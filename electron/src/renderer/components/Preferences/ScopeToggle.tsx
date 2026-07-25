/**
 * ScopeToggle — Global vs Project filter for definition lists.
 * Uses fixed min-widths so the active state never shifts layout.
 */
import type { DefinitionScope } from '../../../shared/types/definitions';
import { Button } from '../ui/Button';
import { StatusBadge } from '../ui/StatusBadge';

export type ScopeFilter = 'all' | DefinitionScope;

export interface ScopeToggleProps {
  value: ScopeFilter;
  onChange: (value: ScopeFilter) => void;
  /** When false, project options are disabled. */
  projectAvailable: boolean;
  projectDir: string | null;
  includeAll?: boolean;
  ariaLabel?: string;
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
  includeAll = true,
  ariaLabel = 'Definition scope filter',
}: ScopeToggleProps) {
  const options = includeAll ? OPTIONS : OPTIONS.filter((option) => option.id !== 'all');
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div
        className="join join-horizontal rounded-box border border-base-300 bg-base-200/60 p-0.5"
        role="group"
        aria-label={ariaLabel}
      >
        {options.map((opt) => {
          const disabled = opt.id === 'project' && !projectAvailable;
          const active = value === opt.id;
          return (
            <Button
              key={opt.id}
              type="button"
              size="xs"
              variant={active ? 'primary' : 'ghost'}
              className={[
                'join-item h-7 min-h-7 border-0 shadow-none font-medium',
                active
                  ? ''
                  : 'bg-transparent text-base-content/70 hover:bg-base-300/60',
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
            </Button>
          );
        })}
      </div>
      {projectAvailable && projectDir ? (
        <span className="truncate text-xs text-base-content/50 max-w-xs" title={projectDir}>
          Project: {projectDir}
        </span>
      ) : (
        <span className="text-xs text-base-content/50">
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
    return (
      <StatusBadge tone="primary" size="xs" outline>
        project
      </StatusBadge>
    );
  }
  if (overriddenByProject) {
    return (
      <StatusBadge
        tone="warning"
        size="xs"
        outline
        title="A project override exists"
      >
        global (overridden)
      </StatusBadge>
    );
  }
  return (
    <StatusBadge tone="neutral" size="xs" outline>
      global
    </StatusBadge>
  );
}
