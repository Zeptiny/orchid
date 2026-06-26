from dataclasses import dataclass
from typing import Any


@dataclass
class ExecutorResult:
    display: str
    content: str


@dataclass
class ToolParameterProperties:
    type: str = ""
    description: str = ""
    items: dict[str, Any] | None = None
@dataclass
class ToolParameter:
    properties: dict[str, ToolParameterProperties]  # name -> schema
    required: list[str]
    type: str = "object"
    additional_properties: bool = False


@dataclass
class Tool:
    name: str
    description: str
    parameters: ToolParameter
    action_label: str = ""
    type: str = "function"
    strict: bool = True

    def to_dict(self) -> dict:
        properties = {}
        for k, v in self.parameters.properties.items():
            prop: dict[str, Any] = {"description": v.description}
            if v.type:
                prop["type"] = v.type
            if v.items is not None:
                prop["items"] = v.items
            properties[k] = prop

        return {
            "type": self.type,
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": {
                    "type": self.parameters.type,
                    "properties": properties,
                    "required": self.parameters.required,
                    "additionalProperties": self.parameters.additional_properties,
                },
                "strict": self.strict,
            },
        }
