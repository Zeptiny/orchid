/**
 * HeadTailBuffer — ring buffer that keeps the first and last ~512 KiB.
 *
 * Total storage never exceeds ~1 MiB. Chunks are stored as a list and only
 * concatenated when a snapshot (head/tail/getTail) is requested, so append()
 * stays O(1) amortised even under high-output streams.
 *
 * Ported from Python `src/orchid/tools/background_store.py` HeadTailBuffer.
 */

const DEFAULT_HEAD_CAP = 512 * 1024; // 512 KiB
const DEFAULT_TAIL_CAP = 512 * 1024; // 512 KiB

function resolveCaps(): { headCap: number; tailCap: number } {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getConfig } = require('../../config/loader') as typeof import('../../config/loader');
    const cfg = getConfig();
    return { headCap: cfg.bg_output_head_bytes, tailCap: cfg.bg_output_tail_bytes };
  } catch {
    return { headCap: DEFAULT_HEAD_CAP, tailCap: DEFAULT_TAIL_CAP };
  }
}

export class HeadTailBuffer {
  private readonly _headCap: number;
  private readonly _tailCap: number;
  private readonly _totalCap: number;

  /** Frozen first headCap bytes once the total cap is exceeded. */
  private _head: Buffer = Buffer.alloc(0);
  private _headLocked = false;

  /** Pre-lock accumulation (under totalCap) as a chunk list. */
  private _preLockChunks: Buffer[] = [];
  private _preLockLength = 0;

  /** Post-lock / overflow tail as a chunk list, trimmed to tailCap. */
  private _tailChunks: Buffer[] = [];
  private _tailLength = 0;

  private _totalWritten = 0;

  constructor(headCap?: number, tailCap?: number) {
    const caps = headCap !== undefined || tailCap !== undefined
      ? { headCap: headCap ?? DEFAULT_HEAD_CAP, tailCap: tailCap ?? DEFAULT_TAIL_CAP }
      : resolveCaps();
    this._headCap = caps.headCap;
    this._tailCap = caps.tailCap;
    this._totalCap = caps.headCap + caps.tailCap;
  }

  /** Append data to the buffer, respecting the hard cap. */
  append(data: Buffer): void {
    if (data.length === 0) return;
    // Own a copy — Node stream chunks may be reused after the listener returns.
    const owned = Buffer.from(data);
    this._totalWritten += owned.length;

    if (this._headLocked) {
      // Head already locked — all new data goes to tail.
      this._pushTail(owned);
      return;
    }

    this._preLockChunks.push(owned);
    this._preLockLength += owned.length;

    if (this._preLockLength <= this._totalCap) {
      return;
    }

    // Over cap — materialize once, split into head (first headCap) and tail.
    const combined = Buffer.concat(this._preLockChunks, this._preLockLength);
    this._preLockChunks = [];
    this._preLockLength = 0;
    this._head = Buffer.from(combined.subarray(0, this._headCap));
    this._headLocked = true;

    if (combined.length <= this._totalCap) {
      this._pushTail(Buffer.from(combined.subarray(this._headCap)));
    } else {
      this._pushTail(Buffer.from(combined.subarray(combined.length - this._tailCap)));
    }
  }

  /**
   * Return the tail portion as a UTF-8 string.
   *
   * If lastN is given, return only the last lastN newline-delimited
   * lines from the tail buffer.
   */
  getTail(lastN?: number): string {
    let raw = this._materializeTail();
    if (lastN !== undefined && lastN >= 0) {
      raw = this._tailLastNLines(raw, lastN);
    }
    return raw.toString('utf-8');
  }

  /** Total bytes stored in head + tail. */
  totalBytes(): number {
    if (!this._headLocked) {
      return this._preLockLength;
    }
    return this._head.length + this._tailLength;
  }

  /** Total bytes ever written (before dropping). */
  get totalWritten(): number {
    return this._totalWritten;
  }

  /** For testing: expose head buffer. */
  get head(): Buffer {
    if (!this._headLocked) {
      // Pre-lock: no frozen head yet (legacy: head is empty while under cap).
      return Buffer.alloc(0);
    }
    return this._head;
  }

  /** For testing: expose tail buffer. */
  get tail(): Buffer {
    return this._materializeTail();
  }

  private _pushTail(data: Buffer): void {
    if (data.length === 0) return;
    // Caller must pass owned buffers (append copies on ingest).
    if (data.length >= this._tailCap) {
      this._tailChunks = [Buffer.from(data.subarray(data.length - this._tailCap))];
      this._tailLength = this._tailCap;
      return;
    }
    this._tailChunks.push(data);
    this._tailLength += data.length;
    this._trimTail();
  }

  private _trimTail(): void {
    while (this._tailLength > this._tailCap && this._tailChunks.length > 0) {
      const excess = this._tailLength - this._tailCap;
      const first = this._tailChunks[0];
      if (first.length <= excess) {
        this._tailChunks.shift();
        this._tailLength -= first.length;
      } else {
        this._tailChunks[0] = Buffer.from(first.subarray(excess));
        this._tailLength -= excess;
        break;
      }
    }
  }

  private _materializeTail(): Buffer {
    if (!this._headLocked) {
      // Under cap, all data lives in pre-lock chunks (legacy "tail").
      if (this._preLockLength === 0) return Buffer.alloc(0);
      return Buffer.concat(this._preLockChunks, this._preLockLength);
    }
    if (this._tailLength === 0) return Buffer.alloc(0);
    return Buffer.concat(this._tailChunks, this._tailLength);
  }

  private _tailLastNLines(tail: Buffer, n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    const text = tail.toString('utf-8');
    // Filter out empty trailing element from split (matches Python splitlines behavior)
    const lines = text.split('\n').filter((l, i, arr) => i < arr.length - 1 || l !== '');
    const selected = lines.slice(-n);
    const result = selected.join('\n');
    // Preserve trailing newline if the original text had one
    if (text.endsWith('\n')) return Buffer.from(result + '\n', 'utf-8');
    return Buffer.from(result, 'utf-8');
  }
}

const HEAD_CAP = DEFAULT_HEAD_CAP;
const TAIL_CAP = DEFAULT_TAIL_CAP;
const TOTAL_CAP = HEAD_CAP + TAIL_CAP;
export { HEAD_CAP, TAIL_CAP, TOTAL_CAP };
