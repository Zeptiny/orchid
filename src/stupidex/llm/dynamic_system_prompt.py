import asyncio
import os
import time
from datetime import datetime
from xml.sax.saxutils import escape

from stupidex.agents.manager import format_subagent_attrs, get_subagent_manager
from stupidex.config import get_config
from stupidex.domain.message import Message, MessageRole, MessageType
from stupidex.domain.todo import get_todo_store
from stupidex.utils import directory_tree

_TREE_CACHE: tuple[str, float, str] | None = None
_TREE_TTL = 5.0


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
        _TREE_CACHE = (cwd, now + _TREE_TTL, tree)

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
    states = subagent_manager.get_states()
    if states:
        parts = []
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
        lines = []
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

    return Message(
        role=MessageRole.SYSTEM,
        content=content,
        type=MessageType.TEXT,
    )
