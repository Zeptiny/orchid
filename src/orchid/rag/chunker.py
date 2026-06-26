import bisect
from dataclasses import dataclass


@dataclass
class Chunk:
    file_path: str
    content: str
    start_line: int
    end_line: int


def _is_binary(content: str) -> bool:
    return "\0" in content


def _line_break_offsets(lines: list[str]) -> list[int]:
    """Cumulative char offset at the *start* of each line index (precomputed once).

    ``line_offsets[i]`` is the char position of line ``i``. The list has
    ``len(lines)`` entries (the final entry is the start of the last line, and
    a sentinel of ``len(content)`` is NOT included — callers use bisect on the
    raw offsets and handle the tail explicitly).
    """
    offsets: list[int] = []
    cumulative = 0
    for line in lines:
        offsets.append(cumulative)
        cumulative += len(line)
    return offsets


def _find_break_points(lines: list[str]) -> list[int]:
    """Find natural break points (blank lines) for smarter chunking."""
    breaks = []
    for i, line in enumerate(lines):
        if not line.strip():
            breaks.append(i)
    return breaks


def _pick_break_after(breaks: list[int], after_line: int, target_line: int) -> int | None:
    """Pick the closest break point to target_line that is strictly after after_line."""
    candidates = [b for b in breaks if b > after_line]
    if not candidates:
        return None
    return min(candidates, key=lambda b: abs(b - target_line))


def chunk_file(
    file_path: str,
    content: str,
    chunk_size: int = 2000,
    chunk_overlap: int = 200,
) -> list[Chunk]:
    """Split source code into overlapping chunks.

    Chunks respect natural break points (blank lines) when possible.
    Binary files and empty files return empty lists.
    """
    if _is_binary(content) or not content.strip():
        return []

    lines = content.splitlines(keepends=True)
    total_chars = len(content)

    if total_chars <= chunk_size:
        return [
            Chunk(
                file_path=file_path,
                content=content,
                start_line=1,
                end_line=len(lines),
            )
        ]

    if chunk_overlap >= chunk_size:
        raise ValueError(
            f"chunk_overlap ({chunk_overlap}) must be less than chunk_size ({chunk_size})"
        )

    break_points = _find_break_points(lines)
    # Precompute cumulative line start offsets once -> O(log N) per lookup instead of O(N).
    line_offsets = _line_break_offsets(lines)
    chunks: list[Chunk] = []
    char_pos = 0
    min_chunk = chunk_size // 4

    while char_pos < total_chars:
        end_char = min(char_pos + chunk_size, total_chars)

        # Natural-break adjustment only when the window is not the final tail.
        if end_char < total_chars and break_points:
            current_line = _line_at_char(line_offsets, char_pos)
            target_line = _line_at_char(line_offsets, end_char)
            bp = _pick_break_after(break_points, current_line, target_line)
            if bp is not None:
                bp_char = _char_at_line(line_offsets, bp)
                if bp_char > char_pos + min_chunk and bp_char < end_char:
                    end_char = bp_char

        if end_char <= char_pos:
            end_char = min(char_pos + chunk_size, total_chars)

        chunk_text = content[char_pos:end_char]
        start_line = _line_at_char(line_offsets, char_pos) + 1
        end_char_for_line = end_char - 1 if content[end_char - 1] == '\n' else end_char
        end_line = _line_at_char(line_offsets, end_char_for_line) + 1

        chunks.append(
            Chunk(
                file_path=file_path,
                content=chunk_text,
                start_line=start_line,
                end_line=end_line,
            )
        )

        if end_char >= total_chars:
            break

        char_pos += max(1, end_char - char_pos - chunk_overlap)

    return chunks


def _line_at_char(line_offsets: list[int], char_pos: int) -> int:
    """Return the 0-indexed line number for a character position (O(log N))."""
    idx = bisect.bisect_right(line_offsets, char_pos) - 1
    return max(idx, 0)


def _char_at_line(line_offsets: list[int], line_idx: int) -> int:
    """Return the character position at the start of a line index (O(1))."""
    if line_idx < 0:
        return 0
    if line_idx >= len(line_offsets):
        return line_offsets[-1] if line_offsets else 0
    return line_offsets[line_idx]
