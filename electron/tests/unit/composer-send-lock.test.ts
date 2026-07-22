/**
 * Behavioral tests for InputArea send-lock release and send admission gates.
 */
import { describe, expect, it } from 'vitest';
import {
  evaluateComposerSend,
  shouldReleaseComposerSendLock,
} from '../../src/renderer/utils/composer-send-lock';

describe('shouldReleaseComposerSendLock', () => {
  it('holds the lock while streaming', () => {
    expect(shouldReleaseComposerSendLock('streaming', 'idle')).toBe(false);
  });

  it('holds the lock during first-phase cancel confirm even if status is not streaming', () => {
    expect(shouldReleaseComposerSendLock('idle', 'confirmAgent')).toBe(false);
    expect(shouldReleaseComposerSendLock('error', 'confirmAgent')).toBe(false);
  });

  it('releases on status error so a second send can proceed', () => {
    expect(shouldReleaseComposerSendLock('error', 'idle')).toBe(true);
    expect(shouldReleaseComposerSendLock('error', 'confirmSubagents')).toBe(true);
  });

  it('releases on idle / non-streaming residual states', () => {
    expect(shouldReleaseComposerSendLock('idle', 'idle')).toBe(true);
    expect(shouldReleaseComposerSendLock('idle', 'confirmSubagents')).toBe(true);
  });
});

describe('evaluateComposerSend (lock + gates)', () => {
  const ready = {
    trimmed: 'hello',
    isStreaming: false,
    isSending: false,
    workspaceBound: true,
    providerAvailable: true,
    modelSelected: true,
  };

  it('ignores empty input and held send lock', () => {
    expect(evaluateComposerSend({ ...ready, trimmed: '' }).action).toBe('ignore');
    expect(evaluateComposerSend({ ...ready, isSending: true }).action).toBe('ignore');
  });

  it('queues non-empty input during streaming', () => {
    expect(evaluateComposerSend({ ...ready, isStreaming: true }).action).toBe('queue');
  });

  it('ignores empty input during streaming', () => {
    expect(evaluateComposerSend({ ...ready, trimmed: '', isStreaming: true }).action).toBe(
      'ignore',
    );
  });

  it('ignores input during streaming when send lock is held', () => {
    expect(
      evaluateComposerSend({ ...ready, isStreaming: true, isSending: true }).action,
    ).toBe('ignore');
  });

  it('after error residual release (isSending false), second send is admitted', () => {
    // Simulates: first send set lock → status='error' released lock → retry.
    expect(
      evaluateComposerSend({
        ...ready,
        isSending: false,
        isStreaming: false,
      }).action,
    ).toBe('send');
  });

  it('blocks plain chat until workspace / provider / model gates pass', () => {
    expect(evaluateComposerSend({ ...ready, workspaceBound: false }).action).toBe(
      'pick-project',
    );
    expect(evaluateComposerSend({ ...ready, providerAvailable: false }).action).toBe(
      'open-providers',
    );
    expect(evaluateComposerSend({ ...ready, modelSelected: false }).action).toBe(
      'need-model',
    );
  });

  it('allows slash commands through workspace and provider gates', () => {
    expect(
      evaluateComposerSend({
        ...ready,
        trimmed: '/help',
        workspaceBound: false,
        providerAvailable: false,
        modelSelected: false,
      }).action,
    ).toBe('send');
  });

  it('still ignores slash while send lock is held', () => {
    expect(
      evaluateComposerSend({
        ...ready,
        trimmed: '/help',
        isSending: true,
      }).action,
    ).toBe('ignore');
  });
});
