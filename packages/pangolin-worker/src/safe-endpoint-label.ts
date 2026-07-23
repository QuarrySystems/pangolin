/**
 * A label for a notification endpoint that is safe to log, persist, and hand to
 * an operator. NEVER throws and NEVER returns the raw URL: a webhook can carry
 * credentials in userinfo, a query token, or a path segment.
 *
 * `new URL(u).origin` alone is unusable here — it raises ERR_INVALID_URL for
 * 'not-a-url', '', and '//example.com/x', and yields the literal string 'null'
 * for opaque-origin schemes (file:, data:). Verified on Node v22.20.0.
 *
 * `index` is a position within one reported fan-out, NOT a position in the
 * operator's config file — `matches` in notifications.ts is a flattened merge
 * of two sources, then filtered by event kind (spec §2.4).
 */
export function safeEndpointLabel(webhook: string, index: number): string {
  const fallback = `notification[${index}] <unparseable>`;
  try {
    const u = new URL(webhook);
    if (u.protocol !== "http:" && u.protocol !== "https:") return fallback;
    // .origin strips userinfo; it keeps a non-default port, which is not credential-bearing.
    return u.origin;
  } catch {
    return fallback;
  }
}
