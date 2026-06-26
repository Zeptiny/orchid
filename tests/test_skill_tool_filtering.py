"""Tests for per-agent skill tool schema filtering.

The `skill` tool's `name` parameter description enumerates available skills via
`build_skill_tool(allowed_skills)`. `stream_response` rebuilds the `skill` Tool
entry per call so the LLM only sees skills the calling agent can load.
"""

import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from stupidex.config import Config
from stupidex.domain.message import Message, MessageRole, MessageType, Usage
from stupidex.domain.skill import Skill
from stupidex.domain.tool import Tool
from stupidex.llm import client as llm_client
from stupidex.tools import skill as skill_tools
from stupidex.tools.skill import build_list_skills_tool, build_skill_tool


def _skill(name: str) -> Skill:
    return Skill(
        name=name,
        description=f"skill {name}",
        location=f"/skills/{name}/SKILL.md",
        content=f"content-{name}",
    )


def _registry(*names: str) -> dict[str, Skill]:
    return {n: _skill(n) for n in names}


def _skill_description(tool: Tool) -> str:
    return tool.parameters.properties["name"].description


def _skill_listing(tool: Tool) -> str:
    """Return the text after 'Available skills:' — the per-skill listing."""
    return _skill_description(tool).split("Available skills:", 1)[1]


class BuildSkillToolFilterTest(unittest.TestCase):
    """build_skill_tool already honors the filter; these pin the contract."""

    def test_restricted_filter_lists_only_matching_skills(self):
        reg = _registry("work", "plan", "debug", "commit")
        with patch.object(skill_tools, "get_skill_registry", return_value=reg):
            tool = build_skill_tool(["work", "plan"])
        listing = _skill_listing(tool)
        self.assertIn("work", listing)
        self.assertIn("plan", listing)
        self.assertNotIn("debug", listing)
        self.assertNotIn("commit", listing)

    def test_glob_filter_matches_suffix(self):
        reg = _registry("correctness-reviewer", "security-reviewer", "work")
        with patch.object(skill_tools, "get_skill_registry", return_value=reg):
            tool = build_skill_tool(["*-reviewer"])
        listing = _skill_listing(tool)
        self.assertIn("correctness-reviewer", listing)
        self.assertIn("security-reviewer", listing)
        self.assertNotIn("work", listing)

    def test_star_filter_matches_unfiltered_description(self):
        reg = _registry("work", "plan", "debug")
        with patch.object(skill_tools, "get_skill_registry", return_value=reg):
            full = build_skill_tool(["*"])
            unfiltered = build_skill_tool(None)
        self.assertEqual(_skill_description(full), _skill_description(unfiltered))

    def test_empty_filter_produces_serializable_tool_with_no_skill_lines(self):
        reg = _registry("work", "plan")
        with patch.object(skill_tools, "get_skill_registry", return_value=reg):
            tool = build_skill_tool([])
        listing = _skill_listing(tool)
        self.assertEqual(listing.strip(), "")
        d = tool.to_dict()
        self.assertEqual(d["function"]["name"], "skill")
        self.assertIn("parameters", d["function"])


def _chunk(*, content="hi", usage=None):
    delta = SimpleNamespace(reasoning_content="", content=content, tool_calls=None)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)], usage=usage or Usage(1, 2, 3))


class StreamResponseSkillToolFilterTest(unittest.IsolatedAsyncioTestCase):
    """Verify stream_response overrides the skill tool entry per allowed_skills."""

    async def _drive(self, *, allowed_skills, allowed_tools=None):
        """Run stream_response with mocked deps; return captured tools kwarg."""
        cfg = Config()
        reg = _registry("work", "plan", "debug", "commit")

        captured: dict = {}

        async def fake_acompletion(**kwargs):
            captured.update(kwargs)

            async def _stream():
                yield _chunk()

            return _stream()

        acompletion_mock = AsyncMock(side_effect=fake_acompletion)
        dummy_dynamic = Message(MessageRole.SYSTEM, "<dynamic/>", MessageType.TEXT)

        with patch("stupidex.llm.client.get_config", return_value=cfg), \
                patch("stupidex.llm.client.build_dynamic_system_prompt",
                      new=AsyncMock(return_value=dummy_dynamic)), \
                patch("stupidex.tools.skill.get_skill_registry", return_value=reg), \
                patch("stupidex.llm.client.litellm.acompletion", new=acompletion_mock):

            skill_tool_entry = {"tool": build_skill_tool(), "executor": AsyncMock()}
            tool_registry_stub = {
                "skill": skill_tool_entry,
                "list_skills": {"tool": build_list_skills_tool(), "executor": AsyncMock()},
            }

            with patch("stupidex.llm.client.get_tool_registry", return_value=tool_registry_stub):
                gen = llm_client.stream_response(
                    messages=[],
                    model=None,
                    allowed_tools=allowed_tools if allowed_tools is not None else ["skill", "list_skills"],
                    system_prompt="",
                    allowed_skills=allowed_skills,
                )
                async for _ in gen:
                    pass

        return captured

    async def test_restricted_allowed_skills_advertises_only_matching(self):
        captured = await self._drive(allowed_skills=["work", "plan"])
        tools = captured["tools"]
        skill_entry = next(t for t in tools if t["function"]["name"] == "skill")
        desc = skill_entry["function"]["parameters"]["properties"]["name"]["description"]
        listing = desc.split("Available skills:", 1)[1]
        self.assertIn("work", listing)
        self.assertIn("plan", listing)
        self.assertNotIn("debug", listing)
        self.assertNotIn("commit", listing)

    async def test_star_allowed_skills_advertises_all(self):
        captured = await self._drive(allowed_skills=["*"])
        tools = captured["tools"]
        skill_entry = next(t for t in tools if t["function"]["name"] == "skill")
        desc = skill_entry["function"]["parameters"]["properties"]["name"]["description"]
        listing = desc.split("Available skills:", 1)[1]
        for name in ("work", "plan", "debug", "commit"):
            self.assertIn(name, listing)

    async def test_empty_allowed_skills_advertises_none(self):
        captured = await self._drive(allowed_skills=[])
        tools = captured["tools"]
        skill_entry = next(t for t in tools if t["function"]["name"] == "skill")
        desc = skill_entry["function"]["parameters"]["properties"]["name"]["description"]
        listing = desc.split("Available skills:", 1)[1]
        self.assertEqual(listing.strip(), "")

    async def test_none_allowed_skills_skips_override_uses_global_tool(self):
        captured = await self._drive(allowed_skills=None)
        tools = captured["tools"]
        skill_entry = next(t for t in tools if t["function"]["name"] == "skill")
        desc = skill_entry["function"]["parameters"]["properties"]["name"]["description"]
        listing = desc.split("Available skills:", 1)[1]
        for name in ("work", "plan", "debug", "commit"):
            self.assertIn(name, listing)

    async def test_skill_absent_from_allowed_tools_no_override(self):
        captured = await self._drive(
            allowed_skills=["work"],
            allowed_tools=["list_skills"],
        )
        tools = captured["tools"]
        names = [t["function"]["name"] for t in tools]
        self.assertNotIn("skill", names)
        self.assertIn("list_skills", names)


if __name__ == "__main__":
    unittest.main()
