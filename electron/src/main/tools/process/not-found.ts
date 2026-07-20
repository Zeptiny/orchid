/**
 * Shared error outcomes for background command process tools.
 */
import { genericBuiltInToolOutcome, type GenericBuiltInToolOutcome } from '../result';

/** Error outcome when a background command id is not visible in scope. */
export function backgroundCommandNotFound(
  toolName: string,
  id: number,
): GenericBuiltInToolOutcome {
  return genericBuiltInToolOutcome(
    toolName,
    `Error: No background command with id ${id}.`,
    'error',
  );
}
