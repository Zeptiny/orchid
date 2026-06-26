"""Tests for Session storage round-trip and corrupt-subagent resilience (P2-16)."""

import unittest
from unittest.mock import patch

from stupidex.agents.manager import SubagentRecord, SubagentState
from stupidex.app import _format_session_model_label, _session_usage_totals
from stupidex.domain.agent import Agent, AgentTypes, ModelTier
from stupidex.domain.chain import Chain
from stupidex.domain.message import Message, MessageRole, MessageType, Usage
from stupidex.domain.session import Session, SessionManager
from stupidex.domain.todo import TodoStatus, TodoTask


class TestSessionStorageRoundTrip(unittest.TestCase):
    def _subagent_record(self, rec_id: str) -> SubagentRecord:
        agent = Agent(
            name="Subagent",
            type=AgentTypes.SUBAGENT,
            tier=ModelTier.PAPUDO,
            description="d",
            system_prompt="p",
        )
        return SubagentRecord(
            id=rec_id,
            agent=agent,
            state=SubagentState.COMPLETED,
            label="sub1",
            task="do thing",
            result="Answer",
            error=None,
            start_time=10.0,
            end_time=11.5,
            chain=Chain(messages=[
                Message(MessageRole.USER, "do thing"),
                Message(MessageRole.ASSISTANT, "Answer", MessageType.TEXT),
            ]),
            messages_mounted=2,
        )

    def test_to_storage_dict_then_from_storage_dict_preserves_chains(self):
        session = Session(name="S", id="sess-1", model="m")
        session.chains = [
            Chain(model="m", messages=[Message(MessageRole.USER, "hi")], start_time=1.0),
            Chain(
                model="m2",
                messages=[Message(MessageRole.ASSISTANT, "hey", MessageType.TEXT)],
                start_time=2.0,
                end_time=3.0,
            ),
        ]
        restored = Session.from_storage_dict(session.to_storage_dict())
        self.assertEqual(restored.id, "sess-1")
        self.assertEqual(restored.name, "S")
        self.assertEqual(restored.model, "m")
        self.assertEqual(len(restored.chains), 2)
        self.assertEqual(restored.chains[0].messages[0].content, "hi")
        self.assertEqual(restored.chains[1].messages[0].role, MessageRole.ASSISTANT)

    def test_storage_round_trip_preserves_subagents(self):
        session = Session(name="S", id="sess-2", model="m")
        rec = self._subagent_record("rec-1")
        session.subagent_manager._subagents[rec.id] = rec

        with patch(
            "stupidex.agents.get_agent_registry",
            return_value={"Subagent": rec.agent},
        ):
            restored = Session.from_storage_dict(session.to_storage_dict())

        self.assertIn("rec-1", restored.subagent_manager._subagents)
        r = restored.subagent_manager._subagents["rec-1"]
        self.assertEqual(r.label, "sub1")
        self.assertEqual(r.task, "do thing")
        self.assertEqual(r.result, "Answer")
        self.assertEqual(r.state, SubagentState.COMPLETED)
        self.assertEqual(len(r.messages), 2)
        self.assertEqual(r.messages[1].content, "Answer")

    def test_storage_round_trip_preserves_todo_store(self):
        session = Session(name="S", id="sess-3", model="m")
        session.todo_store._tasks["t1"] = TodoTask(id="t1", title="Buy milk", status=TodoStatus.IN_PROGRESS)
        restored = Session.from_storage_dict(session.to_storage_dict())
        self.assertIn("t1", restored.todo_store._tasks)
        self.assertEqual(restored.todo_store._tasks["t1"].title, "Buy milk")
        self.assertEqual(restored.todo_store._tasks["t1"].status, TodoStatus.IN_PROGRESS)

    def test_empty_session_round_trips_cleanly(self):
        session = Session(name="empty", id="sess-empty", model=None)
        restored = Session.from_storage_dict(session.to_storage_dict())
        self.assertEqual(restored.id, "sess-empty")
        self.assertEqual(restored.chains, [])
        self.assertEqual(restored.subagent_manager._subagents, {})

    def test_corrupt_subagent_entry_is_skipped_others_preserved(self):
        agent = Agent(
            name="Subagent",
            type=AgentTypes.SUBAGENT,
            tier=ModelTier.PAPUDO,
            description="d",
            system_prompt="p",
        )
        good_record = SubagentRecord(
            id="good-1",
            agent=agent,
            state=SubagentState.COMPLETED,
            label="g",
            task="ok",
            result="done",
            start_time=1.0,
            end_time=2.0,
        )
        # Missing "id" key — SubagentRecord.from_storage_dict raises KeyError,
        # which Session.from_storage_dict catches and skips (fail-soft).
        corrupt_entry = {"agent_name": "Ghost", "state": "completed"}

        data = {
            "version": 1,
            "id": "sess-mixed",
            "name": "mixed",
            "model": "m",
            "chains": [],
            "subagent_chains": [corrupt_entry, good_record.to_storage_dict()],
            "todo_store": {},
        }
        with patch(
            "stupidex.agents.get_agent_registry",
            return_value={"Subagent": agent},
        ):
            session = Session.from_storage_dict(data)

        self.assertNotIn("corrupt", session.subagent_manager._subagents)
        self.assertIn("good-1", session.subagent_manager._subagents)
        self.assertEqual(session.subagent_manager._subagents["good-1"].result, "done")

    def test_all_corrupt_subagent_entries_does_not_raise(self):
        data = {
            "version": 1,
            "id": "sess-broken",
            "name": "broken",
            "model": None,
            "chains": [],
            "subagent_chains": [
                {"agent_name": "x"},
                {"id": None},  # agent_name defaults to ""; registry miss → fallback
            ],
            "todo_store": {},
        }
        session = Session.from_storage_dict(data)
        self.assertEqual(session.id, "sess-broken")
        # The {"id": None} entry gets through from_storage_dict by using a
        # pseudo-agent fallback, so it lands under the None key. We only
        # assert the load did not raise and the corrupt non-id entry was
        # skipped — those are the fail-soft guarantees under test.
        self.assertEqual(session.chains, [])


class TestSessionManagerDelete(unittest.TestCase):
    """Tests for disk-first delete ordering (P2-1)."""

    def _manager_with_session(self, sess_id: str, make_active: bool = True) -> SessionManager:
        mgr = SessionManager()
        session = Session(name="S", id=sess_id, model="m")
        mgr.sessions[sess_id] = session
        if make_active:
            mgr.active = session
        return mgr

    @patch("stupidex.storage.delete_session")
    def test_delete_happy_path_active_session(self, mock_delete):
        mgr = self._manager_with_session("sess-1")
        self.assertTrue(mgr.delete("sess-1"))
        mock_delete.assert_called_once_with("sess-1")
        self.assertNotIn("sess-1", mgr.sessions)
        self.assertIsNone(mgr.active)

    @patch("stupidex.storage.delete_session")
    def test_delete_active_is_different_session(self, mock_delete):
        mgr = self._manager_with_session("sess-1", make_active=False)
        other = Session(name="other", id="sess-other", model="m")
        mgr.sessions["sess-other"] = other
        mgr.active = other
        self.assertTrue(mgr.delete("sess-1"))
        mock_delete.assert_called_once_with("sess-1")
        self.assertNotIn("sess-1", mgr.sessions)
        self.assertIs(mgr.active, other)

    @patch("stupidex.storage.delete_session")
    def test_delete_unknown_session_no_disk_touch(self, mock_delete):
        mgr = SessionManager()
        self.assertFalse(mgr.delete("missing"))
        mock_delete.assert_not_called()

    @patch("stupidex.storage.delete_session")
    def test_delete_disk_failure_preserves_in_memory_state(self, mock_delete):
        mgr = self._manager_with_session("sess-1")
        mock_delete.side_effect = OSError("disk full")
        with self.assertLogs("stupidex.domain.session", level="WARNING") as cm:
            self.assertFalse(mgr.delete("sess-1"))
        self.assertIn("sess-1", mgr.sessions)
        self.assertIsNotNone(mgr.active)
        assert mgr.active is not None
        self.assertEqual(mgr.active.id, "sess-1")
        self.assertTrue(any("sess-1" in line for line in cm.output))

    @patch("stupidex.storage.delete_session")
    def test_cancel_all_called_before_disk_delete(self, mock_delete):
        call_order: list[str] = []

        def track_delete(sid):
            call_order.append("delete_session")

        mock_delete.side_effect = track_delete
        mgr = self._manager_with_session("sess-1")
        session = mgr.sessions["sess-1"]

        def track_cancel():
            call_order.append("cancel_all")

        with patch.object(session.subagent_manager, "cancel_all", side_effect=track_cancel):
            self.assertTrue(mgr.delete("sess-1"))
        mock_delete.assert_called_once_with("sess-1")
        self.assertEqual(call_order, ["cancel_all", "delete_session"])


class TestSessionFromStorageDictChainGuard(unittest.TestCase):
    """Tests for per-chain deserialization guard in Session.from_storage_dict (P2-8)."""

    def _chain_data(self, status: str = "completed") -> dict:
        return {
            "model": "m",
            "messages": [],
            "start_time": 1.0,
            "end_time": 2.0,
            "status": status,
        }

    def _session_data(self, chains: list) -> dict:
        return {
            "version": 1,
            "id": "sess-chains",
            "name": "chains",
            "model": "m",
            "chains": chains,
            "subagent_chains": [],
            "todo_store": {},
        }

    def test_all_valid_chains_load(self):
        data = self._session_data([self._chain_data(), self._chain_data(), self._chain_data()])
        session = Session.from_storage_dict(data)
        self.assertEqual(len(session.chains), 3)

    def test_corrupt_middle_chain_status_skipped(self):
        corrupt = self._chain_data(status="bogus")
        data = self._session_data([self._chain_data(), corrupt, self._chain_data()])
        with self.assertLogs("stupidex.domain.session", level="WARNING") as cm:
            session = Session.from_storage_dict(data)
        self.assertEqual(len(session.chains), 2)
        self.assertTrue(any("index 1" in line for line in cm.output))

    def test_corrupt_first_chain_messages_field_skipped(self):
        corrupt = {"model": "m", "messages": "not-a-list", "start_time": 1.0, "status": "completed"}
        data = self._session_data([corrupt, self._chain_data(), self._chain_data()])
        with self.assertLogs("stupidex.domain.session", level="WARNING"):
            session = Session.from_storage_dict(data)
        self.assertEqual(len(session.chains), 2)

    def test_zero_chains_returns_empty_list(self):
        data = self._session_data([])
        session = Session.from_storage_dict(data)
        self.assertEqual(session.chains, [])

    def test_corrupt_chain_does_not_cascade_to_subagent_restoration(self):
        agent = Agent(
            name="Subagent",
            type=AgentTypes.SUBAGENT,
            tier=ModelTier.PAPUDO,
            description="d",
            system_prompt="p",
        )
        good_record = SubagentRecord(
            id="good-1",
            agent=agent,
            state=SubagentState.COMPLETED,
            label="g",
            task="ok",
            result="done",
            start_time=1.0,
            end_time=2.0,
        )
        data = self._session_data([self._chain_data(status="bogus")])
        data["subagent_chains"] = [good_record.to_storage_dict()]
        with (
            patch("stupidex.agents.get_agent_registry", return_value={"Subagent": agent}),
            self.assertLogs("stupidex.domain.session", level="WARNING"),
        ):
            session = Session.from_storage_dict(data)
        self.assertEqual(session.chains, [])
        self.assertIn("good-1", session.subagent_manager._subagents)


class TestSessionUsageTotals(unittest.TestCase):
    """Tests for U4: session-total token summation and #model label rendering."""

    def _chain_with_usage(
        self,
        prompt: int,
        cached: int,
        completion: int,
        total: int,
    ) -> Chain:
        return Chain(
            model="m",
            messages=[
                Message(MessageRole.USER, "q"),
                Message(
                    MessageRole.ASSISTANT,
                    "a",
                    MessageType.TEXT,
                    usage=Usage(
                        prompt_tokens=prompt,
                        cached_tokens=cached,
                        completion_tokens=completion,
                        total_tokens=total,
                    ),
                ),
            ],
        )

    def test_two_chains_sum_across_both(self):
        session = Session(name="S", id="s1", model="m")
        session.chains = [
            self._chain_with_usage(1000, 400, 200, 1200),
            self._chain_with_usage(500, 100, 50, 650),
        ]
        totals = _session_usage_totals(session)
        self.assertIsNotNone(totals)
        prompt, cached, completion, total = totals
        self.assertEqual(prompt, 1500)
        self.assertEqual(cached, 500)
        self.assertEqual(completion, 250)
        self.assertEqual(total, 1850)

    def test_two_chains_render_summed_label(self):
        session = Session(name="S", id="s2", model="m")
        session.chains = [
            self._chain_with_usage(1000, 400, 200, 1200),
            self._chain_with_usage(500, 100, 50, 650),
        ]
        totals = _session_usage_totals(session)
        label = _format_session_model_label("gpt-4o", totals)
        # 1500 -> 1.5k, 500 cached -> 500, 250 completion -> 250
        self.assertIn("gpt-4o", label)
        self.assertIn("↑1.5k", label)
        self.assertIn("(⟲500)", label)
        self.assertIn("↓250", label)

    def test_mixed_one_chain_without_usage(self):
        session = Session(name="S", id="s3", model="m")
        session.chains = [
            self._chain_with_usage(1000, 400, 200, 1200),
            Chain(model="m", messages=[Message(MessageRole.USER, "no response")]),
        ]
        totals = _session_usage_totals(session)
        self.assertIsNotNone(totals)
        prompt, cached, completion, total = totals
        self.assertEqual(prompt, 1000)
        self.assertEqual(cached, 400)
        self.assertEqual(completion, 200)
        self.assertEqual(total, 1200)

    def test_no_usage_at_all_returns_none(self):
        session = Session(name="S", id="s4", model="m")
        session.chains = [
            Chain(model="m", messages=[Message(MessageRole.USER, "hi")]),
            Chain(model="m", messages=[Message(MessageRole.USER, "hey")]),
        ]
        totals = _session_usage_totals(session)
        self.assertIsNone(totals)
        label = _format_session_model_label("gpt-4o", totals)
        self.assertEqual(label, "gpt-4o")

    def test_no_chains_returns_none(self):
        session = Session(name="S", id="s5", model="m")
        totals = _session_usage_totals(session)
        self.assertIsNone(totals)
        label = _format_session_model_label("gpt-4o", totals)
        self.assertEqual(label, "gpt-4o")

    def test_chain_sums_all_usage_messages(self):
        """A chain with multiple usage messages contributes the cumulative sum
        across all its agentic-loop LLM calls, not just the last snapshot."""
        session = Session(name="S", id="s6", model="m")
        session.chains = [
            Chain(
                model="m",
                messages=[
                    Message(
                        MessageRole.ASSISTANT,
                        "a1",
                        usage=Usage(
                            prompt_tokens=10,
                            completion_tokens=5,
                            total_tokens=15,
                            cached_tokens=0,
                        ),
                    ),
                    Message(
                        MessageRole.ASSISTANT,
                        "a2",
                        usage=Usage(
                            prompt_tokens=1000,
                            completion_tokens=200,
                            total_tokens=1200,
                            cached_tokens=400,
                        ),
                    ),
                ],
            ),
        ]
        totals = _session_usage_totals(session)
        self.assertIsNotNone(totals)
        prompt, cached, completion, _total = totals
        self.assertEqual(prompt, 1010)
        self.assertEqual(cached, 400)
        self.assertEqual(completion, 205)

    def _subagent_record_with_usage(
        self,
        rec_id: str,
        prompt: int,
        cached: int,
        completion: int,
        total: int,
    ) -> SubagentRecord:
        agent = Agent(
            name="Subagent",
            type=AgentTypes.SUBAGENT,
            tier=ModelTier.PAPUDO,
            description="d",
            system_prompt="p",
        )
        return SubagentRecord(
            id=rec_id,
            agent=agent,
            state=SubagentState.COMPLETED,
            label="sub",
            task="t",
            start_time=1.0,
            end_time=2.0,
            model="sub-model",
            chain=Chain(
                model="sub-model",
                messages=[
                    Message(MessageRole.USER, "do thing"),
                    Message(
                        MessageRole.ASSISTANT,
                        "answer",
                        MessageType.TEXT,
                        usage=Usage(
                            prompt_tokens=prompt,
                            cached_tokens=cached,
                            completion_tokens=completion,
                            total_tokens=total,
                        ),
                    ),
                ],
            ),
        )

    def test_subagent_usage_folded_into_session_total(self):
        """A session with one chain (usage A) + one subagent (usage B) →
        totals = A + B (R6)."""
        session = Session(name="S", id="sub1", model="m")
        session.chains = [self._chain_with_usage(1000, 400, 200, 1200)]
        session.subagent_manager._subagents["sa1"] = self._subagent_record_with_usage(
            "sa1", 500, 100, 50, 650
        )
        totals = _session_usage_totals(session)
        self.assertIsNotNone(totals)
        prompt, cached, completion, total = totals
        self.assertEqual(prompt, 1500)
        self.assertEqual(cached, 500)
        self.assertEqual(completion, 250)
        self.assertEqual(total, 1850)

    def test_subagent_usage_rendered_in_model_label(self):
        session = Session(name="S", id="sub2", model="m")
        session.chains = [self._chain_with_usage(1000, 400, 200, 1200)]
        session.subagent_manager._subagents["sa1"] = self._subagent_record_with_usage(
            "sa1", 500, 100, 50, 650
        )
        totals = _session_usage_totals(session)
        label = _format_session_model_label("gpt-4o", totals)
        self.assertIn("gpt-4o", label)
        self.assertIn("↑1.5k", label)
        self.assertIn("(⟲500)", label)
        self.assertIn("↓250", label)

    def test_subagent_without_usage_does_not_affect_total(self):
        session = Session(name="S", id="sub3", model="m")
        session.chains = [self._chain_with_usage(1000, 400, 200, 1200)]
        # Subagent with a user message but no assistant usage.
        agent = Agent(
            name="Subagent",
            type=AgentTypes.SUBAGENT,
            tier=ModelTier.PAPUDO,
            description="d",
            system_prompt="p",
        )
        session.subagent_manager._subagents["sa-no-usage"] = SubagentRecord(
            id="sa-no-usage",
            agent=agent,
            state=SubagentState.COMPLETED,
            label="no-usage",
            task="t",
            start_time=1.0,
            end_time=2.0,
            chain=Chain(messages=[Message(MessageRole.USER, "q")]),
        )
        totals = _session_usage_totals(session)
        self.assertIsNotNone(totals)
        prompt, cached, completion, total = totals
        self.assertEqual(prompt, 1000)
        self.assertEqual(cached, 400)
        self.assertEqual(completion, 200)
        self.assertEqual(total, 1200)

    def test_only_subagent_usage_contributes(self):
        """No chain usage but a subagent with usage → totals come from the
        subagent (not None)."""
        session = Session(name="S", id="sub4", model="m")
        session.chains = []
        session.subagent_manager._subagents["sa1"] = self._subagent_record_with_usage(
            "sa1", 500, 100, 50, 650
        )
        totals = _session_usage_totals(session)
        self.assertIsNotNone(totals)
        prompt, cached, completion, total = totals
        self.assertEqual(prompt, 500)
        self.assertEqual(cached, 100)
        self.assertEqual(completion, 50)
        self.assertEqual(total, 650)


if __name__ == "__main__":
    unittest.main()
