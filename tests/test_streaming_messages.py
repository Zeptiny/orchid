import asyncio
import contextlib
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import litellm

from stupidex.config import Config
from stupidex.domain.message import (
    Message,
    MessageRole,
    MessageType,
    StreamHistoryState,
    Usage,
    record_streamed_message,
)
from stupidex.domain.tool import (
    ExecutorResult,
    Tool,
    ToolParameter,
    ToolParameterProperties,
)
from stupidex.llm import client as llm_client
from stupidex.llm.client import classify_error
from stupidex.llm.providers import ProviderResolutionError
from stupidex.widgets import message_widget


def chunk(*, reasoning: str = "", content: str = "", tool_calls=None, usage=None):
    delta = SimpleNamespace(
        reasoning_content=reasoning,
        content=content,
        tool_calls=tool_calls,
    )
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta)], usage=usage)


def tool_delta(index: int):
    return SimpleNamespace(
        index=index,
        id=f"call-{index}",
        function=SimpleNamespace(name="read", arguments='{"file_path":"README.md"}'),
    )


class StreamHistoryTest(unittest.TestCase):
    def test_record_streamed_message_updates_cumulative_snapshots(self):
        history = []
        state = StreamHistoryState()

        record_streamed_message(
            history,
            Message(MessageRole.ASSISTANT, "Let me read", MessageType.THINKING),
            state,
        )
        record_streamed_message(
            history,
            Message(MessageRole.ASSISTANT, "Let me read the file", MessageType.THINKING),
            state,
        )
        record_streamed_message(
            history,
            Message(MessageRole.ASSISTANT, "Calling tool: read", MessageType.TOOL_CALL),
            state,
        )
        record_streamed_message(
            history,
            Message(MessageRole.TOOL, "file contents", MessageType.TOOL_RESULT, tool_call_id="call-0"),
            state,
        )
        record_streamed_message(
            history,
            Message(MessageRole.ASSISTANT, "Answer", MessageType.TEXT),
            state,
        )
        record_streamed_message(
            history,
            Message(MessageRole.ASSISTANT, "Answer done", MessageType.TEXT),
            state,
        )
        record_streamed_message(
            history,
            Message(MessageRole.ASSISTANT, "", MessageType.TEXT, usage=Usage(1, 2, 3)),
            state,
        )

        self.assertEqual(
            [(msg.type, msg.content) for msg in history],
            [
                (MessageType.THINKING, "Let me read the file"),
                (MessageType.TOOL_RESULT, "file contents"),
                (MessageType.TEXT, "Answer done"),
            ],
        )
        self.assertEqual(history[-1].usage, Usage(1, 2, 3))

    def test_record_streamed_message_attaches_tool_calls_to_assistant_text(self):
        history = []
        state = StreamHistoryState()

        tool_calls = [{"id": "call-0", "type": "function",
                       "function": {"name": "read", "arguments": '{"file_path":"README.md"}'}}]

        record_streamed_message(
            history,
            Message(MessageRole.ASSISTANT, "Let me check", MessageType.TEXT),
            state,
        )
        record_streamed_message(
            history,
            Message(MessageRole.ASSISTANT, "Let me check", MessageType.TEXT, tool_calls=tool_calls),
            state,
        )
        record_streamed_message(
            history,
            Message(MessageRole.TOOL, "contents", MessageType.TOOL_RESULT, tool_call_id="call-0"),
            state,
        )

        self.assertEqual(len(history), 2)
        assistant_msg = history[0]
        self.assertEqual(assistant_msg.role, MessageRole.ASSISTANT)
        self.assertEqual(assistant_msg.content, "Let me check")
        self.assertEqual(assistant_msg.tool_calls, tool_calls)

    def test_record_streamed_message_anchors_tool_calls_without_content(self):
        """When the model calls a tool with no prior text content, the
        tool_calls block must still persist as an assistant message so the
        matching TOOL_RESULT is not orphaned on replay."""
        history = []
        state = StreamHistoryState()

        tool_calls = [{"id": "call-0", "type": "function",
                       "function": {"name": "read", "arguments": '{"file_path":"README.md"}'}}]

        # model goes straight to a tool call, no content
        appended = record_streamed_message(
            history,
            Message(MessageRole.ASSISTANT, "", MessageType.TEXT, tool_calls=tool_calls),
            state,
        )
        self.assertTrue(appended)
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0].tool_calls, tool_calls)
        self.assertEqual(history[0].content, "")

        record_streamed_message(
            history,
            Message(MessageRole.TOOL, "contents", MessageType.TOOL_RESULT, tool_call_id="call-0"),
            state,
        )
        self.assertEqual(len(history), 2)

        # Verify replay can pair the tool result with its assistant tool_calls message.
        api_messages = llm_client._history_to_api_messages(history)
        self.assertEqual(api_messages[0]["role"], "assistant")
        self.assertEqual(api_messages[0]["tool_calls"], tool_calls)
        self.assertEqual(api_messages[1]["role"], "tool")
        self.assertEqual(api_messages[1]["tool_call_id"], "call-0")

    def test_api_history_replays_thinking_and_drops_orphaned_tool_results(self):
        history = [
            Message(MessageRole.USER, "hello"),
            Message(MessageRole.ASSISTANT, "hidden reasoning", MessageType.THINKING),
            Message(MessageRole.ASSISTANT, "Calling tool: read", MessageType.TOOL_CALL),
            Message(MessageRole.TOOL, "tool output", MessageType.TOOL_RESULT, tool_call_id="call-0"),
            Message(MessageRole.ASSISTANT, "", MessageType.TEXT, usage=Usage(1, 2, 3)),
            Message(MessageRole.ASSISTANT, "final answer", MessageType.TEXT),
        ]

        self.assertEqual(
            llm_client._history_to_api_messages(history),
            [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "hidden reasoning"},
                {"role": "assistant", "content": "final answer"},
            ],
        )

    def test_api_history_includes_tool_calls_and_tool_results_with_matching_ids(self):
        assistant_msg = Message(
            MessageRole.ASSISTANT,
            "Let me check",
            MessageType.TEXT,
            tool_calls=[{"id": "call-0", "type": "function",
                         "function": {"name": "read", "arguments": '{"file_path":"README.md"}'}}],
        )
        history = [
            Message(MessageRole.USER, "hello"),
            assistant_msg,
            Message(MessageRole.TOOL, "file contents", MessageType.TOOL_RESULT, tool_call_id="call-0"),
            Message(MessageRole.ASSISTANT, "final answer", MessageType.TEXT),
        ]

        self.assertEqual(
            llm_client._history_to_api_messages(history),
            [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "Let me check",
                 "tool_calls": assistant_msg.tool_calls},
                {"role": "tool", "content": "file contents", "tool_call_id": "call-0"},
                {"role": "assistant", "content": "final answer"},
            ],
        )

    def test_api_history_drops_orphaned_tool_result_without_matching_assistant(self):
        history = [
            Message(MessageRole.USER, "hello"),
            Message(MessageRole.TOOL, "orphaned", MessageType.TOOL_RESULT, tool_call_id="call-9"),
            Message(MessageRole.ASSISTANT, "answer", MessageType.TEXT),
        ]

        self.assertEqual(
            llm_client._history_to_api_messages(history),
            [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "answer"},
            ],
        )


class StreamTaskTest(unittest.IsolatedAsyncioTestCase):
    async def test_dirty_thinking_flushes_before_content_display(self):
        async def response():
            yield chunk(reasoning="The user is")
            yield chunk(reasoning=" asking for help")
            yield chunk(content="Hey!")

        msg_q = asyncio.Queue(maxsize=1)
        ready_q = asyncio.Queue()
        api_messages = []
        assistant_appended = asyncio.Event()
        tool_calls_started = asyncio.Event()

        stream_t = asyncio.create_task(
            llm_client._stream_task(
                response(),
                msg_q,
                ready_q,
                api_messages,
                assistant_appended,
                tool_calls_started,
            )
        )
        executor_t = asyncio.create_task(
            llm_client._executor_task(
                msg_q,
                ready_q,
                api_messages,
                {},
                assistant_appended,
            )
        )

        messages = []
        while True:
            msg = await msg_q.get()
            if msg is None:
                break
            messages.append(msg)

        await asyncio.gather(stream_t, executor_t)

        full_thinking_index = next(
            i for i, msg in enumerate(messages)
            if msg.type == MessageType.THINKING and msg.content == "The user is asking for help"
        )
        content_index = next(
            i for i, msg in enumerate(messages)
            if msg.type == MessageType.TEXT and msg.content == "Hey!"
        )

        self.assertLess(full_thinking_index, content_index)

    async def test_dirty_thinking_flushes_before_tool_call_display(self):
        async def response():
            yield chunk(reasoning="Let me wait")
            yield chunk(reasoning=" for subagents")
            yield chunk(tool_calls=[tool_delta(0)])

        async def fake_execute_tool(tc, filtered_tools):
            return Message(
                role=MessageRole.TOOL,
                content=f"result {tc['id']}",
                type=MessageType.TOOL_RESULT,
                tool_call_id=tc["id"],
            )

        original_execute_tool = llm_client._execute_tool
        llm_client._execute_tool = fake_execute_tool
        try:
            msg_q = asyncio.Queue(maxsize=1)
            ready_q = asyncio.Queue()
            api_messages = []
            assistant_appended = asyncio.Event()
            tool_calls_started = asyncio.Event()

            stream_t = asyncio.create_task(
                llm_client._stream_task(
                    response(),
                    msg_q,
                    ready_q,
                    api_messages,
                    assistant_appended,
                    tool_calls_started,
                )
            )
            executor_t = asyncio.create_task(
                llm_client._executor_task(
                    msg_q,
                    ready_q,
                    api_messages,
                    {},
                    assistant_appended,
                )
            )

            messages = []
            while True:
                msg = await msg_q.get()
                if msg is None:
                    break
                messages.append(msg)

            await asyncio.gather(stream_t, executor_t)
        finally:
            llm_client._execute_tool = original_execute_tool

        full_thinking_index = next(
            i for i, msg in enumerate(messages)
            if msg.type == MessageType.THINKING and msg.content == "Let me wait for subagents"
        )
        tool_call_index = next(
            i for i, msg in enumerate(messages)
            if msg.type == MessageType.TOOL_CALL
        )

        self.assertLess(full_thinking_index, tool_call_index)

    async def test_dirty_thinking_flushes_before_async_tool_result(self):
        async def response():
            yield chunk(reasoning="Let me read")
            yield chunk(reasoning=" the source files")
            yield chunk(tool_calls=[tool_delta(0)])
            yield chunk(tool_calls=[tool_delta(1)])
            await asyncio.sleep(0.01)

        async def fake_execute_tool(tc, filtered_tools):
            return Message(
                role=MessageRole.TOOL,
                content=f"result {tc['id']}",
                type=MessageType.TOOL_RESULT,
                tool_call_id=tc["id"],
            )

        original_execute_tool = llm_client._execute_tool
        llm_client._execute_tool = fake_execute_tool
        try:
            msg_q = asyncio.Queue(maxsize=1)
            ready_q = asyncio.Queue()
            api_messages = []
            assistant_appended = asyncio.Event()
            tool_calls_started = asyncio.Event()

            stream_t = asyncio.create_task(
                llm_client._stream_task(
                    response(),
                    msg_q,
                    ready_q,
                    api_messages,
                    assistant_appended,
                    tool_calls_started,
                )
            )
            executor_t = asyncio.create_task(
                llm_client._executor_task(
                    msg_q,
                    ready_q,
                    api_messages,
                    {},
                    assistant_appended,
                )
            )

            messages = []
            while True:
                msg = await msg_q.get()
                if msg is None:
                    break
                messages.append(msg)

            await asyncio.gather(stream_t, executor_t)
        finally:
            llm_client._execute_tool = original_execute_tool

        full_thinking_index = next(
            i for i, msg in enumerate(messages)
            if msg.type == MessageType.THINKING and msg.content == "Let me read the source files"
        )
        first_tool_result_index = next(
            i for i, msg in enumerate(messages)
            if msg.type == MessageType.TOOL_RESULT
        )

        self.assertLess(full_thinking_index, first_tool_result_index)

    async def test_assistant_text_message_with_tool_calls_is_emitted_to_msg_q(self):
        """Verify _stream_task emits a TEXT assistant message carrying the
        actual tool_calls payload (the fix's whole point). A regression that
        deletes the commit_assistant_with_tool_calls emit would still pass
        every other test because they only assert ordering, not the payload."""

        async def response():
            yield chunk(content="Let me check.")
            yield chunk(tool_calls=[tool_delta(0)])

        msg_q = asyncio.Queue(maxsize=1)
        ready_q = asyncio.Queue()
        api_messages = []
        assistant_appended = asyncio.Event()
        tool_calls_started = asyncio.Event()

        stream_t = asyncio.create_task(
            llm_client._stream_task(
                response(), msg_q, ready_q, api_messages,
                assistant_appended, tool_calls_started,
            )
        )
        executor_t = asyncio.create_task(
            llm_client._executor_task(
                msg_q, ready_q, api_messages, {}, assistant_appended,
            )
        )

        messages = []
        while True:
            msg = await msg_q.get()
            if msg is None:
                break
            messages.append(msg)

        await asyncio.gather(stream_t, executor_t)

        text_with_tool_calls = [
            m for m in messages
            if m.type == MessageType.TEXT and m.tool_calls
        ]
        self.assertEqual(len(text_with_tool_calls), 1)
        self.assertEqual(text_with_tool_calls[0].role, MessageRole.ASSISTANT)
        self.assertEqual(text_with_tool_calls[0].content, "Let me check.")
        tc = text_with_tool_calls[0].tool_calls[0]
        self.assertEqual(tc["id"], "call-0")
        self.assertEqual(tc["function"]["name"], "read")

    async def test_three_parallel_tool_calls_all_persisted_in_assistant_message(self):
        """Regression test for bug #1: with 3+ parallel tool_calls, the
        shallow-copy snapshot used to freeze the list at length 2; the third
        tool_call_id was never persisted, so its TOOL_RESULT was orphaned
        on the next turn. The fix passes the live list reference so all
        tool_call_ids land on disk by end-of-stream.
        """
        async def response():
            yield chunk(content="Reading three files")
            yield chunk(tool_calls=[tool_delta(0)])
            yield chunk(tool_calls=[tool_delta(1)])
            yield chunk(tool_calls=[tool_delta(2)])
            await asyncio.sleep(0.01)

        async def fake_execute_tool(tc, filtered_tools):
            return Message(
                role=MessageRole.TOOL,
                content=f"result {tc['id']}",
                type=MessageType.TOOL_RESULT,
                tool_call_id=tc["id"],
            )

        original_execute_tool = llm_client._execute_tool
        llm_client._execute_tool = fake_execute_tool
        try:
            msg_q = asyncio.Queue(maxsize=1)
            ready_q = asyncio.Queue()
            api_messages = []
            assistant_appended = asyncio.Event()
            tool_calls_started = asyncio.Event()

            stream_t = asyncio.create_task(
                llm_client._stream_task(
                    response(), msg_q, ready_q, api_messages,
                    assistant_appended, tool_calls_started,
                )
            )
            executor_t = asyncio.create_task(
                llm_client._executor_task(
                    msg_q, ready_q, api_messages, {}, assistant_appended,
                )
            )

            messages = []
            while True:
                msg = await msg_q.get()
                if msg is None:
                    break
                messages.append(msg)

            await asyncio.gather(stream_t, executor_t)
        finally:
            llm_client._execute_tool = original_execute_tool

        # Exactly one assistant TEXT message should carry the full set of tool_calls
        text_with_tool_calls = [
            m for m in messages
            if m.type == MessageType.TEXT and m.tool_calls
        ]
        self.assertEqual(len(text_with_tool_calls), 1, "emit should fire exactly once")
        assistant_msg = text_with_tool_calls[0]
        ids = {tc["id"] for tc in assistant_msg.tool_calls}
        self.assertEqual(ids, {"call-0", "call-1", "call-2"},
                         "all three tool_call_ids must be in the persisted assistant message")

        # The persisted history, when replayed, must pair every TOOL_RESULT with its assistant.
        history = [Message(MessageRole.USER, "hello"), assistant_msg]
        for m in messages:
            if m.type == MessageType.TOOL_RESULT:
                history.append(m)

        replayed = llm_client._history_to_api_messages(history)
        # Expect: user, assistant(with all 3 tool_calls), tool(call-0), tool(call-1), tool(call-2)
        self.assertEqual(replayed[0]["role"], "user")
        self.assertEqual(replayed[1]["role"], "assistant")
        self.assertEqual({tc["id"] for tc in replayed[1]["tool_calls"]}, {"call-0", "call-1", "call-2"})
        tool_msgs = [m for m in replayed if m["role"] == "tool"]
        self.assertEqual(len(tool_msgs), 3,
                         "all three tool results must be paired with the assistant tool_calls on replay")

    async def test_none_index_delta_appends_at_slot_zero(self):
        """P2-85: a tool_call delta with `index=None` (Anthropic-via-litellm,
        Bedrock adapters) must be coerced to `len(tool_calls)` — appends at
        slot 0 for the first delta —而不是 raising TypeError mid-stream."""
        async def response():
            yield chunk(content="Reading")
            yield chunk(tool_calls=[self._none_index_delta()])

        async def fake_execute_tool(tc, filtered_tools):
            return Message(
                role=MessageRole.TOOL,
                content=f"result {tc['id']}",
                type=MessageType.TOOL_RESULT,
                tool_call_id=tc["id"],
            )

        messages, api_messages = await self._drive_stream(
            response, execute_tool=fake_execute_tool
        )

        anchored = await self._assistant_with_tool_calls(api_messages)
        self.assertEqual([tc["id"] for tc in anchored["tool_calls"]], ["call-0"])
        self.assertEqual(
            [tc["function"]["name"] for tc in anchored["tool_calls"]], ["read"]
        )

    async def test_none_index_delta_after_prior_index_appends_next_slot(self):
        """P2-85: when `index=None` arrives after a prior `index=0` was already
        appended, it coerces to slot 1 (len(tool_calls) == 1)."""
        async def response():
            yield chunk(content="Reading two files")
            yield chunk(tool_calls=[tool_delta(0)])
            yield chunk(tool_calls=[self._none_index_delta(call_id="call-1")])
            await asyncio.sleep(0.01)

        async def fake_execute_tool(tc, filtered_tools):
            return Message(
                role=MessageRole.TOOL,
                content=f"result {tc['id']}",
                type=MessageType.TOOL_RESULT,
                tool_call_id=tc["id"],
            )

        messages, api_messages = await self._drive_stream(
            response, execute_tool=fake_execute_tool
        )

        anchored = await self._assistant_with_tool_calls(api_messages)
        self.assertEqual(
            {tc["id"] for tc in anchored["tool_calls"]}, {"call-0", "call-1"}
        )

    async def test_none_index_delta_without_name_or_id_does_not_crash(self):
        """P2-85 error path: delta with `index=None`, no id, no function.name
        still processes (appends placeholder) without crashing; downstream
        commit filter drops the malformed entry."""
        async def response():
            yield chunk(content="Picking a tool")
            yield chunk(tool_calls=[
                SimpleNamespace(
                    index=None,
                    id=None,
                    function=SimpleNamespace(name=None, arguments='{"x":1}'),
                )
            ])
            yield chunk(tool_calls=[tool_delta(1)])
            await asyncio.sleep(0.01)

        messages, api_messages = await self._drive_stream(response)

        anchored = await self._assistant_with_tool_calls(api_messages)
        # The malformed placeholder is filtered out; only call-1 survives.
        self.assertEqual([tc["id"] for tc in anchored["tool_calls"]], ["call-1"])

    async def test_maybe_enqueue_snapshots_tool_call_not_live_reference(self):
        """P2-87: maybe_enqueue must put a deepcopy of the tool_call on ready_q,
        not the live working-buffer reference. Without the snapshot, the
        executor races with the stream loop's in-place `+=` on
        `function.arguments`, producing spurious "Invalid arguments" errors
        on parallel tool calls where args arrive in multiple chunks."""
        captured: list[dict] = []

        async def fake_execute_tool(tc, filtered_tools):
            captured.append({
                "id": tc["id"],
                "args_at_exec": tc["function"]["arguments"],
                "identity": id(tc),
            })
            return Message(
                role=MessageRole.TOOL,
                content=f"result {tc['id']}",
                type=MessageType.TOOL_RESULT,
                tool_call_id=tc["id"],
            )

        original_execute_tool = llm_client._execute_tool
        llm_client._execute_tool = fake_execute_tool
        try:
            async def response():
                # Two parallel tool_calls, each with complete args at arrival.
                # When the index transition fires maybe_enqueue(0), tc0 is
                # snapshotted. If a later delta mutated tc0's working-buffer
                # entry's args string (in-place `+=`), the executor's snapshot
                # would be unaffected.
                yield chunk(content="Reading two files")
                yield chunk(tool_calls=[tool_delta(0)])
                yield chunk(tool_calls=[tool_delta(1)])
                await asyncio.sleep(0.01)

            messages, api_messages = await self._drive_stream(response)
        finally:
            llm_client._execute_tool = original_execute_tool

        # Both tool_calls executed exactly once each.
        self.assertEqual(len(captured), 2)
        by_id = {c["id"]: c for c in captured}
        self.assertEqual(
            by_id["call-0"]["args_at_exec"], '{"file_path":"README.md"}',
            "call-0 executor saw its correct args",
        )
        self.assertEqual(
            by_id["call-1"]["args_at_exec"], '{"file_path":"README.md"}',
            "call-1 executor saw its correct args",
        )
        # The executor's `tc` reference is a distinct object from the working
        # buffer's entry — i.e. maybe_enqueue snapshotted rather than passing
        # the live reference. (Without the deepcopy, both would be the same
        # object and a later mutation on `function.arguments` would race.)
        anchored = await self._assistant_with_tool_calls(api_messages)
        working_buffer_ids = {id(tc) for tc in anchored["tool_calls"]}
        executor_ids = {c["identity"] for c in captured}
        self.assertEqual(
            working_buffer_ids & executor_ids, set(),
            "executor must not see the live working-buffer object reference",
        )

    async def _drive_stream(self, response, *, execute_tool=None):
        """Run _stream_task + _executor_task against `response` and return
        (messages, api_messages). Mirrors the setup used by the streaming
        tests above; optionally patches _execute_tool."""
        original = llm_client._execute_tool
        if execute_tool is not None:
            llm_client._execute_tool = execute_tool
        try:
            msg_q = asyncio.Queue(maxsize=1)
            ready_q = asyncio.Queue()
            api_messages: list[dict] = []
            assistant_appended = asyncio.Event()
            tool_calls_started = asyncio.Event()

            stream_t = asyncio.create_task(
                llm_client._stream_task(
                    response(), msg_q, ready_q, api_messages,
                    assistant_appended, tool_calls_started,
                )
            )
            executor_t = asyncio.create_task(
                llm_client._executor_task(
                    msg_q, ready_q, api_messages, {}, assistant_appended,
                )
            )

            messages = []
            while True:
                msg = await msg_q.get()
                if msg is None:
                    break
                messages.append(msg)

            await asyncio.gather(stream_t, executor_t)
        finally:
            llm_client._execute_tool = original
        return messages, api_messages

    @staticmethod
    def _placeholder_delta(index: int, *, arguments: str = '{"x":1}'):
        """A tool_call delta that grows the working buffer for `index` but
        carries NO id and NO function.name — exercising the empty-id
        placeholder filtering path."""
        return SimpleNamespace(
            index=index,
            id=None,
            function=SimpleNamespace(name=None, arguments=arguments),
        )

    @staticmethod
    def _none_index_delta(*, call_id: str = "call-0", name: str = "read"):
        """P2-85: a tool_call delta with `index=None` (Anthropic-via-litellm,
        Bedrock adapters). Must be coerced to len(tool_calls), not TypeError."""
        return SimpleNamespace(
            index=None,
            id=call_id,
            function=SimpleNamespace(name=name, arguments='{"file_path":"README.md"}'),
        )

    async def _assistant_with_tool_calls(self, api_messages):
        return next(
            m for m in api_messages
            if m.get("role") == "assistant" and m.get("tool_calls")
        )

    async def test_commit_does_not_mutate_the_raw_tool_calls_buffer(self):
        """Option A step 4: the filter must NOT mutate the shared `tool_calls`
        working buffer in place. Proven behaviorally: an unfilled placeholder
        at index 1 (only `arguments` arrives, never an id/name) is followed by
        a well-formed index 2. The committed assistant message must contain
        exactly [call-0, call-2] in order — the placeholder is filtered out of
        the snapshot AND not appended. If the filter mutated the working list
        in place (removing the placeholder), the growth the anchored message
        aliased would leak the empty-id growth placeholder into the persisted
        message instead. This test directly mirrors the Option A background
        fix (the in-place `tool_calls[:] = [...]` regression)."""
        async def response():
            yield chunk(content="Reading two files, skipping one")
            yield chunk(tool_calls=[tool_delta(0)])
            yield chunk(tool_calls=[self._placeholder_delta(1)])
            yield chunk(tool_calls=[tool_delta(2)])
            await asyncio.sleep(0.01)

        messages, api_messages = await self._drive_stream(response)

        anchored = await self._assistant_with_tool_calls(api_messages)
        ids = [tc.get("id") for tc in anchored["tool_calls"]]
        self.assertEqual(ids, ["call-0", "call-2"],
                         "placeholder filtered; only well-formed ids anchored, in order")

    async def test_commit_filters_out_empty_and_none_id_tool_calls(self):
        """Option A: tool_calls lacking an id (empty string or None) and/or a
        function.name are excluded from the committed/anchored assistant
        message."""
        async def response():
            yield chunk(content="Picking a tool")
            yield chunk(tool_calls=[tool_delta(0)])
            yield chunk(tool_calls=[self._placeholder_delta(1)])
            await asyncio.sleep(0.01)

        messages, api_messages = await self._drive_stream(response)

        anchored = await self._assistant_with_tool_calls(api_messages)
        for tc in anchored["tool_calls"]:
            self.assertTrue(tc.get("id"), f"no empty-id entry should be committed: {tc}")
            self.assertTrue(tc["function"].get("name"),
                           f"no empty-name entry should be committed: {tc}")
        self.assertEqual([tc["id"] for tc in anchored["tool_calls"]], ["call-0"])

    async def test_commit_preserves_valid_tool_calls_in_order(self):
        """Option A: well-formed tool_calls are preserved in arrival order in
        the committed/anchored assistant message."""
        async def response():
            yield chunk(content="Two parallel reads")
            yield chunk(tool_calls=[tool_delta(0)])
            yield chunk(tool_calls=[tool_delta(1)])
            await asyncio.sleep(0.01)

        messages, api_messages = await self._drive_stream(response)

        anchored = await self._assistant_with_tool_calls(api_messages)
        self.assertEqual(
            [tc["id"] for tc in anchored["tool_calls"]],
            ["call-0", "call-1"],
        )
        self.assertEqual(
            [tc["function"]["name"] for tc in anchored["tool_calls"]],
            ["read", "read"],
        )

    async def test_late_arriving_parallel_tool_call_is_appended_to_committed(self):
        """Option A step 3: a parallel tool_call whose index arrives AFTER the
        commit fired (snapshot was taken without it) must be appended to the
        anchored assistant message's committed_tool_calls list so its
        TOOL_RESULT is not orphaned on next-turn replay. This is the focused
        version of test_three_parallel... (also covers test 4)."""
        async def response():
            yield chunk(content="Reading three files")
            yield chunk(tool_calls=[tool_delta(0)])
            yield chunk(tool_calls=[tool_delta(1)])
            yield chunk(tool_calls=[tool_delta(2)])
            await asyncio.sleep(0.01)

        messages, api_messages = await self._drive_stream(response)

        anchored = await self._assistant_with_tool_calls(api_messages)
        self.assertEqual(
            {tc["id"] for tc in anchored["tool_calls"]},
            {"call-0", "call-1", "call-2"},
        )
        # The emitted Message shares the same committed list reference, so the
        # late append must also be visible on the persisted assistant Message.
        emitted = next(
            m for m in messages
            if m.type == MessageType.TEXT and m.tool_calls
        )
        self.assertEqual(
            {tc["id"] for tc in emitted.tool_calls},
            {"call-0", "call-1", "call-2"},
        )

    async def test_empty_id_placeholder_is_never_appended_to_committed(self):
        """Option A: a placeholder that stays malformed (no id/name) must never
        be appended to committed_tool_calls even when later deltas reference
        its index. The delta-loop append guard requires both `id` AND `name`
        to be present."""
        async def response():
            yield chunk(content="Reading then a dead placeholder")
            yield chunk(tool_calls=[tool_delta(0)])
            yield chunk(tool_calls=[self._placeholder_delta(1)])
            yield chunk(tool_calls=[tool_delta(2)])
            await asyncio.sleep(0.01)

        messages, api_messages = await self._drive_stream(response)

        anchored = await self._assistant_with_tool_calls(api_messages)
        ids = [tc.get("id") for tc in anchored["tool_calls"]]
        self.assertEqual(ids, ["call-0", "call-2"],
                         "no empty-id placeholder appended: only call-0 and call-2")
        # And the persisted history replay must pair both tool results.
        emitted = next(
            m for m in messages
            if m.type == MessageType.TEXT and m.tool_calls
        )
        history = [Message(MessageRole.USER, "hello"), emitted]
        for m in messages:
            if m.type == MessageType.TOOL_RESULT:
                history.append(m)
        replayed = llm_client._history_to_api_messages(history)
        tool_msgs = [m for m in replayed if m["role"] == "tool"]
        self.assertEqual(
            {m["tool_call_id"] for m in tool_msgs},
            {"call-0", "call-2"},
        )

    def test_round_trip_persists_tool_calls_through_storage_dict(self):
        """End-to-end: record_streamed_message -> to_storage_dict ->
        from_storage_dict -> _history_to_api_messages must round-trip the
        tool_calls block. A regression that drops tool_calls at any layer
        would otherwise be caught only by the integration test.
        """
        history = []
        state = StreamHistoryState()
        tool_calls = [{"id": "call-0", "type": "function",
                       "function": {"name": "read", "arguments": '{"file_path":"a"}'}}]

        record_streamed_message(
            history,
            Message(MessageRole.ASSISTANT, "checking", MessageType.TEXT, tool_calls=tool_calls),
            state,
        )
        record_streamed_message(
            history,
            Message(MessageRole.TOOL, "result", MessageType.TOOL_RESULT, tool_call_id="call-0"),
            state,
        )

        serialized = [m.to_storage_dict() for m in history]
        restored = [Message.from_storage_dict(d) for d in serialized]

        replayed = llm_client._history_to_api_messages(restored)
        self.assertEqual(replayed[0]["role"], "assistant")
        self.assertEqual(replayed[0]["tool_calls"], tool_calls)
        self.assertEqual(replayed[1]["role"], "tool")
        self.assertEqual(replayed[1]["tool_call_id"], "call-0")

    def test_display_only_tool_call_hint_without_tool_calls_is_dropped(self):
        """Explicit coverage for the bare-TOOL_CALL-display-hint branch."""
        history = [
            Message(MessageRole.USER, "hi"),
            Message(MessageRole.ASSISTANT, "Calling tool: read", MessageType.TOOL_CALL,
                    metadata={"tool_name": "read"}),
            Message(MessageRole.ASSISTANT, "answer", MessageType.TEXT),
        ]
        replayed = llm_client._history_to_api_messages(history)
        self.assertEqual(replayed, [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "answer"},
        ])

    def test_cancelled_tool_calls_block_filtered_out_on_replay(self):
        """When the user cancels before any tool result arrives, the
        persisted assistant message carries unserviced tool_calls. Replay
        must drop those tool_calls so the provider doesn't see a dangling
        tool_calls block (which strict OpenAI providers reject with 400).
        """
        history = [
            Message(MessageRole.USER, "hi"),
            Message(
                MessageRole.ASSISTANT, "", MessageType.TEXT,
                tool_calls=[{"id": "call-9", "type": "function",
                             "function": {"name": "read", "arguments": '{}'}}],
            ),
            Message(MessageRole.ASSISTANT, "[Interrupted by user]", MessageType.TEXT),
        ]
        replayed = llm_client._history_to_api_messages(history)
        # The cancelled assistant entry (no content, no surviving tool_calls) is dropped entirely;
        # only the user message and the "[Interrupted by user]" reply survive replay.
        self.assertEqual(replayed, [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "[Interrupted by user]"},
        ])

    async def test_whitespace_reasoning_is_not_emitted(self):
        async def response():
            yield chunk(reasoning="   ")
            yield chunk(reasoning="\n\n")
            yield chunk(content="Hello")

        msg_q = asyncio.Queue(maxsize=1)
        ready_q = asyncio.Queue()
        api_messages = []
        assistant_appended = asyncio.Event()
        tool_calls_started = asyncio.Event()

        stream_t = asyncio.create_task(
            llm_client._stream_task(
                response(),
                msg_q,
                ready_q,
                api_messages,
                assistant_appended,
                tool_calls_started,
            )
        )
        executor_t = asyncio.create_task(
            llm_client._executor_task(
                msg_q,
                ready_q,
                api_messages,
                {},
                assistant_appended,
            )
        )

        messages = []
        while True:
            msg = await msg_q.get()
            if msg is None:
                break
            messages.append(msg)

        await asyncio.gather(stream_t, executor_t)

        self.assertEqual(
            [(msg.type, msg.content) for msg in messages],
            [(MessageType.TEXT, "Hello")],
        )

    async def test_final_text_message_does_not_duplicate_content(self):
        async def response():
            yield chunk(content="Hello")
            yield chunk(content=" world", usage=Usage(1, 2, 3))

        msg_q = asyncio.Queue(maxsize=1)
        ready_q = asyncio.Queue()
        api_messages = []
        assistant_appended = asyncio.Event()
        tool_calls_started = asyncio.Event()

        stream_t = asyncio.create_task(
            llm_client._stream_task(
                response(),
                msg_q,
                ready_q,
                api_messages,
                assistant_appended,
                tool_calls_started,
            )
        )
        executor_t = asyncio.create_task(
            llm_client._executor_task(
                msg_q,
                ready_q,
                api_messages,
                {},
                assistant_appended,
            )
        )

        messages = []
        while True:
            msg = await msg_q.get()
            if msg is None:
                break
            messages.append(msg)

        await asyncio.gather(stream_t, executor_t)

        text_messages = [msg for msg in messages if msg.type == MessageType.TEXT]
        self.assertEqual(len(text_messages), 3)
        self.assertEqual(text_messages[0].content, "Hello")
        self.assertEqual(text_messages[1].content, "Hello world")
        self.assertEqual(text_messages[2].content, "")
        self.assertEqual(text_messages[2].usage, Usage(1, 2, 3))


class StreamCachedTokensTest(unittest.IsolatedAsyncioTestCase):
    """U2: _stream_task extracts cached_tokens from provider usage shapes."""

    @staticmethod
    def _usage(**kw):
        return SimpleNamespace(
            prompt_tokens=kw.get("prompt_tokens", 0),
            completion_tokens=kw.get("completion_tokens", 0),
            total_tokens=kw.get("total_tokens", 0),
            prompt_tokens_details=kw.get("prompt_tokens_details"),
            cache_read_input_tokens=kw.get("cache_read_input_tokens"),
            cache_creation_input_tokens=kw.get("cache_creation_input_tokens"),
        )

    @staticmethod
    def _drive(response):
        async def _run():
            msg_q = asyncio.Queue(maxsize=1)
            ready_q = asyncio.Queue()
            api_messages: list[dict] = []
            assistant_appended = asyncio.Event()
            tool_calls_started = asyncio.Event()
            stream_t = asyncio.create_task(
                llm_client._stream_task(
                    response(), msg_q, ready_q, api_messages,
                    assistant_appended, tool_calls_started,
                )
            )
            executor_t = asyncio.create_task(
                llm_client._executor_task(
                    msg_q, ready_q, api_messages, {}, assistant_appended,
                )
            )
            messages = []
            while True:
                msg = await msg_q.get()
                if msg is None:
                    break
                messages.append(msg)
            await asyncio.gather(stream_t, executor_t)
            return messages

        return asyncio.run(_run())

    def _final_usage(self, messages):
        usage_msgs = [m for m in messages if m.usage is not None]
        self.assertTrue(usage_msgs, "no message with usage was emitted")
        return usage_msgs[-1].usage

    def test_openai_prompt_tokens_details_cached(self):
        u = self._usage(
            prompt_tokens=1000, completion_tokens=200, total_tokens=1200,
            prompt_tokens_details=SimpleNamespace(cached_tokens=800),
        )

        async def response():
            yield chunk(content="hi", usage=u)

        usage = self._final_usage(self._drive(response))
        self.assertEqual(usage.cached_tokens, 800)
        self.assertEqual(usage.prompt_tokens, 1000)

    def test_anthropic_cache_read_input_tokens(self):
        u = self._usage(
            prompt_tokens=1000, completion_tokens=200, total_tokens=1200,
            cache_read_input_tokens=600,
        )

        async def response():
            yield chunk(content="hi", usage=u)

        usage = self._final_usage(self._drive(response))
        self.assertEqual(usage.cached_tokens, 600)

    def test_anthropic_cache_creation_not_folded(self):
        u = self._usage(
            prompt_tokens=1000, completion_tokens=200, total_tokens=1200,
            cache_creation_input_tokens=500,
        )

        async def response():
            yield chunk(content="hi", usage=u)

        usage = self._final_usage(self._drive(response))
        self.assertEqual(usage.cached_tokens, 0,
                         "cache_creation_input_tokens must NOT be folded into cached_tokens")

    def test_absent_cache_fields_default_zero(self):
        u = self._usage(
            prompt_tokens=1000, completion_tokens=200, total_tokens=1200,
        )

        async def response():
            yield chunk(content="hi", usage=u)

        usage = self._final_usage(self._drive(response))
        self.assertEqual(usage.cached_tokens, 0)

    def test_positional_usage_still_defaults_cached_zero(self):
        async def response():
            yield chunk(content="hi", usage=Usage(1, 2, 3))

        usage = self._final_usage(self._drive(response))
        self.assertEqual(usage, Usage(1, 2, 3, 0))
        self.assertEqual(usage.cached_tokens, 0)

    def test_prompt_tokens_details_takes_precedence_over_cache_read(self):
        # When both provider shapes are present on the same usage object,
        # prompt_tokens_details.cached_tokens (OpenAI) wins over
        # cache_read_input_tokens (Anthropic) per the `if cached is None:`
        # fallback chain in _stream_task.
        u = self._usage(
            prompt_tokens=1000, completion_tokens=200, total_tokens=1200,
            prompt_tokens_details=SimpleNamespace(cached_tokens=800),
            cache_read_input_tokens=600,
        )

        async def response():
            yield chunk(content="hi", usage=u)

        usage = self._final_usage(self._drive(response))
        self.assertEqual(usage.cached_tokens, 800,
                         "prompt_tokens_details must take precedence")

    def test_prompt_tokens_details_zero_takes_precedence_over_cache_read(self):
        # An explicitly set cached_tokens=0 on prompt_tokens_details (OpenAI)
        # must NOT fall back to cache_read_input_tokens (Anthropic): the
        # provider explicitly reported zero cached reads.
        u = self._usage(
            prompt_tokens=1000, completion_tokens=200, total_tokens=1200,
            prompt_tokens_details=SimpleNamespace(cached_tokens=0),
            cache_read_input_tokens=600,
        )

        async def response():
            yield chunk(content="hi", usage=u)

        usage = self._final_usage(self._drive(response))
        self.assertEqual(usage.cached_tokens, 0,
                         "explicit cached_tokens=0 must not trigger fallback")


class StreamWidgetTest(unittest.IsolatedAsyncioTestCase):
    def test_tool_result_without_display_uses_safe_collapsed_title(self):
        raw_content = "x" * 300
        widget = message_widget.ToolResultMessageWidget(
            Message(MessageRole.TOOL, raw_content, MessageType.TOOL_RESULT)
        )

        collapsible = next(widget.compose())

        self.assertEqual(collapsible.title, "Tool result")

    def test_tool_result_display_title_is_one_line_and_bounded(self):
        widget = message_widget.ToolResultMessageWidget(
            Message(
                MessageRole.TOOL,
                "content",
                MessageType.TOOL_RESULT,
                display=f"Read README.md\n{'x' * 300}",
            )
        )

        collapsible = next(widget.compose())

        self.assertNotIn("\n", collapsible.title)
        self.assertLessEqual(len(collapsible.title), 120)
        self.assertTrue(collapsible.title.endswith("..."))

    def test_edit_tool_result_renders_compact_colored_diff(self):
        rendered = message_widget.get_tool_result_renderable(
            Message(
                MessageRole.TOOL,
                '<edit_result path="demo.py" success="true" replacements="1" '
                'replace_all="false" added="2" removed="1">\n'
                '<diff format="unified"><![CDATA[\n'
                "--- old/demo.py\n"
                "+++ new/demo.py\n"
                "@@ -1,3 +1,4 @@\n"
                " def alpha():\n"
                "-    return 1\n"
                "+    return 2\n"
                "+class Gamma:\n"
                "     pass\n"
                "]]></diff>\n"
                "</edit_result>",
                MessageType.TOOL_RESULT,
                display="Edited demo.py (+2 -1)",
            )
        )

        self.assertIn("   1  def alpha():\n", rendered.plain)
        self.assertIn("   2 -    return 1\n", rendered.plain)
        self.assertIn("   2 +    return 2\n", rendered.plain)
        self.assertIn("   3 +class Gamma:\n", rendered.plain)
        self.assertNotIn("@@", rendered.plain)
        self.assertNotIn("--- old/demo.py", rendered.plain)

        styles = {span.style for span in rendered.spans}
        self.assertIn(message_widget._DIFF_ADDED_STYLE, styles)
        self.assertIn(message_widget._DIFF_REMOVED_STYLE, styles)
        self.assertTrue(any(getattr(span.style, "color", None) is not None for span in rendered.spans))

    async def test_output_pane_hides_horizontal_overflow(self):
        from stupidex.app import Stupidex

        app = Stupidex()
        async with app.run_test():
            output = app.query_one("#output")

            self.assertEqual(output.styles.overflow_x, "hidden")
            self.assertEqual(output.styles.overflow_y, "auto")

    async def test_streamed_tool_result_group_has_spacing_after_thinking(self):
        from stupidex.app import Stupidex

        tool_results = [
            Message(
                MessageRole.TOOL,
                f"file contents {i}",
                MessageType.TOOL_RESULT,
                display=f"Read file_{i}.py lines 1-10",
            )
            for i in range(3)
        ]
        app = Stupidex()
        async with app.run_test(size=(100, 30)) as pilot:
            output = app.query_one("#output")
            state = message_widget.StreamWidgetState()

            await message_widget.mount_streamed_message(
                output,
                Message(MessageRole.USER, "Explore this codebase"),
                state,
            )
            await message_widget.mount_streamed_message(
                output,
                Message(MessageRole.ASSISTANT, "Checking the file", MessageType.THINKING),
                state,
            )
            await message_widget.mount_streamed_message(
                output,
                Message(
                    MessageRole.ASSISTANT,
                    "",
                    MessageType.TOOL_CALL,
                    metadata={"tool_name": "read"},
                ),
                state,
            )
            for _ in tool_results[1:]:
                await message_widget.mount_streamed_message(
                    output,
                    Message(
                        MessageRole.ASSISTANT,
                        "",
                        MessageType.TOOL_CALL,
                        metadata={"tool_name": "read"},
                    ),
                    state,
                )
            for result in tool_results:
                await message_widget.mount_streamed_message(output, result, state)
            await pilot.pause()

            user_widget = output.children[0]
            thinking_widget = output.children[1]
            tool_result_widgets = output.children[2:5]
            thinking_collapse = thinking_widget.query_one(".thinking-collapse")

            self.assertEqual(thinking_widget.region.y, user_widget.region.y + user_widget.region.height + 1)
            self.assertEqual(thinking_widget.region.y, thinking_collapse.region.y)
            self.assertEqual(thinking_widget.region.height, thinking_collapse.region.height)
            self.assertIn("after-thinking", tool_result_widgets[0].classes)
            self.assertEqual(
                tool_result_widgets[0].region.y,
                thinking_collapse.region.y + thinking_collapse.region.height + 1,
            )
            for previous, current in zip(tool_result_widgets, tool_result_widgets[1:], strict=False):
                self.assertNotIn("after-thinking", current.classes)
                self.assertEqual(current.region.y, previous.region.y + previous.region.height)

            await message_widget.mount_streamed_message(
                output,
                Message(MessageRole.ASSISTANT, "Checking another file", MessageType.THINKING),
                state,
            )
            await pilot.pause()

            next_thinking_widget = output.children[5]
            last_tool_result_widget = tool_result_widgets[-1]
            self.assertEqual(
                next_thinking_widget.region.y,
                last_tool_result_widget.region.y + last_tool_result_widget.region.height + 1,
            )

    async def test_streamed_tool_result_after_assistant_text_does_not_get_thinking_spacing(self):
        from stupidex.app import Stupidex

        app = Stupidex()
        async with app.run_test(size=(100, 30)) as pilot:
            output = app.query_one("#output")
            state = message_widget.StreamWidgetState()

            await message_widget.mount_streamed_message(
                output,
                Message(MessageRole.ASSISTANT, "Checking the file", MessageType.THINKING),
                state,
            )
            await message_widget.mount_streamed_message(
                output,
                Message(MessageRole.ASSISTANT, "Let me read the key files.", MessageType.TEXT),
                state,
            )
            await message_widget.mount_streamed_message(
                output,
                Message(
                    MessageRole.ASSISTANT,
                    "",
                    MessageType.TOOL_CALL,
                    metadata={"tool_name": "read"},
                ),
                state,
            )
            await message_widget.mount_streamed_message(
                output,
                Message(
                    MessageRole.TOOL,
                    "file contents",
                    MessageType.TOOL_RESULT,
                    display="Read README.md lines 1-10",
                ),
                state,
            )
            await pilot.pause()

            assistant_widget = output.children[1]
            tool_result_widget = output.children[2]

            self.assertNotIn("after-thinking", tool_result_widget.classes)
            self.assertEqual(tool_result_widget.region.y, assistant_widget.region.y + assistant_widget.region.height)

    async def test_thinking_flushes_before_first_assistant_text_widget_mount(self):
        events = []

        class FakeThinking:
            def flush(self):
                events.append("flush")

            def finish(self):
                events.append("finish")

        class FakeAssistantWidget:
            def __init__(self, msg):
                self.msg = msg

            def scroll_visible(self, animate=True):
                pass

        class FakeContainer:
            async def mount(self, widget):
                events.append("mount")
                self.widget = widget

        container = FakeContainer()
        state = message_widget.StreamWidgetState(thinking=FakeThinking())

        with patch.object(message_widget, "AssistantMessageWidget", FakeAssistantWidget):
            await message_widget.mount_streamed_message(
                container,
                Message(MessageRole.ASSISTANT, "Hi!", MessageType.TEXT),
                state,
            )

        self.assertEqual(events, ["finish", "mount"])
        self.assertIs(state.content, container.widget)


class ClassifyErrorTest(unittest.TestCase):
    def test_authentication_error(self):
        exc = litellm.AuthenticationError(
            message="Invalid API key", llm_provider="openai", model="gpt-4"
        )
        title, detail = classify_error(exc)
        self.assertEqual(title, "Authentication Failed")
        self.assertIn("API key", detail)

    def test_rate_limit_error(self):
        exc = litellm.RateLimitError(
            message="Rate limit", llm_provider="openai", model="gpt-4"
        )
        title, detail = classify_error(exc)
        self.assertEqual(title, "Rate Limit Exceeded")
        self.assertIn("wait", detail)

    def test_api_connection_error(self):
        exc = litellm.APIConnectionError(
            message="Connection refused", llm_provider="openai", model="gpt-4"
        )
        title, detail = classify_error(exc)
        self.assertEqual(title, "Connection Failed")
        self.assertIn("network", detail.lower())

    def test_bad_request_error(self):
        exc = litellm.BadRequestError(
            message="Invalid model", llm_provider="openai", model="bad-model"
        )
        title, detail = classify_error(exc)
        self.assertEqual(title, "Invalid Request")
        self.assertIn("Invalid model", detail)

    def test_generic_api_error(self):
        exc = litellm.APIError(
            status_code=500,
            message="Server error",
            llm_provider="openai",
            model="gpt-4",
        )
        title, detail = classify_error(exc)
        self.assertEqual(title, "API Error")
        self.assertIn("Server error", detail)

    def test_timeout_error(self):
        exc = httpx.TimeoutException("Connection timed out")
        title, detail = classify_error(exc)
        self.assertEqual(title, "Request Timed Out")

    def test_http_error(self):
        exc = httpx.HTTPError("Bad gateway")
        title, detail = classify_error(exc)
        self.assertEqual(title, "HTTP Error")
        self.assertIn("Bad gateway", detail)

    def test_generic_exception(self):
        exc = RuntimeError("something broke")
        title, detail = classify_error(exc)
        self.assertEqual(title, "Unexpected Error")
        self.assertIn("something broke", detail)

    def test_error_messages_excluded_from_api_history(self):
        history = [
            Message(MessageRole.USER, "hello"),
            Message(MessageRole.ASSISTANT, "answer", MessageType.TEXT),
            Message(
                MessageRole.ASSISTANT,
                "Invalid API key",
                MessageType.ERROR,
                metadata={"error_title": "Authentication Failed"},
            ),
        ]
        api_messages = llm_client._history_to_api_messages(history)
        self.assertEqual(
            api_messages,
            [
                {"role": "user", "content": "hello"},
                {"role": "assistant", "content": "answer"},
            ],
        )

    def test_error_messages_pass_through_record_streamed_message(self):
        history = []
        state = StreamHistoryState()
        error_msg = Message(
            MessageRole.ASSISTANT,
            "Invalid API key",
            MessageType.ERROR,
            metadata={"error_title": "Authentication Failed"},
        )
        result = record_streamed_message(history, error_msg, state)
        self.assertTrue(result)
        self.assertEqual(len(history), 1)
        self.assertEqual(history[0].type, MessageType.ERROR)

    def test_timeout_error_is_classified(self):
        exc = litellm.Timeout(
            message="Request timed out", llm_provider="openai", model="gpt-4"
        )
        title, detail = classify_error(exc)
        self.assertEqual(title, "Request Timed Out")
        self.assertIn("time", detail.lower())

    def test_internal_server_error_is_classified(self):
        exc = litellm.InternalServerError(
            message="Internal error", llm_provider="openai", model="gpt-4"
        )
        title, detail = classify_error(exc)
        self.assertEqual(title, "Server Error")
        self.assertIn("Internal error", detail)

    def test_service_unavailable_error_is_classified(self):
        exc = litellm.ServiceUnavailableError(
            message="Service down", llm_provider="openai", model="gpt-4"
        )
        title, detail = classify_error(exc)
        self.assertEqual(title, "Service Unavailable")

    def test_provider_resolution_error_is_classified(self):
        exc = ProviderResolutionError("Unknown provider alias 'nope'")
        title, detail = classify_error(exc)
        self.assertEqual(title, "Unknown Provider")
        self.assertIn("alias", detail)

    def test_provider_resolution_error_with_empty_message_uses_type_name(self):
        exc = ProviderResolutionError("")
        title, detail = classify_error(exc)
        self.assertEqual(title, "Unknown Provider")
        self.assertIn("ProviderResolutionError", detail)

    def test_bad_gateway_error_is_classified(self):
        exc = litellm.BadGatewayError(
            message="Bad gateway", llm_provider="openai", model="gpt-4"
        )
        title, detail = classify_error(exc)
        self.assertEqual(title, "Bad Gateway")
        self.assertIn("Bad gateway", detail)


class ClassifyErrorLadderTest(unittest.TestCase):
    """P2-103 + P3-56 -- exhaustive coverage of the classify_error exception-type
    ladder. Each branch must map to its exact (title, detail) contract so future
    re-ordering of the isinstance chain is caught."""

    def _litellm_kwargs(self, exc_cls, **extra):
        kwargs = {"message": "boom", "llm_provider": "openai", "model": "gpt-4"}
        kwargs.update(extra)
        return exc_cls(**kwargs)

    def test_provider_resolution_error_branch(self):
        title, _ = classify_error(ProviderResolutionError("alias 'x' unknown"))
        self.assertEqual(title, "Unknown Provider")

    def test_authentication_error_branch(self):
        title, _ = classify_error(
            self._litellm_kwargs(litellm.AuthenticationError)
        )
        self.assertEqual(title, "Authentication Failed")

    def test_rate_limit_error_branch(self):
        title, _ = classify_error(self._litellm_kwargs(litellm.RateLimitError))
        self.assertEqual(title, "Rate Limit Exceeded")

    def test_timeout_branch(self):
        title, _ = classify_error(self._litellm_kwargs(litellm.Timeout))
        self.assertEqual(title, "Request Timed Out")

    def test_api_connection_error_branch(self):
        title, _ = classify_error(
            self._litellm_kwargs(litellm.APIConnectionError)
        )
        self.assertEqual(title, "Connection Failed")

    def test_bad_request_error_branch(self):
        title, _ = classify_error(self._litellm_kwargs(litellm.BadRequestError))
        self.assertEqual(title, "Invalid Request")

    def test_internal_server_error_branch(self):
        title, _ = classify_error(
            self._litellm_kwargs(litellm.InternalServerError)
        )
        self.assertEqual(title, "Server Error")

    def test_service_unavailable_error_branch(self):
        title, _ = classify_error(
            self._litellm_kwargs(litellm.ServiceUnavailableError)
        )
        self.assertEqual(title, "Service Unavailable")

    def test_bad_gateway_error_branch(self):
        title, _ = classify_error(self._litellm_kwargs(litellm.BadGatewayError))
        self.assertEqual(title, "Bad Gateway")

    def test_generic_api_error_branch(self):
        exc = litellm.APIError(
            status_code=500, message="boom",
            llm_provider="openai", model="gpt-4",
        )
        title, _ = classify_error(exc)
        self.assertEqual(title, "API Error")

    def test_httpx_timeout_branch(self):
        title, _ = classify_error(httpx.TimeoutException("t"))
        self.assertEqual(title, "Request Timed Out")

    def test_httpx_http_error_branch(self):
        title, _ = classify_error(httpx.HTTPError("h"))
        self.assertEqual(title, "HTTP Error")

    def test_generic_exception_branch(self):
        title, _ = classify_error(RuntimeError("unexpected"))
        self.assertEqual(title, "Unexpected Error")


class HistoryToApiMessagesInvariantTest(unittest.TestCase):
    """P2-104 + P3-55 -- _history_to_api_messages ordering + orphan invariants
    that the prior tests did not exercise directly."""

    def test_thinking_between_tool_calls_and_tool_result_preserved_in_order(self):
        """P2-104: a THINKING chunk arriving between an assistant tool_calls
        block and its matching TOOL_RESULT must be preserved in message order
        AND must NOT break the tool_call/tool_result pairing."""
        tool_calls = [{"id": "call-0", "type": "function",
                       "function": {"name": "read", "arguments": '{"file_path":"a"}'}}]
        history = [
            Message(MessageRole.USER, "hi"),
            Message(MessageRole.ASSISTANT, "Let me check", MessageType.TEXT, tool_calls=tool_calls),
            Message(MessageRole.ASSISTANT, "Reasoning mid-flight", MessageType.THINKING),
            Message(MessageRole.TOOL, "contents", MessageType.TOOL_RESULT, tool_call_id="call-0"),
            Message(MessageRole.ASSISTANT, "final", MessageType.TEXT),
        ]
        replayed = llm_client._history_to_api_messages(history)
        roles = [m["role"] for m in replayed]
        self.assertEqual(
            roles, ["user", "assistant", "assistant", "tool", "assistant"]
        )
        thinking_msg = next(m for m in replayed if m["role"] == "assistant" and m.get("content") == "Reasoning mid-flight")
        tool_msg = next(m for m in replayed if m["role"] == "tool")
        self.assertEqual(thinking_msg["content"], "Reasoning mid-flight")
        self.assertEqual(tool_msg["tool_call_id"], "call-0")
        assistant_with_calls = next(
            m for m in replayed
            if m["role"] == "assistant" and m.get("tool_calls")
        )
        self.assertEqual([tc["id"] for tc in assistant_with_calls["tool_calls"]], ["call-0"])

    def test_orphan_tool_call_with_no_matching_result_is_filtered(self):
        """P3-55: an assistant tool_calls block whose id never receives a
        TOOL_RESULT is filtered (dangling tool_calls removed), and if the
        assistant message has no content it is dropped entirely."""
        history = [
            Message(MessageRole.USER, "hi"),
            Message(
                MessageRole.ASSISTANT, "", MessageType.TEXT,
                tool_calls=[{"id": "call-9", "type": "function",
                             "function": {"name": "read", "arguments": '{}'}}],
            ),
            Message(MessageRole.ASSISTANT, "after", MessageType.TEXT),
        ]
        replayed = llm_client._history_to_api_messages(history)
        self.assertEqual(replayed, [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "after"},
        ])

    def test_tool_result_with_no_preceding_tool_calls_is_dropped(self):
        """P3-55: a TOOL_RESULT whose tool_call_id was never announced by a
        preceding assistant tool_calls block is an orphan and must be dropped
        (no exception raised)."""
        history = [
            Message(MessageRole.USER, "hi"),
            Message(MessageRole.TOOL, "stray", MessageType.TOOL_RESULT, tool_call_id="call-7"),
            Message(MessageRole.ASSISTANT, "ok", MessageType.TEXT),
        ]
        replayed = llm_client._history_to_api_messages(history)
        self.assertEqual(replayed, [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "ok"},
        ])

    def test_tool_calls_with_content_survives_when_result_orphaned(self):
        """P3-55 variant: an assistant tool_calls block with content but no
        matching TOOL_RESULT keeps its content but loses the tool_calls field
        on replay (strict providers reject dangling tool_calls)."""
        history = [
            Message(MessageRole.USER, "hi"),
            Message(
                MessageRole.ASSISTANT, "Thinking out loud", MessageType.TEXT,
                tool_calls=[{"id": "call-9", "type": "function",
                             "function": {"name": "read", "arguments": '{}'}}],
            ),
            Message(MessageRole.ASSISTANT, "done", MessageType.TEXT),
        ]
        replayed = llm_client._history_to_api_messages(history)
        self.assertEqual(replayed, [
            {"role": "user", "content": "hi"},
            {"role": "assistant", "content": "Thinking out loud"},
            {"role": "assistant", "content": "done"},
        ])


class StreamResponseProviderResolutionTest(unittest.IsolatedAsyncioTestCase):
    """U3 -- stream_response resolves `alias/model` via resolve_model_ref
    and passes resolved base_url + api_key through to litellm.acompletion."""

    async def _drive_stream_response(self, *, model, providers, env=None):
        """Invoke stream_response with mocked deps; return captured acompletion kwargs.

        Patches litellm.acompletion to record kwargs and yield a single chunk with
        usage that lets the loop exit cleanly (no tool calls -> early return).
        """
        cfg = Config(providers=providers)

        captured: dict = {}

        async def fake_acompletion(**kwargs):
            captured.update(kwargs)

            async def _stream():
                yield chunk(content="hi", usage=Usage(1, 2, 3))

            return _stream()

        dummy_dynamic = Message(MessageRole.SYSTEM, "<dynamic/>", MessageType.TEXT)

        env_patches = []
        if env:
            for k, v in env.items():
                env_patches.append(patch.dict(os.environ, {k: v}, clear=False))

        acompletion_mock = AsyncMock(side_effect=fake_acompletion)
        with patch("stupidex.llm.client.get_config", return_value=cfg), \
                patch("stupidex.llm.providers.get_config", return_value=cfg), \
                patch("stupidex.llm.client.build_dynamic_system_prompt",
                      new=AsyncMock(return_value=dummy_dynamic)), \
                patch("stupidex.llm.client.get_tool_registry", return_value={}), \
                patch("stupidex.llm.client.litellm.acompletion", new=acompletion_mock):
            stack = contextlib.ExitStack()
            for p in env_patches:
                stack.enter_context(p)
            with stack:
                gen = llm_client.stream_response(
                    messages=[],
                    model=model,
                    allowed_tools=[],
                    system_prompt="",
                )
                async for _ in gen:
                    pass

        return captured

    async def test_resolves_alias_model_and_passes_tuple_to_acompletion(self):
        providers = {
            "default": {
                "base_url": "https://opencode.ai/zen/go/v1",
                "litellm_provider": "openai",
                "models": {"mimo-v2.5": {}},
            }
        }
        captured = await self._drive_stream_response(
            model="default/mimo-v2.5", providers=providers
        )

        self.assertEqual(captured["model"], "openai/mimo-v2.5")
        self.assertEqual(captured["base_url"], "https://opencode.ai/zen/go/v1")
        self.assertIsNone(captured["api_key"])

    async def test_passes_literal_api_key(self):
        providers = {
            "default": {
                "base_url": "https://example.test/v1",
                "litellm_provider": "openai",
                "api_key": "sk-test-123",
                "models": {"mimo-v2.5": {}},
            }
        }
        captured = await self._drive_stream_response(
            model="default/mimo-v2.5", providers=providers
        )

        self.assertEqual(captured["model"], "openai/mimo-v2.5")
        self.assertEqual(captured["base_url"], "https://example.test/v1")
        self.assertEqual(captured["api_key"], "sk-test-123")

    async def test_passes_api_key_env_value_when_set(self):
        providers = {
            "default": {
                "base_url": "https://example.test/v1",
                "litellm_provider": "openai",
                "api_key_env": "STUPIDEX_TEST_OPENAI_KEY",
                "models": {"mimo-v2.5": {}},
            }
        }
        captured = await self._drive_stream_response(
            model="default/mimo-v2.5",
            providers=providers,
            env={"STUPIDEX_TEST_OPENAI_KEY": "env-key-456"},
        )

        self.assertEqual(captured["api_key"], "env-key-456")

    async def test_bare_model_id_when_litellm_provider_unset(self):
        providers = {
            "custom": {
                "base_url": "https://example.test/v1",
                "models": {"my-model-id": {}},
            }
        }
        captured = await self._drive_stream_response(
            model="custom/my-model-id", providers=providers
        )

        self.assertEqual(captured["model"], "my-model-id")
        self.assertEqual(captured["base_url"], "https://example.test/v1")
        self.assertIsNone(captured["api_key"])

    async def test_routes_distinct_alias_to_correct_provider_covers_f3(self):
        providers = {
            "default": {
                "base_url": "https://default.test/v1",
                "litellm_provider": "openai",
                "models": {"mimo-v2.5": {}},
            },
            "work": {
                "base_url": "https://work.test/v1",
                "litellm_provider": "openai",
                "api_key": "sk-work-key",
                "models": {"gpt-4o": {}},
            },
        }
        captured_default = await self._drive_stream_response(
            model="default/mimo-v2.5", providers=providers
        )
        captured_work = await self._drive_stream_response(
            model="work/gpt-4o", providers=providers
        )

        self.assertEqual(captured_default["base_url"], "https://default.test/v1")
        self.assertIsNone(captured_default["api_key"])
        self.assertEqual(captured_default["model"], "openai/mimo-v2.5")

        self.assertEqual(captured_work["base_url"], "https://work.test/v1")
        self.assertEqual(captured_work["api_key"], "sk-work-key")
        self.assertEqual(captured_work["model"], "openai/gpt-4o")

    async def test_provider_resolution_failure_raises_before_a_completion(self):
        """An unknown alias -> ProviderResolutionError surfaces from stream_response.

        resolve_model_ref runs before the first litellm.acompletion call, so
        acompletion must not be invoked at all.
        """
        cfg = Config(providers={"default": {
            "base_url": "https://example.test/v1",
            "litellm_provider": "openai",
            "models": {"mimo-v2.5": {}},
        }})

        acompletion_mock = AsyncMock()

        with patch("stupidex.llm.client.get_config", return_value=cfg), \
                patch("stupidex.llm.providers.get_config", return_value=cfg), \
                patch("stupidex.llm.client.build_dynamic_system_prompt",
                      new=AsyncMock(return_value=Message(
                          MessageRole.SYSTEM, "<dynamic/>", MessageType.TEXT))), \
                patch("stupidex.llm.client.get_tool_registry", return_value={}), \
                patch("stupidex.llm.client.litellm.acompletion", new=acompletion_mock):
            gen = llm_client.stream_response(
                messages=[],
                model="typo-alias/mimo-v2.5",
                allowed_tools=[],
                system_prompt="",
            )
            with self.assertRaises(ProviderResolutionError):
                async for _ in gen:
                    pass

        acompletion_mock.assert_not_called()


class StreamIdleTimeoutTest(unittest.IsolatedAsyncioTestCase):
    """P0-5 -- stream_response wraps the LLM stream in an idle-timeout retry
    loop. The timeout measures time-since-last-delta-received (reset on every
    chunk) and does not fire while a stream keeps producing, even if the total
    stream duration exceeds the idle deadline. On a silent stall, the call is
    retried up to ``cfg.llm_stream_retries`` times; on exhaustion the error
    propagates to the caller so the subagent's ``_run`` records it.
    """

    def _providers(self):
        return {
            "default": {
                "base_url": "https://example.test/v1",
                "litellm_provider": "openai",
                "models": {"mimo-v2.5": {}},
            }
        }

    def _run_stream_response(self, *, cfg, fake_acompletion):
        acompletion_mock = AsyncMock(side_effect=fake_acompletion)
        dummy_dynamic = Message(MessageRole.SYSTEM, "<dynamic/>", MessageType.TEXT)
        patches = [
            patch("stupidex.llm.client.get_config", return_value=cfg),
            patch("stupidex.llm.providers.get_config", return_value=cfg),
            patch("stupidex.llm.client.build_dynamic_system_prompt",
                  new=AsyncMock(return_value=dummy_dynamic)),
            patch("stupidex.llm.client.get_tool_registry", return_value={}),
            patch("stupidex.llm.client.litellm.acompletion", new=acompletion_mock),
            patch("stupidex.llm.client._backoff_sleep", new=AsyncMock()),
        ]
        stack = contextlib.ExitStack()
        for p in patches:
            stack.enter_context(p)
        stack.__enter__()
        gen = llm_client.stream_response(
            messages=[],
            model="default/mimo-v2.5",
            allowed_tools=[],
            system_prompt="",
        )
        return stack, gen

    async def test_stream_idle_timeout_retries_on_silent_stall(self):
        cfg = Config(
            providers=self._providers(),
            llm_stream_idle_timeout=0.05,
            llm_stream_retries=2,
        )
        call_count = {"n": 0}

        async def fake_acompletion(**kwargs):
            call_count["n"] += 1

            async def _stream():
                await asyncio.sleep(10)  # silent stall: never yields
                yield chunk(content="unreachable")

            return _stream()

        stack, gen = self._run_stream_response(cfg=cfg, fake_acompletion=fake_acompletion)
        try:
            with self.assertRaises(llm_client._StreamIdleTimeoutError):
                async for _ in gen:
                    pass
        finally:
            stack.__exit__(None, None, None)
            await gen.aclose()

        self.assertEqual(call_count["n"], cfg.llm_stream_retries + 1)

    async def test_stream_resets_timer_on_each_delta(self):
        cfg = Config(
            providers=self._providers(),
            llm_stream_idle_timeout=0.2,
            llm_stream_retries=3,
        )
        call_count = {"n": 0}

        async def fake_acompletion(**kwargs):
            call_count["n"] += 1

            async def _stream():
                for i in range(5):
                    await asyncio.sleep(0.05)  # < idle_timeout (0.2) per gap
                    yield chunk(
                        content=f"seg{i}",
                        usage=Usage(1, 2, 3) if i == 4 else None,
                    )

            return _stream()

        stack, gen = self._run_stream_response(cfg=cfg, fake_acompletion=fake_acompletion)
        try:
            messages = []
            async for msg in gen:
                messages.append(msg)
        finally:
            stack.__exit__(None, None, None)

        self.assertEqual(call_count["n"], 1, "no retry should occur while the stream keeps producing")
        text_messages = [m for m in messages if m.type == MessageType.TEXT]
        self.assertTrue(text_messages, "stream must emit assistant text messages")
        non_empty = [m for m in text_messages if m.content]
        last_content = non_empty[-1].content if non_empty else None
        self.assertTrue(
            non_empty and non_empty[-1].content.endswith("seg4"),
            "stream must complete normally with all deltas appended; "
            "last non-empty content was " + repr(last_content),
        )
        self.assertTrue(
            any(m.usage == Usage(1, 2, 3) for m in text_messages),
            "usage from the final delta must be carried through",
        )


class StreamRetryRollbackTest(unittest.IsolatedAsyncioTestCase):
    """U1/U2 -- stream_response retry loop snapshots ``api_messages`` length
    before each attempt and rolls back appended entries on retry.  If any
    message has already been yielded to the consumer (``delivered_any``),
    retry is skipped to avoid duplicate / partial output.  Connect-timeout
    and transient provider errors are retried the same way as idle timeouts.
    """

    def _providers(self):
        return {
            "default": {
                "base_url": "https://example.test/v1",
                "litellm_provider": "openai",
                "models": {"mimo-v2.5": {}},
            }
        }

    def _run_stream_response(self, *, cfg, fake_acompletion):
        acompletion_mock = AsyncMock(side_effect=fake_acompletion)
        dummy_dynamic = Message(MessageRole.SYSTEM, "<dynamic/>", MessageType.TEXT)
        patches = [
            patch("stupidex.llm.client.get_config", return_value=cfg),
            patch("stupidex.llm.providers.get_config", return_value=cfg),
            patch("stupidex.llm.client.build_dynamic_system_prompt",
                  new=AsyncMock(return_value=dummy_dynamic)),
            patch("stupidex.llm.client.get_tool_registry", return_value={}),
            patch("stupidex.llm.client.litellm.acompletion", new=acompletion_mock),
            patch("stupidex.llm.client._backoff_sleep", new=AsyncMock()),
        ]
        stack = contextlib.ExitStack()
        for p in patches:
            stack.enter_context(p)
        stack.__enter__()
        gen = llm_client.stream_response(
            messages=[],
            model="default/mimo-v2.5",
            allowed_tools=[],
            system_prompt="",
        )
        return stack, gen

    async def test_idle_retry_restores_api_messages(self):
        """After a stream-idle timeout + retry, ``api_messages`` must not
        contain any pollution from the failed attempt.  The silent-stall case
        (no chunks delivered, ``delivered_any`` stays False) exercises the
        rollback path even though nothing was appended — the key assertion is
        that the second attempt sees a clean ``api_messages``."""
        cfg = Config(
            providers=self._providers(),
            llm_stream_idle_timeout=0.05,
            llm_stream_retries=1,
        )
        call_count = {"n": 0}
        captured_msg_counts: list[int] = []

        async def fake_acompletion(**kwargs):
            call_count["n"] += 1
            # Record how many messages are in api_messages at call time.
            captured_msg_counts.append(len(kwargs["messages"]))
            if call_count["n"] == 1:
                # Silent stall: never yields any chunk.
                async def _stream1():
                    await asyncio.sleep(10)
                    yield chunk(content="unreachable")

                return _stream1()
            # Second attempt: succeed immediately.
            async def _stream2():
                yield chunk(content="recovered", usage=Usage(1, 2, 3))

            return _stream2()

        stack, gen = self._run_stream_response(cfg=cfg, fake_acompletion=fake_acompletion)
        try:
            messages = []
            async for msg in gen:
                messages.append(msg)
        finally:
            stack.__exit__(None, None, None)

        self.assertEqual(call_count["n"], 2, "should have retried once")
        # Both attempts should see the same number of messages in api_messages
        # (system + dynamic prompt). If rollback failed, the second attempt
        # would see extra entries.
        self.assertEqual(
            captured_msg_counts[0], captured_msg_counts[1],
            "api_messages length must be identical on both attempts (rollback works)",
        )

    async def test_no_retry_after_partial_delivery(self):
        """If messages have been yielded to the consumer before the idle
        timeout fires, retry must NOT occur (``delivered_any`` gate)."""
        cfg = Config(
            providers=self._providers(),
            llm_stream_idle_timeout=0.05,
            llm_stream_retries=3,
        )
        call_count = {"n": 0}

        async def fake_acompletion(**kwargs):
            call_count["n"] += 1

            async def _stream():
                yield chunk(content="delivered")
                await asyncio.sleep(10)

            return _stream()

        stack, gen = self._run_stream_response(cfg=cfg, fake_acompletion=fake_acompletion)
        try:
            with self.assertRaises(llm_client._StreamIdleTimeoutError):
                async for _ in gen:
                    pass
        finally:
            stack.__exit__(None, None, None)
            await gen.aclose()

        self.assertEqual(
            call_count["n"], 1,
            "must NOT retry after partial delivery",
        )

    async def test_connect_timeout_retries(self):
        """If litellm.acompletion hangs (connect timeout), asyncio.wait_for
        fires and the call is retried."""
        cfg = Config(
            providers=self._providers(),
            llm_stream_idle_timeout=0.05,
            llm_stream_retries=1,
        )
        call_count = {"n": 0}

        async def fake_acompletion(**kwargs):
            call_count["n"] += 1
            if call_count["n"] == 1:
                await asyncio.sleep(10)  # hangs on connect
            async def _stream():
                yield chunk(content="ok", usage=Usage(1, 2, 3))
            return _stream()

        stack, gen = self._run_stream_response(cfg=cfg, fake_acompletion=fake_acompletion)
        try:
            messages = []
            async for msg in gen:
                messages.append(msg)
        finally:
            stack.__exit__(None, None, None)

        self.assertEqual(call_count["n"], 2, "should have retried after connect timeout")

    async def test_transient_error_retries(self):
        """A transient provider error (e.g. ServiceUnavailableError) from
        acompletion should be retried."""
        cfg = Config(
            providers=self._providers(),
            llm_stream_idle_timeout=5.0,
            llm_stream_retries=2,
        )
        call_count = {"n": 0}

        async def fake_acompletion(**kwargs):
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise litellm.ServiceUnavailableError(
                    message="503", model="openai/mimo-v2.5", llm_provider="openai",
                )
            async def _stream():
                yield chunk(content="ok", usage=Usage(1, 2, 3))
            return _stream()

        stack, gen = self._run_stream_response(cfg=cfg, fake_acompletion=fake_acompletion)
        try:
            messages = []
            async for msg in gen:
                messages.append(msg)
        finally:
            stack.__exit__(None, None, None)

        self.assertEqual(call_count["n"], 2, "should have retried after transient error")

    async def test_non_transient_error_no_retry(self):
        """A non-transient error (e.g. AuthenticationError) must NOT be retried."""
        cfg = Config(
            providers=self._providers(),
            llm_stream_idle_timeout=5.0,
            llm_stream_retries=3,
        )
        call_count = {"n": 0}

        async def fake_acompletion(**kwargs):
            call_count["n"] += 1
            raise litellm.AuthenticationError(
                message="401", model="openai/mimo-v2.5", llm_provider="openai",
            )

        stack, gen = self._run_stream_response(cfg=cfg, fake_acompletion=fake_acompletion)
        try:
            with self.assertRaises(litellm.AuthenticationError):
                async for _ in gen:
                    pass
        finally:
            stack.__exit__(None, None, None)
            await gen.aclose()

        self.assertEqual(call_count["n"], 1, "non-transient error must not retry")


def _tool_delta_split(index, *, id=None, name=None, arguments=None):
    """Build a tool_calls delta with only the specified fields populated."""
    function = SimpleNamespace(
        name=name,
        arguments=arguments,
    )
    return SimpleNamespace(
        index=index,
        id=id,
        function=function,
    )


async def _run_stream(response, *, filtered_tools=None):
    """Drive _stream_task + _executor_task to completion; return (messages, api_messages).

    Wraps the response through ``_idle_timed_stream`` exactly like
    ``stream_response`` does in production. This is critical: the
    ``MidStreamFallbackError`` handling lives inside ``_idle_timed_stream``,
    NOT ``_stream_task`` — tests that pass the raw response directly to
    ``_stream_task`` bypass the suppression path.
    """
    msg_q = asyncio.Queue(maxsize=10)
    ready_q = asyncio.Queue()
    api_messages: list[dict] = []
    assistant_appended = asyncio.Event()
    tool_calls_started = asyncio.Event()

    wrapped = llm_client._idle_timed_stream(response(), idle_timeout=300.0)
    stream_t = asyncio.create_task(
        llm_client._stream_task(
            wrapped, msg_q, ready_q, api_messages,
            assistant_appended, tool_calls_started,
        )
    )
    executor_t = asyncio.create_task(
        llm_client._executor_task(
            msg_q, ready_q, api_messages,
            filtered_tools or {}, assistant_appended,
        )
    )

    messages = []
    while True:
        msg = await msg_q.get()
        if msg is None:
            break
        messages.append(msg)

    await asyncio.gather(stream_t, executor_t)
    return messages, api_messages


class MidStreamFallbackErrorTest(unittest.IsolatedAsyncioTestCase):
    """litellm raises ``MidStreamFallbackError`` when its internal chunk parser
    hits an ``IndexError`` (notably on a trailing usage-only chunk whose
    ``choices`` array is empty — ``is_chunk_non_empty`` accesses ``choices[0]``
    with no length guard).  Because stupidex calls ``litellm.acompletion``
    directly (no Router), the fallback signal can never be consumed; without
    mitigation it surfaces to the user as a spurious "Service Unavailable"
    after partial content has already been delivered.  These tests pin the
    contract: benign post-delivery mid-stream errors terminate cleanly;
    pre-first-chunk and genuine connection errors still propagate.
    """

    def _mid_stream_fallback(
        self, *, message: str, is_pre_first_chunk: bool = False
    ) -> "litellm.exceptions.MidStreamFallbackError":
        from litellm.exceptions import MidStreamFallbackError

        original = litellm.APIConnectionError(
            message=message,
            model="openai/mimo-v2.5",
            llm_provider="openai",
            request=httpx.Request(method="POST", url="https://api.openai.com/v1/"),
        )
        return MidStreamFallbackError(
            message=message,
            model="openai/mimo-v2.5",
            llm_provider="openai",
            original_exception=original,
            generated_content="hello",
            is_pre_first_chunk=is_pre_first_chunk,
        )

    async def test_mid_stream_index_error_terminates_cleanly(self):
        """A ``MidStreamFallbackError`` raised by litellm *after* content has
        been delivered (the empty-choices usage-chunk IndexError) must not
        surface to the consumer; the stream ends cleanly and delivered content
        survives."""
        exc = self._mid_stream_fallback(
            message="OpenAIException - list index out of range",
            is_pre_first_chunk=False,
        )

        async def response():
            yield chunk(content="hello")
            raise exc

        messages, _ = await _run_stream(response)

        text_contents = [m.content for m in messages if m.type == MessageType.TEXT]
        self.assertTrue(
            any(c == "hello" for c in text_contents),
            f"partial content must survive; got {text_contents!r}",
        )

    async def test_pre_first_chunk_mid_stream_error_propagates(self):
        """A ``MidStreamFallbackError`` raised *before* any chunk is delivered
        must propagate so the retry layer can attempt fallback."""
        exc = self._mid_stream_fallback(
            message="OpenAIException - list index out of range",
            is_pre_first_chunk=True,
        )

        async def response():
            if False:
                yield  # force async-generator semantics (no real yields)
            raise exc

        with self.assertRaises(litellm.ServiceUnavailableError):
            await _run_stream(response)

    async def test_mid_stream_non_index_error_propagates(self):
        """A mid-stream ``MidStreamFallbackError`` whose signature does NOT
        match the litellm IndexError bug (e.g. a genuine connection drop) must
        still propagate — we must not silently swallow real failures."""
        exc = self._mid_stream_fallback(
            message="APIConnectionError: OpenAIException - Connection reset by peer",
            is_pre_first_chunk=False,
        )

        async def response():
            yield chunk(content="hello")
            raise exc

        with self.assertRaises(litellm.ServiceUnavailableError):
            await _run_stream(response)

    async def test_mid_stream_index_error_does_not_cut_off_remaining_stream(self):
        """Regression: ``MidStreamFallbackError`` raised *mid-stream* (after
        content has already been delivered, but with more content still to
        come) must NOT terminate the stream. The empty-choices IndexError bug
        in litellm fires per offending chunk — the underlying SSE iterator
        is still alive, and content that arrives after the bogus chunk must
        reach the consumer.

        The original fix (commit cb63f7c) used ``break`` after suppression,
        which silently dropped the tail of the assistant message mid-word —
        cutting "All five explorers completed." to "All five explor" with no
        error surfaced (the app's stream loop sees a clean exhaustion and
        persists the truncated cumulative snapshot). The fix is ``continue``
        instead of ``break``: the next ``__anext__`` either yields the next
        real chunk or raises StopAsyncIteration (genuine end-of-stream), in
        which case the loop exits naturally and end-of-stream flushes still
        run.

        We model litellm's actual behavior with a custom async-iterator
        class whose ``__anext__`` raises the MidStreamFallbackError once
        (mirroring the per-call raise in CustomStreamWrapper.__anext__) then
        yields the remaining chunks on subsequent calls. Plain async
        generators cannot express "raise then resume" — raising terminates
        the generator — so a class is required.
        """
        exc = self._mid_stream_fallback(
            message="OpenAIException - list index out of range",
            is_pre_first_chunk=False,
        )

        class _ResumableStream:
            """Mimics litellm CustomStreamWrapper.__anext__: raises once on
            the offending empty-choices chunk, then continues yielding the
            remaining chunks until exhaustion.

            ``_stream_task`` treats ``delta.content`` as a delta (it does
            ``content += delta.content``), so the post-error chunk carries
            the *remainder* of the text — not the cumulative snapshot. This
            mirrors real SSE streaming: each delta appends; the error chunk
            itself carries no content.
            """

            def __init__(self):
                self._steps = iter([
                    ("yield", chunk(content="All five explor")),
                    ("raise", exc),
                    ("yield", chunk(content="ers completed.")),
                    ("yield", chunk(usage=Usage(1, 2, 3))),
                ])

            def __aiter__(self):
                return self

            async def __anext__(self):
                try:
                    action, payload = next(self._steps)
                except StopIteration as si:
                    raise StopAsyncIteration from si
                if action == "raise":
                    raise payload
                return payload

        messages, _ = await _run_stream(lambda: _ResumableStream())

        # Coalesce cumulative snapshots the same way record_streamed_message
        # would: the last TEXT message carries the final accumulated content.
        text_messages = [m for m in messages if m.type == MessageType.TEXT and m.content]
        final_content = text_messages[-1].content if text_messages else ""
        # Both the pre-error fragment AND the post-error tail must survive.
        self.assertTrue(
            final_content.startswith("All five explor"),
            f"pre-error content must still be delivered; got {final_content!r}",
        )
        self.assertEqual(
            final_content, "All five explorers completed.",
            "post-error content must NOT be cut off by `break`",
        )
        # And the final usage chunk survives too (genuine end-of-stream path).
        self.assertTrue(
            any(m.usage is not None for m in messages),
            "usage from the final chunk must survive the suppressed error",
        )

    async def test_many_consecutive_benign_errors_do_not_truncate(self):
        """A stream that emits many (>3) consecutive empty-choices chunks
        between content chunks must NOT be truncated. The old cap of 3
        (``_BENIGN_SUPPRESSION_LIMIT``) killed the stream after 3 errors,
        cutting off legitimate content that arrived after a burst of
        usage/keep-alive frames — the exact cause of "The" cut-off.

        With the cap removed, each ``MidStreamFallbackError`` corresponds
        to one consumed SSE chunk; the stream advances past each bad
        chunk and eventually reaches the next content chunk (or
        ``StopAsyncIteration`` for a genuine end). The idle timeout guards
        against a truly stalled stream (no chunks at all for N seconds).
        """
        exc = self._mid_stream_fallback(
            message="OpenAIException - list index out of range",
            is_pre_first_chunk=False,
        )

        class _BurstThenContent:
            def __init__(self):
                self._calls = 0

            def __aiter__(self):
                return self

            async def __anext__(self):
                self._calls += 1
                if self._calls == 1:
                    return chunk(content="prefix")
                if 2 <= self._calls <= 10:
                    raise exc  # 9 consecutive empty-choices chunks
                if self._calls == 11:
                    return chunk(content=" suffix")
                if self._calls == 12:
                    return chunk(usage=Usage(1, 2, 3))
                raise StopAsyncIteration

        messages, _ = await _run_stream(lambda: _BurstThenContent())

        text_msgs = [m for m in messages if m.type == MessageType.TEXT and m.content]
        final = text_msgs[-1].content if text_msgs else ""
        self.assertEqual(final, "prefix suffix",
                         "content after 9 consecutive benign errors must survive")

    async def test_pre_first_chunk_error_after_prior_delivery_still_propagates(self):
        """Sanity: ``is_pre_first_chunk=True`` errors must propagate regardless
        of whether content was delivered earlier in a *previous* attempt. The
        predicate keys off ``is_pre_first_chunk`` (the litellm-supplied flag),
        not on stupidex's local delivery state — so a true pre-first-chunk
        error (the stream died before any content reached us) is never
        suppressed.
        """
        exc = self._mid_stream_fallback(
            message="OpenAIException - list index out of range",
            is_pre_first_chunk=True,
        )

        async def response():
            raise exc
            yield  # pragma: no cover — forces async-generator semantics

        with self.assertRaises(litellm.ServiceUnavailableError):
            await _run_stream(response)

    async def test_raise_on_model_repetition_handles_empty_choices(self):
        """Regression: litellm's ``raise_on_model_repetition`` accesses
        ``self.chunks[-1].choices[0]`` with no length guard. Usage-only chunks
        have ``choices=[]``, so after one is appended to ``self.chunks`` the
        next content chunk triggers ``IndexError: list index out of range`` —
        the exact root cause of the truncation bug.

        The monkey-patch in ``_patch_litellm_raise_on_model_repetition``
        skips chunks with empty ``choices`` when searching for the last and
        second-to-last content. This test verifies the patched function
        does not raise on empty-choices chunks.
        """
        from types import SimpleNamespace

        from litellm import CustomStreamWrapper

        csw = CustomStreamWrapper.__new__(CustomStreamWrapper)
        csw._repeated_messages_count = 1

        def _mk_chunk(content):
            return SimpleNamespace(
                choices=[SimpleNamespace(delta=SimpleNamespace(content=content))]
            )

        def _mk_empty_chunk():
            return SimpleNamespace(choices=[])

        csw.chunks = [
            _mk_chunk("hello world"),
            _mk_empty_chunk(),
            _mk_chunk("hello world"),
            _mk_empty_chunk(),
            _mk_chunk("hello world"),
        ]
        csw.raise_on_model_repetition()

        # last and second-to-last content chunks are both "hello world",
        # so _repeated_messages_count increments from 1 to 2.
        self.assertEqual(csw._repeated_messages_count, 2)

    async def test_raise_on_model_repetition_no_crash_all_empty(self):
        """The patched ``raise_on_model_repetition`` must not crash when all
        chunks in ``self.chunks`` have empty ``choices`` (extreme edge case
        where only usage-only chunks were sent)."""
        from types import SimpleNamespace

        from litellm import CustomStreamWrapper

        csw = CustomStreamWrapper.__new__(CustomStreamWrapper)
        csw._repeated_messages_count = 1
        csw.chunks = [
            SimpleNamespace(choices=[]),
            SimpleNamespace(choices=[]),
            SimpleNamespace(choices=[]),
        ]
        csw.raise_on_model_repetition()
        self.assertEqual(csw._repeated_messages_count, 1)



class InterleavedToolCallIndexTest(unittest.IsolatedAsyncioTestCase):
    """P1-6: interleaved tool_call deltas must enqueue each index exactly once."""

    async def test_interleaved_indices_enqueue_each_index_once(self):
        async def response():
            yield chunk(tool_calls=[_tool_delta_split(0, id="call-0", name="read", arguments='{"a":1}')])
            yield chunk(tool_calls=[_tool_delta_split(1, id="call-1", name="read", arguments='{"b":1}')])
            yield chunk(tool_calls=[_tool_delta_split(0, arguments='{"a":2}')])
            yield chunk(tool_calls=[_tool_delta_split(1, arguments='{"b":2}')])

        recorded: list[dict] = []

        async def fake_execute_tool(tc, filtered_tools):
            recorded.append(tc)
            return Message(
                role=MessageRole.TOOL,
                content=f"r {tc['id']}",
                type=MessageType.TOOL_RESULT,
                tool_call_id=tc["id"],
            )

        original = llm_client._execute_tool
        llm_client._execute_tool = fake_execute_tool
        try:
            messages, api_messages = await _run_stream(response)
        finally:
            llm_client._execute_tool = original

        executed_ids = [tc["id"] for tc in recorded]
        self.assertEqual(sorted(executed_ids), ["call-0", "call-1"])
        self.assertEqual(len(executed_ids), 2, "each index enqueued exactly once")

    async def test_monotonic_indices_enqueue_each_once_regression(self):
        async def response():
            yield chunk(tool_calls=[_tool_delta_split(0, id="call-0", name="read", arguments='{"a":1}')])
            yield chunk(tool_calls=[_tool_delta_split(0, arguments='{"a":2}')])
            yield chunk(tool_calls=[_tool_delta_split(1, id="call-1", name="read", arguments='{"b":1}')])
            yield chunk(tool_calls=[_tool_delta_split(1, arguments='{"b":2}')])

        recorded: list[dict] = []

        async def fake_execute_tool(tc, filtered_tools):
            recorded.append(tc)
            return Message(
                role=MessageRole.TOOL,
                content=f"r {tc['id']}",
                type=MessageType.TOOL_RESULT,
                tool_call_id=tc["id"],
            )

        original = llm_client._execute_tool
        llm_client._execute_tool = fake_execute_tool
        try:
            messages, api_messages = await _run_stream(response)
        finally:
            llm_client._execute_tool = original

        executed_ids = [tc["id"] for tc in recorded]
        self.assertEqual(sorted(executed_ids), ["call-0", "call-1"])
        self.assertEqual(len(executed_ids), 2)


class MalformedToolCallTest(unittest.IsolatedAsyncioTestCase):
    """P1-7: placeholder tool_calls (missing id/name) must not reach the provider."""

    async def test_first_delta_without_id_yields_only_well_formed_entries(self):
        async def response():
            yield chunk(content="Hi")
            yield chunk(tool_calls=[_tool_delta_split(0, name="read", arguments='{"f":"x"}')])

        async def fake_execute_tool(tc, filtered_tools):
            return Message(
                role=MessageRole.TOOL, content="r",
                type=MessageType.TOOL_RESULT, tool_call_id=tc["id"],
            )

        original = llm_client._execute_tool
        llm_client._execute_tool = fake_execute_tool
        try:
            messages, api_messages = await _run_stream(response)
        finally:
            llm_client._execute_tool = original

        assistant_msgs = [m for m in api_messages if m["role"] == "assistant"]
        tool_call_entries = [tc for m in assistant_msgs for tc in m.get("tool_calls", [])]
        for tc in tool_call_entries:
            self.assertTrue(tc["id"])
            self.assertTrue(tc["function"]["name"])
        tool_results = [m for m in api_messages if m["role"] == "tool"]
        self.assertEqual(tool_results, [], "no tool result appended for malformed call")

    async def test_stream_ends_without_function_name_yields_error_message(self):
        async def response():
            yield chunk(tool_calls=[_tool_delta_split(0, id="call-0", arguments='{"f":"x"}')])

        async def fake_execute_tool(tc, filtered_tools):
            self.fail("malformed tool call must not be executed")
            return Message(role=MessageRole.TOOL, content="", type=MessageType.TOOL_RESULT)

        original = llm_client._execute_tool
        llm_client._execute_tool = fake_execute_tool
        try:
            messages, api_messages = await _run_stream(response)
        finally:
            llm_client._execute_tool = original

        error_msgs = [m for m in messages if m.type == MessageType.ERROR]
        self.assertTrue(any("Malformed tool call" in m.content for m in error_msgs))
        tool_results = [m for m in api_messages if m["role"] == "tool"]
        self.assertEqual(tool_results, [], "no empty tool result appended")

        assistant_msgs = [m for m in api_messages if m["role"] == "assistant"]
        for m in assistant_msgs:
            self.assertNotIn("tool_calls", m)


class PostCommitContentSyncTest(unittest.IsolatedAsyncioTestCase):
    """P1-8: assistant content arriving after tool_calls must stay in sync with api_messages."""

    async def test_single_tool_content_after_tool_call_reflected_in_api_messages(self):
        async def response():
            yield chunk(content="A")
            yield chunk(tool_calls=[_tool_delta_split(0, id="call-0", name="read", arguments='{"f":"x"}')])
            yield chunk(content="B")
            yield chunk(tool_calls=[_tool_delta_split(0, arguments='{"f":"y"}')])

        async def fake_execute_tool(tc, filtered_tools):
            return Message(
                role=MessageRole.TOOL, content="r",
                type=MessageType.TOOL_RESULT, tool_call_id=tc["id"],
            )

        original = llm_client._execute_tool
        llm_client._execute_tool = fake_execute_tool
        try:
            messages, api_messages = await _run_stream(response)
        finally:
            llm_client._execute_tool = original

        assistant_msgs = [m for m in api_messages if m["role"] == "assistant"]
        self.assertTrue(assistant_msgs)
        self.assertIn("AB", assistant_msgs[-1]["content"])

    async def test_multi_tool_content_after_commit_updates_anchored_assistant(self):
        async def response():
            yield chunk(content="A")
            yield chunk(tool_calls=[_tool_delta_split(0, id="call-0", name="read", arguments='{"f":"x"}')])
            yield chunk(tool_calls=[_tool_delta_split(1, id="call-1", name="read", arguments='{"g":"x"}')])
            yield chunk(content="B")
            yield chunk(tool_calls=[_tool_delta_split(1, arguments='{"g":"y"}')])

        async def fake_execute_tool(tc, filtered_tools):
            return Message(
                role=MessageRole.TOOL, content="r",
                type=MessageType.TOOL_RESULT, tool_call_id=tc["id"],
            )

        original = llm_client._execute_tool
        llm_client._execute_tool = fake_execute_tool
        try:
            messages, api_messages = await _run_stream(response)
        finally:
            llm_client._execute_tool = original

        assistant_msgs = [m for m in api_messages if m["role"] == "assistant" and m.get("tool_calls")]
        self.assertTrue(assistant_msgs)
        self.assertEqual(assistant_msgs[-1]["content"], "AB")

    async def test_exactly_one_assistant_text_persisted_when_content_follows_tool_calls(self):
        from stupidex.domain.message import StreamHistoryState, record_streamed_message

        async def response():
            yield chunk(content="A")
            yield chunk(tool_calls=[_tool_delta_split(0, id="call-0", name="read", arguments='{"f":"x"}')])
            yield chunk(content="B")
            yield chunk(tool_calls=[_tool_delta_split(0, arguments='{"f":"y"}')])

        async def fake_execute_tool(tc, filtered_tools):
            return Message(
                role=MessageRole.TOOL, content="r",
                type=MessageType.TOOL_RESULT, tool_call_id=tc["id"],
            )

        original = llm_client._execute_tool
        llm_client._execute_tool = fake_execute_tool
        try:
            messages, api_messages = await _run_stream(response)
        finally:
            llm_client._execute_tool = original

        history: list[Message] = []
        state = StreamHistoryState()
        for m in messages:
            record_streamed_message(history, m, state)

        assistant_text = [
            m for m in history
            if m.role == MessageRole.ASSISTANT and m.type == MessageType.TEXT
        ]
        self.assertEqual(len(assistant_text), 1)
        self.assertIn("AB", assistant_text[0].content)


class TestValidateToolArgs(unittest.TestCase):
    """P1-33 -- _validate_tool_args covers unknown params, missing required, and ok paths."""

    def _make_tool(self, *, required=None, properties=None):
        props = {
            k: ToolParameterProperties(type="string", description=d)
            for k, d in (properties or {}).items()
        }
        return Tool(
            name="mytool",
            description="d",
            parameters=ToolParameter(properties=props, required=required or []),
        )

    def test_all_required_present_no_unknown_returns_none(self):
        tool = self._make_tool(
            required=["path"],
            properties={"path": "p", "content": "c"},
        )
        self.assertIsNone(llm_client._validate_tool_args(tool, {"path": "x", "content": "y"}))

    def test_unknown_param_returns_error_string(self):
        tool = self._make_tool(properties={"path": "p"})
        err = llm_client._validate_tool_args(tool, {"path": "x", "foo": "z"})
        self.assertIsInstance(err, str)
        self.assertTrue(err.startswith("Unknown parameters:"))

    def test_missing_required_returns_error_string(self):
        tool = self._make_tool(required=["path"], properties={"path": "p"})
        err = llm_client._validate_tool_args(tool, {})
        self.assertIsInstance(err, str)
        self.assertEqual(err, "Missing required parameter: path")

    def test_empty_args_no_required_returns_none(self):
        tool = self._make_tool(properties={"path": "p"})
        self.assertIsNone(llm_client._validate_tool_args(tool, {}))


class TestExecuteToolErrorPaths(unittest.IsolatedAsyncioTestCase):
    """P1-32 -- _execute_tool covers all error branches + happy path + no-timeout branch."""

    def _make_tool(self, name="mytool", required=None, properties=None):
        props = {
            k: ToolParameterProperties(type="string", description=d)
            for k, d in (properties or {"path": "p"}).items()
        }
        return Tool(
            name=name,
            description="d",
            parameters=ToolParameter(properties=props, required=required or []),
        )

    def _filtered_tools(self, name="mytool", tool=None, executor=None):
        return {name: {"tool": tool or self._make_tool(name=name), "executor": executor or AsyncMock()}}

    def _tc(self, name="mytool", arguments="{}", tc_id="tc1"):
        return {"id": tc_id, "function": {"name": name, "arguments": arguments}}

    async def test_jsondecode_error_returns_parse_error(self):
        tc = self._tc(arguments="not json")
        result = await llm_client._execute_tool(tc, self._filtered_tools())
        self.assertEqual(result.role, MessageRole.TOOL)
        self.assertEqual(result.type, MessageType.TOOL_RESULT)
        self.assertEqual(result.tool_call_id, "tc1")
        self.assertIn("parse", result.content.lower())

    async def test_args_not_dict_returns_type_error(self):
        tc = self._tc(arguments='[1,2,3]')
        result = await llm_client._execute_tool(tc, self._filtered_tools())
        self.assertIn("must be a JSON object", result.content)

    async def test_unknown_tool_returns_unknown_error(self):
        tools = self._filtered_tools(name="mytool")
        tc = self._tc(name="nonexistent")
        result = await llm_client._execute_tool(tc, tools)
        self.assertIn("does not exist", result.content)

    async def test_validation_failure_returns_validation_error(self):
        executor = AsyncMock()
        tool = self._make_tool(required=["path"])
        tc = self._tc(arguments="{}")
        result = await llm_client._execute_tool(tc, self._filtered_tools(tool=tool, executor=executor))
        self.assertTrue(result.content.startswith("Error:"))
        self.assertIn("Missing required parameter: path", result.content)
        executor.assert_not_called()

    async def test_timeout_error_returns_timeout_message(self):
        executor = AsyncMock(side_effect=TimeoutError())
        tc = self._tc(arguments='{"path":"x"}')
        result = await llm_client._execute_tool(tc, self._filtered_tools(executor=executor))
        self.assertIn("timed out", result.content.lower())

    async def test_generic_exception_returns_internal_error(self):
        executor = AsyncMock(side_effect=RuntimeError("boom"))
        tc = self._tc(arguments='{"path":"x"}')
        result = await llm_client._execute_tool(tc, self._filtered_tools(executor=executor))
        self.assertIn("internal error", result.content.lower())

    async def test_happy_path_returns_tool_message(self):
        executor = AsyncMock(return_value=ExecutorResult(display="ok", content="result"))
        tc = self._tc(arguments='{"path":"x"}')
        result = await llm_client._execute_tool(tc, self._filtered_tools(executor=executor))
        self.assertEqual(result.role, MessageRole.TOOL)
        self.assertEqual(result.type, MessageType.TOOL_RESULT)
        self.assertEqual(result.content, "result")
        self.assertEqual(result.display, "ok")
        executor.assert_awaited_once_with(path="x")

    async def test_tools_without_timeout_bare_call(self):
        self.assertIn("wait_for_subagent", llm_client._TOOLS_WITHOUT_TIMEOUT)
        tool = self._make_tool(name="wait_for_subagent")

        async def executor(**args):
            await asyncio.sleep(0.02)
            return ExecutorResult(display="ok", content="bare-result")

        mock_exec = AsyncMock(side_effect=executor)
        tc = {"id": "tc1", "function": {"name": "wait_for_subagent", "arguments": "{}"}}
        result = await llm_client._execute_tool(tc, self._filtered_tools(name="wait_for_subagent", tool=tool, executor=mock_exec))
        self.assertEqual(result.content, "bare-result")
        mock_exec.assert_awaited_once()

    async def test_tool_call_id_preserved_in_result(self):
        executor = AsyncMock(return_value=ExecutorResult(display="ok", content="result"))
        tc = self._tc(arguments='{"path":"x"}', tc_id="tc123")
        result = await llm_client._execute_tool(tc, self._filtered_tools(executor=executor))
        self.assertEqual(result.tool_call_id, "tc123")


class ToolsWithoutTimeoutBypassTest(unittest.IsolatedAsyncioTestCase):
    """P2-105 -- _execute_tool bypass branch for _TOOLS_WITHOUT_TIMEOUT.
    Asserts the load-bearing contract directly: a tool name in the allowlist
    runs without an asyncio.wait_for deadline (long sleeps succeed), and a
    tool name NOT in the allowlist is bounded by _TOOL_TIMEOUT (long sleeps
    are cancelled and surfaced as a timeout result)."""

    def _make_tool(self, name):
        return Tool(
            name=name,
            description="d",
            parameters=ToolParameter(
                properties={"path": ToolParameterProperties(type="string", description="p")},
                required=[],
            ),
        )

    def _filtered_tools(self, name, executor):
        return {name: {"tool": self._make_tool(name), "executor": executor}}

    async def test_tool_in_allowlist_bypasses_timeout(self):
        self.assertIn("wait_for_subagent", llm_client._TOOLS_WITHOUT_TIMEOUT)

        async def executor(**args):
            await asyncio.sleep(0.1)
            return ExecutorResult(display="ok", content="bypass")

        mock_exec = AsyncMock(side_effect=executor)
        tc = {"id": "tc1", "function": {"name": "wait_for_subagent", "arguments": "{}"}}
        with patch.object(llm_client, "_TOOL_TIMEOUT", 0.01):
            result = await llm_client._execute_tool(
                tc, self._filtered_tools("wait_for_subagent", mock_exec)
            )
        self.assertEqual(result.content, "bypass")
        self.assertNotIn("timed out", result.content.lower())
        mock_exec.assert_awaited_once()

    async def test_tool_not_in_allowlist_applies_timeout(self):
        self.assertNotIn("read", llm_client._TOOLS_WITHOUT_TIMEOUT)

        async def executor(**args):
            await asyncio.sleep(0.2)
            return ExecutorResult(display="ok", content="should-not-reach")

        mock_exec = AsyncMock(side_effect=executor)
        tc = {"id": "tc1", "function": {"name": "read", "arguments": "{}"}}
        with patch.object(llm_client, "_TOOL_TIMEOUT", 0.01):
            result = await llm_client._execute_tool(
                tc, self._filtered_tools("read", mock_exec)
            )
        self.assertIn("timed out", result.content.lower())
        self.assertIn("read", result.content)
        mock_exec.assert_awaited_once()


class StreamCancelPropagationTest(unittest.IsolatedAsyncioTestCase):
    """P3-57 -- stream_response cancel-propagation path (the deduplicated
    except BaseException branch). When the consumer abandons the stream
    mid-flight, both _stream_task and _executor_task must be cancelled and
    awaited (no dangling tasks); the generator must close cleanly without
    leaving the underlying task graph running."""

    def _providers(self):
        return {
            "default": {
                "base_url": "https://example.test/v1",
                "litellm_provider": "openai",
                "models": {"mimo-v2.5": {}},
            }
        }

    def _run_stream_response(self, *, cfg, fake_acompletion):
        acompletion_mock = AsyncMock(side_effect=fake_acompletion)
        dummy_dynamic = Message(MessageRole.SYSTEM, "<dynamic/>", MessageType.TEXT)
        patches = [
            patch("stupidex.llm.client.get_config", return_value=cfg),
            patch("stupidex.llm.providers.get_config", return_value=cfg),
            patch("stupidex.llm.client.build_dynamic_system_prompt",
                  new=AsyncMock(return_value=dummy_dynamic)),
            patch("stupidex.llm.client.get_tool_registry", return_value={}),
            patch("stupidex.llm.client.litellm.acompletion", new=acompletion_mock),
        ]
        stack = contextlib.ExitStack()
        for p in patches:
            stack.enter_context(p)
        stack.__enter__()
        gen = llm_client.stream_response(
            messages=[],
            model="default/mimo-v2.5",
            allowed_tools=[],
            system_prompt="",
        )
        return stack, gen

    async def test_mid_stream_cancellation_cleans_up_tasks(self):
        """Consumer iterates one message, then closes the generator
        mid-stream. The formerly-duplicated except block must cancel + gather
        both tasks; no _stream_task / _executor_task must remain pending."""
        cfg = Config(providers=self._providers(), llm_stream_idle_timeout=5.0)

        async def fake_acompletion(**kwargs):
            async def _stream():
                yield chunk(content="first")
                await asyncio.sleep(10)  # never completes; consumer will cancel

            return _stream()

        stack, gen = self._run_stream_response(cfg=cfg, fake_acompletion=fake_acompletion)
        seen: list[Message] = []
        try:
            async for msg in gen:
                seen.append(msg)
                break
            await gen.aclose()
        finally:
            stack.__exit__(None, None, None)

        self.assertTrue(seen, "consumer must have received at least one message")
        await asyncio.sleep(0)  # let any deferred cancellation callbacks run
        pending = [
            t for t in asyncio.all_tasks()
            if not t.done()
            and ("_stream_task" in t.get_name() or "_executor_task" in t.get_name())
        ]
        # Either both tasks are done, or none carry the stream/executor names.
        self.assertEqual(pending, [], "no dangling stream/executor tasks after cancel")

    async def test_mid_stream_cancellation_via_baseexception_propagates(self):
        """Consumer raises mid-flight (simulating a prompt-injection abort).
        The cancel branch must re-raise after gathering both tasks; both
        tasks must be cancelled and observed as done."""
        cfg = Config(providers=self._providers(), llm_stream_idle_timeout=5.0)
        captured: dict[str, asyncio.Task] = {}

        original_stream_task = llm_client._stream_task
        original_executor_task = llm_client._executor_task

        async def tracking_stream_task(*args, **kwargs):
            captured["stream"] = asyncio.current_task()
            return await original_stream_task(*args, **kwargs)

        async def tracking_executor_task(*args, **kwargs):
            captured["executor"] = asyncio.current_task()
            return await original_executor_task(*args, **kwargs)

        async def fake_acompletion(**kwargs):
            async def _stream():
                yield chunk(content="first")
                await asyncio.sleep(10)

            return _stream()

        stack, gen = self._run_stream_response(cfg=cfg, fake_acompletion=fake_acompletion)
        try:
            with patch.object(llm_client, "_stream_task", tracking_stream_task), \
                    patch.object(llm_client, "_executor_task", tracking_executor_task), \
                    self.assertRaises(RuntimeError):
                async for _ in gen:
                    raise RuntimeError("consumer abort")
        finally:
            stack.__exit__(None, None, None)
            await gen.aclose()

        await asyncio.sleep(0)
        if "stream" in captured:
            self.assertTrue(captured["stream"].done())
        if "executor" in captured:
            self.assertTrue(captured["executor"].done())


class TestStreamResponseMultiTurn(unittest.IsolatedAsyncioTestCase):
    """P1-31 -- stream_response outer while-loop drives multi-turn tool-call rounds."""

    def _providers(self):
        return {
            "default": {
                "base_url": "https://example.test/v1",
                "litellm_provider": "openai",
                "models": {"mimo-v2.5": {}},
            }
        }

    async def _drive(self, *, fake_acompletion):
        cfg = Config(providers=self._providers())
        acompletion_mock = AsyncMock(side_effect=fake_acompletion)
        dummy_dynamic = Message(MessageRole.SYSTEM, "<dynamic/>", MessageType.TEXT)

        async def fake_execute_tool(tc, filtered_tools):
            return Message(
                role=MessageRole.TOOL,
                content=f"result {tc['id']}",
                type=MessageType.TOOL_RESULT,
                tool_call_id=tc["id"],
            )

        original_execute_tool = llm_client._execute_tool
        llm_client._execute_tool = fake_execute_tool
        patches = [
            patch("stupidex.llm.client.get_config", return_value=cfg),
            patch("stupidex.llm.providers.get_config", return_value=cfg),
            patch("stupidex.llm.client.build_dynamic_system_prompt",
                  new=AsyncMock(return_value=dummy_dynamic)),
            patch("stupidex.llm.client.get_tool_registry", return_value={}),
            patch("stupidex.llm.client.litellm.acompletion", new=acompletion_mock),
        ]
        try:
            with contextlib.ExitStack() as stack:
                for p in patches:
                    stack.enter_context(p)
                gen = llm_client.stream_response(
                    messages=[],
                    model="default/mimo-v2.5",
                    allowed_tools=[],
                    system_prompt="",
                )
                messages: list[Message] = []
                async for msg in gen:
                    messages.append(msg)
        finally:
            llm_client._execute_tool = original_execute_tool
        return messages, acompletion_mock

    async def test_single_round_no_tool_calls_exits_immediately(self):
        async def fake_acompletion(**kwargs):
            async def _stream():
                yield chunk(content="done", usage=Usage(1, 2, 3))
            return _stream()

        messages, mock = await self._drive(fake_acompletion=fake_acompletion)
        self.assertEqual(mock.call_count, 1)
        text_msgs = [m for m in messages if m.type == MessageType.TEXT and m.content]
        self.assertTrue(any(m.content == "done" for m in text_msgs))

    async def test_two_round_loop_tool_calls_then_text(self):
        state = {"n": 0}

        async def fake_acompletion(**kwargs):
            state["n"] += 1
            if state["n"] == 1:
                async def s1():
                    yield chunk(tool_calls=[_tool_delta_split(
                        0, id="tc1", name="mytool", arguments='{"path":"x"}')])
                return s1()
            else:
                async def s2():
                    yield chunk(content="done", usage=Usage(1, 2, 3))
                return s2()

        messages, mock = await self._drive(fake_acompletion=fake_acompletion)
        self.assertEqual(mock.call_count, 2)
        tool_results = [m for m in messages if m.type == MessageType.TOOL_RESULT]
        self.assertEqual(len(tool_results), 1)
        self.assertEqual(tool_results[0].tool_call_id, "tc1")
        text_msgs = [m for m in messages if m.type == MessageType.TEXT and m.content]
        self.assertTrue(any(m.content == "done" for m in text_msgs))

    async def test_three_round_loop_two_tool_rounds_then_text(self):
        state = {"n": 0}

        async def fake_acompletion(**kwargs):
            state["n"] += 1
            if state["n"] == 1:
                async def s1():
                    yield chunk(tool_calls=[_tool_delta_split(
                        0, id="tc1", name="mytool", arguments='{"path":"x"}')])
                return s1()
            elif state["n"] == 2:
                async def s2():
                    yield chunk(tool_calls=[_tool_delta_split(
                        0, id="tc2", name="mytool", arguments='{"path":"y"}')])
                return s2()
            else:
                async def s3():
                    yield chunk(content="final", usage=Usage(1, 2, 3))
                return s3()

        messages, mock = await self._drive(fake_acompletion=fake_acompletion)
        self.assertEqual(mock.call_count, 3)
        tool_results = [m for m in messages if m.type == MessageType.TOOL_RESULT]
        ids = sorted(tr.tool_call_id for tr in tool_results)
        self.assertEqual(ids, ["tc1", "tc2"])
        text_msgs = [m for m in messages if m.type == MessageType.TEXT and m.content]
        self.assertTrue(any(m.content == "final" for m in text_msgs))


if __name__ == "__main__":
    unittest.main()
