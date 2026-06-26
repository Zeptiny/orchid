import asyncio
import difflib
import logging
import os
import stat
import tempfile
from collections.abc import Awaitable, Callable
from pathlib import Path
from xml.sax.saxutils import escape

import tree_sitter

from stupidex.ast.indexer import ensure_indexed
from stupidex.ast.parser import lang_for_extension, load_query_file, parse_file, run_query
from stupidex.ast.store import ASTStore
from stupidex.domain.tool import ExecutorResult, Tool, ToolParameter, ToolParameterProperties
from stupidex.tools._xml_utils import _cdata_text, _count_diff_changes, _xml_attr

logger = logging.getLogger(__name__)

# Session-level hash tracking for get_function change detection (R15).
# Keyed by "{file_path}:{function_name}", values are FNV-1a hashes.
# NOT pre-populated by the indexer — only fires after the agent has received content.
_get_function_sent_hashes: dict[str, str] = {}

# Post-write callbacks registered by the AST indexer.
# edit and write tools call each callback after a successful file write.
post_write_callbacks: list[Callable[[str], Awaitable[None]]] = []

# Register the indexer's update_file so edit/write tools keep the AST store in sync.
from stupidex.ast.indexer import update_file  # noqa: E402

post_write_callbacks.append(update_file)

# FNV-1a constants (64-bit)
_FNV_OFFSET = 14695981039346656037
_FNV_PRIME = 1099511628211

# Language-specific import queries for get_function context resolution
_IMPORT_QUERIES = {
    "python": """
(import_statement) @import
(import_from_statement) @import
""",
    "javascript": """
(import_statement) @import
""",
    "typescript": """
(import_statement) @import
""",
}


def _fnv1a(text: str) -> str:
    h = _FNV_OFFSET
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * _FNV_PRIME) & 0xFFFFFFFFFFFFFFFF
    return format(h, "016x")


def _extract_call_names(
    node: tree_sitter.Node, content_bytes: bytes
) -> list[str]:
    """Walk *node*'s subtree and collect short names of call expressions."""
    calls: list[str] = []
    _walk_for_calls(node, calls, content_bytes)
    seen: set[str] = set()
    result: list[str] = []
    for c in calls:
        if c not in seen:
            seen.add(c)
            result.append(c)
    return result


def _walk_for_calls(
    node: tree_sitter.Node, out: list[str], content_bytes: bytes
) -> None:
    if node.type in ("call", "call_expression"):
        callee = node.child_by_field_name("function")
        if callee is None and node.children:
            callee = node.children[0]
        if callee is not None:
            name = content_bytes[callee.start_byte : callee.end_byte].decode(
                "utf-8", errors="replace"
            )
            # Use the short name: last part after '.' for attribute/member.
            if "." in name:
                name = name.rsplit(".", 1)[-1]
            if name:
                out.append(name)
    for child in node.children:
        _walk_for_calls(child, out, content_bytes)


def _generate_diff(old: str, new: str, path: str) -> str:
    diff = difflib.unified_diff(
        old.splitlines(keepends=True),
        new.splitlines(keepends=True),
        fromfile=f"old/{path}",
        tofile=f"new/{path}",
        lineterm="",
    )
    return "\n".join(diff)


def _format_edit_result(
    file_path: str,
    *,
    success: bool,
    replacements: int,
    added: int,
    removed: int,
    diff_text: str = "",
    error: str | None = None,
    message: str | None = None,
    replace_all: bool = False,
) -> str:
    attrs = [
        f'path="{_xml_attr(file_path)}"',
        f'success="{str(success).lower()}"',
        f'replacements="{replacements}"',
        f'replace_all="{str(replace_all).lower()}"',
        f'added="{added}"',
        f'removed="{removed}"',
    ]
    if error:
        attrs.append(f'error="{_xml_attr(error)}"')

    lines = [f"<edit_result {' '.join(attrs)}>"]
    if message:
        lines.extend(["<message><![CDATA[", _cdata_text(message), "]]></message>"])
    if diff_text:
        lines.extend(['<diff format="unified"><![CDATA[', _cdata_text(diff_text), "]]></diff>"])
    else:
        lines.append('<diff format="unified" />')
    lines.append("</edit_result>")
    return "\n".join(lines)


def _find_extended_range(
    content_bytes: bytes, node: tree_sitter.Node
) -> tuple[int, int]:
    """Extend the node's range backward to include preceding decorators/comments."""
    start = node.start_byte
    text_before = content_bytes[:start].decode("utf-8", errors="replace")
    lines_before = text_before.split("\n")

    # Compute the indentation level of the node's first line.
    node_line_idx = node.start_point[0]
    all_lines = content_bytes.decode("utf-8", errors="replace").split("\n")
    node_line_text = all_lines[node_line_idx] if node_line_idx < len(all_lines) else ""
    node_indent = len(node_line_text) - len(node_line_text.lstrip())

    check_lines = 0
    in_block_comment = False
    for line in reversed(lines_before[:-1] if len(lines_before) > 1 else []):
        stripped = line.strip()
        if not stripped:
            break

        # If we're inside a block comment, keep including middle/end lines.
        if in_block_comment:
            if stripped.startswith("/*") or stripped.startswith("/**"):
                check_lines += 1
                in_block_comment = False
                continue
            if stripped.startswith("*") or stripped.startswith("*/"):
                check_lines += 1
                continue
            break

        is_decorator = stripped.startswith("@")
        is_comment = stripped.startswith("#") or stripped.startswith("//")
        is_docstring = stripped.startswith('"""') or stripped.startswith("'''")
        is_export = stripped.startswith("export ")
        is_multiline_end = stripped.endswith("*/")
        if is_decorator or is_comment or is_docstring or is_export or is_multiline_end:
            check_lines += 1
            if is_multiline_end:
                in_block_comment = True
        else:
            # Stop if this line is at a lower indentation (e.g. class definition).
            line_indent = len(line) - len(line.lstrip())
            if line_indent < node_indent:
                break
            break

    if check_lines > 0:
        preceding = "\n".join(lines_before[-check_lines - 1:-1]) if check_lines < len(lines_before) else ""
        start = start - len(preceding.encode("utf-8")) - 1  # -1 for the newline

    return start, node.end_byte


def _atomic_write(file_path: str, content: str) -> None:
    """Write content atomically: tmp + fsync + os.replace."""
    # Preserve original file permissions.
    try:
        orig_mode = os.stat(file_path).st_mode
    except OSError:
        orig_mode = None

    fd, tmp_path = tempfile.mkstemp(
        dir=str(Path(file_path).parent),
        prefix=".ast_edit_",
        suffix=".tmp",
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, file_path)
        if orig_mode is not None:
            os.chmod(file_path, stat.S_IMODE(orig_mode))
        dir_fd = os.open(str(Path(file_path).parent), os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except BaseException:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


atomic_write = _atomic_write


async def _trigger_post_write_callbacks(file_path: str) -> list[str]:
    """Run all post-write callbacks and return a list of failure messages."""
    failures: list[str] = []
    for cb in post_write_callbacks:
        try:
            await cb(file_path)
        except Exception as e:
            logger.warning("Post-write callback failed for %s: %s", file_path, e)
            failures.append(f"{cb.__name__}: {e}")
    return failures


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

get_file_skeleton_tool = Tool(
    name="get_file_skeleton",
    description=(
        "Get a structural outline of a source file showing only definition lines "
        "(functions, classes, methods) without reading the entire file. Use this "
        "to understand a file's structure before reading specific functions. "
        "Returns definition names with line numbers and visual separators."
    ),
    parameters=ToolParameter(
        properties={
            "file_path": ToolParameterProperties(
                type="string",
                description="Path to the source file, relative to cwd",
            ),
        },
        required=["file_path"],
    ),
    action_label="Getting skeleton...",
)

get_function_tool = Tool(
    name="get_function",
    description=(
        "Extract specific function(s) by name from a source file, including "
        "relevant imports and parent class context. Use this instead of reading "
        "an entire file when you only need one or two functions. Reports "
        '"no changes" if the function body has not changed since last retrieval.'
    ),
    parameters=ToolParameter(
        properties={
            "file_path": ToolParameterProperties(
                type="string",
                description="Path to the source file, relative to cwd",
            ),
            "function_names": ToolParameterProperties(
                type="string",
                description="Comma-separated function names to extract",
            ),
        },
        required=["file_path", "function_names"],
    ),
    action_label="Extracting function...",
)

find_symbol_references_tool = Tool(
    name="find_symbol_references",
    description=(
        "Find all definitions and references of a symbol by name across the project. "
        "Use this to understand where a symbol is defined and used before renaming "
        "or refactoring. Returns file paths with line/column ranges."
    ),
    parameters=ToolParameter(
        properties={
            "name": ToolParameterProperties(
                type="string",
                description="The symbol name to search for",
            ),
            "type_filter": ToolParameterProperties(
                type="string",
                description='Filter by symbol type: "definition", "reference", or "both" (default: "both")',
            ),
        },
        required=["name"],
    ),
    action_label="Finding references...",
)

replace_symbol_tool = Tool(
    name="replace_symbol",
    description=(
        "Replace an entire symbol definition (function, class, method) including "
        "its docstring, decorators, and comments. Use this instead of the edit tool "
        "for replacing whole functions — it handles the full range automatically "
        "and supports multiple replacements in one call with correct offsets."
    ),
    parameters=ToolParameter(
        properties={
            "file_path": ToolParameterProperties(
                type="string",
                description="Path to the source file",
            ),
            "name": ToolParameterProperties(
                type="string",
                description="The symbol name to replace",
            ),
            "new_text": ToolParameterProperties(
                type="string",
                description="The complete replacement text for the symbol definition",
            ),
        },
        required=["file_path", "name", "new_text"],
    ),
    action_label="Replacing symbol...",
)

rename_symbol_tool = Tool(
    name="rename_symbol",
    description=(
        "Rename a symbol across all files in one call. Updates all definitions "
        "and references atomically per file. Use this instead of multiple edit "
        "calls for cross-file renames."
    ),
    parameters=ToolParameter(
        properties={
            "name": ToolParameterProperties(
                type="string",
                description="The current symbol name",
            ),
            "new_name": ToolParameterProperties(
                type="string",
                description="The new symbol name",
            ),
        },
        required=["name", "new_name"],
    ),
    action_label="Renaming symbol...",
)


# ---------------------------------------------------------------------------
# Executors
# ---------------------------------------------------------------------------


async def execute_get_file_skeleton(file_path: str) -> ExecutorResult:
    try:
        filepath = Path(file_path)
        if not filepath.exists():
            return ExecutorResult(
                display=f"File not found: {file_path}",
                content=f'<ast_error tool="get_file_skeleton" file="{_xml_attr(file_path)}">'
                f"File not found: {escape(file_path)}</ast_error>",
            )

        lang_name = lang_for_extension(file_path)
        content = filepath.read_text(encoding="utf-8", errors="replace")
        query_text = load_query_file(lang_name)
        tree = parse_file(file_path, content)
        captures = run_query(tree, lang_name, query_text, content)

        content_bytes = content.encode("utf-8")
        definitions = []
        for cap_name, results in captures.items():
            if cap_name.startswith("name.definition."):
                for r in results:
                    parent_node = r.node.parent
                    definitions.append((r.start_line, r.text, parent_node))

        if not definitions:
            return ExecutorResult(
                display=f"No definitions in {file_path}",
                content=f'<file_skeleton file="{_xml_attr(file_path)}" definitions="0">\n'
                "No definitions found.\n</file_skeleton>",
            )

        definitions.sort(key=lambda x: x[0])

        lines_buf = []
        lines_buf.append(
            f'<file_skeleton file="{_xml_attr(file_path)}" definitions="{len(definitions)}">'
        )
        prev_line = None
        for line_num, name, parent_node in definitions:
            if prev_line is not None and line_num > prev_line + 1:
                lines_buf.append("  |----")

            line_count = ""
            calls_str = ""
            if parent_node is not None:
                end_line_num = parent_node.end_point[0] + 1
                line_count = end_line_num - (line_num + 1)
                calls = _extract_call_names(parent_node, content_bytes)
                # Exclude self-recursion from call list.
                calls = [c for c in calls if c != name]
                if calls:
                    calls_str = f"  # Calls: [{', '.join(calls)}]"
                lines_buf.append(
                    f"  {line_num + 1:>4} │ {name}"
                    f"{calls_str}"
                    f"  # Lines: {line_count}"
                )
            else:
                lines_buf.append(f"  {line_num + 1:>4} │ {name}")

            prev_line = line_num
        lines_buf.append("</file_skeleton>")

        return ExecutorResult(
            display=f"Skeleton of {file_path}: {len(definitions)} definitions",
            content="\n".join(lines_buf),
        )

    except ValueError as e:
        return ExecutorResult(
            display=f"Unsupported file type: {file_path}",
            content=f'<ast_error tool="get_file_skeleton" file="{_xml_attr(file_path)}">'
            f"{escape(str(e))}</ast_error>",
        )
    except Exception as e:
        logger.warning("get_file_skeleton error: %s", e)
        return ExecutorResult(
            display=f"Error: {file_path}",
            content=f'<ast_error tool="get_file_skeleton" file="{_xml_attr(file_path)}">'
            f"{escape(str(e))}</ast_error>",
        )


async def execute_get_function(
    file_path: str, function_names: str
) -> ExecutorResult:
    try:
        filepath = Path(file_path)
        if not filepath.exists():
            return ExecutorResult(
                display=f"File not found: {file_path}",
                content=f'<ast_error tool="get_function" file="{_xml_attr(file_path)}">'
                f"File not found: {escape(file_path)}</ast_error>",
            )

        names = [n.strip() for n in function_names.split(",") if n.strip()]
        if not names:
            return ExecutorResult(
                display="No function names provided",
                content='<ast_error tool="get_function">'
                "No valid function names provided.</ast_error>",
            )

        content = filepath.read_text(encoding="utf-8", errors="replace")
        lang_name = lang_for_extension(file_path)
        query_text = load_query_file(lang_name)
        tree = parse_file(file_path, content)
        captures = run_query(tree, lang_name, query_text, content)

        import_query = _IMPORT_QUERIES.get(lang_name, "")
        imports_text = ""
        if import_query:
            import_captures = run_query(tree, lang_name, import_query, content)
            import_results = import_captures.get("import", [])
            if import_results:
                imports_text = "\n".join(r.text for r in import_results)

        name_caps = captures.get("name.definition.function", [])
        method_caps = captures.get("name.definition.method", [])

        found_functions = []
        for target_name in names:
            matched = False
            for r in name_caps + method_caps:
                if r.text != target_name:
                    continue
                if r.node.parent is None:
                    continue
                func_node = r.node.parent
                if func_node.type not in (
                    "function_definition",
                    "function_declaration",
                    "method_definition",
                ):
                    parent = func_node.parent
                    if parent and parent.type in (
                        "function_definition",
                        "function_declaration",
                        "method_definition",
                    ):
                        func_node = parent
                    else:
                        continue

                class_text = ""
                p = func_node.parent
                while p is not None:
                    if p.type in ("class_definition", "class_declaration"):
                        body_node = p.child_by_field_name("body")
                        end_byte = body_node.start_byte if body_node is not None else p.end_byte
                        class_text = content.encode("utf-8")[
                            p.start_byte : end_byte
                        ].decode("utf-8", errors="replace")
                        break
                    p = p.parent

                func_text = content.encode("utf-8")[
                    func_node.start_byte : func_node.end_byte
                ].decode("utf-8", errors="replace")

                hash_key = f"{file_path}:{target_name}:{class_text}"
                current_hash = _fnv1a(func_text)
                last_hash = _get_function_sent_hashes.get(hash_key)

                start_line = func_node.start_point[0] + 1
                end_line = func_node.end_point[0] + 1

                if last_hash is not None and last_hash == current_hash:
                    found_functions.append(
                        f'<function name="{_xml_attr(target_name)}" '
                        f'file="{_xml_attr(file_path)}" '
                        f'start_line="{start_line}" end_line="{end_line}">\n'
                        "No changes have been made since last retrieval.\n</function>"
                    )
                else:
                    parts = []
                    parts.append(
                        f'<function name="{_xml_attr(target_name)}" '
                        f'file="{_xml_attr(file_path)}" '
                        f'start_line="{start_line}" end_line="{end_line}">'
                    )
                    if imports_text:
                        parts.append("<imports>")
                        parts.append(escape(imports_text))
                        parts.append("</imports>")
                    if class_text:
                        parts.append("<class_context>")
                        parts.append(escape(class_text))
                        parts.append("</class_context>")
                    parts.append("<body>")
                    parts.append(escape(func_text))
                    parts.append("</body>")
                    parts.append("</function>")
                    found_functions.append("\n".join(parts))
                    _get_function_sent_hashes[hash_key] = current_hash

                matched = True

            if not matched:
                found_functions.append(
                    f'<function name="{_xml_attr(target_name)}" '
                    f'file="{_xml_attr(file_path)}" status="not_found">\n'
                    f"Function '{escape(target_name)}' not found.\n</function>"
                )

        content_xml = (
            f'<functions file="{_xml_attr(file_path)}" count="{len(found_functions)}">\n'
            + "\n".join(found_functions)
            + "\n</functions>"
        )

        return ExecutorResult(
            display=f"Extracted {len(found_functions)} function(s) from {file_path}",
            content=content_xml,
        )

    except ValueError as e:
        return ExecutorResult(
            display=f"Unsupported file type: {file_path}",
            content=f'<ast_error tool="get_function" file="{_xml_attr(file_path)}">'
            f"{escape(str(e))}</ast_error>",
        )
    except Exception as e:
        logger.warning("get_function error: %s", e)
        return ExecutorResult(
            display=f"Error: {file_path}",
            content=f'<ast_error tool="get_function" file="{_xml_attr(file_path)}">'
            f"{escape(str(e))}</ast_error>",
        )


async def execute_find_symbol_references(
    name: str, type_filter: str = "both"
) -> ExecutorResult:
    try:
        if not name or not name.strip():
            return ExecutorResult(
                display="Empty symbol name",
                content='<ast_error tool="find_symbol_references">'
                "Symbol name is required.</ast_error>",
            )

        if type_filter not in ("both", "definition", "reference"):
            return ExecutorResult(
                display="Invalid type_filter",
                content=f'<ast_error tool="find_symbol_references">'
                f'Invalid type_filter "{escape(type_filter)}". '
                f"Must be: definition, reference, or both.</ast_error>",
            )

        await ensure_indexed()

        loop = asyncio.get_running_loop()
        project_path = str(Path.cwd())
        store = ASTStore(project_path)

        symbols = await loop.run_in_executor(
            None, store.get_symbols_by_name, name, type_filter
        )

        if not symbols:
            return ExecutorResult(
                display=f"No references for '{name}'",
                content=f'<symbol_references name="{_xml_attr(name)}" count="0" />',
            )

        e = escape
        parts = []
        for s in symbols:
            parts.append(
                f'  <symbol name="{_xml_attr(s["name"])}" '
                f'type="{s["type"]}" '
                f'kind="{s["kind"]}" '
                f'file="{_xml_attr(s["file_path"])}" '
                f'start_line="{s["start_line"] + 1}" '
                f'start_column="{s["start_column"]}" '
                f'end_line="{s["end_line"] + 1}" '
                f'end_column="{s["end_column"]}" />'
            )

        result_xml = (
            f'<symbol_references name="{_xml_attr(name)}" '
            f'type_filter="{type_filter}" count="{len(symbols)}">\n'
            + "\n".join(parts)
            + "\n</symbol_references>"
        )

        defs = sum(1 for s in symbols if s["type"] == "definition")
        refs = sum(1 for s in symbols if s["type"] == "reference")
        return ExecutorResult(
            display=f"Found {defs} definition(s), {refs} reference(s) for '{name}'",
            content=result_xml,
        )

    except Exception as e:
        logger.warning("find_symbol_references error: %s", e)
        return ExecutorResult(
            display=f"Error finding '{name}'",
            content=f'<ast_error tool="find_symbol_references">'
            f"{escape(str(e))}</ast_error>",
        )


async def execute_replace_symbol(
    file_path: str, name: str, new_text: str
) -> ExecutorResult:
    try:
        filepath = Path(file_path)
        if not filepath.exists():
            return ExecutorResult(
                display=f"File not found: {file_path}",
                content=_format_edit_result(
                    file_path,
                    success=False,
                    replacements=0,
                    added=0,
                    removed=0,
                    error="file_not_found",
                    message=f"File not found: {file_path}",
                ),
            )

        content = filepath.read_text(encoding="utf-8", errors="replace")
        content_bytes = content.encode("utf-8")
        lang_name = lang_for_extension(file_path)
        query_text = load_query_file(lang_name)
        tree = parse_file(file_path, content)
        captures = run_query(tree, lang_name, query_text, content)

        name_caps = captures.get("name.definition.function", [])
        method_caps = captures.get("name.definition.method", [])
        class_caps = captures.get("name.definition.class", [])

        target_caps = [r for r in name_caps + method_caps + class_caps if r.text == name]

        if not target_caps:
            return ExecutorResult(
                display=f"Symbol '{name}' not found in {file_path}",
                content=_format_edit_result(
                    file_path,
                    success=False,
                    replacements=0,
                    added=0,
                    removed=0,
                    error="symbol_not_found",
                    message=f"Symbol '{name}' not found in {file_path}",
                ),
            )

        replacements_list = []
        parent_contexts: list[str] = []
        for r in target_caps:
            if r.node.parent is None:
                continue
            parent = r.node.parent
            if parent.type in (
                "function_definition",
                "function_declaration",
                "method_definition",
                "class_definition",
                "class_declaration",
            ):
                definition_node = parent
            else:
                grandparent = parent.parent
                if grandparent and grandparent.type in (
                    "function_definition",
                    "function_declaration",
                    "method_definition",
                    "class_definition",
                    "class_declaration",
                ):
                    definition_node = grandparent
                else:
                    continue

            # Determine parent class context for disambiguation.
            ctx_name = "<module>"
            p = definition_node.parent
            while p is not None:
                if p.type in ("class_definition", "class_declaration"):
                    # Find the class name node.
                    name_node = p.child_by_field_name("name")
                    if name_node is not None:
                        ctx_name = content.encode("utf-8")[
                            name_node.start_byte : name_node.end_byte
                        ].decode("utf-8", errors="replace")
                    break
                p = p.parent

            start, end = _find_extended_range(content_bytes, definition_node)
            replacements_list.append((start, end))
            parent_contexts.append(ctx_name)

        if not replacements_list:
            return ExecutorResult(
                display=f"Symbol '{name}' not found in {file_path}",
                content=_format_edit_result(
                    file_path,
                    success=False,
                    replacements=0,
                    added=0,
                    removed=0,
                    error="symbol_not_found",
                    message=f"Symbol '{name}' not found in {file_path}",
                ),
            )

        # P1 #8: If multiple definitions exist in different parent contexts,
        # ask the user to disambiguate rather than silently replacing all.
        unique_contexts = set(parent_contexts)
        if len(replacements_list) > 1 and len(unique_contexts) > 1:
            locations = []
            for ctx, (_, end) in zip(parent_contexts, replacements_list, strict=False):
                # Compute line number from byte offset.
                line_num = content_bytes[:end].count(b"\n") + 1
                locations.append(f"  - {ctx} (line {line_num})")
            ctx_list = "\n".join(locations)
            return ExecutorResult(
                display=f"Multiple '{name}' definitions found — disambiguate",
                content=_format_edit_result(
                    file_path,
                    success=False,
                    replacements=0,
                    added=0,
                    removed=0,
                    error="ambiguous_symbol",
                    message=(
                        f"Multiple definitions of '{name}' found in {file_path}:\n"
                        f"{ctx_list}\n"
                        f"Please specify which definition to replace (e.g. by providing "
                        f"the class name or line number)."
                    ),
                ),
            )

        replacements_list.sort(key=lambda x: x[0], reverse=True)

        new_content_bytes = content_bytes
        for start, end in replacements_list:
            new_content_bytes = (
                new_content_bytes[:start]
                + new_text.encode("utf-8")
                + new_content_bytes[end:]
            )

        new_content = new_content_bytes.decode("utf-8", errors="replace")

        if new_content == content:
            return ExecutorResult(
                display=f"No changes for '{name}' in {file_path}",
                content=_format_edit_result(
                    file_path,
                    success=True,
                    replacements=0,
                    added=0,
                    removed=0,
                    message=f"No changes needed for '{name}' in {file_path}",
                ),
            )

        _atomic_write(file_path, new_content)

        diff_text = _generate_diff(content, new_content, file_path)
        added, removed = _count_diff_changes(diff_text)

        cb_failures = await _trigger_post_write_callbacks(file_path)

        msg = f"Replaced '{name}' in {file_path} (+{added} -{removed})"
        if cb_failures:
            msg += f" [warnings: {len(cb_failures)} callback(s) failed]"

        return ExecutorResult(
            display=msg,
            content=_format_edit_result(
                file_path,
                success=True,
                replacements=len(replacements_list),
                added=added,
                removed=removed,
                diff_text=diff_text,
                message="; ".join(cb_failures) if cb_failures else None,
            ),
        )

    except ValueError as e:
        return ExecutorResult(
            display=f"Unsupported file type: {file_path}",
            content=_format_edit_result(
                file_path,
                success=False,
                replacements=0,
                added=0,
                removed=0,
                error="unsupported_file",
                message=str(e),
            ),
        )
    except Exception as e:
        logger.warning("replace_symbol error: %s", e)
        return ExecutorResult(
            display=f"Error replacing '{name}'",
            content=_format_edit_result(
                file_path,
                success=False,
                replacements=0,
                added=0,
                removed=0,
                error="replace_error",
                message=f"Error replacing '{name}' in {file_path}: {e}",
            ),
        )


async def execute_rename_symbol(name: str, new_name: str) -> ExecutorResult:
    try:
        if not name or not name.strip():
            return ExecutorResult(
                display="Empty symbol name",
                content='<ast_error tool="rename_symbol">'
                "Symbol name is required.</ast_error>",
            )

        if not new_name or not new_name.strip():
            return ExecutorResult(
                display="Empty new name",
                content='<ast_error tool="rename_symbol">'
                "New name is required.</ast_error>",
            )

        await ensure_indexed()

        loop = asyncio.get_running_loop()
        project_path = str(Path.cwd())
        store = ASTStore(project_path)

        symbols = await loop.run_in_executor(
            None, store.get_symbols_by_name, name, "both"
        )

        if not symbols:
            return ExecutorResult(
                display=f"No references for '{name}'",
                content=f'<ast_error tool="rename_symbol">'
                f"No references found for '{escape(name)}'. "
                f"No files modified.</ast_error>",
            )

        by_file: dict[str, list[dict]] = {}
        for s in symbols:
            by_file.setdefault(s["file_path"], []).append(s)

        # Identifier characters for word boundary check.
        _ident_chars = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")

        # Phase 1: compute all new contents without writing.
        # Each entry: (rel_path, abs_path, old_content, new_content, replacements)
        planned: list[tuple[str, str, str, str, int]] = []
        failed_files: list[str] = []

        for rel_path, file_symbols in by_file.items():
            abs_path = str(Path(project_path) / rel_path)
            if not Path(abs_path).exists():
                failed_files.append(rel_path)
                continue

            try:
                content = Path(abs_path).read_text(encoding="utf-8", errors="replace")
            except Exception:
                failed_files.append(rel_path)
                continue

            lines = content.split("\n")
            sorted_syms = sorted(
                file_symbols,
                key=lambda s: (s["start_line"], s["start_column"]),
                reverse=True,
            )

            file_replacements = 0
            for s in sorted_syms:
                line_idx = s["start_line"]
                byte_col = s["start_column"]
                if line_idx >= len(lines):
                    continue
                line = lines[line_idx]

                # P0 #2: Convert byte-based column to character-based column.
                line_bytes = line.encode("utf-8")
                if byte_col > len(line_bytes):
                    continue
                char_col = len(line_bytes[:byte_col].decode("utf-8", errors="replace"))
                char_end = char_col + len(name)

                if line[char_col:char_end] != name:
                    continue

                # P0 #4: Word boundary check — skip if adjacent chars are identifiers.
                if char_col > 0 and line[char_col - 1] in _ident_chars:
                    continue
                if char_end < len(line) and line[char_end] in _ident_chars:
                    continue

                lines[line_idx] = line[:char_col] + new_name + line[char_end:]
                file_replacements += 1

            new_content = "\n".join(lines)

            if new_content == content:
                continue

            planned.append((rel_path, abs_path, content, new_content, file_replacements))

        if not planned:
            return ExecutorResult(
                display=f"No changes for '{name}'",
                content=f'<ast_error tool="rename_symbol">'
                f"No changes made for '{escape(name)}'.</ast_error>",
            )

        # Phase 2: write all files. Track successes and failures.
        total_added = 0
        total_removed = 0
        edit_results = []

        for rel_path, abs_path, content, new_content, file_replacements in planned:
            try:
                _atomic_write(abs_path, new_content)
            except Exception as write_err:
                failed_files.append(rel_path)
                logger.warning("rename_symbol write failed for %s: %s", rel_path, write_err)
                edit_results.append(
                    f'<edit_result path="{_xml_attr(rel_path)}" success="false" '
                    f'replacements="0" replace_all="false" '
                    f'added="0" removed="0" '
                    f'error="{_xml_attr(str(write_err))}" />'
                )
                continue

            diff_text = _generate_diff(content, new_content, rel_path)
            added, removed = _count_diff_changes(diff_text)
            total_added += added
            total_removed += removed

            cb_failures = await _trigger_post_write_callbacks(rel_path)
            if cb_failures:
                failed_files.append(rel_path)
                logger.warning(
                    "rename_symbol callback failures for %s: %s",
                    rel_path,
                    "; ".join(cb_failures),
                )

            edit_results.append(
                f'<edit_result path="{_xml_attr(rel_path)}" success="true" '
                f'replacements="{file_replacements}" replace_all="false" '
                f'added="{added}" removed="{removed}">\n'
                f'<diff format="unified"><![CDATA[{_cdata_text(diff_text)}]]></diff>\n'
                f"</edit_result>"
            )

        if not edit_results:
            return ExecutorResult(
                display=f"No changes for '{name}'",
                content=f'<ast_error tool="rename_symbol">'
                f"No changes made for '{escape(name)}'.</ast_error>",
            )

        overall_success = len(failed_files) == 0
        result_xml = (
            f'<rename_result name="{_xml_attr(name)}" '
            f'new_name="{_xml_attr(new_name)}" '
            f'files="{len(edit_results)}" '
            f'total_added="{total_added}" total_removed="{total_removed}" '
            f'success="{str(overall_success).lower()}">\n'
            + "\n".join(edit_results)
            + "\n</rename_result>"
        )

        if failed_files:
            display = (
                f"Renamed '{name}' -> '{new_name}' with errors: "
                f"{len(planned) - len(failed_files)} succeeded, "
                f"{len(failed_files)} failed ({', '.join(failed_files)})"
            )
        else:
            display = (
                f"Renamed '{name}' -> '{new_name}' in "
                f"{len(edit_results)} file(s) (+{total_added} -{total_removed})"
            )

        return ExecutorResult(display=display, content=result_xml)

    except Exception as e:
        logger.warning("rename_symbol error: %s", e)
        return ExecutorResult(
            display=f"Error renaming '{name}'",
            content=f'<ast_error tool="rename_symbol">'
            f"{escape(str(e))}</ast_error>",
        )
