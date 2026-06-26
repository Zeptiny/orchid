import json
import logging
import os
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

log = logging.getLogger(__name__)

_MCP_SERVER_NAME_RE = re.compile(r"^[a-z0-9-]+$")
_PROVIDER_ALIAS_RE = re.compile(r"^[a-z0-9-]+$")
_RESERVED_PROVIDER_ALIASES = frozenset({"fastembed"})

HOME_CONFIG_DIR = Path.home() / ".stupidex"
HOME_CONFIG_PATH = HOME_CONFIG_DIR / "config.json"
HOME_AGENTS_DIR = HOME_CONFIG_DIR / "agents"
HOME_SKILLS_DIR = HOME_CONFIG_DIR / "skills"
PROJECT_CONFIG_NAME = ".stupidex.json"
PROJECT_AGENTS_DIR = ".stupidex/agents"
PROJECT_SKILLS_DIR = ".stupidex/skills"
PROJECT_RAG_DIR = ".stupidex/rag"
RAG_VECTORS_FILE = "vectors.npy"
RAG_INDEX_DB = "index.db"
PROJECT_AST_DIR = ".stupidex/ast"
AST_INDEX_DB = "symbols.db"
ENV_PREFIX = "STUPIDEX_"


@dataclass
class RAGConfig:
    chunk_size: int = 2000
    chunk_overlap: int = 200
    top_k: int = 5
    max_file_size: int = 512000
    embedding_model: str = "fastembed/BAAI/bge-small-en-v1.5"


@dataclass
class Config:
    default_model: str = "default/mimo-v2.5"
    tier_models: dict[str, str] = field(
        default_factory=lambda: {
            "tolo": "default/mimo-v2.5",
            "tainha": "default/mimo-v2.5",
            "papudo": "default/mimo-v2.5",
            "papaca": "default/mimo-v2.5",
        }
    )
    ignored_dirs: list[str] = field(
        default_factory=lambda: [
            ".git",
            ".svn",
            ".hg",
            "node_modules",
            "__pycache__",
            "venv",
            ".venv",
            "env",
            "dist",
            "build",
            "target",
            ".idea",
            ".vscode",
            ".vs",
            ".mypy_cache",
            ".pytest_cache",
            ".ruff_cache",
            ".tox",
            ".nox",
            ".eggs",
            "*.egg-info",
        ]
    )
    command_timeout: int = 30
    read_line_limit: int = 1000
    grep_max_results: int = 100
    directory_tree_depth: int = 2
    theme: str = "default"
    personality: str = "default"
    rag: RAGConfig = field(default_factory=RAGConfig)
    ast_max_file_size: int = 1_048_576
    mcp_startup_timeout: float = 60.0
    mcp_per_server_timeout: float = 10.0
    mcp_servers: dict[str, dict] = field(
        default_factory=lambda: {
            "context7": {
                "command": "npx",
                "args": ["-y", "@upstash/context7-mcp"],
            },
            "example": {
                "command": "python",
                "args": ["-m", "stupidex.mcp.example_server"],
            },
        }
    )
    providers: dict[str, dict] = field(
        default_factory=lambda: {
            "default": {
                "base_url": "https://opencode.ai/zen/go/v1",
                "litellm_provider": "openai",
                "models": {"mimo-v2.5": {}},
            }
        }
    )
    llm_stream_idle_timeout: float = 300.0
    llm_stream_retries: int = 3

    def __post_init__(self) -> None:
        """Normalise nested dataclass fields after construction.

        ``Config(**{"rag": {"chunk_size": 2000, ...}})`` leaves ``self.rag`` as a
        plain dict because the dataclass machinery does not recursively construct
        nested dataclass instances. This fix-up converts the dict to a ``RAGConfig``
        when the constructor receives a dict.
        """
        if isinstance(self.rag, dict):
            object.__setattr__(self, "rag", RAGConfig(**self.rag))


_ENV_MAP = {
    "STUPIDEX_DEFAULT_MODEL": "default_model",
    "STUPIDEX_IGNORED_DIRS": "ignored_dirs",
    "STUPIDEX_COMMAND_TIMEOUT": "command_timeout",
    "STUPIDEX_READ_LINE_LIMIT": "read_line_limit",
    "STUPIDEX_GREP_MAX_RESULTS": "grep_max_results",
    "STUPIDEX_DIRECTORY_TREE_DEPTH": "directory_tree_depth",
    "STUPIDEX_THEME": "theme",
    "STUPIDEX_PERSONALITY": "personality",
    "STUPIDEX_AST_MAX_FILE_SIZE": "ast_max_file_size",
    "STUPIDEX_LLM_STREAM_IDLE_TIMEOUT": "llm_stream_idle_timeout",
    "STUPIDEX_LLM_STREAM_RETRIES": "llm_stream_retries",
    "STUPIDEX_MCP_STARTUP_TIMEOUT": "mcp_startup_timeout",
    "STUPIDEX_MCP_PER_SERVER_TIMEOUT": "mcp_per_server_timeout",
}

_RAG_ENV_MAP = {
    "STUPIDEX_RAG_EMBEDDING_MODEL": "embedding_model",
    "STUPIDEX_RAG_CHUNK_SIZE": "chunk_size",
    "STUPIDEX_RAG_CHUNK_OVERLAP": "chunk_overlap",
    "STUPIDEX_RAG_TOP_K": "top_k",
    "STUPIDEX_RAG_MAX_FILE_SIZE": "max_file_size",
}


def _load_json(path: Path) -> dict:
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _convert_from_dict(data: dict) -> dict:
    """Normalize a raw dict before constructing Config.

    Strips None values so they don't shadow dataclass defaults. Legacy
    flat RAG fields (`rag_chunk_size`, etc.) are NOT converted to the
    nested ``rag`` form: there is no backward compatibility, so configs
    still carrying flat RAG fields simply fall back to ``RAGConfig``
    defaults (unknown top-level keys are ignored by ``ConfigManager.load``).
    Never mutates the input.
    """
    result = dict(data)

    for k in list(result.keys()):
        if result[k] is None:
            del result[k]

    return result


def _cast_value(value: str, target_type):
    if target_type is bool:
        return value.lower() in ("true", "1", "yes")
    if target_type is int:
        return int(value)
    if target_type is float:
        return float(value)
    if target_type is list:
        return [s.strip() for s in value.split(",")]
    return value


def _merge_from_env(cfg: Config) -> Config:
    values = asdict(cfg)
    for env_key, field_name in _ENV_MAP.items():
        raw = os.environ.get(env_key)
        if raw is not None:
            target_type = type(values[field_name])
            values[field_name] = _cast_value(raw, target_type)
    # Nested RAG env overrides
    rag_values = dict(values["rag"])
    for env_key, field_name in _RAG_ENV_MAP.items():
        raw = os.environ.get(env_key)
        if raw is not None:
            target_type = type(rag_values[field_name])
            rag_values[field_name] = _cast_value(raw, target_type)
    values["rag"] = RAGConfig(**rag_values)
    return Config(**values)


_NON_EMPTY_STRINGS = {"default_model"}

_VALID_TIERS = frozenset({"tolo", "tainha", "papudo", "papaca"})


def validate_config(cfg: Config) -> list[str]:
    """Validate config and return a list of error messages.

    Returns an empty list if the config is valid. Each message describes
    a specific problem with a field path.
    """
    errors: list[str] = []

    for field_name in _NON_EMPTY_STRINGS:
        val = getattr(cfg, field_name)
        if not val or not isinstance(val, str):
            errors.append(f"'{field_name}' must be a non-empty string, got {type(val).__name__}")

    # Validate tier_models
    if not isinstance(cfg.tier_models, dict):
        errors.append("'tier_models' must be a dict")
    else:
        for tier, model in cfg.tier_models.items():
            if not isinstance(tier, str) or not tier:
                errors.append(f"'tier_models' key must be a non-empty string, got {tier!r}")
            if not isinstance(model, str) or not model:
                errors.append(f"'tier_models.{tier}' must be a non-empty string, got {model!r}")

    # Validate ignored_dirs
    if not isinstance(cfg.ignored_dirs, list):
        errors.append("'ignored_dirs' must be a list")

    # Validate int fields
    _check_positive_int(cfg, "command_timeout", errors)
    _check_positive_int(cfg, "read_line_limit", errors)
    _check_positive_int(cfg, "grep_max_results", errors)
    _check_positive_int(cfg, "directory_tree_depth", errors)
    _check_positive_int(cfg, "ast_max_file_size", errors)

    _check_positive_float(cfg, "llm_stream_idle_timeout", errors)
    _check_nonneg_int(cfg, "llm_stream_retries", errors)

    _check_positive_float(cfg, "mcp_startup_timeout", errors)
    _check_positive_float(cfg, "mcp_per_server_timeout", errors)

    # Validate RAG
    if not isinstance(cfg.rag, RAGConfig):
        errors.append("'rag' must be a RAGConfig object")
    else:
        _check_positive_int(cfg.rag, "chunk_size", errors, prefix="rag")
        _check_nonneg_int(cfg.rag, "chunk_overlap", errors, prefix="rag")
        if isinstance(cfg.rag.chunk_size, int) and isinstance(cfg.rag.chunk_overlap, int) and cfg.rag.chunk_overlap >= cfg.rag.chunk_size:
            errors.append("'rag.chunk_overlap' must be less than 'rag.chunk_size'")
        _check_positive_int(cfg.rag, "top_k", errors, prefix="rag")
        _check_positive_int(cfg.rag, "max_file_size", errors, prefix="rag")
        if not isinstance(cfg.rag.embedding_model, str) or not cfg.rag.embedding_model:
            errors.append("'rag.embedding_model' must be a non-empty string")

    # Validate providers
    if not isinstance(cfg.providers, dict):
        errors.append("'providers' must be a dict")
    else:
        for alias, entry in cfg.providers.items():
            if not isinstance(alias, str) or not _PROVIDER_ALIAS_RE.match(alias):
                errors.append(f"'providers.{alias}': alias must match [a-z0-9-]+ (no '/')")
            if alias in _RESERVED_PROVIDER_ALIASES:
                errors.append(f"'providers.{alias}': alias is reserved (built-in pseudo-provider)")
            if not isinstance(entry, dict):
                errors.append(f"'providers.{alias}': must be a dict, got {type(entry).__name__}")
                continue
            base_url = entry.get("base_url")
            if base_url is not None and (not isinstance(base_url, str) or not base_url):
                errors.append(f"'providers.{alias}.base_url': must be a non-empty string")
            api_key = entry.get("api_key")
            if api_key is not None and (not isinstance(api_key, str) or not api_key):
                errors.append(f"'providers.{alias}.api_key': must be a non-empty string")
            api_key_env = entry.get("api_key_env")
            if api_key_env is not None and (not isinstance(api_key_env, str) or not api_key_env):
                errors.append(f"'providers.{alias}.api_key_env': must be a non-empty string")
            if api_key and api_key_env:
                errors.append(f"'providers.{alias}': both 'api_key' and 'api_key_env' set; use only one")
            litellm_provider = entry.get("litellm_provider")
            if litellm_provider is not None and (not isinstance(litellm_provider, str) or not litellm_provider):
                errors.append(f"'providers.{alias}.litellm_provider': must be a non-empty string")
            models = entry.get("models", {})
            if not isinstance(models, dict):
                errors.append(f"'providers.{alias}.models': must be a dict")
            else:
                for model_id, override in models.items():
                    if override is not None and not isinstance(override, dict):
                        errors.append(f"'providers.{alias}.models.{model_id}': override must be a dict")

    # Validate mcp_servers
    if not isinstance(cfg.mcp_servers, dict):
        errors.append("'mcp_servers' must be a dict")
    else:
        for name, server_cfg in cfg.mcp_servers.items():
            if not isinstance(name, str) or not _MCP_SERVER_NAME_RE.match(name):
                errors.append(f"'mcp_servers.{name}': name must match [a-z0-9-]+")
            if not isinstance(server_cfg, dict):
                errors.append(f"'mcp_servers.{name}': must be a dict, got {type(server_cfg).__name__}")
                continue
            if "url" not in server_cfg:
                cmd = server_cfg.get("command")
                if not isinstance(cmd, str) or not cmd:
                    errors.append(f"'mcp_servers.{name}.command': must be a non-empty string")
                args = server_cfg.get("args", [])
                if not isinstance(args, list):
                    errors.append(f"'mcp_servers.{name}.args': must be a list")
            env = server_cfg.get("env")
            if env is not None and not isinstance(env, dict):
                errors.append(f"'mcp_servers.{name}.env': must be a dict")

    # Validate theme and personality (basic existence check — full validation done at load time)
    if not isinstance(cfg.theme, str) or not cfg.theme:
        errors.append("'theme' must be a non-empty string")
    if not isinstance(cfg.personality, str) or not cfg.personality:
        errors.append("'personality' must be a non-empty string")

    return errors


def _check_positive_int(obj, field: str, errors: list[str], prefix: str | None = None) -> None:
    val = getattr(obj, field)
    key = f"{prefix}.{field}" if prefix else f"'{field}'"
    if not isinstance(val, int) or isinstance(val, bool):
        errors.append(f"{key} must be a positive integer, got {type(val).__name__}")
    elif val <= 0:
        errors.append(f"{key} must be a positive integer, got {val}")


def _check_nonneg_int(obj, field: str, errors: list[str], prefix: str | None = None) -> None:
    val = getattr(obj, field)
    key = f"{prefix}.{field}" if prefix else f"'{field}'"
    if not isinstance(val, int) or isinstance(val, bool):
        errors.append(f"{key} must be a non-negative integer, got {type(val).__name__}")
    elif val < 0:
        errors.append(f"{key} must be a non-negative integer, got {val}")


def _check_positive_float(obj, field: str, errors: list[str], prefix: str | None = None) -> None:
    val = getattr(obj, field)
    key = f"{prefix}.{field}" if prefix else f"'{field}'"
    if not isinstance(val, (int, float)) or isinstance(val, bool):
        errors.append(f"{key} must be a positive number, got {type(val).__name__}")
    elif val <= 0:
        errors.append(f"{key} must be a positive number, got {val}")


def _deep_merge_provider_dict(home: dict, project: dict) -> dict:
    """Recursively merge two provider-dict-shaped values (`providers` or `mcp_servers`).

    For each alias present in either side:
    - present only in `home` → take home entry;
    - present only in `project` → take project entry;
    - present in both as dicts → entry fields shallow-merge as `{**home_entry,
      **project_entry}`, with a recursive merge of a nested `models` sub-dict
      when both sides carry one (preserves home-only fields when project adds
      a new model).

    Anything other than a dict on either side falls back to the project value
    (matches the prior `mcp_servers` merge behavior).
    """
    result: dict[str, dict] = {}
    for alias in set(home) | set(project):
        if alias not in project:
            result[alias] = home[alias]
            continue
        if alias not in home:
            result[alias] = project[alias]
            continue
        home_entry = home[alias]
        project_entry = project[alias]
        if not isinstance(home_entry, dict) or not isinstance(project_entry, dict):
            result[alias] = project_entry
            continue
        merged_entry = {**home_entry, **project_entry}
        home_models = home_entry.get("models")
        project_models = project_entry.get("models")
        if isinstance(home_models, dict) and isinstance(project_models, dict):
            merged_entry["models"] = {**home_models, **project_models}
        result[alias] = merged_entry
    return result


_DEEP_MERGE_KEYS = frozenset({"mcp_servers", "providers"})


class ConfigManager:
    _instance: Config | None = None
    _errors: list[str] = []

    @classmethod
    def errors(cls) -> list[str]:
        """Return validation errors from the last load."""
        return list(cls._errors)

    @classmethod
    def load(cls) -> Config:
        if cls._instance is not None:
            return cls._instance

        defaults = Config()
        merged = asdict(defaults)

        home = _load_json(HOME_CONFIG_PATH)
        home = _convert_from_dict(home)
        for k, v in home.items():
            if k not in merged:
                continue
            if k in _DEEP_MERGE_KEYS and isinstance(v, dict) and isinstance(merged.get(k), dict):
                merged[k] = _deep_merge_provider_dict(merged[k], v)
            elif isinstance(v, dict) and isinstance(merged.get(k), dict):
                # Deep-merge nested dicts even outside _DEEP_MERGE_KEYS so
                # partial nested configs (e.g. project setting only `rag.top_k`)
                # merge with home-level values instead of replacing them wholesale.
                merged[k] = _deep_merge_provider_dict(merged[k], v)
            else:
                merged[k] = v

        project_path = Path.cwd() / PROJECT_CONFIG_NAME
        project = _load_json(project_path)
        project = _convert_from_dict(project)
        for k, v in project.items():
            if k not in merged:
                continue
            if k in _DEEP_MERGE_KEYS and isinstance(v, dict) and isinstance(merged.get(k), dict):
                merged[k] = _deep_merge_provider_dict(merged[k], v)
            elif isinstance(v, dict) and isinstance(merged.get(k), dict):
                # Deep-merge nested dicts even outside _DEEP_MERGE_KEYS so
                # partial nested configs (e.g. project setting only `rag.top_k`)
                # merge with home-level values instead of replacing them wholesale.
                merged[k] = _deep_merge_provider_dict(merged[k], v)
            else:
                merged[k] = v

        cfg = Config(**merged)
        cfg = _merge_from_env(cfg)
        cls._errors = validate_config(cfg)

        cls._instance = cfg
        return cfg

    @classmethod
    def ensure_home_config(cls) -> None:
        HOME_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        os.chmod(str(HOME_CONFIG_DIR), 0o700)
        if not HOME_CONFIG_PATH.exists():
            defaults = Config()
            with open(HOME_CONFIG_PATH, "w") as f:
                json.dump(asdict(defaults), f, indent=2)
            os.chmod(str(HOME_CONFIG_PATH), 0o600)
        from stupidex.agents import load_agents, seed_agents_dir

        seed_agents_dir(HOME_AGENTS_DIR)
        load_agents()
        from stupidex.skills import load_skills, seed_skills_dir

        seed_skills_dir(HOME_SKILLS_DIR)
        load_skills()
        from stupidex.personality import load_personalities

        load_personalities()

    @classmethod
    def reset(cls) -> None:
        cls._instance = None
        cls._errors = []

    @classmethod
    def save(cls) -> None:
        if cls._instance is None:
            return
        HOME_CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        tmp = HOME_CONFIG_PATH.with_suffix(".tmp")
        try:
            with open(tmp, "w") as f:
                json.dump(asdict(cls._instance), f, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, HOME_CONFIG_PATH)
            os.chmod(str(HOME_CONFIG_PATH), 0o600)
            dir_fd = os.open(str(HOME_CONFIG_DIR), os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except BaseException:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass
            raise


def get_config() -> Config:
    return ConfigManager.load()


def get_model_for_tier(tier: str) -> str:
    cfg = get_config()
    return cfg.tier_models.get(tier, cfg.default_model)


def get_current_theme() -> str:
    return get_config().theme


def set_current_theme(name: str) -> None:
    from stupidex.themes import get_theme_registry

    get_theme_registry().get(name)  # raises ValueError for unknown theme
    cfg = get_config()
    cfg.theme = name
    ConfigManager.save()


def get_current_personality() -> str:
    return get_config().personality


def set_current_personality(name: str) -> None:
    from stupidex.personality import get_personality_registry

    get_personality_registry().get(name)  # raises ValueError for unknown
    cfg = get_config()
    cfg.personality = name
    ConfigManager.save()
