import asyncio
import fnmatch
import os
import re

import aiofiles

from stupidex.config import get_config
from stupidex.domain.tool import ExecutorResult, Tool, ToolParameter, ToolParameterProperties

grep_tool = Tool(
    name="grep",
    description="Search file contents using regex. Returns matching lines with file paths and line numbers. Use to find function definitions, variable references, error messages, or any text pattern across the codebase.",
    parameters=ToolParameter(
        properties={
            "pattern": ToolParameterProperties(
                type="string",
                description="The regex pattern to search for"
            ),
            "directory_path": ToolParameterProperties(
                type="string",
                description="The directory to search in, relative to the current working directory"
            ),
            "include_pattern": ToolParameterProperties(
                type="string",
                description="Glob pattern to filter files (e.g., '*.py', '*.txt'). If not set, all files are searched."
            ),
            "case_insensitive": ToolParameterProperties(
                type="boolean",
                description="Whether the search should be case insensitive (default: false)"
            ),
            "max_results": ToolParameterProperties(
                type="integer",
                description="Maximum number of matching lines to return (default: 100)"
            ),
        },
        required=["pattern", "directory_path"]
    ),
    action_label="Grepping...",
)


_PER_FILE_TIMEOUT = 10.0


async def _is_binary(file_path: str) -> bool:
    """Check if a file is binary by reading a small chunk."""
    try:
        async with aiofiles.open(file_path, "rb") as f:
            chunk = await f.read(8192)
            return b"\0" in chunk
    except OSError:
        return True


async def execute_grep_tool(
    pattern: str,
    directory_path: str,
    include_pattern: str | None = None,
    case_insensitive: bool = False,
    max_results: int | None = None,
) -> ExecutorResult:
    """Search for a pattern in files within a directory."""
    if max_results is None:
        max_results = get_config().grep_max_results
    try:
        flags = re.IGNORECASE if case_insensitive else 0
        try:
            regex = re.compile(pattern, flags)
        except re.error as e:
            return ExecutorResult(
                display=f"Invalid regex: {pattern}",
                content=f"Error: Invalid regex pattern '{pattern}': {e}",
            )

        base_path = os.path.abspath(directory_path)
        if not os.path.isdir(base_path):
            return ExecutorResult(
                display=f"Directory not found: {directory_path}",
                content=f"Error: Directory '{directory_path}' does not exist.",
            )

        # Build ignored set once instead of per-directory
        ignored = frozenset(get_config().ignored_dirs)

        def _should_skip_dir(dirname: str) -> bool:
            if dirname in ignored:
                return True
            return bool(dirname.startswith("."))

        # If include_pattern is given, compile it as a regex for matching filenames
        file_regex = None
        if include_pattern:
            glob_regex = fnmatch.translate(include_pattern)
            file_regex = re.compile(glob_regex, re.IGNORECASE)

        # Collect all file paths using os.walk (blocking) in executor
        def _collect_files():
            collected = []
            for root, dirs, files in os.walk(base_path):
                dirs[:] = [d for d in dirs if not _should_skip_dir(d)]
                for filename in sorted(files):
                    if file_regex and not file_regex.match(filename):
                        continue
                    collected.append(os.path.join(root, filename))
            return collected

        loop = asyncio.get_running_loop()
        file_paths = await loop.run_in_executor(None, _collect_files)

        # Search files with bounded concurrency
        semaphore = asyncio.Semaphore(32)
        results: list[str] = []

        def _search_file_sync(file_path: str, regex, max_results: int) -> list[str] | None:
            try:
                relative_path = os.path.relpath(file_path, base_path)
                matches: list[str] = []
                with open(file_path, encoding="utf-8", errors="ignore") as f:
                    for line_num, line in enumerate(f, start=1):
                        if regex.search(line):
                            matches.append(f"{relative_path}:{line_num}: {line.rstrip()}")
                            if len(matches) >= max_results:
                                break
                return matches
            except (PermissionError, OSError):
                return None

        async def _search_file(file_path: str) -> list[str] | None:
            async with semaphore:
                if await _is_binary(file_path):
                    return None
                loop = asyncio.get_running_loop()
                try:
                    return await asyncio.wait_for(
                        loop.run_in_executor(None, _search_file_sync, file_path, regex, max_results),
                        timeout=_PER_FILE_TIMEOUT,
                    )
                except TimeoutError:
                    return None

        tasks = [asyncio.ensure_future(_search_file(fp)) for fp in file_paths]
        try:
            for coro in asyncio.as_completed(tasks):
                matches = await coro
                if matches:
                    for match in matches:
                        results.append(match)
                        if len(results) >= max_results:
                            break
                if len(results) >= max_results:
                    break
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()

        if not results:
            return ExecutorResult(
                display=f"No matches for '{pattern}'",
                content=f"No matches found for pattern '{pattern}' in '{directory_path}'.",
            )

        output_lines = [f"Found {len(results)} match(es) for pattern '{pattern}':"]
        output_lines.extend(results)

        if len(results) >= max_results:
            output_lines.append(f"\n... (truncated to {max_results} results)")

        return ExecutorResult(
            display=f"Found {len(results)} matches for '{pattern}'",
            content="\n".join(output_lines),
        )

    except Exception as e:
        return ExecutorResult(
            display=f"Grep error: {pattern}",
            content=f"Error searching for pattern '{pattern}': {e}",
        )
