---
title: TUI Configuration Management
type: feat
status: plan
created: 2026-06-19
---

# TUI Configuration Management

## Problem

Configuration (providers, MCP servers, models, tier models, RAG, defaults) is only editable by hand-editing JSON. Invalid config silently falls back to defaults with a log warning — users never know their settings were rejected. No in-app mechanism to view or edit config.

## Requirements

- **R1 — Nested RAG config:** Flat `rag_max_file_size`, `rag_top_k`, etc. become a nested `rag { max_file_size, top_k, ... }` module
- **R2 — Hard validation failure:** Invalid config at startup exits with clear CLI error messages listing every broken field
- **R3 — Settings screen:** Full-screen modal with tabs at the top for each config category
- **R4 — In-app editing:** Users can view, add, edit, and remove providers, MCP servers, and tier model assignments
- **R5 — Save persistence:** Changes persist to the config file on disk

## Scope

**In scope:** Config model restructuring (nested RAG, backward compat), hard validation failure at startup, full-screen settings modal with tabbed navigation, CRUD for providers/MCP/tier-models, edit form for RAG/general defaults, persistence, `/settings` command

**Out of scope:** Live MCP server restart on config change, provider credential validation, theme/personality live switching, config profiles, import/export

## Architecture & Key Decisions

### D1. Config model hierarchy

`Config` dataclass gets a `rag: RAGConfig` nested field. No backward compat — any old flat-format configs will fail validation with a clear error message telling the user to update.

```python
@dataclass
class RAGConfig:
    chunk_size: int = 4096
    chunk_overlap: int = 200
    top_k: int = 10
    max_file_size: int = 10 * 1024 * 1024

@dataclass
class Config:
    rag: RAGConfig = field(default_factory=RAGConfig)
    # ... other fields unchanged
```

### D2. Validation — result type, not side effects

Replace in-place `_validate_config()` mutation with `validate_config(config: Config) -> list[str]`. Called at startup before app construction. Errors printed to stderr with exit(1).

### D3. Settings screen — Screen subclass

Full-screen modal (following `OptionPicker` pattern in `app_config.py`):
- Tab bar at top using textual `Tabs`
- Content area below rendering selected tab's form/list
- Save / Cancel footer buttons
- Opens via `/settings` command

### D4. Persistence

Modal works on a copy of config. On Save: validate → if invalid, show inline errors → if valid, `ConfigManager.save()` + `session.reload_config()`.

## Implementation Units

### U1. Config model: nested RAG, backward compat

**Goal:** Restructure `Config` to use `RAGConfig` nested dataclass with backward compat.

**Files:** `src/stupidex/config.py`, `tests/test_ast_config.py`

**Approach:**
1. Define `RAGConfig` dataclass with current flat field defaults
2. Replace flat fields in `Config` with `Config.rag: RAGConfig`
3. In `from_dict()`, detect flat fields and construct `RAGConfig` from them
4. In `to_dict()`, always emit nested form
5. Update all `config.rag_chunk_size` → `config.rag.chunk_size` across codebase

**Test scenarios:**
- New nested `rag { }` deserializes correctly
- Old flat `rag_chunk_size, rag_top_k` deserializes correctly
- Mixed (both) — nested wins
- Serialization always produces nested form

### U2. Validation: hard failure at startup

**Goal:** Replace silent `log.warning()` with return-as-errors. Exit(1) at startup if invalid.

**Files:** `src/stupidex/config.py`, `src/stupidex/main.py`, `tests/test_ast_config.py`

**Approach:**
1. Write `validate_config(cfg: Config) -> list[str]` checking each field
2. `ConfigManager.load()` calls validate, stores errors
3. In `main.py`, check errors → print to stderr → exit(1)
4. Only hard-fail on truly broken config (missing required keys, type mismatches). Missing optionals get defaults.

**Test scenarios:**
- Valid config → empty list
- Missing provider `name` → specific error
- Missing MCP `command` → specific error
- Bad `default_model` reference → error
- Negative `rag_chunk_size` → error
- Multiple errors all reported

### U3. Settings screen: shell and tabbed framework

**Goal:** Create `SettingsScreen` full-screen modal, `/settings` command, keybinding.

**Files:** `src/stupidex/app_config.py`, `src/stupidex/commands.py`, `src/stupidex/main.py`, `tests/test_session_commands.py`

**Approach:**
1. `SettingsScreen(ModalScreen[Config])` following `OptionPicker` pattern
2. Tab bar using textual `Tabs` widget
3. Content area switches on tab selection
4. Footer with Save/Cancel buttons
5. Cancel returns `None`, Save returns modified `Config`
6. Takes current `Config` as constructor arg
7. `/settings` command in `commands.py`

**Test scenarios:**
- `/settings` opens modal
- Escape closes without save
- Tab navigation switches content
- All 5 tabs present

### U4. Settings screen: Providers tab

**Goal:** Tab for listing, adding, editing, removing providers.

**Files:** `src/stupidex/app_config.py`

**Approach:**
1. List of configured providers as rows (name + model + status)
2. Add/Edit/Remove buttons below
3. Add/Edit opens form modal with fields: name, api_key (masked), model, base_url, provider type
4. Remove prompts confirmation

**Test scenarios:**
- List shows configured providers
- Add appends to list
- Edit changes fields
- Remove deletes after confirmation

### U5. Settings screen: MCP Servers tab

**Goal:** Tab for listing, adding, editing, removing MCP servers.

**Files:** `src/stupidex/app_config.py`

**Approach:**
1. List of MCP servers with name, command, status
2. Add/Edit/Remove buttons
3. Add/Edit form: name, command, args (comma-separated), env (key=value), timeout

**Test scenarios:**
- List shows existing MCP servers
- Add creates valid MCPConfig entry
- Required field validation (name, command required)
- Remove shows confirmation

### U6. Settings screen: Tier Models tab

**Goal:** Tab for mapping each tier to a model.

**Files:** `src/stupidex/app_config.py`

**Approach:**
1. Each tier (tolo, tainha, papudo, papaca) as a row with text input for model name
2. Optionally, a picker listing available models

**Test scenarios:**
- All 4 tiers shown
- Editing changes the value
- Empty model shows validation

### U7. Settings screen: RAG tab

**Goal:** Tab for editing RAG settings.

**Files:** `src/stupidex/app_config.py`

**Approach:**
1. Form with labeled integer inputs for chunk_size, chunk_overlap, top_k, max_file_size
2. Validation: positive ints, sane ranges
3. Live feedback

**Test scenarios:**
- All 4 fields shown with current values
- Invalid values show error
- Valid values accepted

### U8. Settings screen: General tab

**Goal:** Tab for editing defaults (default_model, theme, personality).

**Files:** `src/stupidex/app_config.py`

**Approach:**
1. Fields: default_model (text/picker), theme (select), personality (select)
2. Theme/personality open sub-picker or inline select

**Test scenarios:**
- All 3 fields shown with current values
- Theme picker shows available themes
- Personality picker shows available personalities

### U9. Config persistence: Save flow

**Goal:** On Save, validate, write to disk, reload session config.

**Files:** `src/stupidex/config.py`, `src/stupidex/session.py`, `src/stupidex/app_config.py`

**Approach:**
1. `ConfigManager.save(config)` serializes JSON to active config file path
2. On Save: collect modified config → validate → if invalid, show inline errors → if valid, `save() + reload_config()`
3. `session.reload_config()` updates `session.config`, re-initializes providers/MCP

**Test scenarios:**
- Valid config writes to disk correctly
- Invalid config shows inline errors, doesn't save
- After save, session has new values

### U10. Integration wiring

**Goal:** Wire startup gate, command registration, session integration.

**Files:** `src/stupidex/main.py`, `src/stupidex/commands.py`, `src/stupidex/session.py`, `tests/test_ast_config.py`

**Approach:**
1. `main.py`: after `ConfigManager.load()` → if errors, print to stderr and exit(1)
2. Register `/settings` command → `app.push_screen(SettingsScreen(...))`
3. `session.reload_config()` updates `self.config` and re-inits providers

**Test scenarios:**
- Invalid config → non-zero exit + error messages on stderr
- Valid config → normal start
- `/settings` command registered

## Risks

1. **Backward compat complexity** — flat→nested RAG transition could break existing configs. Mitigation: thorough backward-compat tests and clear migration error messages.
2. **MCP live reload** — risky. Plan does NOT attempt it; user is told to restart.
3. **Settings screen complexity** — most complex TUI widget in app. Mitigation: each tab independently testable, tab framework is simple.

## Dependencies

None — all TUI patterns (OptionPicker, InputModal, Screen, notify) exist in the codebase.

## Deferred to Implementation

- Exact keyboard navigation scheme within form fields
- Whether to use textual `Tabs` or manual tab switching
- Exact form field widget choice (textual `Input` vs custom)
- Confirmation dialog style for destructive actions
