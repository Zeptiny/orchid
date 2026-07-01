import re
from dataclasses import dataclass, field
from typing import Any

_NAME_PATTERN = re.compile(r'^[a-z0-9]([a-z0-9-]*[a-z0-9])?$')
_MAX_NAME_LEN = 64
_MAX_DESC_LEN = 1024


@dataclass
class SkillResource:
    path: str
    description: str = ""

    def to_dict(self) -> dict[str, str]:
        d: dict[str, str] = {"path": self.path}
        if self.description:
            d["description"] = self.description
        return d


@dataclass
class Skill:
    name: str
    description: str
    location: str
    content: str = ""
    requires: list[str] = field(default_factory=list[str])
    scripts: list[SkillResource] = field(default_factory=list[SkillResource])
    references: list[SkillResource] = field(default_factory=list[SkillResource])
    assets: list[SkillResource] = field(default_factory=list[SkillResource])

    def validate(self) -> str | None:
        if not self.name or len(self.name) > _MAX_NAME_LEN:
            return f"Name must be a string of 1-{_MAX_NAME_LEN} characters"
        if not _NAME_PATTERN.match(self.name):
            return "Name must be lowercase letters, numbers, hyphens; no leading/trailing hyphens"
        if not self.description or len(self.description) > _MAX_DESC_LEN:
            return f"Description must be a string of 1-{_MAX_DESC_LEN} characters"
        return None

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "name": self.name,
            "description": self.description,
            "location": self.location,
        }
        if self.requires:
            d["requires"] = self.requires
        d["references"] = len(self.references)
        d["scripts"] = len(self.scripts)
        d["assets"] = len(self.assets)
        return d
