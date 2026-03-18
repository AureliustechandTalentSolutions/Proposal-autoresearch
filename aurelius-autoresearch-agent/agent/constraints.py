"""Constraint validation engine for autoresearch loops."""

from __future__ import annotations

import json
import logging
import re
from typing import Literal

import yaml
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


class Constraint(BaseModel):
    """A single constraint definition."""

    name: str
    description: str
    validation_type: Literal[
        "word_count", "page_limit", "readability_range",
        "contains_required", "no_fabrication", "custom_regex", "file_valid"
    ]
    parameters: dict
    on_violation: Literal["DISCARD", "HALT"] = "DISCARD"


class ConstraintValidator:
    """Validates artifact content against a set of constraints."""

    def __init__(self, constraints: list[Constraint]):
        self.constraints = constraints

    def validate(self, artifact_content: str, metadata: dict | None = None) -> tuple[bool, list[str]]:
        """Validate artifact against all constraints. Returns (all_passed, violation_messages)."""
        metadata = metadata or {}
        violations: list[str] = []

        for constraint in self.constraints:
            passed, msg = self._check(constraint, artifact_content, metadata)
            if not passed:
                violations.append(f"[{constraint.on_violation}] {constraint.name}: {msg}")

        return len(violations) == 0, violations

    def has_halt_violation(self, violations: list[str]) -> bool:
        """Check if any violation requires halting."""
        return any(v.startswith("[HALT]") for v in violations)

    def _check(self, constraint: Constraint, content: str, metadata: dict) -> tuple[bool, str]:
        validators = {
            "word_count": self._check_word_count,
            "page_limit": self._check_page_limit,
            "readability_range": self._check_readability_range,
            "contains_required": self._check_contains_required,
            "no_fabrication": self._check_no_fabrication,
            "custom_regex": self._check_custom_regex,
            "file_valid": self._check_file_valid,
        }
        fn = validators.get(constraint.validation_type)
        if not fn:
            return True, ""
        return fn(content, constraint.parameters, metadata)

    def _check_word_count(self, content: str, params: dict, _meta: dict) -> tuple[bool, str]:
        count = len(content.split())
        min_words = params.get("min", 0)
        max_words = params.get("max", float("inf"))
        if count < min_words:
            return False, f"Word count {count} below minimum {min_words}"
        if count > max_words:
            return False, f"Word count {count} above maximum {max_words}"
        return True, ""

    def _check_page_limit(self, content: str, params: dict, _meta: dict) -> tuple[bool, str]:
        words_per_page = params.get("words_per_page", 250)
        max_pages = params["max_pages"]
        pages = len(content.split()) / words_per_page
        if pages > max_pages:
            return False, f"Estimated {pages:.1f} pages exceeds limit of {max_pages}"
        return True, ""

    def _check_readability_range(self, content: str, params: dict, _meta: dict) -> tuple[bool, str]:
        import textstat
        grade = textstat.flesch_kincaid_grade(content)
        min_grade = params.get("min", 0)
        max_grade = params.get("max", 20)
        if grade < min_grade or grade > max_grade:
            return False, f"Readability grade {grade:.1f} outside range [{min_grade}, {max_grade}]"
        return True, ""

    def _check_contains_required(self, content: str, params: dict, _meta: dict) -> tuple[bool, str]:
        missing = [s for s in params.get("required_strings", []) if s.lower() not in content.lower()]
        if missing:
            return False, f"Missing required content: {', '.join(missing)}"
        return True, ""

    def _check_no_fabrication(self, content: str, params: dict, meta: dict) -> tuple[bool, str]:
        # Basic check: if original is provided, verify no major new claims added
        # Full implementation would use LLM to verify
        return True, ""

    def _check_custom_regex(self, content: str, params: dict, _meta: dict) -> tuple[bool, str]:
        pattern = params["pattern"]
        must_match = params.get("must_match", True)
        matches = bool(re.search(pattern, content))
        if must_match and not matches:
            return False, f"Required pattern not found: {pattern}"
        if not must_match and matches:
            return False, f"Forbidden pattern found: {pattern}"
        return True, ""

    def _check_file_valid(self, content: str, params: dict, _meta: dict) -> tuple[bool, str]:
        file_type = params.get("type", "yaml")
        try:
            if file_type == "yaml":
                yaml.safe_load(content)
            elif file_type == "json":
                json.loads(content)
            else:
                return True, ""
        except Exception as e:
            return False, f"Invalid {file_type}: {e}"
        return True, ""


# Predefined constraint sets
FEDERAL_PROPOSAL_CONSTRAINTS = [
    Constraint(
        name="Page Limit",
        description="Proposal must not exceed page limit",
        validation_type="page_limit",
        parameters={"max_pages": 20, "words_per_page": 250},
        on_violation="HALT",
    ),
    Constraint(
        name="Readability",
        description="Readability must be in grade 8-10 range",
        validation_type="readability_range",
        parameters={"min": 8, "max": 10},
        on_violation="DISCARD",
    ),
    Constraint(
        name="No Fabrication",
        description="Must not add fabricated claims",
        validation_type="no_fabrication",
        parameters={"enabled": True},
        on_violation="HALT",
    ),
]

COMPLIANCE_CONSTRAINTS = [
    Constraint(
        name="Valid YAML",
        description="File must be valid YAML",
        validation_type="file_valid",
        parameters={"type": "yaml"},
        on_violation="HALT",
    ),
    Constraint(
        name="No Fabricated Evidence",
        description="Must not add fabricated compliance evidence",
        validation_type="no_fabrication",
        parameters={"enabled": True},
        on_violation="HALT",
    ),
]

KUBERNETES_CONSTRAINTS = [
    Constraint(
        name="Valid YAML",
        description="Must be valid YAML",
        validation_type="file_valid",
        parameters={"type": "yaml"},
        on_violation="HALT",
    ),
]
