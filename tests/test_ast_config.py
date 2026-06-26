import os
from unittest import mock

from stupidex.config import AST_INDEX_DB, PROJECT_AST_DIR, Config, ConfigManager, RAGConfig, get_config, validate_config


def test_ast_path_constants():
    assert PROJECT_AST_DIR == ".stupidex/ast"
    assert AST_INDEX_DB == "symbols.db"


def test_default_ast_max_file_size():
    ConfigManager.reset()
    cfg = Config()
    assert cfg.ast_max_file_size == 1_048_576


def test_config_loads_default_ast_max_file_size():
    ConfigManager.reset()
    with mock.patch("stupidex.config._load_json", return_value={}):
        cfg = get_config()
    assert cfg.ast_max_file_size == 1_048_576


def test_env_override_ast_max_file_size():
    ConfigManager.reset()
    with (
        mock.patch.dict(os.environ, {"STUPIDEX_AST_MAX_FILE_SIZE": "256000"}),
        mock.patch("stupidex.config._load_json", return_value={}),
    ):
        cfg = get_config()
    assert cfg.ast_max_file_size == 256000


def test_validate_rejects_non_positive_ast_max_file_size():
    cfg = Config(ast_max_file_size=-1)
    errors = validate_config(cfg)
    assert any("ast_max_file_size" in e for e in errors)


def test_validate_rejects_zero_ast_max_file_size():
    cfg = Config(ast_max_file_size=0)
    errors = validate_config(cfg)
    assert any("ast_max_file_size" in e for e in errors)


def test_validate_rejects_invalid_type_ast_max_file_size():
    cfg = Config(ast_max_file_size="not_an_int")
    errors = validate_config(cfg)
    assert any("ast_max_file_size" in e for e in errors)


def test_validate_rejects_bool_ast_max_file_size():
    for bool_val in (True, False):
        cfg = Config(ast_max_file_size=bool_val)
        ConfigManager.reset()
        errors = validate_config(cfg)
        assert any("ast_max_file_size" in e for e in errors), (
            f"Boolean {bool_val!r} should produce an error"
        )


def test_validate_default_config_returns_no_errors():
    cfg = Config()
    errors = validate_config(cfg)
    assert errors == []


def test_validate_rejects_missing_default_model():
    cfg = Config(default_model="")
    errors = validate_config(cfg)
    assert any("default_model" in e for e in errors)


def test_validate_rejects_bad_provider_alias():
    cfg = Config(providers={"bad/alias": {"base_url": "http://example.com"}})
    errors = validate_config(cfg)
    assert any("bad/alias" in e for e in errors)


def test_validate_rejects_bad_mcp_server_command():
    cfg = Config(mcp_servers={"myserver": {"args": []}})
    errors = validate_config(cfg)
    assert any("myserver.command" in e for e in errors)


def test_validate_rejects_negative_rag_chunk_size():
    cfg = Config(rag=RAGConfig(chunk_size=-1))
    errors = validate_config(cfg)
    assert any("rag.chunk_size" in e for e in errors)


def test_validate_rejects_rag_chunk_overlap_ge_chunk_size():
    cfg = Config(rag=RAGConfig(chunk_size=100, chunk_overlap=100))
    errors = validate_config(cfg)
    assert any("chunk_overlap" in e for e in errors)


def test_validate_rag_config_nested_structure():
    cfg = Config()
    assert isinstance(cfg.rag, RAGConfig)
    assert cfg.rag.chunk_size == 2000
    assert cfg.rag.chunk_overlap == 200
    assert cfg.rag.top_k == 5
    assert cfg.rag.max_file_size == 512000
    assert cfg.rag.embedding_model == "fastembed/BAAI/bge-small-en-v1.5"
