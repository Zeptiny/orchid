/**
 * Process tools — execute_command, read_output, send_input, terminate_command.
 *
 * Also exports BackgroundProcessStore and HeadTailBuffer for direct use.
 *
 * Ported from Python `src/orchid/tools/exec.py` and `src/orchid/tools/background_io.py`.
 */

// Background store & buffer
export { HeadTailBuffer, HEAD_CAP, TAIL_CAP, TOTAL_CAP } from './head-tail-buffer';
export {
  BackgroundProcessStore,
  getBackgroundStore,
  setBackgroundStore,
  ENV_SUPPRESSION,
  PTY_ENV_SUPPRESSION,
  type ProcessEntry,
} from './background-store';

// execute_command
export {
  executeCommandToolDefinition,
  executeCommandHandler,
  executeCommand,
  executeCommandInputSchema,
  type ExecuteCommandInput,
} from './execute-command';

// read_output
export {
  readOutputToolDefinition,
  readOutputHandler,
  executeReadOutput,
  readOutputInputSchema,
  type ReadOutputInput,
} from './read-output';

// send_input
export {
  sendInputToolDefinition,
  sendInputHandler,
  executeSendInput,
  sendInputSchema,
  type SendInputInput,
} from './send-input';

// terminate_command
export {
  terminateCommandToolDefinition,
  terminateCommandHandler,
  executeTerminateCommand,
  terminateCommandInputSchema,
  type TerminateCommandInput,
} from './terminate-command';
