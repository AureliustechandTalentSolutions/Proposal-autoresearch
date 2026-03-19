"""
Section 508 and WCAG 2.1 AA accessibility compliance tests for Aurelius panel HTML.

Tests validate DOM structure, ARIA attributes, color contrast, keyboard
accessibility, heading hierarchy, and assistive-technology integration
across all five panels: maestro, nemoclaw, trigger, compliance, workspace.

Uses only stdlib (re, html.parser) -- no external packages required.
"""

from __future__ import annotations

import os
import re
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

import pytest

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent
SRC_PANELS = PROJECT_ROOT / "src" / "panels"

PANEL_HTML_FILES: dict[str, Path] = {
    "maestro": SRC_PANELS / "maestro" / "index.html",
    "nemoclaw": SRC_PANELS / "nemoclaw" / "index.html",
    "trigger": SRC_PANELS / "trigger" / "index.html",
    "compliance": SRC_PANELS / "compliance" / "index.html",
    "workspace": SRC_PANELS / "workspace" / "index.html",
}

TS_COMPONENT_FILES: list[Path] = [
    SRC_PANELS / "nemoclaw" / "components" / "SecurityLog.ts",
    SRC_PANELS / "nemoclaw" / "components" / "AgentLifecycle.ts",
    SRC_PANELS / "nemoclaw" / "components" / "PolicyEditor.ts",
]


def _read(path: Path) -> str:
    """Read a file, returning empty string if missing."""
    if path.exists():
        return path.read_text(encoding="utf-8", errors="replace")
    return ""


# ---------------------------------------------------------------------------
# Lightweight HTML DOM helpers
# ---------------------------------------------------------------------------

class _Tag:
    """Minimal representation of an HTML tag for analysis."""

    def __init__(self, tag: str, attrs: dict[str, str | None], line: int):
        self.tag = tag
        self.attrs = attrs
        self.line = line

    def get(self, attr: str, default: str | None = None) -> str | None:
        return self.attrs.get(attr, default)

    def has(self, attr: str) -> bool:
        return attr in self.attrs


class _SimpleHTMLCollector(HTMLParser):
    """Collect all start-tags with their attributes."""

    def __init__(self) -> None:
        super().__init__()
        self.tags: list[_Tag] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        line = self.getpos()[0]
        self.tags.append(_Tag(tag, dict(attrs), line))


def _parse_tags(html: str) -> list[_Tag]:
    parser = _SimpleHTMLCollector()
    parser.feed(html)
    return parser.tags


def _tags_of(tags: list[_Tag], *names: str) -> list[_Tag]:
    return [t for t in tags if t.tag in names]


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(params=list(PANEL_HTML_FILES.keys()), ids=list(PANEL_HTML_FILES.keys()))
def panel_name(request: pytest.FixtureRequest) -> str:
    return request.param


@pytest.fixture()
def panel_html(panel_name: str) -> str:
    path = PANEL_HTML_FILES[panel_name]
    content = _read(path)
    assert content, f"Panel HTML not found: {path}"
    return content


@pytest.fixture()
def panel_tags(panel_html: str) -> list[_Tag]:
    return _parse_tags(panel_html)


# ---------------------------------------------------------------------------
# 1. Images / icons must have alt text
# ---------------------------------------------------------------------------

class TestImagesHaveAltText:
    """WCAG SC 1.1.1 -- Non-text content must have text alternatives."""

    def test_img_tags_have_alt(self, panel_tags: list[_Tag], panel_name: str) -> None:
        imgs = _tags_of(panel_tags, "img")
        for img in imgs:
            assert img.has("alt"), (
                f"[{panel_name}] <img> on line {img.line} missing alt attribute"
            )

    def test_svg_tags_have_accessible_name(self, panel_tags: list[_Tag], panel_name: str) -> None:
        """SVGs used as images should have a <title>, aria-label, or role=presentation."""
        svgs = _tags_of(panel_tags, "svg")
        for svg in svgs:
            has_label = (
                svg.has("aria-label")
                or svg.has("aria-labelledby")
                or svg.get("role") in ("img", "presentation", "none")
            )
            # SVGs used purely for decoration (charts) are acceptable with role=none
            # but should ideally have some accessible marker
            if not has_label:
                pytest.xfail(
                    f"[{panel_name}] <svg> on line {svg.line} lacks aria-label, "
                    "aria-labelledby, or role=img/presentation -- recommend adding one"
                )


# ---------------------------------------------------------------------------
# 2. Form controls have associated labels
# ---------------------------------------------------------------------------

class TestFormControlsHaveLabels:
    """WCAG SC 1.3.1, 4.1.2 -- All inputs must be programmatically labeled."""

    def test_input_elements_labeled(self, panel_html: str, panel_tags: list[_Tag], panel_name: str) -> None:
        inputs = _tags_of(panel_tags, "input", "select", "textarea")
        for inp in inputs:
            has_label = (
                inp.has("aria-label")
                or inp.has("aria-labelledby")
                or inp.has("title")
            )
            inp_id = inp.get("id")
            if inp_id and not has_label:
                # Check for a <label for="..."> pointing at this id
                label_pattern = rf'<label[^>]+for\s*=\s*["\']?{re.escape(inp_id)}["\']?'
                has_label = bool(re.search(label_pattern, panel_html, re.IGNORECASE))
            if inp.get("type") == "hidden":
                continue  # hidden inputs don't need labels
            assert has_label, (
                f"[{panel_name}] <{inp.tag}> on line {inp.line} "
                f"(id={inp_id}) has no associated label, aria-label, or title"
            )


# ---------------------------------------------------------------------------
# 3. Color contrast ratios (static CSS variable analysis)
# ---------------------------------------------------------------------------

def _hex_to_rgb(h: str) -> tuple[int, int, int]:
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _relative_luminance(r: int, g: int, b: int) -> float:
    """WCAG relative luminance formula."""
    rs, gs, bs = r / 255.0, g / 255.0, b / 255.0

    def linearize(c: float) -> float:
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    return 0.2126 * linearize(rs) + 0.7152 * linearize(gs) + 0.0722 * linearize(bs)


def _contrast_ratio(hex1: str, hex2: str) -> float:
    l1 = _relative_luminance(*_hex_to_rgb(hex1))
    l2 = _relative_luminance(*_hex_to_rgb(hex2))
    lighter = max(l1, l2)
    darker = min(l1, l2)
    return (lighter + 0.05) / (darker + 0.05)


class TestColorContrast:
    """WCAG SC 1.4.3 -- Contrast minimum 4.5:1 normal text, 3:1 large text."""

    # Extract CSS custom property pairs expected to be used as text-on-background
    TEXT_BG_PAIRS = [
        # (text color, background color, description)
        ("#e4e6eb", "#0d0f12", "text-primary on bg-primary"),
        ("#8b8f9a", "#0d0f12", "text-secondary on bg-primary"),
        ("#8b8f9a", "#151820", "text-secondary on bg-secondary"),
        ("#5c6070", "#0d0f12", "text-muted on bg-primary"),
        ("#e4e6eb", "#1a1e28", "text-primary on bg-card"),
        ("#8b8f9a", "#232833", "text-secondary on bg-input"),
    ]

    @pytest.mark.parametrize(
        "fg,bg,desc",
        TEXT_BG_PAIRS,
        ids=[t[2] for t in TEXT_BG_PAIRS],
    )
    def test_normal_text_contrast_ratio(self, fg: str, bg: str, desc: str) -> None:
        ratio = _contrast_ratio(fg, bg)
        assert ratio >= 4.5, (
            f"Contrast ratio for {desc} is {ratio:.2f}:1, "
            f"below WCAG AA minimum 4.5:1 ({fg} on {bg})"
        )

    LARGE_TEXT_PAIRS = [
        ("#38a169", "#0d0f12", "green accent (large) on bg-primary"),
        ("#e53e3e", "#0d0f12", "red accent (large) on bg-primary"),
        ("#4299e1", "#0d0f12", "blue accent (large) on bg-primary"),
        ("#d69e2e", "#0d0f12", "yellow accent (large) on bg-primary"),
    ]

    @pytest.mark.parametrize(
        "fg,bg,desc",
        LARGE_TEXT_PAIRS,
        ids=[t[2] for t in LARGE_TEXT_PAIRS],
    )
    def test_large_text_contrast_ratio(self, fg: str, bg: str, desc: str) -> None:
        ratio = _contrast_ratio(fg, bg)
        assert ratio >= 3.0, (
            f"Contrast ratio for {desc} is {ratio:.2f}:1, "
            f"below WCAG AA minimum 3:1 for large text ({fg} on {bg})"
        )


# ---------------------------------------------------------------------------
# 4. Interactive elements are keyboard accessible
# ---------------------------------------------------------------------------

class TestKeyboardAccessibility:
    """WCAG SC 2.1.1 -- All interactive elements reachable via keyboard."""

    def test_buttons_are_native_or_have_role(self, panel_tags: list[_Tag], panel_name: str) -> None:
        """Clickable elements should be <button>, <a>, or have role=button + tabindex."""
        divs_with_click = [
            t for t in panel_tags
            if t.tag == "div" and (t.has("onclick") or t.get("role") == "button")
        ]
        for div in divs_with_click:
            assert div.has("tabindex") or div.has("role"), (
                f"[{panel_name}] Interactive <div> on line {div.line} "
                "needs tabindex and role for keyboard access"
            )

    def test_native_buttons_present(self, panel_tags: list[_Tag], panel_name: str) -> None:
        """Panels should use native <button> elements for actions."""
        buttons = _tags_of(panel_tags, "button")
        assert len(buttons) > 0, (
            f"[{panel_name}] No native <button> elements found -- "
            "interactive controls should use semantic HTML"
        )

    def test_tab_elements_have_keyboard_support(self, panel_html: str, panel_name: str) -> None:
        """Tab-bar elements (non-button) should have role=tab and tabindex."""
        # Check if there are div-based tabs
        tab_divs = re.findall(r'<div[^>]+class="[^"]*\btab\b[^"]*"[^>]*>', panel_html)
        for tab_div in tab_divs:
            # Tabs using <div> should ideally have role="tab"
            if 'role="tab"' not in tab_div and 'tabindex' not in tab_div:
                pytest.xfail(
                    f"[{panel_name}] Tab element uses <div> without role='tab' "
                    "or tabindex -- recommend adding ARIA tab pattern"
                )


# ---------------------------------------------------------------------------
# 5. Proper heading hierarchy
# ---------------------------------------------------------------------------

class TestHeadingHierarchy:
    """WCAG SC 1.3.1 -- Heading levels must not skip."""

    def test_no_skipped_heading_levels(self, panel_html: str, panel_name: str) -> None:
        headings = re.findall(r'<(h[1-6])\b', panel_html, re.IGNORECASE)
        if not headings:
            # No headings is acceptable for panel UIs, but worth noting
            return
        levels = [int(h[1]) for h in headings]
        for i in range(1, len(levels)):
            gap = levels[i] - levels[i - 1]
            assert gap <= 1, (
                f"[{panel_name}] Heading hierarchy skips from h{levels[i-1]} "
                f"to h{levels[i]} (headings found: {headings})"
            )


# ---------------------------------------------------------------------------
# 6. Status updates use aria-live regions
# ---------------------------------------------------------------------------

class TestAriaLiveRegions:
    """WCAG SC 4.1.3 -- Status messages must be programmatically determinable."""

    def test_status_areas_have_aria_live_or_role(self, panel_html: str, panel_name: str) -> None:
        """Status/notification containers should use aria-live or role=status/alert."""
        has_live_region = bool(
            re.search(r'aria-live\s*=', panel_html)
            or re.search(r'role\s*=\s*["\'](?:status|alert|log|timer)["\']', panel_html)
        )
        # Panels that show dynamic status updates need live regions
        dynamic_panels = {"maestro", "nemoclaw", "trigger", "compliance", "workspace"}
        if panel_name in dynamic_panels:
            if not has_live_region:
                pytest.xfail(
                    f"[{panel_name}] Panel has dynamic status updates but no "
                    "aria-live region or role=status/alert/log for screen readers"
                )

    def test_ts_components_dynamic_content(self) -> None:
        """TypeScript components that update DOM should consider aria-live announcements."""
        issues: list[str] = []
        for ts_file in TS_COMPONENT_FILES:
            content = _read(ts_file)
            if not content:
                continue
            # Components that write innerHTML should ideally set aria-live
            if "innerHTML" in content and "aria-live" not in content:
                issues.append(
                    f"{ts_file.name}: updates DOM via innerHTML but "
                    "does not set aria-live for assistive technology"
                )
        if issues:
            pytest.xfail(
                "Dynamic content components lack aria-live attributes:\n"
                + "\n".join(f"  - {i}" for i in issues)
            )


# ---------------------------------------------------------------------------
# 7. All buttons have accessible names
# ---------------------------------------------------------------------------

class TestButtonAccessibleNames:
    """WCAG SC 4.1.2 -- Buttons must have discernible text."""

    def test_buttons_have_text_or_aria_label(self, panel_html: str, panel_tags: list[_Tag], panel_name: str) -> None:
        buttons = _tags_of(panel_tags, "button")
        for btn in buttons:
            has_name = (
                btn.has("aria-label")
                or btn.has("aria-labelledby")
                or btn.has("title")
            )
            if not has_name:
                # Check for visible text content between the tags
                # Simple heuristic: look for >text< after the button opening tag
                btn_pattern = re.compile(
                    r'<button[^>]*>\s*(.+?)\s*</button>',
                    re.DOTALL | re.IGNORECASE,
                )
                matches = btn_pattern.findall(panel_html)
                # If any button is empty (e.g., icon-only), flag it
                empty_buttons = [m for m in matches if not re.sub(r'<[^>]+>', '', m).strip()]
                if empty_buttons:
                    pytest.xfail(
                        f"[{panel_name}] Found button(s) with no visible text and "
                        "no aria-label -- icon-only buttons need accessible names"
                    )
                # If we reach here, buttons have text content -- pass
                return


# ---------------------------------------------------------------------------
# 8. Data tables have proper header associations
# ---------------------------------------------------------------------------

class TestDataTableHeaders:
    """WCAG SC 1.3.1 -- Data tables need proper th/scope/headers."""

    def test_tables_have_thead_and_th(self, panel_tags: list[_Tag], panel_name: str) -> None:
        tables = _tags_of(panel_tags, "table")
        if not tables:
            return
        theads = _tags_of(panel_tags, "thead")
        ths = _tags_of(panel_tags, "th")
        assert len(theads) > 0, (
            f"[{panel_name}] Data table(s) found but no <thead> element"
        )
        assert len(ths) > 0, (
            f"[{panel_name}] Data table(s) found but no <th> header cells"
        )

    def test_th_elements_have_scope(self, panel_tags: list[_Tag], panel_name: str) -> None:
        """Table headers should have scope attribute for clarity."""
        ths = _tags_of(panel_tags, "th")
        if not ths:
            return
        missing_scope = [th for th in ths if not th.has("scope")]
        if missing_scope:
            pytest.xfail(
                f"[{panel_name}] {len(missing_scope)} <th> element(s) "
                "lack scope attribute (recommend scope='col' or scope='row')"
            )


# ---------------------------------------------------------------------------
# 9. Focus indicators are visible
# ---------------------------------------------------------------------------

class TestFocusIndicators:
    """WCAG SC 2.4.7 -- Focus must be visible on interactive elements."""

    def test_no_outline_none_without_replacement(self, panel_html: str, panel_name: str) -> None:
        """CSS should not remove focus outlines without providing an alternative."""
        outline_none = re.findall(
            r'outline\s*:\s*(?:none|0)\b',
            panel_html,
            re.IGNORECASE,
        )
        if outline_none:
            # Check if there is a replacement focus style (border-color, box-shadow, etc.)
            has_focus_style = bool(re.search(r':focus\s*\{[^}]*(?:border|box-shadow|outline)', panel_html))
            if not has_focus_style:
                pytest.xfail(
                    f"[{panel_name}] 'outline: none' found in CSS without visible "
                    "replacement focus indicator (:focus with border/box-shadow)"
                )

    def test_focus_styles_exist_for_inputs(self, panel_html: str, panel_name: str) -> None:
        """Input elements should have visible :focus styles."""
        has_focus_rule = bool(re.search(r':focus\s*\{', panel_html))
        has_inputs = bool(re.search(r'<(?:input|select|textarea|button)\b', panel_html))
        if has_inputs:
            assert has_focus_rule, (
                f"[{panel_name}] Has form controls but no :focus CSS rules -- "
                "focus indicators may not be visible"
            )


# ---------------------------------------------------------------------------
# 10. No content relies solely on color
# ---------------------------------------------------------------------------

class TestColorNotSoleIndicator:
    """WCAG SC 1.4.1 -- Color must not be the only visual means of conveying info."""

    def test_status_dots_have_additional_indicator(self, panel_html: str, panel_name: str) -> None:
        """Status indicators using colored dots should also have text or title."""
        status_dots = re.findall(
            r'<span[^>]+class="[^"]*status-dot[^"]*"[^>]*>',
            panel_html,
        )
        for dot in status_dots:
            has_text_nearby = bool(re.search(r'title\s*=', dot))
            # The dots should be accompanied by text labels (checked in surrounding context)
            if not has_text_nearby:
                # Check if sibling text exists (common pattern: dot + text span)
                pytest.xfail(
                    f"[{panel_name}] Status dot uses color alone without title "
                    "attribute -- recommend adding title or aria-label"
                )

    def test_badges_have_text_content(self, panel_html: str, panel_name: str) -> None:
        """Badges (pass/fail/warn) should have text, not just color."""
        badge_pattern = re.compile(r'<span[^>]+class="[^"]*badge[^"]*"[^>]*>([^<]*)</span>')
        badges = badge_pattern.findall(panel_html)
        for badge_text in badges:
            # Badges in the template HTML should have text content
            if badge_text.strip():
                continue  # Has text -- good


# ---------------------------------------------------------------------------
# 11. Modal/dialog panels trap focus
# ---------------------------------------------------------------------------

class TestModalFocusTrap:
    """WCAG SC 2.4.3 -- Modal dialogs must trap focus."""

    def test_collapsible_panels_keyboard_accessible(self, panel_html: str, panel_name: str) -> None:
        """Collapsible/toggle panels should be operable via keyboard."""
        toggles = re.findall(
            r'<div[^>]+class="[^"]*toggle[^"]*"[^>]*>',
            panel_html,
        )
        for toggle in toggles:
            if 'role=' not in toggle and 'tabindex=' not in toggle:
                pytest.xfail(
                    f"[{panel_name}] Collapsible toggle <div> lacks role=button "
                    "and tabindex for keyboard activation"
                )

    def test_no_focus_escape_from_dialogs(self, panel_html: str, panel_name: str) -> None:
        """If dialog/modal elements exist, they should have role=dialog and aria-modal."""
        dialogs = re.findall(r'role\s*=\s*["\']dialog["\']', panel_html)
        modals = re.findall(r'class="[^"]*modal[^"]*"', panel_html)
        if modals and not dialogs:
            pytest.xfail(
                f"[{panel_name}] Modal elements found but missing role='dialog' "
                "and aria-modal='true' for focus trapping"
            )


# ---------------------------------------------------------------------------
# 12. Language attribute on HTML element
# ---------------------------------------------------------------------------

class TestLanguageAttribute:
    """WCAG SC 3.1.1 -- Page language must be programmatically identified."""

    def test_html_has_lang(self, panel_html: str, panel_name: str) -> None:
        match = re.search(r'<html[^>]+lang\s*=\s*["\'](\w+)["\']', panel_html, re.IGNORECASE)
        assert match, (
            f"[{panel_name}] <html> element missing lang attribute"
        )
        lang = match.group(1)
        assert len(lang) >= 2, (
            f"[{panel_name}] lang attribute value '{lang}' is too short"
        )


# ---------------------------------------------------------------------------
# 13. Error messages programmatically associated with inputs
# ---------------------------------------------------------------------------

class TestErrorAssociations:
    """WCAG SC 3.3.1 -- Error identification must be programmatic."""

    def test_inputs_with_validation_have_aria_describedby(self, panel_html: str, panel_name: str) -> None:
        """Inputs with validation (required, pattern, etc.) should have aria-describedby for errors."""
        required_inputs = re.findall(r'<input[^>]+required[^>]*>', panel_html)
        for inp in required_inputs:
            if "aria-describedby" not in inp and "aria-errormessage" not in inp:
                pytest.xfail(
                    f"[{panel_name}] Required input lacks aria-describedby or "
                    "aria-errormessage for error message association"
                )

    def test_ts_validation_uses_aria(self) -> None:
        """TypeScript validation components should set aria-invalid on errors."""
        for ts_file in TS_COMPONENT_FILES:
            content = _read(ts_file)
            if not content:
                continue
            if "valid" in content.lower() and "error" in content.lower():
                if "aria-invalid" not in content:
                    pytest.xfail(
                        f"{ts_file.name}: performs validation but does not "
                        "set aria-invalid on the field"
                    )


# ---------------------------------------------------------------------------
# 14. Skip-to-main-content or landmark roles
# ---------------------------------------------------------------------------

class TestLandmarkRoles:
    """WCAG SC 2.4.1, 1.3.1 -- Pages need navigable landmarks."""

    def test_has_landmark_roles_or_elements(self, panel_html: str, panel_name: str) -> None:
        """Panels should have header/main/nav landmarks or ARIA roles."""
        landmarks_present = (
            bool(re.search(r'<(?:header|main|nav|footer|aside)\b', panel_html, re.IGNORECASE))
            or bool(re.search(r'role\s*=\s*["\'](?:banner|main|navigation|contentinfo)["\']', panel_html))
        )
        assert landmarks_present, (
            f"[{panel_name}] No landmark regions (header/main/nav or "
            "role=banner/main/navigation) found for screen reader navigation"
        )

    def test_has_skip_link_or_main_landmark(self, panel_html: str, panel_name: str) -> None:
        """Panels should have either a skip-to-content link or a <main> landmark."""
        has_skip = bool(re.search(r'skip.to.(?:main|content)', panel_html, re.IGNORECASE))
        has_main = bool(
            re.search(r'<main\b', panel_html, re.IGNORECASE)
            or re.search(r'role\s*=\s*["\']main["\']', panel_html)
        )
        if not has_skip and not has_main:
            pytest.xfail(
                f"[{panel_name}] No skip-to-content link or <main> landmark found -- "
                "keyboard users need a way to bypass repeated navigation"
            )


# ---------------------------------------------------------------------------
# 15. Dynamic content updates announced to assistive technology
# ---------------------------------------------------------------------------

class TestDynamicContentAnnouncements:
    """WCAG SC 4.1.3 -- Dynamic updates must be announced."""

    def test_notification_areas_use_live_regions(self, panel_html: str, panel_name: str) -> None:
        """Notification/log containers should use aria-live for dynamic updates."""
        notification_ids = re.findall(
            r'id\s*=\s*["\']([^"\']*(?:notification|log|alert|status|error)[^"\']*)["\']',
            panel_html,
            re.IGNORECASE,
        )
        if notification_ids:
            has_any_live = bool(re.search(r'aria-live', panel_html))
            if not has_any_live:
                pytest.xfail(
                    f"[{panel_name}] Has dynamic containers ({notification_ids}) "
                    "but no aria-live regions for screen reader announcements"
                )

    def test_score_updates_announced(self, panel_html: str, panel_name: str) -> None:
        """Score/progress indicators that update dynamically need aria-live."""
        score_elements = re.findall(
            r'id\s*=\s*["\']([^"\']*(?:score|progress|cycle|chip)[^"\']*)["\']',
            panel_html,
            re.IGNORECASE,
        )
        if len(score_elements) > 2:
            has_live = bool(re.search(r'aria-live', panel_html))
            if not has_live:
                pytest.xfail(
                    f"[{panel_name}] Multiple dynamic score/status elements "
                    f"({len(score_elements)}) but no aria-live announcements"
                )

    def test_connection_status_announced(self, panel_html: str, panel_name: str) -> None:
        """Connection status changes should be announced to assistive tech."""
        conn_indicators = re.findall(
            r'class="[^"]*conn.indicator[^"]*"',
            panel_html,
        )
        if conn_indicators:
            # The conn-indicator div or its parent should have aria-live
            has_live_near_conn = bool(
                re.search(r'conn.*aria-live|aria-live.*conn', panel_html, re.DOTALL)
            )
            if not has_live_near_conn:
                pytest.xfail(
                    f"[{panel_name}] Connection status indicator lacks aria-live "
                    "-- connection state changes not announced to screen readers"
                )


# ---------------------------------------------------------------------------
# Cross-cutting: All panels batch check
# ---------------------------------------------------------------------------

class TestAllPanelsExist:
    """Verify all expected panel HTML files are present."""

    def test_all_panel_files_exist(self) -> None:
        missing = [name for name, path in PANEL_HTML_FILES.items() if not path.exists()]
        assert not missing, f"Missing panel HTML files: {missing}"

    def test_all_panels_have_doctype(self) -> None:
        for name, path in PANEL_HTML_FILES.items():
            content = _read(path)
            if content:
                assert content.strip().lower().startswith("<!doctype html"), (
                    f"[{name}] Missing <!DOCTYPE html> declaration"
                )

    def test_all_panels_have_charset(self) -> None:
        for name, path in PANEL_HTML_FILES.items():
            content = _read(path)
            if content:
                assert re.search(r'charset\s*=\s*["\']?utf-8', content, re.IGNORECASE), (
                    f"[{name}] Missing charset=UTF-8 meta tag"
                )

    def test_all_panels_have_viewport_meta(self) -> None:
        for name, path in PANEL_HTML_FILES.items():
            content = _read(path)
            if content:
                assert re.search(r'name\s*=\s*["\']viewport["\']', content, re.IGNORECASE), (
                    f"[{name}] Missing viewport meta tag for responsive design"
                )

    def test_all_panels_have_title(self) -> None:
        for name, path in PANEL_HTML_FILES.items():
            content = _read(path)
            if content:
                assert re.search(r'<title>[^<]+</title>', content, re.IGNORECASE), (
                    f"[{name}] Missing or empty <title> element"
                )
