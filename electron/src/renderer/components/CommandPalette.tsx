/**
 * CommandPalette — modal overlay with fuzzy search.
 *
 * Uses DaisyUI modal and list components.
 */
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import {
  COMMANDS,
  getRecentCommands,
  trackRecentCommand,
  buildThemeResults,
  buildPersonalityResults,
  buildModelResults,
  buildSessionResults,
  fuzzyMatch,
  highlightMatch,
  type CommandCategory,
  type PaletteResult,
} from '../commands/registry';
import { useFocusTrap } from '../keyboard';
import type { CommandContext, SessionSummary } from '../../shared/types/ipc-boundary';
import type { ProviderModelOption } from '../../shared/types/ipc';
import { resolveModelNotifyLabel } from '../utils/provider-selection';
import { Icon, type IconName } from './Icon';
import { Keycaps } from './Keycaps';
import { IconButton } from './ui/IconButton';
import { ShortcutBar } from './ui/ShortcutBar';

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  context: CommandContext;
  sessions: SessionSummary[];
  currentTheme: string;
  currentPersonality: string;
  /** Personality names loaded from disk. */
  personalityNames?: readonly string[];
  /** Display labels for opaque connection-scoped model keys. */
  modelLabels?: Readonly<Record<string, string>>;
  modelDetails?: Readonly<Record<string, ProviderModelOption>>;
}

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  commands: 'Commands',
  sessions: 'Sessions',
  settings: 'Settings',
  navigation: 'Navigation',
};

const CATEGORY_ORDER: CommandCategory[] = ['commands', 'sessions', 'settings', 'navigation'];

const CATEGORY_ICONS: Record<CommandCategory, IconName> = {
  commands: 'command',
  sessions: 'messageSquare',
  settings: 'settings',
  navigation: 'arrowRight',
};

export function CommandPalette({
  isOpen,
  onClose,
  context,
  sessions,
  currentTheme,
  currentPersonality,
  personalityNames = [],
  modelLabels,
  modelDetails,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [subPicker, setSubPicker] = useState<string | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const selectingRef = useRef(false);

  useFocusTrap({
    enabled: isOpen,
    containerRef: panelRef,
    initialFocusRef: inputRef,
  });

  const modelNotifyLabels = useMemo(() => {
    const keys = context.getAvailableModels();
    return Object.fromEntries(
      keys.map((key) => [key, resolveModelNotifyLabel(key, modelDetails, modelLabels)]),
    );
  }, [context, modelDetails, modelLabels]);

  const results = useMemo<PaletteResult[]>(() => {
    if (subPicker === '/theme') {
      return filterSubResults(buildThemeResults(currentTheme), query);
    }
    if (subPicker === '/personality') {
      return filterSubResults(
        buildPersonalityResults(currentPersonality, personalityNames),
        query,
      );
    }
    if (subPicker === '/model') {
      return filterSubResults(
        buildModelResults(
          context.getCurrentModel(),
          context.getAvailableModels(),
          modelNotifyLabels,
        ),
        query,
      );
    }
    if (subPicker === '/sessions') {
      return filterSubResults(buildSessionResults(sessions), query);
    }

    const items: PaletteResult[] = [];

    if (!query) {
      const recent = getRecentCommands();
      const recentCommands = recent
        .map((name) => COMMANDS.find((c) => c.name === name))
        .filter((cmd): cmd is (typeof COMMANDS)[number] => cmd !== undefined);

      for (const cmd of recentCommands) {
        items.push({
          id: `recent:${cmd.name}`,
          label: cmd.name,
          description: cmd.description,
          category: 'commands',
          icon: 'clock',
          commandName: cmd.name,
        });
      }

      const recentNames = new Set(recent);
      for (const cmd of COMMANDS) {
        if (!recentNames.has(cmd.name)) {
          items.push({
            id: `cmd:${cmd.name}`,
            label: cmd.name,
            description: cmd.description,
            category: 'commands',
            icon: 'command',
            commandName: cmd.name,
          });
        }
      }
    } else {
      const scored: Array<{ item: PaletteResult; score: number }> = [];

      for (const cmd of COMMANDS) {
        const score = Math.max(
          fuzzyMatch(query, cmd.name),
          fuzzyMatch(query, cmd.description),
        );
        if (score > 0) {
          scored.push({
            item: {
              id: `cmd:${cmd.name}`,
              label: cmd.name,
              description: cmd.description,
              category: 'commands',
              icon: 'command',
              commandName: cmd.name,
            },
            score,
          });
        }
      }

      for (const session of sessions) {
        const score = fuzzyMatch(query, session.name);
        if (score > 0) {
          scored.push({
            item: {
              id: `session:${session.id}`,
              label: session.name,
              description: session.modelLabel ? `Model: ${session.modelLabel}` : undefined,
              category: 'sessions',
              icon: 'messageSquare',
              action: 'session',
              value: session.id,
            },
            score,
          });
        }
      }

      const settingsItems = [
        { name: 'Providers', desc: 'Configure API providers' },
        { name: 'MCP Servers', desc: 'Configure MCP tool servers' },
        { name: 'Tier Models', desc: 'Map agent tiers to models' },
        { name: 'RAG', desc: 'RAG configuration' },
        { name: 'General', desc: 'General settings' },
      ];
      for (const item of settingsItems) {
        const score = Math.max(
          fuzzyMatch(query, item.name),
          fuzzyMatch(query, item.desc),
        );
        if (score > 0) {
          scored.push({
            item: {
              id: `setting:${item.name}`,
              label: item.name,
              description: item.desc,
              category: 'settings',
              icon: 'settings',
              action: 'settings',
              value: item.name.toLowerCase().replace(' ', '-'),
            },
            score,
          });
        }
      }

      const navItems = [
        { name: 'Sessions', desc: 'Session list in sidebar' },
        { name: 'Subagents', desc: 'Active subagents' },
        { name: 'Todos', desc: 'Task list' },
        { name: 'MCP Servers', desc: 'MCP server status' },
        { name: 'Index Status', desc: 'RAG and AST index status' },
      ];
      for (const item of navItems) {
        const score = Math.max(
          fuzzyMatch(query, item.name),
          fuzzyMatch(query, item.desc),
        );
        if (score > 0) {
          scored.push({
            item: {
              id: `nav:${item.name}`,
              label: item.name,
              description: item.desc,
              category: 'navigation',
              icon: 'arrowRight',
              action: 'navigation',
              value: item.name.toLowerCase().replace(' ', '-'),
            },
            score,
          });
        }
      }

      scored.sort((a, b) => b.score - a.score);
      items.push(...scored.map((s) => s.item));
    }

    return items;
  }, [
    query,
    sessions,
    subPicker,
    currentTheme,
    currentPersonality,
    personalityNames,
    context,
    modelNotifyLabels,
  ]);

  const groupedResults = useMemo(() => {
    const groups: Array<{ category: CommandCategory; label: string; items: PaletteResult[] }> = [];

    for (const category of CATEGORY_ORDER) {
      const categoryItems = results.filter((r) => r.category === category);
      if (categoryItems.length > 0) {
        groups.push({
          category,
          label: CATEGORY_LABELS[category],
          items: categoryItems,
        });
      }
    }

    return groups;
  }, [results]);

  const flatResults = useMemo(() => {
    return groupedResults.flatMap((g) => g.items);
  }, [groupedResults]);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setSubPicker(null);
      selectingRef.current = false;
      setIsSelecting(false);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [isOpen]);

  useEffect(() => {
    if (selectedIndex >= flatResults.length) {
      setSelectedIndex(Math.max(0, flatResults.length - 1));
    }
  }, [flatResults.length, selectedIndex]);

  useEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.querySelector('[data-selected="true"]');
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleSelect = useCallback(
    async (result: PaletteResult) => {
      if (selectingRef.current) return;
      selectingRef.current = true;
      setIsSelecting(true);
      try {
        trackRecentCommand(result.commandName ?? result.label);

        if (result.action === 'theme' && result.value) {
          await context.onSetTheme(result.value);
          context.onNotify(`Theme changed to ${result.label}`, 'info');
          onClose();
          return;
        }

        if (result.action === 'personality' && result.value) {
          await context.onSetPersonality(result.value);
          context.onNotify(`Personality changed to ${result.label}`, 'info');
          onClose();
          return;
        }

        if (result.action === 'model' && result.value) {
          await context.onSetModel(result.value);
          context.onNotify(
            `Model changed to ${resolveModelNotifyLabel(result.value, modelDetails, modelLabels)}`,
            'info',
          );
          onClose();
          return;
        }

        if (result.action === 'session' && result.value) {
          await context.onLoadSession(result.value);
          context.onNotify(`Loaded session: ${result.label}`, 'info');
          onClose();
          return;
        }

        if (result.action === 'settings') {
          context.onOpenSettings();
          onClose();
          return;
        }

        if (result.action === 'navigation') {
          window.dispatchEvent(
            new CustomEvent('orchid:navigate', { detail: { section: result.value } }),
          );
          onClose();
          return;
        }

        if (result.commandName) {
          const command = COMMANDS.find((c) => c.name === result.commandName);
          if (command) {
            if (command.name === '/theme') {
              setSubPicker('/theme');
              setQuery('');
              setSelectedIndex(0);
              return;
            }
            if (command.name === '/personality') {
              setSubPicker('/personality');
              setQuery('');
              setSelectedIndex(0);
              return;
            }
            if (command.name === '/model') {
              setSubPicker('/model');
              setQuery('');
              setSelectedIndex(0);
              return;
            }
            if (command.name === '/sessions') {
              setSubPicker('/sessions');
              setQuery('');
              setSelectedIndex(0);
              return;
            }

            await command.execute(context);
          }
        }
      } finally {
        selectingRef.current = false;
        setIsSelecting(false);
      }
    },
    [context, onClose, modelDetails, modelLabels],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, flatResults.length - 1));
          break;

        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;

        case 'Enter':
          e.preventDefault();
          if (flatResults[selectedIndex] && !selectingRef.current) {
            void handleSelect(flatResults[selectedIndex]);
          }
          break;

        case 'Escape':
          e.preventDefault();
          if (subPicker) {
            setSubPicker(null);
            setQuery('');
            setSelectedIndex(0);
          } else {
            onClose();
          }
          break;

        case 'Backspace':
          if (!query && subPicker) {
            e.preventDefault();
            setSubPicker(null);
            setSelectedIndex(0);
          }
          break;
      }
    },
    [flatResults, selectedIndex, handleSelect, onClose, query, subPicker],
  );

  // Mod+K toggle is owned by ChatView via the central shortcut registry.

  if (!isOpen) return null;

  const subPickerTitle =
    subPicker === '/theme'
      ? 'Switch Theme'
      : subPicker === '/personality'
        ? 'Switch Personality'
        : subPicker === '/model'
          ? 'Select Model'
          : subPicker === '/sessions'
            ? 'Load Session'
            : null;

  return (
    <div
      className="orchid-command-palette-overlay fixed inset-0 z-50 flex justify-center bg-black/55 pt-20"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        ref={panelRef}
        className="orchid-command-palette flex max-h-96 w-full max-w-xl flex-col overflow-hidden rounded-box border border-base-300 bg-base-200 shadow-2xl mx-4"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="orchid-command-palette-search-row">
          {subPicker && (
            <IconButton
              label="Back"
              icon="arrowLeft"
              size="sm"
              iconSize={16}
              onClick={() => {
                setSubPicker(null);
                setQuery('');
                setSelectedIndex(0);
              }}
            />
          )}
          <label className="input input-sm orchid-command-palette-search-field">
            <Icon name="search" size={14} className="shrink-0 text-base-content/45" />
            <input
              ref={inputRef}
              className="orchid-command-palette-input grow"
              type="text"
              placeholder={subPicker ? subPickerTitle ?? 'Type a command or search...' : 'Type a command or search...'}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedIndex(0);
              }}
              autoFocus
            />
          </label>
        </div>

        <div
          className="orchid-command-palette-results min-h-0 flex-1 overflow-y-auto p-1"
          ref={listRef}
          aria-busy={isSelecting || undefined}
        >
          {flatResults.length === 0 && !subPicker && (
            <div className="py-8 text-center text-sm text-base-content/50">
              {query ? 'No results found' : 'Type to search...'}
            </div>
          )}

          {subPicker && flatResults.length === 0 && (
            <div className="py-8 text-center text-sm text-base-content/50">
              {subPickerTitle}
            </div>
          )}

          {subPicker && flatResults.length > 0 ? (
            <div className="p-1">
              <div className="mb-0.5 px-3 py-2 text-xs uppercase tracking-wide text-base-content/50">
                {subPickerTitle ?? 'Select'}
              </div>
              <div className="flex flex-col gap-px">
                {flatResults.map((item, i) => {
                  const isSelected = i === selectedIndex;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={`orchid-command-palette-item flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
                        isSelected ? 'bg-primary/15' : 'hover:bg-base-content/5'
 }`}
                      disabled={isSelecting}
                      onClick={() => void handleSelect(item)}
                      onMouseEnter={() => setSelectedIndex(i)}
                      data-selected={isSelected}
                    >
                      {subPicker === '/theme' && (
                        <span
                          className="orchid-theme-swatch inline-block h-3.5 w-3.5 shrink-0 rounded-sm border border-base-300"
                          style={{ background: THEME_SWATCHES[item.value ?? ''] ?? 'transparent' }}
                        />
                      )}
                      <span>{item.label}</span>
                      {item.description?.toLowerCase().includes('current') && (
                        <span className="badge badge-ghost badge-xs ml-auto">current</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : !subPicker ? (
            groupedResults.map((group) => {
              let localIndex = 0;
              for (const g of groupedResults) {
                if (g.category === group.category) break;
                localIndex += g.items.length;
              }

              return (
                <div key={group.category} className="orchid-command-palette-group mb-1">
                  <div className="flex items-center gap-1.5 px-3 py-2 text-xs uppercase tracking-wide text-base-content/50">
                    <Icon name={CATEGORY_ICONS[group.category]} size={12} />
                    {group.label}
                  </div>
                  <div className="flex flex-col gap-px">
                    {group.items.map((item) => {
                      const globalIndex = localIndex++;
                      const isSelected = globalIndex === selectedIndex;

                      return (
                        <button
                          key={item.id}
                          type="button"
                          className={`orchid-command-palette-item flex min-h-8 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-xs ${
                            isSelected ? 'bg-primary/15' : 'hover:bg-base-content/5'
 }`}
                          data-selected={isSelected}
                          disabled={isSelecting}
                          onClick={() => void handleSelect(item)}
                          onMouseEnter={() => setSelectedIndex(globalIndex)}
                        >
                          <Icon name={iconForResult(item)} size={14} className="shrink-0 text-base-content/55" />
                          <div className="min-w-0 flex-1">
                            <div className="font-medium leading-tight">
                              {query ? (
                                <HighlightedText query={query} text={item.label} />
                              ) : (
                                item.label
                              )}
                            </div>
                            {item.description && (
                              <div className="mt-0.5 truncate text-xs leading-tight text-base-content/50">
                                {item.description}
                              </div>
                            )}
                          </div>
                          {item.category === 'commands' && (
                            <Keycaps chord="Enter" size="xs" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })
          ) : null}
        </div>

        <ShortcutBar
          className="orchid-command-palette-footer"
          items={[
            { chord: ['↑', '↓'], label: 'navigate' },
            { chord: 'Enter', label: 'select' },
            { chord: 'Esc', label: 'close' },
          ]}
        />
      </div>
    </div>
  );
}

function HighlightedText({ query, text }: { query: string; text: string }) {
  const segments = highlightMatch(query, text);
  return (
    <>
      {segments.map((seg, i) =>
        seg.highlighted ? (
          <mark key={i} className="orchid-command-palette-highlight bg-primary/30 rounded-sm px-px">{seg.text}</mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

const THEME_SWATCHES: Record<string, string> = {
  default: '#1a1b26',
  'solarized-light': '#fdf6e3',
  bluey: '#2e3440',
  'windows-xp': '#3a6ea5',
  'green-terminal': '#0a2a0a',
};

function iconForResult(item: PaletteResult): IconName {
  if (item.action === 'theme') return 'sliders';
  if (item.action === 'personality') return 'user';
  if (item.action === 'model') return 'cpu';
  if (item.action === 'session') return 'messageSquare';
  if (item.action === 'settings') return 'settings';
  if (item.action === 'navigation') return 'arrowRight';
  return CATEGORY_ICONS[item.category];
}

function filterSubResults(items: PaletteResult[], query: string): PaletteResult[] {
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
