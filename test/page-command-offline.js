'use strict';

// Run the real client and hub with a device simulator, without opening a network port.
const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const vm = require('vm');
const { Hub } = require('../src/server/hub');
const { normalizeSchema } = require('../src/server/values');
const hub = new Hub();
let node = { id: 7, p: {}, e: { p: {} } };
hub.ingest({ pagerId: 'p', sid: 'session', capabilities: ['propSchemaV1'], full: true, tree: { nodes: [node] } });
let applied = 0;
let dropResult = false;
class Socket extends EventEmitter {
  static CONNECTING = 0;
  constructor() {
    super(); this.readyState = 1;
    this.delta = (message) => this.emit('message', JSON.stringify(message));
    hub.on('delta', this.delta);
    setImmediate(() => this.emit('message', JSON.stringify({ type: 'hello', capabilities: ['propSchemaV1'], sessions: hub.summaries() })));
  }
  send(raw) {
    const { pagerId, command } = JSON.parse(raw);
    try {
      hub.enqueueCommand(pagerId, command);
      setImmediate(() => {
        const commands = hub.ingest({ pagerId, sid: 'session', heartbeat: true }).commands;
        for (const cmd of commands) {
          if (cmd.type === 'inspectProps') {
            hub.ingest({ pagerId, sid: 'session', propSchemaResults: [{
              id: 7, requestId: cmd.requestId, ok: true, schemaVersion: 1, schemaToken: 'session:7', properties: [
                { key: 'backgroundColor', inputType: 'color', wireType: 'argb32', reported: false },
                { key: 'visibility', inputType: 'boolean', wireType: 'Boolean', reported: false },
                { key: 'text', inputType: 'string', wireType: 'String', reported: false },
              ],
            }] });
          } else if (cmd.type === 'edit') {
            applied++;
            if (dropResult) continue;
            if (cmd.value === 'reject') {
              hub.ingest({ pagerId, editResults: [{ requestId: cmd.requestId, ok: false, error: 'Setter rejected' }] });
              continue;
            }
            node = { ...node, p: { ...node.p, [cmd.key]: cmd.key === 'visibility' ? Number(cmd.value) : String(cmd.value) } };
            hub.ingest({ pagerId, sid: 'session', tree: { nodes: [node] }, editResults: [{
              requestId: cmd.requestId, ok: true,
              readback: { key: cmd.key, inputType: cmd.key === 'backgroundColor' ? 'color' : 'boolean', readable: true, value: cmd.value },
            }] });
          }
        }
      });
    } catch (error) {
      setImmediate(() => this.emit('message', JSON.stringify({ type: 'error', requestId: command.requestId, message: error.message })));
    }
  }
  close() { hub.off('delta', this.delta); this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}
const sandbox = { require: (name) => { assert.equal(name, 'ws'); return Socket; }, module: { exports: {} }, setTimeout, clearTimeout };
vm.runInNewContext(fs.readFileSync(require.resolve('../src/client/page-command'), 'utf8'), sandbox);
const { pageCommand } = sandbox.module.exports;
let serial = 0;
const call = (command, timeoutMs = 1000) => pageCommand({ port: 1, pagerId: 'p', command: { requestId: `r${++serial}`, ...command }, timeoutMs });
(async () => {
  const schema = await call({ type: 'inspectProps', id: 7 });
  assert.equal(schema.properties.length, 3);
  const set = (key, value, extra = {}) => call({ type: 'edit', id: 7, target: 'p', mode: 'setSupported', schemaToken: schema.schemaToken, key, value, ...extra });
  const color = await set('backgroundColor', '#80112233');
  assert.equal(color.value, '0x80112233');
  const bool = await set('visibility', false);
  assert.strictEqual(bool.value, false, 'prefer semantic readback to the legacy integer p value');
  await assert.rejects(set('backgroundColor', 'bad-color'), /INVALID_VALUE/);
  await assert.rejects(set('text', 'reject'), /Setter rejected/);
  await assert.rejects(set('visibility', true, { schemaToken: 'expired' }), /SCHEMA_EXPIRED/);
  assert.equal(applied, 3, 'invalid inputs must not reach device; rejected setters execute once');
  dropResult = true;
  await assert.rejects(call({ type: 'edit', id: 7, target: 'p', mode: 'setSupported', schemaToken: schema.schemaToken, key: 'visibility', value: true }, 20), /may still apply/);
  assert.equal(applied, 4, 'timeouts must not replay commands');
  hub.ingest({ pagerId: 'p', capabilities: [] });
  await assert.rejects(call({ type: 'inspectProps', id: 7 }), /latest server/);
  assert.equal(normalizeSchema(schema).schemaToken, schema.schemaToken);
  console.log('page-command-offline: ok (schema query, typed edits, readback, invalid input, timeout, compatibility)');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => hub.close());
