"""Tests for the OptionPicker screen (P2-209)."""

import unittest
from unittest.mock import MagicMock, PropertyMock, patch

from textual.widgets import Input

from stupidex.screens.picker import OptionPicker, PickerItem


def _make_picker(items=None, header=None) -> OptionPicker:
    if items is None:
        items = [
            PickerItem(label="Alpha", id="a"),
            PickerItem(label="Beta", id="b"),
            PickerItem(label="Gamma", id="c"),
        ]
    picker = OptionPicker(items, header=header)
    picker.dismiss = MagicMock()
    return picker


class TestOptionPickerCompose(unittest.TestCase):
    def test_build_options_uses_filtered_items(self):
        items = [PickerItem("A", "a"), PickerItem("B", "b")]
        picker = OptionPicker(items)
        opts = picker._build_options()
        self.assertEqual(len(opts), 2)
        self.assertEqual(opts[0].id, "a")
        self.assertEqual(opts[1].id, "b")

    def test_build_options_reflects_filtered_subset(self):
        items = [PickerItem("A", "a"), PickerItem("B", "b"), PickerItem("C", "c")]
        picker = OptionPicker(items)
        picker._filtered = [items[1]]
        opts = picker._build_options()
        self.assertEqual(len(opts), 1)
        self.assertEqual(opts[0].id, "b")


class TestOptionPickerFilter(unittest.TestCase):
    def test_filter_narrows_list_by_label(self):
        picker = _make_picker()
        option_list = MagicMock()
        picker.query_one = MagicMock(return_value=option_list)
        picker._filter("alph")
        self.assertEqual([i.id for i in picker._filtered], ["a"])
        option_list.clear_options.assert_called_once()
        option_list.add_options.assert_called_once()
        self.assertEqual(option_list.highlighted, 0)

    def test_filter_narrows_list_by_id(self):
        picker = _make_picker()
        option_list = MagicMock()
        picker.query_one = MagicMock(return_value=option_list)
        picker._filter("b")
        self.assertEqual([i.id for i in picker._filtered], ["b"])

    def test_filter_no_matches_clears_options(self):
        picker = _make_picker()
        option_list = MagicMock()
        picker.query_one = MagicMock(return_value=option_list)
        picker._filter("zzz")
        self.assertEqual(picker._filtered, [])
        option_list.clear_options.assert_called_once()
        option_list.add_options.assert_not_called()

    def test_on_input_changed_filters_for_search_input(self):
        picker = _make_picker()
        option_list = MagicMock()
        picker.query_one = MagicMock(return_value=option_list)
        event = MagicMock(spec=Input.Changed)
        event.input = MagicMock(id="picker-search")
        event.value = "beta"
        picker.on_input_changed(event)
        self.assertEqual([i.id for i in picker._filtered], ["b"])

    def test_on_input_changed_ignores_non_search_input(self):
        picker = _make_picker()
        event = MagicMock(spec=Input.Changed)
        event.input = MagicMock(id="something-else")
        event.value = "beta"
        picker.on_input_changed(event)
        self.assertEqual(len(picker._filtered), 3)


class TestOptionPickerSelection(unittest.TestCase):
    def test_option_selected_dismisses_with_id(self):
        picker = _make_picker()
        event = MagicMock()
        event.option_id = "b"
        picker.on_option_list_option_selected(event)
        picker.dismiss.assert_called_once_with("b")

    def test_option_selected_with_empty_id_not_dismissed(self):
        picker = _make_picker()
        event = MagicMock()
        event.option_id = ""
        picker.on_option_list_option_selected(event)
        picker.dismiss.assert_not_called()

    def test_option_selected_with_none_id_not_dismissed(self):
        picker = _make_picker()
        event = MagicMock()
        event.option_id = None
        picker.on_option_list_option_selected(event)
        picker.dismiss.assert_not_called()

    def test_input_submitted_dismisses_highlighted(self):
        picker = _make_picker()
        option_list = MagicMock()
        option_list.highlighted = 1
        picker.query_one = MagicMock(return_value=option_list)
        event = MagicMock(spec=Input.Submitted)
        event.input = MagicMock(id="picker-search")
        picker.on_input_submitted(event)
        picker.dismiss.assert_called_once_with("b")

    def test_input_submitted_falls_back_to_first_when_no_highlight(self):
        picker = _make_picker()
        option_list = MagicMock()
        option_list.highlighted = None
        picker.query_one = MagicMock(return_value=option_list)
        event = MagicMock(spec=Input.Submitted)
        event.input = MagicMock(id="picker-search")
        picker.on_input_submitted(event)
        picker.dismiss.assert_called_once_with("a")

    def test_input_submitted_no_filtered_does_nothing(self):
        picker = _make_picker()
        picker._filtered = []
        option_list = MagicMock()
        picker.query_one = MagicMock(return_value=option_list)
        event = MagicMock(spec=Input.Submitted)
        event.input = MagicMock(id="picker-search")
        picker.on_input_submitted(event)
        picker.dismiss.assert_not_called()

    def test_escape_dismisses_with_none(self):
        picker = _make_picker()
        picker.key_escape()
        picker.dismiss.assert_called_once_with(None)


class TestOptionPickerKeyNav(unittest.TestCase):
    def test_key_down_from_search_focuses_option_list(self):
        picker = _make_picker()
        search = MagicMock()
        option_list = MagicMock()
        option_list.highlighted = None
        picker.query_one = MagicMock(side_effect=lambda sel, _cls=None: search if "search" in sel else option_list)
        with patch.object(type(picker), "focused", new_callable=PropertyMock, return_value=search):
            picker.key_down()
        option_list.focus.assert_called_once()
        self.assertEqual(option_list.highlighted, 0)

    def test_key_down_keeps_existing_highlight(self):
        picker = _make_picker()
        search = MagicMock()
        option_list = MagicMock()
        option_list.highlighted = 2
        picker.query_one = MagicMock(side_effect=lambda sel, _cls=None: search if "search" in sel else option_list)
        with patch.object(type(picker), "focused", new_callable=PropertyMock, return_value=search):
            picker.key_down()
        self.assertEqual(option_list.highlighted, 2)

    def test_key_up_from_option_list_at_zero_focuses_search(self):
        picker = _make_picker()
        search = MagicMock()
        option_list = MagicMock()
        option_list.highlighted = 0
        picker.query_one = MagicMock(side_effect=lambda sel, _cls=None: search if "search" in sel else option_list)
        with patch.object(type(picker), "focused", new_callable=PropertyMock, return_value=option_list):
            picker.key_up()
        search.focus.assert_called_once()

    def test_key_up_from_option_list_with_none_highlight_focuses_search(self):
        picker = _make_picker()
        search = MagicMock()
        option_list = MagicMock()
        option_list.highlighted = None
        picker.query_one = MagicMock(side_effect=lambda sel, _cls=None: search if "search" in sel else option_list)
        with patch.object(type(picker), "focused", new_callable=PropertyMock, return_value=option_list):
            picker.key_up()
        search.focus.assert_called_once()

    def test_key_up_from_search_does_not_focus_search(self):
        picker = _make_picker()
        search = MagicMock()
        option_list = MagicMock()
        option_list.highlighted = 0
        picker.query_one = MagicMock(side_effect=lambda sel, _cls=None: search if "search" in sel else option_list)
        with patch.object(type(picker), "focused", new_callable=PropertyMock, return_value=search):
            picker.key_up()
        search.focus.assert_not_called()


if __name__ == "__main__":
    unittest.main()
