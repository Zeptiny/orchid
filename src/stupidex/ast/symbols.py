from dataclasses import dataclass


@dataclass(frozen=True)
class Symbol:
    name: str
    type: str
    kind: str
    start_line: int
    start_column: int
    end_line: int
    end_column: int
    char_start: int
    char_end: int
