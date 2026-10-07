// The design-import tool only ever fetches Claude Design exports, which are
// served from claude.ai itself or as short-lived signed URLs under
// *.claudeusercontent.com (Anthropic's isolated user-content domain).
// Restricting the fetch to those hosts closes SSRF: a caller can't point the
// server at internal services or any other host.

const ALLOWED_DESIGN_DOMAINS = ['claude.ai', 'claudeusercontent.com'];

// Used in the error returned to the calling agent, so the two valid origins are
// stated in one place.
export const ALLOWED_DESIGN_HOSTS_DESCRIPTION = `${ALLOWED_DESIGN_DOMAINS.join(', ')} and their subdomains`;

export function isAllowedDesignHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  // An exact match on the apex plus a `.`-prefixed suffix match for subdomains
  // keeps look-alikes (`evilclaudeusercontent.com`) and suffix-append tricks
  // (`claude.ai.evil.com`) out, and `URL.hostname` returns the real host
  // (userinfo such as `x@evil.com` resolves to `evil.com`), so an allowed name
  // can't be spoofed by embedding it.
  return ALLOWED_DESIGN_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
}
