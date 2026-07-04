import json
import logging
import os
import shutil
from pathlib import Path
from typing import Any

from orchid.config import HOME_CONFIG_DIR

log = logging.getLogger(__name__)

SESSIONS_DIR = Path.home() / ".orchid" / "sessions"


def ensure_sessions_dir() -> Path:
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    return SESSIONS_DIR


def save_session(data: dict[str, Any]) -> None:
    """Save a session dict to ~/.orchid/sessions/<uuid>.json atomically."""
    session_id: str = data["id"]
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


def load_session(session_id: str) -> dict[str, Any] | None:
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


def list_saved_sessions() -> list[dict[str, Any]]:
    """Return metadata for all saved sessions (id, name, model) sorted by most recent.

    Uses a partial read strategy for top-level string metadata, then parses
    the session to report an exact chain count. Falls back to full metadata
    parsing if the partial read doesn't contain enough data.
    """
    ensure_sessions_dir()
    sessions: list[dict[str, Any]] = []
    partial_read_size = 2048

    def _session_mtime(path: Path) -> float:
        try:
            return path.stat().st_mtime
        except OSError as e:
            log.warning("Could not stat session file %s: %s", path.name, e)
            return 0

    session_paths = sorted(
        SESSIONS_DIR.glob("*.json"),
        key=_session_mtime,
        reverse=True,
    )
    for path in session_paths:
        try:
            # Try partial read first — metadata fields are at the top of the file
            with open(path) as f:
                head = f.read(partial_read_size)
            # Quick extraction via string search (avoids full JSON parse)
            session_id = _extract_json_string(head, '"id"')
            name = _extract_json_string(head, '"name"')
            model = _extract_json_string(head, '"model"')
            updated_at = path.stat().st_mtime
            if session_id:
                with open(path) as f:
                    data: dict[str, Any] = json.load(f)
                sessions.append({
                    "id": session_id,
                    "name": name or "Unnamed",
                    "model": model,
                    "chain_count": len(data.get("chains", [])),
                    "updated_at": updated_at,
                })
            else:
                # Fallback: full parse
                with open(path) as f:
                    data = json.load(f)
                sessions.append({
                    "id": data["id"],
                    "name": data.get("name", "Unnamed"),
                    "model": data.get("model"),
                    "chain_count": len(data.get("chains", [])),
                    "updated_at": updated_at,
                })
        except (json.JSONDecodeError, OSError, KeyError, TypeError, AttributeError) as e:
            log.warning("Skipping corrupted session file %s: %s", path.name, e)
    sessions.sort(key=lambda s: s.get("updated_at", 0.0), reverse=True)
    return sessions


def _extract_json_string(text: str, key: str) -> str | None:
    """Extract a simple string value for a JSON key from partial text.

    Works for flat top-level keys like "id", "name", "model" where the
    value is a quoted string. Returns None if the key is not found or
    value is null.
    """
    import re
    pattern = re.escape(key) + r'\s*:\s*"((?:\\.|[^"\\])*)"'
    match = re.search(pattern, text)
    if match:
        try:
            return json.loads(f'"{match.group(1)}"')
        except json.JSONDecodeError:
            return None
    return None


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
    from orchid.llm.client import cleanup_tool_output_cache
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
