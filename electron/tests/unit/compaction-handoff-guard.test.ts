import { describe, expect, it } from 'vitest';
import {
  isSubstantiveHandoffText,
  MIN_HANDOFF_SUMMARY_CHARS,
} from '../../src/main/llm/compaction/summarize';

describe('isSubstantiveHandoffText', () => {
  it('rejects the degenerate reasoning tail observed in the wild', () => {
    // DeepSeek-V4-Flash spent 3,488 output tokens inside a stripped
    // <analysis> block and ended with a literal ellipsis; "..." was applied
    // as the handoff and the next step lost the task.
    expect(isSubstantiveHandoffText('...')).toBe(false);
    expect(isSubstantiveHandoffText('.  .  .')).toBe(false);
    expect(isSubstantiveHandoffText('— … —')).toBe(false);
  });

  it('rejects empty and whitespace-only text', () => {
    expect(isSubstantiveHandoffText('')).toBe(false);
    expect(isSubstantiveHandoffText('   \n\t  ')).toBe(false);
  });

  it('rejects text below the floor even when it carries real words', () => {
    const short = 'Summary: read files.'.repeat(4); // ~84 chars
    expect(short.length).toBeLessThan(MIN_HANDOFF_SUMMARY_CHARS);
    expect(isSubstantiveHandoffText(short)).toBe(false);
  });

  it('rejects a punctuation shell that clears the length floor', () => {
    const shell = '-'.repeat(MIN_HANDOFF_SUMMARY_CHARS + 50);
    expect(shell.length).toBeGreaterThan(MIN_HANDOFF_SUMMARY_CHARS);
    expect(isSubstantiveHandoffText(shell)).toBe(false);
  });

  it('accepts a real handoff paragraph', () => {
    const handoff = [
      '# Handoff Summary',
      '',
      '## Goal & Context',
      'User asked to explore the compaction system on the feat/session-compaction branch:',
      'trigger engine, select/apply pipeline, summarizer invocation, and IPC integration.',
      '',
      '## Files Read',
      '- electron/src/main/llm/compaction/trigger.ts — threshold + hysteresis decisions',
      '- electron/src/main/llm/compaction/apply.ts — flags + summary head persistence',
      '- electron/src/main/llm/compaction/summarize.ts — compactor LLM invocation',
      '',
      '## Remaining Work',
      'Renderer widget ordering and the subagent scope integration checks.',
    ].join('\n');
    expect(isSubstantiveHandoffText(handoff)).toBe(true);
  });

  it('collapses whitespace before measuring the floor', () => {
    const padded = 'Summary of the compacted range. '.repeat(10) + 'Detailed findings follow with file paths and decisions. '.repeat(3);
    expect(isSubstantiveHandoffText(`\n\n   ${padded}   \n\n`)).toBe(true);
  });
});
