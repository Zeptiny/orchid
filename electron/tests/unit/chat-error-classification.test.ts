import { describe, expect, it } from 'vitest';
import { classifyErrorKind } from '../../src/main/ipc/chat/stream';
import {
  isContextLengthExceededError,
  isContextLengthExceededMessage,
} from '../../src/main/llm/middleware/error-classification';

describe('classifyErrorKind', () => {
  describe('context_length_exceeded', () => {
    it('matches the provider error code in the detail', () => {
      expect(classifyErrorKind(null, 'provider returned context_length_exceeded')).toBe('context_length_exceeded');
    });

    it('matches "context window" phrasing regardless of case', () => {
      expect(classifyErrorKind('Context Window Exceeded', 'request too large')).toBe('context_length_exceeded');
    });

    it('matches "maximum context" phrasing', () => {
      expect(classifyErrorKind(null, 'This model supports a maximum context length of 200000 tokens')).toBe('context_length_exceeded');
    });

    it('takes precedence over rate-limit when both match', () => {
      expect(classifyErrorKind(null, '429 while the context window overflowed')).toBe('context_length_exceeded');
    });
  });

  describe('rate-limit', () => {
    it('matches "rate limit" in the detail', () => {
      expect(classifyErrorKind(null, 'Too many requests: rate limit exceeded')).toBe('rate-limit');
    });

    it('matches a 429 status in the detail', () => {
      expect(classifyErrorKind(null, 'HTTP 429 Too Many Requests')).toBe('rate-limit');
    });

    it('matches "usage limit" in the detail', () => {
      expect(classifyErrorKind(null, 'usage limit reached for this billing period')).toBe('rate-limit');
    });

    it('matches a keyword that appears only in the title', () => {
      expect(classifyErrorKind('429', 'slow down and retry')).toBe('rate-limit');
    });

    it('matches regardless of case', () => {
      expect(classifyErrorKind('Rate Limit', 'PLEASE SLOW DOWN')).toBe('rate-limit');
    });

    it('matches substrings such as "4290"', () => {
      expect(classifyErrorKind(null, 'processed 4290 tokens')).toBe('rate-limit');
    });
  });

  describe('auth', () => {
    it('matches "auth" inside "authentication"', () => {
      expect(classifyErrorKind(null, 'authentication failed for this account')).toBe('auth');
    });

    it('matches "auth" inside "unauthorized"', () => {
      expect(classifyErrorKind(null, 'unauthorized')).toBe('auth');
    });

    it('matches a 401 status', () => {
      expect(classifyErrorKind(null, 'HTTP 401 Unauthorized')).toBe('auth');
    });

    it('matches a 403 status', () => {
      expect(classifyErrorKind(null, 'HTTP 403 Forbidden')).toBe('auth');
    });

    it('matches "api key" in the detail', () => {
      expect(classifyErrorKind(null, 'invalid api key supplied')).toBe('auth');
    });

    it('matches "api key" from the title regardless of case', () => {
      expect(classifyErrorKind('API Key Error', 'check your settings')).toBe('auth');
    });
  });

  describe('stream', () => {
    it('matches "timeout"', () => {
      expect(classifyErrorKind(null, 'request timeout after 300s')).toBe('stream');
    });

    it('matches "timed out"', () => {
      expect(classifyErrorKind(null, 'the upstream connection timed out')).toBe('stream');
    });

    it('matches "network"', () => {
      expect(classifyErrorKind(null, 'network failure while streaming')).toBe('stream');
    });

    it('matches "connection"', () => {
      expect(classifyErrorKind(null, 'connection reset by peer')).toBe('stream');
    });

    it('matches a keyword that appears only in the title with an empty detail', () => {
      expect(classifyErrorKind('Connection lost', '')).toBe('stream');
    });

    it('matches regardless of case', () => {
      expect(classifyErrorKind(null, 'TIMEOUT')).toBe('stream');
    });
  });

  describe('generic fallback', () => {
    it('returns generic for an unrecognized message', () => {
      expect(classifyErrorKind(null, 'model returned an invalid response shape')).toBe('generic');
    });

    it('returns generic for a null title and empty detail', () => {
      expect(classifyErrorKind(null, '')).toBe('generic');
    });

    it('returns generic for an empty title and empty detail', () => {
      expect(classifyErrorKind('', '')).toBe('generic');
    });

    it('returns generic when no keyword appears in either field', () => {
      expect(classifyErrorKind('Something failed', 'unknown provider error')).toBe('generic');
    });
  });

  describe('title and detail concatenation', () => {
    it('detects a keyword split across title and detail', () => {
      expect(classifyErrorKind('rate', 'limit exceeded')).toBe('rate-limit');
    });

    it('detects "api key" split across title and detail', () => {
      expect(classifyErrorKind('api', 'key invalid')).toBe('auth');
    });

    it('treats an undefined title the same as a null title', () => {
      expect(classifyErrorKind(undefined, 'rate limit exceeded')).toBe('rate-limit');
      expect(classifyErrorKind(undefined, 'nothing recognizable here')).toBe('generic');
    });
  });

  describe('branch precedence', () => {
    it('prefers rate-limit over auth when both match', () => {
      expect(classifyErrorKind(null, '429 authentication failure')).toBe('rate-limit');
    });

    it('prefers auth over stream when both match', () => {
      expect(classifyErrorKind(null, 'connection timeout during auth handshake')).toBe('auth');
    });

    it('prefers auth over stream for 401 with a connection error', () => {
      expect(classifyErrorKind(null, '401 then connection refused')).toBe('auth');
    });

    it('prefers rate-limit over stream when both match', () => {
      expect(classifyErrorKind(null, 'usage limit hit after network timeout')).toBe('rate-limit');
    });
  });
});

describe('isContextLengthExceededError (overflow detection, P1 #14)', () => {
  describe('accepted phrasings', () => {
    it('matches the provider error code', () => {
      expect(isContextLengthExceededError('context_length_exceeded')).toBe(true);
    });

    it('matches "context length" phrasing', () => {
      expect(isContextLengthExceededError('This model maximum context length is 8192 tokens')).toBe(true);
    });

    it('matches "maximum context" phrasing', () => {
      expect(isContextLengthExceededError('maximum context of 200000 tokens exceeded by request')).toBe(true);
    });

    it('matches "context window" phrasing', () => {
      expect(isContextLengthExceededError('request exceeds the context window')).toBe(true);
    });

    it('matches "token limit" together with "exceeded"', () => {
      expect(isContextLengthExceededError('token limit exceeded for this request')).toBe(true);
    });

    it('matches "input is too long"', () => {
      expect(isContextLengthExceededError('the input is too long: 100000 tokens > 8192')).toBe(true);
    });

    it('matches "input too long"', () => {
      expect(isContextLengthExceededError('input too long for model')).toBe(true);
    });

    it('matches "prompt is too long"', () => {
      expect(isContextLengthExceededError('prompt is too long: 9000 tokens > 8000 maximum')).toBe(true);
    });

    it('matches "request too large"', () => {
      expect(isContextLengthExceededError('request too large')).toBe(true);
    });

    it('matches regardless of case', () => {
      expect(isContextLengthExceededError('CONTEXT WINDOW EXCEEDED')).toBe(true);
      expect(isContextLengthExceededError('Maximum Context Length')).toBe(true);
    });

    it('matches a keyword split across Error name and message', () => {
      const error = new Error('window exceeded');
      error.name = 'Context';
      expect(isContextLengthExceededError(error)).toBe(true);
    });
  });

  describe('false-positive controls', () => {
    it('rejects rate-limit text that mentions context or tokens', () => {
      expect(isContextLengthExceededError('rate limit reached after 1000 tokens, context is large')).toBe(false);
      expect(isContextLengthExceededError('429 too many requests')).toBe(false);
    });

    it('rejects "token limit" without "exceeded"', () => {
      expect(isContextLengthExceededError('token limit reached')).toBe(false);
      expect(isContextLengthExceededError('raised the token limit for this org')).toBe(false);
    });

    it('rejects generic provider errors', () => {
      expect(isContextLengthExceededError('internal server error')).toBe(false);
      expect(isContextLengthExceededError('model returned an invalid response shape')).toBe(false);
    });

    it('rejects auth and network text', () => {
      expect(isContextLengthExceededError('connection reset by peer')).toBe(false);
      expect(isContextLengthExceededError('authentication failed')).toBe(false);
    });

    it('rejects other "exceeded" errors that are not context-related', () => {
      expect(isContextLengthExceededError('maximum recursion depth exceeded')).toBe(false);
      expect(isContextLengthExceededError('quota exceeded for this account')).toBe(false);
    });

    it('rejects empty and nullish input', () => {
      expect(isContextLengthExceededError('')).toBe(false);
      expect(isContextLengthExceededError(null)).toBe(false);
      expect(isContextLengthExceededError(undefined)).toBe(false);
    });

    it('rejects non-string primitives', () => {
      expect(isContextLengthExceededError(429)).toBe(false);
      expect(isContextLengthExceededError(8192)).toBe(false);
    });
  });

  describe('non-string inputs', () => {
    it('matches an Error instance carrying overflow text', () => {
      expect(isContextLengthExceededError(new Error('context window overflow'))).toBe(true);
    });

    it('matches provider error objects with a code field', () => {
      expect(isContextLengthExceededError({ code: 'context_length_exceeded' })).toBe(true);
    });

    it('matches objects carrying overflow text in message/detail/title/error fields', () => {
      expect(isContextLengthExceededError({ message: 'input too long' })).toBe(true);
      expect(isContextLengthExceededError({ detail: 'prompt is too long' })).toBe(true);
      expect(isContextLengthExceededError({ title: 'Context Window Exceeded' })).toBe(true);
      expect(isContextLengthExceededError({ error: 'request too large' })).toBe(true);
    });

    it('rejects plain objects without overflow fields', () => {
      expect(isContextLengthExceededError({ status: 429, message: 'slow down' })).toBe(false);
    });

    it('isContextLengthExceededMessage wraps the same detection for joined strings', () => {
      expect(isContextLengthExceededMessage('Stream Error maximum context length is 2000 tokens')).toBe(true);
      expect(isContextLengthExceededMessage('Stream Error provider disconnected')).toBe(false);
      expect(isContextLengthExceededMessage(null)).toBe(false);
      expect(isContextLengthExceededMessage(undefined)).toBe(false);
    });
  });
});
