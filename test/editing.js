'use strict';

const assert = require('assert');
const { Hub } = require('../src/server/hub');
const { colorBits, normalizeNode, prepareEdit } = require('../src/server/values');

const raw = {
  id: 1, pid: -1, n: 'View', c: 'View',
  p: { backgroundColor: '4294901760', text: 'hello', width: 20, margin: { top: 2 } },
  s: { accent: '2148606515', tint: -65536, count: 1, enabled: true, colorToken: 'theme-primary', optional: null, readOnly: 'x' },
  as: { color: 4278190335 },
  e: {
    p: { backgroundColor: 'String', text: 'String', width: 'Float', margin: 'space' },
    s: { accent: 'Color', tint: 'Int', count: 'Int', enabled: 'Boolean', colorToken: 'Color', optional: 'String?' },
    as: { color: 'Long' },
  },
};
const node = normalizeNode(raw);
assert.equal(node.p.backgroundColor, '0xFFFF0000');
assert.equal(node.s.accent, '0x80112233');
assert.equal(node.s.tint, '0xFFFF0000');
assert.equal(node.s.colorToken, 'theme-primary');
assert.equal(raw.p.backgroundColor, '4294901760', 'normalization must not mutate payloads');
const edit = (target, key, value) => prepareEdit(node, { type: 'edit', id: 1, target, key, value, requestId: 'e1' });
assert.equal(edit('p', 'backgroundColor', '#80112233').value, '2148606515');
assert.equal(edit('p', 'backgroundColor', '#112233').value, '4279312947');
assert.equal(edit('s', 'tint', '0xFFFFFFFF').value, -1);
assert.equal(edit('s', 'accent', '#00000000').value, 0);
assert.equal(edit('s', 'accent', '-65536').value, 4294901760);
assert.equal(edit('as', 'color', '#FFFFFFFF').value, 4294967295);
assert.equal(edit('s', 'colorToken', 'theme-secondary').value, 'theme-secondary');
assert.equal(edit('s', 'optional', null).value, null);
assert.equal(edit('p', 'text', 'new text').value, 'new text');
assert.deepEqual(edit('p', 'margin', { top: 10, right: 2 }).value, { top: 10, right: 2 });
for (const invalid of ['#GGGGGG', '#12345', '0x100000000', 4294967296, -2147483649, 1.5, NaN]) {
  assert.equal(colorBits(invalid), null);
  assert.throws(() => edit('p', 'backgroundColor', invalid));
}
for (const [target, key, value] of [
  ['s', 'readOnly', 'x'], ['s', 'count', 1.2], ['s', 'count', 2147483648],
  ['s', 'count', '3'], ['s', 'enabled', 'false'], ['p', 'width', Infinity],
  ['p', 'width', 1e40], ['p', 'margin', { invalid: 2 }], ['p', 'text', null],
  ['s', '__proto__', {}], ['invalid', 'count', 3],
]) assert.throws(() => edit(target, key, value));
assert.throws(() => prepareEdit({ ...raw, e: undefined }, { target: 's', key: 'count', value: 2, requestId: 'old' }));
assert.equal(normalizeNode({ p: { border: { color: -1 }, colors: [1, 2] } }).p.border.color, '0xFFFFFFFF');

const hub = new Hub();
try {
  let delta;
  hub.on('delta', (value) => { delta = value; });
  const payload = { pagerId: 'edit-page', sid: 'instance-1', full: true, tree: { nodes: [raw], removed: [] } };
  hub.ingest(payload);
  assert.equal(hub.sessions.get('edit-page').nodes.get(1).p.backgroundColor, '0xFFFF0000');
  hub.enqueueCommand('edit-page', { type: 'edit', id: 1, target: 's', key: 'accent', value: '#80112233', requestId: 'e1' });
  hub.enqueueCommand('edit-page', { type: 'edit', id: 1, target: 's', key: 'count', value: 3, requestId: 'e2' });
  const { commands } = hub.ingest({ pagerId: 'edit-page', sid: 'instance-1', heartbeat: true });
  assert.equal(commands.length, 2, 'edits must not be collapsed');
  assert.equal(commands[0].value, 2148606515);
  assert.equal(commands[1].value, 3);
  assert.equal(hub.sessions.get('edit-page').nodes.get(1).s.count, 1, 'do not claim success before device readback');
  hub.ingest({ ...payload, tree: { nodes: [{ ...raw, s: { ...raw.s, count: 3 } }], removed: [] }, screenshot: { id: 1, data: 'data:image/png;base64,test' }, editResults: [{ requestId: 'e2', ok: true }] });
  assert.equal(delta.nodes[0].s.count, 3);
  assert.equal(delta.editResults[0].ok, true);
  assert.ok(delta.screenshot);
  hub.ingest({ pagerId: 'edit-page', sid: 'instance-1', heartbeat: true, editResults: [{ requestId: 'e3', ok: false, error: 'setter failed' }] });
  assert.equal(delta.editResults[0].error, 'setter failed', 'heartbeat must not swallow acknowledgements');
  hub.ingest({ ...payload, tree: { nodes: [], removed: [] } });
  assert.throws(() => hub.enqueueCommand('edit-page', { ...commands[0] }), /missing node/);
} finally { hub.close(); }
console.log('editing: ok');
