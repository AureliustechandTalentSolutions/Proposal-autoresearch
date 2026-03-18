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


def test_multiple_constraints_one_pass_one_fail():
    """When one constraint passes and another fails, validation should fail."""
    c_pass = Constraint(name="wc_pass", description="", validation_type="word_count",
                        parameters={"min": 1, "max": 1000})
    c_fail = Constraint(name="wc_fail", description="", validation_type="word_count",
                        parameters={"min": 100})
    v = ConstraintValidator([c_pass, c_fail])
    ok, violations = v.validate("Just a few words")
    assert not ok
    assert len(violations) == 1
    assert "wc_fail" in violations[0]


def test_empty_artifact_string():
    """Constraint validation with empty artifact string."""
    c = Constraint(name="wc", description="", validation_type="word_count",
                   parameters={"min": 1})
    v = ConstraintValidator([c])
    ok, violations = v.validate("")
    assert not ok
    assert len(violations) == 1


def test_readability_range_constraint_with_real_text():
    """readability_range constraint with real text."""
    c = Constraint(name="read", description="", validation_type="readability_range",
                   parameters={"min": 6, "max": 14})
    v = ConstraintValidator([c])
    # Text with moderate sentence length and vocabulary to land in grade 6-14 range
    text = (
        "The project team will complete all deliverables within the proposed schedule. "
        "Our approach uses proven methods that reduce risk and improve quality. "
        "Each phase includes testing and validation before moving to the next stage. "
        "Staff members bring an average of fifteen years of relevant experience to this contract. "
        "We maintain compliance with all applicable federal regulations and industry standards. "
        "Monthly progress reports will be submitted to the contracting officer for review and approval."
    )
    ok, violations = v.validate(text)
    assert ok, f"Readability constraint failed: {violations}"
    assert len(violations) == 0
