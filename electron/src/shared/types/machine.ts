/**
 * Machine types — the implicit local machine plus user-added SSH remotes.
 *
 * Machine records are metadata only: SSH auth rides the user's existing
 * key/agent, so no secrets are stored. The local machine is implicit and never
 * persisted; only remote records are written to the home config `machines`
 * section.
 */
import { z } from 'zod';

const isoTimestampSchema = z.string().datetime({ offset: true });

/** Id of the implicit, never-persisted local machine. */
export const MACHINE_ID_LOCAL = 'local';

/**
 * Machine id: a uuid or a stable slug. `local` is reserved for the implicit
 * local machine so a persisted record can never shadow it.
 */
export const machineIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'machine id must be a uuid or slug')
  .refine((id) => id !== MACHINE_ID_LOCAL, {
    message: `machine id '${MACHINE_ID_LOCAL}' is reserved`,
  });

/** Remote host address: hostname, IP, or an ssh-config alias. */
const machineHostSchema = z.string().trim().min(1).max(255);

/** Persisted SSH remote machine record (home config `machines` section). */
export const remoteMachineRecordSchema = z
  .object({
    id: machineIdSchema,
    label: z.string().trim().min(1).max(128),
    kind: z.literal('ssh'),
    host: machineHostSchema,
    port: z.number().int().min(1).max(65535).default(22),
    user: z.string().max(64).default(''),
    agentCommand: z.string().trim().min(1).max(256).default('orchid-agent'),
    created_at: isoTimestampSchema,
    updated_at: isoTimestampSchema,
  })
  .strict();

export type RemoteMachineRecord = z.infer<typeof remoteMachineRecordSchema>;

/** The implicit local machine, synthesized from the host it runs on. */
export const localMachineRecordSchema = z
  .object({
    id: z.literal(MACHINE_ID_LOCAL),
    label: z.string().min(1),
    kind: z.literal('local'),
  })
  .strict();

export type LocalMachineRecord = z.infer<typeof localMachineRecordSchema>;

export type MachineKind = LocalMachineRecord['kind'] | RemoteMachineRecord['kind'];

export type MachineRecord = LocalMachineRecord | RemoteMachineRecord;

export const machineRecordSchema = z.discriminatedUnion('kind', [
  localMachineRecordSchema,
  remoteMachineRecordSchema,
]);

export const machineCreateSchema = remoteMachineRecordSchema
  .omit({
    kind: true,
    created_at: true,
    updated_at: true,
  })
  .extend({
    /** Optional stable slug; a uuid is generated when omitted. */
    id: machineIdSchema.optional(),
  });

export type MachineCreateInput = z.input<typeof machineCreateSchema>;

export const machineUpdateSchema = remoteMachineRecordSchema
  .omit({
    id: true,
    kind: true,
    created_at: true,
    updated_at: true,
  })
  .partial();

export type MachineUpdateInput = z.infer<typeof machineUpdateSchema>;

// ── Connection status views (U8) ─────────────────────────────────────────────

/**
 * Machine connection lifecycle as the renderer sees it. Mirrors the
 * connection-manager states; the implicit local machine is always `connected`.
 */
export const machineConnectionStateSchema = z.enum([
  'offline',
  'connecting',
  'connected',
  'lost',
]);

export type MachineConnectionStateView = z.infer<typeof machineConnectionStateSchema>;

/** Renderer-safe host-key fingerprint; raw key material stays in main. */
export const machineHostKeyFingerprintSchema = z
  .object({
    algorithm: z.string().min(1),
    fingerprintSha256: z.string().min(1),
  })
  .strict();

export type MachineHostKeyFingerprint = z.infer<typeof machineHostKeyFingerprintSchema>;

/** Serialized machine failure: an actionable kind, message, and hint. */
export const machineErrorViewSchema = z
  .object({
    kind: z.string().min(1),
    message: z.string(),
    hint: z.string().default(''),
  })
  .strict();

export type MachineErrorView = z.infer<typeof machineErrorViewSchema>;

/**
 * A failed machine action. `fingerprints` rides only `host-key-not-pinned`
 * connect failures so the UI can prompt TOFU confirmation without a re-scan.
 */
export const machineActionErrorSchema = machineErrorViewSchema.extend({
  fingerprints: z.array(machineHostKeyFingerprintSchema).optional(),
});

export type MachineActionError = z.infer<typeof machineActionErrorSchema>;

/** Connection status of one machine, including the implicit local machine. */
export const machineStatusEntrySchema = z
  .object({
    machineId: z.string().min(1),
    state: machineConnectionStateSchema,
    error: machineErrorViewSchema.nullable(),
    reconnectAttempts: z.number().int().nonnegative(),
  })
  .strict();

export type MachineStatusEntry = z.infer<typeof machineStatusEntrySchema>;
