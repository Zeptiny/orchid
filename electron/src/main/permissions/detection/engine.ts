import type { DetectionPack, DetectionResult } from './types';

function pushSegment(segments: string[], value: string): string {
  const segment = value.trim();
  if (segment !== '') segments.push(segment);
  return '';
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? '';

    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character === '\\' && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }

    if (quote !== null) {
      current += character;
      if (character === quote) quote = null;
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      current += character;
      continue;
    }

    if (character === ';' || character === '\n') {
      current = pushSegment(segments, current);
      continue;
    }

    if (character === '(' || character === ')') {
      current = pushSegment(segments, current);
      segments.push(character);
      continue;
    }

    if (character === '&' || character === '|') {
      current = pushSegment(segments, current);
      if (command[index + 1] === character) {
        index += 1;
      } else if (character === '&') {
        segments.push(character);
      }
      continue;
    }

    current += character;
  }

  pushSegment(segments, current);
  return segments;
}

function matches(regex: RegExp, value: string): boolean {
  regex.lastIndex = 0;
  const matched = regex.test(value);
  regex.lastIndex = 0;
  return matched;
}

interface LiteralCommandCheck {
  literal: boolean;
  reason?: string;
}

/**
 * Safe-pattern exceptions are only sound for literal, simple shell commands.
 * Any syntax that asks the shell to derive additional input or perform an
 * additional side effect is conservatively routed to human approval.
 */
function checkLiteralSimpleCommand(command: string): LiteralCommandCheck {
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? '';

    if (escaped) {
      if (character === '\n' || character === '\r') {
        return { literal: false, reason: 'unsupported shell syntax' };
      }
      escaped = false;
      continue;
    }

    if (character === '\\') {
      escaped = true;
      continue;
    }

    if (character === "'" || character === '"') {
      if (quote === character) quote = null;
      else if (quote === null) quote = character;
      continue;
    }

    // Treat expansion syntax as unsafe even inside quotes. This is stricter
    // than a shell parser by design: safe rules must never depend on subtle
    // quoting semantics or a caller-selected shell.
    if ('$`'.includes(character)) {
      return { literal: false, reason: 'shell expansion or redirection' };
    }

    if (
      quote === null &&
      ('<>{}*?[]~!()&'.includes(character) || character === '#' || character === '\r')
    ) {
      return { literal: false, reason: 'unsupported shell syntax' };
    }
  }

  if (escaped || quote !== null) {
    return { literal: false, reason: 'unterminated shell quoting' };
  }
  return { literal: true };
}

const SHELL_COMMAND_REGEX = /^\s*(?:sh|bash|zsh|dash|ksh)\b/;
const INTERPRETER_EVAL_REGEX =
  /^\s*(?:python3?|ruby|perl|node|php|pwsh|powershell)\s+(?:-[a-zA-Z]*[cerp]\b|--eval\b|--command\b)/;

/**
 * Invoking a shell, or an interpreter with an eval-style flag, runs arbitrary
 * code and is flagged regardless of pipe position. Per-stage denylists miss
 * pipe-to-shell and interpreter RCE (e.g. `curl … | sh`, `python -c …`)
 * because each pipeline stage is scored in isolation, so the leading command
 * token itself is treated as the destructive signal.
 */
function checkExecutionRisk(segment: string): DetectionResult | null {
  if (matches(SHELL_COMMAND_REGEX, segment)) {
    return {
      flagged: true,
      pattern: 'shell-invocation',
      description: 'Direct shell invocation executes arbitrary commands',
    };
  }
  if (matches(INTERPRETER_EVAL_REGEX, segment)) {
    return {
      flagged: true,
      pattern: 'interpreter-eval',
      description: 'Interpreter eval flag executes arbitrary code',
    };
  }
  return null;
}

export class DetectionEngine {
  private packs: DetectionPack[] = [];

  registerPack(pack: DetectionPack): void {
    this.packs.push(pack);
  }

  evaluate(command: string): DetectionResult {
    const segments = splitShellSegments(command);

    for (const segment of segments) {
      const literalCheck = checkLiteralSimpleCommand(segment);
      if (!literalCheck.literal) {
        return {
          flagged: true,
          pattern: 'unsupported-shell-syntax',
          description: literalCheck.reason ?? 'Unsupported shell syntax',
        };
      }

      let safe = false;
      for (const pack of this.packs) {
        for (const pattern of pack.safePatterns) {
          if (matches(pattern.regex, segment)) {
            safe = true;
            break;
          }
        }
        if (safe) break;
      }
      if (safe) continue;

      const executionRisk = checkExecutionRisk(segment);
      if (executionRisk !== null) {
        return executionRisk;
      }

      for (const pack of this.packs) {
        for (const pattern of pack.destructivePatterns) {
          if (matches(pattern.regex, segment)) {
            return {
              flagged: true,
              pattern: pattern.name,
              description: pattern.description,
            };
          }
        }
      }
    }

    return { flagged: false };
  }
}
