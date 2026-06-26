from textual.theme import BUILTIN_THEMES, Theme

THEMES: dict[str, Theme] = {
    "default": BUILTIN_THEMES["textual-dark"],
    "solarized-light": BUILTIN_THEMES["solarized-light"],
    "bluey": Theme(
        name="bluey",
        primary="#1E90FF",
        secondary="#7B61FF",
        warning="#FFA62B",
        error="#DC143C",
        success="#3CB371",
        accent="#6D6DFF",
        foreground="#F5F5F5",
        background="#1A1A2E",
        surface="#252540",
        panel="#1E1E36",
        boost="#1A1A2E",
        dark=True,
    ),
    "windows_xp": Theme(
        name="windows_xp",
        primary="#0054E3",
        secondary="#0078D4",
        warning="#FF8C00",
        error="#CC0000",
        success="#3A9B3A",
        accent="#316AC5",
        foreground="#000000",
        background="#ECE9D8",
        surface="#FFFFFF",
        panel="#D6D2C2",
        boost="#E8E4D4",
        dark=False,
    ),
    "green_terminal": Theme(
        name="green_terminal",
        primary="#00FF41",
        secondary="#00CC33",
        warning="#33FF00",
        error="#FF0000",
        success="#00FF41",
        accent="#00FF41",
        foreground="#00FF41",
        background="#0D0208",
        surface="#0A1A0A",
        panel="#0D0208",
        boost="#0A120A",
        dark=True,
    ),
}


class ThemeRegistry:
    def __init__(self) -> None:
        self._themes: dict[str, Theme] = dict(THEMES)

    def get(self, name: str) -> Theme:
        if name not in self._themes:
            raise ValueError(f"Unknown theme: {name}")
        return self._themes[name]

    def list_themes(self) -> list[str]:
        return list(self._themes.keys())


_REGISTRY: ThemeRegistry | None = None


def get_theme_registry() -> ThemeRegistry:
    global _REGISTRY
    if _REGISTRY is None:
        _REGISTRY = ThemeRegistry()
    return _REGISTRY
