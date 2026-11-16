// The forge's HTTP server: routes each request to the surface that owns it.
// main.ts owns the lifecycle (bind, register, wait for done); this file is the
// server. Keep the dispatch order: git first (its paths never start with /api),
// then REST, GraphQL, MCP, then a JSON 404 for everything else.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { Store } from './store.ts';
import { pathOf, sendJson } from './util.ts';

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store = new Store(process.env.MAKEFUN_SHOP_TOKEN ?? '');
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (await handleGit(store, req, res)) return;
        if (await handleRest(store, req, res)) return;
        if (await handleGraphql(store, req, res)) return;
        if (await handleMcp(store, req, res)) return;

        // Everything else, every method: GitHub's 404 body (JSON, never HTML).
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // A handler must never take the server down: answer 500 JSON.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          try { res.end(); } catch { /* socket already gone */ }
        }
      }
    })();
  });
}
