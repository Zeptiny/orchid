/**
 * Newline-delimited JSON framing for the host protocol (issue #112, plan
 * 2026-08-23-001).
 *
 * Each frame is exactly one JSON document terminated by '\n'.
 * `createFrameDecoder` is a stateful push decoder accepting arbitrary string
 * chunks (frames may split mid-line across chunks) and returning every frame
 * completed by each push — the simplest shape that wires directly into a Node
 * stream's 'data'/'end' events without pulling stream types into the codec.
 */

/** Hard cap on one decoded frame (bytes), guarding decoder memory. */
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** Excerpt length a FrameDecodeError carries from the offending line. */
const DECODE_EXCERPT_LENGTH = 200;

/** Base class for framing violations. */
export class FrameError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FrameError';
  }
}

/** A frame (or accumulated partial frame) exceeded the configured byte cap. */
export class FrameTooLargeError extends FrameError {
  readonly frameBytes: number;
  readonly maxFrameBytes: number;

  constructor(frameBytes: number, maxFrameBytes: number) {
    super(`Frame of ${frameBytes} bytes exceeds the ${maxFrameBytes}-byte limit`);
    this.name = 'FrameTooLargeError';
    this.frameBytes = frameBytes;
    this.maxFrameBytes = maxFrameBytes;
  }
}

/** A complete line was not parseable JSON; carries the raw line excerpt. */
export class FrameDecodeError extends FrameError {
  /** First 200 characters of the offending line. */
  readonly excerpt: string;

  constructor(excerpt: string, options?: ErrorOptions) {
    super(`Frame is not valid JSON: ${excerpt}`, options);
    this.name = 'FrameDecodeError';
    this.excerpt = excerpt;
  }
}

/** Serialize one message as a frame: the JSON document plus a trailing '\n'. */
export function encodeMessage<T>(message: T): string {
  return `${JSON.stringify(message)}\n`;
}

export interface FrameDecoder {
  /**
   * Ingest one string chunk and return every frame the chunk completed.
   * Throws FrameTooLargeError / FrameDecodeError for violating lines.
   */
  push(chunk: string): unknown[];

  /** Signal end-of-stream; rejects a dangling partial frame. */
  finish(): void;
}

/**
 * Create a stateful newline-delimited JSON decoder. Blank lines between
 * frames are tolerated; frames longer than `maxFrameBytes` (default
 * MAX_FRAME_BYTES) — including an accumulated partial frame with no newline
 * yet — throw FrameTooLargeError so a hostile peer cannot grow the buffer
 * unbounded.
 */
export function createFrameDecoder(
  options: { maxFrameBytes?: number } = {},
): FrameDecoder {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  let pending = '';

  const decodeLine = (line: string): unknown => {
    const frameBytes = Buffer.byteLength(line, 'utf8');
    if (frameBytes > maxFrameBytes) {
      throw new FrameTooLargeError(frameBytes, maxFrameBytes);
    }
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new FrameDecodeError(line.slice(0, DECODE_EXCERPT_LENGTH), { cause: error });
    }
  };

  return {
    push(chunk: string): unknown[] {
      pending += chunk;
      const frames: unknown[] = [];
      let newlineIndex = pending.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        if (line.length > 0) {
          frames.push(decodeLine(line));
        }
        newlineIndex = pending.indexOf('\n');
      }
      const pendingBytes = Buffer.byteLength(pending, 'utf8');
      if (pendingBytes > maxFrameBytes) {
        throw new FrameTooLargeError(pendingBytes, maxFrameBytes);
      }
      return frames;
    },

    finish(): void {
      if (pending.length > 0) {
        throw new FrameDecodeError(pending.slice(0, DECODE_EXCERPT_LENGTH));
      }
    },
  };
}
