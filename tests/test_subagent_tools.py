from __future__ import annotations

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from stupidex.domain.agent import Agent, AgentTypes, ModelTier
from stupidex.tools.subagent import (
    execute_delegate_to_subagent,
    execute_interrupt_subagents,
    execute_list_subagents,
    execute_wait_for_subagent,
)


def make_agent(tier: ModelTier = ModelTier.PAPUDO) -> Agent:
    return Agent(
        name="Subagent",
        type=AgentTypes.SUBAGENT,
        tier=tier,
        description="test agent",
        system_prompt="",
        allowed_tools=["read"],
        allowed_skills=[],
    )


def make_record(
    sid: str = "rec1",
    name: str = "sub1",
    type_: str = "subagent",
    state_value: str = "completed",
    task: str = "do thing",
    result: str | None = "ok",
    error: str | None = None,
    elapsed: float | None = 1.5,
) -> SimpleNamespace:
    return SimpleNamespace(
        id=sid,
        name=name,
        type=type_,
        state=SimpleNamespace(value=state_value),
        task=task,
        result=result,
        error=error,
        elapsed_seconds=elapsed,
    )


def patch_registry():
    return patch(
        "stupidex.tools.subagent.get_agent_registry",
        return_value={"Subagent": make_agent()},
    )


def patch_model():
    return patch("stupidex.tools.subagent.get_model_for_tier", return_value="model-x")


class DelegateToSubagentTests(unittest.TestCase):
    def test_unknown_agent_type_returns_error_with_available_agents(self):
        with patch_registry(), patch_model():
            result = asyncio.run(
                execute_delegate_to_subagent(name="n", task="t", type="Nope")
            )
        self.assertIn("Available agents:", result.content)
        self.assertIn("Subagent", result.content)

    def test_invalid_tier_returns_error(self):
        with patch_registry(), patch_model():
            result = asyncio.run(
                execute_delegate_to_subagent(name="n", task="t", type="Subagent", tier="invalid")
            )
        self.assertIn("is not valid", result.content)
        self.assertIn("Available tiers:", result.content)

    def test_tier_none_uses_agent_default(self):
        mock_manager = MagicMock()
        mock_manager.spawn = AsyncMock(return_value=SimpleNamespace(id="abc123"))
        with patch_registry(), patch_model(), \
                patch("stupidex.tools.subagent.get_subagent_manager", return_value=mock_manager):
            result = asyncio.run(
                execute_delegate_to_subagent(name="n", task="t", type="Subagent")
            )
        mock_manager.spawn.assert_called_once()
        called_kwargs = mock_manager.spawn.call_args
        self.assertEqual(called_kwargs.args[3], "model-x")
        self.assertIn("papudo", result.content)

    def test_happy_path_returns_subagent_xml(self):
        mock_manager = MagicMock()
        mock_manager.spawn = AsyncMock(return_value=SimpleNamespace(id="abc123"))
        with patch_registry(), patch_model(), \
                patch("stupidex.tools.subagent.get_subagent_manager", return_value=mock_manager):
            result = asyncio.run(
                execute_delegate_to_subagent(name="n", task="t", type="Subagent", tier="papudo")
            )
        self.assertIn("<subagent", result.content)
        self.assertIn("abc123", result.content)
        self.assertIn("<task>", result.content)

    def test_parent_chain_index_forwarded_from_contextvar(self):
        # The tool reads get_current_chain_index() and forwards it to spawn()
        # as parent_chain_index — the binding's sole production caller.
        mock_manager = MagicMock()
        mock_manager.spawn = AsyncMock(return_value=SimpleNamespace(id="abc123"))
        with patch_registry(), patch_model(), \
                patch("stupidex.tools.subagent.get_subagent_manager", return_value=mock_manager), \
                patch("stupidex.tools.subagent.get_current_chain_index", return_value=2):
            asyncio.run(
                execute_delegate_to_subagent(name="n", task="t", type="Subagent")
            )
        mock_manager.spawn.assert_called_once()
        kwargs = mock_manager.spawn.call_args.kwargs
        self.assertEqual(kwargs["parent_chain_index"], 2)


class WaitForSubagentTests(unittest.TestCase):
    def test_empty_list_returns_error(self):
        result = asyncio.run(execute_wait_for_subagent([]))
        self.assertIn("must be a non-empty list", result.content)

    def test_wait_returns_records_formatted(self):
        mock_manager = MagicMock()
        mock_manager.wait = AsyncMock(
            return_value={"id1": make_record(sid="id1", result="done output")}
        )
        with patch("stupidex.tools.subagent.get_subagent_manager", return_value=mock_manager):
            result = asyncio.run(execute_wait_for_subagent(["id1"]))
        self.assertIn("<subagents>", result.content)
        self.assertIn("<result>", result.content)
        self.assertIn("done output", result.content)

    def test_missing_ids_appear_in_not_found_block(self):
        mock_manager = MagicMock()
        mock_manager.wait = AsyncMock(
            return_value={"id1": make_record(sid="id1")}
        )
        with patch("stupidex.tools.subagent.get_subagent_manager", return_value=mock_manager):
            result = asyncio.run(execute_wait_for_subagent(["id1", "ghost"]))
        self.assertIn("<not_found>", result.content)
        self.assertIn("ghost", result.content)

    def test_all_missing_returns_no_subagents_message(self):
        mock_manager = MagicMock()
        mock_manager.wait = AsyncMock(return_value={})
        with patch("stupidex.tools.subagent.get_subagent_manager", return_value=mock_manager):
            result = asyncio.run(execute_wait_for_subagent(["a", "b"]))
        self.assertIn("No subagents found", result.content)


class ListSubagentsTests(unittest.TestCase):
    def test_empty_states_returns_empty_xml(self):
        mock_manager = MagicMock()
        mock_manager.get_states = MagicMock(return_value=[])
        with patch("stupidex.tools.subagent.get_subagent_manager", return_value=mock_manager):
            result = asyncio.run(execute_list_subagents())
        self.assertEqual(result.content, "<subagents />")

    def test_populated_states_returns_subagent_elements(self):
        mock_manager = MagicMock()
        mock_manager.get_states = MagicMock(
            return_value=[
                {
                    "id": "s1",
                    "name": "sub1",
                    "type": "subagent",
                    "task": "",
                    "state": "completed",
                    "elapsed": 1.0,
                }
            ]
        )
        with patch("stupidex.tools.subagent.get_subagent_manager", return_value=mock_manager):
            result = asyncio.run(execute_list_subagents())
        self.assertIn("<subagents>", result.content)
        self.assertIn("<subagent", result.content)
        self.assertIn("s1", result.content)

    def test_subagent_with_task_includes_task_block(self):
        mock_manager = MagicMock()
        mock_manager.get_states = MagicMock(
            return_value=[
                {
                    "id": "s1",
                    "name": "sub1",
                    "type": "subagent",
                    "task": "explore the module",
                    "state": "running",
                    "elapsed": 2.0,
                }
            ]
        )
        with patch("stupidex.tools.subagent.get_subagent_manager", return_value=mock_manager):
            result = asyncio.run(execute_list_subagents())
        self.assertIn("<task>", result.content)
        self.assertIn("explore the module", result.content)


class InterruptSubagentsTests(unittest.TestCase):
    def test_empty_list_calls_cancel_running(self):
        mock_manager = MagicMock()
        mock_manager.cancel_running = MagicMock(return_value=["id1", "id2"])
        mock_manager.flush_state_callbacks = AsyncMock()
        with patch("stupidex.tools.subagent.get_subagent_manager", return_value=mock_manager):
            result = asyncio.run(execute_interrupt_subagents([]))
        mock_manager.cancel_running.assert_called_once()
        self.assertIn("id1", result.content)
        self.assertIn("id2", result.content)

    def test_empty_list_no_running_returns_message(self):
        mock_manager = MagicMock()
        mock_manager.cancel_running = MagicMock(return_value=[])
        mock_manager.flush_state_callbacks = AsyncMock()
        with patch("stupidex.tools.subagent.get_subagent_manager", return_value=mock_manager):
            result = asyncio.run(execute_interrupt_subagents([]))
        self.assertIn("No running subagents found", result.content)

    def test_per_id_mixed_results_three_buckets(self):
        running_record = SimpleNamespace(async_task=SimpleNamespace(done=lambda: False))
        done_record = SimpleNamespace(async_task=SimpleNamespace(done=lambda: True))

        def get_record(sid):
            if sid == "run1":
                return running_record
            if sid == "done1":
                return done_record
            return None

        mock_manager = MagicMock()
        mock_manager.get_record = MagicMock(side_effect=get_record)
        mock_manager.cancel_one = MagicMock(return_value=True)
        mock_manager.flush_state_callbacks = AsyncMock()

        with patch("stupidex.tools.subagent.get_subagent_manager", return_value=mock_manager):
            result = asyncio.run(
                execute_interrupt_subagents(["run1", "done1", "ghost1"])
            )

        self.assertIn("Interrupted: run1", result.content)
        self.assertIn("Already finished: done1", result.content)
        self.assertIn("Not found: ghost1", result.content)
        mock_manager.cancel_one.assert_called_once_with("run1")

    def test_all_not_found_returns_not_found_bucket(self):
        mock_manager = MagicMock()
        mock_manager.get_record = MagicMock(return_value=None)
        mock_manager.flush_state_callbacks = AsyncMock()
        with patch("stupidex.tools.subagent.get_subagent_manager", return_value=mock_manager):
            result = asyncio.run(
                execute_interrupt_subagents(["a", "b"])
            )
        self.assertIn("Not found: a, b.", result.content)
        self.assertEqual("No subagents interrupted", result.display)


if __name__ == "__main__":
    unittest.main()
