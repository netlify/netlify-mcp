// The design-import tool only ever fetches Claude Design exports, which are
// served as short-lived signed URLs under *.claudeusercontent.com (Anthropic's
// isolated user-content domain). Restricting the fetch to that host closes SSRF:
// a caller can't point the server at internal services or any other host.

export function isAllowedDesignHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  // The leading dot keeps look-alikes like `evilclaudeusercontent.com` out, and
  // `URL.hostname` returns the real host (userinfo such as `x@evil.com` resolves
  // to `evil.com`), so the allowed name can't be spoofed by embedding it.
  return host === 'claudeusercontent.com' || host.endsWith('.claudeusercontent.com');
}
