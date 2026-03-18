"""Readability and page utilization scorers."""

from __future__ import annotations

from typing import Literal

import textstat

from . import Scorer


class ReadabilityScorer(Scorer):
    """Scores readability using Flesch-Kincaid Grade Level."""

    def __init__(self, target_min: float = 8.0, target_max: float = 10.0):
        self.target_min = target_min
        self.target_max = target_max
        self._last_details: dict = {}

    @property
    def direction(self) -> Literal["higher_is_better", "lower_is_better"]:
        return "higher_is_better"

    def describe(self) -> str:
        return f"Readability (Flesch-Kincaid grade {self.target_min}-{self.target_max})"

    async def score(self, artifact_content: str, context: dict | None = None) -> float:
        grade = textstat.flesch_kincaid_grade(artifact_content)
        reading_ease = textstat.flesch_reading_ease(artifact_content)
        sentence_count = textstat.sentence_count(artifact_content)
        word_count = textstat.lexicon_count(artifact_content, removepunct=True)
        avg_sentence_length = word_count / sentence_count if sentence_count > 0 else 0

        self._last_details = {
            "grade_level": grade,
            "flesch_reading_ease": reading_ease,
            "sentence_count": sentence_count,
            "word_count": word_count,
            "avg_sentence_length": round(avg_sentence_length, 1),
        }

        # Scoring: within range = 100, each grade outside = -10, extremes = 0
        if self.target_min <= grade <= self.target_max:
            return 100.0

        if grade < self.target_min:
            distance = self.target_min - grade
        else:
            distance = grade - self.target_max

        score = max(0, 100 - distance * 10)

        # Hard floor: below 6 or above 14 = 0
        if grade < 6.0 or grade > 14.0:
            score = 0.0

        return round(score, 2)


class PageUtilizationScorer(Scorer):
    """Scores page utilization against a maximum page limit."""

    def __init__(self, max_pages: int, words_per_page: int = 250):
        self.max_pages = max_pages
        self.words_per_page = words_per_page

    @property
    def direction(self) -> Literal["higher_is_better", "lower_is_better"]:
        return "higher_is_better"

    def describe(self) -> str:
        return f"Page utilization ({self.max_pages} page limit)"

    async def score(self, artifact_content: str, context: dict | None = None) -> float:
        word_count = len(artifact_content.split())
        pages_used = word_count / self.words_per_page
        utilization = pages_used / self.max_pages * 100

        if utilization > 100:
            return 0.0  # Over limit = violation
        if utilization >= 95:
            return 100.0
        if utilization >= 90:
            return 90.0
        if utilization >= 80:
            return 70.0
        if utilization >= 70:
            return 50.0
        return 30.0
