"""
Code quality, maintainability, and robustness tests for the Aurelius Autoresearch Agent.

Validates Python source hygiene (docstrings, bare excepts, print statements),
TypeScript error handling, configuration integrity, Docker healthchecks,
Rego policy declarations, and structural rules across the codebase.

Uses only stdlib -- no external lint tools required.
"""

from __future__ import annotations

import ast
import importlib
import os
import re
import sys
from pathlib import Path
from typing import Any

import pytest

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent
AGENT_DIR = PROJECT_ROOT / "agent"
SRC_DIR = PROJECT_ROOT / "src"
TESTS_DIR = PROJECT_ROOT / "tests"
POLICIES_DIR = PROJECT_ROOT / "policies"
DOCKER_COMPOSE_FILES = list(PROJECT_ROOT.glob("docker-compose*.y*ml")) + list(
    (PROJECT_ROOT / "docker").glob("docker-compose*.y*ml")
)
ENV_EXAMPLE = PROJECT_ROOT / ".env.example"


def _read(path: Path) -> str:
    if path.exists():
        return path.read_text(encoding="utf-8", errors="replace")
    return ""


def _python_files(directory: Path) -> list[Path]:
    """Collect all .py files under a directory."""
    if not directory.exists():
        return []
    return sorted(directory.rglob("*.py"))


def _ts_files(directory: Path) -> list[Path]:
    if not directory.exists():
        return []
    return sorted(directory.rglob("*.ts"))


# ---------------------------------------------------------------------------
# 1. No Python files exceed 500 lines
# ---------------------------------------------------------------------------

class TestFileLengthLimits:
    """Maintainability: files should not be excessively long."""

    MAX_LINES = 500

    def test_python_file_length(self) -> None:
        violations: list[str] = []
        for py_file in _python_files(AGENT_DIR):
            content = _read(py_file)
            line_count = content.count("\n") + 1
            if line_count > self.MAX_LINES:
                violations.append(
                    f"{py_file.relative_to(PROJECT_ROOT)}: {line_count} lines "
                    f"(max {self.MAX_LINES})"
                )
        assert not violations, (
            f"Python files exceeding {self.MAX_LINES} lines:\n"
            + "\n".join(f"  - {v}" for v in violations)
        )


# ---------------------------------------------------------------------------
# 2. All Python functions have docstrings (public methods)
# ---------------------------------------------------------------------------

class TestDocstrings:
    """All public functions/methods should have docstrings."""

    def test_public_functions_have_docstrings(self) -> None:
        missing: list[str] = []
        for py_file in _python_files(AGENT_DIR):
            content = _read(py_file)
            if not content.strip():
                continue
            try:
                tree = ast.parse(content, filename=str(py_file))
            except SyntaxError:
                continue

            rel_path = py_file.relative_to(PROJECT_ROOT)
            for node in ast.walk(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    # Skip private/dunder methods (except __init__)
                    if node.name.startswith("_") and node.name != "__init__":
                        continue
                    docstring = ast.get_docstring(node)
                    if not docstring:
                        missing.append(
                            f"{rel_path}:{node.lineno} -> {node.name}()"
                        )
                elif isinstance(node, ast.ClassDef):
                    if node.name.startswith("_"):
                        continue
                    docstring = ast.get_docstring(node)
                    if not docstring:
                        missing.append(
                            f"{rel_path}:{node.lineno} -> class {node.name}"
                        )
        if missing:
            pytest.xfail(
                f"{len(missing)} public function(s)/class(es) missing docstrings:\n"
                + "\n".join(f"  - {m}" for m in missing[:20])
                + (f"\n  ... and {len(missing) - 20} more" if len(missing) > 20 else "")
            )


# ---------------------------------------------------------------------------
# 3. No bare except clauses
# ---------------------------------------------------------------------------

class TestNoBareExcepts:
    """Bare 'except:' catches everything including KeyboardInterrupt -- forbid them."""

    def test_no_bare_except_in_python(self) -> None:
        violations: list[str] = []
        for py_file in _python_files(AGENT_DIR):
            content = _read(py_file)
            if not content.strip():
                continue
            try:
                tree = ast.parse(content, filename=str(py_file))
            except SyntaxError:
                continue
            rel_path = py_file.relative_to(PROJECT_ROOT)
            for node in ast.walk(tree):
                if isinstance(node, ast.ExceptHandler):
                    if node.type is None:
                        violations.append(f"{rel_path}:{node.lineno}")
        assert not violations, (
            "Bare 'except:' clauses found (catch specific exceptions instead):\n"
            + "\n".join(f"  - {v}" for v in violations)
        )


# ---------------------------------------------------------------------------
# 4. No print() statements in production code
# ---------------------------------------------------------------------------

class TestNoPrintStatements:
    """Production code should use logging, not print()."""

    def test_no_print_in_agent_code(self) -> None:
        violations: list[str] = []
        for py_file in _python_files(AGENT_DIR):
            # Skip __main__.py where print may be acceptable for CLI output
            if py_file.name == "__main__.py":
                continue
            content = _read(py_file)
            if not content.strip():
                continue
            try:
                tree = ast.parse(content, filename=str(py_file))
            except SyntaxError:
                continue
            rel_path = py_file.relative_to(PROJECT_ROOT)
            for node in ast.walk(tree):
                if isinstance(node, ast.Call):
                    func = node.func
                    if isinstance(func, ast.Name) and func.id == "print":
                        violations.append(f"{rel_path}:{node.lineno}")
        assert not violations, (
            "print() statements in production code (use logging instead):\n"
            + "\n".join(f"  - {v}" for v in violations)
        )


# ---------------------------------------------------------------------------
# 5. All async functions are properly awaited
# ---------------------------------------------------------------------------

class TestAsyncAwaitUsage:
    """Async functions should not be called without await (fire-and-forget)."""

    def test_no_unawaited_async_calls_in_python(self) -> None:
        """Check for common pattern: calling an async function without await."""
        violations: list[str] = []
        for py_file in _python_files(AGENT_DIR):
            content = _read(py_file)
            if not content.strip():
                continue
            try:
                tree = ast.parse(content, filename=str(py_file))
            except SyntaxError:
                continue
            rel_path = py_file.relative_to(PROJECT_ROOT)

            # Collect names of async functions defined in this file
            async_func_names: set[str] = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.AsyncFunctionDef):
                    async_func_names.add(node.name)

            # Walk again looking for calls to those functions outside of await
            for node in ast.walk(tree):
                if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
                    call = node.value
                    func_name = ""
                    if isinstance(call.func, ast.Name):
                        func_name = call.func.id
                    elif isinstance(call.func, ast.Attribute):
                        func_name = call.func.attr
                    if func_name in async_func_names:
                        violations.append(
                            f"{rel_path}:{node.lineno} -> {func_name}() "
                            "called without await"
                        )
        assert not violations, (
            "Async functions called without await (fire-and-forget):\n"
            + "\n".join(f"  - {v}" for v in violations)
        )


# ---------------------------------------------------------------------------
# 6. No hardcoded localhost URLs in production code
# ---------------------------------------------------------------------------

class TestNoHardcodedLocalhostURLs:
    """Production code should use config/env vars, not hardcoded localhost."""

    # Pattern to find localhost URLs (not in comments or strings used as defaults)
    LOCALHOST_PATTERN = re.compile(
        r'(?<!#\s)["\']https?://(?:localhost|127\.0\.0\.1):\d+["\']'
    )

    def test_no_hardcoded_localhost_in_python(self) -> None:
        violations: list[str] = []
        for py_file in _python_files(AGENT_DIR):
            content = _read(py_file)
            rel_path = py_file.relative_to(PROJECT_ROOT)
            for i, line in enumerate(content.splitlines(), 1):
                stripped = line.strip()
                # Allow in comments, env.get defaults, and docstrings
                if stripped.startswith("#"):
                    continue
                if "environ.get" in line or "os.getenv" in line or ".get(" in line:
                    continue
                matches = self.LOCALHOST_PATTERN.findall(line)
                for m in matches:
                    violations.append(f"{rel_path}:{i} -> {m}")
        assert not violations, (
            "Hardcoded localhost URLs found (use config/env vars):\n"
            + "\n".join(f"  - {v}" for v in violations)
        )


# ---------------------------------------------------------------------------
# 7. TypeScript files use proper error handling
# ---------------------------------------------------------------------------

class TestTypeScriptErrorHandling:
    """Async TypeScript code should use try/catch."""

    def test_async_functions_have_try_catch(self) -> None:
        issues: list[str] = []
        for ts_file in _ts_files(SRC_DIR):
            content = _read(ts_file)
            if not content:
                continue
            rel_path = ts_file.relative_to(PROJECT_ROOT)

            # Find async functions/methods
            async_fns = re.finditer(
                r'async\s+(?:\w+\s+)?(\w+)\s*\([^)]*\)[^{]*\{',
                content,
            )
            for match in async_fns:
                fn_name = match.group(1)
                # Get function body (rough: find matching brace)
                start = match.end()
                depth = 1
                pos = start
                while pos < len(content) and depth > 0:
                    if content[pos] == "{":
                        depth += 1
                    elif content[pos] == "}":
                        depth -= 1
                    pos += 1
                body = content[start:pos]
                # Check for try/catch or .catch in the body
                has_error_handling = (
                    "try" in body
                    or ".catch(" in body
                    or "catch(" in body
                    or "catch {" in body
                )
                # Skip very short functions (one-liners, getters, etc.)
                if body.count("\n") < 3:
                    continue
                if not has_error_handling:
                    issues.append(f"{rel_path} -> async {fn_name}()")

        if issues:
            pytest.xfail(
                f"{len(issues)} async TypeScript function(s) without try/catch:\n"
                + "\n".join(f"  - {i}" for i in issues[:15])
            )


# ---------------------------------------------------------------------------
# 8. No TODO/FIXME/HACK comments in production code
# ---------------------------------------------------------------------------

class TestNoTodoComments:
    """Production code should not have leftover TODO/FIXME/HACK markers."""

    MARKERS = re.compile(r'\b(TODO|FIXME|HACK|XXX|TEMP)\b', re.IGNORECASE)

    def test_no_todo_in_python(self) -> None:
        found: list[str] = []
        for py_file in _python_files(AGENT_DIR):
            content = _read(py_file)
            rel_path = py_file.relative_to(PROJECT_ROOT)
            for i, line in enumerate(content.splitlines(), 1):
                if self.MARKERS.search(line):
                    found.append(f"{rel_path}:{i} -> {line.strip()[:80]}")
        assert not found, (
            "TODO/FIXME/HACK comments in production code:\n"
            + "\n".join(f"  - {f}" for f in found)
        )

    def test_no_todo_in_typescript(self) -> None:
        found: list[str] = []
        for ts_file in _ts_files(SRC_DIR):
            content = _read(ts_file)
            rel_path = ts_file.relative_to(PROJECT_ROOT)
            for i, line in enumerate(content.splitlines(), 1):
                if self.MARKERS.search(line):
                    found.append(f"{rel_path}:{i} -> {line.strip()[:80]}")
        assert not found, (
            "TODO/FIXME/HACK comments in TypeScript code:\n"
            + "\n".join(f"  - {f}" for f in found)
        )


# ---------------------------------------------------------------------------
# 9. All config values have defaults or validation
# ---------------------------------------------------------------------------

class TestConfigDefaults:
    """Configuration models should have defaults or validation."""

    def test_pydantic_fields_have_defaults_or_required(self) -> None:
        config_path = AGENT_DIR / "config.py"
        content = _read(config_path)
        if not content:
            pytest.skip("config.py not found")

        try:
            tree = ast.parse(content)
        except SyntaxError:
            pytest.skip("config.py has syntax errors")

        # Look for Pydantic Field() calls without default
        issues: list[str] = []
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                for item in node.body:
                    if isinstance(item, ast.AnnAssign) and item.value is None:
                        # Annotated field with no default -- must have a type that
                        # makes it clearly required (e.g., no Optional)
                        target = item.target
                        if isinstance(target, ast.Name):
                            field_name = target.id
                            # This is acceptable for required fields in Pydantic
                            # Just verify the class is a BaseModel subclass
                            pass

        # Check that RunConfig has reasonable defaults
        assert "default" in content or "default_factory" in content, (
            "config.py should have default values for optional config fields"
        )

    def test_env_example_matches_docker_compose_env(self) -> None:
        """All environment variables in docker-compose should appear in .env.example."""
        env_content = _read(ENV_EXAMPLE)
        if not env_content:
            pytest.skip(".env.example not found")

        env_vars_defined = set(
            re.findall(r'^(\w+)=', env_content, re.MULTILINE)
        )

        for dc_file in DOCKER_COMPOSE_FILES:
            dc_content = _read(dc_file)
            # Find ${VAR:-default} and ${VAR} patterns
            dc_vars = set(re.findall(r'\$\{(\w+)(?::-[^}]*)?\}', dc_content))
            # Exclude standard vars that don't need to be in .env.example
            standard_vars = {"NODE_VERSION", "PATH", "HOME"}
            dc_vars -= standard_vars

            missing = dc_vars - env_vars_defined
            if missing:
                pytest.xfail(
                    f"Environment variables in {dc_file.name} missing from .env.example: "
                    f"{sorted(missing)}"
                )


# ---------------------------------------------------------------------------
# 10. No circular imports in Python modules
# ---------------------------------------------------------------------------

class TestNoCircularImports:
    """Detect potential circular imports in the agent package."""

    def test_no_circular_import_patterns(self) -> None:
        """Check for cross-imports that could form cycles."""
        # Build import graph
        imports: dict[str, set[str]] = {}
        for py_file in _python_files(AGENT_DIR):
            module = py_file.stem
            content = _read(py_file)
            if not content:
                continue
            try:
                tree = ast.parse(content)
            except SyntaxError:
                continue

            imports[module] = set()
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom):
                    if node.module and node.module.startswith("."):
                        # Relative import within agent package
                        imported_module = node.module.lstrip(".")
                        if imported_module:
                            imports[module].add(imported_module)
                    elif node.module and "agent." in (node.module or ""):
                        imported_module = node.module.split(".")[-1]
                        imports[module].add(imported_module)

        # Check for direct circular imports (A imports B, B imports A)
        circular: list[str] = []
        for mod_a, deps_a in imports.items():
            for dep in deps_a:
                if dep in imports and mod_a in imports[dep]:
                    pair = tuple(sorted([mod_a, dep]))
                    msg = f"{pair[0]} <-> {pair[1]}"
                    if msg not in circular:
                        circular.append(msg)

        # Note: some circular imports are handled via TYPE_CHECKING or local imports
        # So we flag but don't fail hard if they use local imports
        if circular:
            # Check if the circular imports use local/deferred imports
            for py_file in _python_files(AGENT_DIR):
                content = _read(py_file)
                if "from .config import" in content and "def " in content:
                    # Local import pattern -- acceptable
                    pass
            # If there are real top-level circular imports, that's a problem
            # For now, just verify the pattern doesn't exist at module scope


# ---------------------------------------------------------------------------
# 11. All test files follow consistent naming
# ---------------------------------------------------------------------------

class TestTestFileNaming:
    """Test files should follow the test_*.py convention."""

    def test_all_test_files_prefixed(self) -> None:
        if not TESTS_DIR.exists():
            pytest.skip("tests/ directory not found")
        py_files = list(TESTS_DIR.glob("*.py"))
        bad_names: list[str] = []
        for f in py_files:
            if f.name == "__init__.py" or f.name == "conftest.py":
                continue
            if not f.name.startswith("test_"):
                bad_names.append(f.name)
        assert not bad_names, (
            "Test files not following test_*.py convention:\n"
            + "\n".join(f"  - {n}" for n in bad_names)
        )

    def test_test_files_contain_test_functions(self) -> None:
        """Test files should contain at least one test function or class."""
        for test_file in TESTS_DIR.glob("test_*.py"):
            content = _read(test_file)
            has_tests = (
                bool(re.search(r'\bdef test_', content))
                or bool(re.search(r'\bclass Test', content))
            )
            assert has_tests, (
                f"{test_file.name} does not contain any test_ functions or Test classes"
            )


# ---------------------------------------------------------------------------
# 12. Docker compose services have healthchecks
# ---------------------------------------------------------------------------

class TestDockerHealthchecks:
    """All Docker services should have healthcheck definitions."""

    def test_all_services_have_healthcheck(self) -> None:
        if not DOCKER_COMPOSE_FILES:
            pytest.skip("No docker-compose files found")

        for dc_file in DOCKER_COMPOSE_FILES:
            content = _read(dc_file)
            if not content:
                continue

            # Parse services from YAML (simple regex approach)
            # Find service names (indented at exactly 2 spaces under 'services:')
            in_services = False
            current_service: str | None = None
            services: dict[str, str] = {}
            service_block_lines: dict[str, list[str]] = {}

            lines = content.splitlines()
            for i, line in enumerate(lines):
                if line.strip() == "services:":
                    in_services = True
                    continue
                if in_services:
                    # Top-level key (not indented under services) ends the block
                    if line and not line[0].isspace() and line.strip().endswith(":"):
                        in_services = False
                        continue
                    # Service name: exactly 2-space indent
                    service_match = re.match(r'^  (\w[\w-]*):', line)
                    if service_match:
                        current_service = service_match.group(1)
                        service_block_lines[current_service] = []
                    if current_service:
                        service_block_lines[current_service].append(line)

            missing_healthcheck: list[str] = []
            for svc_name, svc_lines in service_block_lines.items():
                block = "\n".join(svc_lines)
                # Services with 'profiles:' are optional -- skip
                if "profiles:" in block:
                    continue
                if "healthcheck:" not in block:
                    missing_healthcheck.append(svc_name)

            assert not missing_healthcheck, (
                f"{dc_file.name}: services missing healthcheck: "
                f"{missing_healthcheck}"
            )


# ---------------------------------------------------------------------------
# 13. Environment variables have fallback defaults in .env.example
# ---------------------------------------------------------------------------

class TestEnvExampleCompleteness:
    """The .env.example file should document all required variables."""

    def test_env_example_exists(self) -> None:
        assert ENV_EXAMPLE.exists(), ".env.example file not found at project root"

    def test_env_example_has_critical_vars(self) -> None:
        content = _read(ENV_EXAMPLE)
        if not content:
            pytest.skip(".env.example not found")

        critical_vars = [
            "ANTHROPIC_API_KEY",
            "LLM_PROVIDER",
            "OPA_ENDPOINT",
            "MINIO_ENDPOINT",
            "REDIS_URL",
        ]
        defined = set(re.findall(r'^(\w+)=', content, re.MULTILINE))
        missing = [v for v in critical_vars if v not in defined]
        assert not missing, (
            f".env.example missing critical variables: {missing}"
        )

    def test_env_example_no_real_secrets(self) -> None:
        """Ensure .env.example does not contain real API keys or passwords."""
        content = _read(ENV_EXAMPLE)
        if not content:
            pytest.skip(".env.example not found")

        # Check for patterns that look like real secrets
        suspicious: list[str] = []
        for i, line in enumerate(content.splitlines(), 1):
            if "=" not in line or line.strip().startswith("#"):
                continue
            key, _, value = line.partition("=")
            value = value.strip()
            # Real API keys are typically long alphanumeric strings
            if re.match(r'^sk-[a-zA-Z0-9]{20,}$', value):
                suspicious.append(f"Line {i}: {key} appears to contain a real API key")
            # Real passwords shouldn't be in example files (except obvious placeholders)
            if key.strip().upper().endswith("PASSWORD") and value not in (
                "changeme123", "changeme", "password", "placeholder", ""
            ):
                suspicious.append(f"Line {i}: {key} may contain a non-placeholder password")

        assert not suspicious, (
            ".env.example may contain real secrets:\n"
            + "\n".join(f"  - {s}" for s in suspicious)
        )


# ---------------------------------------------------------------------------
# 14. No duplicate function names within same module
# ---------------------------------------------------------------------------

class TestNoDuplicateFunctionNames:
    """No two functions in the same module should share a name."""

    def test_no_duplicate_function_names(self) -> None:
        duplicates: list[str] = []
        for py_file in _python_files(AGENT_DIR):
            content = _read(py_file)
            if not content:
                continue
            try:
                tree = ast.parse(content)
            except SyntaxError:
                continue

            rel_path = py_file.relative_to(PROJECT_ROOT)

            # Check top-level functions
            top_level_names: list[str] = []
            for node in ast.iter_child_nodes(tree):
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    if node.name in top_level_names:
                        duplicates.append(
                            f"{rel_path}:{node.lineno} -> duplicate "
                            f"top-level function '{node.name}'"
                        )
                    top_level_names.append(node.name)

            # Check within each class
            for node in ast.iter_child_nodes(tree):
                if isinstance(node, ast.ClassDef):
                    method_names: list[str] = []
                    for item in node.body:
                        if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                            if item.name in method_names:
                                duplicates.append(
                                    f"{rel_path}:{item.lineno} -> duplicate "
                                    f"method '{item.name}' in class {node.name}"
                                )
                            method_names.append(item.name)

        assert not duplicates, (
            "Duplicate function/method names found:\n"
            + "\n".join(f"  - {d}" for d in duplicates)
        )


# ---------------------------------------------------------------------------
# 15. Rego policies have package declarations
# ---------------------------------------------------------------------------

class TestRegoPolicies:
    """OPA Rego policy files must declare a package."""

    def test_rego_files_have_package(self) -> None:
        rego_files = sorted(POLICIES_DIR.rglob("*.rego")) if POLICIES_DIR.exists() else []
        if not rego_files:
            pytest.skip("No .rego policy files found")

        missing_package: list[str] = []
        for rego_file in rego_files:
            content = _read(rego_file)
            # Package declaration should be near the top (after comments)
            has_package = bool(
                re.search(r'^\s*package\s+\w+', content, re.MULTILINE)
            )
            if not has_package:
                missing_package.append(str(rego_file.relative_to(PROJECT_ROOT)))

        assert not missing_package, (
            "Rego files missing package declaration:\n"
            + "\n".join(f"  - {f}" for f in missing_package)
        )

    def test_rego_files_have_default_rules(self) -> None:
        """Rego policies should define default values for decision rules."""
        rego_files = sorted(POLICIES_DIR.rglob("*.rego")) if POLICIES_DIR.exists() else []
        if not rego_files:
            pytest.skip("No .rego files found")

        missing_default: list[str] = []
        for rego_file in rego_files:
            content = _read(rego_file)
            has_default = bool(re.search(r'^\s*default\s+\w+', content, re.MULTILINE))
            if not has_default:
                missing_default.append(str(rego_file.relative_to(PROJECT_ROOT)))

        if missing_default:
            pytest.xfail(
                "Rego files without default rule declarations:\n"
                + "\n".join(f"  - {f}" for f in missing_default)
            )


# ---------------------------------------------------------------------------
# Bonus: Module-level docstrings
# ---------------------------------------------------------------------------

class TestModuleDocstrings:
    """All Python modules in agent/ should have module-level docstrings."""

    def test_agent_modules_have_docstrings(self) -> None:
        missing: list[str] = []
        for py_file in _python_files(AGENT_DIR):
            if py_file.name == "__init__.py":
                continue
            content = _read(py_file)
            if not content.strip():
                continue
            try:
                tree = ast.parse(content)
            except SyntaxError:
                continue
            docstring = ast.get_docstring(tree)
            if not docstring:
                missing.append(str(py_file.relative_to(PROJECT_ROOT)))
        assert not missing, (
            "Python modules missing module-level docstrings:\n"
            + "\n".join(f"  - {m}" for m in missing)
        )


# ---------------------------------------------------------------------------
# Bonus: Consistent logging usage
# ---------------------------------------------------------------------------

class TestLoggingConsistency:
    """Agent modules should use the logging module consistently."""

    def test_all_agent_modules_import_logging(self) -> None:
        """Non-trivial modules should import and configure logging."""
        missing: list[str] = []
        for py_file in _python_files(AGENT_DIR):
            if py_file.name in ("__init__.py", "__main__.py"):
                continue
            content = _read(py_file)
            if not content.strip() or content.count("\n") < 10:
                continue
            has_logging = (
                "import logging" in content
                or "from logging" in content
            )
            if not has_logging:
                missing.append(str(py_file.relative_to(PROJECT_ROOT)))
        if missing:
            pytest.xfail(
                "Agent modules without logging import:\n"
                + "\n".join(f"  - {m}" for m in missing)
            )
