#!/usr/bin/env bun
/**
 * The MCP server for the explorer's datasets.
 *
 *   bun mcp/server.ts            stdio, for an agent that starts the server itself
 *   bun mcp/server.ts --http     Streamable HTTP at http://HOST:PORT/mcp, for agents elsewhere
 *
 * Environment:
 *   BIBLE_SITE_ROOT   folder holding data/ (default: public/, where `bun run data:build` writes)
 *   HOST, PORT        where the HTTP server listens (default 127.0.0.1:3333)
 *   MCP_AUTH_TOKEN    if set, HTTP requests must send `Authorization: Bearer <token>`
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { BibleData, fileDatasetReader } from './bible-data.ts';
import { handleHttpRequest } from './http.ts';
import { createBibleServer } from './tools.ts';

const data = new BibleData(fileDatasetReader(process.env['BIBLE_SITE_ROOT']));

if (process.argv.includes('--http')) {
  const hostname = process.env['HOST'] ?? '127.0.0.1';
  const port = Number(process.env['PORT'] ?? 3333);
  const server = Bun.serve({
    hostname,
    port,
    fetch: (request) =>
      handleHttpRequest(request, {
        token: process.env['MCP_AUTH_TOKEN'],
        // Stateless (no session ID generator): every request gets its own server and transport,
        // so nothing is kept between calls but the datasets, which `data` shares across them.
        connect: async () => {
          const transport = new WebStandardStreamableHTTPServerTransport({
            enableJsonResponse: true,
          });
          await createBibleServer(data).connect(transport);
          return transport;
        },
      }),
  });
  console.error(`Bible cross-references MCP server on ${server.url.href}mcp`);
} else {
  await createBibleServer(data).connect(new StdioServerTransport());
}
