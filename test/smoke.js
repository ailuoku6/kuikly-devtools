'use strict';

/**
 * End-to-end check of the server side without a device: posts synthetic payloads to the ingest port
 * and asserts that the hub merges them and that a WebSocket client sees the same result.
 *
 *   node test/smoke.js
 */

const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');

const { startServers, INGEST_PATH } = require('../src/index');

const INGEST_PORT = 18930;
const PANEL_PORT = 18931;

function post(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function node(id, pid, name, extra = {}) {
  return {
    id,
    pid,
    n: name,
    c: `${name}View`,
    r: true,
    cv: false,
    f: [0, 0, 100, 20],
    lf: [0, 0],
    p: {},
    hs: false,
    ...extra,
  };
}

/**
 * Buffers every frame from the moment the socket exists. The server pushes `hello` as soon as the
 * connection is accepted, so a listener attached after `open` would miss it.
 */
function recorder(socket) {
  const received = [];
  const waiters = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    received.push(message);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].predicate(message)) {
        waiters[i].resolve(message);
        waiters.splice(i, 1);
      }
    }
  });

  return {
    waitFor(predicate, timeoutMs = 4000) {
      const existing = received.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
            reject(new Error(`timed out waiting for message; got: ${received.map((m) => m.type).join(',')}`));
          }
        }, timeoutMs);
      });
    },
    drop(predicate) {
      for (let i = received.length - 1; i >= 0; i -= 1) {
        if (predicate(received[i])) received.splice(i, 1);
      }
    },
  };
}

async function run() {
  const servers = await startServers({ ingestPort: INGEST_PORT, panelPort: PANEL_PORT });
  const socket = new WebSocket(`ws://127.0.0.1:${PANEL_PORT}/ws`);
  const frames = recorder(socket);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  await frames.waitFor((m) => m.type === 'hello');

  // --- full snapshot -------------------------------------------------------
  const deltaPromise = frames.waitFor((m) => m.type === 'delta' && m.full === true);
  let response = await post(INGEST_PORT, INGEST_PATH, {
    v: 1,
    pagerId: '7',
    page: 'DevToolsTestPage',
    class: 'DevToolsTestPage',
    platform: 'android',
    seq: 0,
    ts: Date.now(),
    full: true,
    sampleMs: 300,
    tree: {
      nodes: [node(1, -1, 'DivView'), node(2, 1, 'TextView', { p: { color: '#FF0000', text: 'hi' } })],
      removed: [],
      total: 2,
      changed: 2,
    },
    logs: [{ seq: 0, lv: 'i', tag: 'DevToolsTestPage', msg: 'page created', ts: Date.now() }],
    network: [
      {
        id: 'cb_1',
        url: 'https://example.com/a',
        method: 'POST',
        stack: 'KRNetworkModule',
        req: '{}',
        hdr: '{"Content-Type":"application/json"}',
        ts: Date.now(),
      },
    ],
    device: { platform: 'android', density: 3 },
  });
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(response.body.commands, []);
  const delta = await deltaPromise;
  assert.strictEqual(delta.meta.nodeCount, 2);

  const session = servers.hub.sessions.get('7');
  assert.strictEqual(session.nodes.size, 2);
  assert.strictEqual(session.logs.length, 1);
  assert.strictEqual(session.networkOrder.length, 1);
  assert.strictEqual(session.network.get('cb_1').status, undefined);

  // --- delta: one node changes, one disappears, request completes ----------
  await post(INGEST_PORT, INGEST_PATH, {
    v: 1,
    pagerId: '7',
    seq: 1,
    ts: Date.now(),
    full: false,
    tree: {
      nodes: [node(2, 1, 'TextView', { p: { color: '#00FF00', text: 'bye' } })],
      removed: [],
      total: 2,
      changed: 1,
    },
    logs: [],
    network: [{ id: 'cb_1', status: 200, ok: true, cost: 132, rsp: '{"a":1}' }],
  });
  assert.strictEqual(session.nodes.get(2).p.color, '#00FF00');
  // Request fields survive the merge with the completion payload.
  assert.strictEqual(session.network.get('cb_1').url, 'https://example.com/a');
  assert.strictEqual(session.network.get('cb_1').hdr, '{"Content-Type":"application/json"}');
  assert.strictEqual(session.network.get('cb_1').status, 200);
  assert.strictEqual(session.network.get('cb_1').cost, 132);

  await post(INGEST_PORT, INGEST_PATH, {
    v: 1,
    pagerId: '7',
    seq: 2,
    ts: Date.now(),
    full: false,
    tree: { nodes: [], removed: [2], total: 1, changed: 0 },
  });
  assert.strictEqual(session.nodes.size, 1);

  // --- panel commands ride back on the next ingest response ---------------
  socket.send(JSON.stringify({ type: 'command', pagerId: '7', command: { type: 'state', ids: [1] } }));
  socket.send(JSON.stringify({ type: 'command', pagerId: '7', command: { type: 'state', ids: [1, 5] } }));
  socket.send(JSON.stringify({ type: 'command', pagerId: '7', command: { type: 'sample', value: 500 } }));
  await new Promise((resolve) => setTimeout(resolve, 120));

  response = await post(INGEST_PORT, INGEST_PATH, {
    v: 1,
    pagerId: '7',
    seq: 3,
    ts: Date.now(),
    full: false,
    tree: { nodes: [], removed: [], total: 1, changed: 0 },
  });
  const types = response.body.commands.map((c) => c.type).sort();
  assert.deepStrictEqual(types, ['sample', 'state'], 'duplicate state commands must collapse');
  const stateCommand = response.body.commands.find((c) => c.type === 'state');
  assert.deepStrictEqual(stateCommand.ids, [1, 5], 'the newest state command wins');
  assert.deepStrictEqual(session.stateNodeIds, [1, 5]);

  socket.send(JSON.stringify({ type: 'command', pagerId: '7', command: { type: 'shot', sample: 2 } }));
  socket.send(JSON.stringify({ type: 'command', pagerId: '7', command: { type: 'shot', id: 2, sample: 4 } }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  response = await post(INGEST_PORT, INGEST_PATH, {
    v: 1,
    pagerId: '7',
    seq: 4,
    ts: Date.now(),
    full: false,
    tree: { nodes: [], removed: [], total: 1, changed: 0 },
  });
  const shotCommands = response.body.commands.filter((c) => c.type === 'shot');
  assert.strictEqual(shotCommands.length, 1, 'duplicate shot commands must collapse');
  assert.deepStrictEqual(shotCommands[0], { type: 'shot', id: 2, sample: 4 });

  const shotDelta = frames.waitFor((m) => m.type === 'delta' && m.screenshot && m.screenshot.data);
  await post(INGEST_PORT, INGEST_PATH, {
    v: 1,
    pagerId: '7',
    seq: 5,
    ts: Date.now(),
    full: false,
    tree: { nodes: [], removed: [], total: 1, changed: 0 },
    screenshot: {
      id: 1,
      ts: Date.now(),
      sample: 2,
      ox: 0,
      oy: 0,
      ow: 393,
      oh: 852,
      data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
    },
  });
  const shotFrame = await shotDelta;
  assert.strictEqual(session.screenshot.id, 1);
  assert.ok(session.screenshot.data.startsWith('data:image/png;base64,'));
  assert.ok(shotFrame.screenshot.data.startsWith('data:image/png;base64,'));
  assert.strictEqual(shotFrame.screenshot.ow, 393);

  socket.send(JSON.stringify({ type: 'command', pagerId: '7', command: { type: 'live', on: true, interval: 500 } }));
  socket.send(JSON.stringify({ type: 'command', pagerId: '7', command: { type: 'live', on: false } }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  response = await post(INGEST_PORT, INGEST_PATH, {
    v: 1,
    pagerId: '7',
    seq: 6,
    ts: Date.now(),
    full: false,
    tree: { nodes: [], removed: [], total: 1, changed: 0 },
  });
  const liveCommands = response.body.commands.filter((c) => c.type === 'live');
  assert.strictEqual(liveCommands.length, 1, 'duplicate live commands must collapse');
  assert.strictEqual(liveCommands[0].on, false);

  // --- subscribe returns the merged authoritative state -------------------
  const snapshotPromise = frames.waitFor((m) => m.type === 'snapshot');
  socket.send(JSON.stringify({ type: 'subscribe', pagerId: '7' }));
  const snapshot = await snapshotPromise;
  assert.strictEqual(snapshot.session.nodes.length, 1);
  assert.strictEqual(snapshot.session.device.platform, 'android');
  assert.ok(snapshot.session.screenshot.data.startsWith('data:image/png;base64,'));

  // --- malformed input must not take the server down ----------------------
  const bad = await post(INGEST_PORT, INGEST_PATH, { v: 1 }); // no pagerId
  assert.strictEqual(bad.status, 200);
  assert.deepStrictEqual(bad.body.commands, []);

  socket.close();
  await servers.close();
  process.stdout.write('smoke: ok\n');
}

run().catch((error) => {
  process.stderr.write(`smoke: FAILED\n${error.stack}\n`);
  process.exit(1);
});
