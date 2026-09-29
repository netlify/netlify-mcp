---
name: 2026-09-29-ema-forwarding
created: 2026-09-29T15:42Z  by gpt-6-astra
updated: 2026-09-29T15:42Z  by gpt-6-astra
git_sha: 7bbb718
audit:
  - 2026-09-29T15:42Z gpt-6-astra write (created)
---

# EMA forwarding draft

Implement MCP's side of the BitBalloon-owned exchange. The BitBalloon token endpoint remains unfinished, so this is an opt-in POC transport with no JWT-bearer discovery advertisement.

## Design position

1. A docs-only PR cannot verify byte-preserving forwarding or wrapper expiry. Add one transport function and a JWT-bearer dispatch branch.
2. BitBalloon's ownership is settled. Its endpoint and client authentication are pending; use a trusted server-configured endpoint, disabled when absent. Do not invent an IdP verifier or issuer registry in MCP.
3. This touches the OAuth token handler and JWE helper. Existing authorization-code and refresh behavior must keep passing. No provisioning or billing calls are added.
4. A single forwarding module can be deleted when a common proxy replaces it. It shares only the standard token response and the existing accessToken wrapper field.
5. The likely next change is the backend endpoint/authentication contract. Preserve the original form and client Authorization header; document that enabling requires a backend which actually authenticates Claude and binds the public audience.
6. Discovery stays unchanged even when the POC endpoint is configured. This is intentional until the real exchange passes. EMA access wrappers never mint refresh tokens.
7. Inject fetch into the transport for network tests. Validate the response at the boundary and pass an absolute expiry to the existing JWE function; policy and identity remain in BitBalloon.

## Verification

Failing tests first: original form/header forwarding, no redirects, disabled route, OAuth errors, malformed success, expiry bound, and denied refresh. Then implement and run full tests, strict typecheck and build. Independent correctness audit before publishing the draft.

Kickoff: staff-engineering-mindset applies because this adds a service boundary. Why is unnecessary: the existing wrapper and dispatch were inspected during the prior POC. Grill is unnecessary: the service ownership and draft scope are approved. No SPA data loading is involved. The local kickoff receipt directory is denied by the sandbox; this file records the work order and design pass.
