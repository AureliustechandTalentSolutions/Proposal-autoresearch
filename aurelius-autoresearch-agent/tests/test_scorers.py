"""Tests for scoring engines."""

import pytest
import asyncio


@pytest.mark.asyncio
async def test_readability_scorer_in_range():
    from scorers.readability_scorer import ReadabilityScorer
    scorer = ReadabilityScorer(target_min=8.0, target_max=10.0)
    # Grade ~9 text
    text = (
        "The federal government requires all contractors to maintain compliance with established "
        "security frameworks. Our organization implements rigorous security controls across all "
        "operational domains. The technical approach leverages modern DevSecOps practices to ensure "
        "continuous monitoring and automated compliance verification throughout the system lifecycle. "
        "This methodology reduces risk while maintaining operational efficiency across the enterprise."
    )
    score = await scorer.score(text)
    assert 0 <= score <= 100


@pytest.mark.asyncio
async def test_readability_scorer_very_simple():
    from scorers.readability_scorer import ReadabilityScorer
    scorer = ReadabilityScorer(target_min=8.0, target_max=10.0)
    # Very simple text
    text = "The cat sat. The dog ran. I see a big red ball. We go to the park."
    score = await scorer.score(text)
    # Simple text should score lower (grade level too low)
    assert score < 100


@pytest.mark.asyncio
async def test_page_utilization_scorer():
    from scorers.readability_scorer import PageUtilizationScorer
    scorer = PageUtilizationScorer(max_pages=10, words_per_page=250)

    # 95% utilization (2375 words for 10 pages)
    text_95 = " ".join(["word"] * 2375)
    score = await scorer.score(text_95)
    assert score == 100.0

    # Over limit
    text_over = " ".join(["word"] * 2600)
    score = await scorer.score(text_over)
    assert score == 0.0

    # 80% utilization
    text_80 = " ".join(["word"] * 2000)
    score = await scorer.score(text_80)
    assert score == 70.0


@pytest.mark.asyncio
async def test_composite_scorer_weights():
    from scorers.composite_scorer import CompositeScorer
    from scorers.readability_scorer import ReadabilityScorer, PageUtilizationScorer

    scorer = CompositeScorer(scorers={
        "readability": (ReadabilityScorer(), 0.6),
        "page_util": (PageUtilizationScorer(max_pages=10), 0.4),
    })
    text = " ".join(["word"] * 2400)
    score = await scorer.score(text)
    assert 0 <= score <= 100


@pytest.mark.asyncio
async def test_composite_scorer_invalid_weights():
    from scorers.composite_scorer import CompositeScorer
    from scorers.readability_scorer import ReadabilityScorer

    with pytest.raises(ValueError):
        CompositeScorer(scorers={
            "r1": (ReadabilityScorer(), 0.5),
            "r2": (ReadabilityScorer(), 0.3),
        })


@pytest.mark.asyncio
async def test_win_theme_scorer():
    from scorers.proposal_scorer import WinThemeScorer
    scorer = WinThemeScorer(win_themes=["innovation", "veteran"])
    text = "# Section 1\nOur innovation drives veteran success.\n# Section 2\nAnother section without themes."
    score = await scorer.score(text)
    assert 0 <= score <= 100
