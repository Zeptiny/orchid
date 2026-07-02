---
title: Add pyright strict type checking
type: refactor
status: active
date: 2026-07-01
---

# Add pyright strict type checking

## Summary

Add pyright in strict mode as a static type checker for the orchid codebase. This involves configuring pyright, adding it to dev dependencies and CI, then incrementally fixing type errors across 59 Python source files to achieve a clean strict-mode pass.

---

## Problem Frame

The orchid codebase has no static type checking configured. While many domain dataclasses have reasonable annotations, there is pervasive `Any` usage, missing return types on some methods, and untyped parameters in key files (`llm/client.py`, `app.py`, `config.py`, `agents/manager.py`). Without a type checker, type errors propagate silently and refactoring is riskier. Adding pyright strict mode establishes a safety net and improves code quality.

---

## Requirements

- R1. Pyright strict mode is configured and runs cleanly on the codebase
- R2. Pyright runs in CI on every push/PR to main
- R3. Type annotations are added or tightened where pyright reports errors
- R4. Legitimate dynamic patterns that cannot be statically typed use targeted `# type: ignore[...]` comments with specific error codes

---

## Scope Boundaries

- Not rewriting `dict[str, Any]` patterns into typed dataclasses unless needed to satisfy pyright errors
- Not changing runtime behavior — all fixes are annotation-only or type-ignore additions
- Not adding runtime type validation (e.g., pydantic, beartype)

### Deferred to Follow-Up Work

- Tightening `Any` usage beyond what strict mode requires: separate follow-up
- Adding typed dicts or Protocol types for litellm/stream chunk shapes: separate PR

---

## Context & Research

### Relevant Code and Patterns

- `pyproject.toml` — existing project config, ruff config, dev dependencies
- `.github/workflows/lint.yml` — existing lint CI workflow to extend
- `src/orchid/domain/message.py` — well-typed example with dataclasses
- `src/orchid/llm/client.py` — heaviest `Any` usage, monkey-patching, will need most work
- `src/orchid/app.py` — Textual App subclass with dynamic patterns
- `src/orchid/config.py` — dynamic getattr/setattr patterns
- `src/orchid/agents/manager.py` — complex async callback signatures

### External References

- [Pyright configuration docs](https://microsoft.github.io/pyright/#/configuration)
- [Pyright strict mode](https://microsoft.github.io/pyright/#/configuration?id=type-check-rule-overrides)

---

## Key Technical Decisions

- **Use `pyproject.toml` `[tool.pyright]` section** rather than `pyrightconfig.json`: keeps all Python tool config in one place alongside ruff and pytest.
- **Start with `typeCheckingMode = "basic"` then escalate to `"strict"`**: fix errors incrementally rather than all at once, reducing risk of large broken diffs.
- **Use specific `# type: ignore[error-code]` comments**: avoid blanket `# type: ignore` so future errors in nearby code are still caught.
- **Add pyright to `[project.optional-dependencies] dev`**: keeps it alongside ruff and pytest as a dev tool.

---

## Implementation Units

- U1. **Add pyright configuration and dev dependency**

**Goal:** Configure pyright in strict mode and add it as a dev dependency.

**Requirements:** R1

**Dependencies:** None

**Files:**
- Modify: `pyproject.toml`

**Approach:**
- Add `pyright` to `[project.optional-dependencies] dev` list
- Add `[tool.pyright]` section with `typeCheckingMode = "strict"`, `pythonVersion = "3.11"`, `include = ["src"]`, `exclude = [".venv"]`
- Set `reportMissingImports = true`, `reportMissingTypeStubs = false` (for third-party libs without stubs)

**Patterns to follow:**
- Existing ruff/pytest config in `pyproject.toml`

**Test scenarios:**
- Happy path: `pip install -e ".[dev]"` installs pyright
- Happy path: `pyright` runs without config errors

**Verification:**
- `pyright --version` succeeds after install
- `pyright` command runs (may have type errors at this stage)

---

- U2. **Fix type errors in domain layer (`src/orchid/domain/`)**

**Goal:** Achieve clean pyright strict pass on domain dataclasses and models.

**Requirements:** R3

**Dependencies:** U1

**Files:**
- Modify: `src/orchid/domain/message.py`
- Modify: `src/orchid/domain/agent.py`
- Modify: `src/orchid/domain/tool.py`
- Modify: `src/orchid/domain/session.py`
- Modify: `src/orchid/domain/chain.py`
- Modify: `src/orchid/domain/skill.py`
- Modify: `src/orchid/domain/todo.py`

**Approach:**
- Run `pyright src/orchid/domain/` and fix errors
- Add missing return type annotations
- Replace bare `dict` with `dict[str, Any]` where needed
- Add type annotations for untyped parameters

**Test scenarios:**
- Happy path: `pyright src/orchid/domain/` reports zero errors
- Edge case: existing tests still pass (`pytest tests/`)

**Verification:**
- `pyright src/orchid/domain/` exits cleanly

---

- U3. **Fix type errors in config and storage (`config.py`, `storage.py`, `utils.py`)**

**Goal:** Achieve clean pyright strict pass on config and utility modules.

**Requirements:** R3

**Dependencies:** U1

**Files:**
- Modify: `src/orchid/config.py`
- Modify: `src/orchid/storage.py`
- Modify: `src/orchid/utils.py`

**Approach:**
- Run `pyright src/orchid/config.py src/orchid/storage.py src/orchid/utils.py` and fix errors
- Add type annotations for `_cast_value`'s `target_type` parameter
- Add proper typing for dynamic getattr/setattr patterns where feasible
- Use `# type: ignore[assignment]` for genuinely dynamic attribute access

**Test scenarios:**
- Happy path: `pyright src/orchid/config.py` reports zero errors
- Happy path: `pyright src/orchid/storage.py` reports zero errors

**Verification:**
- `pyright src/orchid/config.py src/orchid/storage.py src/orchid/utils.py` exits cleanly

---

- U4. **Fix type errors in tools layer (`src/orchid/tools/`)**

**Goal:** Achieve clean pyright strict pass on all tool implementations.

**Requirements:** R3

**Dependencies:** U1

**Files:**
- Modify: `src/orchid/tools/exec.py`
- Modify: `src/orchid/tools/search.py`
- Modify: `src/orchid/tools/file_manipulation.py`
- Modify: `src/orchid/tools/web_fetch.py`
- Modify: `src/orchid/tools/todo.py`
- Modify: `src/orchid/tools/subagent.py`
- Modify: `src/orchid/tools/skill.py`
- Modify: `src/orchid/tools/rag.py`
- Modify: `src/orchid/tools/mcp_resource.py`
- Modify: `src/orchid/tools/ast.py`
- Modify: `src/orchid/tools/_xml_utils.py`

**Approach:**
- Run `pyright src/orchid/tools/` and fix errors
- Add missing return type and parameter annotations
- Type tool function signatures precisely

**Test scenarios:**
- Happy path: `pyright src/orchid/tools/` reports zero errors

**Verification:**
- `pyright src/orchid/tools/` exits cleanly

---

- U5. **Fix type errors in LLM client (`src/orchid/llm/`)**

**Goal:** Achieve clean pyright strict pass on LLM client — the most challenging module due to litellm interop.

**Requirements:** R3, R4

**Dependencies:** U1

**Files:**
- Modify: `src/orchid/llm/client.py`
- Modify: `src/orchid/llm/providers.py`
- Modify: `src/orchid/llm/dynamic_system_prompt.py`
- Modify: `src/orchid/llm/static_system_prompt.py`

**Approach:**
- Run `pyright src/orchid/llm/` and fix errors
- For litellm interop that cannot be statically typed, use targeted `# type: ignore[arg-type]` or `# type: ignore[assignment]` with specific error codes
- Tighten callback type signatures where possible
- Add missing return type annotations

**Test scenarios:**
- Happy path: `pyright src/orchid/llm/` reports zero errors
- Integration: existing LLM tests still pass

**Verification:**
- `pyright src/orchid/llm/` exits cleanly

---

- U6. **Fix type errors in remaining modules (app, agents, mcp, ast, rag, screens, widgets, themes, commands, skills, personality)**

**Goal:** Achieve clean pyright strict pass on all remaining source modules.

**Requirements:** R3, R4

**Dependencies:** U1

**Files:**
- Modify: `src/orchid/app.py`
- Modify: `src/orchid/agents/manager.py`
- Modify: `src/orchid/mcp/__init__.py`
- Modify: `src/orchid/mcp/schema.py`
- Modify: `src/orchid/ast/*.py`
- Modify: `src/orchid/rag/*.py`
- Modify: `src/orchid/screens/*.py`
- Modify: `src/orchid/widgets/*.py`
- Modify: `src/orchid/themes/*.py`
- Modify: `src/orchid/commands/*.py`
- Modify: `src/orchid/skills/*.py`
- Modify: `src/orchid/personality/*.py`
- Modify: `src/orchid/__init__.py`
- Modify: `src/orchid/main.py`

**Approach:**
- Run `pyright src/orchid/` (full scan) and fix remaining errors
- For MCP SDK, textual, and other third-party library interop that cannot be statically typed, use targeted `# type: ignore[...]` comments
- Add missing annotations on callbacks and async functions

**Test scenarios:**
- Happy path: `pyright src/orchid/` reports zero errors
- Integration: full test suite passes (`pytest`)

**Verification:**
- `pyright src/orchid/` exits cleanly with zero errors

---

- U7. **Add pyright to CI workflow**

**Goal:** Run pyright in CI on every push/PR to main so type errors are caught before merge.

**Requirements:** R2

**Dependencies:** U6

**Files:**
- Modify: `.github/workflows/lint.yml`

**Approach:**
- Add a `pyright` job to the existing lint workflow
- Use the `jakebailey/pyright-action` GitHub Action for consistent version pinning
- Run on same triggers as ruff (push/PR to main)

**Test scenarios:**
- Happy path: CI workflow passes with pyright step
- Error path: introducing a type error causes CI to fail

**Verification:**
- `act` or manual CI run shows pyright step passing

---

## System-Wide Impact

- **Interaction graph:** No runtime behavior changes — type annotations and type-ignore comments are additive
- **Error propagation:** N/A — static analysis only
- **State lifecycle risks:** None — no runtime changes
- **API surface parity:** None
- **Integration coverage:** N/A
- **Unchanged invariants:** All existing functionality, tests, and runtime behavior remain identical

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Large number of type errors may be overwhelming to fix | Incremental approach: fix module-by-module, use type-ignore for genuinely dynamic code |
| Third-party libraries (litellm, textual, mcp) may lack type stubs | Use `reportMissingTypeStubs = false` and targeted type-ignore comments |
| Pyright version upgrades may introduce new errors | Pin pyright version in CI and dev dependencies |

---

## Sources & References

- [Pyright configuration docs](https://microsoft.github.io/pyright/#/configuration)
- Existing lint CI: `.github/workflows/lint.yml`
- Project config: `pyproject.toml`
