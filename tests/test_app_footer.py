import unittest

from textual.widgets import Static

from orchid.app import InterruptState, Orchid, _get_shortcut_hints
from orchid.config import Config, ConfigManager
from orchid.domain.chain import Chain
from orchid.domain.message import Message, MessageRole, Usage


class FooterShortcutTest(unittest.TestCase):
    def test_streaming_shortcuts_prioritize_interrupt(self):
        hints = _get_shortcut_hints(
            InterruptState.IDLE,
            is_streaming=True,
            has_running_subagents=False,
            input_has_text=True,
        )
        self.assertEqual(hints, "Esc: interrupt agent | Ctrl+P: commands")
        self.assertNotIn("submit", hints)

    def test_confirm_agent_shortcuts_are_single_status(self):
        hints = _get_shortcut_hints(
            InterruptState.CONFIRM_AGENT,
            is_streaming=True,
            has_running_subagents=True,
            input_has_text=True,
        )
        self.assertEqual(hints, "Esc again: interrupt agent")

    def test_confirm_subagent_shortcuts_are_single_status(self):
        hints = _get_shortcut_hints(
            InterruptState.CONFIRM_SUBAGENTS,
            is_streaming=False,
            has_running_subagents=True,
            input_has_text=False,
        )
        self.assertEqual(hints, "Esc again: interrupt subagents")

    def test_idle_subagent_shortcuts_offer_interrupt(self):
        hints = _get_shortcut_hints(
            InterruptState.IDLE,
            is_streaming=False,
            has_running_subagents=True,
            input_has_text=False,
        )
        self.assertEqual(hints, "Esc: interrupt subagents | Ctrl+P: commands")


class AppFooterTest(unittest.IsolatedAsyncioTestCase):
    def tearDown(self) -> None:
        ConfigManager.reset()

    async def test_input_meta_renders_model_with_session_usage(self):
        ConfigManager._instance = Config(mcp_servers={})

        app = Orchid()
        async with app.run_test(size=(90, 25)):
            session = app.sessions.active
            self.assertIsNotNone(session)
            assert session is not None
            session.model = "default/mimo-v2.5-pro"
            session.chains = [
                Chain(
                    model=session.model,
                    messages=[
                        Message(
                            MessageRole.ASSISTANT,
                            "done",
                            usage=Usage(
                                prompt_tokens=1500,
                                cached_tokens=500,
                                completion_tokens=250,
                                total_tokens=1750,
                            ),
                        )
                    ],
                )
            ]

            await app.rerender_footer()

            label = str(app.query_one("#input-meta", Static).render())
            usage = str(app.query_one("#footer-usage", Static).render())
            self.assertEqual(label, "default/mimo-v2.5-pro")
            self.assertIn("↑1.5k", usage)
            self.assertIn("(⟲500)", usage)
            self.assertIn("↓250", usage)
            self.assertIn("Σ1.8k", usage)


if __name__ == "__main__":
    unittest.main()
