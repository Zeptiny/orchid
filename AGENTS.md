# Agent instructions

## Tool output contract

Agent-facing tool results use the convention documented in
`docs/tools/README.md`.

Every result is framed by one XML envelope:

```xml
<tool_result name="exact_tool_name" status="complete">
  <!-- tool-specific payload -->
</tool_result>
```

`status` is `complete`, `partial`, `empty`, `error`, or `cancelled`. XML is
the framing and metadata format; compact line-oriented text is preferred for
homogeneous lists. Use ordinary XML text and escape `&` and `<` as
`&amp;` and `&lt;`.

The compact result formats are:

- `edit`: `<old_string>`, `<new_string>`, `replace_all`, and replacement count.
  With `replace_all=false`, multiple matches are an error. With
  `replace_all=true`, every match is replaced and counted.
- `get_file_skeleton`: one `line | name | line_count` row per definition.
- `glob`: the query followed by one matching path per line.
- `grep`: the query followed by one `path | line | content` row per match.
  The first two separators are structural; the remainder is content.
- `read_directory`: an ASCII tree using `├──`, `└──`, `│`, and indentation.
  The tree starts immediately after the opening `<tree>` tag.
- `read`: one `line | content` row per source line. Do not trim, normalize,
  or re-indent the source content.
- `replace_symbol`: one `<replacement>` with `<old_string>` and
  `<new_string>` for each replaced definition.
- `send_input`: the exact input sent to stdin, including whitespace and
  newlines.

All other built-in and dynamic results still use the same XML envelope, with
tool-specific XML payloads or compact text blocks where repeating tags would
cost tokens. External or untrusted content must be escaped as text.

### MCP tool names

The `name` attribute is always the exact registered/internal tool name.
Built-in names are used as registered. MCP names use:

```text
mcp::<server_name>::<tool_name>
```

An MCP `ToolDefinition.name` is this internal name and must be present for
every dynamic tool. A provider-safe alias may be used only as the LLM
function-map key; never put that alias, `mcp`, `dynamic`, or a generic
placeholder in the result `name` attribute.
