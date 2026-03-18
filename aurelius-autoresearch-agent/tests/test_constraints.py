"""Tests for constraint validation."""

import pytest
from agent.constraints import Constraint, ConstraintValidator


def test_word_count_pass():
    c = Constraint(name="wc", description="", validation_type="word_count",
                   parameters={"min": 10, "max": 100})
    v = ConstraintValidator([c])
    ok, violations = v.validate("This is a test with enough words in it for validation purposes now")
    assert ok
    assert len(violations) == 0


def test_word_count_too_short():
    c = Constraint(name="wc", description="", validation_type="word_count",
                   parameters={"min": 100})
    v = ConstraintValidator([c])
    ok, violations = v.validate("Too short")
    assert not ok
    assert len(violations) == 1


def test_page_limit_pass():
    c = Constraint(name="pl", description="", validation_type="page_limit",
                   parameters={"max_pages": 2, "words_per_page": 250})
    v = ConstraintValidator([c])
    text = " ".join(["word"] * 400)
    ok, _ = v.validate(text)
    assert ok


def test_page_limit_fail():
    c = Constraint(name="pl", description="", validation_type="page_limit",
                   parameters={"max_pages": 1, "words_per_page": 250})
    v = ConstraintValidator([c])
    text = " ".join(["word"] * 300)
    ok, violations = v.validate(text)
    assert not ok


def test_contains_required_pass():
    c = Constraint(name="req", description="", validation_type="contains_required",
                   parameters={"required_strings": ["SDVOSB", "veteran"]})
    v = ConstraintValidator([c])
    ok, _ = v.validate("We are a SDVOSB certified veteran-owned business")
    assert ok


def test_contains_required_fail():
    c = Constraint(name="req", description="", validation_type="contains_required",
                   parameters={"required_strings": ["SDVOSB"]})
    v = ConstraintValidator([c])
    ok, violations = v.validate("We are a business")
    assert not ok


def test_custom_regex_must_match():
    c = Constraint(name="rx", description="", validation_type="custom_regex",
                   parameters={"pattern": r"\d{3}-\d{2}-\d{4}", "must_match": False})
    v = ConstraintValidator([c])
    # SSN-like pattern should fail (must NOT match)
    ok, _ = v.validate("SSN: 123-45-6789")
    assert not ok


def test_file_valid_yaml():
    c = Constraint(name="fv", description="", validation_type="file_valid",
                   parameters={"type": "yaml"})
    v = ConstraintValidator([c])
    ok, _ = v.validate("key: value\nlist:\n  - item1\n  - item2")
    assert ok


def test_file_valid_json():
    c = Constraint(name="fv", description="", validation_type="file_valid",
                   parameters={"type": "json"})
    v = ConstraintValidator([c])
    ok, _ = v.validate('{"key": "value"}')
    assert ok
    ok2, _ = v.validate("not json")
    assert not ok2


def test_halt_violation():
    c = Constraint(name="critical", description="", validation_type="word_count",
                   parameters={"max": 10}, on_violation="HALT")
    v = ConstraintValidator([c])
    ok, violations = v.validate(" ".join(["word"] * 20))
    assert not ok
    assert v.has_halt_violation(violations)


def test_discard_violation():
    c = Constraint(name="minor", description="", validation_type="word_count",
                   parameters={"max": 10}, on_violation="DISCARD")
    v = ConstraintValidator([c])
    ok, violations = v.validate(" ".join(["word"] * 20))
    assert not ok
    assert not v.has_halt_violation(violations)
