/**
 * InputArea — composer with info bar (cwd / model / tokens / context).
 * Iteration 012 mock-aligned.
 * Enter send · Shift+Enter newline · Ctrl/Cmd+S send · Esc cancel while streaming.
 * Slash commands: type `/` to open autocomplete above the input.
 */
import { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import type { Usage } from '../../shared/types/message';
import type { CommandContext, SessionSummary } from '../../shared/types/ipc-boundary';
import type { ChatStatus } from '../hooks/useChat';
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
import { Icon } from './Icon';
import { SlashCommandMenu } from './SlashCommandMenu';

interface InputAreaProps {
  status: ChatStatus;
  model: string;
  cwd?: string;
  usage?: Usage | null;
  maxContext?: number | null;
  onSend: (message: string) => Promise<void>;
  onCancel: () => Promise<void>;
  /** When set, enables `/command` autocomplete above the input. */
  commandContext?: CommandContext;
  sessions?: SessionSummary[];
  currentTheme?: string;
  currentPersonality?: string;
  personalityNames?: readonly string[];
}

type SubPicker = '/theme' | '/personality' | '/model' | '/sessions' | null;

export function InputArea({
  status,
  model,
  cwd,
  usage,
  maxContext,
  onSend,
  onCancel,
  commandContext,
  sessions = [],
  currentTheme = 'default',
  currentPersonality = 'default',
  personalityNames = [],
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

  /** Slash mode: input starts with `/` (single line) or a sub-picker is open. */
  const isSlashMode =
    Boolean(commandContext) &&
    !isStreaming &&
    (subPicker !== null || (input.startsWith('/') && !input.includes('\n')));

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
        textareaRef.current.style.height = '34px';
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
        slashContext.onNotify(`Model changed to ${result.label}`, 'info');
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
    [slashContext, clearAndClose],
  );

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(Math.max(el.scrollHeight, 34), 160);
    el.style.height = `${next}px`;
  }, []);

  useEffect(() => {
    if (status === 'idle') {
      isSendingRef.current = false;
      textareaRef.current?.focus();
    }
  }, [status]);

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

  useEffect(() => {
    if (status !== 'streaming') return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancel();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, status]);

  const handleSend = useCallback(async () => {
    const trimmed = input.trim();
    // status and isSendingRef both guard: status can lag one frame behind Enter.
    if (!trimmed || status === 'streaming' || isSendingRef.current) return;
    isSendingRef.current = true;
    setInput('');
    setSubPicker(null);
    try {
      await onSend(trimmed);
    } catch {
      isSendingRef.current = false;
    }
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      if (textareaRef.current) {
        textareaRef.current.style.height = '34px';
      }
    });
  }, [input, status, onSend]);

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
      if (subPicker && (e.key === 'Enter' && !e.shiftKey)) {
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
        handleSend();
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

  const tokenTotal = usage?.total_tokens ?? 0;
  const contextPercent =
    usage && maxContext && maxContext > 0
      ? Math.min(100, Math.round((usage.prompt_tokens / maxContext) * 100))
      : null;

  const showMenu = isSlashMode && (slashResults.length > 0 || subPicker !== null || input === '/');

  return (
    <div className="composer-area">
      <div className="composer-info">
        {cwd ? (
          <>
            <span className="composer-info-cwd" title={cwd}>
              {cwd}
            </span>
            <span className="composer-info-sep">-</span>
          </>
        ) : null}
        <span className="composer-info-model">{model || 'No model'}</span>
        <span className="composer-info-sep">-</span>
        <span>{formatTokens(tokenTotal)} tokens</span>
        <span className="composer-info-sep">-</span>
        <span>{contextPercent != null ? contextPercent : 0}% context</span>
      </div>

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

      <div className={`composer ${isStreaming ? 'streaming' : ''}`}>
        <textarea
          ref={textareaRef}
          className="composer-textarea"
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={
            isStreaming
              ? 'Streaming...'
              : commandContext
                ? 'Type a message or /command… (Enter to send)'
                : 'Type a message... (Enter to send, Shift+Enter for newline)'
          }
          disabled={isStreaming}
          rows={1}
          aria-autocomplete={commandContext ? 'list' : undefined}
          aria-expanded={showMenu || undefined}
          aria-controls={showMenu ? 'slash-command-menu' : undefined}
        />
        {isStreaming ? (
          <button
            className="btn btn-error btn-sm composer-action"
            onClick={onCancel}
            title="Cancel"
            type="button"
          >
            <Icon name="square" size={12} />
            Cancel
          </button>
        ) : (
          <button
            className="btn btn-primary btn-sm composer-action"
            onClick={() => {
              if (showMenu && slashResults[selectedIndex]) {
                void handleSelectResult(slashResults[selectedIndex]);
                return;
              }
              void handleSend();
            }}
            disabled={isStreaming || (!input.trim() && !subPicker)}
            title={showMenu ? 'Run command' : 'Send'}
            type="button"
            aria-disabled={isStreaming || undefined}
          >
            {showMenu ? 'Run' : 'Send'}
          </button>
        )}
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

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
