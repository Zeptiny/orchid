import logging
from pathlib import Path

from stupidex.config import HOME_SKILLS_DIR, PROJECT_SKILLS_DIR
from stupidex.domain.skill import Skill, SkillResource
from stupidex.utils import parse_frontmatter, seed_defaults

log = logging.getLogger(__name__)

SKILL_REGISTRY: dict[str, Skill] = {}

_RESOURCE_DIRS = ("scripts", "references", "assets")


def _scan_resource_dir(skill_dir: Path, dirname: str) -> list[SkillResource]:
    """Scan a resource directory for files and extract frontmatter descriptions."""
    dir_path = skill_dir / dirname
    if not dir_path.is_dir():
        return []

    resources: list[SkillResource] = []
    for file_path in sorted(dir_path.rglob("*")):
        if not file_path.is_file():
            continue

        rel_path = f"{dirname}/{file_path.relative_to(dir_path)}"
        description = ""

        if file_path.suffix in (".md", ".txt", ".sh", ".py", ".rb", ".js", ".ts", ".yaml", ".yml", ".json", ".toml", ".cfg", ".ini", ".bash", ".zsh", ".fish"):
            try:
                text = file_path.read_text()
                metadata, _ = parse_frontmatter(text)
                description = metadata.get("description", "")
            except (OSError, UnicodeDecodeError):
                pass

        resources.append(SkillResource(path=rel_path, description=description))

    return resources


def _load_skills_from_dir(skills_dir: Path) -> dict[str, Skill]:
    skills: dict[str, Skill] = {}
    if not skills_dir.is_dir():
        return skills

    for path in sorted(skills_dir.iterdir()):
        if not path.is_dir():
            continue

        skill_file = path / "SKILL.md"
        if not skill_file.exists():
            continue

        try:
            content = skill_file.read_text()
        except OSError as e:
            log.warning("Skipping %s: %s", skill_file, e)
            continue

        metadata, body = parse_frontmatter(content)

        name = metadata.get("name", path.name)
        description = metadata.get("description", "")

        if not description:
            log.warning("Skipping %s: no description in frontmatter", skill_file)
            continue

        requires_raw = metadata.get("requires", [])
        if isinstance(requires_raw, list):
            requires = requires_raw
        else:
            if requires_raw:
                log.warning("%s: 'requires' must be a list, got %s — ignoring", skill_file, type(requires_raw).__name__)
            requires = []

        scripts = _scan_resource_dir(path, "scripts")
        references = _scan_resource_dir(path, "references")
        assets = _scan_resource_dir(path, "assets")

        skill = Skill(
            name=name,
            description=description,
            location=str(skill_file),
            content=body.strip(),
            requires=requires,
            scripts=scripts,
            references=references,
            assets=assets,
        )

        error = skill.validate()
        if error:
            log.warning("Skipping %s: %s", skill_file, error)
            continue

        skills[name] = skill

    return skills


def seed_skills_dir(skills_dir: Path) -> None:
    source_dir = Path(__file__).parent / "defaults"
    seed_defaults(source_dir, skills_dir, "SKILL.md")


def load_skills() -> dict[str, Skill]:
    global SKILL_REGISTRY

    home_skills = _load_skills_from_dir(HOME_SKILLS_DIR)

    project_skills_dir = Path.cwd() / PROJECT_SKILLS_DIR
    project_skills = _load_skills_from_dir(project_skills_dir)

    merged = {**home_skills, **project_skills}
    SKILL_REGISTRY = merged

    from stupidex.tools import reset_tool_registry
    reset_tool_registry()

    return merged


def get_skill_registry() -> dict[str, Skill]:
    if not SKILL_REGISTRY:
        return load_skills()
    return SKILL_REGISTRY
