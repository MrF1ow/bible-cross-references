import { createHash, timingSafeEqual } from 'node:crypto';

/** The part of an MCP transport the HTTP handler needs. */
export interface HttpTransport {
  handleRequest(request: Request): Promise<Response>;
}

export interface HttpOptions {
  /** When set, requests to /mcp must carry `Authorization: Bearer <token>`. */
  readonly token: string | undefined;
  /** Makes a transport with a server connected to it, for one request. */
  readonly connect: () => Promise<HttpTransport>;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Compares in constant time, so the response time says nothing about how much of it matched. */
function isAuthorized(request: Request, token: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  return timingSafeEqual(digest(header), digest(`Bearer ${token}`));
}

/** Routes one HTTP request: `/health` for load balancers, `/mcp` for agents, 404 otherwise. */
export async function handleHttpRequest(request: Request, options: HttpOptions): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === '/health') {
    return Response.json({ ok: true });
  }
  if (pathname !== '/mcp') {
    return new Response('Not found. The MCP endpoint is /mcp.', { status: 404 });
  }
  if (
    options.token !== undefined &&
    options.token !== '' &&
    !isAuthorized(request, options.token)
  ) {
    return new Response('Unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Bearer' },
    });
  }
  const transport = await options.connect();
  return transport.handleRequest(request);
}
