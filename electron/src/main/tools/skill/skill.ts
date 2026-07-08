/**
 * Skill tool — dynamically built, dependency-resolving, resource-reading.
 *
 * Ported from Python `src/orchid/tools/skill.py`.
 *
 * Key behaviors:
 * - Dynamically built: description lists available skills from registry
 * - Params: `name` (skill name or `skill_name/resource_path`)
 * - Dependency resolution: depth-first, circular detection
 * - Injection: deepest dependency first, XML blocks
 * - Resource access via `name/path` with path traversal protection
 * - `.md` frontmatter stripped from resource content
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { minimatch } from 'minimatch';
import { z } from 'zod';
import type { Skill } from '../../../shared/types/skill';
import type { ToolDefinition, ToolHandler } from '../types';
import { parseFrontmatter } from '../../../shared/utils/frontmatter';

// ---------------------------------------------------------------------------
// Skill filtering
// ---------------------------------------------------------------------------

/**
 * Filter skills by glob patterns from agent's allowed_skills.
 */
export function filterSkills(
  allowed: string[],
  registry: Map<string, Skill>,
): Map<string, Skill> {
  if (allowed.length === 0) return new Map();

  const result = new Map<string, Skill>();
  for (const [name, skill] of registry) {
    if (allowed.some((pattern) => minimatch(name, pattern))) {
      result.set(name, skill);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Dependency resolution
// ---------------------------------------------------------------------------

/**
 * Resolve skill dependencies depth-first. Returns ordered list (deepest first).
 *
 * @param name - Skill name to resolve
 * @param registry - Full skill registry
 * @param allowed - Allowed skill patterns (for dependency validation)
 * @param _stack - Internal: current recursion stack for circular detection
 * @param _resolved - Internal: already-resolved set
 * @returns Ordered list of skills (deepest dependency first, then the skill itself)
 */
export function resolveSkillDependencies(
  name: string,
  registry: Map<string, Skill>,
  allowed: string[],
  _stack?: Set<string>,
  _resolved?: Set<string>,
): Skill[] {
  const stack = _stack ?? new Set<string>();
  const resolved = _resolved ?? new Set<string>();

  if (stack.has(name)) {
    throw new Error(`Circular dependency detected involving '${name}'`);
  }
  if (resolved.has(name)) {
    return [];
  }

  const skill = registry.get(name);
  if (!skill) {
    throw new Error(`Skill '${name}' not found`);
  }

  stack.add(name);
  const result: Skill[] = [];

  for (const depName of skill.requires) {
    if (!registry.has(depName)) {
      throw new Error(
        `Skill '${name}' requires '${depName}' which does not exist`,
      );
    }
    if (!allowed.some((p) => minimatch(depName, p))) {
      throw new Error(
        `Skill '${name}' requires '${depName}' which is not available for this agent`,
      );
    }
    const depSkills = resolveSkillDependencies(
      depName,
      registry,
      allowed,
      stack,
      resolved,
    );
    result.push(...depSkills);
  }

  stack.delete(name);
  resolved.add(name);
  result.push(skill);
  return result;
}

// ---------------------------------------------------------------------------
// Resource listing (for skill content output)
// ---------------------------------------------------------------------------

/**
 * Format resource listing for skill load output.
 * Mirrors Python `_format_resource_listing`.
 */
function formatResourceListing(skill: Skill): string {
  // Group resources by directory prefix
  const groups = new Map<string, Array<{ path: string; description: string }>>();

  for (const resource of skill.resources) {
    const slashIdx = resource.path.indexOf('/');
    const label =
      slashIdx > 0 ? resource.path.slice(0, slashIdx) : 'other';
    if (!groups.has(label)) {
      groups.set(label, []);
    }
    groups.get(label)!.push(resource);
  }

  const sections: string[] = [];
  for (const [label, resources] of groups) {
    const lines = resources.map((r) =>
      r.description ? `- ${r.path} — ${r.description}` : `- ${r.path}`,
    );
    sections.push(`<${label}>\n${lines.join('\n')}\n</${label}>`);
  }

  if (sections.length === 0) return '';
  return `<skill_resources>\n${sections.join('\n')}\n</skill_resources>`;
}

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ---------------------------------------------------------------------------
// Resource read
// ---------------------------------------------------------------------------

/**
 * Handle `skill_name/resource_path` reads.
 * Includes path traversal protection and .md frontmatter stripping.
 */
function executeResourceRead(
  name: string,
  registry: Map<string, Skill>,
  filtered: Map<string, Skill>,
): { display: string; content: string } {
  const slashIdx = name.indexOf('/');
  const skillName = name.slice(0, slashIdx);
  const resourcePath = name.slice(slashIdx + 1);

  if (!filtered.has(skillName)) {
    if (registry.has(skillName)) {
      return {
        display: `Skill '${skillName}' not available`,
        content: `Error: skill '${skillName}' is not available for this agent.`,
      };
    }
    return {
      display: `Unknown skill: ${skillName}`,
      content: `Error: skill '${skillName}' does not exist.`,
    };
  }

  const skill = registry.get(skillName)!;
  const skillDir = skill.location
    ? path.dirname(skill.location)
    : undefined;

  if (!skillDir) {
    return {
      display: 'Skill location unknown',
      content: `Error: skill '${skillName}' has no file location (cannot read resources).`,
    };
  }

  // Path traversal check
  const resolved = path.resolve(path.join(skillDir, resourcePath));
  const resolvedSkillDir = path.resolve(skillDir);

  if (
    !resolved.startsWith(resolvedSkillDir + path.sep) &&
    resolved !== resolvedSkillDir
  ) {
    return {
      display: 'Path traversal rejected',
      content: 'Error: resource path is outside the skill directory.',
    };
  }

  // Must be within a known resource directory
  const allowedSubdirs = ['scripts', 'references', 'assets'];
  const isAllowed = allowedSubdirs.some((subdir) => {
    const allowedDir = path.resolve(path.join(skillDir, subdir));
    return (
      resolved.startsWith(allowedDir + path.sep) ||
      resolved === allowedDir
    );
  });

  if (!isAllowed) {
    return {
      display: 'Resource not in allowed directory',
      content:
        'Error: resource must be in scripts/, references/, or assets/ directory.',
    };
  }

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return {
      display: 'Resource not found',
      content: `Error: resource file '${resourcePath}' not found in skill '${skillName}'.`,
    };
  }

  let fileContent: string;
  try {
    fileContent = fs.readFileSync(resolved, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      display: 'Read error',
      content: `Error reading resource: ${message}`,
    };
  }

  // Strip frontmatter from .md files
  if (resolved.endsWith('.md')) {
    const { body } = parseFrontmatter(fileContent);
    fileContent = body.trim();
  }

  const e = escapeXml;
  const content =
    `<skill_resource skill="${e(skillName)}" path="${e(resourcePath)}">\n` +
    `${e(fileContent)}\n` +
    `</skill_resource>`;

  return {
    display: `Resource '${resourcePath}' from '${skillName}'`,
    content,
  };
}

// ---------------------------------------------------------------------------
// Skill execution
// ---------------------------------------------------------------------------

/**
 * Execute the skill tool — load a skill or read a skill resource.
 */
function executeSkill(
  name: string,
  registry: Map<string, Skill>,
  allowedSkills: string[] | undefined,
): { display: string; content: string } {
  // Check if this is a resource file read request (skill_name/resource_path)
  if (name.includes('/')) {
    const filtered =
      allowedSkills !== undefined
        ? filterSkills(allowedSkills, registry)
        : registry;
    return executeResourceRead(name, registry, filtered);
  }

  const filtered =
    allowedSkills !== undefined
      ? filterSkills(allowedSkills, registry)
      : registry;

  if (!filtered.has(name)) {
    if (registry.has(name)) {
      return {
        display: `Skill '${name}' not available`,
        content: `Error: skill '${name}' is not available for this agent.`,
      };
    }
    const available = Array.from(filtered.keys()).join(', ');
    return {
      display: `Unknown skill: ${name}`,
      content: `Error: skill '${name}' does not exist. Available skills: ${available}`,
    };
  }

  // Resolve dependencies
  let skillsToInject: Skill[];
  try {
    skillsToInject = resolveSkillDependencies(
      name,
      registry,
      allowedSkills ?? ['*'],
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { display: 'Dependency error', content: `Error: ${message}` };
  }

  const e = escapeXml;
  const parts: string[] = [];

  for (const skill of skillsToInject) {
    const skillContent =
      skill.content ??
      `Skill '${skill.name}' loaded (no content file found)`;
    parts.push(
      `<skill_content name="${e(skill.name)}">\n` +
        `${e(skillContent)}\n` +
        `</skill_content>`,
    );

    const resourceListing = formatResourceListing(skill);
    if (resourceListing) {
      parts.push(resourceListing);
    }
  }

  const content = parts.join('\n');

  return {
    display: `Skill '${name}' loaded`,
    content,
  };
}

// ---------------------------------------------------------------------------
// Tool builder
// ---------------------------------------------------------------------------

/**
 * Build the skill tool.
 *
 * The tool's description is dynamically constructed from the available skills,
 * listing each skill's name and description. The handler resolves dependencies
 * (depth-first, circular detection) and returns XML-structured content.
 *
 * @param skills - Map of skill name → Skill from the skill registry
 * @param allowedSkills - Optional glob patterns to filter skills (agent's allowed_skills)
 */
export function buildSkillTool(
  skills: Map<string, Skill>,
  allowedSkills?: string[],
): { definition: ToolDefinition; handler: ToolHandler } {
  const filtered =
    allowedSkills !== undefined
      ? filterSkills(allowedSkills, skills)
      : skills;

  const skillLines = Array.from(filtered.entries())
    .map(([name, skill]) => `- ${name}: ${skill.description}`)
    .join('\n');

  const definition: ToolDefinition = {
    name: 'skill',
    description:
      'Load a specialized skill when the task at hand matches one of the skills listed in the system prompt. ' +
      'Use this tool to inject the skill\'s instructions and resources into current conversation. ' +
      'The output may contain detailed workflow guidance as well as references to scripts, files, etc in the same directory as the skill. ' +
      'You can also read a resource file by passing skill_name/path (e.g. \'work/references/api-errors.md\').',
    inputSchema: z.object({
      name: z
        .string()
        .describe(
          `The name of the skill to load, or skill_name/path to read a resource file ` +
            `(e.g. 'work' loads the skill, 'work/references/api-errors.md' reads that file). ` +
            `Available skills:\n${skillLines}`,
        ),
    }),
    actionLabel: 'Loading skill...',
    category: 'skill',
  };

  const handler: ToolHandler = async (input: unknown): Promise<{ display: string; content: string }> => {
    const { name } = input as { name: string };
    return executeSkill(name, skills, allowedSkills);
  };

  return { definition, handler };
}
