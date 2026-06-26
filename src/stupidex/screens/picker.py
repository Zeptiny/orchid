from dataclasses import dataclass

from textual.containers import Vertical
from textual.screen import Screen
from textual.widgets import Input, OptionList, Static
from textual.widgets.option_list import Option


@dataclass
class PickerItem:
    label: str
    id: str


class OptionPicker(Screen[str]):
    """Generic picker screen with search filtering that returns the selected id."""

    def __init__(self, items: list[PickerItem], header: str | None = None) -> None:
        super().__init__()
        self._items = items
        self._filtered: list[PickerItem] = list(items)
        self._header = header

    def _build_options(self) -> list[Option]:
        return [Option(item.label, id=item.id) for item in self._filtered]

    def compose(self):
        with Vertical(id="picker-container"):
            yield Input(placeholder="Search...", id="picker-search")
            if self._header:
                yield Static(self._header, id="picker-header")
            yield OptionList(*self._build_options(), id="picker-list")

    def on_mount(self) -> None:
        self.query_one("#picker-search", Input).focus()

    def _filter(self, query: str) -> None:
        q = query.lower()
        self._filtered = [item for item in self._items if q in item.label.lower() or q in item.id.lower()]
        option_list = self.query_one("#picker-list", OptionList)
        option_list.clear_options()
        if self._filtered:
            option_list.add_options(self._build_options())
            option_list.highlighted = 0

    def on_input_changed(self, event: Input.Changed) -> None:
        if event.input.id != "picker-search":
            return
        self._filter(event.value)

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        if event.option_id:
            self.dismiss(event.option_id)

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "picker-search":
            return
        if not self._filtered:
            return
        option_list = self.query_one("#picker-list", OptionList)
        if option_list.highlighted is not None and 0 <= option_list.highlighted < len(self._filtered):
            self.dismiss(self._filtered[option_list.highlighted].id)
        else:
            self.dismiss(self._filtered[0].id)

    def key_escape(self) -> None:
        self.dismiss(None)

    def key_down(self) -> None:
        search = self.query_one("#picker-search", Input)
        option_list = self.query_one("#picker-list", OptionList)
        if self.focused is search:
            option_list.focus()
            if option_list.highlighted is None and self._filtered:
                option_list.highlighted = 0

    def key_up(self) -> None:
        search = self.query_one("#picker-search", Input)
        option_list = self.query_one("#picker-list", OptionList)
        if self.focused is option_list and (option_list.highlighted is None or option_list.highlighted == 0):
            search.focus()
