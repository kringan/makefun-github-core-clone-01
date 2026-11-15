// The forge's HTTP server: one process, one in-memory store.
//
//   GET  /healthz                                  200 {"ok":true}, no auth
//   GET  /api/v3/                                  the API root, token scopes
//   *    /api/v3/**                                REST v3 (rest.ts)
//   POST /api/graphql                             GraphQL v4 (graphql.ts)
//   POST /mcp                                     MCP, Streamable HTTP (mcp.ts)
//   GET  /{owner}/{repo}.git/info/refs            git smart HTTP (gitproto.ts)
//   POST /{owner}/{repo}.git/git-upload-pack
//   POST /{owner}/{repo}.git/git-receive-pack
//
// Every reply carries a non-empty X-GitHub-Request-Id. Everything except
// /healthz needs the trial bearer token (MAKEFUN_SHOP_TOKEN, exact match;
// when the variable is unset, any non-empty bearer is accepted, which is
// only a local-testing convenience).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ForgeStore } from './store.ts';
import { handleRest, nextRequestId, type HttpRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGitRoute } from './gitproto.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match ? match[1]! : null;
}

function tokenIsValid(token: string | null): boolean {
  if (token === null || token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  return token === expected;
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new ForgeStore();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = nextRequestId();
      const baseHeaders = { 'x-github-request-id': requestId };
      const path = pathOf(req);
      const method = req.method ?? 'GET';

      // The env's boot check calls this twice: 200 {"ok":true}.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true }, baseHeaders);
        return;
      }

      // Everything below needs the trial token.
      const token = bearerOf(req);
      if (!tokenIsValid(token)) {
        sendJson(res, 401, { message: 'Bad credentials' }, baseHeaders);
        return;
      }

      // The GitHub API root: a 200 with the token's scopes.
      if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
        sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, {
          ...baseHeaders,
          'x-oauth-scopes': 'repo, read:org',
        });
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const body = await readBody(req);
        const url = new URL(req.url ?? '/', 'http://entry');
        const httpRequest: HttpRequest = {
          method,
          path,
          query: url.searchParams,
          headers: req.headers as Record<string, string | undefined>,
          bodyText: body.toString('utf8'),
          host: req.headers.host ?? 'entry',
        };
        const reply = handleRest(store, httpRequest);
        if (reply === null) {
          sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
          return;
        }
        if (reply.status === 204) {
          res.writeHead(204, { ...baseHeaders });
          res.end();
          return;
        }
        sendJson(res, reply.status, reply.body, { ...baseHeaders, ...(reply.headers ?? {}) });
        return;
      }

      // GraphQL v4.
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
          return;
        }
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8')) as unknown;
        } catch {
          sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }, baseHeaders);
          return;
        }
        const reply = handleGraphQL(store, parsed);
        sendJson(res, reply.status, reply.body, baseHeaders);
        return;
      }

      // MCP, Streamable HTTP.
      if (path === '/mcp') {
        if (method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' }, baseHeaders);
          return;
        }
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8')) as unknown;
        } catch {
          // JSON-RPC parse error: HTTP 400 with -32700.
          sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, baseHeaders);
          return;
        }
        const reply = handleMcp(store, parsed);
        if (reply.status === 202) {
          res.writeHead(202, { ...baseHeaders });
          res.end();
          return;
        }
        sendJson(res, reply.status, reply.body, { ...baseHeaders, ...(reply.headers ?? {}) });
        return;
      }

      // Git smart HTTP.
      if (path.includes('.git/')) {
        const body = await readBody(req);
        const url = new URL(req.url ?? '/', 'http://entry');
        const reply = handleGitRoute(store, method, path, url.searchParams, req.headers as Record<string, string | undefined>, body);
        if (reply === null) {
          sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
          return;
        }
        const headers: Record<string, string> = { ...baseHeaders, ...(reply.headers ?? {}) };
        res.writeHead(reply.status, headers);
        res.end(reply.body);
        return;
      }

      // Everything else, every method: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' }, baseHeaders);
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) });
      } else {
        res.end();
      }
    });
  });
}
