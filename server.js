import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStore } from './lib/store.js';

const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url));
const securityHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function normalizeOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin without a path.');
  return url.origin;
}

export function createApp({ store, publicOrigin }) {
  const origin = publicOrigin?.trim() ? normalizeOrigin(publicOrigin.trim()) : null;
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/background.js', ['background.js', 'text/javascript; charset=utf-8']],
  ].map(([route, [file, type]]) => [route, { body: readFileSync(resolve(publicDirectory, file)), type }]));
  const server = createServer({ maxHeaderSize: 8192 }, async (request, response) => {
    const send = (statusCode, body, type = 'application/json; charset=utf-8') => {
      if (response.destroyed) return;
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      response.writeHead(statusCode, { ...securityHeaders, 'Content-Type': type, 'Content-Length': bytes.length });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    };
    try {
      const url = new URL(request.url, 'http://localhost');
      const route = url.pathname;
      if ((request.method === 'GET' || request.method === 'HEAD') && assets.has(route)) {
        const asset = assets.get(route);
        return send(200, asset.body, asset.type);
      }
      if (route === '/healthz' && (request.method === 'GET' || request.method === 'HEAD')) {
        return send(store.healthy() ? 200 : 503, { status: store.healthy() ? 'ok' : 'unavailable' });
      }
      if (route === '/api/participants' && request.method === 'GET') {
        await store.refresh?.();
        return send(200, { participants: store.list() });
      }
      const reveal = route.match(/^\/api\/reveal\/([a-f0-9-]{36})$/);
      if (reveal) {
        if (request.method !== 'POST') return send(405, { error: 'Use POST to reveal a name.' });
        // Without a fixed public origin, direct HTTP requests can use whichever
        // local hostname/port the browser opened. Forwarded headers are not trusted.
        let expectedOrigin = origin;
        if (!expectedOrigin && request.headers.host) {
          try { expectedOrigin = normalizeOrigin(`http://${request.headers.host}`); }
          catch { /* Invalid Host headers never authorize a reveal. */ }
        }
        if (!expectedOrigin || request.headers.origin !== expectedOrigin) {
          return send(403, { error: 'Reveal requests must come from this website.' });
        }
        request.resume();
        const result = await store.reveal(reveal[1]);
        return send(200, result);
      }
      return send(404, { error: 'Not found.' });
    } catch (error) {
      const messages = {
        404: 'This name is not on the list.',
        409: 'This name has already been opened.',
        503: 'The list is unavailable. Ask the organizer to check the server before trying again.',
      };
      const expected = Object.hasOwn(messages, error.statusCode);
      send(expected ? error.statusCode : 500, { error: expected ? messages[error.statusCode] : 'The server could not complete this request.' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

async function main() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const host = process.env.HOST || '127.0.0.1';
  const publicOrigin = process.env.PUBLIC_ORIGIN?.trim() || undefined;
  if (publicOrigin) normalizeOrigin(publicOrigin);
  const store = await createStore({ dataDir: process.env.DATA_DIR || './data' });
  const server = createApp({ store, publicOrigin });
  await new Promise((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListening);
  });
  console.log(`Secret Santa listening at http://${host}:${port}`);
  if (publicOrigin) console.log(`Public origin: ${normalizeOrigin(publicOrigin)}`);
  else console.warn('Warning: PUBLIC_ORIGIN is not set. Using the request Host for local HTTP origin checks. Set PUBLIC_ORIGIN for a public HTTPS deployment.');
  let stopping = false;
  let lastReloadError = null;
  let reloadTimer;
  async function reloadParticipants() {
    try {
      const reset = await store.refresh();
      if (reset) console.log('Participant file changed. New draw saved; all names reopened.');
      else if (lastReloadError) console.log('Participant file is valid again. Reveals resumed.');
      lastReloadError = null;
    } catch (error) {
      if (error.message !== lastReloadError) console.warn(error.message);
      lastReloadError = error.message;
    } finally {
      if (!stopping) reloadTimer = setTimeout(reloadParticipants, 1000).unref();
    }
  }
  // Polling also sees atomic editor saves and changes through Docker bind mounts.
  reloadTimer = setTimeout(reloadParticipants, 1000).unref();
  function shutdown() {
    stopping = true;
    clearTimeout(reloadTimer);
    server.close(() => { process.exitCode = 0; });
    setTimeout(() => process.exit(1), 15_000).unref();
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
