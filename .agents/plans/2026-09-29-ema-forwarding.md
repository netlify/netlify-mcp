---
name: 2026-09-29-ema-forwarding
created: 2026-09-29T15:42Z  by gpt-6-astra
updated: 2026-10-01T20:08Z  by gpt-6-astra
git_sha: 68f3c9f
audit:
  - 2026-09-29T15:42Z gpt-6-astra write (created)
  - 2026-09-29T16:02Z gpt-6-astra edit  (native patch; line delta unavailable)
  - 2026-10-01T20:08Z gpt-6-astra edit  (native patch; line delta unavailable)
  - 2026-10-01T20:08Z gpt-6-astra edit  (native patch; line delta unavailable)
---

# EMA forwarding draft

Implement MCP's side of a backend-owned exchange. The backend token endpoint remains unfinished, so this is an opt-in POC transport with no JWT-bearer discovery advertisement.

## Design position

1. A docs-only PR cannot verify byte-preserving forwarding or wrapper expiry. Add one transport function and a JWT-bearer dispatch branch.
2. The backend owns client authentication and proof verification. Its endpoint is pending; use a trusted server-configured endpoint, disabled when absent. Do not invent an IdP verifier or issuer registry in MCP.
3. This touches the OAuth token handler and JWE helper. Existing authorization-code and refresh behavior must keep passing. No provisioning or billing calls are added.
4. A single forwarding module can be deleted when a common proxy replaces it. It shares only the standard token response and the existing accessToken wrapper field.
5. The likely next change is the backend endpoint/authentication contract. Preserve the original form and client Authorization header; document that enabling requires a backend which actually authenticates Claude and binds the public audience.
6. Discovery stays unchanged even when the POC endpoint is configured. This is intentional until the real exchange passes. EMA access wrappers never mint refresh tokens.
7. Inject fetch into the transport for network tests. Validate the response at the boundary and pass an absolute expiry to the existing JWE function; policy and identity remain in the backend.

## Administrator setup and pilot requirements

The customer must enable the managed connector through Claude and its identity provider and enable the corresponding backend configuration. The configured client ID identifies the OAuth registration; the web/desktop registration relationship remains unconfirmed. MCP provides discovery and the authentication handoff to the application's login page. The backend owns identity verification, linking and provisioning policy.

Before enabling discovery, agree on request correlation with the backend and demonstrate analytics for successful exchanges and EMA tool use, plus diagnostic traces for denials. Use internal request identifiers and safe outcome codes; exclude assertions, tokens, secrets and raw identity claims. This draft does not implement that telemetry contract or administrator setup.

Provisioning and placement are backend concerns. Transport tests cannot establish provider interoperability, correct member placement, account lifecycle behavior or pilot readiness.

## Verification

Failing tests first: original form/header forwarding, no redirects, disabled route, OAuth errors, malformed success, expiry bound, and denied refresh. Then implement and run full tests, strict typecheck and build. Independent correctness audit before publishing the draft.

Kickoff: staff-engineering-mindset applies because this adds a service boundary. Why is unnecessary: the existing wrapper and dispatch were inspected during the prior POC. Grill is unnecessary: the service ownership and draft scope are approved. No SPA data loading is involved. The local kickoff receipt directory is denied by the sandbox; this file records the work order and design pass.
