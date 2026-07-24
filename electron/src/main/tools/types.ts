/**
 * Core types for the Zod-based tool registry framework.
 *
 * Each tool is defined by a zod schema — single source of truth for:
 * - TypeScript types (via z.infer)
 * - Runtime validation (zod parse)
 * - JSON Schema generation (zod-to-json-schema)
 * - MCP exposure and LLM function-calling
 */
import * as path from 'node:path';
import { z } from 'zod';
import { getConfig } from '../config/loader';
import type { Config } from '../config/schema';
import type { ProjectRuntime } from '../project/runtime';
import type { ModelSelection } from '../../shared/types/provider';
import type {
  AgentProjector,
  JsonValue,
  ToolHandlerOutcome,
  ToolResultFamily,
} from '../../shared/types/tool-result';
import { genericToolResultDataSchema } from '../../shared/types/tool-result';
import type { RiskClass } from '../../shared/types/permission';

/** Shared explicit result contract for built-ins using the generic family. */
export const genericToolResultMetadata = {
  resultFamily: 'generic',
  outputDataSchema: genericToolResultDataSchema,
} as const satisfies Pick<ToolDefinition, 'resultFamily' | 'outputDataSchema'>;

export type {
  AgentProjection,
  CanonicalToolResult,
  ToolExecutionResult,
  ToolHandlerOutcome,
} from '../../shared/types/tool-result';

/**
 * Defines a tool's metadata and schema.
 * The inputSchema zod object is the single source of truth —
 * TS types, IPC validation, and JSON Schema all derive from it.
 */
export interface ToolDefinition {
  /** Unique tool name (e.g., 'read', 'grep', 'mcp::context7::resolve-library-id') */
  name: string;

  /** Human-readable description for LLM consumption */
  description: string;

  /** Zod schema for tool input — single source of truth */
  inputSchema: z.ZodType;

  /**
   * Raw JSON Schema from the origin server (MCP tools only).
   * When present, the LLM receives this schema directly instead of the
   * Zod-derived one — preserving parameter names, types, and descriptions
   * that the opaque Zod passthrough would discard.
   */
  rawInputJsonSchema?: Record<string, unknown>;

  /** Canonical result family for this tool's typed result data. */
  resultFamily: ToolResultFamily;

  /** Schema for canonical `data`. */
  outputDataSchema: z.ZodTypeAny;

  /** Tool-level agent projector override (wins over its family default). */
  agentProjector?: AgentProjector;

  /** Tool category for grouping/filtering */
  category: string;

  /** Risk classification for permission gating */
  riskClass: RiskClass;

  /** If true, skip timeout for this tool */
  noTimeout?: boolean;

  /** If true, execute the handler in a worker thread via the tool worker pool. */
  offload?: boolean;
}

/**
 * Frozen per-turn execution context for tools.
 *
 * Captured at turn start (chat:send) and passed into every tool invocation
 * for that turn — never re-read live process.cwd() or active session mid-turn.
 */
export interface ToolExecutionContext {
  /** Absolute working/project directory for this turn. */
  cwd: string;
  /** Session id when available (bg process ownership, output offload). */
  sessionId?: string;
  /** Originating renderer window frozen for approval delivery. */
  windowId?: string;
  /** Immutable project definitions captured when the parent turn began. */
  projectRuntime?: ProjectRuntime;
  /** Connection/model identity frozen by the parent turn. */
  selection?: ModelSelection;
  /**
   * Agent scope within the session (`"main"` or subagent id).
   * Isolates todos and background commands so peer agents cannot see each other.
   */
  agentScopeId?: string;
  /**
   * Abort signal for outer tool-dispatch timeout / parent cancel.
   *
   * Honored by long-running / network tools that can cancel cooperatively:
   * - `execute_command` — kills the live ChildProcess handle (never bare PID)
   * - `web_fetch` — aborts the HTTP request
   * - MCP `callTool` / `readResource` — cancels the in-flight SDK request
   * - `wait_for_subagent` — unblocks wait without cancelling children
   *
   * Residual: pure sync FS tools (read/write/edit/glob/grep) and AST/RAG
   * indexers do not cooperatively cancel mid-op; work may finish after the
   * timed-out tool result is returned.
   */
  abortSignal?: AbortSignal;
}

/**
 * Resolve configuration for one tool invocation.
 *
 * Turns carry a frozen project runtime, so a tool must prefer that snapshot
 * over the legacy process-wide ConfigManager. The fallback keeps direct tool
 * callers and legacy IPC surfaces compatible.
 */
export function getToolConfig(ctx: ToolExecutionContext): Config {
  return ctx.projectRuntime?.config ?? getConfig();
}

export interface WorkerToolContext {
  cwd: string;
  config: Config;
}

export function toWorkerContext(ctx: ToolExecutionContext): WorkerToolContext {
  return {
    cwd: ctx.cwd,
    config: ctx.projectRuntime?.config ?? getConfig(),
  };
}

/**
 * Resolve a user-supplied path against the tool execution cwd.
 * Absolute paths stay absolute (normalized); relative paths join cwd.
 */
export function resolveToolPath(cwd: string, userPath: string): string {
  if (path.isAbsolute(userPath)) {
    return path.normalize(userPath);
  }
  return path.resolve(cwd, userPath);
}

/** Handler function that executes the tool with validated input + turn context. */
export type ToolHandler = (
  input: unknown,
  ctx: ToolExecutionContext,
) => Promise<ToolHandlerOutcome<JsonValue>>;

/** A registered tool combining definition and handler */
export interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}
