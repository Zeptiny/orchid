"""Tests for Skill.validate() and to_dict() domain gate (P1-28)."""

import unittest

from stupidex.domain.skill import Skill, SkillResource


class TestSkillValidate(unittest.TestCase):
    def test_valid_name_and_description_returns_none(self):
        skill = Skill(name="valid-name", description="desc", location="/x")
        self.assertIsNone(skill.validate())

    def test_single_char_name_valid(self):
        skill = Skill(name="a", description="desc", location="/x")
        self.assertIsNone(skill.validate())

    def test_name_length_64_boundary_passes(self):
        skill = Skill(name="a" * 64, description="desc", location="/x")
        self.assertIsNone(skill.validate())

    def test_name_length_65_fails(self):
        skill = Skill(name="a" * 65, description="desc", location="/x")
        result = skill.validate()
        self.assertIsNotNone(result)
        self.assertIn("1-64 characters", result)

    def test_empty_name_fails(self):
        skill = Skill(name="", description="desc", location="/x")
        result = skill.validate()
        self.assertIsNotNone(result)
        self.assertIn("1-64 characters", result)

    def test_name_not_str_fails(self):
        skill = Skill(name=None, description="desc", location="/x")
        result = skill.validate()
        self.assertIsNotNone(result)
        self.assertIn("1-64 characters", result)

    def test_leading_hyphen_fails(self):
        skill = Skill(name="-foo", description="desc", location="/x")
        result = skill.validate()
        self.assertIsNotNone(result)
        self.assertIn("lowercase", result)

    def test_trailing_hyphen_fails(self):
        skill = Skill(name="foo-", description="desc", location="/x")
        result = skill.validate()
        self.assertIsNotNone(result)
        self.assertIn("lowercase", result)

    def test_uppercase_fails(self):
        skill = Skill(name="Foo", description="desc", location="/x")
        result = skill.validate()
        self.assertIsNotNone(result)
        self.assertIn("lowercase", result)

    def test_underscore_fails(self):
        skill = Skill(name="foo_bar", description="desc", location="/x")
        result = skill.validate()
        self.assertIsNotNone(result)
        self.assertIn("lowercase", result)

    def test_description_length_1024_boundary_passes(self):
        skill = Skill(name="valid-name", description="d" * 1024, location="/x")
        self.assertIsNone(skill.validate())

    def test_description_length_1025_fails(self):
        skill = Skill(name="valid-name", description="d" * 1025, location="/x")
        result = skill.validate()
        self.assertIsNotNone(result)
        self.assertIn("Description", result)

    def test_description_not_str_fails(self):
        skill = Skill(name="valid-name", description=None, location="/x")
        result = skill.validate()
        self.assertIsNotNone(result)
        self.assertIn("Description", result)


class TestSkillToDict(unittest.TestCase):
    def test_to_dict_omits_content_key(self):
        skill = Skill(name="valid-name", description="desc", location="/x", content="body")
        d = skill.to_dict()
        self.assertNotIn("content", d)

    def test_to_dict_collapses_references_to_count(self):
        skill = Skill(
            name="valid-name",
            description="desc",
            location="/x",
            references=[SkillResource(path="/x"), SkillResource(path="/y")],
        )
        d = skill.to_dict()
        self.assertEqual(d["references"], 2)
        self.assertNotIsInstance(d["references"], list)

    def test_to_dict_collapses_scripts_to_count(self):
        skill = Skill(
            name="valid-name",
            description="desc",
            location="/x",
            scripts=[SkillResource(path="/x"), SkillResource(path="/y")],
        )
        d = skill.to_dict()
        self.assertEqual(d["scripts"], 2)
        self.assertNotIsInstance(d["scripts"], list)

    def test_to_dict_collapses_assets_to_count(self):
        skill = Skill(
            name="valid-name",
            description="desc",
            location="/x",
            assets=[SkillResource(path="/x"), SkillResource(path="/y")],
        )
        d = skill.to_dict()
        self.assertEqual(d["assets"], 2)
        self.assertNotIsInstance(d["assets"], list)

    def test_to_dict_omits_requires_when_empty(self):
        skill = Skill(name="valid-name", description="desc", location="/x", requires=[])
        d = skill.to_dict()
        self.assertNotIn("requires", d)

    def test_to_dict_includes_requires_when_populated(self):
        skill = Skill(name="valid-name", description="desc", location="/x", requires=["a"])
        d = skill.to_dict()
        self.assertEqual(d["requires"], ["a"])


class TestSkillResourceToDict(unittest.TestCase):
    def test_resource_to_dict_includes_description_when_truthy(self):
        res = SkillResource(path="/x", description="d")
        d = res.to_dict()
        self.assertEqual(d["description"], "d")

    def test_resource_to_dict_omits_description_when_empty(self):
        res = SkillResource(path="/x", description="")
        d = res.to_dict()
        self.assertNotIn("description", d)


if __name__ == "__main__":
    unittest.main()
