from __future__ import annotations

from textual.containers import ScrollableContainer
from textual.widget import Widget

_BOTTOM_THRESHOLD = 5.0


class SmartScrollContainer(ScrollableContainer):
    """ScrollableContainer that auto-follows new content unless the user scrolls away.

    Tracks whether the user is "following the tail" (auto-scroll on) or
    "reading history" (auto-scroll off). When the user scrolls up, auto-scroll
    pauses; when they scroll back to the bottom (within a small tolerance),
    auto-scroll re-engages.
    """

    def __init__(
        self,
        *children: Widget,
        name: str | None = None,
        id: str | None = None,
        classes: str | None = None,
        disabled: bool = False,
        can_focus: bool | None = None,
        can_focus_children: bool | None = None,
        can_maximize: bool | None = None,
    ) -> None:
        super().__init__(
            *children,
            name=name,
            id=id,
            classes=classes,
            disabled=disabled,
            can_focus=can_focus,
            can_focus_children=can_focus_children,
            can_maximize=can_maximize,
        )
        self._auto_scroll: bool = True
        self._programmatic_scroll: bool = False

    def watch_scroll_y(self, old_value: float, new_value: float) -> None:
        super().watch_scroll_y(old_value, new_value)
        if self._programmatic_scroll:
            return
        self._auto_scroll = self._is_at_bottom(new_value)

    def _is_at_bottom(self, scroll_y: float | None = None) -> bool:
        if scroll_y is None:
            scroll_y = self.scroll_y
        if self.max_scroll_y <= 0:
            return True
        return scroll_y >= self.max_scroll_y - _BOTTOM_THRESHOLD

    def maybe_scroll_to_end(self) -> None:
        """Scroll to the end if auto-scroll is engaged."""
        if not self._auto_scroll:
            return
        self._programmatic_scroll = True
        self.scroll_end(animate=False)
        self.call_after_refresh(self._clear_programmatic_scroll)

    def force_scroll_to_end(self) -> None:
        """Always scroll to the end and re-engage auto-scroll."""
        self._auto_scroll = True
        self._programmatic_scroll = True
        self.scroll_end(animate=False)
        self.call_after_refresh(self._clear_programmatic_scroll)

    def _clear_programmatic_scroll(self) -> None:
        self._programmatic_scroll = False

    def reset_auto_scroll(self) -> None:
        """Reset to default state (used on session switch)."""
        self._auto_scroll = True
        self._programmatic_scroll = False

    def disable_auto_scroll(self) -> None:
        """Temporarily pause auto-scroll (e.g. during bulk history load)."""
        self._auto_scroll = False
