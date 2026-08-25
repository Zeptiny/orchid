/**
 * IPC payload Zod schemas — shared by main-process handlers and tests.
 *
 * The schemas live in shared/types/ipc-schemas.ts (and the config-boundary
 * family in shared/types/config-schema.ts) as the single source the host
 * protocol registry (shared/host/protocol.ts) also validates against; this
 * module re-exports them so existing main-side import sites stay stable.
 * Only the local-only families (machines) remain defined here; the renderer
 * tool allow-list now lives in shared/types/tool.ts.
 */
import { z } from 'zod';
import {
  machineCreateSchema,
  machineIdSchema,
  machineUpdateSchema,
} from '../../shared/types/machine';

// ── Chat / subagents / ask-question (hoisted to shared/types/ipc-schemas) ────

export {
  askQuestionAnswerSchema,
  askQuestionCancelSchema,
  astIndexSchema,
  chatCancelSchema,
  chatCompactSchema,
  chatQueueNextSchema,
  chatSendSchema,
  chatSnapshotSchema,
  chatStopSchema,
  projectTrustGetSchema,
  projectTrustSetSchema,
  ragIndexSchema,
  sessionChangeCwdSchema,
  sessionChangeModelSchema,
  sessionDeleteSchema,
  sessionGetReasoningConfigSchema,
  sessionGetServiceTierConfigSchema,
  sessionHistoryPageSchema,
  sessionLoadSchema,
  sessionOpenSchema,
  sessionRenameSchema,
  sessionSetReasoningEffortSchema,
  sessionSetServiceTierSchema,
  sessionSetWorkspaceSchema,
  toolExecuteSchema,
} from '../../shared/types/ipc-schemas';
export {
  subagentSnapshotRequestSchema as subagentSnapshotSchema,
  subagentDetailRequestSchema as subagentDetailSchema,
} from '../../shared/types/ipc-schemas';

// ── Config (hoisted to shared/types/config-schema, beside the zod config
//    schemas they structurally validate against) ──────────────────────────────

export {
  configReadProjectSchema,
  configSaveProjectSchema,
  configSaveSchema,
  permissionConfigScopeSaveSchema,
} from '../../shared/types/config-schema';

// ── Machines (local-only family; never host-routed) ──────────────────────────

/**
 * Create input plus the write-only SSH password (stored encrypted, never part
 * of the persisted record). Only honored for `authMethod: 'password'`.
 */
export const machinesCreateSchema = machineCreateSchema.extend({
  password: z.string().min(1).max(1024).optional(),
});

export const machinesUpdateSchema = z
  .object({
    id: machineIdSchema,
    patch: machineUpdateSchema.extend({
      /** Non-empty stores (replacing any prior password); empty clears. */
      password: z.string().max(1024).optional(),
    }),
  })
  .strict();

export const machinesDeleteSchema = z
  .object({
    id: machineIdSchema,
  })
  .strict();

/**
 * `{ machineId }` for the connection/status handlers. Unlike the CRUD schemas
 * this accepts the reserved `local` id (set_active/connect/disconnect answer
 * local-machine misuse with typed results, not validation errors).
 */
export const machinesMachineIdSchema = z
  .object({
    machineId: z.string().trim().min(1).max(64),
  })
  .strict();
