"""Tests for Message persistence and deserialization (P1-27)."""

import unittest

from stupidex.domain.chain import Chain
from stupidex.domain.message import (
    Message,
    MessageRole,
    MessageType,
    StreamHistoryState,
    Usage,
    record_streamed_message,
)


class TestUsageDeserializationForwardCompat(unittest.TestCase):
    """Forward-compat: persisted usage dicts may carry extra keys from a newer
    writer or a different provider. The loader must filter rather than crash the
    whole session restore (see session.py:56/130).
    """

    def _msg_with_usage(self, usage_dict) -> Message:
        data = {
            "role": "assistant",
            "content": "hi",
            "type": "text",
            "usage": usage_dict,
        }
        return Message.from_storage_dict(data)

    def test_extra_key_in_usage_does_not_raise(self):
        """Extra keys (reasoning_tokens, prompt_tokens_details, ...) are dropped."""
        msg = self._msg_with_usage(
            {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
                "reasoning_tokens": 99,
                "prompt_tokens_details": {"cached_tokens": 4},
            }
        )
        self.assertIsNotNone(msg.usage)
        assert msg.usage is not None  # for type narrowing
        self.assertEqual(msg.usage.prompt_tokens, 10)
        self.assertEqual(msg.usage.completion_tokens, 5)
        self.assertEqual(msg.usage.total_tokens, 15)

    def test_missing_key_in_usage_defaults_to_zero(self):
        """Partial/corrupt usage dict does not raise; missing fields are 0."""
        msg = self._msg_with_usage({"prompt_tokens": 7})
        assert msg.usage is not None
        self.assertEqual(msg.usage.prompt_tokens, 7)
        self.assertEqual(msg.usage.completion_tokens, 0)
        self.assertEqual(msg.usage.total_tokens, 0)

    def test_completely_empty_usage_defaults_to_zero(self):
        """An empty usage dict yields an all-zero Usage rather than raising."""
        msg = self._msg_with_usage({})
        assert msg.usage is not None
        self.assertEqual(msg.usage.prompt_tokens, 0)
        self.assertEqual(msg.usage.completion_tokens, 0)
        self.assertEqual(msg.usage.total_tokens, 0)

    def test_none_usage_yields_none(self):
        """An explicit `usage: null` yields Message.usage is None."""
        msg = Message.from_storage_dict(
            {"role": "user", "content": "hi", "type": "text", "usage": None}
        )
        self.assertIsNone(msg.usage)

    def test_absent_usage_key_yields_none(self):
        """An absent `usage` key yields Message.usage is None."""
        msg = Message.from_storage_dict(
            {"role": "user", "content": "hi", "type": "text"}
        )
        self.assertIsNone(msg.usage)

    def test_round_trip_preserves_known_fields(self):
        """to_storage_dict -> from_storage_dict preserves the four known fields,
        including cached_tokens (cache-read tokens only — R1/R7)."""
        orig = Message(
            MessageRole.ASSISTANT,
            "hi",
            MessageType.TEXT,
            usage=Usage(
                prompt_tokens=10,
                completion_tokens=5,
                total_tokens=15,
                cached_tokens=4,
            ),
        )
        restored = Message.from_storage_dict(orig.to_storage_dict())
        assert restored.usage is not None
        self.assertEqual(
            restored.usage,
            Usage(
                prompt_tokens=10,
                completion_tokens=5,
                total_tokens=15,
                cached_tokens=4,
            ),
        )

    def test_round_trip_cached_tokens_zero_when_omitted(self):
        """Usage(1, 2, 3) (positional, no cached) round-trips with cached_tokens=0."""
        orig = Message(
            MessageRole.ASSISTANT,
            "hi",
            MessageType.TEXT,
            usage=Usage(1, 2, 3),
        )
        restored = Message.from_storage_dict(orig.to_storage_dict())
        assert restored.usage is not None
        self.assertEqual(restored.usage.cached_tokens, 0)

    def test_forward_compat_nested_prompt_tokens_details_ignored(self):
        """A persisted dict with prompt_tokens_details: {cached_tokens: 4} plus
        a top-level cached_tokens: 7 → loader reads the top-level (7), ignoring
        the nested block (existing extra-key handling drops unknown structures)."""
        msg = self._msg_with_usage(
            {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
                "cached_tokens": 7,
                "prompt_tokens_details": {"cached_tokens": 4},
            }
        )
        assert msg.usage is not None
        self.assertEqual(msg.usage.cached_tokens, 7)

    def test_backward_compat_missing_cached_tokens_defaults_to_zero(self):
        """Old persisted sessions without cached_tokens load as 0."""
        msg = self._msg_with_usage(
            {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            }
        )
        assert msg.usage is not None
        self.assertEqual(msg.usage.cached_tokens, 0)

    def test_extra_keys_in_usage_do_not_break_session_load(self):
        """Simulates the full-session restore path: a drifted usage dict on one
        message must not cascade-fail the whole session load. This pins the
        P1-27 fix against the chain.py:59 comprehension propagation path.
        """
        # Hand-construct a storage dict for one assistant message with drifted usage.
        data = {
            "role": "assistant",
            "content": "hello",
            "type": "text",
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 50,
                "total_tokens": 150,
                "cache_read_input_tokens": 40,  # forward-compat extra
                "cache_creation_input_tokens": 5,  # forward-compat extra
            },
        }
        # If from_storage_dict raised, a list comprehension over many messages
        # (chain.py:59) would propagate the exception up to SessionManager.load
        # which returns None (data loss). Verify the loader returns a Message.
        msg = Message.from_storage_dict(data)
        self.assertEqual(msg.role, MessageRole.ASSISTANT)
        self.assertEqual(msg.content, "hello")
        assert msg.usage is not None
        self.assertEqual(msg.usage.total_tokens, 150)


class TestMessageFromStorageDictEnumTolerance(unittest.TestCase):
    """P2-9: unknown role/type enum values must not abort session recovery.
    The loader falls back to SYSTEM/TEXT and records the drift in
    metadata["_deserialize_warning"] so the message stays visible
    (dropping it would break chain length and tool_call_id pairing).
    """

    def test_well_formed_message_loads_normally(self):
        msg = Message.from_storage_dict(
            {"role": "assistant", "content": "hi", "type": "text"}
        )
        self.assertEqual(msg.role, MessageRole.ASSISTANT)
        self.assertEqual(msg.type, MessageType.TEXT)
        self.assertEqual(msg.content, "hi")
        self.assertNotIn("_deserialize_warning", msg.metadata)

    def test_unknown_role_falls_back_to_system_with_warning(self):
        msg = Message.from_storage_dict(
            {"role": "helper", "content": "hello", "type": "text"}
        )
        self.assertEqual(msg.role, MessageRole.SYSTEM)
        self.assertEqual(msg.type, MessageType.TEXT)
        self.assertEqual(msg.content, "hello")
        warning = msg.metadata.get("_deserialize_warning", "")
        self.assertIn("helper", warning)
        self.assertIn("system", warning)

    def test_unknown_role_preserves_other_fields(self):
        tool_calls = [{"id": "tc1", "function": {"name": "x", "arguments": "{}"}}]
        msg = Message.from_storage_dict(
            {
                "role": "bogus",
                "content": "body",
                "type": "text",
                "display": "displayed",
                "tool_call_id": "tc1",
                "tool_calls": tool_calls,
                "metadata": {"k": "v"},
            }
        )
        self.assertEqual(msg.role, MessageRole.SYSTEM)
        self.assertEqual(msg.content, "body")
        self.assertEqual(msg.display, "displayed")
        self.assertEqual(msg.tool_call_id, "tc1")
        self.assertEqual(msg.tool_calls, tool_calls)
        self.assertEqual(msg.metadata.get("k"), "v")
        self.assertIn("_deserialize_warning", msg.metadata)

    def test_unknown_type_falls_back_to_text_with_warning(self):
        msg = Message.from_storage_dict(
            {"role": "user", "content": "hi", "type": "reasoning"}
        )
        self.assertEqual(msg.role, MessageRole.USER)
        self.assertEqual(msg.type, MessageType.TEXT)
        warning = msg.metadata.get("_deserialize_warning", "")
        self.assertIn("reasoning", warning)
        self.assertIn("text", warning)

    def test_both_role_and_type_unknown_fall_back_independently(self):
        msg = Message.from_storage_dict(
            {"role": "helper", "content": "hi", "type": "reasoning"}
        )
        self.assertEqual(msg.role, MessageRole.SYSTEM)
        self.assertEqual(msg.type, MessageType.TEXT)
        warning = msg.metadata.get("_deserialize_warning", "")
        self.assertIn("helper", warning)
        self.assertIn("reasoning", warning)

    def test_missing_role_key_defaults_to_system_without_warning(self):
        msg = Message.from_storage_dict({"content": "hi", "type": "text"})
        self.assertEqual(msg.role, MessageRole.SYSTEM)
        self.assertNotIn("_deserialize_warning", msg.metadata)

    def test_missing_type_key_defaults_to_text_without_warning(self):
        msg = Message.from_storage_dict({"role": "user", "content": "hi"})
        self.assertEqual(msg.type, MessageType.TEXT)
        self.assertNotIn("_deserialize_warning", msg.metadata)

    def test_warning_metadata_does_not_mutate_caller_dict(self):
        shared_meta = {"k": "v"}
        Message.from_storage_dict(
            {"role": "helper", "content": "hi", "type": "text", "metadata": shared_meta}
        )
        self.assertNotIn("_deserialize_warning", shared_meta)

    def test_chain_loads_with_mixed_valid_and_corrupt_messages(self):
        data = {
            "model": "m",
            "status": "completed",
            "messages": [
                {"role": "user", "content": "ok", "type": "text"},
                {"role": "helper", "content": "bad-role", "type": "reasoning"},
                {"role": "assistant", "content": "reply", "type": "text"},
            ],
        }
        chain = Chain.from_storage_dict(data)
        self.assertEqual(len(chain.messages), 3)
        self.assertEqual(chain.messages[0].role, MessageRole.USER)
        self.assertEqual(chain.messages[1].role, MessageRole.SYSTEM)
        self.assertEqual(chain.messages[1].type, MessageType.TEXT)
        self.assertIn("_deserialize_warning", chain.messages[1].metadata)
        self.assertEqual(chain.messages[2].role, MessageRole.ASSISTANT)


class TestMessageToDict(unittest.TestCase):
    """Tests for Message.to_dict() content/tool_call_id/tool_calls contracts (P1-30)."""

    def _tool_calls(self):
        return [{"id": "tc1", "function": {"name": "x", "arguments": "{}"}}]

    def test_assistant_with_tool_calls_and_content_keeps_string(self):
        msg = Message(
            MessageRole.ASSISTANT,
            "hello",
            MessageType.TEXT,
            tool_calls=self._tool_calls(),
        )
        d = msg.to_dict()
        self.assertEqual(d["content"], "hello")
        self.assertIn("tool_calls", d)

    def test_assistant_with_tool_calls_empty_content_becomes_none(self):
        msg = Message(
            MessageRole.ASSISTANT,
            "",
            MessageType.TEXT,
            tool_calls=self._tool_calls(),
        )
        d = msg.to_dict()
        self.assertIsNone(d["content"])
        self.assertIn("tool_calls", d)

    def test_assistant_with_tool_calls_none_content_becomes_none(self):
        msg = Message(
            MessageRole.ASSISTANT,
            None,  # type: ignore[arg-type]
            MessageType.TEXT,
            tool_calls=self._tool_calls(),
        )
        d = msg.to_dict()
        self.assertIsNone(d["content"])

    def test_assistant_without_tool_calls_keeps_empty_content(self):
        msg = Message(MessageRole.ASSISTANT, "", MessageType.TEXT, tool_calls=None)
        d = msg.to_dict()
        self.assertEqual(d["content"], "")
        self.assertNotIn("tool_calls", d)

    def test_tool_role_empty_content_preserved(self):
        msg = Message(
            MessageRole.TOOL,
            "",
            MessageType.TOOL_RESULT,
            tool_call_id="tc1",
        )
        d = msg.to_dict()
        self.assertEqual(d["content"], "")

    def test_user_role_content_preserved(self):
        msg = Message(MessageRole.USER, "hi", MessageType.TEXT)
        d = msg.to_dict()
        self.assertEqual(d["content"], "hi")

    def test_system_role_content_preserved(self):
        msg = Message(MessageRole.SYSTEM, "sys", MessageType.TEXT)
        d = msg.to_dict()
        self.assertEqual(d["content"], "sys")

    def test_tool_call_id_included_when_truthy(self):
        msg = Message(
            MessageRole.TOOL,
            "result",
            MessageType.TOOL_RESULT,
            tool_call_id="tc1",
        )
        d = msg.to_dict()
        self.assertEqual(d["tool_call_id"], "tc1")

    def test_tool_call_id_omitted_when_falsy(self):
        msg = Message(
            MessageRole.TOOL,
            "result",
            MessageType.TOOL_RESULT,
            tool_call_id=None,
        )
        d = msg.to_dict()
        self.assertNotIn("tool_call_id", d)

    def test_tool_calls_deep_copied(self):
        msg = Message(
            MessageRole.ASSISTANT,
            "",
            MessageType.TEXT,
            tool_calls=self._tool_calls(),
        )
        d = msg.to_dict()
        assert d["tool_calls"] is not None  # for type narrowing
        d["tool_calls"][0]["function"]["arguments"] = "mutated"
        self.assertEqual(
            msg.tool_calls[0]["function"]["arguments"], "{}"  # type: ignore[index]
        )


class TestRecordStreamedMessageSystemAndCatchAll(unittest.TestCase):
    """P3-13: SYSTEM-role routing and catch-all branch of record_streamed_message.

    There is no dedicated SYSTEM-role branch; SYSTEM+TEXT messages are routed
    through the generic TEXT branch (mutating an existing assistant snapshot
    in place rather than appending — pinned here as regression coverage), while
    SYSTEM messages of a non-TEXT type fall through to the catch-all.
    """

    def test_system_text_with_no_prior_state_appended_and_anchors_state(self):
        history: list[Message] = []
        state = StreamHistoryState()
        sys_msg = Message(MessageRole.SYSTEM, "you are helpful", MessageType.TEXT)
        appended = record_streamed_message(history, sys_msg, state)
        self.assertTrue(appended)
        self.assertIsNone(state.content)
        self.assertEqual(history, [sys_msg])

    def test_system_text_appends_distinct_entry_without_mutating_prior(self):
        history: list[Message] = []
        state = StreamHistoryState()
        prior = Message(MessageRole.ASSISTANT, "partial", MessageType.TEXT)
        record_streamed_message(history, prior, state)
        self.assertEqual(len(history), 1)

        sys_msg = Message(MessageRole.SYSTEM, "sys", MessageType.TEXT)
        appended = record_streamed_message(history, sys_msg, state)

        self.assertTrue(appended)
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0].role, MessageRole.ASSISTANT)
        self.assertEqual(history[0].content, "partial")
        self.assertEqual(history[1].role, MessageRole.SYSTEM)
        self.assertEqual(history[1].content, "sys")

    def test_system_non_text_type_hits_catch_all_and_appends(self):
        history: list[Message] = []
        state = StreamHistoryState()
        prior = Message(MessageRole.ASSISTANT, "x", MessageType.TEXT)
        record_streamed_message(history, prior, state)
        self.assertIsNotNone(state.content)

        sys_err = Message(MessageRole.SYSTEM, "sys-error", MessageType.ERROR)
        appended = record_streamed_message(history, sys_err, state)
        self.assertTrue(appended)
        self.assertIn(sys_err, history)
        self.assertIsNone(state.thinking)
        self.assertIsNone(state.content)

    def test_system_text_with_no_prior_state(self):
        history: list[Message] = []
        state = StreamHistoryState()
        sys_msg = Message(MessageRole.SYSTEM, "sys", MessageType.TEXT)
        appended = record_streamed_message(history, sys_msg, state)
        self.assertTrue(appended)
        self.assertEqual(len(history), 1)
        self.assertIsNone(state.content)
        self.assertIsNone(state.thinking)

    def test_stream_with_system_interleaved(self):
        history: list[Message] = []
        state = StreamHistoryState()

        user = Message(MessageRole.USER, "u1", MessageType.TEXT)
        record_streamed_message(history, user, state)

        asst1 = Message(MessageRole.ASSISTANT, "a1", MessageType.TEXT)
        record_streamed_message(history, asst1, state)

        sys1 = Message(MessageRole.SYSTEM, "s1", MessageType.TEXT)
        record_streamed_message(history, sys1, state)

        asst2 = Message(MessageRole.ASSISTANT, "a2", MessageType.TEXT)
        record_streamed_message(history, asst2, state)

        self.assertEqual(len(history), 4)
        self.assertEqual(history[0], user)
        self.assertEqual(history[0].content, "u1")
        self.assertEqual(history[1], asst1)
        self.assertEqual(history[1].content, "a1")
        self.assertEqual(history[2], sys1)
        self.assertEqual(history[2].content, "s1")
        self.assertEqual(history[3], asst2)
        self.assertEqual(history[3].content, "a2")

    def test_catch_all_appends_unknown_combination_without_raising(self):
        history: list[Message] = []
        state = StreamHistoryState()
        # TOOL role + ERROR type matches no named branch → catch-all.
        weird = Message(MessageRole.TOOL, "stray", MessageType.ERROR)
        appended = record_streamed_message(history, weird, state)
        self.assertTrue(appended)
        self.assertEqual(history, [weird])
        self.assertIsNone(state.thinking)
        self.assertIsNone(state.content)

    def test_catch_all_resets_prior_stream_state(self):
        history: list[Message] = []
        state = StreamHistoryState()
        prior = Message(MessageRole.ASSISTANT, "x", MessageType.TEXT)
        record_streamed_message(history, prior, state)
        self.assertIsNotNone(state.content)

        err = Message(MessageRole.ASSISTANT, "boom", MessageType.ERROR)
        appended = record_streamed_message(history, err, state)
        self.assertTrue(appended)
        self.assertIn(err, history)
        self.assertIsNone(state.thinking)
        self.assertIsNone(state.content)

    def test_catch_all_appends_each_call_exactly_once(self):
        history: list[Message] = []
        state = StreamHistoryState()
        m1 = Message(MessageRole.ASSISTANT, "note", MessageType.ERROR)
        m2 = Message(MessageRole.ASSISTANT, "note2", MessageType.ERROR)
        self.assertTrue(record_streamed_message(history, m1, state))
        self.assertTrue(record_streamed_message(history, m2, state))
        self.assertEqual(len(history), 2)
        self.assertEqual(history[0].content, "note")
        self.assertEqual(history[1].content, "note2")


if __name__ == "__main__":
    unittest.main()
