import json
import logging
import os
import shutil
from pathlib import Path

from stupidex.config import HOME_CONFIG_DIR

log = logging.getLogger(__name__)

SESSIONS_DIR = Path.home() / ".stupidex" / "sessions"


def ensure_sessions_dir() -> Path:
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    return SESSIONS_DIR


def save_session(data: dict) -> None:
    """Save a session dict to ~/.stupidex/sessions/<uuid>.json atomically."""
    session_id = data["id"]
    ensure_sessions_dir()
    path = SESSIONS_DIR / f"{session_id}.json"
    tmp = path.with_suffix(".tmp")
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        log.exception("Failed to save session %s", session_id)
        raise


def load_session(session_id: str) -> dict | None:
    """Load a session dict from disk by ID. Returns None if not found."""
    path = SESSIONS_DIR / f"{session_id}.json"
    if not path.exists():
        return None
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        log.warning("Failed to load session %s: %s", session_id, e)
        return None


def list_saved_sessions() -> list[dict]:
    """Return metadata for all saved sessions (id, name, model) sorted by most recent chains."""
    ensure_sessions_dir()
    sessions = []
    for path in SESSIONS_DIR.glob("*.json"):
        try:
            with open(path) as f:
                data = json.load(f)
            # Extract just the metadata we need for listing
            sessions.append({
                "id": data["id"],
                "name": data.get("name", "Unnamed"),
                "model": data.get("model"),
                "chain_count": len(data.get("chains", [])),
            })
        except (json.JSONDecodeError, OSError, KeyError, TypeError, AttributeError) as e:
            log.warning("Skipping corrupted session file %s: %s", path.name, e)
    return sessions


def delete_session(session_id: str) -> bool:
    """Delete a session file from disk. Returns True if deleted."""
    path = SESSIONS_DIR / f"{session_id}.json"
    if not path.exists():
        return False
    try:
        path.unlink()
    except OSError as e:
        log.warning("Failed to delete session file %s: %s", session_id, e)
        return False
    from stupidex.llm.client import cleanup_tool_output_cache
    try:
        cleanup_tool_output_cache(session_id)
    except Exception:
        log.debug("Failed to clean tool-output cache for %s", session_id, exc_info=True)
    cache_dir = HOME_CONFIG_DIR / "cache" / "web-fetch" / session_id
    if cache_dir.exists():
        try:
            shutil.rmtree(cache_dir)
        except OSError as e:
            log.warning("Failed to delete cache dir for %s: %s", session_id, e)
    return True
