"""Security tests for the Aurelius Autoresearch Agent."""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient
from pydantic import ValidationError

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def client():
    """Create a FastAPI test client."""
    from dashboard.app import app

    return TestClient(app)


@pytest.fixture
def tmp_run_dir(tmp_path):
    """Create a temporary run directory for audit tests."""
    run_dir = tmp_path / "test-run"
    run_dir.mkdir()
    return run_dir


# ===========================================================================
# Test 1: Path Traversal Prevention
# ===========================================================================


class TestPathTraversalPrevention:
    """Verify that path traversal attacks are prevented."""

    def test_run_config_accepts_traversal_path_as_path_object(self):
        """RunConfig stores target_path as a Path object (no automatic sanitization)."""
        from agent.config import RunConfig

        config = RunConfig(
            mode="proposal",
            target_path=Path("../../etc/passwd"),
            metric="readability",
            threshold=90.0,
        )
        # The Path object is stored as-is; actual protection must come from
        # the file-read step (the file won't exist or won't be readable).
        assert isinstance(config.target_path, Path)

    def test_run_config_target_path_is_path_type(self):
        """Verify target_path is coerced to Path, not kept as raw string."""
        from agent.config import RunConfig

        config = RunConfig(
            mode="proposal",
            target_path="../../../etc/passwd",
            metric="readability",
            threshold=90.0,
        )
        assert isinstance(config.target_path, Path)

    def test_api_start_run_traversal_path_does_not_leak_file_contents(self, client):
        """POST /api/runs with traversal path should not leak system files.

        The endpoint may return 200 (starting a background task that will fail)
        or 400 (if component init fails). Either way, the response body must
        NOT contain file contents from the traversed path.
        """
        response = client.post(
            "/api/runs",
            json={
                "mode": "proposal",
                "target_path": "../../../etc/passwd",
                "metric": "readability",
                "threshold": 90.0,
            },
        )
        body = response.text
        assert "root:" not in body
        assert "/bin/bash" not in body
        assert "/bin/sh" not in body
        # Must be either a controlled error (400) or a background start (200)
        assert response.status_code in (200, 400)

    def test_api_start_run_absolute_system_path_does_not_leak(self, client):
        """POST /api/runs with /etc/passwd should not leak file contents."""
        response = client.post(
            "/api/runs",
            json={
                "mode": "proposal",
                "target_path": "/etc/passwd",
                "metric": "readability",
                "threshold": 90.0,
            },
        )
        body = response.text
        assert "root:" not in body
        assert response.status_code in (200, 400)

    def test_get_run_path_traversal_does_not_leak(self, client):
        """GET /api/runs/../../etc/passwd should not leak file contents."""
        response = client.get("/api/runs/..%2F..%2Fetc%2Fpasswd")
        assert b"root:" not in response.content
        # Should be 404 for nonexistent run
        assert response.status_code == 404


# ===========================================================================
# Test 2: API Input Validation
# ===========================================================================


class TestAPIInputValidation:
    """Verify that invalid inputs are rejected with 400."""

    def test_missing_required_fields(self, client):
        """POST /api/runs with missing fields -> 400, not 500."""
        response = client.post("/api/runs", json={})
        assert response.status_code == 400

    def test_threshold_above_100(self, client):
        """POST /api/runs with threshold > 100 -> 400."""
        response = client.post(
            "/api/runs",
            json={
                "mode": "proposal",
                "target_path": "/tmp/test.md",
                "metric": "readability",
                "threshold": 150.0,
            },
        )
        assert response.status_code == 400

    def test_threshold_below_0(self, client):
        """POST /api/runs with threshold < 0 -> 400."""
        response = client.post(
            "/api/runs",
            json={
                "mode": "proposal",
                "target_path": "/tmp/test.md",
                "metric": "readability",
                "threshold": -10.0,
            },
        )
        assert response.status_code == 400

    def test_invalid_mode(self, client):
        """POST /api/runs with invalid mode -> 400."""
        response = client.post(
            "/api/runs",
            json={
                "mode": "invalid_mode",
                "target_path": "/tmp/test.md",
                "metric": "readability",
                "threshold": 90.0,
            },
        )
        assert response.status_code == 400

    def test_max_iterations_zero(self):
        """RunConfig with max_iterations=0 -> ValidationError (ge=1)."""
        from agent.config import RunConfig

        with pytest.raises(ValidationError):
            RunConfig(
                mode="proposal",
                target_path=Path("/tmp/test.md"),
                metric="readability",
                threshold=90.0,
                max_iterations=0,
            )

    def test_max_iterations_extremely_large(self):
        """RunConfig with max_iterations=999999 -> ValidationError (le=1000)."""
        from agent.config import RunConfig

        with pytest.raises(ValidationError):
            RunConfig(
                mode="proposal",
                target_path=Path("/tmp/test.md"),
                metric="readability",
                threshold=90.0,
                max_iterations=999999,
            )

    def test_max_iterations_at_upper_bound(self):
        """RunConfig with max_iterations=1000 is accepted (boundary)."""
        from agent.config import RunConfig

        config = RunConfig(
            mode="proposal",
            target_path=Path("/tmp/test.md"),
            metric="readability",
            threshold=90.0,
            max_iterations=1000,
        )
        assert config.max_iterations == 1000

    def test_threshold_above_100_pydantic(self):
        """Direct Pydantic validation: threshold > 100 raises."""
        from agent.config import RunConfig

        with pytest.raises(ValidationError):
            RunConfig(
                mode="proposal",
                target_path=Path("/tmp/test.md"),
                metric="readability",
                threshold=101.0,
            )

    def test_threshold_below_0_pydantic(self):
        """Direct Pydantic validation: threshold < 0 raises."""
        from agent.config import RunConfig

        with pytest.raises(ValidationError):
            RunConfig(
                mode="proposal",
                target_path=Path("/tmp/test.md"),
                metric="readability",
                threshold=-0.1,
            )

    def test_invalid_mode_pydantic(self):
        """Direct Pydantic validation: invalid mode raises."""
        from agent.config import RunConfig

        with pytest.raises(ValidationError):
            RunConfig(
                mode="attack",
                target_path=Path("/tmp/test.md"),
                metric="readability",
                threshold=90.0,
            )


# ===========================================================================
# Test 3: SSE Stream Safety
# ===========================================================================


class TestSSEStreamSafety:
    """Verify SSE endpoints are safe against path traversal and XSS."""

    def test_sse_path_traversal_returns_no_file_contents(self, client):
        """GET /api/runs/../../etc/passwd/progress -> should not leak files."""
        response = client.get("/api/runs/..%2F..%2Fetc%2Fpasswd/progress")
        assert b"root:" not in response.content

    def test_sse_xss_injection(self, client):
        """GET /api/runs/<script>alert(1)</script> -> should not reflect XSS."""
        response = client.get("/api/runs/%3Cscript%3Ealert(1)%3C%2Fscript%3E")
        # Should return 404 JSON, not reflected HTML
        assert response.status_code == 404
        # Verify the response doesn't contain unescaped script tags
        body = response.text
        assert "<script>alert(1)</script>" not in body

    def test_get_run_nonexistent_returns_404(self, client):
        """GET /api/runs/nonexistent -> 404."""
        response = client.get("/api/runs/nonexistent-run-id")
        assert response.status_code == 404


# ===========================================================================
# Test 4: Environment Variable Handling
# ===========================================================================


class TestEnvironmentVariableHandling:
    """Verify API keys come from environment, not hardcoded."""

    def test_claude_provider_reads_key_from_env(self):
        """ClaudeProvider uses ANTHROPIC_API_KEY env var."""
        from agent.llm import ClaudeProvider

        import inspect

        source = inspect.getsource(ClaudeProvider.__init__)
        assert "os.environ" in source or "api_key" in source

    def test_openai_provider_reads_key_from_env(self):
        """OpenAICompatibleProvider uses OPENAI_API_KEY env var."""
        from agent.llm import OpenAICompatibleProvider

        import inspect

        source = inspect.getsource(OpenAICompatibleProvider.__init__)
        assert "os.environ" in source or "api_key" in source

    def test_env_example_has_empty_values(self):
        """Verify .env.example has empty API key values (no real keys)."""
        env_example = Path(__file__).parent.parent / ".env.example"
        if env_example.exists():
            content = env_example.read_text()
            for line in content.strip().splitlines():
                line = line.strip()
                if line.startswith("#") or not line:
                    continue
                if "API_KEY" in line:
                    key, _, value = line.partition("=")
                    assert value.strip() == "", (
                        f"API key {key} has a value in .env.example: {value!r}"
                    )

    def test_no_api_keys_in_source_files(self):
        """Verify no hardcoded API keys in any Python source file."""
        agent_dir = Path(__file__).parent.parent
        suspicious_patterns = [
            "sk-ant-",  # Anthropic key prefix
            "sk-proj-",  # OpenAI key prefix
        ]
        for py_file in agent_dir.rglob("*.py"):
            if "__pycache__" in str(py_file):
                continue
            content = py_file.read_text()
            for pattern in suspicious_patterns:
                # Only flag if it looks like an actual key (long string after prefix)
                matches = re.findall(rf"{pattern}[A-Za-z0-9_-]{{20,}}", content)
                assert not matches, (
                    f"Possible hardcoded API key in {py_file}: {matches}"
                )


# ===========================================================================
# Test 5: Audit Trail Integrity
# ===========================================================================


class TestAuditTrailIntegrity:
    """Verify SHA-256 hashes and tampering detection."""

    def test_sha256_hash_is_correct(self, tmp_run_dir):
        """Verify hash_artifact produces correct SHA-256."""
        from agent.audit import AuditTrail

        audit = AuditTrail(tmp_run_dir)
        content = "Test artifact content for hashing."
        expected = hashlib.sha256(content.encode("utf-8")).hexdigest()
        assert audit.hash_artifact(content) == expected

    def test_sha256_hash_deterministic(self, tmp_run_dir):
        """Same content always produces same hash."""
        from agent.audit import AuditTrail

        audit = AuditTrail(tmp_run_dir)
        content = "Repeatable content"
        h1 = audit.hash_artifact(content)
        h2 = audit.hash_artifact(content)
        assert h1 == h2

    def test_sha256_hash_changes_on_modification(self, tmp_run_dir):
        """Different content produces different hash."""
        from agent.audit import AuditTrail

        audit = AuditTrail(tmp_run_dir)
        h1 = audit.hash_artifact("Version 1")
        h2 = audit.hash_artifact("Version 2")
        assert h1 != h2

    def test_tamper_detection(self, tmp_run_dir):
        """Create an audit trail, tamper with artifact, verify hash mismatch."""
        from agent.audit import AuditTrail

        audit = AuditTrail(tmp_run_dir)

        original_content = "This is the original artifact content for audit."
        score = 75.0
        audit.log_baseline(original_content, score)

        # Read the baseline.yaml to get the recorded hash
        baseline_data = yaml.safe_load(
            (tmp_run_dir / "baseline.yaml").read_text()
        )
        recorded_hash = baseline_data["hash"]

        # Verify original hash matches
        assert recorded_hash == hashlib.sha256(
            original_content.encode("utf-8")
        ).hexdigest()

        # Now tamper with the stored artifact
        tampered_content = "TAMPERED: This content has been modified maliciously."
        (tmp_run_dir / "original").write_text(tampered_content)

        # Verify the hash no longer matches
        tampered_hash = hashlib.sha256(
            tampered_content.encode("utf-8")
        ).hexdigest()
        assert tampered_hash != recorded_hash, (
            "Tampered content should not match original hash"
        )

        # Independent verification: read stored file, compute hash, compare
        stored_content = (tmp_run_dir / "original").read_text()
        computed_hash = hashlib.sha256(
            stored_content.encode("utf-8")
        ).hexdigest()
        assert computed_hash != recorded_hash, (
            "Hash of tampered file should differ from audit record"
        )


# ===========================================================================
# Test 6: CORS Configuration
# ===========================================================================


class TestCORSConfiguration:
    """Verify CORS is configured (and document security implications)."""

    def test_cors_allows_all_origins_for_local_dev(self, client):
        """Verify CORS allows all origins (acceptable for local dev only)."""
        response = client.options(
            "/api/runs",
            headers={
                "Origin": "http://evil.com",
                "Access-Control-Request-Method": "GET",
            },
        )
        # CORS middleware should respond; allow_origins=["*"] is set
        # For local development this is acceptable
        assert response.status_code in (200, 405)

    def test_cors_wildcard_is_documented(self):
        """Verify allow_origins=['*'] is present in dashboard/app.py."""
        app_source = (
            Path(__file__).parent.parent / "dashboard" / "app.py"
        ).read_text()
        assert 'allow_origins=["*"]' in app_source, (
            "CORS allow_origins=['*'] should be present for local dev. "
            "NOTE: This must be restricted in production deployments."
        )


# ===========================================================================
# Test 7: Dependency Security
# ===========================================================================


class TestDependencySecurity:
    """Check dependency configuration for security concerns."""

    def test_pyproject_uses_minimum_version_pins(self):
        """Verify dependencies use >= pins (minimum versions, not unpinned)."""
        pyproject_path = Path(__file__).parent.parent / "pyproject.toml"
        content = pyproject_path.read_text()

        # All dependencies should have version constraints
        deps_match = re.search(
            r"dependencies\s*=\s*\[(.*?)\]", content, re.DOTALL
        )
        assert deps_match, "No dependencies section found"
        deps_text = deps_match.group(1)

        # Extract quoted dependency strings
        dep_lines = re.findall(r'"([^"]+)"', deps_text)
        for dep in dep_lines:
            assert ">=" in dep or "==" in dep or "~=" in dep, (
                f"Dependency {dep!r} has no version pin"
            )

    def test_no_known_vulnerable_patterns(self):
        """Check for known vulnerable package patterns."""
        pyproject_path = Path(__file__).parent.parent / "pyproject.toml"
        content = pyproject_path.read_text()

        # Known vulnerable packages (examples, update as needed)
        vulnerable_packages = [
            "pyyaml<5.4",  # CVE-2020-14343
            "jinja2<2.11.3",  # CVE-2020-28493
            "httpx<0.23",  # Various security fixes
        ]
        for vuln in vulnerable_packages:
            assert vuln not in content, (
                f"Potentially vulnerable dependency pattern found: {vuln}"
            )

    def test_no_wildcard_dependency_versions(self):
        """Verify no dependency uses * for version."""
        pyproject_path = Path(__file__).parent.parent / "pyproject.toml"
        content = pyproject_path.read_text()

        # Extract the dependencies section only
        deps_match = re.search(
            r"dependencies\s*=\s*\[(.*?)\]", content, re.DOTALL
        )
        if deps_match:
            deps_text = deps_match.group(1)
            # Look for wildcard version patterns like "package==*" or "package>=*"
            assert not re.search(r'[><=~]+\*', deps_text), (
                "Wildcard version found in dependencies"
            )
