from textual import events
from textual.message import Message
from textual.widgets import OptionList, TextArea
from textual.widgets.option_list import Option


class CommandPicker(OptionList):
    """Inline command picker shown above the input when the user types /.

    When shown, the OptionList receives focus so Up/Down/Enter work natively.
    Printable characters and backspace are forwarded to the input TextArea.
    """

    class CommandSelected(Message):
        """Posted when a command is picked."""

        def __init__(self, command: str) -> None:
            self.command = command
            super().__init__()

    def __init__(self, commands: dict[str, str]) -> None:
        self._all_commands = commands
        self._filtered: list[str] = []
        super().__init__(id="command-picker")
        self.display = False

    def update_filter(self, query: str) -> None:
        if not query.startswith("/"):
            self.hide()
            return
        parts = query.lstrip("/").strip().split()
        raw = parts[0] if parts else ""
        self._filtered = []
        for cmd, _desc in self._all_commands.items():
            cmd_name = cmd.lstrip("/")
            if not raw or cmd_name.startswith(raw) or raw in cmd_name:
                self._filtered.append(cmd)
        self.clear_options()
        if self._filtered:
            self.add_options([Option(f"{cmd}  [dim]{self._all_commands[cmd]}[/dim]", id=cmd) for cmd in self._filtered])
            self.highlighted = 0
            self.display = True
            self.focus()
        else:
            self.hide()

    def get_selected_command(self) -> str | None:
        highlighted = self.highlighted
        if highlighted is not None and 0 <= highlighted < len(self._filtered):
            return self._filtered[highlighted]
        return self._filtered[0] if self._filtered else None

    def hide(self) -> None:
        self.display = False
        self._filtered = []
        self.clear_options()
        try:
            self.app.query_one("#input", TextArea).focus()
        except Exception:
            pass

    def on_key(self, event: events.Key) -> None:
        text_area = self.app.query_one("#input", TextArea)

        if event.key == "escape":
            self.hide()
            event.stop()
            return

        if event.key == "backspace":
            if text_area.text:
                text_area.text = text_area.text[:-1]
                self.update_filter(text_area.text.strip())
            else:
                self.hide()
            event.stop()
            return

        if event.is_printable and event.character:
            text_area.text += event.character
            self.update_filter(text_area.text.strip())
            event.stop()
            return

        # Up/Down/Enter handled by OptionList bindings

    def on_option_list_option_selected(self, event: OptionList.OptionSelected) -> None:
        if event.option_id and event.option_id.startswith("/"):
            self.post_message(self.CommandSelected(event.option_id))
