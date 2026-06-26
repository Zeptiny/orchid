import logging
from pathlib import Path

from stupidex.config import HOME_AGENTS_DIR, PROJECT_AGENTS_DIR
from stupidex.domain.agent import Agent, AgentTypes, ModelTier
from stupidex.utils import parse_frontmatter, seed_defaults

log = logging.getLogger(__name__)

AGENT_REGISTRY: dict[str, Agent] = {}


def _load_agents_from_dir(agents_dir: Path) -> dict[str, Agent]:
    agents: dict[str, Agent] = {}
    if not agents_dir.is_dir():
        return agents

    for path in sorted(agents_dir.iterdir()):
        if not path.is_dir():
            continue

        agent_file = path / "AGENT.md"
        if not agent_file.exists():
            continue

        try:
            content = agent_file.read_text()
        except OSError as e:
            log.warning("Skipping %s: %s", agent_file, e)
            continue

        metadata, body = parse_frontmatter(content)

        name = metadata.get('name', path.name)
        agent_type = metadata.get('type', 'subagent')
        tier = metadata.get('tier', 'papudo')
        description = metadata.get('description', '')
        allowed_tools = metadata.get('allowed_tools')
        allowed_skills = metadata.get('allowed_skills', [])
        if isinstance(allowed_tools, str):
            if allowed_tools.strip() in ('[]', ''):
                allowed_tools = []
            else:
                allowed_tools = [t.strip() for t in allowed_tools.split(',') if t.strip()]
        if isinstance(allowed_skills, str):
            if allowed_skills.strip() in ('[]', ''):
                allowed_skills = []
            else:
                allowed_skills = [s.strip() for s in allowed_skills.split(',') if s.strip()]
        if not isinstance(allowed_skills, list) or not all(isinstance(s, str) for s in allowed_skills):
            log.warning("Skipping %s: allowed_skills must be a list of strings", agent_file)
            allowed_skills = []

        if not description:
            log.warning("Skipping %s: no description in frontmatter", agent_file)
            continue

        if allowed_tools is None:
            log.warning("Skipping %s: no allowed_tools in frontmatter", agent_file)
            continue

        if not isinstance(allowed_tools, list) or not all(isinstance(t, str) for t in allowed_tools):
            log.warning("Skipping %s: allowed_tools must be a list of strings", agent_file)
            continue

        try:
            agent = Agent(
                name=str(name),
                type=AgentTypes.from_str(str(agent_type)),
                tier=ModelTier.from_str(str(tier)),
                description=description,
                system_prompt=body.strip(),
                allowed_tools=allowed_tools,
                allowed_skills=allowed_skills,
            )
        except (KeyError, ValueError, AttributeError) as e:
            log.warning("Skipping %s: %s", agent_file, e)
            continue

        agents[agent.name] = agent

    return agents


def seed_agents_dir(agents_dir: Path) -> None:
    source_dir = Path(__file__).parent / "defaults"
    seed_defaults(source_dir, agents_dir, "AGENT.md")


def load_agents() -> dict[str, Agent]:
    global AGENT_REGISTRY

    home_agents = _load_agents_from_dir(HOME_AGENTS_DIR)

    project_agents_dir = Path.cwd() / PROJECT_AGENTS_DIR
    project_agents = _load_agents_from_dir(project_agents_dir)

    merged = {**home_agents, **project_agents}
    AGENT_REGISTRY = merged

    from stupidex.tools import reset_tool_registry
    reset_tool_registry()

    return merged


def get_agent_registry() -> dict[str, Agent]:
    if not AGENT_REGISTRY:
        return load_agents()
    return AGENT_REGISTRY
