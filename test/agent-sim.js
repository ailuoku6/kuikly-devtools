'use strict';

/**
 * Stands in for a real device.
 *
 * Unlike `?mock=1` in the panel, this drives the *real* ingest endpoint with payloads shaped exactly
 * like `KDevtoolsSession.upload()` and honours the commands that come back, so the whole loop -
 * diffing, on-demand state dumps, sampling changes - is exercised without a phone.
 *
 *   node test/agent-sim.js [--port 8089] [--pager 7] [--once]
 */

const http = require('http');
const { INGEST_PATH } = require('../src/server/ingest');

const args = process.argv.slice(2);
const readFlag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
};

const PORT = Number(readFlag('--port', 8089));
const PAGER_ID = readFlag('--pager', '7');
const ONCE = args.includes('--once');

// --- fake page -----------------------------------------------------------------

const nodes = new Map();
let nextRef = 1;

function addNode(parentId, viewName, className, extra = {}) {
  const id = nextRef++;
  const siblings = [...nodes.values()].filter((node) => node.pid === parentId).length;
  nodes.set(id, {
    id,
    pid: parentId,
    ci: siblings,
    n: viewName,
    c: className,
    r: true,
    cv: false,
    f: [0, siblings * 44, 393, 44],
    lf: [0, siblings * 44],
    p: {},
    hs: false,
    ...extra,
  });
  return id;
}

const root = addNode(-1, 'DivView', 'DevToolsTestPage', { cv: true, f: [0, 0, 393, 852], lf: [0, 0] });
addNode(root, 'DivView', 'DevToolsPreviewView', { cv: true, f: [0, 0, 393, 360] });
const card = addNode(root, 'DivView', 'DevToolsTestCardView', { cv: true, f: [0, 420, 393, 432] });
const dialog = addNode(card, 'DivView', 'DevToolsTestDialogView', {
  cv: true,
  hs: true,
  f: [0, 260, 393, 560],
});

for (let i = 0; i < 40; i += 1) {
  const row = addNode(card, 'DivView', 'TestListItem', { f: [0, i * 30, 393, 30] });
  addNode(row, 'TextView', 'TextView', {
    f: [12, i * 30 + 6, 200, 18],
    p: { text: `test item ${i + 1}`, color: '#FF333333', fontSize: 13 },
  });
}
for (let i = 0; i < 6; i += 1) {
  addNode(dialog, 'TextView', 'TextView', {
    f: [16, 48 + i * 40, 160, 20],
    p: { text: `fixture ${i + 1}`, color: '#FF1A1A1A', fontSize: 14 },
  });
}

// The member variables the instrumentor would have generated a dumper for.
const dialogState = {
  view: {
    selectedTabForward: 0,
    selectedDirection: 1,
    slideCount: 3,
    expandedKeys: ['09:00', '10:00'],
    scrollerRef: '<unreadable: lateinit property scrollerRef has not been initialized>',
  },
  attr: { showDialog: true, title: 'DevTools test dialog', initialTab: 0 },
};

// --- agent behaviour -----------------------------------------------------------

const lastSerialized = new Map();
let needFull = true;
let sampleMs = 500;
let seq = 0;
let logSeq = 0;
let requestSeq = 0;
let stateNodeIds = new Set();
const pendingRequests = [];
let streamFrameSeq = 0;
const STREAM_ID = 'll_sim_1';
let streamStarted = false;
let pendingScreenshot = null;
let liveShot = false;
let lastLiveAt = 0;
const logBuffer = [];
const networkBuffer = [];
let auxDeadlineAt = 0;
const AUX_FLUSH_MS = 1500;
const AUX_FLUSH_LOGS = 64;
const AUX_FLUSH_NETWORK = 16;

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

function serialize(node) {
  const payload = { ...node };
  if (stateNodeIds.has(node.id) && node.hs) {
    payload.s = dialogState.view;
    payload.as = dialogState.attr;
  }
  return payload;
}

function collectTree() {
  const changed = [];
  for (const node of nodes.values()) {
    const payload = serialize(node);
    const text = JSON.stringify(payload);
    if (needFull || stateNodeIds.has(node.id) || lastSerialized.get(node.id) !== text) {
      changed.push(payload);
    }
    lastSerialized.set(node.id, text);
  }
  return changed;
}

function jitterLayout() {
  // A couple of rows drift, the way a scrolling list would.
  const ids = [...nodes.keys()];
  for (let i = 0; i < 3; i += 1) {
    const node = nodes.get(ids[Math.floor(Math.random() * ids.length)]);
    if (node?.f) node.f = [node.f[0], node.f[1] + Math.round(Math.random() * 4 - 2), node.f[2], node.f[3]];
  }
}

function nextLog() {
  const samples = [
    ['i', 'DevToolsTestPage', 'onPageDidAppear, restoring diagnostic viewport offset=120'],
    ['d', 'DiagnosticsPoller', 'poll tick interval=5000 activeTask=2'],
    ['e', 'DevToolsFixture', 'parse failed: missing field `payload`'],
    ['p', 'println', 'test stage changed -> 2'],
  ];
  const [lv, tag, msg] = samples[logSeq % samples.length];
  return { seq: logSeq++, lv, tag, msg: `${msg} (#${logSeq})`, ts: Date.now() };
}

function nextNetwork() {
  const out = [];
  if (!streamStarted) {
    streamStarted = true;
    out.push({
      id: STREAM_ID,
      url: 'longlink://devtools/test?event=diagnosticStream',
      method: 'SUB',
      stack: 'TDF/TMLongLinkModule',
      kind: 'stream',
      req: JSON.stringify({ eventName: 'diagnosticStream', source: 'simulator' }),
      ts: Date.now(),
      msgs: [],
      frames: 0,
    });
  } else if (Math.random() < 0.4) {
    const seq = streamFrameSeq++;
    out.push({
      id: STREAM_ID,
      kind: 'stream',
      msgs: [{
        seq,
        dir: 'down',
        ts: Date.now(),
        data: JSON.stringify({ batch: seq + 1, dataKey: seq === 0 ? 'bootstrap' : 'update' }),
      }],
    });
  }
  if (Math.random() < 0.3) {
    requestSeq += 1;
    const record = {
      id: `cb_${requestSeq}`,
      url: `https://devtools.test/api/diagnostics?id=${requestSeq}`,
      method: 'POST',
      stack: requestSeq % 2 === 0 ? 'TDF/network.fetch' : 'KRNetworkModule',
      req: JSON.stringify({ requestId: `diagnostic-${requestSeq}` }),
      hdr: JSON.stringify({ 'Content-Type': 'application/json', Cookie: 'session=sim' }),
      ts: Date.now(),
    };
    pendingRequests.push(record);
    out.push(record);
  }
  if (pendingRequests.length > 0 && Math.random() < 0.6) {
    const record = pendingRequests.shift();
    const ok = Math.random() < 0.85;
    out.push({
      ...record,
      status: ok ? 200 : 502,
      ok,
      cost: Math.round(60 + Math.random() * 400),
      rsp: JSON.stringify({ info: ok ? 'ok' : 'bad gateway', data: { records: 24 } }),
      ...(ok ? {} : { err: 'upstream timeout' }),
    });
  }
  return out;
}

function post(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: INGEST_PATH,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on('error', reject);
    request.end(body);
  });
}

function applyCommands(commands) {
  for (const command of commands ?? []) {
    switch (command.type) {
      case 'full':
        needFull = true;
        console.log('[agent-sim] command: full snapshot requested');
        break;
      case 'state':
        stateNodeIds = new Set(command.ids ?? []);
        needFull = true;
        console.log(`[agent-sim] command: dump state for ${[...stateNodeIds].join(', ') || '(none)'}`);
        break;
      case 'sample':
        sampleMs = command.value;
        console.log(`[agent-sim] command: sample interval -> ${sampleMs}ms`);
        break;
      case 'clear':
        console.log('[agent-sim] command: clear buffers');
        break;
      case 'shot': {
        const id = command.id && command.id > 0 ? command.id : 1;
        pendingScreenshot = {
          id,
          ts: Date.now(),
          sample: command.sample || 2,
          ox: 0,
          oy: 0,
          ow: 393,
          oh: 852,
          data: TINY_PNG,
        };
        console.log(`[agent-sim] command: screenshot nativeRef=${id} sample=${pendingScreenshot.sample}`);
        break;
      }
      case 'live':
        liveShot = command.on !== false;
        console.log(`[agent-sim] command: live screenshot ${liveShot ? 'on' : 'off'}`);
        break;
      default:
        console.log(`[agent-sim] unknown command ${command.type}`);
    }
  }
}

async function tick() {
  jitterLayout();
  const isFull = needFull;
  const changed = collectTree();
  if (Math.random() < 0.7) logBuffer.push(nextLog());
  networkBuffer.push(...nextNetwork());

  if (liveShot && !pendingScreenshot && (isFull || changed.length > 0)) {
    const shotAt = Date.now();
    if (!lastLiveAt || shotAt - lastLiveAt >= 2000) {
      lastLiveAt = shotAt;
      pendingScreenshot = {
        id: 1,
        ts: shotAt,
        sample: 2,
        live: true,
        ox: 0,
        oy: 0,
        ow: 393,
        oh: 852,
        data: TINY_PNG,
      };
    }
  }

  const now = Date.now();
  const hasAux = logBuffer.length > 0 || networkBuffer.length > 0;
  if (hasAux && !auxDeadlineAt) auxDeadlineAt = now + AUX_FLUSH_MS;
  const flushAux = hasAux && (
    now >= auxDeadlineAt ||
    logBuffer.length >= AUX_FLUSH_LOGS ||
    networkBuffer.length >= AUX_FLUSH_NETWORK
  );

  if (!isFull && changed.length === 0 && !pendingScreenshot && !flushAux) {
    return;
  }
  needFull = false;
  if (hasAux) auxDeadlineAt = 0;

  const logs = logBuffer.splice(0);
  const network = networkBuffer.splice(0);

  const payload = {
    v: 1,
    pagerId: PAGER_ID,
    page: 'DevToolsTestPage',
    class: 'DevToolsTestPage',
    platform: 'android',
    seq: seq++,
    ts: Date.now(),
    full: isFull,
    sampleMs,
    droppedLogs: 0,
    tree: { nodes: changed, removed: [], total: nodes.size, changed: changed.length },
    logs,
    network,
  };
  if (pendingScreenshot) {
    payload.screenshot = pendingScreenshot;
    pendingScreenshot = null;
  }
  if (isFull) {
    payload.device = {
      platform: 'android',
      osVersion: '14',
      appVersion: '9.20.0',
      density: 3,
      pageWidth: 393,
      pageHeight: 852,
      deviceWidth: 393,
      deviceHeight: 852,
      statusBarHeight: 44,
    };
  }

  const response = await post(payload);
  applyCommands(response.commands);
}

async function loop() {
  console.log(`[agent-sim] posting to http://127.0.0.1:${PORT}${INGEST_PATH} as pagerId=${PAGER_ID}`);
  for (;;) {
    try {
      await tick();
    } catch (error) {
      console.error(`[agent-sim] ${error.message}`);
    }
    if (ONCE) return;
    await new Promise((resolve) => setTimeout(resolve, sampleMs));
  }
}

loop().catch((error) => {
  console.error(error);
  process.exit(1);
});
