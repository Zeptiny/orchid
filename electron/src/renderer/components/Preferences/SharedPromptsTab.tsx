/**
 * SharedPromptsTab — edit the fixed shared prompt slots.
 *
 * Two singleton slots (All agents / Subagents), each with a global file and an
 * optional project override (replace semantics — a non-empty project file
 * replaces the global one for that slot). Unlike named definitions there is
 * no add/rename: the files themselves are the identity.
 *
 * Receives preloaded definitions data from ConfigView to avoid tab-switch flicker.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  DefinitionScope,
  DefinitionsListResult,
  ManagedSharedPrompt,
  SharedPromptSlot,
} from '../../../shared/types/definitions';
import { onOrchidEvent } from '../../utils/events';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { ConfigCard } from '../ui/ConfigCard';
import { Panel } from '../ui/Panel';
import { SectionHeader } from '../ui/SectionHeader';
import { StatusBadge } from '../ui/StatusBadge';
import { ScopeToggle } from './ScopeToggle';

export interface SharedPromptsTabProps {
  data: DefinitionsListResult;
  onReload: () => Promise<void>;
  lockedScope?: 'global' | 'project';
}

const SLOT_META: Record<SharedPromptSlot, { title: string; description: string }> = {
  'all-agents': {
    title: 'All agents',
    description:
      'Injected into the main agent and every subagent. Use for rules that must be respected by all agents.',
  },
  subagents: {
    title: 'Subagents',
    description:
      'Injected into subagents only, after the all-agents rules. Use for subagent-specific guidance such as parallel-work awareness and mutation limits.',
  },
};

interface SlotEditorState {
  scope: DefinitionScope;
  content: string;
  dirty: boolean;
}

export function SharedPromptsTab({ data, onReload, lockedScope }: SharedPromptsTabProps) {
  const [error, setError] = useState<string | null>(null);
  const [savingSlot, setSavingSlot] = useState<SharedPromptSlot | null>(null);
  const [editors, setEditors] = useState<
    Record<SharedPromptSlot, SlotEditorState>
  >({
    'all-agents': { scope: lockedScope ?? 'global', content: '', dirty: false },
    subagents: { scope: lockedScope ?? 'global', content: '', dirty: false },
  });

  useEffect(() => {
    return onOrchidEvent('orchid:definitions-workspace-changed', () => {
      setError(null);
    });
  }, []);

  const projectDir = data.projectDir;
  const projectAvailable = projectDir != null;

  // Reset non-dirty editors to the on-disk state whenever the definitions
  // snapshot changes. Dirty slots keep their drafts — the two editors are
  // independently always-mounted, so saving one slot must not wipe the
  // other's unsaved edits.
  useEffect(() => {
    setEditors((prev) => {
      const initial: Record<SharedPromptSlot, SlotEditorState> = {
        'all-agents': { scope: lockedScope ?? 'global', content: '', dirty: false },
        subagents: { scope: lockedScope ?? 'global', content: '', dirty: false },
      };
      if (lockedScope) {
        for (const slot of ['all-agents', 'subagents'] as const) {
          const entry = data.sharedPrompts.find(
            (p) => p.slot === slot && p.scope === lockedScope,
          );
          initial[slot] = {
            scope: lockedScope,
            content: entry?.content ?? '',
            dirty: false,
          };
        }
      } else {
        // Prefer the most specific available scope for editing: a project
        // override when present, otherwise the global entry.
        for (const prompt of data.sharedPrompts) {
          if (initial[prompt.slot].scope === 'project') continue;
          initial[prompt.slot] = {
            scope: prompt.scope,
            content: prompt.content,
            dirty: false,
          };
        }
      }
      return {
        'all-agents': prev['all-agents'].dirty ? prev['all-agents'] : initial['all-agents'],
        subagents: prev.subagents.dirty ? prev.subagents : initial.subagents,
      };
    });
  }, [data, lockedScope]);

  const findEntry = useCallback(
    (slot: SharedPromptSlot, scope: DefinitionScope): ManagedSharedPrompt | undefined =>
      data.sharedPrompts.find((p) => p.slot === slot && p.scope === scope),
    [data.sharedPrompts],
  );

  const handleScopeChange = useCallback(
    (slot: SharedPromptSlot, scope: DefinitionScope) => {
      if (lockedScope) return;
      setEditors((prev) => {
        if (prev[slot].dirty) {
          const ok = window.confirm(
            `Discard unsaved changes to the ${slot} prompt before switching scope?`,
          );
          if (!ok) return prev;
        }
        return {
          ...prev,
          [slot]: {
            scope,
            content: findEntry(slot, scope)?.content ?? '',
            dirty: false,
          },
        };
      });
    },
    [lockedScope, findEntry],
  );

  const handleContentChange = useCallback(
    (slot: SharedPromptSlot, content: string) => {
      setEditors((prev) => ({
        ...prev,
        [slot]: { ...prev[slot], content, dirty: true },
      }));
    },
    [],
  );

  const handleSave = useCallback(
    async (slot: SharedPromptSlot) => {
      if (!window.orchid?.sharedPrompt?.save) return;
      const editor = editors[slot];
      setSavingSlot(slot);
      setError(null);
      try {
        await window.orchid.sharedPrompt.save({
          scope: editor.scope,
          slot,
          content: editor.content,
        });
        // Clear the dirty flag so the post-reload reset re-syncs this slot
        // from disk without wiping the other slot's still-dirty draft.
        setEditors((prev) => ({ ...prev, [slot]: { ...prev[slot], dirty: false } }));
        await onReload();
      } catch (err) {
        setError(err instanceof Error ? err.message : `Failed to save ${slot} prompt`);
      } finally {
        setSavingSlot(null);
      }
    },
    [editors, onReload],
  );

  const handleDelete = useCallback(
    async (slot: SharedPromptSlot) => {
      if (!window.orchid?.sharedPrompt?.delete) return;
      const editor = editors[slot];
      const ok = window.confirm(
        `Delete the ${editor.scope} "${slot}" prompt file? The slot falls back to ` +
          (editor.scope === 'project' ? 'the global prompt' : 'no prompt') +
          '.',
      );
      if (!ok) return;
      setError(null);
      try {
        await window.orchid.sharedPrompt.delete({ scope: editor.scope, slot });
        await onReload();
      } catch (err) {
        if (err instanceof Error && err.message.includes('not found')) {
          await onReload();
          return;
        }
        setError(err instanceof Error ? err.message : `Failed to delete ${slot} prompt`);
      }
    },
    [editors, onReload],
  );

  const handleReveal = useCallback(async (prompt: ManagedSharedPrompt) => {
    try {
      await window.orchid?.definitions?.reveal({ path: prompt.path });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reveal path');
    }
  }, []);

  const renderSlot = (slot: SharedPromptSlot) => {
    const meta = SLOT_META[slot];
    const editor = editors[slot];
    const entry = findEntry(slot, editor.scope);
    const projectEntry = findEntry(slot, 'project');
    const effective =
      projectEntry ?? findEntry(slot, 'global') ?? undefined;

    return (
      <ConfigCard key={slot} className="flex flex-col gap-3 p-4">
        <SectionHeader
          title={meta.title}
          actions={
            entry ? (
              <Button
                variant="ghost"
                size="xs"
                type="button"
                onClick={() => void handleReveal(entry)}
              >
                Reveal
              </Button>
            ) : undefined
          }
        />
        <p className="config-card-desc text-sm text-base-content/70">{meta.description}</p>

        {!lockedScope && (
          <div className="config-scope-bar">
            <ScopeToggle
              value={editor.scope}
              onChange={(value) => handleScopeChange(slot, value as DefinitionScope)}
              projectAvailable={projectAvailable}
              projectDir={projectDir}
              includeAll={false}
              ariaLabel={`${meta.title} prompt scope`}
            />
          </div>
        )}

        {projectEntry && editor.scope === 'global' && (
          <div className="flex items-center gap-2">
            <StatusBadge tone="warning" size="xs" outline>
              overridden by project
            </StatusBadge>
            <span className="text-xs text-base-content/60">
              Editing the global file has no effect until the project override is removed.
            </span>
          </div>
        )}

        <textarea
          className="textarea textarea-bordered w-full font-mono text-xs"
          rows={10}
          value={editor.content}
          placeholder={
            entry
              ? undefined
              : 'No prompt in this scope yet — type rules and save to create the file.'
          }
          onChange={(e) => handleContentChange(slot, e.target.value)}
          aria-label={`${meta.title} prompt (markdown)`}
        />

        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-base-content/60">
            File: {editor.scope === 'global' ? '~/.orchid/prompts' : '.orchid/prompts'}/{slot}.md
            {effective && editor.scope !== effective.scope
              ? ` · effective: ${effective.scope}`
              : ''}
          </span>
          <div className="flex justify-end gap-2">
            {entry && (
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => void handleDelete(slot)}
              >
                Delete
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              type="button"
              onClick={() => void handleSave(slot)}
              loading={savingSlot === slot}
              disabled={!editor.dirty}
            >
              Save
            </Button>
          </div>
        </div>
      </ConfigCard>
    );
  };

  return (
    <div className="config-form flex flex-col gap-4">
      <Panel as="section" className="config-fieldset flex flex-col gap-3">
        <SectionHeader title="Shared Prompts" />

        {error && (
          <Alert tone="error" className="py-2 text-sm mb-3" action={
            <Button variant="ghost" size="xs" type="button" onClick={() => setError(null)}>
              Dismiss
            </Button>
          }>
            {error}
          </Alert>
        )}

        {(['all-agents', 'subagents'] as const).map(renderSlot)}

        <div className="config-note text-xs text-base-content/60 mt-2">
          Shared prompts are injected into the system prompt of every turn. A
          non-empty project file replaces the global file for that slot (no
          merge). Internal agents (session naming, web fetch) do not receive
          shared prompts. Changes apply from the next turn.
        </div>
      </Panel>
    </div>
  );
}
