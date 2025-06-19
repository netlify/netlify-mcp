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
  if (!decryptedToken || typeof decryptedToken.accessToken !== 'string') {
    return new Response('Unauthorized', { status: 401 });
  }
  
  const requestedPath = req.url.split(token)[1];

  if (Array.isArray(decryptedToken.apisAllowed)) {
    const isAllowed = decryptedToken.apisAllowed.some(({ path, method }: { path: string; method: string; }) => {
      const regex = new RegExp(path.replace(/:\w+/g, '[\\w-_]+'));
      const pathMatches = regex.test(requestedPath);
      return pathMatches && method === req.method;
    });

    if (!isAllowed) {
      console.error('Unauthorized access attempt to path:', requestedPath, decryptedToken.apisAllowed);
      return new Response('Forbidden', { status: 403 });
    }
  }
  
  console.log('Valid token and allowed path, proceeding with proxy request', requestedPath);

  req.headers.set('Authorization', `Bearer ${decryptedToken.accessToken}`);
  req.headers.delete('host');

  // rewrite the URL to be api.netlify.com
  const url = new URL(requestedPath as string, 'https://api.netlify.com');

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
