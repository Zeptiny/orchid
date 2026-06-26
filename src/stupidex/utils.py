import os
import re
from pathlib import Path

from stupidex.config import get_config

_FRONTMATTER_PATTERN = re.compile(
    r'^---\s*\n(.*?)\n---\s*\n(.*)',
    re.DOTALL
)


def parse_frontmatter(content: str) -> tuple[dict, str]:
    """Parse YAML frontmatter from markdown content.

    Returns (metadata_dict, body_content).
    If no frontmatter is found, returns ({}, content).
    """
    match = _FRONTMATTER_PATTERN.match(content.strip())
    if not match:
        return {}, content

    frontmatter_str = match.group(1)
    body = match.group(2)

    metadata: dict[str, str | list[str]] = {}
    current_key: str | None = None
    current_list: list[str] | None = None

    for line in frontmatter_str.split('\n'):
        stripped = line.strip()

        # List item under a key
        if stripped.startswith('- ') and current_key:
            if current_list is None:
                current_list = []
            current_list.append(stripped[2:].strip().strip("'\""))
            continue

        # Save previous list if we hit a new key
        if current_list is not None and current_key:
            metadata[current_key] = current_list
            current_list = None

        if not stripped or ':' not in stripped:
            continue

        key, _, value = stripped.partition(':')
        key = key.strip()
        value = value.strip()
        current_key = key

        # Remove quotes if present
        if value and value[0] in ('"', "'") and value[-1] == value[0]:
            value = value[1:-1]

        if value:
            metadata[key] = value
            current_list = None
        else:
            current_list = []

    # Save any trailing list
    if current_list is not None and current_key:
        metadata[current_key] = current_list

    return metadata, body


def seed_defaults(
    source_dir: Path,
    target_dir: Path,
    filename: str,
) -> None:
    """Copy default directories from source to target if not present.

    Args:
        source_dir: Directory containing default subdirectories
        target_dir: Directory to seed into (e.g., ~/.stupidex/agents)
        filename: The markdown filename to look for (e.g., AGENT.md, SKILL.md)
    """
    target_dir.mkdir(parents=True, exist_ok=True)

    if not source_dir.is_dir():
        return

    for source_subdir in sorted(source_dir.iterdir()):
        if not source_subdir.is_dir():
            continue

        source_file = source_subdir / filename
        if not source_file.exists():
            continue

        target_subdir = target_dir / source_subdir.name
        target_file = target_subdir / filename

        if not target_file.exists():
            import shutil
            target_subdir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_file, target_file)


def directory_tree(path: str, max_depth: int, include_hidden: bool = False, _depth: int = 0, _prefix: str = "") -> str:
    if _depth >= max_depth:
        return ""

    lines = []
    try:
        entries = sorted(os.listdir(path))
    except PermissionError:
        return ""

    ignored = set(get_config().ignored_dirs)
    if not include_hidden:
        entries = [
            e for e in entries if e not in ignored and not e.startswith(".")]

    for i, entry in enumerate(entries):
        full_path = os.path.join(path, entry)
        is_last = i == len(entries) - 1
        connector = "└── " if is_last else "├── "
        child_prefix = "    " if is_last else "│   "

        if os.path.isdir(full_path):
            lines.append(f"{_prefix}{connector}{entry}/")
            lines.append(directory_tree(full_path, max_depth, include_hidden,
                         _depth + 1, _prefix + child_prefix))
        else:
            lines.append(f"{_prefix}{connector}{entry}")

    return "\n".join(line for line in lines if line)
