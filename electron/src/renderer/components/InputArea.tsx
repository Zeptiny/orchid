/**
 * InputArea — composer with model selector and send/cancel.
 *
 * Layout (right-aligned controls, image-#1 style model chip):
 *   [ textarea … ] [ model ▾ ] [ ↑ / ■ ]
 *
 * Enter send · Shift+Enter newline · Ctrl/Cmd+S send · Esc multi-stage interrupt.
 * Slash commands: type `/` to open autocomplete above the input.
   * Context radial lives in Footer (always right-aligned).
 */
import { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import type { CommandContext, SessionSummary } from '../../shared/types/ipc-boundary';
import type { ProviderModelOption } from '../../shared/types/ipc';
import type { ChatStatus, InterruptState } from '../hooks/useChat';
import {
  COMMANDS,
  trackRecentCommand,
  buildThemeResults,
  buildPersonalityResults,
  buildModelResults,
  buildSessionResults,
  fuzzyMatch,
  type PaletteResult,
} from '../commands/registry';
import { resolveModelNotifyLabel } from '../utils/provider-selection';
import {
  evaluateComposerSend,
  shouldReleaseComposerSendLock,
} from '../utils/composer-send-lock';
import { ModelPicker } from './ModelPicker';
import { SlashCommandMenu } from './SlashCommandMenu';
import { IconButton } from './ui/IconButton';

interface InputAreaProps {
  status: ChatStatus;
  model: string;
  /** Display labels for opaque connection-scoped model picker keys. */
  modelLabels?: Readonly<Record<string, string>>;
  modelDetails?: Readonly<Record<string, ProviderModelOption>>;
  /** Staged Esc / cancel-button interrupt phase. */
  interruptState?: InterruptState;
  onSend: (message: string) => Promise<void>;
  onCancel: () => Promise<void>;
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
}

type SubPicker = '/theme' | '/personality' | '/model' | '/sessions' | null;

/** Single-line composer height — keep in sync with `.orchid-composer-textarea` CSS. */
const TEXTAREA_MIN_HEIGHT_PX = 34;
const TEXTAREA_MAX_HEIGHT_PX = 160;

export function InputArea({
  status,
  model,
  modelLabels,
  modelDetails,
  interruptState = 'idle',
  onSend,
  onCancel,
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
}: InputAreaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Blocks rapid double-Enter before parent status re-renders to streaming. */
  const isSendingRef = useRef(false);
  /** Tracks pending requestAnimationFrame so we can cancel on unmount. */
  const rafRef = useRef<number | null>(null);
  const [input, setInput] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [subPicker, setSubPicker] = useState<SubPicker>(null);

  const isStreaming = status === 'streaming';
  const hasInput = Boolean(input.trim());
  const confirming =
    interruptState === 'confirmAgent' || interruptState === 'confirmSubagents';
  /** Agent stream active, or waiting for subagent-cancel confirmation. */
  const canInterrupt =
    isStreaming || interruptState === 'confirmAgent' || interruptState === 'confirmSubagents';
  /**
   * Show cancel (square) while streaming / first confirm, and during
   * confirmSubagents only when the input is empty. Typing a follow-up message
   * switches the control back to send.
   */
  const showCancel =
    isStreaming ||
    interruptState === 'confirmAgent' ||
    (interruptState === 'confirmSubagents' && !hasInput);

  /** Slash mode: input starts with `/` (single line) or a sub-picker is open. */
  const isSlashMode =
    Boolean(commandContext) &&
    !isStreaming &&
    (subPicker !== null || (input.startsWith('/') && !input.includes('\n')));

  const availableModels = commandContext?.getAvailableModels() ?? [];

  const modelNotifyLabels = useMemo(
    () => Object.fromEntries(
      availableModels.map((key) => [
        key,
        resolveModelNotifyLabel(key, modelDetails, modelLabels),
      ]),
    ),
    [availableModels, modelDetails, modelLabels],
  );

  const slashResults = useMemo<PaletteResult[]>(() => {
    if (!isSlashMode || !commandContext) return [];

    if (subPicker === '/theme') {
      return filterResults(buildThemeResults(currentTheme), input);
    }
    if (subPicker === '/personality') {
      return filterResults(
        buildPersonalityResults(currentPersonality, personalityNames),
        input,
      );
    }
    if (subPicker === '/model') {
      return filterResults(
        buildModelResults(
          commandContext.getCurrentModel(),
          commandContext.getAvailableModels(),
          modelNotifyLabels,
        ),
        input,
      );
    }
    if (subPicker === '/sessions') {
      return filterResults(buildSessionResults(sessions), input);
    }

    // Command list — query is the full `/…` text
    const query = input.trim();
    const scored: Array<{ item: PaletteResult; score: number }> = [];

    for (const cmd of COMMANDS) {
      const score = Math.max(
        fuzzyMatch(query, cmd.name),
        // Also match without requiring the leading slash in the description path
        fuzzyMatch(query.replace(/^\//, ''), cmd.name.replace(/^\//, '')),
        fuzzyMatch(query, cmd.description),
      );
      if (score > 0 || query === '/' || query === '') {
        scored.push({
          item: {
            id: `cmd:${cmd.name}`,
            label: cmd.name,
            description: cmd.description,
            category: 'commands',
            icon: 'command',
            commandName: cmd.name,
          },
          score: query === '/' || query === '' ? 1 : score,
        });
      }
    }

    if (query === '/' || query === '') {
      return scored.map((s) => s.item);
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.filter((s) => s.score > 0).map((s) => s.item);
  }, [
    isSlashMode,
    commandContext,
    subPicker,
    input,
    currentTheme,
    currentPersonality,
    personalityNames,
    sessions,
    modelNotifyLabels,
  ]);

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

  const clearAndClose = useCallback(() => {
    setInput('');
    setSubPicker(null);
    setSelectedIndex(0);
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (textareaRef.current) {
        textareaRef.current.style.height = `${TEXTAREA_MIN_HEIGHT_PX}px`;
      }
      textareaRef.current?.focus();
    });
  }, []);

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

      trackRecentCommand(result.commandName ?? result.label);

      if (result.action === 'theme' && result.value) {
        await slashContext.onSetTheme(result.value);
        slashContext.onNotify(`Theme changed to ${result.label}`, 'info');
        clearAndClose();
        return;
      }

      if (result.action === 'personality' && result.value) {
        await slashContext.onSetPersonality(result.value);
        slashContext.onNotify(`Personality changed to ${result.label}`, 'info');
        clearAndClose();
        return;
      }

      if (result.action === 'model' && result.value) {
        await slashContext.onSetModel(result.value);
        slashContext.onNotify(
          `Model changed to ${resolveModelNotifyLabel(result.value, modelDetails, modelLabels)}`,
          'info',
        );
        clearAndClose();
        return;
      }

      if (result.action === 'session' && result.value) {
        await slashContext.onLoadSession(result.value);
        slashContext.onNotify(`Loaded session: ${result.label}`, 'info');
        clearAndClose();
        return;
      }

      if (result.commandName) {
        const command = COMMANDS.find((c) => c.name === result.commandName);
        if (!command) return;

        if (command.name === '/theme') {
          setSubPicker('/theme');
          setInput('');
          setSelectedIndex(0);
          return;
        }
        if (command.name === '/personality') {
          setSubPicker('/personality');
          setInput('');
          setSelectedIndex(0);
          return;
        }
        if (command.name === '/model') {
          setSubPicker('/model');
          setInput('');
          setSelectedIndex(0);
          return;
        }
        if (command.name === '/sessions') {
          setSubPicker('/sessions');
          setInput('');
          setSelectedIndex(0);
          return;
        }

        await command.execute(slashContext);
        // Ensure composer is cleared even if execute did not call onClose
        clearAndClose();
      }
    },
    [slashContext, clearAndClose, modelDetails, modelLabels],
  );

  const handleSelectModel = useCallback(
    async (next: string) => {
      if (!commandContext || next === model) return;
      try {
        await commandContext.onSetModel(next);
        commandContext.onNotify(
          `Model changed to ${resolveModelNotifyLabel(next, modelDetails, modelLabels)}`,
          'info',
        );
      } catch {
        // Non-fatal — parent may already toast
      }
    },
    [commandContext, model, modelDetails, modelLabels],
  );

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Empty fields often report scrollHeight taller than one visual line
    // (padding / placeholder metrics). Force the compact single-line height
    // so startup matches the post-send size.
    if (!el.value) {
      el.style.height = `${TEXTAREA_MIN_HEIGHT_PX}px`;
      return;
    }
    el.style.height = 'auto';
    const next = Math.min(
      Math.max(el.scrollHeight, TEXTAREA_MIN_HEIGHT_PX),
      TEXTAREA_MAX_HEIGHT_PX,
    );
    el.style.height = `${next}px`;
  }, []);

  useEffect(() => {
    // Release send lock when not streaming: idle success path and error/gate
    // recovery (status 'error' never returned to idle without this).
    if (shouldReleaseComposerSendLock(status, interruptState)) {
      isSendingRef.current = false;
    }
    if (status === 'idle' && interruptState === 'idle') {
      textareaRef.current?.focus();
    }
  }, [status, interruptState]);

  useEffect(() => {
    resizeTextarea();
  }, [input, resizeTextarea]);

  // Cancel pending rAF on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  // Multi-stage Esc — same path as the cancel button (agent → subagents).
  // Model dropup closes first; slash menu owns Esc while open.
  // When Settings is open ChatView stays mounted but Escape belongs to ConfigView.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (document.documentElement.dataset.orchidSettingsOpen === '1') return;

      if (!canInterrupt) return;
      // Let slash-menu Esc handlers win when the menu is open on confirmSubagents
      // with typed input — only intercept when cancel UI is active without slash.
      if (isSlashMode) return;
      event.preventDefault();
      void onCancel();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canInterrupt, isSlashMode, onCancel]);

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
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (textareaRef.current) {
        textareaRef.current.style.height = `${TEXTAREA_MIN_HEIGHT_PX}px`;
      }
    });
  }, [
    input,
    isStreaming,
    modelSelected,
    onOpenProviders,
    onPickProjectDir,
    onSend,
    providerAvailable,
    workspaceBound,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Slash menu navigation
      if (isSlashMode && slashResults.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, slashResults.length - 1));
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const item = slashResults[selectedIndex];
          if (item) void handleSelectResult(item);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          const item = slashResults[selectedIndex];
          if (item) void handleSelectResult(item);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          if (subPicker) {
            setSubPicker(null);
            setInput(subPicker);
            setSelectedIndex(0);
          } else {
            closeSlashMenu();
            // Leave text so user can keep editing, or clear if only `/`
            if (input === '/') setInput('');
          }
          return;
        }
      } else if (isSlashMode && e.key === 'Escape') {
        e.preventDefault();
        if (subPicker) {
          setSubPicker(null);
          setInput(subPicker);
        } else {
          closeSlashMenu();
          if (input === '/') setInput('');
        }
        return;
      }

      // Sub-picker open with no options: don't send filter text as a chat message
      if (subPicker && e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        return;
      }

      // Exact slash command with no fuzzy matches: try exact match, else send as chat
      if ((e.key === 'Enter' && !e.shiftKey) || (e.key === 's' && (e.ctrlKey || e.metaKey))) {
        if (isSlashMode && slashResults.length === 0 && input.trim().startsWith('/')) {
          const exact = COMMANDS.find((c) => c.name === input.trim());
          if (exact && slashContext) {
            e.preventDefault();
            void handleSelectResult({
              id: `cmd:${exact.name}`,
              label: exact.name,
              description: exact.description,
              category: 'commands',
              commandName: exact.name,
            });
            return;
          }
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
      handleSelectResult,
      subPicker,
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

  const cancelTitle =
    interruptState === 'confirmSubagents'
      ? 'Cancel subagents'
      : interruptState === 'confirmAgent'
        ? 'Cancel agent'
        : 'Interrupt';

  const cancelVariant = interruptState === 'confirmSubagents' ? 'warning' : 'error';

  // During confirmSubagents the agent is done — keep input editable for follow-ups.
  const inputDisabled = isStreaming || interruptState === 'confirmAgent';
  const plainChatBlocked = !workspaceBound || !providerAvailable || !modelSelected;

  return (
    <div className="orchid-composer-area">
      {!workspaceBound && (
        <div className="orchid-composer-gate alert alert-warning" role="status">
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
          className="orchid-composer-gate alert alert-info"
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
          className="orchid-composer-gate alert alert-warning"
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
        <textarea
          ref={textareaRef}
          className="textarea textarea-bordered orchid-composer-textarea"
          data-orchid-composer
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={
            isStreaming || interruptState === 'confirmAgent'
              ? 'Streaming… (Esc or ■ to interrupt)'
              : interruptState === 'confirmSubagents'
                ? 'Type a follow-up, or Esc / ■ to cancel subagents…'
                : !workspaceBound
                  ? 'Choose a project folder first… (or /cd)'
                  : !providerAvailable
                    ? 'Set up a provider before chatting…'
                    : !modelSelected
                      ? 'Select a connection and model first…'
                  : commandContext
                    ? 'Type a message or /command… (Enter to send)'
                    : 'Type a message… (Enter to send, Shift+Enter for newline)'
          }
          disabled={inputDisabled}
          rows={1}
          aria-autocomplete={commandContext ? 'list' : undefined}
          aria-expanded={showMenu || undefined}
          aria-controls={showMenu ? 'slash-command-menu' : undefined}
        />

        <div className="orchid-composer-controls">
          <ModelPicker
            value={model}
            options={availableModels}
            optionLabels={modelLabels}
            optionDetails={modelDetails}
            onChange={(next) => void handleSelectModel(next)}
            placement="top"
            label="Select model"
            showSelectedContext={false}
            disabled={isStreaming || interruptState === 'confirmAgent'}
            className="orchid-composer-model-picker"
          />

          {showCancel ? (
            <IconButton
              label={cancelTitle}
              icon="square"
              size="sm"
              variant={cancelVariant}
              className="orchid-composer-action"
              onClick={() => void onCancel()}
              iconSize={14}
            />
          ) : (
            <IconButton
              label={showMenu ? 'Run command' : 'Send'}
              icon="arrowUp"
              size="sm"
              variant="primary"
              className="orchid-composer-action"
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
        </div>
      </div>
    </div>
  );
}

function filterResults(items: PaletteResult[], query: string): PaletteResult[] {
  const q = query.trim();
  if (!q) return items;
  const scored = items
    .map((item) => ({
      item,
      score: Math.max(
        fuzzyMatch(q, item.label),
        item.description ? fuzzyMatch(q, item.description) : -1,
      ),
    }))
    .filter((s) => s.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

/** Prefer the model id after provider/ for the compact chip. */
