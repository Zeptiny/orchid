import logging
import os
import sys
from pathlib import Path

from stupidex.app import Stupidex
from stupidex.config import HOME_CONFIG_DIR, ConfigManager


def _setup_logging() -> Path | None:
    """Attach a file handler so diagnostics survive the TUI.

    Logs at INFO+ go to ``~/.stupidex/logs/stupidex.log`` (created on first
    run). Set ``STUPIDEX_LOG_LEVEL=DEBUG`` for verbose chunk-level traces.
    WARNING+ also prints to stderr — but in a TUI session, stderr is usually
    lost, so the file is the primary diagnostic surface. When truncation
    strikes, check the file for the ``stream ended:`` summary line.
    """
    log_dir = HOME_CONFIG_DIR / "logs"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        return None
    log_path = log_dir / "stupidex.log"
    level = os.environ.get("STUPIDEX_LOG_LEVEL", "INFO").upper()
    handler = logging.FileHandler(log_path, encoding="utf-8")
    handler.setLevel(getattr(logging, level, logging.INFO))
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(name)s %(levelname)s %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    ))
    root = logging.getLogger("stupidex")
    root.setLevel(getattr(logging, level, logging.INFO))
    root.addHandler(handler)
    return log_path


def _restore_terminal_echo() -> None:
    """Restore canonical terminal state (ECHO/ICANON/ISIG) after the app exits.

    Defense-in-depth against Textual's ``stop_application_mode`` being skipped
    when an exception or hung shutdown prevents termios restoration — leaving
    the terminal in raw mode where input is accepted but not echoed.
    """
    try:
        import termios
        fd = sys.stderr.fileno()
        if not os.isatty(fd):
            return
        attrs = termios.tcgetattr(fd)
        attrs[3] |= termios.ECHO | termios.ICANON | termios.ISIG | termios.IEXTEN
        termios.tcsetattr(fd, termios.TCSANOW, attrs)
    except Exception:
        pass


def main():
    ConfigManager.ensure_home_config()
    ConfigManager.load()
    errors = ConfigManager.errors()
    if errors:
        print("STUPIDEX CONFIGURATION ERRORS:", file=sys.stderr)
        for err in errors:
            print(f"  - {err}", file=sys.stderr)
        print(file=sys.stderr)
        print("Fix the errors in ~/.stupidex/config.json or .stupidex.json and try again.", file=sys.stderr)
        sys.exit(1)
    log_path = _setup_logging()
    if log_path:
        logging.getLogger("stupidex.main").info(
            "stupidex starting; logs at %s (level=%s)",
            log_path, os.environ.get("STUPIDEX_LOG_LEVEL", "INFO"),
        )
    try:
        app = Stupidex()
        app.run()
    finally:
        _restore_terminal_echo()

    if app.restart_requested:
        os.execv(sys.executable, [sys.executable, *sys.argv])


if __name__ == "__main__":
    main()
