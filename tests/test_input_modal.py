"""Tests for the InputModal screen (P2-208)."""

import unittest
from unittest.mock import MagicMock

from textual.widgets import Button, Input

from stupidex.screens.input_modal import InputModal


class TestInputModal(unittest.TestCase):
    def _make_modal(self, current_value: str = "") -> InputModal:
        modal = InputModal("Title", placeholder="ph", default=current_value)
        modal.dismiss = MagicMock()
        modal.query_one = MagicMock(return_value=MagicMock(value=current_value))
        return modal

    def test_ok_with_text_returns_value(self):
        modal = InputModal("Title", default="hello")
        modal.dismiss = MagicMock()
        modal.query_one = MagicMock(return_value=MagicMock(value="hello"))
        modal.on_button_pressed(Button.Pressed(button=MagicMock(id="modal-ok")))
        modal.dismiss.assert_called_once_with("hello")

    def test_cancel_returns_none(self):
        modal = self._make_modal("ignored")
        modal.on_button_pressed(Button.Pressed(button=MagicMock(id="modal-cancel")))
        modal.dismiss.assert_called_once_with(None)

    def test_ok_with_empty_value_returns_none(self):
        modal = self._make_modal("")
        modal.on_button_pressed(Button.Pressed(button=MagicMock(id="modal-ok")))
        modal.dismiss.assert_called_once_with(None)

    def test_input_submitted_with_text_returns_value(self):
        modal = InputModal("Title")
        modal.dismiss = MagicMock()
        event = MagicMock(spec=Input.Submitted)
        event.value = "typed-text"
        modal.on_input_submitted(event)
        modal.dismiss.assert_called_once_with("typed-text")

    def test_input_submitted_with_empty_returns_none(self):
        modal = InputModal("Title")
        modal.dismiss = MagicMock()
        event = MagicMock(spec=Input.Submitted)
        event.value = ""
        modal.on_input_submitted(event)
        modal.dismiss.assert_called_once_with(None)

    def test_escape_returns_none(self):
        modal = self._make_modal("anything")
        modal.key_escape()
        modal.dismiss.assert_called_once_with(None)


if __name__ == "__main__":
    unittest.main()
