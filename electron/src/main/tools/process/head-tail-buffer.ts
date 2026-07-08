/**
 * HeadTailBuffer — ring buffer that keeps the first and last ~512 KiB.
 *
 * Total storage never exceeds ~1 MiB. append() is O(1) amortised for the
 * common case (under cap); when the cap is hit the head is trimmed to
 * exactly HEAD_CAP bytes and the remainder lands in the tail.
 *
 * Ported from Python `src/orchid/tools/background_store.py` HeadTailBuffer.
 */

const HEAD_CAP = 512 * 1024; // 512 KiB
const TAIL_CAP = 512 * 1024; // 512 KiB
const TOTAL_CAP = HEAD_CAP + TAIL_CAP; // ~1 MiB hard cap

export class HeadTailBuffer {
  private _head: Buffer = Buffer.alloc(0);
  private _tail: Buffer = Buffer.alloc(0);
  private _totalWritten = 0;

  /** Append data to the buffer, respecting the hard cap. */
  append(data: Buffer): void {
    if (data.length === 0) return;
    this._totalWritten += data.length;

    if (this._head.length > 0) {
      // Head already locked — all new data goes to tail.
      this._tail = Buffer.concat([this._tail, data]);
      if (this._tail.length > TAIL_CAP) {
        this._tail = this._tail.subarray(this._tail.length - TAIL_CAP);
      }
      return;
    }

    if (this._head.length + this._tail.length + data.length <= TOTAL_CAP) {
      // Still under the cap — append to tail.
      this._tail = Buffer.concat([this._tail, data]);
      return;
    }

    // Over cap — merge everything into a single working buffer, split into
    // head (first HEAD_CAP) and tail (last TAIL_CAP).
    const combined = Buffer.concat([this._head, this._tail, data]);
    if (combined.length <= TOTAL_CAP) {
      // Edge case: merging freed enough room.
      this._head = combined.subarray(0, HEAD_CAP);
      this._tail = combined.subarray(HEAD_CAP);
    } else {
      this._head = combined.subarray(0, HEAD_CAP);
      this._tail = combined.subarray(combined.length - TAIL_CAP);
    }
  }

  /**
   * Return the tail portion as a UTF-8 string.
   *
   * If lastN is given, return only the last lastN newline-delimited
   * lines from the tail buffer.
   */
  getTail(lastN?: number): string {
    let raw = this._tail;
    if (lastN !== undefined && lastN >= 0) {
      raw = this._tailLastNLines(lastN);
    }
    return raw.toString('utf-8');
  }

  /** Total bytes stored in head + tail. */
  totalBytes(): number {
    return this._head.length + this._tail.length;
  }

  /** Total bytes ever written (before dropping). */
  get totalWritten(): number {
    return this._totalWritten;
  }

  /** For testing: expose head buffer. */
  get head(): Buffer {
    return this._head;
  }

  /** For testing: expose tail buffer. */
  get tail(): Buffer {
    return this._tail;
  }

  private _tailLastNLines(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    const text = this._tail.toString('utf-8');
    // Filter out empty trailing element from split (matches Python splitlines behavior)
    const lines = text.split('\n').filter((l, i, arr) => i < arr.length - 1 || l !== '');
    const selected = lines.slice(-n);
    const result = selected.join('\n');
    // Preserve trailing newline if the original text had one
    if (text.endsWith('\n')) return Buffer.from(result + '\n', 'utf-8');
    return Buffer.from(result, 'utf-8');
  }
}

export { HEAD_CAP, TAIL_CAP, TOTAL_CAP };
