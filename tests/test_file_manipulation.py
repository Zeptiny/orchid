import os
from unittest.mock import MagicMock, patch

import pytest

from stupidex.tools.file_manipulation import (
    execute_edit_tool,
    execute_glob_tool,
    execute_read_directory_tool,
    execute_read_tool,
    execute_write_tool,
)


@pytest.mark.asyncio
async def test_edit_tool_display_summarizes_change_counts_and_compacts_diff(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "sample.txt").write_text("one\ntwo\nthree\n")

    result = await execute_edit_tool("sample.txt", "two\n", "TWO\nadded\n")

    assert result.display == "Edited sample.txt (+2 -1)"
    assert (tmp_path / "sample.txt").read_text() == "one\nTWO\nadded\nthree\n"
    assert result.content.startswith(
        '<edit_result path="sample.txt" success="true" replacements="1" '
        'replace_all="false" added="2" removed="1">'
    )
    assert '<diff format="unified"><![CDATA[' in result.content
    assert result.content.endswith("\n]]></diff>\n</edit_result>")
    assert (
        "--- old/sample.txt\n"
        "+++ new/sample.txt\n"
        "@@ -1,3 +1,4 @@\n"
        " one\n"
        "-two\n"
        "+TWO\n"
        "+added\n"
        " three"
    ) in result.content
    assert "\n-two\n\n+TWO" not in result.content


@pytest.mark.asyncio
async def test_edit_tool_not_found_uses_structured_error(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "sample.txt").write_text("content\n")

    result = await execute_edit_tool("sample.txt", "missing", "replacement")

    assert result.display == "String not found in sample.txt"
    assert '<edit_result path="sample.txt" success="false" replacements="0"' in result.content
    assert 'error="string_not_found"' in result.content
    assert '<diff format="unified" />' in result.content


@pytest.mark.asyncio
async def test_edit_tool_replace_all_replaces_every_match(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "multi.txt").write_text("foo\nbar\nfoo\nbaz\nfoo\n")

    result = await execute_edit_tool("multi.txt", "foo", "qux", replace_all=True)

    assert result.display == "Edited multi.txt (+3 -3)"
    assert (tmp_path / "multi.txt").read_text() == "qux\nbar\nqux\nbaz\nqux\n"
    assert 'success="true"' in result.content
    assert 'replacements="3"' in result.content
    assert 'replace_all="true"' in result.content


@pytest.mark.asyncio
async def test_edit_tool_multiple_matches_without_replace_all_errors(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "multi.txt").write_text("foo\nbar\nfoo\nbaz\nfoo\n")

    result = await execute_edit_tool("multi.txt", "foo", "qux")

    assert result.display == "Multiple matches in multi.txt"
    assert 'success="false"' in result.content
    assert 'replacements="0"' in result.content
    assert 'error="multiple_matches"' in result.content
    assert "found 3 times" in result.content
    assert (tmp_path / "multi.txt").read_text() == "foo\nbar\nfoo\nbaz\nfoo\n"


@pytest.mark.asyncio
async def test_edit_tool_generic_exception_returned_as_error_result(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "boom.txt").write_text("content\n")

    def _boom(*args, **kwargs):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr("stupidex.tools.file_manipulation.atomic_write", _boom)

    result = await execute_edit_tool("boom.txt", "content", "other")

    assert result.display == "Edit error boom.txt"
    assert 'success="false"' in result.content
    assert 'error="edit_error"' in result.content
    assert "disk on fire" in result.content
    assert (tmp_path / "boom.txt").read_text() == "content\n"


# ---------------------------------------------------------------------------
# P1-14: atomic writes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_write_tool_writes_content(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    result = await execute_write_tool("out.txt", "hello\nworld\n")
    assert (tmp_path / "out.txt").read_text() == "hello\nworld\n"
    assert "Wrote 2 lines" in result.display


@pytest.mark.asyncio
async def test_edit_tool_preserves_file_mode_bits(tmp_path, monkeypatch):
    import os
    import stat

    monkeypatch.chdir(tmp_path)
    target = tmp_path / "f.txt"
    target.write_text("a\nb\n")
    os.chmod(target, 0o640)
    original_mode = stat.S_IMODE(os.stat(target).st_mode)

    await execute_edit_tool("f.txt", "a\n", "A\n")

    assert target.read_text() == "A\nb\n"
    assert stat.S_IMODE(os.stat(target).st_mode) == original_mode


@pytest.mark.asyncio
async def test_write_tool_fires_post_write_callbacks(tmp_path, monkeypatch):
    from unittest.mock import AsyncMock

    from stupidex.tools.ast import post_write_callbacks

    monkeypatch.chdir(tmp_path)
    cb = AsyncMock()
    post_write_callbacks.append(cb)
    try:
        await execute_write_tool("cb.txt", "data\n")
        cb.assert_called_once()
    finally:
        post_write_callbacks.remove(cb)


@pytest.mark.asyncio
async def test_write_tool_creates_parent_directories(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    result = await execute_write_tool("nested/deep/dir/file.txt", "content\n")
    assert (tmp_path / "nested" / "deep" / "dir" / "file.txt").read_text() == "content\n"
    assert "Wrote" in result.display


class TestExecuteReadTool:
    @pytest.mark.asyncio
    async def test_read_full_file(self, tmp_path):
        target = tmp_path / "five.txt"
        target.write_text("line1\nline2\nline3\nline4\nline5\n")
        result = await execute_read_tool(str(target), offset=1, limit=10)
        assert result.content.count(" | ") == 5
        assert "1 | line1" in result.content
        assert "5 | line5" in result.content

    @pytest.mark.asyncio
    async def test_read_with_offset_and_limit(self, tmp_path):
        target = tmp_path / "ten.txt"
        target.write_text("\n".join(f"line{i}" for i in range(1, 11)) + "\n")
        result = await execute_read_tool(str(target), offset=3, limit=2)
        assert "3 | line3" in result.content
        assert "4 | line4" in result.content
        assert "line1" not in result.content
        assert "line5" not in result.content

    @pytest.mark.asyncio
    async def test_read_limit_none_uses_config(self, tmp_path):
        target = tmp_path / "many.txt"
        target.write_text("\n".join(f"line{i}" for i in range(1, 11)) + "\n")
        mock_cfg = MagicMock(read_line_limit=3)
        with patch("stupidex.tools.file_manipulation.get_config", return_value=mock_cfg):
            result = await execute_read_tool(str(target), offset=1, limit=None)
        assert result.content.count(" | ") == 3
        assert "1 | line1" in result.content
        assert "3 | line3" in result.content
        assert "line4" not in result.content

    @pytest.mark.asyncio
    async def test_read_empty_file(self, tmp_path):
        target = tmp_path / "empty.txt"
        target.write_text("")
        result = await execute_read_tool(str(target))
        assert "empty" in result.content

    @pytest.mark.asyncio
    async def test_read_offset_out_of_range(self, tmp_path):
        target = tmp_path / "three.txt"
        target.write_text("a\nb\nc\n")
        result = await execute_read_tool(str(target), offset=10)
        assert "out of range" in result.display
        assert "greater than the file line count" in result.content

    @pytest.mark.asyncio
    async def test_read_unreadable_file_returns_error(self, tmp_path):
        if os.geteuid() == 0:
            pytest.skip("chmod is not effective for root")
        target = tmp_path / "noperm.txt"
        target.write_text("secret\n")
        os.chmod(target, 0o000)
        try:
            result = await execute_read_tool(str(target))
            assert "error" in result.content.lower()
        finally:
            os.chmod(target, 0o644)


class TestExecuteGlobTool:
    @pytest.mark.asyncio
    async def test_glob_matches_files(self, tmp_path):
        (tmp_path / "a.py").write_text("x")
        (tmp_path / "b.py").write_text("x")
        (tmp_path / "c.txt").write_text("x")
        result = await execute_glob_tool(str(tmp_path), "*.py")
        assert "2 file(s)" in result.content
        assert "a.py" in result.content
        assert "b.py" in result.content
        assert "c.txt" not in result.content

    @pytest.mark.asyncio
    async def test_glob_recursive_pattern(self, tmp_path):
        sub = tmp_path / "src"
        sub.mkdir()
        (sub / "nested.py").write_text("x")
        (tmp_path / "top.py").write_text("x")
        result = await execute_glob_tool(str(tmp_path), "**/*.py")
        assert "nested.py" in result.content
        assert "top.py" in result.content
        assert "2 file(s)" in result.content

    @pytest.mark.asyncio
    async def test_glob_include_hidden_false_excludes(self, tmp_path):
        (tmp_path / ".hidden.py").write_text("x")
        (tmp_path / "visible.py").write_text("x")
        result = await execute_glob_tool(str(tmp_path), "*.py", include_hidden=False)
        assert "1 file(s)" in result.content
        assert "visible.py" in result.content
        assert ".hidden.py" not in result.content

    @pytest.mark.asyncio
    async def test_glob_no_matches(self, tmp_path):
        (tmp_path / "a.py").write_text("x")
        result = await execute_glob_tool(str(tmp_path), "*.nonexistent")
        assert "No files found" in result.content

    @pytest.mark.asyncio
    async def test_glob_unscannable_path_returns_error(self, tmp_path):
        bad_path = str(tmp_path) + "\x00readonly"
        result = await execute_glob_tool(bad_path, "*.py")
        assert "error" in result.content.lower()


class TestExecuteReadDirectoryTool:
    @pytest.mark.asyncio
    async def test_read_directory_happy_path(self, tmp_path):
        (tmp_path / "sub").mkdir()
        (tmp_path / "sub" / "child.py").write_text("x")
        (tmp_path / "top.py").write_text("x")
        result = await execute_read_directory_tool(str(tmp_path), max_depth=2)
        assert "top.py" in result.content
        assert "sub/" in result.content
        assert "child.py" in result.content
        assert "├──" in result.content or "└──" in result.content

    @pytest.mark.asyncio
    async def test_read_directory_max_depth_none_uses_config(self, tmp_path):
        sub = tmp_path / "sub"
        sub.mkdir()
        (sub / "deep.py").write_text("x")
        (tmp_path / "top.py").write_text("x")
        mock_cfg = MagicMock(directory_tree_depth=1, ignored_dirs=[])
        with patch("stupidex.tools.file_manipulation.get_config", return_value=mock_cfg):
            result = await execute_read_directory_tool(str(tmp_path), max_depth=None)
        assert "top.py" in result.content
        assert "sub/" in result.content
        assert "deep.py" not in result.content

    @pytest.mark.asyncio
    async def test_read_directory_include_hidden(self, tmp_path):
        (tmp_path / ".hidden_dir").mkdir()
        (tmp_path / ".hidden_dir" / "secret.py").write_text("x")
        excluded = await execute_read_directory_tool(str(tmp_path), max_depth=2, include_hidden=False)
        assert "secret.py" not in excluded.content
        assert ".hidden_dir" not in excluded.content
        included = await execute_read_directory_tool(str(tmp_path), max_depth=2, include_hidden=True)
        assert ".hidden_dir" in included.content
        assert "secret.py" in included.content

    @pytest.mark.asyncio
    async def test_read_directory_nonexistent_returns_error(self, tmp_path):
        result = await execute_read_directory_tool(str(tmp_path / "does_not_exist"))
        assert "error" in result.content.lower()


