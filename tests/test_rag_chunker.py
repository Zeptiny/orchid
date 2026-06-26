"""Tests for RAG chunker (U9)."""

from stupidex.rag.chunker import chunk_file


def test_chunker_single_line():
    """Single line file produces one chunk."""
    chunks = chunk_file("test.py", "x = 1\n")
    assert len(chunks) == 1
    assert chunks[0].content == "x = 1\n"
    assert chunks[0].start_line == 1
    assert chunks[0].end_line == 1


def test_chunker_empty_file():
    """Empty file produces no chunks."""
    chunks = chunk_file("test.py", "")
    assert chunks == []


def test_chunker_whitespace_only():
    """Whitespace-only file produces no chunks."""
    chunks = chunk_file("test.py", "   \n\n  ")
    assert chunks == []


def test_chunker_binary_file():
    """Binary file (with null bytes) produces no chunks."""
    chunks = chunk_file("test.py", "def foo():\n\x00\x01\x02")
    assert chunks == []


def test_chunker_large_file_splits():
    """Large file should be split into multiple chunks."""
    code = "def foo():\n    pass\n\n" * 200
    chunks = chunk_file("test.py", code, chunk_size=2000, chunk_overlap=200)
    assert len(chunks) > 1
    assert len(chunks) <= 10


def test_chunker_respects_line_numbers():
    """Chunks should have correct line numbers."""
    lines = [f"line {i}" for i in range(1, 101)]
    content = "\n".join(lines)
    chunks = chunk_file("test.py", content, chunk_size=200, chunk_overlap=50)

    assert len(chunks) > 1
    for i, chunk in enumerate(chunks):
        assert chunk.start_line >= 1
        assert chunk.end_line >= chunk.start_line
        if i > 0:
            assert chunk.start_line >= chunks[i-1].start_line


def test_chunker_overlap():
    """Chunks should overlap by the specified amount."""
    code = "A\n" * 1000
    chunks = chunk_file("test.py", code, chunk_size=100, chunk_overlap=20)

    if len(chunks) > 1:
        for i in range(len(chunks) - 1):
            overlap_region = chunks[i].content[-20:]
            next_start = chunks[i + 1].content[:20]
            assert overlap_region == next_start, (
                f"Chunk {i} end does not match chunk {i + 1} start: "
                f"{overlap_region!r} != {next_start!r}"
            )


def test_chunker_preserves_content():
    """Chunks should preserve the original content."""
    original = "def hello():\n    return 'world'\n"
    chunks = chunk_file("test.py", original)
    assert chunks[0].content == original


def test_chunker_multiline_function():
    """Multiline function should be chunked correctly."""
    code = """
def complex_function(a, b, c):
    if a > b:
        return a + c
    else:
        return b + c

def another_function():
    pass
"""
    chunks = chunk_file("test.py", code.strip())
    assert len(chunks) >= 1


def test_chunker_markdown_file():
    """Markdown file should be chunked correctly."""
    content = "# Title\n\nSome text\n\n## Section\n\nMore text\n"
    chunks = chunk_file("doc.md", content)
    assert len(chunks) == 1


def test_chunker_json_file():
    """JSON file should be chunked correctly."""
    content = '{"key": "value", "nested": {"a": 1}}\n'
    chunks = chunk_file("config.json", content)
    assert len(chunks) == 1


def test_chunker_very_large_chunks():
    """File smaller than chunk_size should produce single chunk."""
    small_code = "x = 1\n" * 100
    chunks = chunk_file("test.py", small_code, chunk_size=10000, chunk_overlap=200)
    assert len(chunks) == 1


def test_chunker_custom_size():
    """Custom chunk_size should be respected."""
    code = "line\n" * 100
    chunks = chunk_file("test.py", code, chunk_size=50, chunk_overlap=10)
    assert len(chunks) > 1


# ---------------------------------------------------------------------------
# P2-143: end_line correctness when chunk boundary aligns with a newline.
# Investigation tests written before the fix to confirm the bug. Each asserts
# the *correct* (post-fix) line numbers — they all fail against the original
# `content[end_char] == '\n'` adjustment.
# ---------------------------------------------------------------------------


def test_chunker_end_line_chunk_ends_with_newline():
    """P2-143: chunk_text that ends with a trailing '\n' must report end_line
    as the line of the trailing newline (not the next line)."""
    # content = "abc\ndef\nghi"; chunk_size=4, chunk_overlap=1
    # first chunk = content[0:4] = "abc\n" -> line 1 only.
    chunks = chunk_file("t.py", "abc\ndef\nghi", chunk_size=4, chunk_overlap=1)
    assert chunks[0].content == "abc\n"
    assert chunks[0].start_line == 1
    assert chunks[0].end_line == 1


def test_chunker_end_line_chunk_includes_two_newlines():
    """P2-143: chunk spanning two full lines (each ending with '\n') must
    report end_line as the second line, not the line after."""
    # content = "abc\ndef\nghi"; chunk_size=8, chunk_overlap=1
    # first chunk = content[0:8] = "abc\ndef\n" -> lines 1-2.
    chunks = chunk_file("t.py", "abc\ndef\nghi", chunk_size=8, chunk_overlap=1)
    assert chunks[0].content == "abc\ndef\n"
    assert chunks[0].start_line == 1
    assert chunks[0].end_line == 2


def test_chunker_end_line_chunk_ends_just_before_newline():
    """P2-143: chunk that ends exactly at the char before '\n' (last content
    char is non-newline) — end_line is the line that char is on."""
    # content = "abc\ndef\nghi"; chunk_size=3, chunk_overlap=1
    # first chunk = content[0:3] = "abc" -> line 1.
    chunks = chunk_file("t.py", "abc\ndef\nghi", chunk_size=3, chunk_overlap=1)
    assert chunks[0].content == "abc"
    assert chunks[0].start_line == 1
    assert chunks[0].end_line == 1


def test_chunker_end_line_chunk_spans_newline_mid_chunk():
    """P2-143: chunk that contains a '\n' in the middle but last char is on a
    later line — end_line is the line of the last char."""
    # content = "abc\ndef\nghi"; chunk_size=3, chunk_overlap=1
    # second chunk = content[2:5] = "c\nd" -> spans lines 1-2.
    chunks = chunk_file("t.py", "abc\ndef\nghi", chunk_size=3, chunk_overlap=1)
    assert chunks[1].content == "c\nd"
    assert chunks[1].start_line == 1
    assert chunks[1].end_line == 2


def test_chunker_end_line_no_trailing_newline_in_file():
    """P2-143: file without a trailing newline — last chunk end_line is the
    last line of the file."""
    content = "line one\nline two\nline three"
    chunks = chunk_file("t.py", content, chunk_size=100, chunk_overlap=10)
    assert len(chunks) == 1
    assert chunks[0].start_line == 1
    assert chunks[0].end_line == 3


def test_chunker_end_line_single_line_short_file():
    """Edge: file shorter than chunk_size; start_line=1, end_line=1."""
    chunks = chunk_file("t.py", "x = 1\n")
    assert len(chunks) == 1
    assert chunks[0].start_line == 1
    assert chunks[0].end_line == 1


def test_chunker_end_line_empty_content():
    """Edge: empty content returns []."""
    assert chunk_file("t.py", "") == []


def test_chunker_end_line_binary_content():
    """Edge: binary content returns []."""
    assert chunk_file("t.py", "abc\x00def") == []


# ---------------------------------------------------------------------------
# Batch-3 fixes 2026-06-22: O(N²)→O(N log N), dead branch removal
# ---------------------------------------------------------------------------


def test_chunker_large_file_completes_quickly():
    """P2-156: a 100k-line file chunks in well under a second.

    The old O(N²) _line_at_char/_char_at_line scanned the line list inside the
    chunking loop; the bisect-based version is O(N log N) and handles 100k
    lines in milliseconds."""
    import time

    lines = [f"line {i}\n" for i in range(100_000)]
    content = "".join(lines)
    t0 = time.monotonic()
    chunks = chunk_file("big.py", content, chunk_size=2000, chunk_overlap=200)
    elapsed = time.monotonic() - t0

    assert len(chunks) > 1
    # Generous bound; old O(N²) would take many seconds.
    assert elapsed < 2.0, f"chunking 100k lines took {elapsed:.2f}s"


def test_chunker_no_dead_branch_on_final_tail():
    """P2-181: the dead `if remaining <= chunk_size: pass` branch is gone.

    The final-tail break now triggers via `if end_char >= total_chars: break`.
    Verify the last chunk reaches the end of the content (no premature break
    and no off-by-one leaving trailing content unchunked)."""
    # Construct content where the final chunk is exactly the tail.
    lines = ["aaaa\n" for _ in range(50)]
    content = "".join(lines)
    chunks = chunk_file("t.py", content, chunk_size=20, chunk_overlap=5)

    # The union of all chunk contents (with overlap) covers the whole file.
    # Last chunk's end must reach the final char.
    assert chunks[-1].end_line == 50
    # The last chunk's content ends at the end of the file content.
    assert chunks[-1].content.endswith(lines[-1])


def test_chunker_single_chunk_no_break_branch():
    """P2-181 edge: a file smaller than chunk_size returns a single chunk
    without entering the while loop (the early-return path)."""
    content = "short file\n"
    chunks = chunk_file("t.py", content, chunk_size=2000, chunk_overlap=200)
    assert len(chunks) == 1
    assert chunks[0].content == content
    assert chunks[0].start_line == 1
    assert chunks[0].end_line == 1
