/**
 * Shared reasoning-token estimation.
 *
 * When a provider does not report a reasoning-token count, both the
 * accounting ledger and the per-step usage surfaced to the renderer apportion
 * the provider's output-token total by the observed output characters. The
 * estimator lives here so the two paths stay identical.
 */

export interface ReasoningChars {
  reasoning: number;
  text: number;
  tool: number;
}

export function emptyReasoningChars(): ReasoningChars {
  return { reasoning: 0, text: 0, tool: 0 };
}

/**
 * Apportion the provider's output total by the observed output characters.
 * Returns undefined when the output total is unknown or no reasoning was
 * observed, so callers can keep "provider did not report" distinct from
 * "provider reported zero".
 */
export function estimateReasoningTokens(
  chars: ReasoningChars,
  outputTokens: number | undefined,
): number | undefined {
  if (outputTokens === undefined || outputTokens <= 0) return undefined;
  const totalChars = chars.reasoning + chars.text + chars.tool;
  if (chars.reasoning <= 0 || totalChars <= 0) return undefined;
  return Math.min(
    outputTokens,
    Math.round((outputTokens * chars.reasoning) / totalChars),
  );
}
