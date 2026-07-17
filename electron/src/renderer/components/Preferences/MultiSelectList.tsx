/**
 * MultiSelectList — multi-select checklist for config forms (tools, skills, …).
 *
 * Shows a scrollable list of available options with checkboxes, plus any
 * currently selected values that are not in the catalog (orphan / custom globs).
 */
import { useMemo, useState } from 'react';
import { StateMessage } from '../ui/StateMessage';
import { StatusBadge } from '../ui/StatusBadge';

export interface MultiSelectListProps {
  /** Catalog of selectable values. */
  options: readonly string[];
  /** Currently selected values. */
  selected: readonly string[];
  onChange: (next: string[]) => void;
  /** Optional values always shown first (e.g. `*`). */
  leadingOptions?: readonly string[];
  /** Optional labels for special options. */
  optionLabels?: Readonly<Record<string, string>>;
  /** Max height of the scroll area. */
  maxHeightClass?: string;
  /** Optional placeholder for the filter shown when there are many options. */
  searchPlaceholder?: string;
  emptyLabel?: string;
}

export function MultiSelectList({
  options,
  selected,
  onChange,
  leadingOptions = [],
  optionLabels = {},
  maxHeightClass = 'max-h-72',
  searchPlaceholder = 'Filter options…',
  emptyLabel = 'No options available',
}: MultiSelectListProps) {
  const [query, setQuery] = useState('');
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const ordered = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];

    for (const opt of leadingOptions) {
      if (!seen.has(opt)) {
        seen.add(opt);
        out.push(opt);
      }
    }
    for (const opt of options) {
      if (!seen.has(opt)) {
        seen.add(opt);
        out.push(opt);
      }
    }
    // Keep custom / orphan selections (e.g. mcp globs not currently registered)
    for (const opt of selected) {
      if (!seen.has(opt)) {
        seen.add(opt);
        out.push(opt);
      }
    }
    return out;
  }, [leadingOptions, options, selected]);

  const visibleOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return ordered;
    return ordered.filter((opt) =>
      (optionLabels[opt] ?? opt).toLowerCase().includes(normalizedQuery),
    );
  }, [optionLabels, ordered, query]);

  const toggle = (value: string) => {
    if (selectedSet.has(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const selectAllCatalog = () => {
    const catalog = new Set([...leadingOptions, ...options]);
    const orphans = selected.filter((v) => !catalog.has(v));
    onChange([...Array.from(catalog), ...orphans]);
  };

  const clearAll = () => onChange([]);

  if (ordered.length === 0) {
    return <StateMessage kind="empty" title={emptyLabel} className="py-4" />;
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="btn btn-ghost btn-xs font-normal"
            onClick={selectAllCatalog}
          >
            Select all
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs font-normal"
            onClick={clearAll}
          >
            Clear
          </button>
        </div>
        <StatusBadge tone="neutral" size="sm" outline className="ml-auto whitespace-nowrap">
          {selected.length} selected
        </StatusBadge>
      </div>

      {ordered.length > 8 && (
        <input
          type="search"
          className="input input-bordered input-sm w-full"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
        />
      )}

      <div
        className={`overflow-y-auto rounded-box border border-base-300 bg-base-100 p-1.5 ${maxHeightClass}`}
      >
        {visibleOptions.length > 0 ? (
          <ul className="flex w-full flex-col gap-1">
            {visibleOptions.map((opt) => {
              const checked = selectedSet.has(opt);
              const isOrphan = !options.includes(opt) && !leadingOptions.includes(opt);
              const label = optionLabels[opt] ?? opt;
              return (
                <li key={opt}>
                  <label
                    className={[
                      'flex min-h-11 cursor-pointer items-center gap-2.5 rounded-box border border-transparent px-3 py-2.5',
                      'hover:bg-base-200/80 transition-colors',
                      checked ? 'border-primary/20 bg-primary/10' : '',
                    ].join(' ')}
                  >
                    <input
                      type="checkbox"
                      className="checkbox checkbox-sm"
                      checked={checked}
                      onChange={() => toggle(opt)}
                    />
                    <span className="min-w-0 flex-1 flex items-center gap-2">
                      <span className="font-mono text-sm leading-snug break-all">
                        {label}
                      </span>
                      {isOrphan && (
                        <StatusBadge tone="neutral" size="xs" outline>
                          custom
                        </StatusBadge>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        ) : (
          <StateMessage
            kind="empty"
            title={`No options match “${query}”.`}
            className="py-4"
          />
        )}
      </div>
    </div>
  );
}
