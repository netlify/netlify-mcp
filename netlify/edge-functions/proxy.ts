import { decryptJWE } from "../functions/mcp-server/utils.ts";
import {Config, Context} from '@netlify/edge-functions';


// The proxy is called with a JWE that has a accessToken inside.
// This is to allow us to give a short lived token to something external to
// the MCP server and use it to enrich requests
export default async (req: Request, ctx: Context) => {
  
  const token = ctx.params?.token as string;

  if (!token) {
    return new Response('Unauthorized', { status: 401 });
  }
  const decryptedToken = await decryptJWE(token);
  if (!decryptedToken || typeof decryptedToken.accessToken !== 'string' || !decryptedToken.apiPath) {
    return new Response('Unauthorized', { status: 401 });
  }

  req.headers.set('Authorization', `Bearer ${decryptedToken.accessToken}`);
  req.headers.delete('host');

  // rewrite the URL to be api.netlify.com
  const url = new URL(decryptedToken.apiPath as string, 'https://api.netlify.com');

  const updatedReq = new Request(url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    redirect: 'manual', // prevent automatic redirects
  });
  
  const response = await fetch(updatedReq);

  console.log('Response from APIproxy:', response.status, response.statusText);

  return response;
};

export const config: Config = {
  path: '/proxy/:token/*'
};
