# Renderer styling contract

Maintainer-facing contract for Orchid’s Electron renderer UI. Class selection, approved exceptions, reserved DaisyUI selectors, theme requirements, and **layout preservation** are frozen so UI work stays consistent without redesigning the product shell.

Related tests: `electron/tests/integration/renderer-style-contract.test.ts`.

## Layout preservation (non-negotiable)

Restyle **in place** only. Do **not**:

- Introduce Focused Workspace, a narrow global rail, workspace header redesign, or contextual right inspector
- Replace sidebars with drawer/overlay navigation patterns
- Redesign session tabs, chat/composer center, settings, or onboarding information architecture
- Change expand/collapse ownership or panel topology to make styling easier

Existing shell topology (left session navigation, session tabs, main chat/composer, right/context surfaces if present, overlays) stays as implemented in `App.tsx`, `ChatView.tsx`, `LeftSidebar.tsx`, `Sidebar.tsx`, and `SessionTabBar.tsx`. Only classes, shared primitives, tokens, and presentation implementation move.

## Class selection order

1. **DaisyUI component class** when the element has a matching semantic: `btn`, `input`, `select`, `textarea`, `alert`, `badge`, `status`, `loading`, `collapse`, `modal`, `tabs`, `steps`, `dropdown`, `table`, `fieldset`, `card`, `kbd`, `tooltip`, and related DaisyUI primitives.
2. **Predefined Tailwind utilities** for layout and composition: `flex`, `grid`, `min-h-0`, `gap-2`, `p-3`, `text-sm`, `w-64`, responsive variants, etc.
3. **`orchid-*` CSS composite** when the same utility/state set is shared by multiple features or encodes a product-specific surface contract. Define under `@layer components` with `@apply` and semantic tokens.
4. **Custom declarations** only for a documented exception or a CSS feature that cannot be expressed above.

Do **not** use DaisyUI `chat` / `chat-bubble` for message bodies (flat chat presentation).

## Ownership matrix (short)

| Need | Owner |
| --- | --- |
| Recognizable control/state | DaisyUI classes in JSX |
| One-off static geometry | Tailwind utilities in JSX |
| Repeated product geometry/state | `orchid-*` composite |
| Repeated interaction semantics | Typed React primitive under `components/ui/` |
| Runtime-only value | Inline style or CSS variable at the narrowest boundary |

## Required rules

- Prefer DaisyUI semantic colors (`base-100`, `primary`, `error`, …) over ad-hoc palette values in new markup.
- Prefer standard spacing, text, and radius scales over arbitrary values (`text-[10px]`, `z-[1000]`, `rounded-[5px]`).
- Keep dynamic values (grid tracks, textarea height, swatches, progress) as data via CSS variables or inline styles — not static utility classes.
- Namespace new composites with `orchid-`. Residual legacy selectors live only in `chat.css` while still consumed.
- Do not redefine reserved DaisyUI selectors in feature CSS (see below).
- Do not add CSS Modules or a second styling library for this migration.

## Reserved DaisyUI selectors

Do not introduce top-level custom rules whose subject is a DaisyUI component class (or its common modifiers such as `btn-primary`, `btn-ghost`). Reserved roots include:

`btn`, `input`, `select`, `textarea`, `alert`, `badge`, `status`, `loading`, `collapse`, `modal`, `tabs`, `tab`, `steps`, `step`, `dropdown`, `table`, `fieldset`, `card`, `kbd`, `tooltip`, `menu`, `checkbox`, `radio`, `toggle`, `range`, `progress`, `link`, `divider`, `avatar`, `navbar`, `drawer`, `hero`, `footer`, `stat`, `toast`, `file-input`, `label`, `join`, `mask`, `stack`, `skeleton`, `indicator`, `list`, `dock`, `fab`, `validator`

Product-specific names that only *start* like a DaisyUI root but are not DaisyUI (for example `.input-area`) are allowed when they are not the reserved class itself.

**U8 gate:** zero top-level reserved DaisyUI redefinitions in feature CSS. Scoped overrides (e.g. `.provider-connection-wizard .modal-box`) are allowed when they only adjust a product surface.

## Approved exception paths

| Exception | Allowed location | Treatment |
| --- | --- | --- |
| Theme variables / `color-scheme` | `themes/*.css` | DaisyUI `--color-*` plus app-specific variables still consumed by the renderer |
| Markdown / syntax highlighting | `styles/markdown.css` | Nested element/token selectors; semantic theme variables |
| Scrollbars | `styles/exceptions.css` | Browser-specific selectors; theme variables only |
| Animations / streaming cursor | `styles/exceptions.css` | Keyframes and pseudo-elements when utilities cannot express behavior |
| Runtime layout dimensions | `ChatView.tsx` + `styles/exceptions.css` `.app-frame` | Set `--orchid-shell-left` / `--orchid-shell-right` from collapse state; center track stays `minmax(460px, 1fr)`; preserve grid/panel topology |
| Runtime textarea height | `InputArea.tsx` + `.composer-textarea` in exceptions | Keep resize behavior; do not encode generated pixel heights as static utilities |
| Runtime swatches / progress | `ContextGrid.tsx`, `Footer.tsx`, `CommandPalette.tsx` | Dynamic colors/fractions as data; classes for surrounding geometry |
| Focus / modal browser quirks | focused exception selectors | Only after smoke proves utilities/DaisyUI insufficient |
| Residual product CSS | `styles/chat.css` | Unmigrated shell/onboarding/palette/config selectors still consumed by JSX; shrink further when dual-class consumers drop legacy names |

Every exception needs a short comment or a row in this table explaining why a predefined class cannot replace it.

### Approved dynamic style components

These files may use inline `style={...}` for runtime values without that usage counting as a static class violation:

- `components/ChatView.tsx`
- `components/InputArea.tsx`
- `components/ContextGrid.tsx`
- `components/Footer.tsx`
- `components/CommandPalette.tsx`
- `components/Preferences/ScopeToggle.tsx`
- `components/ToolWidgets/LiveCommandInline.tsx`

Static `className` strings in those files still must not introduce arbitrary utilities outside the approved list (currently empty).

### Approved static arbitrary utilities

**None.** After U8, static `className` strings must use predefined Tailwind utilities only. Prefer `text-xs`, `z-50`, `rounded-md`, `gap-px`, `max-h-96`, `max-w-xl`, etc. If exact geometry is behavior-critical, use an `orchid-*` composite or a dynamic CSS variable exception.

## Themes

These five themes must remain selectable, loadable, and coherent via the existing runtime stylesheet swap (`applyTheme()` / `data-theme`):

- `default`
- `solarized-light`
- `bluey`
- `windows-xp`
- `green-terminal`

Do not replace the runtime theme loader with compile-time-only DaisyUI theme blocks in this migration’s first pass.

## Stylesheet layout

| File | Role |
| --- | --- |
| `index.css` | **Canonical entry** (imported from `main.tsx`): Tailwind, DaisyUI plugin, document/root rules, layer imports |
| `components.css` | `@layer components` `orchid-*` composites with `@apply` + semantic/theme tokens (dual-named with legacy aliases where still needed) |
| `markdown.css` | Markdown / GFM / highlight tokens |
| `exceptions.css` | Scrollbars, keyframes, streaming cursor, shell grid tracks, composer height hooks |
| `chat.css` | Residual compatibility bridge: command palette, onboarding/provider wizard, shell panels/session/config/shortcuts not fully dual-class only yet |
| `README.md` | This contract |

### Import graph

```text
main.tsx
  └── styles/index.css
        ├── tailwindcss + daisyui plugin
        ├── components.css
        ├── markdown.css
        ├── exceptions.css
        └── chat.css          ← residual bridge only
```

Runtime themes are **not** part of this graph: `applyTheme()` swaps a single `#orchid-theme` stylesheet link (`themes/*.css`) and sets `document.documentElement.dataset.theme`.

### Residual bridge (`chat.css`)

- Dead pre-migration legacy blocks (old `.message-*`, `.app-layout`, `.sidebar-*`, `.footer` layout, unused onboarding substeps without consumers) were removed in U8.
- Migrated dual-class rules already owned by `components.css` were removed from the bridge.
- Remaining rules still have JSX consumers (shell panels, session chrome, config/onboarding, command palette chrome, pickers, shortcuts help).
- **Do not add new rules** to `chat.css`. New composites → `components.css`; markdown → `markdown.css`; browser exceptions → `exceptions.css`.

### Known reserved redefinitions

**None** after U8. Product lists use plain lists / PopoverList / custom menus rather than DaisyUI `menu`. Buttons are DaisyUI `btn` in JSX, not custom `.btn` CSS.

## Arbitrary utilities

Static class strings (from `className` / `class` attributes and class-like string/template literals inside those attributes) must not introduce Tailwind arbitrary values (tokens matching `utility-[...]`, including variants like `sm:grid-cols-[...]`).

- **Approved**: intentional long-lived exceptions go in `APPROVED_ARBITRARY_UTILITIES` (currently empty) and must be documented here.
- **Not scanned**: TypeScript arrays, generics, indexed access (`tierModels[tier.id]`), and `${...}` interiors of class templates — the scanner is class-bearing only.

## How to add UI safely

### Example 1 — DaisyUI component

```tsx
<button type="button" className="btn btn-primary btn-sm">Save</button>
```

### Example 2 — Tailwind utilities (one-off layout)

```tsx
<div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
  <p className="truncate text-sm text-base-content/70">{label}</p>
</div>
```

### Example 3 — `orchid-*` composite (repeated product surface)

In `components.css`:

```css
@layer components {
  .orchid-chat-footer {
    @apply flex shrink-0 items-center justify-between gap-2.5 border-t border-base-content/10 px-3 py-1 text-xs;
  }
}
```

In JSX: `className="orchid-chat-footer chat-footer"` (dual name only while a legacy alias remains useful).

### Example 4 — Dynamic exception

```tsx
<div
  className="app-frame"
  style={{
    ['--orchid-shell-left' as string]: leftCollapsed ? '56px' : '260px',
    ['--orchid-shell-right' as string]: rightCollapsed ? '48px' : '300px',
  }}
/>
```

Document the path under **Approved dynamic style components** and keep static geometry in classes.

### Checklist

1. Prefer DaisyUI + predefined Tailwind in the feature JSX.
2. If the same pattern appears twice (or encodes shared behavior), extract a small primitive or `orchid-*` composite.
3. If you need a dynamic pixel/color/fraction, put it in an approved exception path as a CSS variable or inline style.
4. Run `npm test -- tests/integration/renderer-style-contract.test.ts` from `electron/`.
5. Never “fix” styling by redesigning shell layout.
