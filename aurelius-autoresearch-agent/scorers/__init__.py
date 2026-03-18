"""Abstract scorer interface and result models."""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel


class ScorerResult(BaseModel):
    """Result from a scoring operation."""
    score: float  # 0-100 normalized
    raw_score: Any  # original metric value
    details: dict[str, Any]  # breakdown by sub-metric
    scorer_name: str
    timestamp: datetime


class Scorer(ABC):
    """Abstract base class for all scorers."""

    @abstractmethod
    async def score(self, artifact_content: str, context: dict | None = None) -> float:
        """Score an artifact. Returns 0-100."""
        ...

    @abstractmethod
    def describe(self) -> str:
        """Human-readable description of what this scorer measures."""
        ...

    @property
    @abstractmethod
    def direction(self) -> Literal["higher_is_better", "lower_is_better"]:
        ...
