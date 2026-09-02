/**
 * InputArea — unified composer shell with send/cancel inside the field.
 *
 * Layout:
 *   [ textarea ………………………………… [ ↑ / ■ ] ]
 *
 * Model selector lives in Footer (left of context radial).
 * Enter send · Shift+Enter newline · Ctrl/Cmd+S send · Esc multi-stage interrupt.
 * Slash commands: type `/` to open autocomplete above the input.
 */
import { memo, useRef, useCallback, useEffect, useState, useMemo } from 'react';
import type { CommandContext, SessionSummary } from '../../shared/types/ipc-boundary';
import type { ProviderModelOption } from '../../shared/types/ipc';
import type { ChatStatus, InterruptState } from '../hooks/useChat';
import { useAskQuestion } from '../hooks/useAskQuestion';
import { usePermissionApproval } from '../hooks/usePermissionApproval';
import type { PaletteResult } from '../commands/registry';
import {
  evaluateComposerSend,
  shouldReleaseComposerSendLock,
} from '../utils/composer-send-lock';
import { AskQuestionOverlay } from './AskQuestionOverlay';
import { PermissionApprovalPanel } from './PermissionApprovalPanel';
import { SlashCommandMenu } from './SlashCommandMenu';
import { IconButton } from './ui/IconButton';
import {
  TEXTAREA_MIN_HEIGHT_PX,
  resizeComposerTextarea,
} from './input-area/composer-autosize';
import {
  resolveCancelTitle,
  resolveComposerActionKey,
} from './input-area/composer-action-controls';
import {
  consumeExactSlashCommand,
  consumeSlashMenuKey,
  isComposerSendKey,
} from './input-area/slash-menu-keys';
import { applySlashSelection } from './input-area/slash-selection';
import { useComposerAutoResize } from './input-area/useComposerAutoResize';
import { useSlashResults } from './input-area/useSlashResults';
import type { SlashSubPicker } from './input-area/slash-results';

interface InputAreaProps {
  /** Session whose pending ask_question calls may own this composer. */
  sessionId: string | null;
  status: ChatStatus;
  model: string;
  /** Display labels for opaque connection-scoped model picker keys. */
  modelLabels?: Readonly<Record<string, string>>;
  modelDetails?: Readonly<Record<string, ProviderModelOption>>;
  /** Staged Esc / cancel-button interrupt phase. */
  interruptState?: InterruptState;
  /** Resolves once the send attempt settles; the value is caller-defined. */
  onSend: (message: string) => Promise<unknown>;
  onCancel: () => Promise<void>;
  /** Called when the user submits a message while the agent is streaming. */
  onQueue?: (message: string) => void;
  /** When set, enables `/command` autocomplete above the input. */
  commandContext?: CommandContext;
  sessions?: SessionSummary[];
  currentTheme?: string;
  currentPersonality?: string;
  personalityNames?: readonly string[];
  /** When false, chat send is gated until a project folder is chosen (R3). */
  workspaceBound?: boolean;
  onPickProjectDir?: () => void;
  /** A ready connection is required for LLM-backed sends, not local commands. */
  providerAvailable?: boolean;
  /** A typed `{ connectionId, modelId }` selection is required for a send. */
  modelSelected?: boolean;
  onOpenProviders?: () => void;
  /** ChatView keeps this subtree mounted while the Subagent View owns focus. */
  isViewActive?: boolean;
  /**
   * The session still owns queued/running subagents: Esc must reach the
   * third interrupt layer even when no main-agent turn is live (issue #145).
   */
  hasRunningSubagents?: boolean;
  /**
   * One-shot composer text restore (e.g. a trust-gated send the user
   * declined). The text replaces the input once; `consumed()` reports back so
   * the owner drops the restore and cannot fire it twice.
   */
  draftRestore?: { text: string; consumed: () => void } | null;
}

export type InputEscapeAction = 'cancel-question' | 'cancel-chat' | 'none';

/** Resolve global Escape ownership without allowing chat cancellation to race a question. */
export function resolveInputEscapeAction(options: {
  hasActiveQuestion: boolean;
  canInterrupt: boolean;
  /** Session still owns queued/running subagents (third interrupt layer). */
  hasRunningSubagents: boolean;
  isSlashMode: boolean;
  isViewActive: boolean;
  settingsOpen: boolean;
}): InputEscapeAction {
  if (options.isViewActive || options.settingsOpen) return 'none';
  if (options.hasActiveQuestion) return 'cancel-question';
  if ((!options.canInterrupt && !options.hasRunningSubagents) || options.isSlashMode) return 'none';
  return 'cancel-chat';
}

interface ComposerPlaceholderState {
  isStreaming: boolean;
  interruptState: InterruptState;
  workspaceBound: boolean;
  providerAvailable: boolean;
  modelSelected: boolean;
  hasCommandContext: boolean;
}

function resolveComposerPlaceholder(state: ComposerPlaceholderState): string {
  if (state.isStreaming) {
    return 'Type to queue a message or run /command… (Esc to interrupt)';
  }
  if (state.interruptState === 'confirmAgent') {
    return 'Streaming… (Esc or ■ to interrupt)';
  }
  if (state.interruptState === 'confirmSubagents') {
    return 'Type a follow-up, or Esc / ■ to cancel subagents…';
  }
  if (!state.workspaceBound) {
    return 'Choose a project folder first… (or /cd)';
  }
  if (!state.providerAvailable) {
    return 'Set up a provider before chatting…';
  }
  if (!state.modelSelected) {
    return 'Select a connection and model first…';
  }
  if (state.hasCommandContext) {
    return 'Type a message or /command… (Enter to send)';
  }
  return 'Type a message… (Enter to send, Shift+Enter for newline)';
}

export const InputArea = memo(function InputArea({
  sessionId,
  status,
  model: _model,
  modelLabels,
  modelDetails,
  interruptState = 'idle',
  onSend,
  onCancel,
  onQueue,
  commandContext,
  sessions = [],
  currentTheme = 'default',
  currentPersonality = 'default',
  personalityNames = [],
  workspaceBound = true,
  onPickProjectDir,
  providerAvailable = true,
  modelSelected = true,
  onOpenProviders,
  isViewActive = false,
  hasRunningSubagents = false,
  draftRestore = null,
}: InputAreaProps) {
  /** Blocks rapid double-Enter before parent status re-renders to streaming. */
  const isSendingRef = useRef(false);
  const [input, setInput] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [subPicker, setSubPicker] = useState<SlashSubPicker>(null);
  const {
    textareaRef,
    resetComposerHeight,
    resetComposerHeightAndFocus,
  } = useComposerAutoResize(TEXTAREA_MIN_HEIGHT_PX);
  /** Pending ask_question stepper; while active it owns the composer area. */
  const askQuestion = useAskQuestion(sessionId);
  const hasActiveQuestion = askQuestion.active !== null;
  /** Pending permission approval; while active it owns the composer area. */
  const permission = usePermissionApproval(sessionId);

  const isStreaming = status === 'streaming';
  const hasInput = Boolean(input.trim());
  const confirming =
    interruptState === 'confirmAgent' || interruptState === 'confirmSubagents';
  /** Agent stream active, or waiting for subagent-cancel confirmation. */
  const canInterrupt =
    isStreaming || interruptState === 'confirmAgent' || interruptState === 'confirmSubagents';
  /**
   * Show cancel (square) while streaming with no input / first confirm, and
   * during confirmSubagents only when the input is empty. Typing a message
   * switches the control to queue (streaming) or send (confirmSubagents).
   */
  const showCancel =
    (isStreaming && !hasInput) ||
    interruptState === 'confirmAgent' ||
    (interruptState === 'confirmSubagents' && !hasInput);

  /** Slash mode: input starts with `/` (single line) or a sub-picker is open. */
  const isSlashMode =
    Boolean(commandContext) &&
    (subPicker !== null || (input.startsWith('/') && !input.includes('\n')));

  const slashResults = useSlashResults({
    commandContext,
    input,
    isSlashMode,
    subPicker,
    currentTheme,
    currentPersonality,
    personalityNames,
    sessions,
    modelDetails,
    modelLabels,
  });

  // Keep selection in range when results change
  useEffect(() => {
    if (selectedIndex >= slashResults.length) {
      setSelectedIndex(Math.max(0, slashResults.length - 1));
    }
  }, [slashResults.length, selectedIndex]);

  // Reset selection when query/sub-picker changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [input, subPicker]);

  const closeSlashMenu = useCallback(() => {
    setSubPicker(null);
    setSelectedIndex(0);
  }, []);

  const openSubPicker = useCallback((picker: NonNullable<SlashSubPicker>) => {
    setSubPicker(picker);
    setInput('');
    setSelectedIndex(0);
  }, []);

  const leaveSubPicker = useCallback(
    (picker: NonNullable<SlashSubPicker>, resetSelection: boolean) => {
      setSubPicker(null);
      setInput(picker);
      if (resetSelection) setSelectedIndex(0);
    },
    [],
  );

  const clearAndClose = useCallback(() => {
    setInput('');
    setSubPicker(null);
    setSelectedIndex(0);
    resetComposerHeightAndFocus();
  }, [resetComposerHeightAndFocus]);

  const slashContext = useMemo<CommandContext | null>(() => {
    if (!commandContext) return null;
    return {
      ...commandContext,
      onClose: () => {
        clearAndClose();
        commandContext.onClose();
      },
    };
  }, [commandContext, clearAndClose]);

  const handleSelectResult = useCallback(
    async (result: PaletteResult) => {
      if (!slashContext) return;
      await applySlashSelection(result, {
        commandContext: slashContext,
        modelDetails,
        modelLabels,
        clearAndClose,
        openSubPicker,
      });
    },
    [slashContext, clearAndClose, openSubPicker, modelDetails, modelLabels],
  );

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    resizeComposerTextarea(el, () => el.scrollHeight);
  }, [textareaRef]);

  useEffect(() => {
    // Release send lock when not streaming: idle success path and error/gate
    // recovery (status 'error' never returned to idle without this).
    if (shouldReleaseComposerSendLock(status, interruptState)) {
      isSendingRef.current = false;
    }
    if (!isViewActive && status === 'idle' && interruptState === 'idle') {
      textareaRef.current?.focus();
    }
  }, [status, interruptState, isViewActive]);

  useEffect(() => {
    resizeTextarea();
  }, [input, resizeTextarea]);

  // One-shot draft restore: apply the stashed text, then tell the owner it
  // landed so the same restore cannot re-fire on later re-renders.
  useEffect(() => {
    if (!draftRestore) return;
    setInput(draftRestore.text);
    draftRestore.consumed();
  }, [draftRestore]);

  // Multi-stage Esc — same path as the cancel button (agent → subagents).
  // Model dropup closes first; slash menu owns Esc while open.
  // When Settings is open ChatView stays mounted but Escape belongs to ConfigView.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (isViewActive) return;
      if (document.documentElement.dataset.orchidSettingsOpen === '1') return;
      const action = resolveInputEscapeAction({
        hasActiveQuestion,
        canInterrupt,
        hasRunningSubagents,
        isSlashMode,
        isViewActive: false,
        settingsOpen: false,
      });
      if (action === 'none') return;
      event.preventDefault();
      if (action === 'cancel-question') {
        void askQuestion.cancelAll();
        return;
      }
      void onCancel();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [askQuestion.cancelAll, canInterrupt, hasActiveQuestion, hasRunningSubagents, isSlashMode, isViewActive, onCancel]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    // status and isSendingRef both guard: status can lag one frame behind Enter.
    // Allow send during confirmSubagents so a follow-up can be queued after cancel UI.
    const gate = evaluateComposerSend({
      trimmed,
      isStreaming,
      isSending: isSendingRef.current,
      workspaceBound,
      providerAvailable,
      modelSelected,
    });
    if (gate.action === 'ignore') return;
    if (gate.action === 'queue') {
      if (onQueue) {
        setInput('');
        onQueue(trimmed);
        resetComposerHeight();
      }
      return;
    }
    if (gate.action === 'pick-project') {
      onPickProjectDir?.();
      return;
    }
    if (gate.action === 'open-providers') {
      onOpenProviders?.();
      return;
    }
    if (gate.action === 'need-model') return;
    isSendingRef.current = true;
    setInput('');
    setSubPicker(null);
    try {
      await onSend(trimmed);
    } catch {
      // Failure path: release immediately so a subsequent send is possible.
      // Gate failures that resolve without throwing are cleared via status effect.
      isSendingRef.current = false;
    }
    resetComposerHeight();
  }, [
    input,
    isStreaming,
    modelSelected,
    onOpenProviders,
    onPickProjectDir,
    onQueue,
    onSend,
    providerAvailable,
    resetComposerHeight,
    workspaceBound,
  ]);

  const selectNextSlashResult = useCallback(() => {
    setSelectedIndex((prev) => Math.min(prev + 1, slashResults.length - 1));
  }, [slashResults.length]);

  const selectPreviousSlashResult = useCallback(() => {
    setSelectedIndex((prev) => Math.max(prev - 1, 0));
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Slash menu navigation
      if (
        isSlashMode &&
        consumeSlashMenuKey(e, {
          results: slashResults,
          selectedIndex,
          subPicker,
          input,
          selectNext: selectNextSlashResult,
          selectPrevious: selectPreviousSlashResult,
          selectResult: (result) => void handleSelectResult(result),
          leaveSubPicker,
          closeMenu: closeSlashMenu,
          setInputValue: setInput,
        })
      ) {
        return;
      }

      // Sub-picker open with no options: don't send filter text as a chat message
      if (subPicker && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        return;
      }

      // Exact slash command with no fuzzy matches: try exact match, else send as chat
      if (isComposerSendKey(e)) {
        if (
          consumeExactSlashCommand(e, {
            isSlashMode,
            hasResults: slashResults.length > 0,
            input,
            commandContext: slashContext,
            selectResult: (result) => void handleSelectResult(result),
          })
        ) {
          return;
        }

        e.preventDefault();
        void handleSend();
        return;
      }

      if (e.key === 'c' && (e.ctrlKey || e.metaKey) && !input.trim()) {
        e.preventDefault();
        setInput('');
        return;
      }
    },
    [
      isSlashMode,
      slashResults,
      selectedIndex,
      selectNextSlashResult,
      selectPreviousSlashResult,
      handleSelectResult,
      subPicker,
      leaveSubPicker,
      closeSlashMenu,
      input,
      slashContext,
      handleSend,
    ],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      // Leaving slash mode when user deletes the leading `/` (and not in sub-picker)
      if (subPicker && value.startsWith('/')) {
        // Typing a new slash command from sub-picker resets to command mode
        setSubPicker(null);
      }
      setInput(value);
    },
    [subPicker],
  );

  const showMenu = isSlashMode && (slashResults.length > 0 || subPicker !== null || input === '/');

  const cancelVariant = interruptState === 'confirmSubagents' ? 'warning' : 'error';

  // During streaming the user can type to queue; only confirmAgent blocks input.
  const inputDisabled = interruptState === 'confirmAgent';
  const plainChatBlocked = !workspaceBound || !providerAvailable || !modelSelected;

  // A pending permission approval owns the composer area; the composer (and
  // every send path) stays unmounted until it is approved or denied. The chat
  // stream above stays mounted and scrollable. Takes precedence over a pending
  // question because it gates a potentially dangerous tool call.
  if (permission.active) {
    return (
      <div className="orchid-composer-area">
        <section className="orchid-permission" aria-label="Permission request">
          <PermissionApprovalPanel
            key={permission.active.toolCallId}
            request={permission.active}
            submittingDecision={permission.submittingDecision}
            onAnswer={permission.answer}
          />
        </section>
      </div>
    );
  }

  // A pending ask_question tool call owns the composer area; the composer (and
  // every send path) stays unmounted until it is answered or cancelled.
  if (askQuestion.active) {
    return (
      <div className="orchid-composer-area">
        <AskQuestionOverlay question={askQuestion} />
      </div>
    );
  }

  return (
    <div className="orchid-composer-area">
      {!workspaceBound && (
        <div className="orchid-composer-gate orchid-state-enter alert alert-warning" role="status">
          <span>Select a project folder before chatting.</span>
          {onPickProjectDir && (
            <IconButton
              label="Open folder"
              icon="folder"
              size="xs"
              variant="warning"
              onClick={onPickProjectDir}
              iconSize={12}
            >
              Open folder
            </IconButton>
          )}
        </div>
      )}

      {!providerAvailable && (
        <div
          className="orchid-composer-gate orchid-state-enter alert alert-info"
          role="status"
          aria-live="polite"
        >
          <span>A provider connection is required before Orchid can send an LLM request.</span>
          {onOpenProviders && (
            <IconButton
              label="Set up provider"
              icon="settings"
              size="xs"
              variant="primary"
              onClick={onOpenProviders}
              iconSize={12}
            >
              Set up provider
            </IconButton>
          )}
        </div>
      )}

      {providerAvailable && !modelSelected && (
        <div
          className="orchid-composer-gate orchid-state-enter alert alert-warning"
          role="status"
          aria-live="polite"
        >
          <span>Select a connection and model before sending a message.</span>
        </div>
      )}

      {showMenu && (
        <SlashCommandMenu
          results={slashResults}
          selectedIndex={selectedIndex}
          query={subPicker ? input : input.trim()}
          subPicker={subPicker}
          onSelect={(r) => void handleSelectResult(r)}
          onHover={setSelectedIndex}
        />
      )}

      <div
        className={`orchid-composer ${isStreaming || confirming ? 'streaming' : ''} ${
          showCancel ? 'composer-cancel-mode' : ''
        }`}
      >
        <div className="orchid-composer-shell">
          <textarea
            ref={textareaRef}
            className="orchid-composer-textarea"
            data-orchid-composer
            value={input}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder={resolveComposerPlaceholder({
              isStreaming,
              interruptState,
              workspaceBound,
              providerAvailable,
              modelSelected,
              hasCommandContext: Boolean(commandContext),
            })}
            disabled={inputDisabled}
            rows={1}
            aria-autocomplete={commandContext ? 'list' : undefined}
            aria-expanded={showMenu || undefined}
            aria-controls={showMenu ? 'slash-command-menu' : undefined}
          />

          <div className="orchid-composer-controls">
            <span
              key={resolveComposerActionKey({ showCancel, showMenu, isStreaming, hasInput })}
              className="orchid-composer-action-swap"
            >
            {showCancel ? (
              <IconButton
                label={resolveCancelTitle(interruptState)}
                icon="square"
                size="sm"
                variant={cancelVariant}
                className="orchid-composer-action btn-square"
                onClick={() => void onCancel()}
                iconSize={14}
              />
            ) : isStreaming && hasInput && !showMenu ? (
              <IconButton
                label="Queue message"
                icon="list"
                size="sm"
                variant="primary"
                className="orchid-composer-action btn-square"
                onClick={() => void handleSend()}
                disabled={input.trim().startsWith('/')}
                iconSize={16}
              />
            ) : (
              <IconButton
                label={showMenu ? 'Run command' : 'Send'}
                icon="arrowUp"
                size="sm"
                variant="primary"
                className="orchid-composer-action btn-square"
                onClick={() => {
                  if (showMenu && slashResults[selectedIndex]) {
                    void handleSelectResult(slashResults[selectedIndex]);
                    return;
                  }
                  void handleSend();
                }}
                disabled={!hasInput || (!showMenu && plainChatBlocked)}
                iconSize={16}
              />
            )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});
