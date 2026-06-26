from textual.app import ComposeResult
from textual.containers import Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label


class InputModal(ModalScreen[str | None]):
    """Simple modal that asks the user for text input."""

    CSS = """
    InputModal {
        align: center middle;
    }

    #input-modal-container {
        width: 50;
        height: auto;
        max-height: 20;
        border: thick $primary;
        background: $surface;
        padding: 1 2;
    }

    #input-modal-container Label {
        margin-bottom: 1;
        text-align: center;
    }

    #input-modal-container Input {
        margin-bottom: 1;
    }

    #input-modal-buttons {
        width: 100%;
        height: auto;
        align: center middle;
    }

    #input-modal-buttons Button {
        margin: 0 1;
    }
    """

    def __init__(self, title: str, placeholder: str = "", default: str = "") -> None:
        super().__init__()
        self._title = title
        self._placeholder = placeholder
        self._default = default

    def compose(self) -> ComposeResult:
        with Vertical(id="input-modal-container"):
            yield Label(self._title)
            yield Input(
                placeholder=self._placeholder,
                value=self._default,
                id="modal-input",
            )
            with Vertical(id="input-modal-buttons"):
                yield Button("OK", variant="primary", id="modal-ok")
                yield Button("Cancel", variant="default", id="modal-cancel")

    def on_mount(self) -> None:
        self.query_one("#modal-input", Input).focus()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "modal-ok":
            value = self.query_one("#modal-input", Input).value
            self.dismiss(value if value else None)
        else:
            self.dismiss(None)

    def on_input_submitted(self, event: Input.Submitted) -> None:
        value = event.value
        self.dismiss(value if value else None)

    def key_escape(self) -> None:
        self.dismiss(None)
