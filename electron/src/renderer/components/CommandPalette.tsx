/**
 * CommandPalette — modal overlay with fuzzy search across commands, sessions,
 * settings, and navigation.
 *
 * Opened via Cmd+K (macOS) / Ctrl+K (Win/Linux).
 * Highest z-index — always on top of all other modals.
 *
 * Features:
 * - Fuzzy search input at top
 * - Results list below, grouped by category
 * - Keyboard: Up/Down arrows navigate, Enter executes, Esc closes
 * - Mouse click selects
 * - Empty query: recent commands + all commands
 * - Sub-pickers for /theme, /personality, /model
 *
 * Ported from src/orchid/screens/picker.py and session_commands.py.
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
  type CommandContext,
  type CommandCategory,
  type PaletteResult,
} from '../../main/commands/registry';
import type { SessionSummary } from '../../main/session/storage';

// ── Props ────────────────────────────────────────────────────────────────────

export interface CommandPaletteProps {
  /** Whether the palette is currently open. */
  isOpen: boolean;
  /** Close the palette. */
  onClose: () => void;
  /** Callbacks for command execution. */
  context: CommandContext;
  /** Current sessions list for session search. */
  sessions: SessionSummary[];
  /** Current theme name. */
  currentTheme: string;
  /** Current personality name. */
  currentPersonality: string;
}

// ── Category labels ──────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<CommandCategory, string> = {
  commands: 'Commands',
  sessions: 'Sessions',
  settings: 'Settings',
  navigation: 'Navigation',
};

const CATEGORY_ORDER: CommandCategory[] = ['commands', 'sessions', 'settings', 'navigation'];

// ── Component ────────────────────────────────────────────────────────────────

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

  // ── Build results ────────────────────────────────────────────────────────

  const results = useMemo<PaletteResult[]>(() => {
    // If we're in a sub-picker mode, show sub-picker results
    if (subPicker === '/theme') {
      return buildThemeResults(currentTheme);
    }
    if (subPicker === '/personality') {
      return buildPersonalityResults(currentPersonality);
    }

    const items: PaletteResult[] = [];

    if (!query) {
      // Empty query: show recent commands + all commands
      const recent = getRecentCommands();
      const recentCommands = recent
        .map((name) => COMMANDS.find((c) => c.name === name))
        .filter(Boolean) as Command[];

      // Add recent commands first
      for (const cmd of recentCommands) {
        items.push({
          id: `recent:${cmd.name}`,
          label: cmd.name,
          description: cmd.description,
          category: 'commands',
          icon: '\u23F1',
          commandName: cmd.name,
        });
      }

      // Add all commands (excluding already shown recent ones)
      const recentNames = new Set(recent);
      for (const cmd of COMMANDS) {
        if (!recentNames.has(cmd.name)) {
          items.push({
            id: `cmd:${cmd.name}`,
            label: cmd.name,
            description: cmd.description,
            category: 'commands',
            icon: '\u276F',
            commandName: cmd.name,
          });
        }
      }
    } else {
      // Search mode: fuzzy match across commands, sessions, settings, navigation
      const scored: Array<{ item: PaletteResult; score: number }> = [];

      // Search commands
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
              icon: '\u276F',
              commandName: cmd.name,
            },
            score,
          });
        }
      }

      // Search sessions
      for (const session of sessions) {
        const score = fuzzyMatch(query, session.name);
        if (score > 0) {
          scored.push({
            item: {
              id: `session:${session.id}`,
              label: session.name,
              description: session.model ? `Model: ${session.model}` : undefined,
              category: 'sessions',
              icon: '\u25A3',
              action: 'session',
              value: session.id,
            },
            score,
          });
        }
      }

      // Search settings
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
              icon: '\u2699',
              action: 'settings',
              value: item.name.toLowerCase().replace(' ', '-'),
            },
            score,
          });
        }
      }

      // Search navigation
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
              icon: '\u2192',
              action: 'navigation',
              value: item.name.toLowerCase().replace(' ', '-'),
            },
            score,
          });
        }
      }

      // Sort by score descending
      scored.sort((a, b) => b.score - a.score);
      items.push(...scored.map((s) => s.item));
    }

    return items;
  }, [query, sessions, subPicker, currentTheme, currentPersonality]);

  // ── Group results by category ────────────────────────────────────────────

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

  // ── Flat list for keyboard navigation ────────────────────────────────────

  const flatResults = useMemo(() => {
    return groupedResults.flatMap((g) => g.items);
  }, [groupedResults]);

  // ── Reset on open/close ──────────────────────────────────────────────────

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setSubPicker(null);
      // Focus input on next tick
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [isOpen]);

  // ── Clamp selected index ─────────────────────────────────────────────────

  useEffect(() => {
    if (selectedIndex >= flatResults.length) {
      setSelectedIndex(Math.max(0, flatResults.length - 1));
    }
  }, [flatResults.length, selectedIndex]);

  // ── Scroll selected item into view ───────────────────────────────────────

  useEffect(() => {
    if (!listRef.current) return;
    const selectedEl = listRef.current.querySelector('[data-selected="true"]');
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  // ── Handle result selection ──────────────────────────────────────────────

  const handleSelect = useCallback(
    async (result: PaletteResult) => {
      trackRecentCommand(result.commandName ?? result.label);

      // Handle sub-picker results
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
        // Navigation results just close the palette; the sidebar section will
        // be expanded by the parent component listening to this event
        window.dispatchEvent(
          new CustomEvent('orchid:navigate', { detail: { section: result.value } }),
        );
        onClose();
        return;
      }

      // Handle command execution
      if (result.commandName) {
        const command = COMMANDS.find((c) => c.name === result.commandName);
        if (command) {
          // Commands that open sub-pickers
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
            // Model picker would be handled here when model discovery is available
            // For now, just notify
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

  // ── Keyboard handling ────────────────────────────────────────────────────

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
            // Go back from sub-picker
            setSubPicker(null);
            setQuery('');
            setSelectedIndex(0);
          } else {
            onClose();
          }
          break;

        case 'Backspace':
          if (!query && subPicker) {
            // Go back from sub-picker on backspace with empty query
            e.preventDefault();
            setSubPicker(null);
            setSelectedIndex(0);
          }
          break;
      }
    },
    [flatResults, selectedIndex, handleSelect, onClose, query, subPicker],
  );

  // ── Global keyboard shortcut ─────────────────────────────────────────────

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (isOpen) {
          onClose();
        } else {
          // Open is handled by the parent; this is for closing
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [isOpen, onClose]);

  // ── Don't render if not open ─────────────────────────────────────────────

  if (!isOpen) return null;

  // ── Sub-picker title ─────────────────────────────────────────────────────

  const subPickerTitle = subPicker
    ? subPicker === '/theme'
      ? 'Switch Theme'
      : subPicker === '/personality'
        ? 'Switch Personality'
        : null
    : null;

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      className="command-palette-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div className="command-palette" onKeyDown={handleKeyDown}>
        {/* Header with search input */}
        <div className="command-palette-header">
          {subPicker && (
            <button
              className="command-palette-back"
              onClick={() => {
                setSubPicker(null);
                setQuery('');
                setSelectedIndex(0);
              }}
              title="Back"
            >
              &#8592;
            </button>
          )}
          <input
            ref={inputRef}
            className="command-palette-input"
            type="text"
            placeholder={subPickerTitle ?? 'Search commands, sessions, settings...'}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            autoFocus
          />
          <div className="command-palette-hint">
            <kbd>&#8984;K</kbd>
          </div>
        </div>

        {/* Results list */}
        <div className="command-palette-results" ref={listRef}>
          {flatResults.length === 0 && (
            <div className="command-palette-empty">
              {query ? 'No results found' : 'Type to search...'}
            </div>
          )}

          {groupedResults.map((group) => {
            let localIndex = 0;
            // Calculate the starting index for this group
            for (const g of groupedResults) {
              if (g.category === group.category) break;
              localIndex += g.items.length;
            }

            return (
              <div key={group.category} className="command-palette-group">
                <div className="command-palette-group-label">{group.label}</div>
                {group.items.map((item) => {
                  const globalIndex = localIndex++;
                  const isSelected = globalIndex === selectedIndex;

                  return (
                    <div
                      key={item.id}
                      className={`command-palette-item ${isSelected ? 'selected' : ''}`}
                      data-selected={isSelected}
                      onClick={() => handleSelect(item)}
                      onMouseEnter={() => setSelectedIndex(globalIndex)}
                      role="option"
                      aria-selected={isSelected}
                    >
                      {item.icon && (
                        <span className="command-palette-item-icon">{item.icon}</span>
                      )}
                      <div className="command-palette-item-content">
                        <span className="command-palette-item-label">
                          {query ? (
                            <HighlightedText query={query} text={item.label} />
                          ) : (
                            item.label
                          )}
                        </span>
                        {item.description && (
                          <span className="command-palette-item-description">
                            {item.description}
                          </span>
                        )}
                      </div>
                      {item.category === 'commands' && (
                        <span className="command-palette-item-shortcut">Enter</span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {/* Footer hint */}
        <div className="command-palette-footer">
          <span className="command-palette-footer-hint">
            <kbd>&#8593;&#8595;</kbd> navigate
          </span>
          <span className="command-palette-footer-hint">
            <kbd>&#9166;</kbd> select
          </span>
          <span className="command-palette-footer-hint">
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}

// ── Highlighted text helper ──────────────────────────────────────────────────

function HighlightedText({ query, text }: { query: string; text: string }) {
  const segments = highlightMatch(query, text);
  return (
    <>
      {segments.map((seg, i) =>
        seg.highlighted ? (
          <mark key={i} className="command-palette-highlight">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}
