/**
 * Poll a single deploy-status check for the CLI deploy watcher (`--proxy-path`
 * mode in netlify-mcp.ts).
 *
 * This intentionally NEVER throws: the watcher runs it from a bare
 * `setInterval(async …)` with no surrounding boundary, so a rejected `fetch()`
 * or a non-JSON body from `.json()` would otherwise become an unhandled
 * rejection and terminate the process mid-deploy. Transient failures are
 * returned as a `poll-error` result so the caller can log and keep polling.
 */
export type DeployStatusResult =
  | { kind: 'ready'; deploy: any }
  | { kind: 'error' }
  | { kind: 'pending'; state: string }
  | { kind: 'unavailable'; statusText: string }
  | { kind: 'poll-error'; message: string };

export async function checkDeployStatus(deployEndpoint: string): Promise<DeployStatusResult> {
  try {
    const deployLookup = await fetch(deployEndpoint);
    if (!deployLookup.ok) {
      return { kind: 'unavailable', statusText: deployLookup.statusText };
    }

    const deploy = await deployLookup.json();
    if (deploy.state === 'ready') {
      return { kind: 'ready', deploy };
    }
    if (deploy.state === 'error') {
      return { kind: 'error' };
    }
    return { kind: 'pending', state: deploy.state };
  } catch (error) {
    return { kind: 'poll-error', message: error instanceof Error ? error.message : String(error) };
  }
}
