'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const vm = require('vm');
const { createRequire } = require('module');
const { Hub } = require('../src/server/hub');
const file = require.resolve('../src/server/panel');
const localRequire = createRequire(file);
class Server extends EventEmitter { listen(_port, _host, ready) { ready(); } }
class WebSocketServer extends EventEmitter { constructor() { super(); this.clients = new Set(); } }
class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.messages = []; }
  send(text) { this.messages.push(JSON.parse(text)); }
}
const context = { module: { exports: {} }, require: (name) => name === 'http' ? { createServer: () => new Server() }
  : name === 'ws' ? { WebSocketServer } : localRequire(name), URL, Buffer };
vm.runInNewContext(fs.readFileSync(file, 'utf8'), context);
const hub = new Hub();
hub.ingest({ pagerId: 'p', capabilities: ['propSchemaV1'], full: true, tree: { nodes: [{ id: 7, p: {}, e: { p: {} } }] } });
(async () => {
  const { wss } = await context.module.exports.createPanelServer({ hub, port: 0 });
  const a = new Socket(); const b = new Socket();
  for (const socket of [a, b]) { wss.clients.add(socket); wss.emit('connection', socket); }
  a.emit('message', JSON.stringify({ type: 'command', pagerId: 'p', command: { type: 'inspectProps', id: 7, requestId: 'query-a' } }));
  const queued = hub.ingest({ pagerId: 'p', heartbeat: true }).commands;
  assert.equal(queued[0].type, 'inspectProps');
  hub.ingest({ pagerId: 'p', propSchemaResults: [{ requestId: queued[0].requestId, id: 7, ok: true, schemaVersion: 1, schemaToken: 't', properties: [] }] });
  assert.equal(a.messages.at(-1).propSchemaResults[0].requestId, 'query-a');
  assert.equal(b.messages.at(-1).propSchemaResults, undefined);
  // Retried uploads must not deliver a completed query twice.
  hub.ingest({ pagerId: 'p', propSchemaResults: [{ requestId: queued[0].requestId, id: 7, ok: true, schemaVersion: 1, schemaToken: 't', properties: [] }] });
  assert.equal(a.messages.at(-1).propSchemaResults, undefined);
  assert.equal(a.propRequests.size, 0);
  for (const socket of [a, b]) socket.emit('message', JSON.stringify({ type: 'command', pagerId: 'p', command: { type: 'inspectProps', id: 7, requestId: 'same-id' } }));
  const concurrent = hub.ingest({ pagerId: 'p', heartbeat: true }).commands;
  assert.notEqual(concurrent[0].requestId, concurrent[1].requestId);
  hub.ingest({ pagerId: 'p', propSchemaResults: [{ requestId: concurrent[0].requestId, id: 7, ok: true, schemaVersion: 1, schemaToken: 't', properties: [] }] });
  assert.equal(a.messages.at(-1).propSchemaResults[0].requestId, 'same-id');
  assert.equal(b.messages.at(-1).propSchemaResults, undefined, 'same user request id on another socket must not leak results');
  b.emit('message', JSON.stringify({ type: 'command', pagerId: 'p', command: { type: 'inspectProps', id: 999, requestId: 'missing' } }));
  assert.match(b.messages.at(-1).message, /missing node/);
  assert.equal(b.messages.at(-1).requestId, 'missing');
  console.log('panel-schema-offline: ok (request routing, no broadcast leak, duplicate response, rejection)');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => hub.close());
