"""Tests for Agent serialization and enum from_str error paths (P2-15)."""

import unittest

from stupidex.domain.agent import Agent, AgentTypes, ModelTier


class TestAgentTypesFromStrErrors(unittest.TestCase):
    def test_invalid_value_raises_listing_raw_enum_values(self):
        with self.assertRaises(ValueError) as ctx:
            AgentTypes.from_str("bogus")
        msg = str(ctx.exception)
        self.assertIn("Internal", msg)
        self.assertIn("Hidden", msg)
        self.assertIn("Subagent", msg)

    def test_error_message_does_not_use_lower_cased_values(self):
        with self.assertRaises(ValueError) as ctx:
            AgentTypes.from_str("nope")
        msg = str(ctx.exception)
        self.assertNotIn("internal", msg)
        self.assertNotIn("hidden", msg)
        self.assertNotIn("subagent", msg)

    def test_valid_inputs_case_insensitive(self):
        self.assertEqual(AgentTypes.from_str("internal"), AgentTypes.INTERNAL)
        self.assertEqual(AgentTypes.from_str("HIDDEN"), AgentTypes.HIDDEN)
        self.assertEqual(AgentTypes.from_str("SubAgent"), AgentTypes.SUBAGENT)


class TestModelTierFromStrErrors(unittest.TestCase):
    def test_invalid_value_raises_listing_raw_enum_values(self):
        with self.assertRaises(ValueError) as ctx:
            ModelTier.from_str("bogus")
        msg = str(ctx.exception)
        self.assertIn("tolo", msg)
        self.assertIn("tainha", msg)
        self.assertIn("papudo", msg)
        self.assertIn("papaca", msg)

    def test_valid_inputs_case_insensitive(self):
        self.assertEqual(ModelTier.from_str("TOLO"), ModelTier.TOLO)
        self.assertEqual(ModelTier.from_str("Papudo"), ModelTier.PAPUDO)


class TestAgentDictRoundTrip(unittest.TestCase):
    def _agent(self, **overrides):
        defaults = dict(
            name="Explorer",
            type=AgentTypes.SUBAGENT,
            tier=ModelTier.PAPUDO,
            description="explores things",
            system_prompt="be helpful",
            allowed_tools=["read", "grep"],
            allowed_skills=["search", "summarize"],
        )
        defaults.update(overrides)
        return Agent(**defaults)

    def test_to_dict_then_from_dict_round_trips_all_fields(self):
        agent = self._agent()
        restored = Agent.from_dict(agent.to_dict())
        self.assertEqual(restored.name, agent.name)
        self.assertEqual(restored.type, agent.type)
        self.assertEqual(restored.tier, agent.tier)
        self.assertEqual(restored.description, agent.description)
        self.assertEqual(restored.system_prompt, agent.system_prompt)
        self.assertEqual(restored.allowed_tools, agent.allowed_tools)
        self.assertEqual(restored.allowed_skills, agent.allowed_skills)

    def test_to_dict_serializes_type_as_lower_cased_value(self):
        agent = self._agent(type=AgentTypes.INTERNAL)
        d = agent.to_dict()
        self.assertEqual(d["type"], "internal")
        self.assertEqual(d["tier"], "papudo")

    def test_round_trip_preserves_allowed_tools_and_allowed_skills_empty(self):
        agent = self._agent(allowed_tools=[], allowed_skills=[])
        restored = Agent.from_dict(agent.to_dict())
        self.assertEqual(restored.allowed_tools, [])
        self.assertEqual(restored.allowed_skills, [])

    def test_from_dict_defaults_missing_optional_fields(self):
        d = {
            "name": "Plain",
            "type": "subagent",
            "description": "d",
            "system_prompt": "p",
        }
        restored = Agent.from_dict(d)
        self.assertEqual(restored.tier, ModelTier.PAPUDO)
        self.assertEqual(restored.allowed_tools, [])
        self.assertEqual(restored.allowed_skills, [])


if __name__ == "__main__":
    unittest.main()
