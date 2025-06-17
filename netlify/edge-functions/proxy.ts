import { decryptJWE } from "../functions/mcp-server/utils.js";
import {Config} from '@netlify/edge-functions';


// The proxy is called with a JWE that has a accessToken inside.
// This is to allow us to give a short lived token to something external to
// the MCP server and use it to enrich requests
export default async (req: Request) => {

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    return new Response('Unauthorized', { status: 401 });
  }

  const token = authHeader.replace('Bearer ', '');
  const decryptedToken = await decryptJWE(token);
  if (!decryptedToken || typeof decryptedToken.accessToken !== 'string') {
    return new Response('Unauthorized', { status: 401 });
  }

  req.headers.set('Authorization', `Bearer ${decryptedToken.accessToken}`);

  // rewrite the URL to be api.netlify.com
  const url = new URL(req.url);
  url.hostname = 'api.netlify.com';
  url.protocol = 'https:';
  url.pathname = url.pathname.replace('/proxy', ''); // remove the /proxy prefix

  const updatedReq = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    redirect: 'manual', // prevent automatic redirects
  });

  // Continue with the request
  return await fetch(updatedReq);
};

export const config: Config = {
  path: '/proxy/*'
};
