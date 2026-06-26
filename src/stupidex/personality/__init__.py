import logging
import shutil
from pathlib import Path

from stupidex.config import HOME_CONFIG_DIR, get_config

log = logging.getLogger(__name__)

HOME_PERSONALITIES_DIR = HOME_CONFIG_DIR / "personalities"
DEFAULT_PERSONALITIES_DIR = Path(__file__).parent / "defaults"


class PersonalityRegistry:
    def __init__(self) -> None:
        self._personalities: dict[str, str] = {}

    def load(self) -> dict[str, str]:
        _seed_personalities_dir()
        self._personalities = {}

        if not HOME_PERSONALITIES_DIR.is_dir():
            return self._personalities

        for md_file in sorted(HOME_PERSONALITIES_DIR.glob("*.md")):
            name = md_file.stem
            try:
                content = md_file.read_text().strip()
                if content:
                    self._personalities[name] = content
            except OSError as e:
                log.warning("Skipping personality %s: %s", md_file, e)

        return self._personalities

    def get(self, name: str) -> str:
        if name not in self._personalities:
            raise ValueError(
                f"Unknown personality: '{name}'. "
                f"Available: {', '.join(sorted(self._personalities))}"
            )
        return self._personalities[name]

    def list_names(self) -> list[str]:
        return list(self._personalities.keys())

    @property
    def data(self) -> dict[str, str]:
        return self._personalities


_REGISTRY: PersonalityRegistry | None = None


def get_personality_registry() -> PersonalityRegistry:
    global _REGISTRY
    if _REGISTRY is None:
        _REGISTRY = PersonalityRegistry()
    return _REGISTRY


def _seed_personalities_dir() -> None:
    HOME_PERSONALITIES_DIR.mkdir(parents=True, exist_ok=True)

    if not DEFAULT_PERSONALITIES_DIR.is_dir():
        return

    for md_file in sorted(DEFAULT_PERSONALITIES_DIR.glob("*.md")):
        target = HOME_PERSONALITIES_DIR / md_file.name
        if not target.exists():
            shutil.copy2(md_file, target)


def load_personalities() -> dict[str, str]:
    registry = get_personality_registry()
    return registry.load()


def append_personality(agent_system_prompt: str) -> str:
    """Append the selected personality to the end of the agent's system prompt."""
    current = get_config().personality
    registry = get_personality_registry()
    try:
        personality_text = registry.get(current)
    except ValueError:
        return agent_system_prompt

    return f"{agent_system_prompt}\n\n## Personality\n\n{personality_text}\n"
