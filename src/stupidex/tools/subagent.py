from xml.sax.saxutils import escape

from stupidex.agents import get_agent_registry
from stupidex.agents.manager import format_subagent_attrs, get_current_chain_index, get_subagent_manager
from stupidex.config import get_model_for_tier
from stupidex.domain.agent import TIER_DESCRIPTIONS, AgentTypes, ModelTier
from stupidex.domain.tool import ExecutorResult, Tool, ToolParameter, ToolParameterProperties


def build_delegate_tool() -> Tool:
    registry = get_agent_registry()
    agent_lines = "\n".join(
        f"- {name} [{agent.tier.value}]: {agent.description}"
        for name, agent in registry.items() if agent.type == AgentTypes.SUBAGENT
    )
    tier_lines = "\n".join(
        f"- {tier.value}: {desc}"
        for tier, desc in TIER_DESCRIPTIONS.items()
    )
    return Tool(
        name="delegate_to_subagent",
        description="Delegate a task to a specialized subagent with an isolated context. Subagents do not share your context — you must provide all necessary information in the task description. Subagents cannot create subagents. Avoid spawning parallel subagents that edit the same files.",
        parameters=ToolParameter(
            properties={
                "name": ToolParameterProperties(
                    type="string",
                    description="A descriptive name for this subagent instance (e.g. 'explore auth module', 'review payment flow')"
                ),
                "task": ToolParameterProperties(
                    type="string",
                    description="The complete task description. Include all context the subagent needs: file paths, code snippets, requirements, constraints, and what to return."
                ),
                "type": ToolParameterProperties(
                    type="string",
                    description=f"The agent type to delegate to. Available agents:\n{agent_lines}"
                ),
                "tier": ToolParameterProperties(
                    type="string",
                    description=(
                        f"Override the agent's default model tier. "
                        f"The tier determines which model is used for this task. "
                        f"If omitted, the agent's predefined tier is used.\n\n"
                        f"Available tiers (from fastest to most capable):\n{tier_lines}"
                    )
                ),
            },
            required=["name", "task", "type"]
        ),
        action_label="Delegating...",
    )


async def execute_delegate_to_subagent(name: str, task: str, type: str, tier: str | None = None) -> ExecutorResult:
    registry = get_agent_registry()
    if type not in registry:
        available = ", ".join(registry.keys())
        return ExecutorResult(
            display=f"Unknown agent type: {type}",
            content=f"Error: agent type '{type}' does not exist. Available agents: {available}",
        )

    agent = registry[type]

    if tier is not None:
        try:
            resolved_tier = ModelTier.from_str(tier)
        except ValueError:
            valid = ", ".join(t.value for t in ModelTier)
            return ExecutorResult(
                display=f"Invalid tier: {tier}",
                content=f"Error: tier '{tier}' is not valid. Available tiers: {valid}",
            )
    else:
        resolved_tier = agent.tier

    model = get_model_for_tier(resolved_tier.value)
    record = await get_subagent_manager().spawn(
        name, task, type, model,
        parent_chain_index=get_current_chain_index(),
    )

    return ExecutorResult(
        display=f"Subagent '{name}' spawned (id: {record.id}, tier: {resolved_tier.value})",
        content=f'<subagent {format_subagent_attrs(record.id, name, type, "pending")} tier="{escape(resolved_tier.value)}">\n<task>\n{escape(task)}\n</task>\n</subagent>',
    )


wait_for_subagent = Tool(
    name="wait_for_subagent",
    description="Wait for one or more subagents to complete and get their results. Returns the subagent's final output, status, and any errors. Use after delegate_to_subagent to collect results.",
    parameters=ToolParameter(
        properties={
            "subagent_ids": ToolParameterProperties(
                type="array",
                description="List of subagent IDs to wait for",
                items={"type": "string"},
            ),
        },
        required=["subagent_ids"]
    ),
    action_label="Waiting...",
)


async def execute_wait_for_subagent(subagent_ids: list[str]) -> ExecutorResult:
    if not subagent_ids:
        return ExecutorResult(display="No subagent IDs provided", content="Error: subagent_ids must be a non-empty list of IDs.")

    records = await get_subagent_manager().wait(subagent_ids)

    if not records:
        return ExecutorResult(display="No subagents found", content=f"No subagents found for IDs: {', '.join(subagent_ids)}")

    parts = []
    for sid, record in records.items():
        status = record.state.value
        elapsed = record.elapsed_seconds

        e = escape
        attrs = format_subagent_attrs(sid, record.name, record.type, status, elapsed)
        task_block = f"<task>\n{e(record.task)}\n</task>" if record.task else ""
        if record.result:
            parts.append(
                f'<subagent {attrs}>\n{task_block}\n<result>\n{e(record.result)}\n</result>\n</subagent>')
        elif record.error:
            parts.append(
                f'<subagent {attrs}>\n{task_block}\n<error>\n{e(record.error)}\n</error>\n</subagent>')
        else:
            parts.append(f'<subagent {attrs}>\n{task_block}\n</subagent>')

    found_ids = set(records.keys())
    missing = [sid for sid in subagent_ids if sid not in found_ids]
    missing_block = ""
    if missing:
        missing_block = f'\n<not_found>{", ".join(escape(sid) for sid in missing)}</not_found>'

    content = "<subagents>\n" + \
        "\n".join(parts) + f"\n</subagents>{missing_block}"

    return ExecutorResult(
        display=f"Waited for {len(records)} subagent(s)",
        content=content,
    )


list_subagents = Tool(
    name="list_subagents",
    description="List all active and completed subagents with their current state, task description, and elapsed time. Use to check progress of running subagents or review what was dispatched.",
    parameters=ToolParameter(properties={}, required=[]),
    action_label="Checking subagents...",
)


async def execute_list_subagents() -> ExecutorResult:
    states = get_subagent_manager().get_states()

    if not states:
        return ExecutorResult(display="No subagents", content="<subagents />")

    parts = []
    for s in states:
        e = escape
        attrs = format_subagent_attrs(s["id"], s["name"], s["type"], s["state"], s["elapsed"])
        task_block = f"<task>\n{e(s['task'])}\n</task>" if s.get("task") else ""
        parts.append(f'<subagent {attrs}>\n{task_block}\n</subagent>')

    return ExecutorResult(
        display=f"{len(states)} subagent(s)",
        content="<subagents>\n" + "\n".join(parts) + "\n</subagents>",
    )


interrupt_subagents = Tool(
    name="interrupt_subagents",
    description="Interrupt one or more running subagents. Use when you need to stop subagents that are no longer needed or are taking too long. Returns which subagents were cancelled.",
    parameters=ToolParameter(
        properties={
            "subagent_ids": ToolParameterProperties(
                type="array",
                description="List of subagent IDs to interrupt. Pass an empty list to interrupt all running subagents.",
                items={"type": "string"},
            ),
        },
        required=["subagent_ids"]
    ),
    action_label="Interrupting...",
)


async def execute_interrupt_subagents(subagent_ids: list[str]) -> ExecutorResult:
    manager = get_subagent_manager()

    if not subagent_ids:
        cancelled = manager.cancel_running()
        await manager.flush_state_callbacks()
        if not cancelled:
            return ExecutorResult(
                display="No running subagents to interrupt",
                content="No running subagents found to interrupt.",
            )
        return ExecutorResult(
            display=f"Interrupted {len(cancelled)} subagent(s)",
            content=f"Interrupted subagents: {', '.join(cancelled)}",
        )

    cancelled = []
    not_found = []
    already_done = []

    for sid in subagent_ids:
        record = manager.get_record(sid)
        if not record:
            not_found.append(sid)
        elif record.async_task and not record.async_task.done():
            manager.cancel_one(sid)
            cancelled.append(sid)
        else:
            already_done.append(sid)

    parts = []
    if cancelled:
        parts.append(f"Interrupted: {', '.join(cancelled)}")
    if already_done:
        parts.append(f"Already finished: {', '.join(already_done)}")
    if not_found:
        parts.append(f"Not found: {', '.join(not_found)}")

    content = ". ".join(parts) + "." if parts else "No subagents matched."
    display = f"Interrupted {len(cancelled)} subagent(s)" if cancelled else "No subagents interrupted"

    await manager.flush_state_callbacks()

    return ExecutorResult(display=display, content=content)
