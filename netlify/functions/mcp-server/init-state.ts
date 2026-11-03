import { createHmac } from "crypto";
import { SignJWT, jwtVerify } from "jose";
import { getSecretKey } from "./utils.ts";

// The authorize request (client_id, redirect_uri, PKCE challenge, the client's
// own state) round-trips through app.netlify.com as the `state` parameter and
// comes back to /oauth-server/server-redirect, which mints the authorization
// code and sends it to that redirect_uri.
//
// It is SIGNED, not encrypted, on purpose. Netlify's consent screen decodes the
// payload and shows the user the origin the code will be sent to before they
// authorize. It doesn't need to verify the signature to do that safely:
// server-redirect refuses anything we didn't sign and only ever redirects to
// the redirect_uri inside the signed payload, so what the screen shows is
// exactly where the code goes. An attacker can't edit the destination (the
// signature breaks), and a state they get signed by running /authorize for their
// own client honestly shows their own origin.
//
// Payload contract with the Netlify UI (netlify-react-ui, the MCP first-party
// consent screen): a compact JWS whose payload is JSON with `v: 1` and a
// `redirect_uri` string. Bump `v` on any change the UI would need to know about.

export const INIT_STATE_VERSION = 1;

// Long enough to sign in to Netlify (including SSO) from the consent screen,
// short enough that a leaked state is of little use.
const INIT_STATE_TTL = '30m';

const INIT_STATE_TYP = 'mcp-init-state+jwt';

export interface AUTH_REQUEST_STATE {
  response_type: 'code';
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  state?: string;
  scope?: string;
  nonce?: string;
}

let cachedKey: Uint8Array | null = null;

/**
 * HMAC key derived from JWE_SECRET, so signing needs no new secret but never
 * uses the token encryption key directly.
 */
function getInitStateKey(): Uint8Array {
  if (!cachedKey) {
    cachedKey = new Uint8Array(createHmac('sha256', getSecretKey()).update('netlify-mcp/init-state/v1').digest());
  }
  return cachedKey;
}

export async function signInitState(state: AUTH_REQUEST_STATE): Promise<string> {
  return new SignJWT({ v: INIT_STATE_VERSION, ...state })
    .setProtectedHeader({ alg: 'HS256', typ: INIT_STATE_TYP })
    .setIssuedAt()
    .setExpirationTime(INIT_STATE_TTL)
    .sign(getInitStateKey());
}

/**
 * Verify a state from signInitState. Throws if it isn't ours, was altered or
 * has expired; the caller still validates the fields it relies on.
 */
export async function verifyInitState(initState: string): Promise<Partial<AUTH_REQUEST_STATE>> {
  const { payload } = await jwtVerify(initState, getInitStateKey(), {
    algorithms: ['HS256'],
    typ: INIT_STATE_TYP,
  });
  if (payload.v !== INIT_STATE_VERSION) {
    throw new Error(`unsupported init-state version: ${String(payload.v)}`);
  }
  return payload as Partial<AUTH_REQUEST_STATE>;
}
