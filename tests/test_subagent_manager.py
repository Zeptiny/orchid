from __future__ import annotations

import asyncio
import time
import unittest
from unittest.mock import patch

from stupidex.agents.manager import (
    SubagentManager,
    SubagentRecord,
    SubagentState,
    format_subagent_attrs,
)
from stupidex.domain.agent import Agent, AgentTypes, ModelTier
from stupidex.domain.chain import Chain
from stupidex.domain.message import Message, MessageRole, MessageType


class _DoneTaskStub:
    """Stand-in for a finished asyncio.Task with a cancel spy."""

    def __init__(self) -> None:
        self.cancel_called = False

    def done(self) -> bool:
        return True

    def cancelled(self) -> bool:
        return False

    def cancel(self) -> bool:
        self.cancel_called = True
        return False


def make_agent() -> Agent:
    return Agent(
        name="Subagent",
        type=AgentTypes.SUBAGENT,
        tier=ModelTier.PAPUDO,
        description="test agent",
        system_prompt="",
        allowed_tools=["read"],
        allowed_skills=[],
    )


def stream_yielding(messages: list[Message]):
    """Fake stream_response that yields the given messages in order."""

    async def _gen(*args, **kwargs):
        for m in messages:
            yield m

    return _gen


def stream_stalled(messages: list[Message], proceed: asyncio.Event):
    """Fake stream_response that stalls until `proceed` is set, then yields."""

    async def _gen(*args, **kwargs):
        await proceed.wait()
        for m in messages:
            yield m

    return _gen


def stream_raising(exc: BaseException):
    """Fake stream_response that raises on first iteration."""

    async def _gen(*args, **kwargs):
        raise exc
        yield  # pragma: no cover - makes this an async generator function

    return _gen


def stream_dispatch(*gen_fns):
    """Return a side-effect factory serving each gen function in call order."""
    remaining = list(gen_fns)

    def factory(*args, **kwargs):
        if not remaining:
            raise AssertionError("stream_response called more times than expected")
        gen_fn = remaining.pop(0)
        return gen_fn(*args, **kwargs)

    return factory


def patch_registry(agent: Agent | None = None):
    """Patch stupidex.agents.get_agent_registry to return {name: agent}."""
    agent = agent if agent is not None else make_agent()
    return patch(
        "stupidex.agents.get_agent_registry",
        return_value={agent.name: agent},
    )


def patch_stream(factory):
    """Patch stupidex.llm.client.stream_response with `factory`."""
    return patch("stupidex.llm.client.stream_response", side_effect=factory)


async def drain(n: int = 8) -> None:
    """Yield control to the loop so fire-and-forget tasks can complete."""
    for _ in range(n):
        await asyncio.sleep(0)


async def _await_cancelled(task: asyncio.Task) -> None:
    """Await a cancelled task, suppressing CancelledError."""
    try:
        await task
    except asyncio.CancelledError:
        pass


class SubagentManagerTests(unittest.IsolatedAsyncioTestCase):
    async def test_spawn_happy_path_transitions_pending_running_completed(self):
        messages = [
            Message(MessageRole.ASSISTANT, "thinking...", MessageType.THINKING),
            Message(MessageRole.ASSISTANT, "Hello", MessageType.TEXT),
            Message(MessageRole.ASSISTANT, "Hello world", MessageType.TEXT),
        ]
        with patch_registry(), patch_stream(stream_yielding(messages)):
            manager = SubagentManager()
            record = await manager.spawn("sub1", "do thing", "Subagent")
            await record.async_task
            await drain()

        self.assertEqual(record.state, SubagentState.COMPLETED)
        self.assertGreater(record.start_time, 0.0)
        self.assertIsNotNone(record.end_time)
        self.assertGreater(record.end_time, record.start_time)
        self.assertEqual(record.result, "Hello world")

    async def test_spawn_fires_on_spawn_callback_with_record(self):
        with patch_registry(), patch_stream(stream_yielding([Message(MessageRole.ASSISTANT, "hi", MessageType.TEXT)])):
            manager = SubagentManager()
            seen: list[tuple[SubagentRecord, SubagentState]] = []

            async def on_spawn(rec):
                seen.append((rec, rec.state))

            manager.on_spawn = on_spawn
            record = await manager.spawn("sub1", "do thing", "Subagent")
            await drain()
            self.assertEqual(len(seen), 1)
            self.assertIs(seen[0][0], record)
            self.assertEqual(seen[0][1], SubagentState.PENDING)
            await record.async_task
            await drain()

    async def test_run_fires_on_state_change_running_then_completed(self):
        messages = [Message(MessageRole.ASSISTANT, "done", MessageType.TEXT)]
        with patch_registry(), patch_stream(stream_yielding(messages)):
            manager = SubagentManager()
            record = await manager.spawn("sub1", "do thing", "Subagent")
            transitions: list[SubagentState] = []

            async def on_state_change(state):
                transitions.append(state)

            record.on_state_change = on_state_change
            await record.async_task
            await drain()

        self.assertEqual(transitions, [SubagentState.RUNNING, SubagentState.COMPLETED])

    async def test_on_message_invoked_for_user_msg_and_each_streamed_msg(self):
        stream_msgs = [
            Message(MessageRole.ASSISTANT, "a", MessageType.TEXT),
            Message(MessageRole.ASSISTANT, "ab", MessageType.TEXT),
            Message(MessageRole.TOOL, "result", MessageType.TOOL_RESULT, tool_call_id="c0"),
        ]
        with patch_registry(), patch_stream(stream_yielding(stream_msgs)):
            manager = SubagentManager()
            record = await manager.spawn("sub1", "do thing", "Subagent")
            calls: list[Message] = []

            async def on_message(msg):
                calls.append(msg)

            record.on_message = on_message
            await record.async_task
            await drain()

        self.assertEqual(len(calls), 1 + len(stream_msgs))
        self.assertIs(calls[0], record.messages[0])
        self.assertEqual(calls[0].role, MessageRole.USER)
        self.assertEqual(calls[1], stream_msgs[0])

    async def test_messages_mounted_counter_increments_per_appended_message(self):
        stream_msgs = [
            Message(MessageRole.ASSISTANT, "thinking", MessageType.THINKING),
            Message(MessageRole.ASSISTANT, "Calling tool", MessageType.TOOL_CALL),
            Message(MessageRole.ASSISTANT, "Answer", MessageType.TEXT),
            Message(MessageRole.ASSISTANT, "Answer updated", MessageType.TEXT),
        ]
        with patch_registry(), patch_stream(stream_yielding(stream_msgs)):
            manager = SubagentManager()
            record = await manager.spawn("sub1", "do thing", "Subagent")
            calls: list[Message] = []

            async def on_message(msg):
                calls.append(msg)

            record.on_message = on_message
            await record.async_task
            await drain()

        self.assertEqual(record.messages_mounted, len(record.messages))
        self.assertGreater(len(calls), record.messages_mounted)

    async def test_finally_block_fires_on_state_change_on_completion(self):
        with patch_registry(), patch_stream(stream_yielding([Message(MessageRole.ASSISTANT, "done", MessageType.TEXT)])):
            manager = SubagentManager()
            record = await manager.spawn("sub1", "do thing", "Subagent")
            end_times_at_callback: list[float | None] = []

            async def on_state_change(state):
                if state == SubagentState.COMPLETED:
                    end_times_at_callback.append(record.end_time)

            record.on_state_change = on_state_change
            await record.async_task
            await drain()

        self.assertEqual(len(end_times_at_callback), 1)
        self.assertIsNotNone(end_times_at_callback[0])
        self.assertGreater(end_times_at_callback[0], 0.0)

    async def test_finally_block_fires_on_state_change_on_cancel(self):
        proceed = asyncio.Event()
        with patch_registry(), patch_stream(stream_stalled([Message(MessageRole.ASSISTANT, "x", MessageType.TEXT)], proceed)):
            manager = SubagentManager()
            record = await manager.spawn("sub1", "do thing", "Subagent")
            transitions: list[SubagentState] = []

            async def on_state_change(state):
                transitions.append(state)

            record.on_state_change = on_state_change
            for _ in range(20):
                if record.state == SubagentState.RUNNING:
                    break
                await asyncio.sleep(0)
            self.assertEqual(record.state, SubagentState.RUNNING)

            record.async_task.cancel()
            try:
                await record.async_task
            except asyncio.CancelledError:
                pass
            await drain()

        self.assertEqual(record.state, SubagentState.INTERRUPTED)
        self.assertEqual(record.error, "Interrupted by user")
        self.assertIsNotNone(record.end_time)
        self.assertIn(SubagentState.INTERRUPTED, transitions)

    async def test_finally_block_fires_on_state_change_on_exception(self):
        with patch_registry(), patch_stream(stream_raising(RuntimeError("boom"))):
            manager = SubagentManager()
            record = await manager.spawn("sub1", "do thing", "Subagent")
            transitions: list[SubagentState] = []

            async def on_state_change(state):
                transitions.append(state)

            record.on_state_change = on_state_change
            await record.async_task
            await drain()

        self.assertEqual(record.state, SubagentState.FAILED)
        self.assertEqual(record.error, "boom")
        self.assertIsNotNone(record.end_time)
        self.assertIn(SubagentState.FAILED, transitions)

    async def test_cancel_one_cancels_running_task_returns_true(self):
        proceed = asyncio.Event()
        with patch_registry(), patch_stream(stream_stalled([Message(MessageRole.ASSISTANT, "x", MessageType.TEXT)], proceed)):
            manager = SubagentManager()
            record = await manager.spawn("sub1", "do thing", "Subagent")
            for _ in range(20):
                if record.state == SubagentState.RUNNING:
                    break
                await asyncio.sleep(0)
            self.assertEqual(record.state, SubagentState.RUNNING)

            ok = manager.cancel_one(record.id)
            self.assertTrue(ok)
            await _await_cancelled(record.async_task)
            self.assertTrue(record.async_task.cancelled())

    async def test_cancel_one_returns_false_for_missing_or_done(self):
        with patch_registry(), patch_stream(stream_yielding([Message(MessageRole.ASSISTANT, "done", MessageType.TEXT)])):
            manager = SubagentManager()
            record = await manager.spawn("sub1", "do thing", "Subagent")
            await record.async_task

            self.assertFalse(manager.cancel_one("nope-id"))
            self.assertFalse(manager.cancel_one(record.id))

    async def test_cancel_all_cancels_running_and_clears_on_spawn(self):
        proceed = asyncio.Event()
        with patch_registry(), patch_stream(stream_stalled([Message(MessageRole.ASSISTANT, "x", MessageType.TEXT)], proceed)):
            manager = SubagentManager()
            r1 = await manager.spawn("sub1", "t1", "Subagent")
            r2 = await manager.spawn("sub2", "t2", "Subagent")
            manager.on_spawn = None

            async def on_spawn(rec):
                pass

            manager.on_spawn = on_spawn

            for _ in range(20):
                if r1.state == SubagentState.RUNNING and r2.state == SubagentState.RUNNING:
                    break
                await asyncio.sleep(0)

            cancelled = manager.cancel_all()
            self.assertEqual(set(cancelled), {r1.id, r2.id})
            self.assertIsNone(manager.on_spawn)

            for t in (r1.async_task, r2.async_task):
                if t is not None:
                    try:
                        await t
                    except asyncio.CancelledError:
                        pass

    async def test_cancel_running_skips_terminal_records(self):
        proceed = asyncio.Event()
        stalled = stream_stalled([Message(MessageRole.ASSISTANT, "x", MessageType.TEXT)], proceed)
        yielding = stream_yielding([Message(MessageRole.ASSISTANT, "done", MessageType.TEXT)])
        with patch_registry(), patch_stream(stream_dispatch(stalled, yielding)):
            manager = SubagentManager()
            running = await manager.spawn("sub1", "t1", "Subagent")
            completed = await manager.spawn("sub2", "t2", "Subagent")
            await completed.async_task

            for _ in range(20):
                if running.state == SubagentState.RUNNING:
                    break
                await asyncio.sleep(0)
            self.assertEqual(running.state, SubagentState.RUNNING)
            self.assertEqual(completed.state, SubagentState.COMPLETED)

            cancelled = manager.cancel_running()
            self.assertEqual(cancelled, [running.id])
            await _await_cancelled(running.async_task)
            self.assertTrue(running.async_task.cancelled())
            self.assertFalse(completed.async_task.cancelled())

    async def test_wait_returns_records_for_valid_ids_and_skips_unknown(self):
        with patch_registry(), patch_stream(stream_yielding([Message(MessageRole.ASSISTANT, "done", MessageType.TEXT)])):
            manager = SubagentManager()
            r1 = await manager.spawn("sub1", "t1", "Subagent")
            r2 = await manager.spawn("sub2", "t2", "Subagent")
            await r1.async_task
            await r2.async_task

            result = await manager.wait([r1.id, r2.id, "unknown-id"])
            self.assertEqual(set(result.keys()), {r1.id, r2.id})
            self.assertIs(result[r1.id], r1)
            self.assertIs(result[r2.id], r2)
            self.assertNotIn("unknown-id", result)

    async def test_wait_awaits_inflight_tasks(self):
        proceed = asyncio.Event()
        with patch_registry(), patch_stream(stream_stalled([Message(MessageRole.ASSISTANT, "done", MessageType.TEXT)], proceed)):
            manager = SubagentManager()
            record = await manager.spawn("sub1", "do thing", "Subagent")

            wait_task = asyncio.create_task(manager.wait([record.id]))
            await asyncio.sleep(0.01)
            self.assertFalse(wait_task.done())

            proceed.set()
            result = await asyncio.wait_for(wait_task, timeout=2.0)
            self.assertIn(record.id, result)
            self.assertEqual(record.state, SubagentState.COMPLETED)

    def test_from_storage_dict_running_migrates_to_interrupted(self):
        data = {
            "id": "abc123",
            "agent_name": "Subagent",
            "agent_type": "subagent",
            "state": "running",
            "label": "sub1",
            "task": "do thing",
            "result": None,
            "error": None,
            "start_time": 1.0,
            "end_time": None,
            "messages": [],
        }
        with patch("stupidex.agents.get_agent_registry", return_value={"Subagent": make_agent()}):
            record = SubagentRecord.from_storage_dict(data)
        self.assertEqual(record.state, SubagentState.INTERRUPTED)
        self.assertEqual(record.id, "abc123")

    def test_from_storage_dict_pending_migrates_to_interrupted(self):
        data = {
            "id": "pend1",
            "agent_name": "Subagent",
            "agent_type": "subagent",
            "state": "pending",
            "label": "sub1",
            "task": "do thing",
            "result": None,
            "error": None,
            "start_time": 1.0,
            "end_time": None,
            "messages": [],
        }
        with patch("stupidex.agents.get_agent_registry", return_value={"Subagent": make_agent()}):
            record = SubagentRecord.from_storage_dict(data)
        self.assertEqual(record.state, SubagentState.INTERRUPTED)
        self.assertIsNone(record.async_task)
        self.assertIsNotNone(record.end_time)
        self.assertGreaterEqual(record.end_time, 1.0)

    def test_cancel_one_pending_task_none_transitions_and_returns_true(self):
        agent = make_agent()
        record = SubagentRecord(
            id="pend1",
            agent=agent,
            state=SubagentState.PENDING,
            label="sub1",
            task="t",
            start_time=time.time(),
        )
        manager = SubagentManager()
        manager._subagents[record.id] = record

        ok = manager.cancel_one(record.id)
        self.assertTrue(ok)
        self.assertEqual(record.state, SubagentState.INTERRUPTED)
        self.assertEqual(record.error, "Interrupted by user")
        self.assertIsNotNone(record.end_time)

    def test_cancel_one_terminal_returns_false_no_mutation(self):
        agent = make_agent()
        record = SubagentRecord(
            id="done1",
            agent=agent,
            state=SubagentState.COMPLETED,
            label="sub1",
            task="t",
            start_time=1.0,
            end_time=2.0,
            result="ok",
        )
        manager = SubagentManager()
        manager._subagents[record.id] = record

        original = record.to_storage_dict()
        ok = manager.cancel_one(record.id)
        self.assertFalse(ok)
        self.assertEqual(record.state, SubagentState.COMPLETED)
        self.assertEqual(record.end_time, 2.0)
        self.assertEqual(record.result, "ok")
        self.assertEqual(record.to_storage_dict(), original)

    def test_cancel_running_transitions_restored_records_with_no_task(self):
        agent = make_agent()
        manager = SubagentManager()
        r1 = SubagentRecord(
            id="rest1",
            agent=agent,
            state=SubagentState.RUNNING,
            label="s1",
            task="t",
            start_time=1.0,
            end_time=None,
        )
        r2 = SubagentRecord(
            id="rest2",
            agent=agent,
            state=SubagentState.PENDING,
            label="s2",
            task="t",
            start_time=2.0,
            end_time=None,
        )
        r3 = SubagentRecord(
            id="rest3",
            agent=agent,
            state=SubagentState.COMPLETED,
            label="s3",
            task="t",
            start_time=3.0,
            end_time=4.0,
        )
        for rec in (r1, r2, r3):
            manager._subagents[rec.id] = rec

        cancelled = manager.cancel_running()
        self.assertEqual(set(cancelled), {r1.id, r2.id})
        self.assertEqual(r1.state, SubagentState.INTERRUPTED)
        self.assertEqual(r2.state, SubagentState.INTERRUPTED)
        self.assertIsNotNone(r1.end_time)
        self.assertIsNotNone(r2.end_time)
        self.assertEqual(r3.state, SubagentState.COMPLETED)

    def test_cancel_one_done_task_pending_state_transitions_no_cancel_call(self):
        agent = make_agent()
        stub = _DoneTaskStub()

        record = SubagentRecord(
            id="done-task1",
            agent=agent,
            state=SubagentState.PENDING,
            label="s1",
            task="t",
            start_time=time.time(),
            async_task=stub,
        )
        manager = SubagentManager()
        manager._subagents[record.id] = record

        ok = manager.cancel_one(record.id)
        self.assertTrue(ok)
        self.assertEqual(record.state, SubagentState.INTERRUPTED)
        self.assertIsNotNone(record.end_time)
        self.assertFalse(stub.cancel_called)

    def test_cancel_all_clears_on_spawn_side_effect(self):
        agent = make_agent()
        manager = SubagentManager()

        async def on_spawn(rec):
            pass

        manager.on_spawn = on_spawn
        record = SubagentRecord(
            id="p1",
            agent=agent,
            state=SubagentState.PENDING,
            label="s1",
            task="t",
            start_time=time.time(),
        )
        manager._subagents[record.id] = record

        cancelled = manager.cancel_all()
        self.assertEqual(cancelled, [record.id])
        self.assertIsNone(manager.on_spawn)
        self.assertEqual(record.state, SubagentState.INTERRUPTED)

    def test_to_storage_dict_round_trips_completed_record(self):
        agent = make_agent()
        msgs = [
            Message(MessageRole.USER, "do thing"),
            Message(MessageRole.ASSISTANT, "Answer", MessageType.TEXT),
        ]
        record = SubagentRecord(
            id="deadbeef",
            agent=agent,
            state=SubagentState.COMPLETED,
            label="sub1",
            task="do thing",
            result="Answer",
            error=None,
            start_time=10.0,
            end_time=11.5,
            chain=Chain(messages=msgs),
            messages_mounted=2,
        )
        d = record.to_storage_dict()
        with patch("stupidex.agents.get_agent_registry", return_value={agent.name: agent}):
            restored = SubagentRecord.from_storage_dict(d)

        self.assertEqual(restored.id, record.id)
        self.assertEqual(restored.agent.name, agent.name)
        self.assertEqual(restored.state, SubagentState.COMPLETED)
        self.assertEqual(restored.label, record.label)
        self.assertEqual(restored.task, record.task)
        self.assertEqual(restored.result, record.result)
        self.assertEqual(restored.error, record.error)
        self.assertEqual(restored.start_time, record.start_time)
        self.assertEqual(restored.end_time, record.end_time)
        self.assertEqual(len(restored.messages), len(msgs))
        self.assertEqual(restored.messages[0].content, "do thing")
        self.assertEqual(restored.messages[1].content, "Answer")
        self.assertIsNone(restored.async_task)
        self.assertIsNone(restored.on_message)
        self.assertIsNone(restored.on_state_change)

    def test_from_storage_dict_falls_back_to_pseudoagent_when_registry_misses(self):
        data = {
            "id": "ghost1",
            "agent_name": "Ghost",
            "agent_type": "subagent",
            "state": "completed",
            "label": "",
            "task": "",
            "result": None,
            "error": None,
            "start_time": 0.0,
            "end_time": None,
            "messages": [],
        }
        empty_registry = {}
        with patch("stupidex.agents.get_agent_registry", return_value=empty_registry):
            record = SubagentRecord.from_storage_dict(data)
        self.assertEqual(record.agent.name, "Ghost")
        self.assertEqual(record.agent.type, AgentTypes.from_str("subagent"))
        self.assertEqual(record.type, "Subagent")

    async def test_spawn_unknown_agent_type_raises_valueerror(self):
        with patch_registry(), patch_stream(stream_yielding([])):
            manager = SubagentManager()
            with self.assertRaises(ValueError) as ctx:
                await manager.spawn("sub1", "do thing", "nope")
            self.assertIn("Available:", str(ctx.exception))

    async def test_get_states_all_records_get_record(self):
        with patch_registry(), patch_stream(stream_yielding([Message(MessageRole.ASSISTANT, "done", MessageType.TEXT)])):
            manager = SubagentManager()
            r1 = await manager.spawn("sub1", "t1", "Subagent")
            r2 = await manager.spawn("sub2", "t2", "Subagent")

            states = manager.get_states()
            self.assertEqual(len(states), 2)
            entry = states[0]
            self.assertEqual(
                set(entry.keys()),
                {"id", "name", "type", "task", "state", "elapsed"},
            )
            self.assertEqual(entry["id"], r1.id)
            self.assertEqual(entry["name"], r1.name)
            self.assertEqual(entry["type"], r1.type)
            self.assertEqual(entry["task"], r1.task)
            self.assertEqual(entry["state"], r1.state.value)

            records = manager.all_records()
            self.assertEqual(records, [r1, r2])

            self.assertIs(manager.get_record(r1.id), r1)
            self.assertIsNone(manager.get_record("nope-id"))

            await r1.async_task
            await r2.async_task


class TestWaitEdgeCases(unittest.IsolatedAsyncioTestCase):
    async def test_wait_empty_list_returns_empty_dict_immediately(self):
        real_gather = asyncio.gather
        gather_calls: list = []

        async def gather_spy(*args, **kwargs):
            gather_calls.append((args, kwargs))
            return await real_gather(*args, **kwargs)

        with patch.object(asyncio, "gather", gather_spy):
            manager = SubagentManager()
            result = await manager.wait([])
        self.assertEqual(result, {})
        self.assertEqual(gather_calls, [])

    async def test_wait_all_unknown_ids_returns_empty_dict(self):
        real_gather = asyncio.gather
        gather_calls: list = []

        async def gather_spy(*args, **kwargs):
            gather_calls.append((args, kwargs))
            return await real_gather(*args, **kwargs)

        with patch_registry(), patch_stream(stream_yielding([Message(MessageRole.ASSISTANT, "done", MessageType.TEXT)])):
            manager = SubagentManager()
            with patch.object(asyncio, "gather", gather_spy):
                result = await manager.wait(["unknown1", "unknown2"])
        self.assertEqual(result, {})
        self.assertEqual(gather_calls, [])

    async def test_wait_mix_done_and_unknown_returns_only_done(self):
        real_gather = asyncio.gather
        gather_calls: list = []

        async def gather_spy(*args, **kwargs):
            gather_calls.append((args, kwargs))
            return await real_gather(*args, **kwargs)

        with patch_registry(), patch_stream(stream_yielding([Message(MessageRole.ASSISTANT, "done", MessageType.TEXT)])):
            manager = SubagentManager()
            done = await manager.spawn("sub1", "t1", "Subagent")
            await done.async_task
            self.assertEqual(done.state, SubagentState.COMPLETED)

            with patch.object(asyncio, "gather", gather_spy):
                result = await manager.wait([done.id, "unknown-id"])
        self.assertEqual(set(result.keys()), {done.id})
        self.assertIs(result[done.id], done)
        self.assertNotIn("unknown-id", result)
        self.assertEqual(gather_calls, [])

    async def test_wait_does_not_await_already_done_tasks(self):
        real_gather = asyncio.gather
        gather_calls: list = []

        async def gather_spy(*args, **kwargs):
            gather_calls.append((args, kwargs))
            return await real_gather(*args, **kwargs)

        with patch_registry(), patch_stream(stream_yielding([Message(MessageRole.ASSISTANT, "done", MessageType.TEXT)])):
            manager = SubagentManager()
            record = await manager.spawn("sub1", "do thing", "Subagent")
            await record.async_task
            self.assertTrue(record.async_task.done())

            with patch.object(asyncio, "gather", gather_spy):
                result = await manager.wait([record.id])
        self.assertIs(result[record.id], record)
        self.assertEqual(gather_calls, [])


class TestCallbackFailureIsolation(unittest.IsolatedAsyncioTestCase):
    async def test_on_message_user_callback_raising_does_not_crash_run(self):
        with patch_registry(), patch_stream(stream_yielding([Message(MessageRole.ASSISTANT, "done", MessageType.TEXT)])):
            manager = SubagentManager()
            record = await manager.spawn("sub1", "do thing", "Subagent")

            async def on_message(msg):
                raise RuntimeError("boom")

            record.on_message = on_message
            await record.async_task
            await drain()
        self.assertEqual(record.state, SubagentState.COMPLETED)
        self.assertGreaterEqual(record.messages_mounted, 1)

    async def test_on_message_streamed_callback_raising_does_not_crash_run(self):
        streamed = [
            Message(MessageRole.ASSISTANT, "a", MessageType.TEXT),
            Message(MessageRole.ASSISTANT, "ab", MessageType.TEXT),
            Message(MessageRole.ASSISTANT, "abc", MessageType.TEXT),
        ]
        with patch_registry(), patch_stream(stream_yielding(streamed)):
            manager = SubagentManager()
            record = await manager.spawn("sub1", "do thing", "Subagent")
            streamed_calls: list[Message] = []

            async def on_message(msg):
                if msg.role != MessageRole.USER:
                    streamed_calls.append(msg)
                    raise RuntimeError("boom")

            record.on_message = on_message
            await record.async_task
            await drain()
        self.assertEqual(record.state, SubagentState.COMPLETED)
        self.assertEqual(len(streamed_calls), len(streamed))
        self.assertEqual(record.result, "abc")

    async def test_on_message_first_callback_raises_second_still_processed(self):
        streamed = [Message(MessageRole.ASSISTANT, "ok", MessageType.TEXT)]
        with patch_registry(), patch_stream(stream_yielding(streamed)):
            manager = SubagentManager()
            record = await manager.spawn("sub1", "do thing", "Subagent")
            calls: list[Message] = []

            async def on_message(msg):
                calls.append(msg)
                if len(calls) == 1:
                    raise RuntimeError("boom")

            record.on_message = on_message
            await record.async_task
            await drain()
        self.assertEqual(record.state, SubagentState.COMPLETED)
        self.assertEqual(len(calls), 1 + len(streamed))
        self.assertEqual(record.messages_mounted, 1 + len(streamed))

    async def test_on_state_change_callback_raising_does_not_crash_run(self):
        with patch_registry(), patch_stream(stream_yielding([Message(MessageRole.ASSISTANT, "done", MessageType.TEXT)])):
            manager = SubagentManager()
            record = await manager.spawn("sub1", "do thing", "Subagent")

            async def on_state_change(state):
                raise RuntimeError("boom")

            record.on_state_change = on_state_change
            await record.async_task
            await drain()
        self.assertEqual(record.state, SubagentState.COMPLETED)


class TestFormatSubagentAttrs(unittest.TestCase):
    def test_escapes_lt_gt_amp_in_all_attribute_values(self):
        evil = 'a<b>&c'
        out = format_subagent_attrs(evil, evil, evil, evil)
        self.assertNotIn('<', out)
        self.assertNotIn('>', out.replace('&gt;', ''))
        self.assertNotIn('&c', out)
        self.assertIn('&lt;', out)
        self.assertIn('&gt;', out)
        self.assertIn('&amp;', out)
        self.assertEqual(out.count('&lt;'), 4)
        self.assertEqual(out.count('&gt;'), 4)
        self.assertEqual(out.count('&amp;'), 4)

    def test_quote_escaped_to_entities(self):
        out = format_subagent_attrs('a"b', 'n', 't', 's')
        self.assertIn('&quot;', out)
        self.assertNotIn('a"b', out)
        self.assertIn('a&quot;b', out)

    def test_all_special_chars_escaped_together(self):
        evil = '<a>&"'
        out = format_subagent_attrs(evil, evil, evil, evil)
        self.assertNotIn('<a>&"', out)
        self.assertIn('&lt;a&gt;&amp;&quot;', out)
        self.assertEqual(out.count('&lt;'), 4)
        self.assertEqual(out.count('&gt;'), 4)
        self.assertEqual(out.count('&amp;'), 4)
        self.assertEqual(out.count('&quot;'), 4)

    def test_omits_elapsed_when_none(self):
        out = format_subagent_attrs('id1', 'n', 't', 's', elapsed=None)
        self.assertNotIn('elapsed', out)

    def test_includes_elapsed_when_float(self):
        out = format_subagent_attrs('id1', 'n', 't', 's', elapsed=12.3)
        self.assertIn('elapsed="12.3s"', out)


class TestElapsedSeconds(unittest.TestCase):
    def _record(self, **kw) -> SubagentRecord:
        return SubagentRecord(
            id="r1",
            agent=make_agent(),
            state=SubagentState.COMPLETED,
            label="s",
            task="t",
            **kw,
        )

    def test_completed_record_uses_end_minus_start(self):
        rec = self._record(start_time=10.0, end_time=12.45)
        self.assertEqual(rec.elapsed_seconds, 2.4)

    def test_running_record_uses_now_minus_start(self):
        rec = self._record(start_time=100.0, end_time=None)
        with patch("stupidex.agents.manager.time.time", return_value=130.7):
            self.assertEqual(rec.elapsed_seconds, 30.7)

    def test_restored_record_with_neither_returns_none(self):
        rec = self._record(start_time=0.0, end_time=None)
        self.assertIsNone(rec.elapsed_seconds)


class TestResultAssignmentEdgeCases(unittest.IsolatedAsyncioTestCase):
    async def test_empty_then_none_then_truthy_assigns_last_truthy(self):
        msgs = [
            Message(MessageRole.ASSISTANT, "", MessageType.TEXT),
            Message(MessageRole.ASSISTANT, None, MessageType.TEXT),
            Message(MessageRole.ASSISTANT, "final", MessageType.TEXT),
        ]
        with patch_registry(), patch_stream(stream_yielding(msgs)):
            manager = SubagentManager()
            record = await manager.spawn("s1", "t", "Subagent")
            await record.async_task
            await drain()
        self.assertEqual(record.state, SubagentState.COMPLETED)
        self.assertEqual(record.result, "final")

    async def test_only_empty_content_leaves_result_none_no_crash(self):
        msgs = [
            Message(MessageRole.ASSISTANT, "", MessageType.TEXT),
            Message(MessageRole.ASSISTANT, None, MessageType.TEXT),
        ]
        with patch_registry(), patch_stream(stream_yielding(msgs)):
            manager = SubagentManager()
            record = await manager.spawn("s1", "t", "Subagent")
            await record.async_task
            await drain()
        self.assertEqual(record.state, SubagentState.COMPLETED)
        self.assertIsNone(record.result)


class TestCancelAllClearsOnSpawn(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_all_clears_on_spawn_and_subsequent_spawn_skips_callback(self):
        with patch_registry(), patch_stream(stream_yielding([Message(MessageRole.ASSISTANT, "done", MessageType.TEXT)])):
            manager = SubagentManager()
            calls: list[SubagentRecord] = []

            async def on_spawn(rec):
                calls.append(rec)

            manager.on_spawn = on_spawn
            r1 = await manager.spawn("s1", "t1", "Subagent")
            await r1.async_task
            await drain()
            self.assertEqual(len(calls), 1)

            manager.cancel_all()
            self.assertIsNone(manager.on_spawn)

            r2 = await manager.spawn("s2", "t2", "Subagent")
            await r2.async_task
            await drain()

            self.assertEqual(len(calls), 1)
            self.assertIsNone(manager.on_spawn)


def _storage_record(**overrides) -> dict:
    base = {
        "id": "rec",
        "agent_name": "Subagent",
        "agent_type": "subagent",
        "state": "completed",
        "label": "s",
        "task": "t",
        "result": None,
        "error": None,
        "start_time": 0.0,
        "end_time": None,
        "messages": [],
    }
    base.update(overrides)
    return base


class TestRestoreAgentHelper(unittest.TestCase):
    def test_registry_hit_returns_registered_agent(self):
        agent = make_agent()
        with patch("stupidex.agents.get_agent_registry", return_value={agent.name: agent}):
            record = SubagentRecord.from_storage_dict(_storage_record(agent_name="Subagent"))
        self.assertIs(record.agent, agent)

    def test_registry_miss_valid_type_constructs_fallback(self):
        with patch("stupidex.agents.get_agent_registry", return_value={}):
            record = SubagentRecord.from_storage_dict(
                _storage_record(agent_name="Ghost", agent_type="Subagent")
            )
        self.assertEqual(record.agent.name, "Ghost")
        self.assertEqual(record.agent.type, AgentTypes.SUBAGENT)
        self.assertEqual(record.agent.tier, ModelTier.PAPUDO)

    def test_registry_miss_invalid_type_falls_back_to_subagent(self):
        with patch("stupidex.agents.get_agent_registry", return_value={}):
            record = SubagentRecord.from_storage_dict(
                _storage_record(agent_name="Ghost", agent_type="garbage")
            )
        self.assertEqual(record.agent.name, "Ghost")
        self.assertEqual(record.agent.type, AgentTypes.SUBAGENT)

    def test_registry_raises_still_constructs_fallback(self):
        def boom():
            raise RuntimeError("registry not initialized")

        with patch("stupidex.agents.get_agent_registry", side_effect=boom):
            record = SubagentRecord.from_storage_dict(
                _storage_record(agent_name="Ghost", agent_type="garbage")
            )
        self.assertEqual(record.agent.name, "Ghost")
        self.assertEqual(record.agent.type, AgentTypes.SUBAGENT)

    def test_empty_agent_name_constructs_agent_with_empty_name(self):
        with patch("stupidex.agents.get_agent_registry", return_value={}):
            record = SubagentRecord.from_storage_dict(
                _storage_record(agent_name="", agent_type="subagent")
            )
        self.assertEqual(record.agent.name, "")


class TestRestoredInterruptedNormalization(unittest.TestCase):
    def test_completed_record_elapsed_uses_end_minus_start(self):
        with patch("stupidex.agents.get_agent_registry", return_value={"Subagent": make_agent()}):
            record = SubagentRecord.from_storage_dict(
                _storage_record(
                    state="completed", start_time=100.0, end_time=200.0
                )
            )
        self.assertEqual(record.elapsed_seconds, 100.0)

    def test_interrupted_with_both_times_uses_end_minus_start(self):
        with patch("stupidex.agents.get_agent_registry", return_value={"Subagent": make_agent()}):
            record = SubagentRecord.from_storage_dict(
                _storage_record(
                    state="interrupted", start_time=100.0, end_time=200.0
                )
            )
        self.assertEqual(record.elapsed_seconds, 100.0)

    def test_running_migrated_to_interrupted_sets_end_time_now(self):
        before = time.time()
        with patch("stupidex.agents.get_agent_registry", return_value={"Subagent": make_agent()}):
            record = SubagentRecord.from_storage_dict(
                _storage_record(state="running", start_time=100.0, end_time=None)
            )
        after = time.time()
        self.assertEqual(record.state, SubagentState.INTERRUPTED)
        self.assertIsNotNone(record.end_time)
        self.assertGreaterEqual(record.end_time, before)
        self.assertLessEqual(record.end_time, after)
        self.assertAlmostEqual(
            record.elapsed_seconds, round(record.end_time - 100.0, 1)
        )

    def test_pending_never_started_reports_zero_elapsed(self):
        with patch("stupidex.agents.get_agent_registry", return_value={"Subagent": make_agent()}):
            record = SubagentRecord.from_storage_dict(
                _storage_record(state="pending", start_time=0.0, end_time=None)
            )
        self.assertEqual(record.state, SubagentState.INTERRUPTED)
        self.assertIsNotNone(record.end_time)
        self.assertEqual(record.start_time, record.end_time)
        self.assertEqual(record.elapsed_seconds, 0.0)

    def test_running_with_zero_start_time_reports_zero_elapsed(self):
        with patch("stupidex.agents.get_agent_registry", return_value={"Subagent": make_agent()}):
            record = SubagentRecord.from_storage_dict(
                _storage_record(state="running", start_time=0.0, end_time=None)
            )
        self.assertEqual(record.state, SubagentState.INTERRUPTED)
        self.assertEqual(record.start_time, record.end_time)
        self.assertEqual(record.elapsed_seconds, 0.0)

    def test_pending_string_state_migrates_to_interrupted(self):
        with patch("stupidex.agents.get_agent_registry", return_value={"Subagent": make_agent()}):
            record = SubagentRecord.from_storage_dict(
                _storage_record(state="pending", start_time=100.0, end_time=200.0)
            )
        self.assertEqual(record.state, SubagentState.INTERRUPTED)

    def test_completed_with_none_end_time_keeps_live_running_semantics(self):
        with patch("stupidex.agents.get_agent_registry", return_value={"Subagent": make_agent()}):
            record = SubagentRecord.from_storage_dict(
                _storage_record(state="completed", start_time=100.0, end_time=None)
            )
        self.assertIsNone(record.end_time)
        with patch("stupidex.agents.manager.time.time", return_value=200.0):
            self.assertEqual(record.elapsed_seconds, 100.0)


class TestSubagentMessageReconciliation(unittest.TestCase):
    def _assistant_with_tool_calls(self, content="calling", tool_call_id="abc"):
        return Message(
            role=MessageRole.ASSISTANT,
            content=content,
            type=MessageType.TOOL_CALL,
            tool_calls=[{"id": tool_call_id, "function": {"name": "f", "arguments": "{}"}}],
        )

    def _tool_result(self, tool_call_id="abc", content="result"):
        return Message(
            role=MessageRole.TOOL,
            content=content,
            type=MessageType.TOOL_RESULT,
            tool_call_id=tool_call_id,
        )

    def test_well_formed_messages_preserved(self):
        msgs = [
            self._assistant_with_tool_calls(),
            self._tool_result(),
        ]
        with patch("stupidex.agents.get_agent_registry", return_value={"Subagent": make_agent()}):
            record = SubagentRecord.from_storage_dict(
                _storage_record(messages=[m.to_storage_dict() for m in msgs])
            )
        self.assertEqual(len(record.messages), 2)

    def test_orphan_tool_result_dropped(self):
        msgs = [
            self._tool_result(tool_call_id="orphan"),
            self._assistant_with_tool_calls(tool_call_id="valid"),
            self._tool_result(tool_call_id="valid"),
        ]
        with patch("stupidex.agents.get_agent_registry", return_value={"Subagent": make_agent()}):
            record = SubagentRecord.from_storage_dict(
                _storage_record(messages=[m.to_storage_dict() for m in msgs])
            )
        ids = [m.tool_call_id for m in record.messages if m.tool_call_id]
        self.assertNotIn("orphan", ids)
        self.assertEqual(ids, ["valid"])
        self.assertEqual(len(record.messages), 2)

    def test_multiple_orphans_interleaved_dropped_others_preserved(self):
        msgs = [
            self._tool_result(tool_call_id="orphan1"),
            self._assistant_with_tool_calls(content="c1", tool_call_id="valid1"),
            self._tool_result(tool_call_id="orphan2"),
            self._tool_result(tool_call_id="valid1"),
            self._tool_result(tool_call_id="orphan3"),
        ]
        with patch("stupidex.agents.get_agent_registry", return_value={"Subagent": make_agent()}):
            record = SubagentRecord.from_storage_dict(
                _storage_record(messages=[m.to_storage_dict() for m in msgs])
            )
        ids = [m.tool_call_id for m in record.messages if m.tool_call_id]
        self.assertNotIn("orphan1", ids)
        self.assertNotIn("orphan2", ids)
        self.assertNotIn("orphan3", ids)
        self.assertEqual(ids, ["valid1"])
        self.assertEqual(len(record.messages), 2)

    def test_empty_messages_list_is_noop(self):
        with patch("stupidex.agents.get_agent_registry", return_value={"Subagent": make_agent()}):
            record = SubagentRecord.from_storage_dict(_storage_record(messages=[]))
        self.assertEqual(record.messages, [])


class TestSubagentRecordComposition(unittest.IsolatedAsyncioTestCase):
    """U5: SubagentRecord wraps a Chain via composition (R8/R9/R10)."""

    def _agent(self) -> Agent:
        return make_agent()

    def test_messages_property_returns_chain_messages_reference(self):
        record = SubagentRecord(
            id="r", agent=self._agent(), state=SubagentState.PENDING,
        )
        m = Message(MessageRole.USER, "hi")
        record.messages.append(m)
        # Appending via the back-compat property mutates the chain's list.
        self.assertIs(record.messages, record.chain.messages)
        self.assertIn(m, record.chain.messages)

    def test_default_construction_chain_empty_model_none_parent_none(self):
        record = SubagentRecord(
            id="r", agent=self._agent(), state=SubagentState.PENDING,
            label="s", task="t",
        )
        self.assertIsInstance(record.chain, Chain)
        self.assertEqual(record.chain.messages, [])
        self.assertIsNone(record.model)
        self.assertIsNone(record.parent_chain_index)
        # messages property still resolves to the empty chain list.
        self.assertIs(record.messages, record.chain.messages)

    def test_persistence_round_trip_preserves_model_parent_and_messages(self):
        agent = self._agent()
        msgs = [
            Message(MessageRole.USER, "do thing"),
            Message(MessageRole.ASSISTANT, "Answer", MessageType.TEXT),
        ]
        record = SubagentRecord(
            id="r2",
            agent=agent,
            state=SubagentState.COMPLETED,
            label="sub1",
            task="do thing",
            result="Answer",
            start_time=10.0,
            end_time=11.5,
            chain=Chain(model="gpt-4o", messages=msgs),
            model="gpt-4o",
            parent_chain_index=2,
            messages_mounted=2,
        )
        d = record.to_storage_dict()
        # New shape: nested chain dict + top-level model/parent_chain_index.
        self.assertIn("chain", d)
        self.assertEqual(d["model"], "gpt-4o")
        self.assertEqual(d["parent_chain_index"], 2)
        with patch("stupidex.agents.get_agent_registry", return_value={agent.name: agent}):
            restored = SubagentRecord.from_storage_dict(d)
        self.assertEqual(restored.model, "gpt-4o")
        self.assertEqual(restored.parent_chain_index, 2)
        self.assertEqual(restored.chain.model, "gpt-4o")
        self.assertEqual(len(restored.chain.messages), 2)
        self.assertEqual(restored.chain.messages[0].content, "do thing")
        self.assertEqual(restored.chain.messages[1].content, "Answer")
        self.assertEqual(restored.messages_mounted, 2)

    def test_orphan_reconcile_runs_once_via_chain_from_storage_dict(self):
        """R9: SubagentRecord.from_storage_dict must NOT call the orphan
        reconciler directly; it is delegated to Chain.from_storage_dict."""
        from stupidex.agents import manager as manager_mod

        msgs = [
            Message(
                role=MessageRole.TOOL,
                content="orphan",
                type=MessageType.TOOL_RESULT,
                tool_call_id="orphan",
            ),
            Message(
                role=MessageRole.ASSISTANT,
                content="ok",
                type=MessageType.TEXT,
            ),
        ]
        with patch("stupidex.agents.get_agent_registry", return_value={"Subagent": make_agent()}), \
                patch.object(manager_mod.Chain, "from_storage_dict", wraps=manager_mod.Chain.from_storage_dict) as chain_spy:
            record = SubagentRecord.from_storage_dict(
                _storage_record(messages=[m.to_storage_dict() for m in msgs])
            )
        # Chain.from_storage_dict called exactly once (the single reconcile path).
        self.assertEqual(chain_spy.call_count, 1)
        # The orphan tool result was dropped by that single pass.
        ids = [m.tool_call_id for m in record.messages if m.tool_call_id]
        self.assertNotIn("orphan", ids)

    async def test_parent_linkage_at_spawn_records_current_chain_index(self):
        """R10: spawn within a turn whose chain index is i sets
        record.parent_chain_index == i via the ContextVar."""
        from stupidex.agents import manager as manager_mod

        with patch_registry(), patch_stream(stream_yielding([Message(MessageRole.ASSISTANT, "done", MessageType.TEXT)])):
            manager = SubagentManager()
            try:
                manager_mod._current_chain_index.set(3)
                record = await manager.spawn("sub1", "t", "Subagent")
                await record.async_task
                await drain()
            finally:
                manager_mod._current_chain_index.set(None)
        self.assertEqual(record.parent_chain_index, 3)
        self.assertIsNone(record.model)  # no model passed to spawn


class TestFlushStateCallbacks(unittest.IsolatedAsyncioTestCase):
    async def test_flush_awaits_single_callback(self):
        manager = SubagentManager()
        agent = make_agent()
        record = SubagentRecord(
            id="r1",
            agent=agent,
            state=SubagentState.RUNNING,
            label="s",
            task="t",
            start_time=time.time(),
        )
        observed: list[SubagentState] = []

        async def on_state_change(state):
            observed.append(state)

        record.on_state_change = on_state_change
        manager._subagents[record.id] = record

        self.assertTrue(manager.cancel_one(record.id))
        self.assertEqual(len(manager._pending_callback_tasks), 1)
        await manager.flush_state_callbacks()
        self.assertEqual(observed, [SubagentState.INTERRUPTED])
        self.assertEqual(manager._pending_callback_tasks, set())

    async def test_flush_awaits_multiple_callbacks(self):
        manager = SubagentManager()
        agent = make_agent()
        r1 = SubagentRecord(
            id="r1", agent=agent, state=SubagentState.RUNNING, label="s", task="t",
            start_time=time.time(),
        )
        r2 = SubagentRecord(
            id="r2", agent=agent, state=SubagentState.RUNNING, label="s", task="t",
            start_time=time.time(),
        )
        observed: list[SubagentState] = []

        async def on_state_change(state):
            observed.append(state)

        r1.on_state_change = on_state_change
        r2.on_state_change = on_state_change
        manager._subagents[r1.id] = r1
        manager._subagents[r2.id] = r2

        cancelled = manager.cancel_running()
        self.assertEqual(set(cancelled), {r1.id, r2.id})
        self.assertEqual(len(manager._pending_callback_tasks), 2)
        await manager.flush_state_callbacks()
        self.assertEqual(observed, [SubagentState.INTERRUPTED, SubagentState.INTERRUPTED])
        self.assertEqual(manager._pending_callback_tasks, set())

    async def test_flush_callback_raises_does_not_propagate(self):
        manager = SubagentManager()
        agent = make_agent()
        record = SubagentRecord(
            id="r1", agent=agent, state=SubagentState.RUNNING, label="s", task="t",
            start_time=time.time(),
        )

        async def on_state_change(state):
            raise RuntimeError("boom")

        record.on_state_change = on_state_change
        manager._subagents[record.id] = record

        manager.cancel_one(record.id)
        await manager.flush_state_callbacks()
        self.assertEqual(manager._pending_callback_tasks, set())

    async def test_flush_empty_returns_immediately(self):
        manager = SubagentManager()
        await manager.flush_state_callbacks()
        self.assertEqual(manager._pending_callback_tasks, set())


if __name__ == "__main__":
    unittest.main()
