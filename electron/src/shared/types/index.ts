/**
 * Domain model types for Orchid.
 *
 * Each model:
 * - TypeScript interface for compile-time typing
 * - Zod schema for runtime validation on restore
 * - toStorageDict() / fromStorageDict() for persistence
 * - Enums as const objects (ergonomic for JSON serialization)
 *
 * This is version 1 of the TS app's session format.
 * No backward-compatibility with Python TUI sessions is required.
 */

// Tool types (foundation — no cross-dependencies)
export {
  type ToolCall,
  type ToolCallFunction,
  type ToolResult,
  type ToolCallStorageDict,
  type ToolResultStorageDict,
  toolCallSchema,
  toolCallFunctionSchema,
  toolResultSchema,
  toolCallToStorageDict,
  toolCallFromStorageDict,
  toolResultToStorageDict,
  toolResultFromStorageDict,
} from './tool';

// Message types
export {
  MessageRole,
  MessageType,
  type Usage,
  type Message,
  type ApiMessage,
  type MessageStorageDict,
  usageSchema,
  messageRoleSchema,
  messageTypeSchema,
  messageSchema,
  messageToApiFormat,
  messageToStorageDict,
  messageFromStorageDict,
} from './message';

// Chain types
export {
  ChainStatus,
  type Chain,
  type ChainStorageDict,
  chainStatusSchema,
  chainSchema,
  chainToStorageDict,
  chainFromStorageDict,
} from './chain';

// SubagentRecord types
export {
  SubagentStatus,
  type SubagentRecord,
  type SubagentRecordStorageDict,
  subagentStatusSchema,
  subagentRecordSchema,
  subagentRecordToStorageDict,
  subagentRecordFromStorageDict,
} from './subagent';

// Session types
export {
  type Session,
  type SessionStorageDict,
  sessionSchema,
  sessionToStorageDict,
  sessionFromStorageDict,
} from './session';

// Todo types
export {
  TodoStatus,
  type Todo,
  type TodoStoreData,
  type TodoStorageDict,
  type TodoStoreStorageDict,
  todoStatusSchema,
  todoSchema,
  VALID_TRANSITIONS,
  validateTodoTransition,
  todoToStorageDict,
  todoFromStorageDict,
  todoStoreToStorageDict,
  todoStoreFromStorageDict,
} from './todo';

// Skill types
export {
  type Skill,
  type SkillResource,
  type SkillStorageDict,
  skillSchema,
  skillResourceSchema,
  skillToStorageDict,
  skillFromStorageDict,
} from './skill';

// Agent types
export {
  AgentType,
  AgentTier,
  TIER_DESCRIPTIONS,
  type Agent,
  type AgentStorageDict,
  agentTypeSchema,
  agentTierSchema,
  agentSchema,
  agentToStorageDict,
  agentFromStorageDict,
} from './agent';
