/**
 * Config validation — comprehensive validation rules ported from Python
 * `src/orchid/config.py` lines 203–324.
 *
 * Zod handles type checking and basic constraints (positive int, non-empty
 * string, etc.).  This module handles cross-field and structural validations
 * that are awkward to express in zod:
 *
 * - non-empty `default_model`
 * - tier_models structure (non-empty string keys/values)
 * - provider alias format (`[a-z0-9-]+`, no reserved aliases)
 * - provider entry structure (base_url, api_key, api_key_env, models)
 * - mcp_server name format (`[a-z0-9-]+`)
 * - mcp_server entry structure (command, args, env)
 * - rag.chunk_overlap < rag.chunk_size
 */
import type { Config } from './schema';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MCP_SERVER_NAME_RE = /^[a-z0-9-]+$/;
const PROVIDER_ALIAS_RE = /^[a-z0-9-]+$/;
const RESERVED_PROVIDER_ALIASES = new Set(['fastembed']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkPositiveInt(
  obj: Record<string, unknown>,
  field: string,
  errors: string[],
  prefix?: string,
): void {
  const val = obj[field];
  const key = prefix ? `${prefix}.${field}` : `'${field}'`;
  if (typeof val !== 'number' || !Number.isInteger(val) || val <= 0) {
    errors.push(`${key} must be a positive integer, got ${typeof val === 'number' ? val : typeof val}`);
  }
}

function checkNonnegInt(
  obj: Record<string, unknown>,
  field: string,
  errors: string[],
  prefix?: string,
): void {
  const val = obj[field];
  const key = prefix ? `${prefix}.${field}` : `'${field}'`;
  if (typeof val !== 'number' || !Number.isInteger(val) || val < 0) {
    errors.push(`${key} must be a non-negative integer, got ${typeof val === 'number' ? val : typeof val}`);
  }
}

function checkPositiveFloat(
  obj: Record<string, unknown>,
  field: string,
  errors: string[],
  prefix?: string,
): void {
  const val = obj[field];
  const key = prefix ? `${prefix}.${field}` : `'${field}'`;
  if (typeof val !== 'number' || val <= 0) {
    errors.push(`${key} must be a positive number, got ${typeof val === 'number' ? val : typeof val}`);
  }
}

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

/**
 * Validate a fully-parsed Config and return a list of error messages.
 *
 * Returns an empty list if the config is valid. Each message describes a
 * specific problem with a field path.
 */
export function validateConfig(cfg: Config): string[] {
  const errors: string[] = [];

  // --- Non-empty strings ---
  if (!cfg.default_model || typeof cfg.default_model !== 'string') {
    errors.push(`'default_model' must be a non-empty string, got ${typeof cfg.default_model}`);
  }

  // --- tier_models ---
  if (typeof cfg.tier_models !== 'object' || cfg.tier_models === null) {
    errors.push("'tier_models' must be a dict");
  } else {
    for (const [tier, model] of Object.entries(cfg.tier_models)) {
      if (!tier) {
        errors.push(`'tier_models' key must be a non-empty string, got ${JSON.stringify(tier)}`);
      }
      if (!model || typeof model !== 'string') {
        errors.push(`'tier_models.${tier}' must be a non-empty string, got ${JSON.stringify(model)}`);
      }
    }
  }

  // --- ignored_dirs ---
  if (!Array.isArray(cfg.ignored_dirs)) {
    errors.push("'ignored_dirs' must be a list");
  }

  // --- Positive int fields ---
  checkPositiveInt(cfg as unknown as Record<string, unknown>, 'command_timeout', errors);
  checkPositiveInt(cfg as unknown as Record<string, unknown>, 'read_line_limit', errors);
  checkPositiveInt(cfg as unknown as Record<string, unknown>, 'grep_max_results', errors);
  checkPositiveInt(cfg as unknown as Record<string, unknown>, 'directory_tree_depth', errors);
  checkPositiveInt(cfg as unknown as Record<string, unknown>, 'ast_max_file_size', errors);

  // --- Float/int fields ---
  checkPositiveFloat(cfg as unknown as Record<string, unknown>, 'llm_stream_idle_timeout', errors);
  checkNonnegInt(cfg as unknown as Record<string, unknown>, 'llm_stream_retries', errors);
  checkPositiveFloat(cfg as unknown as Record<string, unknown>, 'mcp_startup_timeout', errors);
  checkPositiveFloat(cfg as unknown as Record<string, unknown>, 'mcp_per_server_timeout', errors);
  checkPositiveFloat(cfg as unknown as Record<string, unknown>, 'background_command_idle_timeout', errors);
  checkPositiveInt(cfg as unknown as Record<string, unknown>, 'max_tool_steps', errors);

  // --- RAG ---
  const rag = cfg.rag as unknown as Record<string, unknown>;
  if (typeof rag !== 'object' || rag === null) {
    errors.push("'rag' must be an object");
  } else {
    checkPositiveInt(rag, 'chunk_size', errors, 'rag');
    checkNonnegInt(rag, 'chunk_overlap', errors, 'rag');
    if (
      typeof rag['chunk_size'] === 'number' &&
      typeof rag['chunk_overlap'] === 'number' &&
      rag['chunk_overlap'] >= rag['chunk_size']
    ) {
      errors.push("'rag.chunk_overlap' must be less than 'rag.chunk_size'");
    }
    checkPositiveInt(rag, 'top_k', errors, 'rag');
    checkPositiveInt(rag, 'max_file_size', errors, 'rag');
    checkPositiveInt(rag, 'embedding_threads', errors, 'rag');
    checkPositiveInt(rag, 'embedding_batch_size', errors, 'rag');
    if (!rag['embedding_model'] || typeof rag['embedding_model'] !== 'string') {
      errors.push("'rag.embedding_model' must be a non-empty string");
    }
  }

  // --- providers ---
  const providers = cfg.providers as unknown as Record<string, unknown>;
  if (typeof providers !== 'object' || providers === null) {
    errors.push("'providers' must be a dict");
  } else {
    for (const [alias, entry] of Object.entries(providers)) {
      if (!PROVIDER_ALIAS_RE.test(alias)) {
        errors.push(`'providers.${alias}': alias must match [a-z0-9-]+ (no '/')`);
      }
      if (RESERVED_PROVIDER_ALIASES.has(alias)) {
        errors.push(`'providers.${alias}': alias is reserved (built-in pseudo-provider)`);
      }
      if (typeof entry !== 'object' || entry === null) {
        errors.push(`'providers.${alias}': must be a dict, got ${typeof entry}`);
        continue;
      }
      const entryDict = entry as Record<string, unknown>;
      const baseUrl = entryDict['base_url'];
      if (baseUrl !== undefined && (typeof baseUrl !== 'string' || !baseUrl)) {
        errors.push(`'providers.${alias}.base_url': must be a non-empty string`);
      }
      const apiKey = entryDict['api_key'];
      if (apiKey !== undefined && (typeof apiKey !== 'string' || !apiKey)) {
        errors.push(`'providers.${alias}.api_key': must be a non-empty string`);
      }
      const apiKeyEnv = entryDict['api_key_env'];
      if (apiKeyEnv !== undefined && (typeof apiKeyEnv !== 'string' || !apiKeyEnv)) {
        errors.push(`'providers.${alias}.api_key_env': must be a non-empty string`);
      }
      if (apiKey && apiKeyEnv) {
        errors.push(`'providers.${alias}': both 'api_key' and 'api_key_env' set; use only one`);
      }
      const litellmProvider = entryDict['litellm_provider'];
      if (litellmProvider !== undefined && (typeof litellmProvider !== 'string' || !litellmProvider)) {
        errors.push(`'providers.${alias}.litellm_provider': must be a non-empty string`);
      }
      const models = entryDict['models'];
      if (models !== undefined && (typeof models !== 'object' || models === null)) {
        errors.push(`'providers.${alias}.models': must be a dict`);
      } else if (typeof models === 'object' && models !== null) {
        for (const [modelId, override] of Object.entries(models as Record<string, unknown>)) {
          if (override !== undefined && (typeof override !== 'object' || override === null)) {
            errors.push(`'providers.${alias}.models.${modelId}': override must be a dict`);
          }
        }
      }
    }
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

  // --- theme & personality ---
  if (!cfg.theme || typeof cfg.theme !== 'string') {
    errors.push("'theme' must be a non-empty string");
  }
  if (!cfg.personality || typeof cfg.personality !== 'string') {
    errors.push("'personality' must be a non-empty string");
  }

  return errors;
}
