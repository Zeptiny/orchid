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
  fuzzyMatch,
  highlightMatch,
  type Command,
  type CommandCategory,
  type PaletteResult,
} from '../commands/registry';
import type { CommandContext, SessionSummary } from '../../shared/types/ipc-boundary';

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  context: CommandContext;
  sessions: SessionSummary[];
  currentTheme: string;
  currentPersonality: string;
}

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  commands: 'Commands',
  sessions: 'Sessions',
  settings: 'Settings',
  navigation: 'Navigation',
};

const CATEGORY_ORDER: CommandCategory[] = ['commands', 'sessions', 'settings', 'navigation'];

export function CommandPalette({
  isOpen,
  onClose,
  context,
  sessions,
  currentTheme,
  currentPersonality,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [subPicker, setSubPicker] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo<PaletteResult[]>(() => {
    if (subPicker === '/theme') {
      return buildThemeResults(currentTheme);
    }
    if (subPicker === '/personality') {
      return buildPersonalityResults(currentPersonality);
    }

    const items: PaletteResult[] = [];

    if (!query) {
      const recent = getRecentCommands();
      const recentCommands = recent
        .map((name) => COMMANDS.find((c) => c.name === name))
        .filter(Boolean) as Command[];

      for (const cmd of recentCommands) {
        items.push({
          id: `recent:${cmd.name}`,
          label: cmd.name,
          description: cmd.description,
          category: 'commands',
          icon: '⏱',
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
            icon: '❯',
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
              icon: '❯',
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
              description: session.model ? `Model: ${session.model}` : undefined,
              category: 'sessions',
              icon: '▣',
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
              icon: '⚙',
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
              icon: '→',
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
  }, [query, sessions, subPicker, currentTheme, currentPersonality]);

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
            context.onNotify('Model picker: configure providers in settings first.', 'info');
            onClose();
            return;
          }

          await command.execute(context);
        }
      }
    },
    [context, onClose],
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
          if (flatResults[selectedIndex]) {
            handleSelect(flatResults[selectedIndex]);
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

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (isOpen) {
          onClose();
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const subPickerTitle = subPicker
    ? subPicker === '/theme'
      ? 'Switch Theme'
      : subPicker === '/personality'
        ? 'Switch Personality'
        : null
    : null;

  return (
    <dialog className="modal modal-open" onClose={onClose}>
      <div className="modal-box max-w-2xl p-0" onKeyDown={handleKeyDown}>
        {/* Header */}
        <div className="p-4 border-b border-base-300">
          <div className="flex items-center gap-2">
            {subPicker && (
              <button
                className="btn btn-ghost btn-sm btn-circle"
                onClick={() => {
                  setSubPicker(null);
                  setQuery('');
                  setSelectedIndex(0);
                }}
              >
                ←
              </button>
            )}
            <input
              ref={inputRef}
              className="input input-bordered flex-1"
              type="text"
              placeholder={subPickerTitle ?? 'Search commands, sessions, settings...'}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelectedIndex(0);
              }}
              autoFocus
            />
            <kbd className="kbd kbd-sm">⌘K</kbd>
          </div>
        </div>

        {/* Results */}
        <div className="max-h-[60vh] overflow-y-auto p-2" ref={listRef}>
          {flatResults.length === 0 && (
            <div className="text-center py-8 text-base-content/50">
              {query ? 'No results found' : 'Type to search...'}
            </div>
          )}

          {groupedResults.map((group) => {
            let localIndex = 0;
            for (const g of groupedResults) {
              if (g.category === group.category) break;
              localIndex += g.items.length;
            }

            return (
              <div key={group.category} className="mb-2">
                <div className="text-xs font-semibold text-base-content/50 px-2 py-1 uppercase">
                  {group.label}
                </div>
                <ul className="menu menu-sm">
                  {group.items.map((item) => {
                    const globalIndex = localIndex++;
                    const isSelected = globalIndex === selectedIndex;

                    return (
                      <li key={item.id}>
                        <button
                          className={`flex items-start gap-2 ${isSelected ? 'active' : ''}`}
                          data-selected={isSelected}
                          onClick={() => handleSelect(item)}
                          onMouseEnter={() => setSelectedIndex(globalIndex)}
                        >
                          {item.icon && <span className="text-lg">{item.icon}</span>}
                          <div className="flex-1 min-w-0">
                            <div className="font-medium">
                              {query ? (
                                <HighlightedText query={query} text={item.label} />
                              ) : (
                                item.label
                              )}
                            </div>
                            {item.description && (
                              <div className="text-xs opacity-50 truncate">{item.description}</div>
                            )}
                          </div>
                          {item.category === 'commands' && (
                            <kbd className="kbd kbd-xs">Enter</kbd>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="p-2 border-t border-base-300 flex gap-4 text-xs text-base-content/50">
          <span><kbd className="kbd kbd-xs">↑↓</kbd> navigate</span>
          <span><kbd className="kbd kbd-xs">↵</kbd> select</span>
          <span><kbd className="kbd kbd-xs">esc</kbd> close</span>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button onClick={onClose}>close</button>
      </form>
    </dialog>
  );
}

function HighlightedText({ query, text }: { query: string; text: string }) {
  const segments = highlightMatch(query, text);
  return (
    <>
      {segments.map((seg, i) =>
        seg.highlighted ? (
          <mark key={i} className="bg-primary/30">{seg.text}</mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}
