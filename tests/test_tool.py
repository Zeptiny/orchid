"""Tests for Tool.to_dict() OpenAI function-schema serialization (P2-18)."""

import unittest

from stupidex.domain.tool import Tool, ToolParameter, ToolParameterProperties


def _tool(**overrides) -> Tool:
    defaults = dict(
        name="read_file",
        description="Read a file from disk.",
        parameters=ToolParameter(
            properties={
                "file_path": ToolParameterProperties(type="string", description="absolute path"),
                "offset": ToolParameterProperties(type="integer", description="line offset"),
            },
            required=["file_path"],
        ),
    )
    defaults.update(overrides)
    return Tool(**defaults)


class TestToolToDictSchema(unittest.TestCase):
    def test_top_level_function_envelope(self):
        d = _tool().to_dict()
        self.assertEqual(d["type"], "function")
        self.assertIn("function", d)

    def test_function_block_has_name_and_description(self):
        fn = _tool().to_dict()["function"]
        self.assertEqual(fn["name"], "read_file")
        self.assertEqual(fn["description"], "Read a file from disk.")

    def test_parameters_is_object_with_required_properties_strict(self):
        params = _tool().to_dict()["function"]["parameters"]
        self.assertEqual(params["type"], "object")
        self.assertIn("file_path", params["properties"])
        self.assertEqual(params["required"], ["file_path"])
        self.assertFalse(params["additionalProperties"])
        self.assertNotIn("strict", params)

    def test_strict_flag_serialized_at_function_level(self):
        d = _tool().to_dict()
        self.assertTrue(d["function"]["strict"])

    def test_strict_false_serialized_when_disabled(self):
        d = _tool(strict=False).to_dict()
        self.assertFalse(d["function"]["strict"])

    def test_property_includes_type_and_description(self):
        props = _tool().to_dict()["function"]["parameters"]["properties"]
        fp = props["file_path"]
        self.assertEqual(fp["type"], "string")
        self.assertEqual(fp["description"], "absolute path")
        self.assertNotIn("items", fp)

    def test_array_property_serializes_items(self):
        params = ToolParameter(
            properties={
                "paths": ToolParameterProperties(
                    type="array",
                    description="list of paths",
                    items={"type": "string"},
                ),
            },
            required=["paths"],
        )
        d = _tool(parameters=params).to_dict()["function"]["parameters"]["properties"]
        self.assertEqual(d["paths"]["type"], "array")
        self.assertEqual(d["paths"]["items"], {"type": "string"})

    def test_empty_description_property_omits_only_unused_fields(self):
        params = ToolParameter(
            properties={
                "note": ToolParameterProperties(type="string", description="", items=None),
            },
            required=[],
        )
        prop = _tool(parameters=params).to_dict()["function"]["parameters"]["properties"]["note"]
        self.assertEqual(prop["description"], "")
        self.assertNotIn("items", prop)

    def test_round_trip_via_direct_construction_preserves_required_order(self):
        d = _tool().to_dict()
        self.assertEqual(d["function"]["parameters"]["required"], ["file_path"])


if __name__ == "__main__":
    unittest.main()
