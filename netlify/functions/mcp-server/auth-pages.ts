import type { HandlerResponse } from "@netlify/functions";

// What a person sees in the browser while connecting an MCP client. The
// consent, callback and handoff endpoints are reached by a browser, so a dead
// end there is a page that says what happened and what to do next; the token,
// registration and revocation endpoints are called by programs and keep their
// JSON errors.

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));
}

export const PAGE_SECURITY_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  // No form-action: Chrome applies it to the 302 a form post is answered
  // with, and both pages legitimately redirect off-origin (to Netlify, and to
  // the client's registered callback). CSRF is the cookie-derived token.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

// Colours are chosen for WCAG AA: the primary button is white on #006b68
// (6.4:1), the secondary button's border is #6b7780 on white (4.6:1, above the
// 3:1 required for a control's boundary), and focus is a 3px #0b4f8a ring.
export const PAGE_STYLES = `
  body { font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; background: #f4f5f7; color: #0e1e25; }
  main { max-width: 36rem; margin: 3rem auto; background: #fff; border-radius: 12px; padding: 2rem; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; overflow-wrap: anywhere; }
  h2 { font-size: 1rem; margin: 1.5rem 0 .5rem; }
  .badge { padding: .6rem .8rem; border-radius: 8px; font-size: .95rem; }
  .ok { background: #e6f7ee; color: #0b5d34; }
  .warn { background: #fff4e5; color: #7a3e00; }
  .dest { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; background: #f4f5f7; padding: .6rem .8rem; border-radius: 8px; }
  .dest strong { color: #0b4f8a; }
  ul { padding-left: 1.2rem; }
  .actions { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1.5rem; }
  button { font: inherit; padding: .7rem 1.2rem; border-radius: 8px; border: 1px solid #6b7780; background: #fff; color: #0e1e25; cursor: pointer; }
  button.primary { background: #006b68; border-color: #006b68; color: #fff; }
  button:focus-visible { outline: 3px solid #0b4f8a; outline-offset: 2px; }
  .fine { font-size: .85rem; color: #4d5a62; margin-top: 1.5rem; }
  @media (max-width: 30rem) {
    main { margin: 0; border-radius: 0; padding: 1.25rem; min-height: 100vh; box-sizing: border-box; }
    .actions button { flex: 1 1 100%; }
  }
`;

export function pageShell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Netlify MCP</title>
<style>${PAGE_STYLES}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

export type BrowserState =
  | 'expired'
  | 'other_browser'
  | 'unknown'
  | 'not_approved'
  | 'finished'
  | 'cancelled'
  | 'upstream_cancelled'
  | 'no_token'
  | 'conflict'
  | 'unavailable'
  | 'method';

const START_AGAIN = 'Go back to the application you were connecting and start the connection again.';

const STATES: Record<BrowserState, { title: string; message: string; next: string }> = {
  expired: {
    title: 'This sign-in request expired',
    message: 'Sign-in requests are only valid for a short time, and this one ran out before it finished.',
    next: START_AGAIN,
  },
  other_browser: {
    title: 'Finish signing in where you started',
    message: 'This sign-in was started in a different browser or browser profile, or this browser is not keeping cookies for this site. For your safety it can only be finished where it began.',
    next: 'Return to the browser you started in, or start the connection again from the application here.',
  },
  unknown: {
    title: 'We could not find this sign-in request',
    message: 'The link is incomplete, or the request is too old to be found.',
    next: START_AGAIN,
  },
  not_approved: {
    title: 'This sign-in was not approved',
    message: 'Netlify MCP did not get your approval for this request in this browser, so it has not connected anything.',
    next: START_AGAIN,
  },
  finished: {
    title: 'This sign-in is already finished',
    message: 'The application was already sent its sign-in for this request. Nothing else needs to happen on this page.',
    next: 'You can close this tab. If the application still says it is not connected, start the connection again from the application.',
  },
  cancelled: {
    title: 'Sign-in cancelled',
    message: 'This request was cancelled, and the application was not given access to your Netlify account.',
    next: 'You can close this tab. To connect after all, start again from the application.',
  },
  upstream_cancelled: {
    title: 'Netlify sign-in was cancelled',
    message: 'Netlify did not complete the sign-in, so the application was not given access to your account.',
    next: START_AGAIN,
  },
  no_token: {
    title: 'Sign-in did not finish',
    message: 'Netlify returned to this page without a sign-in, so there is nothing to pass on to the application.',
    next: START_AGAIN,
  },
  conflict: {
    title: 'This sign-in was answered in another tab',
    message: 'Another tab or a second click answered this request at the same moment.',
    next: 'Reload this page to see where the request stands, or start again from the application.',
  },
  unavailable: {
    title: 'Netlify MCP cannot finish sign-in right now',
    message: 'The service that records sign-ins did not answer, so nothing was approved or issued.',
    next: 'Wait a minute and reload this page. If it keeps happening, start again from the application later.',
  },
  method: {
    title: 'Nothing to do here',
    message: 'This address only finishes a sign-in that Netlify sends back, and cannot be opened on its own.',
    next: START_AGAIN,
  },
};

/** A full-page answer for a browser that reached a dead end in the flow. */
export function statePage(state: BrowserState, statusCode: number, extraHeaders: Record<string, string> = {}): HandlerResponse {
  const { title, message, next } = STATES[state];
  return {
    statusCode,
    headers: { ...PAGE_SECURITY_HEADERS, ...extraHeaders },
    body: pageShell(title, `  <h1 data-state="${state}">${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  <p>${escapeHtml(next)}</p>`),
  };
}

/** A browser navigation asks for HTML; a program calling the endpoint usually does not. */
export function wantsHtml(req: Request): boolean {
  return (req.headers.get('accept') ?? '').toLowerCase().includes('text/html');
}

export function minutesLeft(expiresAt: number, now = Date.now()): number {
  return Math.max(1, Math.ceil((expiresAt - now) / 60_000));
}
