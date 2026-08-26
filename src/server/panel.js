'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Browser-facing server: serves the panel bundle and pushes live deltas over a WebSocket.
 *
 * Deltas are forwarded verbatim from the hub, so the browser applies exactly the same merge the hub
 * did and both sides converge on the same tree.
 */
function createPanelServer({ hub, port, host = '0.0.0.0', uiDir, onEvent = () => {} }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/sessions') {
      return respondJson(res, 200, { sessions: hub.summaries() });
    }
    if (url.pathname === '/api/inspect/sessions') {
      return respondJson(res, 200, { sessions: hub.summaries() });
    }
    if (url.pathname === '/api/inspect/logs') {
      return respondInspectLogs(res, hub, url);
    }
    if (url.pathname.startsWith('/api/inspect/logs/')) {
      return respondInspectLogDetail(res, hub, url);
    }
    if (url.pathname === '/api/inspect/network') {
      return respondInspectNetwork(res, hub, url);
    }
    if (url.pathname === '/api/inspect/nodes') {
      return respondInspectNodes(res, hub, url);
    }
    if (url.pathname.startsWith('/api/inspect/network/')) {
      return respondInspectNetworkDetail(res, hub, url);
    }
    if (url.pathname.startsWith('/api/inspect/nodes/')) {
      return respondInspectNodeDetail(res, hub, url);
    }
    if (url.pathname === '/api/session') {
      const session = hub.sessions.get(url.searchParams.get('pagerId') || '');
      if (!session) return respondJson(res, 404, { error: 'unknown session' });
      return respondJson(res, 200, session.fullState());
    }
    if (url.pathname === '/api/command' && req.method === 'POST') {
      return readJson(req)
        .then((body) => {
          const ok = hub.enqueueCommand(String(body.pagerId || ''), body.command);
          return respondJson(res, ok ? 200 : 400, { ok });
        })
        .catch((error) => respondJson(res, 400, { error: error.message }));
    }

    return serveStatic(url.pathname, uiDir, res, onEvent);
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 * 1024 });

  wss.on('connection', (socket) => {
    send(socket, { type: 'hello', sessions: hub.summaries() });
    // Push the full archive immediately so a browser that opens after the page has already been
    // running still sees every log and request, without waiting for a subscribe round-trip.
    for (const session of hub.sessions.values()) {
      send(socket, { type: 'snapshot', session: session.fullState() });
    }

    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch (error) {
        return;
      }
      handlePanelMessage(hub, socket, message, onEvent);
    });
  });

  const broadcast = (message) => {
    const text = JSON.stringify(message);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(text);
    }
  };

  hub.on('delta', broadcast);
  hub.on('session-added', (summary) => broadcast({ type: 'session-added', summary }));
  hub.on('session-removed', (payload) => broadcast({ type: 'session-removed', ...payload }));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({ server, wss }));
  });
}

const INSPECT_DEFAULT_LIMIT = 50;
const INSPECT_MAX_LIMIT = 200;
const INSPECT_LOG_PREVIEW = 600;
const INSPECT_BODY_PREVIEW = 800;

function inspectSession(hub, url) {
  const pagerId = url.searchParams.get('pagerId') || '';
  const session = hub.sessions.get(pagerId);
  return session || null;
}

function inspectPage(url, total) {
  const requestedLimit = Number(url.searchParams.get('limit'));
  const requestedOffset = Number(url.searchParams.get('offset'));
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.floor(requestedLimit), 1), INSPECT_MAX_LIMIT)
    : INSPECT_DEFAULT_LIMIT;
  const offset = Number.isFinite(requestedOffset) ? Math.max(Math.floor(requestedOffset), 0) : 0;
  return { limit, offset, total };
}

function matchesQuery(value, query) {
  return !query || String(value || '').toLowerCase().includes(query.toLowerCase());
}

function nestedMatches(value, query, budget = { remaining: 200 }, depth = 0) {
  if (!query) return true;
  if (budget.remaining-- <= 0 || depth > 5 || value == null) return false;
  if (typeof value !== 'object') return matchesQuery(value, query);
  for (const [key, child] of Object.entries(value)) {
    if (matchesQuery(key, query) || nestedMatches(child, query, budget, depth + 1)) return true;
  }
  return false;
}

function preview(value, max = INSPECT_BODY_PREVIEW) {
  if (typeof value !== 'string' || value.length <= max) return value;
  return `${value.slice(0, max)}...`;
}

function compactLog(log) {
  return {
    ...log,
    msg: preview(log.msg, INSPECT_LOG_PREVIEW),
    msgChars: typeof log.msg === 'string' ? log.msg.length : undefined,
  };
}

function compactNetwork(record) {
  const compact = { ...record };
  delete compact.req;
  delete compact.rsp;
  delete compact.msgs;
  if (typeof record.req === 'string') compact.reqPreview = preview(record.req);
  if (typeof record.rsp === 'string') compact.rspPreview = preview(record.rsp);
  if (Array.isArray(record.msgs)) compact.frames = record.msgs.length;
  return compact;
}

function compactNode(node) {
  return {
    id: node.id,
    pid: node.pid,
    ci: node.ci,
    name: node.n,
    className: node.c,
    renderView: node.r,
    composeView: node.cv,
    frame: node.f,
    localFrame: node.lf,
    scrollOffset: node.so,
    hasState: node.hs,
    propKeys: node.p && typeof node.p === 'object' ? Object.keys(node.p) : [],
    stateKeys: node.s && typeof node.s === 'object' ? Object.keys(node.s) : [],
    attrStateKeys: node.as && typeof node.as === 'object' ? Object.keys(node.as) : [],
    props: compactValues(node.p),
    state: compactValues(node.s),
    attrState: compactValues(node.as),
  };
}

function compactValues(value) {
  if (!value || typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, child]) => [
    key,
    typeof child === 'string' ? preview(child, 160) :
      (child && typeof child === 'object' ? '[object]' : child),
  ]));
}

function respondInspectLogs(res, hub, url) {
  const session = inspectSession(hub, url);
  if (!session) return respondJson(res, 404, { error: 'unknown session' });
  const query = url.searchParams.get('q') || url.searchParams.get('query') || '';
  const level = url.searchParams.get('level') || '';
  const tag = url.searchParams.get('tag') || '';
  const matched = session.logs.filter((log) =>
    (!level || log.lv === level) && matchesQuery(log.tag, tag) &&
    (matchesQuery(log.msg, query) || matchesQuery(log.tag, query))
  );
  const page = inspectPage(url, matched.length);
  return respondJson(res, 200, {
    pagerId: session.pagerId,
    page: session.page,
    ...page,
    logs: matched.slice(page.offset, page.offset + page.limit).map(compactLog),
  });
}

function respondInspectLogDetail(res, hub, url) {
  const session = inspectSession(hub, url);
  if (!session) return respondJson(res, 404, { error: 'unknown session' });
  const seq = Number(decodeURIComponent(url.pathname.slice('/api/inspect/logs/'.length)));
  const log = session.logs.find((entry) => entry.seq === seq);
  if (!log) return respondJson(res, 404, { error: 'unknown log record' });
  return respondJson(res, 200, { pagerId: session.pagerId, page: session.page, log });
}

function respondInspectNetwork(res, hub, url) {
  const session = inspectSession(hub, url);
  if (!session) return respondJson(res, 404, { error: 'unknown session' });
  const query = url.searchParams.get('q') || url.searchParams.get('query') || '';
  const status = url.searchParams.get('status');
  const kind = url.searchParams.get('kind') || '';
  const matched = session.networkOrder
    .map((id) => session.network.get(id))
    .filter(Boolean)
    .filter((record) =>
      (!status || String(record.status) === status) && (!kind || record.kind === kind) &&
      (matchesQuery(record.url, query) || matchesQuery(record.stack, query) || matchesQuery(record.id, query))
    );
  const page = inspectPage(url, matched.length);
  return respondJson(res, 200, {
    pagerId: session.pagerId,
    page: session.page,
    ...page,
    network: matched.slice(page.offset, page.offset + page.limit).map(compactNetwork),
  });
}

function respondInspectNodes(res, hub, url) {
  const session = inspectSession(hub, url);
  if (!session) return respondJson(res, 404, { error: 'unknown session' });
  const query = url.searchParams.get('q') || url.searchParams.get('query') || '';
  const matched = Array.from(session.nodes.values()).filter((node) =>
    matchesQuery(node.n, query) || matchesQuery(node.c, query) || matchesQuery(node.id, query) ||
    nestedMatches(node.p, query) || nestedMatches(node.s, query) || nestedMatches(node.as, query)
  );
  const page = inspectPage(url, matched.length);
  return respondJson(res, 200, {
    pagerId: session.pagerId,
    page: session.page,
    ...page,
    nodes: matched.slice(page.offset, page.offset + page.limit).map(compactNode),
  });
}

function respondInspectNetworkDetail(res, hub, url) {
  const session = inspectSession(hub, url);
  if (!session) return respondJson(res, 404, { error: 'unknown session' });
  const id = decodeURIComponent(url.pathname.slice('/api/inspect/network/'.length));
  const record = session.network.get(id);
  if (!record) return respondJson(res, 404, { error: 'unknown network record' });
  return respondJson(res, 200, { pagerId: session.pagerId, page: session.page, network: record });
}

function respondInspectNodeDetail(res, hub, url) {
  const session = inspectSession(hub, url);
  if (!session) return respondJson(res, 404, { error: 'unknown session' });
  const id = Number(decodeURIComponent(url.pathname.slice('/api/inspect/nodes/'.length)));
  const node = session.nodes.get(id);
  if (!node) return respondJson(res, 404, { error: 'unknown node' });
  return respondJson(res, 200, { pagerId: session.pagerId, page: session.page, node });
}

function handlePanelMessage(hub, socket, message, onEvent) {
  switch (message.type) {
    case 'subscribe': {
      const session = hub.sessions.get(String(message.pagerId || ''));
      if (session) {
        send(socket, { type: 'snapshot', session: session.fullState() });
      } else {
        send(socket, { type: 'error', message: `unknown session ${message.pagerId}` });
      }
      break;
    }
    case 'command':
      hub.enqueueCommand(String(message.pagerId || ''), message.command);
      break;
    case 'clear':
    case 'drop':
      // The server archive is dropped only when the Kuikly page itself is destroyed. Panel Clear
      // is a local view action and must not wipe history for a later reconnect.
      break;
    default:
      onEvent({ level: 'warn', message: `unknown panel message: ${message.type}` });
  }
}

function serveStatic(pathname, uiDir, res, onEvent) {
  if (!uiDir || !fs.existsSync(uiDir)) {
    return respondText(
      res,
      503,
      'Kuikly DevTools panel bundle is missing.\n\n' +
        'Build it with:  npm run build:ui   (inside the kuikly-devtools package)\n'
    );
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(uiDir, relative);
  if (!resolved.startsWith(path.resolve(uiDir))) {
    return respondText(res, 403, 'forbidden');
  }

  const target = fs.existsSync(resolved) && fs.statSync(resolved).isFile()
    ? resolved
    : path.join(uiDir, 'index.html'); // SPA fallback

  fs.readFile(target, (error, data) => {
    if (error) {
      onEvent({ level: 'warn', message: `static read failed: ${error.message}` });
      return respondText(res, 404, 'not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  });
  return undefined;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function send(socket, message) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

function respondJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
  return undefined;
}

function respondText(res, status, text) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
  return undefined;
}

module.exports = { createPanelServer };
