from contextvars import ContextVar
from fnmatch import fnmatch
from xml.sax.saxutils import escape

from stupidex.domain.skill import Skill
from stupidex.domain.tool import ExecutorResult, Tool, ToolParameter, ToolParameterProperties
from stupidex.skills import get_skill_registry

_current_allowed_skills: ContextVar[list[str] | None] = ContextVar("_current_allowed_skills", default=None)


def set_current_allowed_skills(allowed: list[str] | None) -> None:
    _current_allowed_skills.set(allowed)


def get_current_allowed_skills() -> list[str] | None:
    return _current_allowed_skills.get()


def filter_skills(allowed: list[str], registry: dict[str, Skill]) -> dict[str, Skill]:
    """Filter skills by glob patterns from agent's allowed_skills."""
    if not allowed:
        return {}
    return {
        name: skill
        for name, skill in registry.items()
        if any(fnmatch(name, pattern) for pattern in allowed)
    }


def resolve_skill_dependencies(
    name: str,
    registry: dict[str, Skill],
    allowed: list[str],
    _stack: set[str] | None = None,
    _resolved: set[str] | None = None,
) -> list[Skill]:
    """Resolve skill dependencies depth-first. Returns ordered list (deepest first)."""
    if _stack is None:
        _stack = set()
    if _resolved is None:
        _resolved = set()

    if name in _stack:
        raise ValueError(f"Circular dependency detected involving '{name}'")
    if name in _resolved:
        return []

    if name not in registry:
        raise ValueError(f"Skill '{name}' not found")

    skill = registry[name]
    _stack.add(name)
    result: list[Skill] = []

    for dep_name in skill.requires:
        if dep_name not in registry:
            raise ValueError(f"Skill '{name}' requires '{dep_name}' which does not exist")
        if not any(fnmatch(dep_name, p) for p in allowed):
            raise ValueError(f"Skill '{name}' requires '{dep_name}' which is not available for this agent")
        dep_skills = resolve_skill_dependencies(dep_name, registry, allowed, _stack, _resolved)
        result.extend(dep_skills)

    _stack.discard(name)
    _resolved.add(name)
    result.append(skill)
    return result


def _format_resource_listing(skill: Skill) -> str:
    """Format resource listing for skill load output."""
    sections: list[str] = []

    for attr, label in [("references", "references"), ("scripts", "scripts"), ("assets", "assets")]:
        resources = getattr(skill, attr)
        if not resources:
            continue
        lines = []
        for r in resources:
            if r.description:
                lines.append(f"- {r.path} — {r.description}")
            else:
                lines.append(f"- {r.path}")
        sections.append(f"<{label}>\n" + "\n".join(lines) + f"\n</{label}>")

    if not sections:
        return ""
    return "<skill_resources>\n" + "\n".join(sections) + "\n</skill_resources>"


def build_skill_tool(allowed_skills: list[str] | None = None) -> Tool:
    registry = get_skill_registry()
    filtered = filter_skills(allowed_skills, registry) if allowed_skills is not None else registry
    skill_lines = "\n".join(
        f"- {name}: {skill.description}"
        for name, skill in filtered.items()
    )
    return Tool(
        name="skill",
        description=(
            "Load a specialized skill when the task at hand matches one of the skills listed in the system prompt. "
            "Use this tool to inject the skill's instructions and resources into current conversation. "
            "The output may contain detailed workflow guidance as well as references to scripts, files, etc in the same directory as the skill. "
            "You can also read a resource file by passing skill_name/path (e.g. 'work/references/api-errors.md')."
        ),
        parameters=ToolParameter(
            properties={
                "name": ToolParameterProperties(
                    type="string",
                    description=(
                        "The name of the skill to load, or skill_name/path to read a resource file "
                        f"(e.g. 'work' loads the skill, 'work/references/api-errors.md' reads that file). "
                        f"Available skills:\n{skill_lines}"
                    )
                ),
            },
            required=["name"]
        ),
        action_label="Loading skill...",
    )


async def execute_skill(name: str) -> ExecutorResult:
    registry = get_skill_registry()
    allowed_skills = get_current_allowed_skills()

    # Check if this is a resource file read request (skill_name/resource_path)
    if "/" in name:
        return await _execute_resource_read(name, registry, allowed_skills)

    filtered = filter_skills(allowed_skills, registry) if allowed_skills is not None else registry

    if name not in filtered:
        if name in registry:
            return ExecutorResult(
                display=f"Skill '{name}' not available",
                content=f"Error: skill '{name}' is not available for this agent.",
            )
        available = ", ".join(filtered.keys())
        return ExecutorResult(
            display=f"Unknown skill: {name}",
            content=f"Error: skill '{name}' does not exist. Available skills: {available}",
        )

    # Resolve dependencies
    try:
        skills_to_inject = resolve_skill_dependencies(name, registry, allowed_skills or ["*"])
    except ValueError as e:
        return ExecutorResult(display="Dependency error", content=f"Error: {e}")

    e = escape
    parts: list[str] = []

    for skill in skills_to_inject:
        skill_content = skill.content if skill.content else f"Skill '{skill.name}' loaded (no content file found)"
        parts.append(
            f'<skill_content name="{e(skill.name)}">\n'
            f'{e(skill_content)}\n'
            f'</skill_content>'
        )

        resource_listing = _format_resource_listing(skill)
        if resource_listing:
            parts.append(resource_listing)

    content = "\n".join(parts)

    return ExecutorResult(
        display=f"Skill '{name}' loaded",
        content=content,
    )


async def _execute_resource_read(
    name: str,
    registry: dict[str, Skill],
    allowed_skills: list[str] | None,
) -> ExecutorResult:
    """Handle skill_name/resource_path reads."""
    skill_name, resource_path = name.split("/", 1)

    filtered = filter_skills(allowed_skills, registry) if allowed_skills is not None else registry

    if skill_name not in filtered:
        if skill_name in registry:
            return ExecutorResult(
                display=f"Skill '{skill_name}' not available",
                content=f"Error: skill '{skill_name}' is not available for this agent.",
            )
        return ExecutorResult(
            display=f"Unknown skill: {skill_name}",
            content=f"Error: skill '{skill_name}' does not exist.",
        )

    skill = registry[skill_name]
    from pathlib import Path

    skill_dir = Path(skill.location).parent
    resolved = (skill_dir / resource_path).resolve()

    # Path traversal check
    if not resolved.is_relative_to(skill_dir.resolve()):
        return ExecutorResult(
            display="Path traversal rejected",
            content="Error: resource path is outside the skill directory.",
        )

    # Must be within a known resource directory
    if not any(resolved.is_relative_to((skill_dir / d).resolve()) for d in ("scripts", "references", "assets")):
        return ExecutorResult(
            display="Resource not in allowed directory",
            content="Error: resource must be in scripts/, references/, or assets/ directory.",
        )

    if not resolved.is_file():
        return ExecutorResult(
            display="Resource not found",
            content=f"Error: resource file '{resource_path}' not found in skill '{skill_name}'.",
        )

    try:
        file_content = resolved.read_text()
    except OSError as e:
        return ExecutorResult(display="Read error", content=f"Error reading resource: {e}")

    # Strip frontmatter from .md files
    if resolved.suffix == ".md":
        from stupidex.utils import parse_frontmatter
        _, body = parse_frontmatter(file_content)
        file_content = body.strip()

    e = escape
    content = (
        f'<skill_resource skill="{e(skill_name)}" path="{e(resource_path)}">\n'
        f'{e(file_content)}\n'
        f'</skill_resource>'
    )

    return ExecutorResult(
        display=f"Resource '{resource_path}' from '{skill_name}'",
        content=content,
    )


def build_list_skills_tool(allowed_skills: list[str] | None = None) -> Tool:
    return Tool(
        name="list_skills",
        description="List all available skills with their descriptions. Use to discover what skills are available before loading one.",
        parameters=ToolParameter(properties={}, required=[]),
        action_label="Listing skills...",
    )


async def execute_list_skills() -> ExecutorResult:
    registry = get_skill_registry()
    allowed_skills = get_current_allowed_skills()

    filtered = filter_skills(allowed_skills, registry) if allowed_skills is not None else registry

    if not filtered:
        return ExecutorResult(display="No skills available", content="<skills />")

    e = escape
    parts = []
    for name, skill in filtered.items():
        ref_count = len(skill.references)
        script_count = len(skill.scripts)
        asset_count = len(skill.assets)
        resource_hint = f'<resources references="{ref_count}" scripts="{script_count}" assets="{asset_count}" />'
        parts.append(f'<skill name="{e(name)}">\n{e(skill.description)}\n{resource_hint}\n</skill>')

    content = "<skills>\n" + "\n".join(parts) + "\n</skills>"

    return ExecutorResult(
        display=f"{len(filtered)} skill(s) available",
        content=content,
    )
