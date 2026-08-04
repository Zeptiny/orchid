/**
 * stripAnsi — remove ANSI escape sequences for display.
 *
 * Scope: CSI sequences (`ESC [` params/intermediates → final byte), which
 * cover SGR colors, cursor movement, and erase operations, plus OSC
 * window-title sequences (`ESC ] … BEL|ST`). Other escape forms (charset
 * shifts, bare two-byte ESC codes) pass through untouched. Display-path only —
 * agent-visible buffers and canonical results stay raw.
 */

const ANSI_SEQUENCE_RE = new RegExp(
  [
    // CSI: ESC [ <param 0x30–0x3F>* <intermediate 0x20–0x2F>* <final 0x40–0x7E>
    '\\u001b\\[[0-9;?]*[ -/]*[@-~]',
    // OSC: ESC ] <payload without BEL/ESC> terminated by BEL or ST (ESC \)
    '\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)',
  ].join('|'),
  'g',
);

/** Return `text` with CSI/SGR and OSC escape sequences removed. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE_RE, '');
}
