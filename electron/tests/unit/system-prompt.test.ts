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
          toolCallId: 'tc-1',
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
      '<pending_question subagent_id="sa-1" name="review auth" type="code-reviewer">',
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
          toolCallId: 'tc-1',
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
    expect(prompt).toContain('title="Say &quot;hi&quot; &amp; &lt;bye&gt;"');
    expect(prompt).toContain('label="A &quot;quoted&quot; &amp; &lt;tagged&gt;"');
  });
});
