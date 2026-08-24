/**
 * Add-machine wizard — create → keyscan → TOFU confirm → connect (U8).
 *
 * Mirrors the provider ConnectionWizard composition on top of the typed
 * machines API: create writes the record, the scan step shows `ssh-keyscan`
 * fingerprints, an explicit confirmation pins exactly that scan into the
 * machine's known-hosts file, and the final step connects (surfacing the
 * agent-missing install hint verbatim when the remote has no agent).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MachineHostKeyFingerprint,
  RemoteMachineRecord,
} from '../../../shared/types/ipc';
import type { UseMachinesReturn } from '../../hooks/useMachines';
import { useMachines } from '../../hooks/useMachines';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { DialogSurface } from '../ui/DialogSurface';
import { FormField } from '../ui/FormField';
import { Spinner } from '../ui/Spinner';
import { TextInput } from '../ui/TextInput';
import { ConnectionStatusBadge } from './ConnectionStatusBadge';

type WizardStep = 'form' | 'scan' | 'connect';

export type AddMachineActions = Pick<
  UseMachinesReturn,
  'createMachine' | 'scanHostKey' | 'confirmHostKey' | 'connect' | 'switchTo'
>;

export interface AddMachineWizardProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Action surface; defaults to the shared useMachines store. */
  readonly actions?: AddMachineActions;
  /** Called after a successful connect (before close) with the machine id. */
  readonly onComplete?: (machineId: string) => void;
}

const EMPTY_FORM = { label: '', host: '', port: '22', user: '', agentCommand: 'orchid-agent' };

/**
 * Modal that walks one SSH remote from record creation to a connected host.
 */
export function AddMachineWizard({ open, onClose, actions, onComplete }: AddMachineWizardProps) {
  const store = useMachines();
  const machines = actions ?? store;
  const wasOpenRef = useRef(false);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<WizardStep>('form');
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [machine, setMachine] = useState<RemoteMachineRecord | null>(null);
  const [fingerprints, setFingerprints] = useState<readonly MachineHostKeyFingerprint[] | null>(null);
  const [scanning, setScanning] = useState(false);

  const reset = useCallback(() => {
    setStep('form');
    setForm(EMPTY_FORM);
    setSubmitting(false);
    setError(null);
    setHint(null);
    setMachine(null);
    setFingerprints(null);
    setScanning(false);
  }, []);

  useEffect(() => {
    if (open && !wasOpenRef.current) reset();
    wasOpenRef.current = open;
  }, [open, reset]);

  const runScan = useCallback(async (target: RemoteMachineRecord) => {
    setScanning(true);
    setError(null);
    setHint(null);
    setFingerprints(null);
    try {
      const result = await machines.scanHostKey(target.id);
      if (result.status === 'scanned') {
        setFingerprints(result.fingerprints);
      } else {
        setError(result.error.message);
        setHint(result.error.hint || null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setHint(null);
    } finally {
      setScanning(false);
    }
  }, [machines]);

  const runConnect = useCallback(async (target: RemoteMachineRecord) => {
    setSubmitting(true);
    setError(null);
    setHint(null);
    try {
      const result = await machines.connect(target.id);
      if (result.status === 'error') {
        setError(result.error.message);
        setHint(result.error.hint || null);
        return;
      }
      onComplete?.(target.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setHint(null);
    } finally {
      setSubmitting(false);
    }
  }, [machines, onClose, onComplete]);

  // The scan and connect steps run their action on entry (and on retry).
  useEffect(() => {
    if (!open) return;
    if (step === 'scan' && machine && !scanning && fingerprints === null && error === null) {
      void runScan(machine);
    }
  }, [open, step, machine, scanning, fingerprints, error, runScan]);

  useEffect(() => {
    if (!open) return;
    if (step === 'connect' && machine && !submitting && error === null) {
      void runConnect(machine);
    }
  }, [open, step, machine, submitting, error, runConnect]);

  const handleCreate = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    setHint(null);
    try {
      const created = await machines.createMachine({
        label: form.label.trim(),
        host: form.host.trim(),
        port: Number.parseInt(form.port, 10) || 22,
        user: form.user.trim(),
        agentCommand: form.agentCommand.trim() || 'orchid-agent',
      });
      setMachine(created);
      setStep('scan');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [form, machines]);

  const handleConfirm = useCallback(async () => {
    if (!machine) return;
    setSubmitting(true);
    setError(null);
    setHint(null);
    try {
      const result = await machines.confirmHostKey(machine.id);
      if (result.status === 'error') {
        setError(result.error.message);
        setHint(result.error.hint || null);
        return;
      }
      setStep('connect');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [machine, machines]);

  const handleRetryScan = useCallback(() => {
    setError(null);
    setHint(null);
    setFingerprints(null);
    if (machine) void runScan(machine);
  }, [machine, runScan]);

  const handleRetryConnect = useCallback(() => {
    setError(null);
    setHint(null);
    if (machine) void runConnect(machine);
  }, [machine, runConnect]);

  const formValid = form.label.trim() !== '' && form.host.trim() !== '';

  return (
    <DialogSurface
      isOpen={open}
      onClose={onClose}
      labelledBy="add-machine-title"
      describedBy="add-machine-desc"
      initialFocusRef={labelInputRef}
      variant="modal"
    >
      <h2 id="add-machine-title" className="text-lg font-semibold">
        Add remote machine
      </h2>
      <p id="add-machine-desc" className="pt-1 text-sm text-base-content/70">
        {step === 'form' && 'Connect to an SSH host running orchid-agent. Keys and agent authentication only.'}
        {step === 'scan' && 'Fingerprints come from ssh-keyscan; confirming pins them for every future connection.'}
        {step === 'connect' && 'Attaching to the remote agent daemon over SSH.'}
      </p>

      {step === 'form' && (
        <div className="flex flex-col gap-3 pt-3">
          <FormField label="Label" htmlFor="add-machine-label" required>
            <TextInput
              id="add-machine-label"
              ref={labelInputRef}
              value={form.label}
              onChange={(event) => setForm((prev) => ({ ...prev, label: event.target.value }))}
              placeholder="Build server"
            />
          </FormField>
          <FormField label="Host" htmlFor="add-machine-host" hint="Hostname, IP, or ssh-config alias" required>
            <TextInput
              id="add-machine-host"
              value={form.host}
              onChange={(event) => setForm((prev) => ({ ...prev, host: event.target.value }))}
              placeholder="build.example.com"
            />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Port" htmlFor="add-machine-port">
              <TextInput
                id="add-machine-port"
                value={form.port}
                inputMode="numeric"
                onChange={(event) => setForm((prev) => ({ ...prev, port: event.target.value }))}
              />
            </FormField>
            <FormField label="User" htmlFor="add-machine-user" hint="Empty = ssh default">
              <TextInput
                id="add-machine-user"
                value={form.user}
                onChange={(event) => setForm((prev) => ({ ...prev, user: event.target.value }))}
                placeholder="deploy"
              />
            </FormField>
          </div>
          <FormField label="Agent command" htmlFor="add-machine-agent" hint="orchid-agent binary on the remote">
            <TextInput
              id="add-machine-agent"
              value={form.agentCommand}
              onChange={(event) => setForm((prev) => ({ ...prev, agentCommand: event.target.value }))}
            />
          </FormField>
        </div>
      )}

      {step === 'scan' && machine && (
        <div className="flex flex-col gap-3 pt-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">{machine.label}</span>
            <span className="mono text-base-content/60">{machine.host}</span>
            {scanning && <Spinner size="xs" />}
          </div>
          {scanning && !fingerprints && (
            <p className="text-sm text-base-content/70">Scanning host keys…</p>
          )}
          {fingerprints && (
            <>
              <p className="text-sm text-base-content/70">
                Verify these fingerprints out-of-band before trusting the host:
              </p>
              <ul className="m-0 flex flex-col gap-1 p-0">
                {fingerprints.map((fingerprint) => (
                  <li
                    key={`${fingerprint.algorithm}:${fingerprint.fingerprintSha256}`}
                    className="flex items-center justify-between gap-3 rounded-md border border-base-300 bg-base-100/60 px-3 py-1.5"
                  >
                    <span className="mono text-xs">{fingerprint.algorithm}</span>
                    <span className="mono truncate text-xs">{fingerprint.fingerprintSha256}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {step === 'connect' && machine && (
        <div className="flex flex-col gap-3 pt-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">{machine.label}</span>
            {submitting ? (
              <ConnectionStatusBadge state="connecting" />
            ) : (
              <ConnectionStatusBadge state={error ? 'offline' : 'connected'} />
            )}
          </div>
          {submitting && <p className="text-sm text-base-content/70">Connecting to {machine.host}…</p>}
        </div>
      )}

      {error && (
        <Alert tone="error" icon="alert" className="mt-3">
          <div className="text-sm">{error}</div>
          {hint && hint.trim() !== '' && (
            <div className="text-xs text-base-content/80">{hint}</div>
          )}
        </Alert>
      )}

      <div className="modal-action">
        {step === 'form' && (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => void handleCreate()}
              disabled={!formValid}
              loading={submitting}
            >
              Continue
            </Button>
          </>
        )}
        {step === 'scan' && (
          <>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            {!fingerprints && error && (
              <Button variant="primary" onClick={handleRetryScan} disabled={scanning}>
                Retry scan
              </Button>
            )}
            <Button
              variant="primary"
              onClick={() => void handleConfirm()}
              disabled={!fingerprints || submitting}
              loading={submitting}
            >
              Trust and continue
            </Button>
          </>
        )}
        {step === 'connect' && (
          <>
            <Button variant="ghost" onClick={onClose}>Close</Button>
            {error && (
              <Button variant="primary" onClick={handleRetryConnect} disabled={submitting}>
                Retry connect
              </Button>
            )}
          </>
        )}
      </div>
    </DialogSurface>
  );
}
