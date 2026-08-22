/**
 * Shared prompt registry — reads fixed-slot prompt files injected into every
 * agent's system prompt.
 *
 * Layout mirrors personalities:
 *   home:    ~/.orchid/prompts/{all-agents,subagents}.md
 *   project: <workspace>/.orchid/prompts/{all-agents,subagents}.md
 *
 * Each slot is a singleton: a non-empty project file replaces the home file
 * for that slot (never merged). Empty or missing files mean "no rules".
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { HOME_PROMPTS_DIR } from '../config/loader';
import {
  SHARED_PROMPT_SLOTS,
  type SharedPromptSlot,
} from '../../shared/types/definitions';

/** Effective (project-overridden) content per slot; null = no prompt. */
export type SharedPrompts = Readonly<Record<SharedPromptSlot, string | null>>;

export const EMPTY_SHARED_PROMPTS: SharedPrompts = {
  'all-agents': null,
  subagents: null,
};

export function sharedPromptFileName(slot: SharedPromptSlot): string {
  return `${slot}.md`;
}

/**
 * Read one slot's prompt from a directory. Empty/whitespace-only or missing
 * files return null (an empty file cannot inject rules).
 */
function readSlotFromDir(dir: string, slot: SharedPromptSlot): string | null {
  const file = path.join(dir, sharedPromptFileName(slot));
  try {
    const content = fs.readFileSync(file, 'utf-8').trim();
    return content ? content : null;
  } catch {
    return null;
  }
}

export interface ReadSharedPromptsOptions {
  /**
   * Override home prompts directory.
   * `null` skips the home load entirely (project-only reads).
   */
  homeDir?: string | null;
  /** Project root whose `.orchid/prompts/` directory is overlaid. */
  projectDir?: string;
}

/**
 * Read both shared prompt slots and resolve their effective content.
 * A non-empty project file replaces the home file per slot (no merge).
 */
export function readSharedPrompts(
  options?: ReadSharedPromptsOptions,
): SharedPrompts {
  const homeDir = options?.homeDir ?? HOME_PROMPTS_DIR;
  const projectDir = options?.projectDir
    ? path.join(options.projectDir, '.orchid', 'prompts')
    : null;

  const result: Record<SharedPromptSlot, string | null> = {
    'all-agents': null,
    subagents: null,
  };
  for (const slot of SHARED_PROMPT_SLOTS) {
    const home =
      options?.homeDir === null
        ? null
        : readSlotFromDir(homeDir, slot);
    const project = projectDir ? readSlotFromDir(projectDir, slot) : null;
    result[slot] = project ?? home;
  }
  return result;
}

/**
 * Seed default shared prompt files into the given home directory.
 * Bundled defaults are copied only when the target file does not exist —
 * user edits always win (same policy as personality seeding).
 */
export function seedSharedPromptsDir(
  homeDir: string = HOME_PROMPTS_DIR,
): void {
  const defaultsDir = path.join(__dirname, 'defaults');
  if (!fs.existsSync(defaultsDir) || !fs.statSync(defaultsDir).isDirectory()) {
    return;
  }
  fs.mkdirSync(homeDir, { recursive: true });
  for (const entry of fs.readdirSync(defaultsDir).sort()) {
    if (!SHARED_PROMPT_SLOTS.some((slot) => sharedPromptFileName(slot) === entry)) continue;
    const source = path.join(defaultsDir, entry);
    if (!fs.statSync(source).isFile()) continue;
    const target = path.join(homeDir, entry);
    if (!fs.existsSync(target)) {
      fs.copyFileSync(source, target);
    }
  }
}
