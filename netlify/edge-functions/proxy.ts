import { decryptJWE } from "../functions/mcp-server/utils.ts";
import {Config, Context} from '@netlify/edge-functions';


// The proxy is called with a JWE that has a accessToken inside.
// This is to allow us to give a short lived token to something external to
// the MCP server and use it to enrich requests
export default async (req: Request, ctx: Context) => {
  console.log('Received request for proxy');
  const token = ctx.params?.token as string;

  if (!token) {
    return new Response('Unauthorized', { status: 401 });
  }
  const decryptedToken = await decryptJWE(token);
  if (!decryptedToken || typeof decryptedToken.accessToken !== 'string' || !decryptedToken.apiPath) {
    return new Response('Unauthorized', { status: 401 });
  }

  console.log('Valid token, proceeding with proxy request', decryptedToken.apiPath);

  req.headers.set('Authorization', `Bearer ${decryptedToken.accessToken}`);
  req.headers.delete('host');

  // rewrite the URL to be api.netlify.com
  const url = new URL(decryptedToken.apiPath as string, 'https://api.netlify.com');

  const updatedReq = new Request(url, {
    method: decryptedToken.apiMethod as string | undefined || req.method,
    headers: req.headers,
    body: req.body,
    redirect: 'manual', // prevent automatic redirects
  });
  console.log('Updated request:', url.toString(), updatedReq.method);
  return fetch(updatedReq);
};

export const config: Config = {
  path: '/proxy/:token/*'
};
