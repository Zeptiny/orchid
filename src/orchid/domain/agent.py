from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class AgentTypes(Enum):
    INTERNAL = "Internal"  # General, Plan, etc.
    HIDDEN = "Hidden"  # Compactor, etc.
    SUBAGENT = "Subagent"  # Explorer, Review, etc.

    @classmethod
    def from_str(cls, value: str) -> "AgentTypes":
        _map = {
            "internal": cls.INTERNAL,
            "hidden": cls.HIDDEN,
            "subagent": cls.SUBAGENT,
        }
        result = _map.get(value.lower())
        if result is None:
            valid = ", ".join(t.value for t in cls)
            raise ValueError(f"Invalid agent type: '{value}'. Valid types: {valid}")
        return result


class ModelTier(Enum):
    SEED = "seed"
    SPROUT = "sprout"
    BLOOM = "bloom"
    CROWN = "crown"

    @classmethod
    def from_str(cls, value: str) -> "ModelTier":
        _map = {
            "seed": cls.SEED,
            "sprout": cls.SPROUT,
            "bloom": cls.BLOOM,
            "crown": cls.CROWN,
        }
        result = _map.get(value.lower())
        if result is None:
            valid = ", ".join(t.value for t in cls)
            raise ValueError(f"Invalid tier: '{value}'. Valid tiers: {valid}")
        return result


TIER_DESCRIPTIONS: dict[ModelTier, str] = {
    ModelTier.SEED: (
        "Fast and lightweight. Best for simple, mechanical tasks: file listing, "
        "basic searches, reading files, glob matching. No complex reasoning needed."
    ),
    ModelTier.SPROUT: (
        "Light reasoning. Good for code exploration, grep analysis, understanding "
        "file structure, reading comprehension, and summarizing findings."
    ),
    ModelTier.BLOOM: (
        "Standard reasoning. Use for implementation tasks, writing code, refactoring, "
        "multi-file changes, bug fixes, and following code conventions."
    ),
    ModelTier.CROWN: (
        "Deep reasoning. Use for architecture decisions, complex debugging, code review, "
        "design analysis, evaluating trade-offs, and tasks requiring careful judgment."
    ),
}


@dataclass
class Agent:
    name: str
    type: AgentTypes
    tier: ModelTier
    description: str
    system_prompt: str
    allowed_tools: list[str] = field(default_factory=list[str])
    allowed_skills: list[str] = field(default_factory=list[str])

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "type": self.type.value.lower(),
            "tier": self.tier.value,
            "description": self.description,
            "system_prompt": self.system_prompt,
            "allowed_tools": self.allowed_tools,
            "allowed_skills": self.allowed_skills,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Agent":
        return cls(
            name=data["name"],
            type=AgentTypes.from_str(data["type"]),
            tier=ModelTier.from_str(data.get("tier", "bloom")),
            description=data["description"],
            system_prompt=data["system_prompt"],
            allowed_tools=data.get("allowed_tools", []),
            allowed_skills=data.get("allowed_skills", []),
        )
