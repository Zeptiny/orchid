import { describe, expect, it } from 'vitest';
import { genericAgentProjector } from '../../src/main/tools/result';
import type { CanonicalToolResult } from '../../src/shared/types/tool-result';

function errorCanonical(message: string): CanonicalToolResult {
  return {
    schemaVersion: 1,
    family: 'generic',
    status: 'error',
    completeness: 'complete',
    data: {
      value: message,
      origin: { kind: 'built-in', name: 'skill' },
    },
    error: { code: 'tool_error', message },
  } as CanonicalToolResult;
}

function completeCanonical(value: unknown, name: string): CanonicalToolResult {
  return {
    schemaVersion: 1,
    family: 'generic',
    status: 'complete',
    completeness: 'complete',
    data: { value, origin: { kind: 'built-in', name } },
  } as CanonicalToolResult;
}

describe('genericAgentProjector token trims', () => {
  it('renders string-valued error outcomes once (error element only)', () => {
    const message = "Error: skill 'x' does not exist.";
    const projection = genericAgentProjector(errorCanonical(message), 'skill');
    expect(projection.content).toContain('<error code="tool_error">');
    expect(projection.content).toContain(message);
    expect(projection.content).not.toContain('<data>');
    expect(projection.content.match(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')))
      .toHaveLength(1);
  });

  it('keeps the body for object-valued error outcomes', () => {
    const canonical = {
      ...errorCanonical('Tool execution failed.'),
      data: {
        value: { error: 'detail' },
        origin: { kind: 'built-in', name: 'find_symbol_references' },
      },
    } as CanonicalToolResult;
    const projection = genericAgentProjector(canonical, 'find_symbol_references');
    expect(projection.content).toContain('<error code="tool_error">');
  });

  it('renders string values as data for non-error statuses', () => {
    const projection = genericAgentProjector(
      completeCanonical('plain output', 'skill'),
      'skill',
    );
    expect(projection.content).toContain('<data>plain output</data>');
  });

  it('renders ask_question answers without echoing the questions', () => {
    const projection = genericAgentProjector(
      completeCanonical(
        {
          questions: [{
            type: 'single',
            title: 'Which database?',
            options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }],
          }],
          answers: [
            { selected: ['PostgreSQL'], text: 'hosted please', skipped: false },
            { selected: [], text: null, skipped: true },
          ],
        },
        'ask_question',
      ),
      'ask_question',
    );
    expect(projection.content).toContain('<answers count="2">');
    expect(projection.content).toContain('<answer selected="PostgreSQL">hosted please</answer>');
    expect(projection.content).toContain('<answer skipped="true" />');
    expect(projection.content).not.toContain('Which database?');
    expect(projection.content).not.toContain('SQLite');
  });

  it('renders ask_question cancellation without the questions payload', () => {
    const canonical = {
      ...completeCanonical({ questions: [{ type: 'single', title: 'Q?' }], answers: [], cancelled: true }, 'ask_question'),
      status: 'cancelled' as const,
    };
    const projection = genericAgentProjector(canonical, 'ask_question');
    expect(projection.content).toContain('status="cancelled"');
    expect(projection.content).not.toContain('Q?');
    expect(projection.content).not.toContain('<data>');
  });
});
