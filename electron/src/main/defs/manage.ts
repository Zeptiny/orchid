/**
 * CRUD for skills, agents, and personalities on disk.
 *
 * List returns per-scope entries (same name can appear in global + project).
 * Save/delete write only the selected scope, then callers reload registries.
 *
 * Policy:
 * - Names: DEFINITION_NAME_PATTERN only
 * - Internal agents: editable in place, never created/renamed/deleted via app
 * - Target path is authoritative for internal status (not client type alone)
 * - Rename moves directories (skills keep resources); refuses if target exists
 * - Reserved internal names cannot be project-overlaid via save
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AgentTier,
  AgentType,
  type Agent,
} from '../../shared/types/agent';
import type {
  DefinitionScope,
  ManagedAgent,
  ManagedPersonality,
  ManagedSkill,
  AgentSaveMessage,
  PersonalitySaveMessage,
  SkillSaveMessage,
} from '../../shared/types/definitions';
import type { Skill } from '../../shared/types/skill';
import {
  parseFrontmatter,
  serializeFrontmatter,
  getString,
  getStringArray,
} from '../../shared/utils/frontmatter';
import {
  HOME_AGENTS_DIR,
  HOME_PERSONALITIES_DIR,
  HOME_SKILLS_DIR,
} from '../config/loader';
import {
  RESERVED_INTERNAL_AGENT_NAMES,
  agentMdPath,
  assertPathInScopeRoot,
  assertTargetDoesNotExist,
  atomicWriteText,
  definitionEntryDir,
  type DefinitionKind,
  personalityMdPath,
  removeDefinitionDir,
  removeFileInScope,
  renameDefinitionDir,
  resolveScopeRoot,
  skillMdPath,
  validateDefinitionName,
} from './paths';

// ── Helpers ──────────────────────────────────────────────────────────────────

function readAgentTypeFromFile(agentFile: string): AgentType | null {
  if (!fs.existsSync(agentFile)) return null;
  try {
    const content = fs.readFileSync(agentFile, 'utf-8');
    const { metadata } = parseFrontmatter(content);
    const raw = getString(metadata, 'type', 'subagent').toLowerCase();
    if (raw === AgentType.INTERNAL) return AgentType.INTERNAL;
    if (raw === AgentType.SUBAGENT) return AgentType.SUBAGENT;
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve writable agent type from disk, ignoring untrusted client creates.
 *
 * - Create (no previous): always subagent
 * - Edit same name: preserve internal if target is internal
 * - Rename: refuse if previous or target is internal; else subagent
 */
function resolveWritableAgentType(
  scope: DefinitionScope,
  name: string,
  previousName: string | undefined,
  projectDir: string | null,
): AgentType {
  const targetFile = agentMdPath(scope, name, projectDir);
  const targetType = readAgentTypeFromFile(targetFile);

  if (!previousName) {
    // Create or overwrite-without-rename
    if (targetType === AgentType.INTERNAL) {
      // In-place edit of existing internal (UI sends previousName, but also
      // defend save without previousName onto internal path)
      return AgentType.INTERNAL;
    }
    // Never create/promote to internal via IPC
    return AgentType.SUBAGENT;
  }

  const prev = validateDefinitionName(previousName);
  const prevFile = agentMdPath(scope, prev, projectDir);
  const prevType = readAgentTypeFromFile(prevFile);

  if (prev !== name) {
    // Rename
    if (prevType === AgentType.INTERNAL) {
      throw new Error(
        'Internal agents cannot be renamed. Change the display fields only.',
      );
    }
    if (targetType === AgentType.INTERNAL) {
      throw new Error(
        `Cannot rename onto internal agent "${name}".`,
      );
    }
    // Forged previousName (missing prev file) or normal rename → always subagent
    if (prevType === null && !fs.existsSync(prevFile)) {
      throw new Error(
        `Agent "${prev}" not found in ${scope} scope`,
      );
    }
    return AgentType.SUBAGENT;
  }

  // Same-name edit
  if (prevType === AgentType.INTERNAL || targetType === AgentType.INTERNAL) {
    return AgentType.INTERNAL;
  }
  return AgentType.SUBAGENT;
}

function assertNotReservedProjectAgent(
  scope: DefinitionScope,
  name: string,
): void {
  if (scope === 'project' && RESERVED_INTERNAL_AGENT_NAMES.has(name)) {
    throw new Error(
      `Agent "${name}" is reserved (internal) and cannot be defined at project scope.`,
    );
  }
}

// ── List ─────────────────────────────────────────────────────────────────────

/**
 * Merge global + project definition entries for one kind.
 * Project names drive `overriddenByProject` badges on global rows.
 */
function listDefinitionEntries<T>(options: {
  projectDir: string | null;
  kind: DefinitionKind;
  globalDir: string;
  collectProjectNames: (projectRoot: string) => Set<string>;
  listInDir: (
    dir: string,
    scope: DefinitionScope,
    projectNames: Set<string>,
  ) => T[];
}): T[] {
  const projectRoot = options.projectDir
    ? path.join(options.projectDir, '.orchid', options.kind)
    : null;
  const projectNames =
    projectRoot && fs.existsSync(projectRoot)
      ? options.collectProjectNames(projectRoot)
      : new Set<string>();

  const global = options.listInDir(options.globalDir, 'global', projectNames);
  const project = projectRoot
    ? options.listInDir(projectRoot, 'project', new Set())
    : [];
  return [...global, ...project];
}

function listSkillEntriesInDir(
  dir: string,
  scope: DefinitionScope,
  projectNames: Set<string>,
): ManagedSkill[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];

  const out: ManagedSkill[] = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    const sub = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(sub);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const skillFile = path.join(sub, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;

    let content: string;
    try {
      content = fs.readFileSync(skillFile, 'utf-8');
    } catch {
      continue;
    }

    const { metadata, body } = parseFrontmatter(content);
    // Prefer directory stem as identity (stable for override badges / delete)
    const name = entry;
    const description = getString(metadata, 'description', '');
    if (!description) continue;

    const requiresRaw = metadata['requires'];
    const requires = Array.isArray(requiresRaw)
      ? requiresRaw.filter((r): r is string => typeof r === 'string')
      : [];

    const resources = scanResources(sub);

    out.push({
      name,
      description,
      requires,
      content: body,
      resources,
      scope,
      path: skillFile,
      overriddenByProject: scope === 'global' && projectNames.has(name),
    });
  }
  return out;
}

function scanResources(skillDir: string): ManagedSkill['resources'] {
  const resources: Array<{ path: string; description: string }> = [];
  for (const dirname of ['scripts', 'references', 'assets'] as const) {
    const dirPath = path.join(skillDir, dirname);
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) continue;
    walk(dirPath, dirname);
  }
  return resources;

  function walk(current: string, rootName: string): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(current).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, rootName);
      } else if (st.isFile()) {
        const rel = `${rootName}/${path.relative(path.join(skillDir, rootName), full)}`;
        resources.push({ path: rel, description: '' });
      }
    }
  }
}

function collectSkillProjectNames(projectRoot: string): Set<string> {
  const names = new Set<string>();
  for (const e of fs.readdirSync(projectRoot)) {
    if (fs.existsSync(path.join(projectRoot, e, 'SKILL.md'))) {
      names.add(e);
    }
  }
  return names;
}

export function listManagedSkills(projectDir: string | null): ManagedSkill[] {
  return listDefinitionEntries({
    projectDir,
    kind: 'skills',
    globalDir: HOME_SKILLS_DIR,
    collectProjectNames: collectSkillProjectNames,
    listInDir: listSkillEntriesInDir,
  });
}

function listAgentEntriesInDir(
  dir: string,
  scope: DefinitionScope,
  projectNames: Set<string>,
): ManagedAgent[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];

  const validTypes = new Set<string>(Object.values(AgentType));
  const validTiers = new Set<string>(Object.values(AgentTier));
  const out: ManagedAgent[] = [];

  for (const entry of fs.readdirSync(dir).sort()) {
    const sub = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(sub);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // Skip reserved names at project scope (defense for hand-planted dirs)
    if (scope === 'project' && RESERVED_INTERNAL_AGENT_NAMES.has(entry)) {
      continue;
    }

    const agentFile = path.join(sub, 'AGENT.md');
    if (!fs.existsSync(agentFile)) continue;

    let content: string;
    try {
      content = fs.readFileSync(agentFile, 'utf-8');
    } catch {
      continue;
    }

    const { metadata, body } = parseFrontmatter(content);
    const name = entry;
    const rawType = getString(metadata, 'type', 'subagent').toLowerCase();
    const rawTier = getString(metadata, 'tier', AgentTier.BLOOM).toLowerCase();
    const description = getString(metadata, 'description', '');
    if (!description || !validTypes.has(rawType) || !validTiers.has(rawTier)) {
      continue;
    }

    const rawEffort = metadata['reasoning_effort'];
    let reasoning_effort: string | number | undefined;
    if (typeof rawEffort === 'number') {
      reasoning_effort = rawEffort;
    } else if (typeof rawEffort === 'string' && rawEffort.trim() !== '') {
      const num = Number(rawEffort);
      reasoning_effort = Number.isNaN(num) ? rawEffort : num;
    }

    out.push({
      name,
      type: rawType as AgentType,
      tier: rawTier as AgentTier,
      description,
      system_prompt: body.trim(),
      allowed_tools: getStringArray(metadata, 'allowed_tools'),
      allowed_skills: getStringArray(metadata, 'allowed_skills', ['*']),
      ...(reasoning_effort !== undefined ? { reasoning_effort } : {}),
      scope,
      path: agentFile,
      overriddenByProject: scope === 'global' && projectNames.has(name),
    });
  }
  return out;
}

function collectAgentProjectNames(projectRoot: string): Set<string> {
  const names = new Set<string>();
  for (const e of fs.readdirSync(projectRoot)) {
    if (
      fs.existsSync(path.join(projectRoot, e, 'AGENT.md')) &&
      !RESERVED_INTERNAL_AGENT_NAMES.has(e)
    ) {
      names.add(e);
    }
  }
  return names;
}

export function listManagedAgents(projectDir: string | null): ManagedAgent[] {
  return listDefinitionEntries({
    projectDir,
    kind: 'agents',
    globalDir: HOME_AGENTS_DIR,
    collectProjectNames: collectAgentProjectNames,
    listInDir: listAgentEntriesInDir,
  });
}

function listPersonalityEntriesInDir(
  dir: string,
  scope: DefinitionScope,
  projectNames: Set<string>,
): ManagedPersonality[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];

  const out: ManagedPersonality[] = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!entry.endsWith('.md')) continue;
    const full = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let content: string;
    try {
      content = fs.readFileSync(full, 'utf-8').trim();
    } catch {
      continue;
    }
    if (!content) continue;

    const name = path.basename(entry, '.md');
    out.push({
      name,
      content,
      scope,
      path: full,
      overriddenByProject: scope === 'global' && projectNames.has(name),
    });
  }
  return out;
}

function collectPersonalityProjectNames(projectRoot: string): Set<string> {
  const names = new Set<string>();
  for (const e of fs.readdirSync(projectRoot)) {
    if (e.endsWith('.md')) names.add(path.basename(e, '.md'));
  }
  return names;
}

export function listManagedPersonalities(
  projectDir: string | null,
): ManagedPersonality[] {
  return listDefinitionEntries({
    projectDir,
    kind: 'personalities',
    globalDir: HOME_PERSONALITIES_DIR,
    collectProjectNames: collectPersonalityProjectNames,
    listInDir: listPersonalityEntriesInDir,
  });
}

// ── Save ─────────────────────────────────────────────────────────────────────

export function saveSkill(
  msg: SkillSaveMessage,
  projectDir: string | null,
): ManagedSkill {
  const name = validateDefinitionName(msg.name);
  const description = msg.description.trim();
  if (!description) {
    throw new Error('Skill description is required');
  }

  const requires = (msg.requires ?? [])
    .map((r) => r.trim())
    .filter(Boolean);

  const scopeRoot = resolveScopeRoot('skills', msg.scope, projectDir);
  const targetDir = definitionEntryDir('skills', msg.scope, name, projectDir);
  const filePath = skillMdPath(msg.scope, name, projectDir);

  // Rename first (preserves scripts/references/assets)
  if (msg.previousName) {
    const prev = validateDefinitionName(msg.previousName);
    if (prev !== name) {
      const prevDir = definitionEntryDir('skills', msg.scope, prev, projectDir);
      if (!fs.existsSync(path.join(prevDir, 'SKILL.md'))) {
        throw new Error(`Skill "${prev}" not found in ${msg.scope} scope`);
      }
      assertTargetDoesNotExist(targetDir);
      renameDefinitionDir(prevDir, targetDir, scopeRoot);
    }
  } else if (fs.existsSync(filePath) === false && fs.existsSync(targetDir)) {
    // empty dir ok
  }

  // Create: refuse clobber of an existing different skill via name collision only when renaming
  // In-place create when target already has SKILL.md is intentional overwrite of that skill.

  const markdown = serializeFrontmatter(
    {
      name,
      description,
      ...(requires.length > 0 ? { requires } : {}),
    },
    msg.content ?? '',
  );
  atomicWriteText(filePath, markdown, scopeRoot);

  const resources = scanResources(path.dirname(filePath));
  return {
    name,
    description,
    requires,
    content: msg.content ?? '',
    resources,
    scope: msg.scope,
    path: filePath,
    overriddenByProject: false,
  };
}

export function saveAgent(
  msg: AgentSaveMessage,
  projectDir: string | null,
): ManagedAgent {
  const name = validateDefinitionName(msg.name);
  const description = msg.description.trim();
  if (!description) {
    throw new Error('Agent description is required');
  }
  if (!Object.values(AgentTier).includes(msg.tier)) {
    throw new Error(`Invalid agent tier: ${msg.tier}`);
  }

  assertNotReservedProjectAgent(msg.scope, name);

  const type = resolveWritableAgentType(
    msg.scope,
    name,
    msg.previousName,
    projectDir,
  );

  const targetFile = agentMdPath(msg.scope, name, projectDir);
  const targetExists = fs.existsSync(targetFile);

  // Never create a new reserved/internal agent from nothing
  if (!targetExists && RESERVED_INTERNAL_AGENT_NAMES.has(name)) {
    throw new Error(
      `Agent "${name}" is reserved. Restore from defaults or edit the existing file.`,
    );
  }
  if (!targetExists && type === AgentType.INTERNAL) {
    throw new Error('Internal agents cannot be created via the app');
  }

  const allowedTools = msg.allowed_tools.map((t) => t.trim()).filter(Boolean);
  const allowedSkills = msg.allowed_skills.map((t) => t.trim()).filter(Boolean);
  if (allowedTools.length === 0) {
    throw new Error('At least one allowed tool is required');
  }

  const scopeRoot = resolveScopeRoot('agents', msg.scope, projectDir);
  const targetDir = definitionEntryDir('agents', msg.scope, name, projectDir);

  if (msg.previousName) {
    const prev = validateDefinitionName(msg.previousName);
    if (prev !== name) {
      const prevDir = definitionEntryDir('agents', msg.scope, prev, projectDir);
      if (!fs.existsSync(path.join(prevDir, 'AGENT.md'))) {
        throw new Error(`Agent "${prev}" not found in ${msg.scope} scope`);
      }
      assertTargetDoesNotExist(targetDir);
      renameDefinitionDir(prevDir, targetDir, scopeRoot);
    }
  }

  const metadata: Record<string, string | string[]> = {
    name,
    type,
    tier: msg.tier,
    description,
    allowed_tools: allowedTools,
    allowed_skills: allowedSkills.length > 0 ? allowedSkills : ['*'],
    ...(msg.reasoning_effort !== undefined
      ? { reasoning_effort: String(msg.reasoning_effort) }
      : {}),
  };
  const markdown = serializeFrontmatter(metadata, msg.system_prompt ?? '');
  atomicWriteText(targetFile, markdown, scopeRoot);

  return {
    name,
    type,
    tier: msg.tier,
    description,
    system_prompt: (msg.system_prompt ?? '').trim(),
    allowed_tools: allowedTools,
    allowed_skills: allowedSkills.length > 0 ? allowedSkills : ['*'],
    ...(msg.reasoning_effort !== undefined
      ? { reasoning_effort: msg.reasoning_effort }
      : {}),
    scope: msg.scope,
    path: targetFile,
    overriddenByProject: false,
  };
}

export function savePersonality(
  msg: PersonalitySaveMessage,
  projectDir: string | null,
): ManagedPersonality {
  const name = validateDefinitionName(msg.name);
  const content = msg.content.trim();
  if (!content) {
    throw new Error('Personality content is required');
  }

  const scopeRoot = resolveScopeRoot('personalities', msg.scope, projectDir);
  const filePath = personalityMdPath(msg.scope, name, projectDir);

  if (msg.previousName) {
    const prev = validateDefinitionName(msg.previousName);
    if (prev !== name) {
      const prevPath = personalityMdPath(msg.scope, prev, projectDir);
      if (!fs.existsSync(prevPath)) {
        throw new Error(`Personality "${prev}" not found in ${msg.scope} scope`);
      }
      assertTargetDoesNotExist(filePath);
      const safeFrom = assertPathInScopeRoot(prevPath, scopeRoot);
      const safeToParent = assertPathInScopeRoot(path.dirname(filePath), scopeRoot);
      const safeTo = path.join(safeToParent, path.basename(filePath));
      fs.renameSync(safeFrom, safeTo);
    }
  }

  atomicWriteText(filePath, `${content}\n`, scopeRoot);

  return {
    name,
    content,
    scope: msg.scope,
    path: filePath,
    overriddenByProject: false,
  };
}

// ── Delete ───────────────────────────────────────────────────────────────────

export function deleteSkill(
  scope: DefinitionScope,
  name: string,
  projectDir: string | null,
): void {
  const safe = validateDefinitionName(name);
  const dir = definitionEntryDir('skills', scope, safe, projectDir);
  const root = resolveScopeRoot('skills', scope, projectDir);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) {
    throw new Error(`Skill "${safe}" not found in ${scope} scope`);
  }
  removeDefinitionDir(dir, root);
}

export function deleteAgent(
  scope: DefinitionScope,
  name: string,
  projectDir: string | null,
): void {
  const safe = validateDefinitionName(name);
  const dir = definitionEntryDir('agents', scope, safe, projectDir);
  const root = resolveScopeRoot('agents', scope, projectDir);
  const agentFile = path.join(dir, 'AGENT.md');
  if (!fs.existsSync(agentFile)) {
    throw new Error(`Agent "${safe}" not found in ${scope} scope`);
  }

  if (RESERVED_INTERNAL_AGENT_NAMES.has(safe)) {
    throw new Error(
      `Agent "${safe}" is reserved/internal and cannot be deleted.`,
    );
  }

  const diskType = readAgentTypeFromFile(agentFile);
  if (diskType === AgentType.INTERNAL) {
    throw new Error(
      `Agent "${safe}" is internal and cannot be deleted. Edit it instead.`,
    );
  }

  removeDefinitionDir(dir, root);
}

export function deletePersonality(
  scope: DefinitionScope,
  name: string,
  projectDir: string | null,
): void {
  const safe = validateDefinitionName(name);
  const root = resolveScopeRoot('personalities', scope, projectDir);
  const filePath = personalityMdPath(scope, safe, projectDir);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Personality "${safe}" not found in ${scope} scope`);
  }
  removeFileInScope(filePath, root);
}

// ── Registry reload helpers (typed re-exports for tests) ─────────────────────

export type { Skill, Agent };
