/**
 * ProjectTierModelsTab — per-project tier model / default model / reasoning
 * effort overrides.
 *
 * The runtime already resolves these from the project layer
 * (`ProjectRuntime.config` → `tier_models` → `default_model`), so this editor
 * makes that capability explicit instead of the old "global only" notice.
 * Overrides replace the project file's tier maps exactly; unset tiers inherit
 * the global (home) assignment.
 */
import { useEffect, useMemo } from 'react';
import type { ModelSelection } from '../../../shared/types/provider';
import type { Config } from '../../../shared/types/ipc-boundary';
import { useProviders } from '../../hooks/useProviders';
import { onOrchidEvent } from '../../utils/events';
import { isTextGenerationModel } from '../../utils/models';
import { ModelAssignments } from './ModelAssignments';

/** Explicit project overrides for the tier assignment surface. */
export interface ProjectTierOverrides {
  /** null = clear the override (inherit the home default). */
  defaultModel: ModelSelection | null;
  tierModels: Record<string, ModelSelection | null>;
  tierReasoningEffort: Record<string, string | number | null>;
}

export interface ProjectTierModelsTabProps {
  /** Global (home-only) config providing inherit targets. */
  readonly homeConfig: Config | null;
  /** Tier overrides stored in the project `.orchid.json`. */
  readonly stored: ProjectTierOverrides;
  /** Draft edits; `null` parts mean "no change from stored". */
  readonly draft: ProjectTierOverrides | null;
  readonly onDraftChange: (draft: ProjectTierOverrides | null) => void;
}

function plainRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Shape-validate a raw `.orchid.json` value as a ModelSelection (or null). */
function coerceSelection(value: unknown): ModelSelection | null {
  if (
    value !== null && typeof value === 'object'
    && typeof (value as Record<string, unknown>)['connectionId'] === 'string'
    && typeof (value as Record<string, unknown>)['modelId'] === 'string'
  ) {
    return value as unknown as ModelSelection;
  }
  return null;
}

/**
 * Explicit-null tier entries ("mask the home tier, use the default model")
 * are a file-level state the project UI does not model — the picker is
 * inherit-or-selection. Treat them as absent so a save through this view
 * normalizes them away instead of mislabeling them "Inherit global".
 */
function selectionRecord(value: unknown): Record<string, ModelSelection | null> {
  const out: Record<string, ModelSelection | null> = {};
  for (const [key, entry] of Object.entries(plainRecord(value))) {
    const selection = coerceSelection(entry);
    if (selection !== null) out[key] = selection;
  }
  return out;
}

/** Null efforts are runtime-equivalent to absent for our two-state UI; drop. */
function effortRecord(value: unknown): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [key, entry] of Object.entries(plainRecord(value))) {
    if (typeof entry === 'string' || typeof entry === 'number') {
      out[key] = entry;
    }
  }
  return out;
}

/** Read tier overrides out of raw project-config overrides. */
export function readTierOverrides(overrides: Record<string, unknown>): ProjectTierOverrides {
  return {
    defaultModel: coerceSelection(overrides['default_model']),
    tierModels: selectionRecord(overrides['tier_models']),
    tierReasoningEffort: effortRecord(overrides['tier_reasoning_effort']),
  };
}

function stripNullEfforts(
  map: Record<string, string | number | null>,
): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  for (const [key, value] of Object.entries(map)) {
    if (value !== null) out[key] = value;
  }
  return out;
}

export function ProjectTierModelsTab({
  homeConfig,
  stored,
  draft,
  onDraftChange,
}: ProjectTierModelsTabProps) {
  const providers = useProviders();

  useEffect(() => {
    void providers.ensureModelList();
  }, [providers.ensureModelList]);

  useEffect(() => {
    return onOrchidEvent('orchid:providers-updated', () => {
      void providers.refresh().then(() => providers.ensureModelList());
    });
  }, [providers.refresh, providers.ensureModelList]);

  const options = useMemo(
    () => (providers.modelOptions ?? []).filter(
      (option) => option.available && isTextGenerationModel(option.model),
    ),
    [providers.modelOptions],
  );

  const effective = draft ?? stored;

  const resetTier = (tierId: string): void => {
    const next = { ...effective.tierModels };
    delete next[tierId];
    onDraftChange({ ...effective, tierModels: next });
  };
  const setDefault = (selection: ModelSelection | null): void => {
    onDraftChange({ ...effective, defaultModel: selection });
  };
  const clearDefault = (): void => {
    onDraftChange({ ...effective, defaultModel: null });
  };

  return (
    <div className="config-form">
      <ModelAssignments
        options={options}
        connections={providers.overview?.connections ?? []}
        defaultModel={effective.defaultModel}
        tierModels={effective.tierModels}
        tierReasoningEffort={effective.tierReasoningEffort}
        projectScope
        inheritedDefaultModel={homeConfig?.default_model ?? null}
        inheritedTierModels={homeConfig?.tier_models ?? {}}
        onDefaultModelChange={setDefault}
        onDefaultModelReset={clearDefault}
        onTierModelsChange={(next) => {
          // ModelAssignments sends the complete desired map; only explicit
          // selections reach here ('' routes to resetTier in project scope).
          onDraftChange({ ...effective, tierModels: next });
        }}
        onTierReset={resetTier}
        onTierReasoningEffortChange={(next) => {
          onDraftChange({ ...effective, tierReasoningEffort: stripNullEfforts(next) });
        }}
      />
    </div>
  );
}
