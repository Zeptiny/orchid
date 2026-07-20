/**
 * SlashCommandMenu — autocomplete list shown above the chat composer when the
 * user types `/…`. Supports command filter + sub-pickers (theme / model / etc.).
   */
import { useEffect, useRef } from 'react';
import {
  highlightMatch,
  type PaletteResult,
} from '../commands/registry';
import { Icon, type IconName } from './Icon';

export interface SlashCommandMenuProps {
  results: readonly PaletteResult[];
  selectedIndex: number;
  query: string;
  subPicker: string | null;
  onSelect: (result: PaletteResult) => void;
  onHover: (index: number) => void;
}

const SUB_PICKER_TITLES: Record<string, string> = {
  '/theme': 'Select theme',
  '/personality': 'Select personality',
  '/model': 'Select model',
  '/sessions': 'Load session',
};

export function SlashCommandMenu({
  results,
  selectedIndex,
  query,
  subPicker,
  onSelect,
  onHover,
}: SlashCommandMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-selected="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, results]);

  const title = subPicker
    ? (SUB_PICKER_TITLES[subPicker] ?? subPicker)
    : 'Commands';

  return (
    <div
      id="slash-command-menu"
      className="orchid-slash-menu"
      role="listbox"
      aria-label={title}
      ref={listRef}
    >
      <div className="orchid-slash-menu-header">
        <Icon name="command" size={12} className="text-base-content/50" />
        <span>{title}</span>
        {!subPicker && (
          <span className="slash-menu-hint ml-auto text-xs opacity-75">
            type to filter · ↑↓ · Enter · Esc
          </span>
        )}
        {subPicker && (
          <span className="slash-menu-hint ml-auto text-xs opacity-75">
            Esc back · Enter select
          </span>
        )}
      </div>

      {results.length === 0 ? (
        <div className="orchid-slash-menu-empty px-2.5 py-4 text-center text-xs text-base-content/60">
          {subPicker ? 'No options' : 'No matching commands'}
        </div>
      ) : (
        <div className="orchid-slash-menu-list flex min-h-0 flex-col gap-px overflow-y-auto p-1">
          {results.map((item, i) => {
            const isSelected = i === selectedIndex;
            return (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-selected={isSelected}
                className={`orchid-slash-menu-item flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
                  isSelected ? 'is-selected bg-primary/15' : 'hover:bg-primary/10'
 }`}
                onMouseDown={(e) => {
                  // Prevent textarea blur before click registers
                  e.preventDefault();
                }}
                onClick={() => onSelect(item)}
                onMouseEnter={() => onHover(i)}
              >
                <Icon
                  name={iconForResult(item)}
                  size={14}
                  className="slash-menu-item-icon shrink-0 text-base-content/60"
                />
                <div className="slash-menu-item-body flex min-w-0 flex-1 items-center gap-2.5">
                  <div className="slash-menu-item-label shrink-0 font-semibold leading-snug">
                    {query && !subPicker ? (
                      <HighlightedText query={query} text={item.label} />
                    ) : (
                      item.label
                    )}
                  </div>
                  {item.description && (
                    <div className="slash-menu-item-desc min-w-0 flex-1 truncate text-right text-xs text-base-content/60">
                      {item.description}
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function HighlightedText({ query, text }: { query: string; text: string }) {
  const segments = highlightMatch(query, text);
  return (
    <>
      {segments.map((seg, i) =>
        seg.highlighted ? (
          <mark key={i} className="orchid-slash-menu-highlight rounded-sm bg-primary/30 px-px">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

function iconForResult(item: PaletteResult): IconName {
  if (item.action === 'theme') return 'sliders';
  if (item.action === 'personality') return 'user';
  if (item.action === 'model') return 'cpu';
  if (item.action === 'session') return 'messageSquare';
  if (item.action === 'settings') return 'settings';
  if (item.action === 'navigation') return 'arrowRight';
  if (item.icon === 'clock') return 'clock';
  return 'command';
}
