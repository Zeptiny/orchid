import { describe, it, expect } from 'vitest';
import {
  parsePatch,
  ParseError,
  BEGIN_PATCH_MARKER,
  END_PATCH_MARKER,
  ADD_FILE_MARKER,
  DELETE_FILE_MARKER,
  UPDATE_FILE_MARKER,
  MOVE_TO_MARKER,
  EOF_MARKER,
  CHANGE_CONTEXT_MARKER,
  EMPTY_CHANGE_CONTEXT_MARKER,
} from '../../src/main/tools/filesystem/apply-patch-parser';
import type { PatchHunk } from '../../src/main/tools/filesystem/apply-patch-parser';

// ── Marker constants ───────────────────────────────────────────────────────

describe('marker constants', () => {
  it('should export all marker constants', () => {
    expect(BEGIN_PATCH_MARKER).toBe('*** Begin Patch');
    expect(END_PATCH_MARKER).toBe('*** End Patch');
    expect(ADD_FILE_MARKER).toBe('*** Add File: ');
    expect(DELETE_FILE_MARKER).toBe('*** Delete File: ');
    expect(UPDATE_FILE_MARKER).toBe('*** Update File: ');
    expect(MOVE_TO_MARKER).toBe('*** Move to: ');
    expect(EOF_MARKER).toBe('*** End of File');
    expect(CHANGE_CONTEXT_MARKER).toBe('@@ ');
    expect(EMPTY_CHANGE_CONTEXT_MARKER).toBe('@@');
  });
});

// ── Happy path: multi-file patch ───────────────────────────────────────────

describe('multi-file patch', () => {
  it('should parse Add, Update (with chunks), and Delete hunks', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: path/add.py',
      '+abc',
      '+def',
      '*** Delete File: path/delete.py',
      '*** Update File: path/update.py',
      '*** Move to: path/update2.py',
      '@@ def f():',
      '-    pass',
      '+    return 123',
      '*** End Patch',
    ].join('\n');

    const result = parsePatch(patch);

    expect(result.hunks).toHaveLength(3);

    const addHunk = result.hunks[0] as Extract<PatchHunk, { type: 'add' }>;
    expect(addHunk.type).toBe('add');
    expect(addHunk.path).toBe('path/add.py');
    expect(addHunk.contents).toBe('abc\ndef\n');

    const deleteHunk = result.hunks[1] as Extract<PatchHunk, { type: 'delete' }>;
    expect(deleteHunk.type).toBe('delete');
    expect(deleteHunk.path).toBe('path/delete.py');

    const updateHunk = result.hunks[2] as Extract<PatchHunk, { type: 'update' }>;
    expect(updateHunk.type).toBe('update');
    expect(updateHunk.path).toBe('path/update.py');
    expect(updateHunk.movePath).toBe('path/update2.py');
    expect(updateHunk.chunks).toHaveLength(1);
    expect(updateHunk.chunks[0].changeContext).toBe('def f():');
    expect(updateHunk.chunks[0].oldLines).toEqual(['    pass']);
    expect(updateHunk.chunks[0].newLines).toEqual(['    return 123']);
    expect(updateHunk.chunks[0].isEndOfFile).toBe(false);
  });

  it('should return the normalized patch string', () => {
    const patch = '*** Begin Patch\n*** Add File: foo\n+hi\n*** End Patch';
    const result = parsePatch(patch);
    expect(result.patch).toBe(patch);
  });
});

// ── Happy path: Move to ────────────────────────────────────────────────────

describe('update with Move to', () => {
  it('should populate movePath', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/old.rs',
      '*** Move to: src/new.rs',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');

    const result = parsePatch(patch);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'update' }>;

    expect(hunk.path).toBe('src/old.rs');
    expect(hunk.movePath).toBe('src/new.rs');
  });

  it('should set movePath to null when no Move to marker', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.py',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');

    const result = parsePatch(patch);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'update' }>;
    expect(hunk.movePath).toBeNull();
  });
});

// ── Happy path: multiple @@ chunks ─────────────────────────────────────────

describe('multiple @@ chunks', () => {
  it('should parse chunks in order', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: src/config.rs',
      '@@ impl Config',
      '-    pub apply_patch_progress: bool,',
      '+    pub stream_apply_patch_progress: bool,',
      '     pub include_diagnostics: bool,',
      '@@ fn default_progress_interval()',
      '-    Duration::from_millis(500)',
      '+    Duration::from_millis(250)',
      '*** End Patch',
    ].join('\n');

    const result = parsePatch(patch);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'update' }>;

    expect(hunk.chunks).toHaveLength(2);

    expect(hunk.chunks[0].changeContext).toBe('impl Config');
    expect(hunk.chunks[0].oldLines).toEqual([
      '    pub apply_patch_progress: bool,',
      '    pub include_diagnostics: bool,',
    ]);
    expect(hunk.chunks[0].newLines).toEqual([
      '    pub stream_apply_patch_progress: bool,',
      '    pub include_diagnostics: bool,',
    ]);

    expect(hunk.chunks[1].changeContext).toBe('fn default_progress_interval()');
    expect(hunk.chunks[1].oldLines).toEqual(['    Duration::from_millis(500)']);
    expect(hunk.chunks[1].newLines).toEqual(['    Duration::from_millis(250)']);
  });
});

// ── Happy path: @@ context hint ────────────────────────────────────────────

describe('@@ context hint', () => {
  it('should populate changeContext from @@ hint', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: app.py',
      '@@ class Foo',
      '-    x = 1',
      '+    x = 2',
      '*** End Patch',
    ].join('\n');

    const result = parsePatch(patch);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'update' }>;
    expect(hunk.chunks[0].changeContext).toBe('class Foo');
  });

  it('should set changeContext to null for bare @@', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: app.py',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');

    const result = parsePatch(patch);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'update' }>;
    expect(hunk.chunks[0].changeContext).toBeNull();
  });
});

// ── Happy path: stacked @@ hints ───────────────────────────────────────────

describe('stacked @@ hints', () => {
  it('should produce multiple chunks for stacked hints', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: app.py',
      '@@ class Foo',
      '@@ def bar():',
      '-    pass',
      '+    return 1',
      '*** End Patch',
    ].join('\n');

    const result = parsePatch(patch);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'update' }>;

    expect(hunk.chunks).toHaveLength(2);

    expect(hunk.chunks[0].changeContext).toBe('class Foo');
    expect(hunk.chunks[0].oldLines).toEqual([]);
    expect(hunk.chunks[0].newLines).toEqual([]);

    expect(hunk.chunks[1].changeContext).toBe('def bar():');
    expect(hunk.chunks[1].oldLines).toEqual(['    pass']);
    expect(hunk.chunks[1].newLines).toEqual(['    return 1']);
  });

  it('should produce three chunks for three stacked hints', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: app.py',
      '@@ a',
      '@@ b',
      '@@ c',
      '-x',
      '+y',
      '*** End Patch',
    ].join('\n');

    const result = parsePatch(patch);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'update' }>;

    expect(hunk.chunks).toHaveLength(3);

    expect(hunk.chunks[0].changeContext).toBe('a');
    expect(hunk.chunks[0].oldLines).toEqual([]);
    expect(hunk.chunks[0].newLines).toEqual([]);

    expect(hunk.chunks[1].changeContext).toBe('b');
    expect(hunk.chunks[1].oldLines).toEqual([]);
    expect(hunk.chunks[1].newLines).toEqual([]);

    expect(hunk.chunks[2].changeContext).toBe('c');
    expect(hunk.chunks[2].oldLines).toEqual(['x']);
    expect(hunk.chunks[2].newLines).toEqual(['y']);
  });
});

// ── Happy path: End of File ────────────────────────────────────────────────

describe('*** End of File', () => {
  it('should set isEndOfFile true on the current chunk', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      '+quux',
      '*** End of File',
      '',
      '*** End Patch',
    ].join('\n');

    const result = parsePatch(patch);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'update' }>;
    expect(hunk.chunks[0].isEndOfFile).toBe(true);
    expect(hunk.chunks[0].newLines).toEqual(['quux']);
  });
});

// ── Happy path: Add File contents ──────────────────────────────────────────

describe('Add File with + lines', () => {
  it('should join contents with trailing newline', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: hello.txt',
      '+Hello',
      '+world',
      '*** End Patch',
    ].join('\n');

    const result = parsePatch(patch);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'add' }>;
    expect(hunk.contents).toBe('Hello\nworld\n');
  });

  it('should handle single + line', () => {
    const patch = '*** Begin Patch\n*** Add File: foo\n+hi\n*** End Patch';
    const result = parsePatch(patch);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'add' }>;
    expect(hunk.contents).toBe('hi\n');
  });
});

// ── Edge case: empty patch ─────────────────────────────────────────────────

describe('empty patch', () => {
  it('should return empty hunks array', () => {
    const patch = '*** Begin Patch\n*** End Patch';
    const result = parsePatch(patch);
    expect(result.hunks).toEqual([]);
  });
});

// ── Edge case: heredoc stripping ───────────────────────────────────────────

describe('heredoc stripping', () => {
  const innerPatch = [
    '*** Begin Patch',
    '*** Update File: file2.py',
    ' import foo',
    '+bar',
    '*** End Patch',
  ].join('\n');

  it('should strip <<EOF wrapper', () => {
    const wrapped = `<<EOF\n${innerPatch}\nEOF`;
    const result = parsePatch(wrapped);
    expect(result.hunks).toHaveLength(1);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'update' }>;
    expect(hunk.path).toBe('file2.py');
  });

  it("should strip <<'EOF' wrapper", () => {
    const wrapped = `<<'EOF'\n${innerPatch}\nEOF`;
    const result = parsePatch(wrapped);
    expect(result.hunks).toHaveLength(1);
  });

  it('should strip <<"EOF" wrapper', () => {
    const wrapped = `<<"EOF"\n${innerPatch}\nEOF`;
    const result = parsePatch(wrapped);
    expect(result.hunks).toHaveLength(1);
  });

  it('should not strip heredoc with fewer than 4 lines', () => {
    const short = '<<EOF\n*** Begin Patch\nEOF';
    expect(() => parsePatch(short)).toThrow(ParseError);
  });
});

// ── Edge case: implicit chunk (no @@ header) ───────────────────────────────

describe('implicit chunk without @@ header', () => {
  it('should create implicit chunk with null changeContext', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: file2.py',
      ' import foo',
      '+bar',
      '*** End Patch',
    ].join('\n');

    const result = parsePatch(patch);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'update' }>;

    expect(hunk.chunks).toHaveLength(1);
    expect(hunk.chunks[0].changeContext).toBeNull();
    expect(hunk.chunks[0].oldLines).toEqual(['import foo']);
    expect(hunk.chunks[0].newLines).toEqual(['import foo', 'bar']);
  });
});

// ── Edge case: context lines ───────────────────────────────────────────────

describe('context lines', () => {
  it('should add space-prefixed lines to both oldLines and newLines', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.py',
      '@@',
      ' context before',
      '-removed',
      '+added',
      ' context after',
      '*** End Patch',
    ].join('\n');

    const result = parsePatch(patch);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'update' }>;
    const chunk = hunk.chunks[0];

    expect(chunk.oldLines).toEqual(['context before', 'removed', 'context after']);
    expect(chunk.newLines).toEqual(['context before', 'added', 'context after']);
  });

  it('should handle bare empty lines as empty context lines', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      ' context before',
      '',
      ' context after',
      '*** End Patch',
    ].join('\n');

    const result = parsePatch(patch);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'update' }>;
    const chunk = hunk.chunks[0];

    expect(chunk.oldLines).toEqual(['context before', '', 'context after']);
    expect(chunk.newLines).toEqual(['context before', '', 'context after']);
  });
});

// ── Edge case: update hunk followed by another hunk ────────────────────────

describe('update hunk followed by another hunk', () => {
  it('should finalize update and start new hunk', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.py',
      '@@',
      '+line',
      '*** Add File: other.py',
      '+content',
      '*** End Patch',
    ].join('\n');

    const result = parsePatch(patch);
    expect(result.hunks).toHaveLength(2);

    const updateHunk = result.hunks[0] as Extract<PatchHunk, { type: 'update' }>;
    expect(updateHunk.type).toBe('update');
    expect(updateHunk.chunks[0].newLines).toEqual(['line']);

    const addHunk = result.hunks[1] as Extract<PatchHunk, { type: 'add' }>;
    expect(addHunk.type).toBe('add');
    expect(addHunk.contents).toBe('content\n');
  });
});

// ── Edge case: indented update markers as context ──────────────────────────

describe('indented update markers', () => {
  it('should treat indented *** Update File as context line', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@',
      '-old a',
      '+new a',
      ' *** Update File: b.txt',
      '@@',
      '-old b',
      '+new b',
      '*** End Patch',
    ].join('\n');

    const result = parsePatch(patch);
    expect(result.hunks).toHaveLength(1);

    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'update' }>;
    expect(hunk.chunks).toHaveLength(2);
    expect(hunk.chunks[0].oldLines).toEqual(['old a', '*** Update File: b.txt']);
    expect(hunk.chunks[0].newLines).toEqual(['new a', '*** Update File: b.txt']);
  });
});

// ── Error: missing Begin Patch ─────────────────────────────────────────────

describe('missing *** Begin Patch', () => {
  it('should throw ParseError', () => {
    expect(() => parsePatch('bad')).toThrow(ParseError);
    expect(() => parsePatch('bad')).toThrow(
      "The first line of the patch must be '*** Begin Patch'",
    );
  });
});

// ── Error: missing End Patch ───────────────────────────────────────────────

describe('missing *** End Patch', () => {
  it('should throw ParseError', () => {
    expect(() => parsePatch('*** Begin Patch\nbad')).toThrow(ParseError);
    expect(() => parsePatch('*** Begin Patch\nbad')).toThrow(
      "The last line of the patch must be '*** End Patch'",
    );
  });

  it('should reject an End Patch marker before the final line', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: first.txt',
      '+first',
      '*** End Patch',
      '*** Add File: second.txt',
      '+second',
      '*** End Patch',
    ].join('\n');

    expect(() => parsePatch(patch)).toThrow(ParseError);
    expect(() => parsePatch(patch)).toThrow(
      "'*** End Patch' must only appear as the last line of the patch",
    );
  });
});

// ── Error: empty update hunk ───────────────────────────────────────────────

describe('empty update hunk', () => {
  it('should throw ParseError for update with no chunks', () => {
    const patch = '*** Begin Patch\n*** Update File: test.py\n*** End Patch';
    expect(() => parsePatch(patch)).toThrow(ParseError);
    expect(() => parsePatch(patch)).toThrow(
      "Update file hunk for path 'test.py' is empty",
    );
  });

  it('should throw ParseError for update with Move to but no chunks', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: old.txt',
      '*** Move to: new.txt',
      '*** Delete File: other.txt',
      '*** End Patch',
    ].join('\n');
    expect(() => parsePatch(patch)).toThrow(ParseError);
  });

  it('should throw ParseError for @@ with no lines before End Patch', () => {
    const patch = '*** Begin Patch\n*** Update File: file.txt\n@@\n*** End Patch';
    expect(() => parsePatch(patch)).toThrow(ParseError);
    expect(() => parsePatch(patch)).toThrow('Update hunk does not contain any lines');
  });

  it('should throw ParseError for a dangling context hint', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@ functionName',
      '*** End Patch',
    ].join('\n');

    expect(() => parsePatch(patch)).toThrow(ParseError);
    expect(() => parsePatch(patch)).toThrow('Update hunk does not contain any lines');
  });
});

// ── Error: mismatched heredoc quotes ───────────────────────────────────────

describe('mismatched heredoc quotes', () => {
  it('should throw ParseError (not stripped)', () => {
    const innerPatch = [
      '*** Begin Patch',
      '*** Update File: file2.py',
      ' import foo',
      '+bar',
      '*** End Patch',
    ].join('\n');
    const wrapped = `<<"EOF'\n${innerPatch}\nEOF`;

    expect(() => parsePatch(wrapped)).toThrow(ParseError);
    expect(() => parsePatch(wrapped)).toThrow('is not a valid hunk header');
  });
});

// ── Error: invalid lines in add/delete mode ────────────────────────────────

describe('invalid lines in add/delete mode', () => {
  it('should throw for non-+ line in Add File', () => {
    const patch = '*** Begin Patch\n*** Add File: file.txt\nbad\n*** End Patch';
    expect(() => parsePatch(patch)).toThrow(ParseError);
  });

  it('should throw for any line after Delete File', () => {
    const patch = '*** Begin Patch\n*** Delete File: file.txt\nbad\n*** End Patch';
    expect(() => parsePatch(patch)).toThrow(ParseError);
  });
});

// ── Error: invalid line in update hunk ─────────────────────────────────────

describe('invalid line in update hunk', () => {
  it('should throw for unrecognized line after change lines', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      '-old',
      'bad',
      '*** End Patch',
    ].join('\n');
    expect(() => parsePatch(patch)).toThrow(ParseError);
    expect(() => parsePatch(patch)).toThrow(
      "Invalid hunk line prefix 'b' in 'bad'",
    );
  });

  it('should throw for consecutive @@ with empty chunk between', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      '@@',
      '*** End Patch',
    ].join('\n');
    expect(() => parsePatch(patch)).toThrow(ParseError);
  });
});

// ── Edge case: CRLF handling ───────────────────────────────────────────────

describe('CRLF handling', () => {
  it('should strip trailing \\r from lines', () => {
    const patch = '*** Begin Patch\r\n*** Update File: file.txt\r\n@@\r\n-old\r\n+new\r\n*** End Patch\r\n';
    const result = parsePatch(patch);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'update' }>;
    expect(hunk.chunks[0].oldLines).toEqual(['old']);
    expect(hunk.chunks[0].newLines).toEqual(['new']);
  });
});

// ── Edge case: leading/trailing whitespace on boundaries ───────────────────

describe('whitespace on boundaries', () => {
  it('should trim boundary markers', () => {
    const patch = ' *** Begin Patch \n*** Add File: foo\n+hi\n *** End Patch ';
    const result = parsePatch(patch);
    expect(result.hunks).toHaveLength(1);
  });
});

// ── ParseError properties ──────────────────────────────────────────────────

describe('ParseError', () => {
  it('should have correct name and lineNumber', () => {
    try {
      parsePatch('*** Begin Patch\n*** Update File: test.py\n*** End Patch');
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      const err = e as ParseError;
      expect(err.name).toBe('ParseError');
      expect(err.lineNumber).toBe(2);
    }
  });
});

// ── Lenient envelope repair ────────────────────────────────────────────────

describe('envelope repair', () => {
  it('synthesizes a missing *** Begin Patch marker', () => {
    const patch = [
      '*** Update File: file.txt',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    const result = parsePatch(patch);
    expect(result.hunks).toHaveLength(1);
    expect(result.patch.split('\n')[0]).toBe(BEGIN_PATCH_MARKER);
  });

  it('synthesizes a missing *** End Patch marker', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      '-old',
      '+new',
    ].join('\n');
    const result = parsePatch(patch);
    expect(result.hunks).toHaveLength(1);
    expect(result.patch.endsWith(END_PATCH_MARKER)).toBe(true);
  });

  it('synthesizes both markers when both are missing', () => {
    const patch = [
      '*** Add File: new.txt',
      '+content',
    ].join('\n');
    const result = parsePatch(patch);
    expect(result.hunks).toHaveLength(1);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'add' }>;
    expect(hunk.path).toBe('new.txt');
    expect(hunk.contents).toBe('content\n');
  });

  it('still rejects input without any file operation header', () => {
    expect(() => parsePatch('some prose\nwithout headers')).toThrow(
      "The first line of the patch must be '*** Begin Patch'",
    );
  });

  it('strips a markdown code fence wrapper', () => {
    const patch = [
      '```diff',
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
      '```',
    ].join('\n');
    const result = parsePatch(patch);
    expect(result.hunks).toHaveLength(1);
  });

  it('strips fences and repairs a missing Begin marker together', () => {
    const patch = [
      '```',
      '*** Update File: file.txt',
      '@@',
      '-old',
      '+new',
      '```',
    ].join('\n');
    const result = parsePatch(patch);
    expect(result.hunks).toHaveLength(1);
  });
});

// ── Lenient @@ markers ─────────────────────────────────────────────────────

describe('lenient @@ markers', () => {
  it('accepts @@hint without a space after the marker', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@function greet():',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    const result = parsePatch(patch);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'update' }>;
    expect(hunk.chunks[0].changeContext).toBe('function greet():');
  });

  it('treats an indented @@ line as content, not a header', () => {
    // A leading space always marks a content line, so an indented `@@` is
    // parsed as context (and will fail to match loudly) rather than being
    // misread as a chunk boundary that could corrupt content lines starting
    // with '@@'.
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@',
      '  @@ function greet():',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    const result = parsePatch(patch);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'update' }>;
    expect(hunk.chunks).toHaveLength(1);
    expect(hunk.chunks[0].oldLines).toEqual([' @@ function greet():', 'old']);
  });

  it('keeps a stacked hint when a bare @@ follows it', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.txt',
      '@@ class Foo',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    const result = parsePatch(patch);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'update' }>;
    expect(hunk.chunks).toHaveLength(1);
    expect(hunk.chunks[0].changeContext).toBe('class Foo');
    expect(hunk.chunks[0].oldLines).toEqual(['old']);
    expect(hunk.chunks[0].newLines).toEqual(['new']);
  });

  it('still treats prefixed @@ content lines as content', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: file.css',
      '@@',
      ' @@keyframes spin {',
      '-  from { opacity: 0; }',
      '+  from { opacity: 1; }',
      '*** End Patch',
    ].join('\n');
    const result = parsePatch(patch);
    const hunk = result.hunks[0] as Extract<PatchHunk, { type: 'update' }>;
    expect(hunk.chunks[0].oldLines).toEqual([
      '@@keyframes spin {',
      '  from { opacity: 0; }',
    ]);
  });
});
