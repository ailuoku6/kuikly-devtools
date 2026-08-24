'use strict';

/**
 * Server archive lifetime: logs/network are recorded on ingest and survive a panel that opens
 * later; they are dropped only when the device reports that the pager was destroyed.
 *
 *   node test/history.js
 */

const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');

const { startServers, INGEST_PATH } = require('../src/index');

const INGEST_PORT = 18940;
const PANEL_PORT = 18941;

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

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

function connectPanel(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
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
  const api = {
    socket,
    received,
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
            reject(new Error(`timed out; got: ${received.map((m) => m.type).join(',')}`));
          }
        }, timeoutMs);
      });
    },
  };
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(api));
    socket.once('error', reject);
  });
}

function envelope(over = {}) {
  return {
    v: 1,
    pagerId: '9',
    sid: 'sid-9-a',
    page: 'DevToolsTestPage',
    class: 'DevToolsTestPage',
    platform: 'android',
    seq: 0,
    ts: Date.now(),
    full: false,
    sampleMs: 300,
    tree: { nodes: [], removed: [], total: 0, changed: 0 },
    logs: [],
    network: [],
    ...over,
  };
}

async function run() {
  const servers = await startServers({ ingestPort: INGEST_PORT, panelPort: PANEL_PORT });

  // --- archive is recorded even with no browser connected -------------------
  await post(INGEST_PORT, INGEST_PATH, envelope({
    seq: 0,
    full: true,
    logs: [
      { seq: 0, lv: 'i', tag: 'Page', msg: 'created', ts: 1 },
      { seq: 1, lv: 'e', tag: 'Net', msg: 'timeout', ts: 2 },
    ],
    network: [
      { id: 'cb_1', url: 'https://example.com/a', method: 'GET', stack: 'KRNetworkModule', ts: 1 },
    ],
    device: { platform: 'android' },
  }));
  await post(INGEST_PORT, INGEST_PATH, envelope({
    seq: 1,
    logs: [{ seq: 2, lv: 'i', tag: 'Page', msg: 'ticked', ts: 3 }],
    network: [{ id: 'cb_1', status: 200, ok: true, cost: 40, rsp: '{}' }],
    screenshot: {
      id: 1,
      ts: 3,
      sample: 2,
      data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
    },
  }));

  const rest = await get(PANEL_PORT, '/api/session?pagerId=9');
  assert.strictEqual(rest.status, 200);
  assert.strictEqual(rest.body.logs.length, 3);
  assert.strictEqual(rest.body.network.length, 1);
  assert.strictEqual(rest.body.network[0].url, 'https://example.com/a');
  assert.strictEqual(rest.body.network[0].status, 200);

  // Duplicate seqs from a destroy-vs-inflight race must not double-count.
  await post(INGEST_PORT, INGEST_PATH, envelope({
    seq: 2,
    logs: [{ seq: 2, lv: 'i', tag: 'Page', msg: 'ticked', ts: 3 }],
  }));
  assert.strictEqual(servers.hub.sessions.get('9').logs.length, 3);

  // --- late-opening panel receives the full archive on connect --------------
  const late = await connectPanel(PANEL_PORT);
  await late.waitFor((m) => m.type === 'hello');
  const snapshot = await late.waitFor((m) => m.type === 'snapshot' && m.session.pagerId === '9');
  assert.strictEqual(snapshot.session.logs.length, 3, 'late panel must see logs recorded before it opened');
  assert.strictEqual(snapshot.session.network.length, 1);
  assert.strictEqual(snapshot.session.network[0].status, 200);
  assert.ok(snapshot.session.screenshot.data.startsWith('data:image/png;base64,'), 'late panel must see the last screenshot');
  late.socket.close();

  // --- panel Clear / drop must not wipe the server archive ------------------
  const live = await connectPanel(PANEL_PORT);
  await live.waitFor((m) => m.type === 'hello');
  live.socket.send(JSON.stringify({ type: 'clear', pagerId: '9' }));
  live.socket.send(JSON.stringify({ type: 'drop', pagerId: '9' }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(servers.hub.sessions.has('9'), 'drop from the panel must not delete a live page');
  assert.strictEqual(servers.hub.sessions.get('9').logs.length, 3);

  // --- destroy is the only delete path -------------------------------------
  const removed = live.waitFor((m) => m.type === 'session-removed' && m.pagerId === '9');
  await post(INGEST_PORT, INGEST_PATH, envelope({
    seq: 3,
    destroyed: true,
    logs: [{ seq: 3, lv: 'i', tag: 'Page', msg: 'onDestroy', ts: 4 }],
  }));
  await removed;
  assert.strictEqual(servers.hub.sessions.has('9'), false);

  // Late packet from the dying session must not resurrect it.
  await post(INGEST_PORT, INGEST_PATH, envelope({
    seq: 2,
    logs: [{ seq: 99, lv: 'i', tag: 'late', msg: 'should be ignored', ts: 5 }],
  }));
  assert.strictEqual(servers.hub.sessions.has('9'), false);

  // A brand-new page (new sid) on the recycled pagerId starts a fresh archive.
  await post(INGEST_PORT, INGEST_PATH, envelope({
    sid: 'sid-9-b',
    seq: 0,
    full: true,
    logs: [{ seq: 0, lv: 'i', tag: 'Page', msg: 'recreated', ts: 6 }],
    device: { platform: 'android' },
  }));
  const reincarnated = servers.hub.sessions.get('9');
  assert.ok(reincarnated);
  assert.strictEqual(reincarnated.sid, 'sid-9-b');
  assert.strictEqual(reincarnated.logs.length, 1);
  assert.strictEqual(reincarnated.logs[0].msg, 'recreated');

  // A late destroy for the previous sid must not wipe the new page.
  await post(INGEST_PORT, INGEST_PATH, envelope({
    sid: 'sid-9-a',
    seq: 99,
    destroyed: true,
  }));
  assert.ok(servers.hub.sessions.has('9'));
  assert.strictEqual(servers.hub.sessions.get('9').sid, 'sid-9-b');
  assert.strictEqual(servers.hub.sessions.get('9').logs.length, 1);

  // Long-connection frames concatenate on the server; a late panel sees every push.
  await post(INGEST_PORT, INGEST_PATH, envelope({
    sid: 'sid-9-b',
    seq: 1,
    network: [{
      id: 'll_1',
      url: 'longlink://cmd/270532608?event=poiDetail:longConnect',
      method: 'SUB',
      stack: 'TDF/TMLongLinkModule',
      kind: 'stream',
      req: '{"cmd":270532608,"eventName":"poiDetail:longConnect"}',
      ts: Date.now(),
      msgs: [{ seq: 0, dir: 'down', ts: Date.now(), data: '{"batch":1}' }],
      frames: 1,
    }],
  }));
  await post(INGEST_PORT, INGEST_PATH, envelope({
    sid: 'sid-9-b',
    seq: 2,
    network: [{
      id: 'll_1',
      kind: 'stream',
      msgs: [{ seq: 1, dir: 'down', ts: Date.now(), data: '{"batch":2}' }],
    }],
  }));
  const stream = servers.hub.sessions.get('9').network.get('ll_1');
  assert.strictEqual(stream.kind, 'stream');
  assert.strictEqual(stream.msgs.length, 2, 'server must keep every long-link frame');
  assert.strictEqual(stream.msgs[1].data, '{"batch":2}');
  assert.strictEqual(stream.url, 'longlink://cmd/270532608?event=poiDetail:longConnect');

  // Chunked HTTP bodies reassemble in ingest order, including when chunks arrive on later POSTs.
  const big = 'N'.repeat(200000);
  const chunk = 80000;
  const count = Math.ceil(big.length / chunk);
  const blobs = [];
  for (let i = 0; i < count; i += 1) {
    blobs.push({
      id: 'big_1',
      field: 'rsp',
      index: i,
      count,
      data: big.slice(i * chunk, (i + 1) * chunk),
    });
  }
  await post(INGEST_PORT, INGEST_PATH, envelope({
    sid: 'sid-9-b',
    seq: 3,
    network: [{
      id: 'big_1',
      url: 'https://example.com/big',
      method: 'POST',
      stack: 'TDF/network.fetch',
      ts: Date.now(),
      status: 200,
      ok: true,
      rspChars: big.length,
      rspChunks: count,
    }],
    blobs: blobs.slice(0, 1),
  }));
  assert.notStrictEqual(servers.hub.sessions.get('9').network.get('big_1').rsp, big);
  await post(INGEST_PORT, INGEST_PATH, envelope({
    sid: 'sid-9-b',
    seq: 4,
    network: [{ id: 'big_1' }],
    blobs: blobs.slice(1),
  }));
  assert.strictEqual(servers.hub.sessions.get('9').network.get('big_1').rsp, big);
  const restBig = await get(PANEL_PORT, '/api/session?pagerId=9');
  assert.strictEqual(restBig.body.network.find((row) => row.id === 'big_1').rsp, big);

  // Destroy must not drop the session until leftover chunks have arrived.
  const drainBody = 'Z'.repeat(200000);
  const drainBlobs = [];
  const drainCount = Math.ceil(drainBody.length / chunk);
  for (let i = 0; i < drainCount; i += 1) {
    drainBlobs.push({
      id: 'drain_1',
      field: 'rsp',
      index: i,
      count: drainCount,
      data: drainBody.slice(i * chunk, (i + 1) * chunk),
    });
  }
  const dying = servers.hub.sessions.get('9');
  await post(INGEST_PORT, INGEST_PATH, envelope({
    sid: 'sid-9-b',
    seq: 5,
    destroyed: true,
    network: [{
      id: 'drain_1',
      url: 'https://example.com/drain',
      method: 'GET',
      stack: 'TDF/network.fetch',
      ts: Date.now(),
      status: 200,
      ok: true,
      rspChars: drainBody.length,
      rspChunks: drainCount,
    }],
    blobs: drainBlobs.slice(0, 1),
  }));
  assert.ok(servers.hub.sessions.has('9'), 'incomplete destroy must keep the session for remaining chunks');
  assert.notStrictEqual(dying.network.get('drain_1').rsp, drainBody);
  await post(INGEST_PORT, INGEST_PATH, envelope({
    sid: 'sid-9-b',
    seq: 6,
    destroyed: true,
    blobs: drainBlobs.slice(1),
  }));
  assert.strictEqual(dying.network.get('drain_1').rsp, drainBody, 'follow-up destroy POSTs must finish the body');
  assert.strictEqual(servers.hub.sessions.has('9'), false);

  live.socket.close();
  await servers.close();
  process.stdout.write('history: ok\n');
}

run().catch((error) => {
  process.stderr.write(`history: FAILED\n${error.stack}\n`);
  process.exit(1);
});
