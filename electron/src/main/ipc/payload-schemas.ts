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
import { modelSelectionSchema } from '../../shared/types/provider';
import {
  machineCreateSchema,
  machineIdSchema,
  machineUpdateSchema,
} from '../../shared/types/machine';
import { permissionRuleSchema } from '../../shared/types/config-schema';

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
} from '../../shared/types/config-schema';

// ── Permissions ──────────────────────────────────────────────────────────────

const permissionUpdatesSchema = z.record(z.string(), permissionRuleSchema.nullable())
  .superRefine((updates, ctx) => {
    for (const key of Object.keys(updates)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unsafe permission key: ${key}`,
          path: [key],
        });
      }
    }
  });

export const permissionConfigScopeSaveSchema = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('global'),
    updates: permissionUpdatesSchema,
    expectedProjectDir: z.never().optional(),
  }).strict(),
  z.object({
    scope: z.literal('project'),
    updates: permissionUpdatesSchema,
    expectedProjectDir: z.string().min(1),
  }).strict(),
]);

// ── Machines (local-only family; never host-routed) ──────────────────────────

export const machinesCreateSchema = machineCreateSchema;

export const machinesUpdateSchema = z
  .object({
    id: machineIdSchema,
    patch: machineUpdateSchema,
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

// ── Local-only session config reads ──────────────────────────────────────────

export const sessionGetReasoningConfigSchema = z.object({
  selection: modelSelectionSchema.nullable().optional(),
}).strict().optional();

export const sessionGetServiceTierConfigSchema = z.object({
  selection: modelSelectionSchema.nullable().optional(),
}).strict().optional();
