/**
 * The shell's floating surfaces: command palette, shortcut reference, and the
 * project-trust dialog. They render above the three panels and own the keyboard
 * while open.
 */
import { CommandPalette } from '../CommandPalette';
import { ShortcutsHelp } from '../ShortcutsHelp';
import { TrustProjectDialog } from '../TrustProjectDialog';
import type { Dispatch, SetStateAction } from 'react';
import type { CommandContext, SessionSummary } from '../../../shared/types/ipc-boundary';
import type { UseTrustPromptReturn } from '../../hooks/useTrustPrompt';
import type { UseChatViewConfigReturn } from './use-chat-view-config';
import type { UseChatViewModelsReturn } from './use-chat-view-models';

export interface ChatViewOverlayStackProps {
  paletteOpen: boolean;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  helpOpen: boolean;
  setHelpOpen: Dispatch<SetStateAction<boolean>>;
  commandContext: CommandContext;
  sessions: SessionSummary[];
  config: UseChatViewConfigReturn;
  models: UseChatViewModelsReturn;
  trustPrompt: UseTrustPromptReturn;
  /** Trust declined: the stashed gated send returns to the composer. */
  onDeclineTrust: () => void;
}

/** A drifted fingerprint reviews as `changed`; anything else is a first grant. */
function pendingTrustState(pending: UseTrustPromptReturn['pending']) {
  return pending?.info.state === 'changed' ? 'changed' : 'untrusted';
}

export function ChatViewOverlayStack({
  paletteOpen,
  setPaletteOpen,
  helpOpen,
  setHelpOpen,
  commandContext,
  sessions,
  config,
  models,
  trustPrompt,
  onDeclineTrust,
}: ChatViewOverlayStackProps) {
  return (
    <>
      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        context={commandContext}
        sessions={sessions}
        currentTheme={config.currentTheme}
        currentPersonality={config.currentPersonality}
        personalityNames={config.personalityNames}
        modelLabels={models.providerModelLabels}
        modelDetails={models.providerModelDetails}
      />

      <ShortcutsHelp isOpen={helpOpen} onClose={() => setHelpOpen(false)} />

      <TrustProjectDialog
        open={trustPrompt.pending != null}
        cwd={trustPrompt.pending?.cwd ?? ''}
        trustState={pendingTrustState(trustPrompt.pending)}
        report={trustPrompt.pending?.info.report ?? null}
        busy={trustPrompt.busy}
        error={trustPrompt.error}
        onGrant={() => void trustPrompt.grant()}
        onDecline={onDeclineTrust}
      />
    </>
  );
}
