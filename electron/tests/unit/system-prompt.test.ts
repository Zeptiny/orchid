/**
 * Dynamic system prompt rendering — pending subagent questions (U8).
 */
import { describe, it, expect } from 'vitest';
import { buildDynamicSystemPrompt } from '../../src/main/llm/system-prompt';

describe('buildDynamicSystemPrompt — pendingSubagentQuestions', () => {
  it('renders a pending_subagent_questions section when questions exist', () => {
    const prompt = buildDynamicSystemPrompt({
      cwd: '/tmp',
      pendingSubagentQuestions: [
        {
          subagentId: 'sa-1',
          name: 'review auth',
          type: 'code-reviewer',
          toolCallId: 'tc-&"1',
          questions: [
            {
              type: 'single',
              title: 'Which framework?',
              description: 'Pick one',
              options: [
                { label: 'React', description: 'A UI library' },
                { label: 'Vue' },
              ],
            },
          ],
        },
      ],
    });

    expect(prompt).toContain('<pending_subagent_questions>');
    expect(prompt).toContain(
      '<pending_question subagent_id="sa-1" tool_call_id="tc-&amp;&quot;1" name="review auth" type="code-reviewer">',
    );
    expect(prompt).toContain(
      '<question type="single" title="Which framework?" description="Pick one">',
    );
    expect(prompt).toContain('<option label="React" description="A UI library"/>');
    expect(prompt).toContain('<option label="Vue"/>');
    expect(prompt).toContain('</pending_subagent_questions>');
  });

  it('omits the section when there are no pending questions', () => {
    const prompt = buildDynamicSystemPrompt({ cwd: '/tmp', pendingSubagentQuestions: [] });
    expect(prompt).not.toContain('<pending_subagent_questions>');
  });

  it('escapes XML special characters in attribute values', () => {
    const prompt = buildDynamicSystemPrompt({
      cwd: '/tmp',
      pendingSubagentQuestions: [
        {
          subagentId: 'sa-1',
          name: 'a & b <c>',
          type: 'code-reviewer',
          toolCallId: 'tc-1 & "quoted"',
          questions: [
            {
              type: 'single',
              title: 'Say "hi" & <bye>',
              options: [{ label: 'A "quoted" & <tagged>' }],
            },
          ],
        },
      ],
    });

    expect(prompt).toContain('name="a &amp; b &lt;c&gt;"');
    expect(prompt).toContain('tool_call_id="tc-1 &amp; &quot;quoted&quot;"');
    expect(prompt).toContain('title="Say &quot;hi&quot; &amp; &lt;bye&gt;"');
    expect(prompt).toContain('label="A &quot;quoted&quot; &amp; &lt;tagged&gt;"');
  });
});

/**
 * R14 — stable-prefix order. The static system prompt (agent instructions +
 * OS identity) must precede every volatile, per-turn dynamic block so explicit
 * cache breakpoints on the prefix survive turn-to-turn. New dynamic context
 * belongs in the dynamic region only.
 */
describe('buildSystemPrompt — stable prefix order (R14)', () => {
  it('places the static instructions before all dynamic context', async () => {
    const { buildSystemPrompt } = await import('../../src/main/llm/system-prompt');
    const prompt = buildSystemPrompt('You are a helpful assistant.', {
      cwd: '/tmp/project',
      directoryTree: 'src/\n  index.ts',
      todos: [{ id: 't1', title: 'task', status: 'pending' }],
      subagents: [{ id: 'sa1', name: 'review', type: 'code-reviewer', state: 'running', elapsed: 3 }],
      backgroundCommands: [],
    });

    const staticIdx = prompt.indexOf('<instructions>');
    const osIdx = prompt.indexOf('<user_operating_system>');
    const timeIdx = prompt.indexOf('<current_time>');
    const cwdIdx = prompt.indexOf('<working_directory>');
    const treeIdx = prompt.indexOf('<directory_structure>');
    const todosIdx = prompt.indexOf('<todos>');
    const subagentsIdx = prompt.indexOf('<subagents>');

    // Static prefix first…
    expect(staticIdx).toBeGreaterThanOrEqual(0);
    expect(osIdx).toBeGreaterThan(staticIdx);
    // …then every dynamic block after it, in a stable relative order.
    for (const dynamicIdx of [timeIdx, cwdIdx, treeIdx, todosIdx, subagentsIdx]) {
      expect(dynamicIdx).toBeGreaterThan(osIdx);
    }
    expect(cwdIdx).toBeGreaterThan(timeIdx);
    expect(treeIdx).toBeGreaterThan(cwdIdx);
    expect(subagentsIdx).toBeGreaterThan(treeIdx);
    expect(todosIdx).toBeGreaterThan(subagentsIdx);
  });

  it('keeps instructions identical across turns when only dynamic context changes', async () => {
    const { buildStaticSystemPrompt } = await import('../../src/main/llm/system-prompt');
    // The cached prefix is the static prompt; it must not embed volatile data.
    const first = buildStaticSystemPrompt('Be brief.');
    const second = buildStaticSystemPrompt('Be brief.');
    expect(first).toBe(second);
    expect(first).not.toContain('<current_time>');
    expect(first).not.toContain('<working_directory>');
  });
});
