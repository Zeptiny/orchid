import { describe, expect, it } from 'vitest';
import { classifyErrorKind } from '../../src/main/ipc/chat/stream';

describe('classifyErrorKind', () => {
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
