/**
 * Config validation — cross-field and structural validations.
 *
 * Zod handles type checking and basic constraints (positive int, non-empty
 * string, etc.).  This module handles cross-field and structural validations
 * that are awkward to express in zod:
 *
 * - nullable connection-scoped `default_model` / tier selections
 * - tier_models structure (non-empty string keys, typed nullable values)
 * - mcp_server name format (`[a-z0-9-]+`)
 * - mcp_server entry structure (command, args, env)
 * - rag.chunk_overlap < rag.chunk_size
 */
import { modelSelectionSchema } from '../../shared/types/provider';
import type { Config } from './schema';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MCP_SERVER_NAME_RE = /^[a-z0-9-]+$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkNullableModelSelection(
  value: unknown,
  field: string,
  errors: string[],
): void {
  if (value === null) return;
  if (!modelSelectionSchema.safeParse(value).success) {
    errors.push(`'${field}' must be null or a valid connection-scoped model selection`);
  }
}

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

/**
 * Validate a fully-parsed Config and return a list of error messages.
 *
 * Returns an empty list if the config is valid. Each message describes a
 * specific problem with a field path. Range/type constraints already enforced
 * by `configSchema` are not re-checked here.
 */
export function validateConfig(cfg: Config): string[] {
  const errors: string[] = [];

  // --- Connection-scoped model selections ---
  checkNullableModelSelection(cfg.default_model, 'default_model', errors);

  // --- tier_models ---
  if (typeof cfg.tier_models !== 'object' || cfg.tier_models === null) {
    errors.push("'tier_models' must be a dict");
  } else {
    for (const [tier, model] of Object.entries(cfg.tier_models)) {
      if (!tier) {
        errors.push(`'tier_models' key must be a non-empty string, got ${JSON.stringify(tier)}`);
      }
      checkNullableModelSelection(model, `tier_models.${tier}`, errors);
    }
  }

  // --- RAG cross-field ---
  const rag = cfg.rag;
  if (
    typeof rag.chunk_size === 'number' &&
    typeof rag.chunk_overlap === 'number' &&
    rag.chunk_overlap >= rag.chunk_size
  ) {
    errors.push("'rag.chunk_overlap' must be less than 'rag.chunk_size'");
  }

  // --- mcp_servers ---
  const mcpServers = cfg.mcp_servers as unknown as Record<string, unknown>;
  if (typeof mcpServers !== 'object' || mcpServers === null) {
    errors.push("'mcp_servers' must be a dict");
  } else {
    for (const [name, serverCfg] of Object.entries(mcpServers)) {
      if (!MCP_SERVER_NAME_RE.test(name)) {
        errors.push(`'mcp_servers.${name}': name must match [a-z0-9-]+`);
      }
      if (typeof serverCfg !== 'object' || serverCfg === null) {
        errors.push(`'mcp_servers.${name}': must be a dict, got ${typeof serverCfg}`);
        continue;
      }
      const serverDict = serverCfg as Record<string, unknown>;
      if (!('url' in serverDict)) {
        const cmd = serverDict['command'];
        if (typeof cmd !== 'string' || !cmd) {
          errors.push(`'mcp_servers.${name}.command': must be a non-empty string`);
        }
        const args = serverDict['args'];
        if (args !== undefined && !Array.isArray(args)) {
          errors.push(`'mcp_servers.${name}.args': must be a list`);
        }
      }
      const env = serverDict['env'];
      if (env !== undefined && (typeof env !== 'object' || env === null)) {
        errors.push(`'mcp_servers.${name}.env': must be a dict`);
      }
    }
  }

  return errors;
}
