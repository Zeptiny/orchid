"""Tests for resolve_skill_dependencies (P1-16) and resource-read path traversal (P1-46)."""

import asyncio

import pytest

from stupidex.domain.skill import Skill, SkillResource
from stupidex.tools import skill as skill_tools
from stupidex.tools.skill import (
    _execute_resource_read,
    execute_list_skills,
    execute_skill,
    resolve_skill_dependencies,
    set_current_allowed_skills,
)


def _skill(name: str, requires: list[str] | None = None) -> Skill:
    return Skill(
        name=name,
        description=f"skill {name}",
        location=f"/skills/{name}/SKILL.md",
        content=f"content-{name}",
        requires=list(requires or []),
    )


def _registry(*skills: Skill) -> dict[str, Skill]:
    return {s.name: s for s in skills}


def test_diamond_resolves_without_false_positive():
    """Diamond A->B,C; B->D; C->D resolves without raising; D appears once."""
    registry = _registry(
        _skill("a", ["b", "c"]),
        _skill("b", ["d"]),
        _skill("c", ["d"]),
        _skill("d"),
    )
    result = resolve_skill_dependencies("a", registry, ["*"])
    names = [s.name for s in result]
    assert names.count("d") == 1
    assert "d" in names
    assert "b" in names
    assert "c" in names
    assert "a" in names
    # A must come last (dependents after dependencies).
    assert names.index("d") < names.index("b")
    assert names.index("d") < names.index("c")
    assert names.index("b") < names.index("a")
    assert names.index("c") < names.index("a")


def test_true_cycle_raises():
    """A->B->A raises ValueError."""
    registry = _registry(
        _skill("a", ["b"]),
        _skill("b", ["a"]),
    )
    with pytest.raises(ValueError, match="Circular dependency"):
        resolve_skill_dependencies("a", registry, ["*"])


def test_self_dependency_raises():
    """A->A raises ValueError."""
    registry = _registry(_skill("a", ["a"]))
    with pytest.raises(ValueError, match="Circular dependency"):
        resolve_skill_dependencies("a", registry, ["*"])


def test_linear_chain_resolves_deepest_first():
    """A->B->C->D resolves in dependency order (deepest first)."""
    registry = _registry(
        _skill("a", ["b"]),
        _skill("b", ["c"]),
        _skill("c", ["d"]),
        _skill("d"),
    )
    result = resolve_skill_dependencies("a", registry, ["*"])
    names = [s.name for s in result]
    assert names == ["d", "c", "b", "a"]


def test_sibling_sharing_no_false_positive():
    """A->B,C; B->D,E; C->E — E appears once, no false positive."""
    registry = _registry(
        _skill("a", ["b", "c"]),
        _skill("b", ["d", "e"]),
        _skill("c", ["e"]),
        _skill("d"),
        _skill("e"),
    )
    result = resolve_skill_dependencies("a", registry, ["*"])
    names = [s.name for s in result]
    assert names.count("e") == 1
    assert names.index("e") < names.index("b")
    assert names.index("e") < names.index("c")
    assert names[-1] == "a"


def _build_skill(tmp_path, name="my-skill", description="d"):
    skill_dir = tmp_path
    skill_file = skill_dir / "SKILL.md"
    skill_file.write_text(f"---\ndescription: {description}\n---\n\n# {name}\n")
    return Skill(
        name=name,
        description=description,
        location=str(skill_file),
        content=f"content-{name}",
    )


def _patch_registry(monkeypatch, registry, allowed=None):
    monkeypatch.setattr(skill_tools, "get_skill_registry", lambda: registry)
    set_current_allowed_skills(allowed)


class TestResourceReadPathTraversal:
    def _setup(self, tmp_path):
        skill = _build_skill(tmp_path)
        registry = {skill.name: skill}
        allowed_skills = [skill.name]
        return skill, registry, allowed_skills

    def test_happy_path_scripts_returns_content(self, tmp_path):
        skill, registry, allowed = self._setup(tmp_path)
        (tmp_path / "scripts").mkdir()
        (tmp_path / "scripts" / "run.sh").write_text("echo hello")
        result = asyncio.run(
            _execute_resource_read(f"{skill.name}/scripts/run.sh", registry, allowed)
        )
        assert "echo hello" in result.content
        assert "<skill_resource" in result.content

    def test_happy_path_references_returns_content(self, tmp_path):
        skill, registry, allowed = self._setup(tmp_path)
        (tmp_path / "references").mkdir()
        (tmp_path / "references" / "doc.md").write_text(
            "---\ndescription: d\n---\nbody text"
        )
        result = asyncio.run(
            _execute_resource_read(f"{skill.name}/references/doc.md", registry, allowed)
        )
        assert "body text" in result.content
        assert "description: d" not in result.content

    def test_happy_path_assets_returns_content(self, tmp_path):
        skill, registry, allowed = self._setup(tmp_path)
        (tmp_path / "assets").mkdir()
        (tmp_path / "assets" / "icon.txt").write_text("ICON")
        result = asyncio.run(
            _execute_resource_read(f"{skill.name}/assets/icon.txt", registry, allowed)
        )
        assert "ICON" in result.content

    def test_traversal_double_dot_rejected(self, tmp_path):
        skill, registry, allowed = self._setup(tmp_path)
        result = asyncio.run(
            _execute_resource_read(f"{skill.name}/../../etc/passwd", registry, allowed)
        )
        assert "Path traversal rejected" in result.display

    def test_traversal_to_sibling_skill_rejected(self, tmp_path):
        skill, registry, allowed = self._setup(tmp_path)
        result = asyncio.run(
            _execute_resource_read(
                f"{skill.name}/../sibling-skill/scripts/x", registry, allowed
            )
        )
        assert "Path traversal rejected" in result.display

    def test_allowlist_violation_scripts_dot_dot(self, tmp_path):
        skill, registry, allowed = self._setup(tmp_path)
        (tmp_path / "foo.txt").write_text("nope")
        result = asyncio.run(
            _execute_resource_read(
                f"{skill.name}/scripts/../foo.txt", registry, allowed
            )
        )
        assert "Resource not in allowed directory" in result.display

    def test_allowlist_violation_unknown_dir(self, tmp_path):
        skill, registry, allowed = self._setup(tmp_path)
        (tmp_path / "content").mkdir()
        (tmp_path / "content" / "secret").write_text("nope")
        result = asyncio.run(
            _execute_resource_read(f"{skill.name}/content/secret", registry, allowed)
        )
        assert "Resource not in allowed directory" in result.display

    def test_resource_file_not_found(self, tmp_path):
        skill, registry, allowed = self._setup(tmp_path)
        (tmp_path / "scripts").mkdir()
        result = asyncio.run(
            _execute_resource_read(
                f"{skill.name}/scripts/missing.sh", registry, allowed
            )
        )
        assert "Resource not found" in result.display

    def test_skill_not_in_registry_returns_unknown(self, tmp_path):
        skill, registry, allowed = self._setup(tmp_path)
        result = asyncio.run(
            _execute_resource_read("unknown-skill/scripts/x", registry, allowed)
        )
        assert "Unknown skill" in result.display

    def test_skill_not_in_allowed_skills_returns_not_available(self, tmp_path):
        skill, registry, _ = self._setup(tmp_path)
        result = asyncio.run(
            _execute_resource_read(f"{skill.name}/scripts/x", registry, ["other"])
        )
        assert "not available" in result.display

    def test_execute_skill_routes_resource_read(self, tmp_path, monkeypatch):
        skill, registry, _ = self._setup(tmp_path)
        _patch_registry(monkeypatch, registry, allowed=[skill.name])
        (tmp_path / "scripts").mkdir()
        (tmp_path / "scripts" / "run.sh").write_text("echo via-execute")
        result = asyncio.run(execute_skill(f"{skill.name}/scripts/run.sh"))
        assert "echo via-execute" in result.content


class TestExecuteListSkills:
    def test_empty_registry_returns_empty_skills_tag(self, tmp_path, monkeypatch):
        _patch_registry(monkeypatch, {}, allowed=None)
        result = asyncio.run(execute_list_skills())
        assert result.content == "<skills />"

    def test_populated_registry_emits_skill_elements(self, tmp_path, monkeypatch):
        skill = _build_skill(tmp_path, name="alpha", description="alpha desc")
        _patch_registry(monkeypatch, {skill.name: skill}, allowed=None)
        result = asyncio.run(execute_list_skills())
        assert result.content.startswith("<skills>")
        assert "<skill name=\"alpha\">" in result.content
        assert "alpha desc" in result.content

    def test_list_skills_includes_count_attributes(self, tmp_path, monkeypatch):
        skill = _build_skill(tmp_path, name="beta", description="beta desc")
        skill.references = [SkillResource(path="references/a.md", description="")]
        skill.scripts = [SkillResource(path="scripts/x.sh", description=""),
                         SkillResource(path="scripts/y.sh", description="")]
        skill.assets = []
        _patch_registry(monkeypatch, {skill.name: skill}, allowed=None)
        result = asyncio.run(execute_list_skills())
        assert 'references="1"' in result.content
        assert 'scripts="2"' in result.content
        assert 'assets="0"' in result.content

