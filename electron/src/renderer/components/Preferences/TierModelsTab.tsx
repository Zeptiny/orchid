/**
 * TierModelsTab — map agent tiers to models.
 *
 * 4 tiers: seed, sprout, bloom, crown.
 * Typed connection-scoped tier assignments are introduced with provider IPC in U8.
 */

interface TierInfo {
  id: string;
  label: string;
  description: string;
}

// ── Tier definitions ─────────────────────────────────────────────────────────

const TIERS: TierInfo[] = [
  {
    id: 'seed',
    label: 'Seed',
    description: 'Lightweight tasks — quick answers, simple lookups.',
  },
  {
    id: 'sprout',
    label: 'Sprout',
    description: 'Standard tasks — everyday coding, moderate reasoning.',
  },
  {
    id: 'bloom',
    label: 'Bloom',
    description: 'Complex tasks — deep reasoning, multi-step planning.',
  },
  {
    id: 'crown',
    label: 'Crown',
    description: 'Critical tasks — highest quality, architecture decisions.',
  },
];

// ── Component ────────────────────────────────────────────────────────────────

export function TierModelsTab() {
  return (
    <div className="config-form">
      <section className="config-fieldset">
        <div className="config-fieldset-legend">Tier Models</div>

        <div className="config-card-list">
          {TIERS.map((tier) => {
            return (
              <div key={tier.id} className="config-card config-card-row">
                <div className="min-w-0">
                  <div className="config-card-title">{tier.label}</div>
                  <p className="config-card-desc">{tier.description}</p>
                </div>
                <div className="badge badge-ghost shrink-0">
                  Not configured
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <div role="alert" className="alert alert-info">
        <span>
          Tier assignments require a provider connection and will be available
          with the connection setup flow.
        </span>
      </div>
    </div>
  );
}
