/**
 * Subagent tools — delegate, wait, interrupt.
 *
 * Each tool is dynamically built via a builder function that accepts
 * the dependencies it needs (agent registry, SubagentManager).
 *
 * Ported from Python `src/orchid/tools/subagent.py`.
 */
export { buildDelegateTool, type SubagentToolResult } from './delegate';
export { buildWaitTool } from './wait';
export { buildInterruptTool } from './interrupt';
