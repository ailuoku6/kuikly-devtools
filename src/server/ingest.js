'use strict';

const http = require('http');

const INGEST_PATH = '/__kuikly_devtools/ingest';
const PING_PATH = '/__kuikly_devtools/ping';
/** Shared by ingest/ping; must match KDevtoolsTransport.SERVE_PATH_MARKER on the device. */
const SERVE_PATH_MARKER = '__kuikly_devtools';
const MAX_BODY_BYTES = 48 * 1024 * 1024; // per POST only; HTTP bodies are chunked well below this

/**
 * Device-facing server. Deliberately dependency-free and permissive: it must accept plain HTTP from
 * an app sandbox with no CORS story and no TLS.
 */
function createIngestServer({ hub, port, host = '0.0.0.0', onEvent = () => {} }) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === PING_PATH || req.url === '/')) {
      return respondJson(res, 200, { ok: true, service: 'kuikly-devtools-ingest' });
    }
    if (req.method !== 'POST' || !req.url.startsWith(INGEST_PATH)) {
      return respondJson(res, 404, { error: 'not found' });
    }

    let size = 0;
    const chunks = [];
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        respondJson(res, 413, { error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch (error) {
        onEvent({ level: 'warn', message: `malformed ingest payload: ${error.message}` });
        return respondJson(res, 400, { error: 'invalid json' });
      }
      try {
        const { commands } = hub.ingest(payload);
        return respondJson(res, 200, { ok: true, commands });
      } catch (error) {
        onEvent({ level: 'error', message: `ingest failed: ${error.stack || error.message}` });
        return respondJson(res, 500, { error: 'ingest failed' });
      }
    });

    req.on('error', () => {
      aborted = true;
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

function respondJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
}

module.exports = { createIngestServer, INGEST_PATH, PING_PATH, SERVE_PATH_MARKER };
