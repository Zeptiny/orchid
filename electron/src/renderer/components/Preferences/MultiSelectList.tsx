/**
 * MultiSelectList — multi-select checklist for config forms (tools, skills, …).
 *
 * Shows a scrollable list of available options with checkboxes, plus any
 * currently selected values that are not in the catalog (orphan / custom globs).
 */
import { useMemo } from 'react';

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
  emptyLabel?: string;
}

export function MultiSelectList({
  options,
  selected,
  onChange,
  leadingOptions = [],
  optionLabels = {},
  maxHeightClass = 'max-h-72',
  emptyLabel = 'No options available',
}: MultiSelectListProps) {
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
    return <p className="text-sm text-base-content/50 py-2">{emptyLabel}</p>;
  }

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex items-center gap-2">
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
        <span className="text-xs text-base-content/50 ml-auto">
          {selected.length} selected
        </span>
      </div>
      <div
        className={`overflow-y-auto rounded-md border border-base-300 bg-base-100 ${maxHeightClass}`}
      >
        <ul className="flex flex-col p-1.5 gap-0.5 w-full">
          {ordered.map((opt) => {
            const checked = selectedSet.has(opt);
            const isOrphan = !options.includes(opt) && !leadingOptions.includes(opt);
            const label = optionLabels[opt] ?? opt;
            return (
              <li key={opt}>
                <label
                  className={[
                    'flex items-center gap-2.5 cursor-pointer rounded-md py-2 px-2.5',
                    'hover:bg-base-200/80 transition-colors',
                    checked ? 'bg-primary/10' : '',
                  ].join(' ')}
                >
                  <input
                    type="checkbox"
                    className="checkbox checkbox-sm shrink-0"
                    checked={checked}
                    onChange={() => toggle(opt)}
                  />
                  <span className="min-w-0 flex-1 flex items-center gap-2">
                    <span className="font-mono text-sm leading-snug break-all">
                      {label}
                    </span>
                    {isOrphan && (
                      <span className="badge badge-sm badge-ghost shrink-0">
                        custom
                      </span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
