const NUMERIC_RE = /^\d+$/;
const NUMERIC_MIN = 1;
const NUMERIC_MAX = 1_000_000;

export function parseReasoningNumeric(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!NUMERIC_RE.test(trimmed)) return null;
  const num = Number(trimmed);
  if (num < NUMERIC_MIN || num > NUMERIC_MAX) return null;
  return num;
}
