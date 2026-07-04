import asyncio
import os
import time
from datetime import datetime
from typing import Any
from xml.sax.saxutils import escape

from orchid.agents.manager import format_subagent_attrs, get_subagent_manager
from orchid.config import get_config
from orchid.domain.message import Message, MessageRole, MessageType
from orchid.domain.todo import get_todo_store
from orchid.tools.background_store import get_background_store
from orchid.utils import directory_tree

_TREE_CACHE: tuple[str, float, str] | None = None
_TREE_TTL = 5.0

# -- background commands display caps -----------------------------------------
_BG_MAX_ENTRIES = 5       # most-recent agent entries shown
_BG_TAIL_LINES = 8        # lines per entry tail
_BG_TAIL_CHARS = 500      # max chars per entry tail


async def build_dynamic_system_prompt() -> Message:
    global _TREE_CACHE
    cfg = get_config()
    cwd = os.getcwd()

    now = time.monotonic()
    if _TREE_CACHE and _TREE_CACHE[0] == cwd and _TREE_CACHE[1] > now:
        tree = _TREE_CACHE[2]
    else:
        loop = asyncio.get_running_loop()
        tree = await loop.run_in_executor(None, directory_tree, cwd, cfg.directory_tree_depth)
        _TREE_CACHE = (cwd, now + _TREE_TTL, tree)  # type: ignore[reportConstantRedefinition]

    esc_cwd = escape(cwd)
    esc_tree = escape(tree)
    content = f"""
<current_time>{datetime.now().strftime("%Y-%m-%d %H:%M:%S")}</current_time>
<working_directory>{esc_cwd}</working_directory>
<directory_structure>
{esc_tree}
</directory_structure>
"""

    subagent_manager = get_subagent_manager()
    states: list[dict[str, Any]] = subagent_manager.get_states()  # type: ignore[reportUnknownVariableType,reportUnknownMemberType]
    if states:
        parts: list[str] = []
        for s in states:
            e = escape
            attrs = format_subagent_attrs(s["id"], s["name"], s["type"], s["state"], s["elapsed"])
            task_block = f"<task>\n{e(s['task'])}\n</task>" if s.get(
                "task") else ""
            parts.append(
                f'  <subagent {attrs}>\n  {task_block}\n  </subagent>')
        content += "\n<subagents>\n" + "\n".join(parts) + "\n</subagents>\n"

    store = get_todo_store()
    tasks = store.list()
    if tasks:
        lines: list[str] = []
        for t in tasks:
            line = f"  <todo id=\"{escape(t.id)}\" status=\"{escape(t.status.value)}\">"
            line += f"\n    <title>{escape(t.title)}</title>"
            if t.description:
                line += f"\n    <description>{escape(t.description)}</description>"
            if t.subagent_id:
                line += f"\n    <subagent_id>{escape(t.subagent_id)}</subagent_id>"
            line += "\n  </todo>"
            lines.append(line)
        content += "\n<todos>\n" + "\n".join(lines) + "\n</todos>\n"

    # -- <background_commands> block -------------------------------------------
    bg_store = get_background_store()
    bg_entries = bg_store.list_visible()
    if bg_entries:
        now = time.monotonic()
        # Split into USER-owned and AGENT-owned.
        user_entries = [e for e in bg_entries if e.owner == "USER"]
        agent_entries = [e for e in bg_entries if e.owner != "USER"]
        # Keep most-recent _BG_MAX_ENTRIES from agent, plus all USER entries.
        agent_entries = agent_entries[-_BG_MAX_ENTRIES:]
        selected = agent_entries + user_entries

        bg_lines: list[str] = []
        for entry in selected:
            runtime = int(now - entry.created_at)
            last_output_age = int(now - entry.last_output_at)
            status = "running" if entry.exit_code is None else "exited"

            attrs = (
                f'id="{entry.id}" '
                f'command="{escape(entry.command)}" '
                f'runtime="{runtime}" '
                f'last_output_age="{last_output_age}" '
                f'owner="{escape(entry.owner)}" '
                f'interactive="{"true" if entry.interactive else "false"}" '
                f'status="{status}"'
            )
            if entry.exit_code is not None:
                attrs += f' exit_code="{entry.exit_code}"'

            tail_text = entry.buffer.get_tail(_BG_TAIL_LINES)
            # Cap tail chars.
            if len(tail_text) > _BG_TAIL_CHARS:
                tail_text = tail_text[:_BG_TAIL_CHARS] + "..."
            tail_escaped = escape(tail_text)

            bg_lines.append(f'  <command {attrs}>')
            bg_lines.append("    <tail>")
            bg_lines.append(f"      {tail_escaped}")
            bg_lines.append("    </tail>")
            bg_lines.append("  </command>")

        content += "\n<background_commands>\n" + "\n".join(bg_lines) + "\n</background_commands>\n"

    return Message(
        role=MessageRole.SYSTEM,
        content=content,
        type=MessageType.TEXT,
    )
