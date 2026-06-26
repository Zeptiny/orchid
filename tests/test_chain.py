"""Tests for chain._reconcile_orphan_tool_results mutation (P1-29)."""

import unittest

from stupidex.domain.chain import Chain, ChainStatus, _reconcile_orphan_tool_results
from stupidex.domain.message import Message, MessageRole, MessageType, Usage


def _assistant_with_tool_calls(tc_id: str | None) -> Message:
    tc: dict = {"function": {"name": "lookup", "arguments": "{}"}}
    if tc_id is not None:
        tc["id"] = tc_id
    return Message(
        MessageRole.ASSISTANT,
        "",
        MessageType.TEXT,
        tool_calls=[tc],
    )


def _tool_result(tc_id: str | None) -> Message:
    return Message(
        MessageRole.TOOL,
        "result",
        MessageType.TOOL_RESULT,
        tool_call_id=tc_id,
    )


class TestReconcileOrphanToolResults(unittest.TestCase):
    def test_empty_list_no_mutation(self):
        messages: list[Message] = []
        _reconcile_orphan_tool_results(messages)
        self.assertEqual(messages, [])

    def test_orphan_tool_result_dropped(self):
        messages = [_tool_result("orphan")]
        _reconcile_orphan_tool_results(messages)
        self.assertEqual(len(messages), 0)

    def test_assistant_tool_calls_registers_ids(self):
        messages = [
            _assistant_with_tool_calls("tc1"),
            _tool_result("tc1"),
        ]
        _reconcile_orphan_tool_results(messages)
        self.assertEqual(len(messages), 2)

    def test_tool_result_with_matching_id_kept(self):
        messages = [
            _assistant_with_tool_calls("tc1"),
            _tool_result("tc1"),
        ]
        _reconcile_orphan_tool_results(messages)
        self.assertEqual(messages[0].role, MessageRole.ASSISTANT)
        self.assertEqual(messages[1].tool_call_id, "tc1")

    def test_assistant_tool_calls_without_id_not_registered(self):
        messages = [
            _assistant_with_tool_calls(None),
            _tool_result("missing-id"),
        ]
        _reconcile_orphan_tool_results(messages)
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0].role, MessageRole.ASSISTANT)

    def test_none_tool_call_id_kept(self):
        messages = [_tool_result(None)]
        _reconcile_orphan_tool_results(messages)
        self.assertEqual(len(messages), 1)
        self.assertIsNone(messages[0].tool_call_id)

    def test_multiple_orphans_all_dropped(self):
        messages = [
            _tool_result("a"),
            _tool_result("b"),
            _tool_result("c"),
        ]
        _reconcile_orphan_tool_results(messages)
        self.assertEqual(len(messages), 0)

    def test_duplicate_tool_results_for_seen_id_second_dropped(self):
        """P2-3: a second TOOL_RESULT with an already-served tool_call_id is
        dropped at replay time (strict OpenAI/Anthropic providers 400 on
        duplicate tool_call_id in the same history)."""
        messages = [
            _assistant_with_tool_calls("tc1"),
            _tool_result("tc1"),
            _tool_result("tc1"),
        ]
        _reconcile_orphan_tool_results(messages)
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[0].role, MessageRole.ASSISTANT)
        self.assertEqual(messages[1].tool_call_id, "tc1")

    def test_duplicate_tool_result_across_turns_second_dropped_as_orphan(self):
        """P2-3 edge case: same tool_call_id appearing across two separate
        turns. The second tool(tc1) is dropped — as orphan, because
        pending_tool_call_ids was reset by the intervening assistant(content)
        message; the duplicate-result check is not what fires here. Both
        drop paths converge on the same outcome without firing duplicate-drop
        log noise."""
        messages = [
            _assistant_with_tool_calls("tc1"),
            _tool_result("tc1"),
            Message(MessageRole.ASSISTANT, "intermediate", MessageType.TEXT),
            _tool_result("tc1"),
        ]
        _reconcile_orphan_tool_results(messages)
        # The first tool(tc1) is kept (paired), the second is dropped as orphan
        # (no preceding assistant tool_calls in this turn). Both drops converge
        # on the same outcome: only one tool(tc1) survives.
        kept_tool_results = [m for m in messages if m.role == MessageRole.TOOL]
        self.assertEqual(len(kept_tool_results), 1)
        self.assertEqual(kept_tool_results[0].tool_call_id, "tc1")

    def test_duplicate_tool_result_back_to_back_first_kept(self):
        """P2-3 edge case: back-to-back duplicate — first kept, second dropped,
        preserving order."""
        messages = [
            _assistant_with_tool_calls("tc1"),
            _tool_result("tc1"),
            _tool_result("tc1"),
            _tool_result("tc1"),
        ]
        _reconcile_orphan_tool_results(messages)
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[1].tool_call_id, "tc1")

    def test_tool_result_before_assistant_partner_dropped(self):
        messages = [
            _tool_result("tc1"),
            _assistant_with_tool_calls("tc1"),
        ]
        _reconcile_orphan_tool_results(messages)
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0].role, MessageRole.ASSISTANT)

    def test_no_op_preserves_list_identity(self):
        messages = [
            _assistant_with_tool_calls("tc1"),
            _tool_result("tc1"),
        ]
        original = messages
        _reconcile_orphan_tool_results(messages)
        self.assertIs(messages, original)

    def test_mutation_preserves_list_identity_replaces_contents(self):
        messages = [
            _tool_result("orphan"),
            _assistant_with_tool_calls("tc1"),
            _tool_result("tc1"),
        ]
        original = messages
        _reconcile_orphan_tool_results(messages)
        self.assertIs(messages, original)
        self.assertEqual(len(messages), 2)

    def test_user_message_kept(self):
        messages = [
            Message(MessageRole.USER, "hi", MessageType.TEXT),
        ]
        _reconcile_orphan_tool_results(messages)
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0].content, "hi")

    def test_system_message_kept(self):
        messages = [
            Message(MessageRole.SYSTEM, "sys", MessageType.TEXT),
        ]
        _reconcile_orphan_tool_results(messages)
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0].content, "sys")

    def test_round_trip_from_storage_dict_runs_reconcile(self):
        data = {
            "model": "m",
            "messages": [
                {
                    "role": "tool",
                    "content": "result",
                    "type": "tool_result",
                    "tool_call_id": "orphan",
                },
                {
                    "role": "assistant",
                    "content": "",
                    "type": "text",
                    "tool_calls": [{"id": "tc1", "function": {"name": "f", "arguments": "{}"}}],
                },
                {
                    "role": "tool",
                    "content": "result",
                    "type": "tool_result",
                    "tool_call_id": "tc1",
                },
            ],
            "start_time": 0.0,
            "end_time": None,
            "status": "completed",
        }
        chain = Chain.from_storage_dict(data)
        self.assertEqual(len(chain.messages), 2)
        self.assertEqual(chain.messages[0].role, MessageRole.ASSISTANT)
        self.assertEqual(chain.messages[1].tool_call_id, "tc1")


class TestChainFinishIdempotency(unittest.TestCase):
    """P2-14: Chain.finish() must be a no-op once the chain has left RUNNING."""

    def test_finish_completes_running_chain(self):
        chain = Chain()
        self.assertIsNone(chain.end_time)
        chain.finish()
        self.assertIsNotNone(chain.end_time)
        self.assertEqual(chain.status, ChainStatus.COMPLETED)

    def test_finish_twice_second_call_is_noop(self):
        chain = Chain()
        chain.finish(ChainStatus.COMPLETED)
        first_end = chain.end_time
        first_status = chain.status
        self.assertIsNotNone(first_end)
        chain.finish(ChainStatus.FAILED)
        self.assertEqual(chain.end_time, first_end)
        self.assertEqual(chain.status, first_status)

    def test_finish_failed_is_terminal_idempotent(self):
        chain = Chain()
        chain.finish(ChainStatus.FAILED)
        first_end = chain.end_time
        chain.finish(ChainStatus.COMPLETED)
        self.assertEqual(chain.end_time, first_end)
        self.assertEqual(chain.status, ChainStatus.FAILED)

    def test_finish_interrupted_is_terminal_idempotent(self):
        chain = Chain()
        chain.finish(ChainStatus.INTERRUPTED)
        first_end = chain.end_time
        chain.finish(ChainStatus.COMPLETED)
        self.assertEqual(chain.end_time, first_end)
        self.assertEqual(chain.status, ChainStatus.INTERRUPTED)


class TestChainFormatElapsed(unittest.TestCase):
    """P2-14: Chain.format_elapsed boundary outputs."""

    def test_zero_seconds_renders_milliseconds(self):
        self.assertEqual(Chain.format_elapsed(0), "0ms")

    def test_sub_second_renders_milliseconds(self):
        self.assertEqual(Chain.format_elapsed(0.5), "500ms")

    def test_just_under_one_second_renders_milliseconds(self):
        self.assertEqual(Chain.format_elapsed(0.999), "999ms")

    def test_exactly_one_second_renders_seconds(self):
        self.assertEqual(Chain.format_elapsed(1), "1.0s")

    def test_just_under_one_minute_renders_seconds(self):
        self.assertEqual(Chain.format_elapsed(59.9), "59.9s")

    def test_exactly_fifty_nine_seconds(self):
        self.assertEqual(Chain.format_elapsed(59), "59.0s")

    def test_exactly_sixty_seconds_rolls_to_minutes(self):
        self.assertEqual(Chain.format_elapsed(60), "1m 0s")

    def test_one_hour(self):
        self.assertEqual(Chain.format_elapsed(3600), "60m 0s")

    def test_one_hour_fifty_nine_minutes(self):
        self.assertEqual(Chain.format_elapsed(3600 + 59 * 60), "119m 0s")

    def test_one_hour_fifty_nine_minutes_thirty_seconds(self):
        self.assertEqual(Chain.format_elapsed(3600 + 59 * 60 + 30), "119m 30s")


class TestChainFormatTokens(unittest.TestCase):
    """U3: Chain.format_tokens boundary outputs."""

    def test_below_thousand_is_raw(self):
        self.assertEqual(Chain.format_tokens(0), "0")

    def test_just_under_thousand_is_raw(self):
        self.assertEqual(Chain.format_tokens(999), "999")

    def test_thousand_rolls_to_k(self):
        # 1000 / 1000 = 1.0 → "1.0k"
        self.assertEqual(Chain.format_tokens(1000), "1.0k")

    def test_twelve_hundred(self):
        self.assertEqual(Chain.format_tokens(1200), "1.2k")

    def test_twelve_thousand(self):
        self.assertEqual(Chain.format_tokens(12345), "12.3k")

    def test_just_under_million_stays_k(self):
        self.assertEqual(Chain.format_tokens(999_999), "1000.0k")

    def test_million_rolls_to_m(self):
        self.assertEqual(Chain.format_tokens(1_000_000), "1.0M")

    def test_one_and_a_half_million(self):
        self.assertEqual(Chain.format_tokens(1_500_000), "1.5M")


class TestChainFooterWidgetTokenDisplay(unittest.TestCase):
    """U3: ChainFooterWidget renders per-chain input/cached/output tokens."""

    def _footer_text(self, chain: Chain) -> str:
        # Import lazily so a textual import failure in the test environment
        # only affects these cases, not the rest of the test module.
        from stupidex.widgets.message_widget import ChainFooterWidget

        widget = ChainFooterWidget(chain)
        return widget._build_text()

    def test_footer_text_with_usage_shows_subset_format(self):
        chain = Chain(model="gpt-4o")
        chain.messages = [
            Message(MessageRole.USER, "hi", MessageType.TEXT),
            Message(
                MessageRole.ASSISTANT,
                "hello",
                MessageType.TEXT,
                usage=Usage(1000, 200, 1200, cached_tokens=400),
            ),
        ]
        text = self._footer_text(chain)
        self.assertIn("1.0k", text)  # input
        self.assertIn("400", text)  # cached (parenthetical subset)
        self.assertIn("200", text)  # output
        self.assertIn("↑1.0k", text)
        self.assertIn("(⟲400)", text)
        self.assertIn("↓200", text)

    def test_footer_text_no_usage_omits_token_segment(self):
        chain = Chain(model="gpt-4o")
        chain.messages = [
            Message(MessageRole.USER, "hi", MessageType.TEXT),
            Message(MessageRole.ASSISTANT, "hello", MessageType.TEXT),
        ]
        text = self._footer_text(chain)
        self.assertIn("gpt-4o", text)
        self.assertNotIn("↑", text)
        self.assertNotIn("↓", text)
        self.assertNotIn("⟲", text)

    def test_footer_text_sums_all_usage_messages(self):
        chain = Chain(model="m")
        chain.messages = [
            Message(
                MessageRole.ASSISTANT,
                "first",
                MessageType.TEXT,
                usage=Usage(10, 5, 15, cached_tokens=1),
            ),
            Message(
                MessageRole.ASSISTANT,
                "second",
                MessageType.TEXT,
                usage=Usage(2000, 800, 2800, cached_tokens=500),
            ),
        ]
        text = self._footer_text(chain)
        # Cumulative sum across both agentic-loop calls: 2010 / 501 / 805.
        self.assertIn("2.0k", text)  # 2010 -> "2.0k"
        self.assertIn("501", text)  # cached sum
        self.assertIn("805", text)  # output sum


class TestChainFooterDelegatedSubtotal(unittest.TestCase):
    """U7: ChainFooterWidget renders the delegated-subagent subtotal."""

    def _footer_text(
        self,
        chain: Chain,
        subagent_subtotal=None,
    ) -> str:
        from stupidex.widgets.message_widget import ChainFooterWidget

        widget = ChainFooterWidget(chain, subagent_subtotal=subagent_subtotal)
        return widget._build_text()

    def test_attributed_subtotal_rendered_for_own_chain(self):
        """Chain 0 has its own usage + a subagent subtotal; footer shows both.
        Chain 1 has no subagent → no (sub:) segment."""
        chain0 = Chain(model="m0")
        chain0.messages = [
            Message(MessageRole.USER, "hi", MessageType.TEXT),
            Message(
                MessageRole.ASSISTANT,
                "hello",
                MessageType.TEXT,
                usage=Usage(1000, 200, 1200, cached_tokens=400),
            ),
        ]
        # Attributed subtotal for chain 0: prompt=500, cached=100, completion=50.
        def sub0():
            return (500, 100, 50, 650)

        text0 = self._footer_text(chain0, subagent_subtotal=sub0)
        self.assertIn("↑1.0k", text0)  # chain's own input
        self.assertIn("(⟲400)", text0)  # chain's own cached
        self.assertIn("↓200", text0)  # chain's own output
        # sub segment
        self.assertIn("(sub:", text0)
        self.assertIn("↑500", text0)  # sub input
        self.assertIn("(⟲100)", text0)  # sub cached
        self.assertIn("↓50", text0)  # sub output

        # Chain 1 with no attributed subagents (provider returns None).
        chain1 = Chain(model="m1")
        chain1.messages = [
            Message(
                MessageRole.ASSISTANT,
                "hi",
                MessageType.TEXT,
                usage=Usage(10, 5, 15, cached_tokens=1),
            ),
        ]
        text1 = self._footer_text(chain1, subagent_subtotal=lambda: None)
        self.assertNotIn("(sub:", text1)

    def test_no_subagents_no_sub_segment(self):
        """A chain whose provider returns None → no (sub:) segment."""
        chain = Chain(model="m")
        chain.messages = [
            Message(
                MessageRole.ASSISTANT,
                "x",
                MessageType.TEXT,
                usage=Usage(100, 10, 110, cached_tokens=5),
            ),
        ]
        text = self._footer_text(chain, subagent_subtotal=lambda: None)
        self.assertNotIn("(sub:", text)
        # own usage still present
        self.assertIn("↑100", text)
        self.assertIn("↓10", text)

    def test_multiple_subagents_summed_together(self):
        """Two subagents attributed to the same chain → subtotals summed
        together by the provider (which aggregates before returning)."""
        chain = Chain(model="m")
        chain.messages = [
            Message(
                MessageRole.ASSISTANT,
                "x",
                MessageType.TEXT,
                usage=Usage(1000, 200, 1200, cached_tokens=400),
            ),
        ]
        # Provider returns the summed total of two attributed subagents.
        def sub():
            # subagent A: prompt=500; subagent B: prompt=300 → total 800.
            return (800, 150, 75, 1025)

        text = self._footer_text(chain, subagent_subtotal=sub)
        self.assertIn("(sub:", text)
        self.assertIn("↑800", text)
        self.assertIn("(⟲150)", text)
        self.assertIn("↓75", text)

    def test_zero_subtotal_omits_sub_segment(self):
        """When the provider returns a zero subtotal (no attributable usage),
        the (sub:) segment is omitted (no noise)."""
        chain = Chain(model="m")
        chain.messages = [
            Message(
                MessageRole.ASSISTANT,
                "x",
                MessageType.TEXT,
                usage=Usage(1000, 200, 1200, cached_tokens=400),
            ),
        ]
        text = self._footer_text(chain, subagent_subtotal=lambda: (0, 0, 0, 0))
        self.assertNotIn("(sub:", text)

    def test_provider_on_app_helper_matches_session(self):
        """The app-level _chain_subagent_subtotals helper sums attributed
        subagent records' final-usage messages correctly."""
        from stupidex.agents.manager import SubagentRecord, SubagentState
        from stupidex.app import _chain_subagent_subtotals
        from stupidex.domain.agent import Agent, AgentTypes, ModelTier
        from stupidex.domain.session import Session

        agent = Agent(
            name="Subagent",
            type=AgentTypes.SUBAGENT,
            tier=ModelTier.PAPUDO,
            description="d",
            system_prompt="p",
        )
        # Two subagents attributed to chain 0, one to chain 1.
        def rec(rec_id, parent_idx, prompt, cached, completion, total):
            return SubagentRecord(
                id=rec_id,
                agent=agent,
                state=SubagentState.COMPLETED,
                label=rec_id,
                task="t",
                start_time=1.0,
                end_time=2.0,
                parent_chain_index=parent_idx,
                chain=Chain(
                    model="sub",
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
                ),
            )

        session = Session(name="S", id="s", model="m")
        session.subagent_manager._subagents["a"] = rec("a", 0, 500, 100, 50, 650)
        session.subagent_manager._subagents["b"] = rec("b", 0, 300, 50, 25, 375)
        session.subagent_manager._subagents["c"] = rec("c", 1, 900, 0, 0, 900)

        totals0 = _chain_subagent_subtotals(session, 0)
        self.assertEqual(totals0, (800, 150, 75, 1025))

        totals1 = _chain_subagent_subtotals(session, 1)
        self.assertEqual(totals1, (900, 0, 0, 900))

        totals2 = _chain_subagent_subtotals(session, 2)
        self.assertIsNone(totals2)


if __name__ == "__main__":
    unittest.main()
