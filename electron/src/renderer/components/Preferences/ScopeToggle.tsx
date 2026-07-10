/**
 * ScopeToggle — Global vs Project filter for definition lists.
 * Uses fixed min-widths so the active state never shifts layout.
 */
import type { DefinitionScope } from '../../../shared/types/definitions';

export type ScopeFilter = 'all' | DefinitionScope;

export interface ScopeToggleProps {
  value: ScopeFilter;
  onChange: (value: ScopeFilter) => void;
  /** When false, project options are disabled. */
  projectAvailable: boolean;
  projectDir: string | null;
}

const OPTIONS = [
  { id: 'all' as const, label: 'All', minWidth: '3.25rem' },
  { id: 'global' as const, label: 'Global', minWidth: '4.25rem' },
  { id: 'project' as const, label: 'Project', minWidth: '4.5rem' },
] as const;

export function ScopeToggle({
  value,
  onChange,
  projectAvailable,
  projectDir,
}: ScopeToggleProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        className="inline-flex items-center rounded-md border border-base-300 bg-base-200/60 p-0.5 gap-0.5"
        role="group"
        aria-label="Definition scope filter"
      >
        {OPTIONS.map((opt) => {
          const disabled = opt.id === 'project' && !projectAvailable;
          const active = value === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              className={[
                'btn btn-xs h-7 min-h-7 border-0 shadow-none font-medium',
                active
                  ? 'btn-primary'
                  : 'btn-ghost bg-transparent text-base-content/70 hover:bg-base-300/60',
              ].join(' ')}
              style={{ minWidth: opt.minWidth }}
              disabled={disabled}
              aria-pressed={active}
              onClick={() => onChange(opt.id)}
              title={
                disabled
                  ? 'Bind a project folder to manage project definitions'
                  : undefined
              }
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {projectAvailable && projectDir ? (
        <span className="text-[10px] text-base-content/50 truncate max-w-[280px]" title={projectDir}>
          Project: {projectDir}
        </span>
      ) : (
        <span className="text-[10px] text-base-content/50">
          No project bound — project scope unavailable
        </span>
      )}
    </div>
  );
}

export function ScopeBadge({
  scope,
  overriddenByProject,
}: {
  scope: DefinitionScope;
  overriddenByProject?: boolean;
}) {
  if (scope === 'project') {
    return <span className="badge badge-xs badge-primary badge-outline">project</span>;
  }
  if (overriddenByProject) {
    return (
      <span className="badge badge-xs badge-warning badge-outline" title="A project override exists">
        global (overridden)
      </span>
    );
  }
  return <span className="badge badge-xs badge-ghost">global</span>;
}
