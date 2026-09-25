'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const { startServers, INGEST_PATH } = require('../src');
const { isPortFree } = require('../src/util/net');
const { commandInitSkill } = require('../src/cli');

let INGEST_PORT;
let PANEL_PORT;

function post(port, requestPath, body) {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body);
    const request = http.request({
      host: '127.0.0.1', port, path: requestPath, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) },
    }, (response) => {
      response.resume();
      response.on('end', resolve);
    });
    request.once('error', reject);
    request.end(text);
  });
}

function inspect(args, project) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      path.join(__dirname, '..', 'bin', 'kuikly-devtools.js'), 'inspect', ...args,
      '--panel-port', String(PANEL_PORT), '--project', project,
    ]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

async function run() {
  const base = 20000 + ((process.pid * 2) % 1000);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = base + attempt * 2;
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(candidate) && await isPortFree(candidate + 1)) {
      INGEST_PORT = candidate;
      PANEL_PORT = candidate + 1;
      break;
    }
  }
  if (!INGEST_PORT) throw new Error('could not find free inspect test ports');
  const servers = await startServers({ ingestPort: INGEST_PORT, panelPort: PANEL_PORT });
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kuikly-page-inspect-'));
  try {
    await post(INGEST_PORT, INGEST_PATH, {
      v: 1, pagerId: 'inspect-1', page: 'SearchPage', class: 'SearchPage', platform: 'android', seq: 0,
      full: true, ts: Date.now(), sampleMs: 500,
      tree: {
        total: 1, changed: 1, removed: [],
        nodes: [{ id: 7, pid: -1, n: 'SearchBar', c: 'SearchBarView', r: true, cv: false,
          f: [0, 0, 100, 40], p: { hint: 'Search', requestId: 'suggestions-42' }, hs: true }],
      },
      logs: [{ seq: 0, lv: 'e', tag: 'Search', msg: 'request timeout while loading suggestions', ts: Date.now() }],
      network: [{
        id: 'request-1', url: 'https://example.test/suggestions', method: 'GET', stack: 'KRNetworkModule',
        ts: Date.now(), status: 500, ok: false, rsp: JSON.stringify({ payload: 'x'.repeat(18 * 1024) }),
      }],
      native: [{
        id: 'nc-1', mod: 'CalendarModule', method: 'getReminderList', via: 'KuiklyTDFModule.asyncCall',
        sync: false, args: JSON.stringify({ busId: 'line-9' }), ts: Date.now(), ok: true, cost: 18,
        rsp: '{"code":0,"data":{"count":2}}',
      }],
    });

    const logs = await inspect(['logs', '--pager', 'inspect-1', '--query', 'timeout'], project);
    assert.strictEqual(logs.status, 0, logs.stderr);
    const logResult = JSON.parse(logs.stdout);
    assert.strictEqual(logResult.total, 1);
    assert.strictEqual(logResult.logs[0].tag, 'Search');

    const nodes = await inspect(['nodes', '--pager', 'inspect-1', '--query', 'SearchBar'], project);
    assert.strictEqual(nodes.status, 0, nodes.stderr);
    assert.strictEqual(JSON.parse(nodes.stdout).nodes[0].id, 7);

    const native = await inspect(['native', '--pager', 'inspect-1', '--query', 'CalendarModule'], project);
    assert.strictEqual(native.status, 0, native.stderr);
    const nativeResult = JSON.parse(native.stdout);
    assert.strictEqual(nativeResult.total, 1);
    assert.strictEqual(nativeResult.native[0].mod, 'CalendarModule');
    assert.ok(nativeResult.native[0].argsPreview);

    const nativeDetail = await inspect(['native-detail', '--pager', 'inspect-1', '--id', 'nc-1'], project);
    assert.strictEqual(nativeDetail.status, 0, nativeDetail.stderr);
    assert.strictEqual(JSON.parse(nativeDetail.stdout).native.method, 'getReminderList');

    const nodeProps = await inspect(['nodes', '--pager', 'inspect-1', '--query', 'suggestions-42'], project);
    assert.strictEqual(nodeProps.status, 0, nodeProps.stderr);
    assert.strictEqual(JSON.parse(nodeProps.stdout).nodes[0].props.requestId, 'suggestions-42');

    const logDetail = await inspect(['log-detail', '--pager', 'inspect-1', '--id', '0'], project);
    assert.strictEqual(logDetail.status, 0, logDetail.stderr);
    const logDetailResult = JSON.parse(logDetail.stdout);
    assert.strictEqual(logDetailResult.log.msg.includes('timeout'), true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(logDetailResult, 'savedTo'), false);

    const detail = await inspect(['network-detail', '--pager', 'inspect-1', '--id', 'request-1'], project);
    assert.strictEqual(detail.status, 0, detail.stderr);
    const detailResult = JSON.parse(detail.stdout);
    assert.ok(detailResult.savedTo, 'large network body must be written to a project-local temp file');
    assert.ok(detailResult.savedTo.startsWith(path.join(project, '.kuiklyDevtoolTemp')));
    const saved = JSON.parse(fs.readFileSync(detailResult.savedTo, 'utf8'));
    assert.strictEqual(saved.network.id, 'request-1');
    assert.strictEqual(saved.network.rsp.length > 16 * 1024, true);

    const cleaned = await inspect(['clean-temp'], project);
    assert.strictEqual(cleaned.status, 0, cleaned.stderr);
    assert.strictEqual(JSON.parse(cleaned.stdout).removed, 1);

    // Exercise the installed CLI against the real server and an asynchronously polling device.
    let liveNode = { id: 7, pid: -1, n: 'SearchBar', c: 'SearchBarView', r: true, hs: true,
      p: { width: 100, backgroundColor: '4294901760', hint: 'Search' },
      e: { p: { width: 'Float', backgroundColor: 'String', hint: 'String' } } };
    servers.hub.ingest({ pagerId: 'inspect-1', tree: { nodes: [liveNode] } });
    let schemaResults = [];
    let acknowledgements = [];
    servers.hub.ingest({ pagerId: 'inspect-1', capabilities: ['propSchemaV1'] });
    const observer = new WebSocket(`ws://127.0.0.1:${PANEL_PORT}/ws`);
    const leakedSchemas = [];
    observer.on('message', (raw) => { const msg = JSON.parse(raw); if (msg.propSchemaResults?.length) leakedSchemas.push(msg); });
    const applied = [];
    const poller = setInterval(() => {
      const reply = servers.hub.ingest({ pagerId: 'inspect-1', tree: { nodes: [liveNode] }, editResults: acknowledgements, propSchemaResults: schemaResults });
      schemaResults = [];
      acknowledgements = [];
      for (const command of reply.commands) {
        if (command.type === 'inspectProps') {
          schemaResults.push({ requestId: command.requestId, ok: true, id: 7, schemaVersion: 1, schemaToken: 'test-node-7', properties: [
            { key: 'color', inputType: 'color', wireType: 'argb32', reported: false },
            { key: 'visibility', inputType: 'boolean', wireType: 'Boolean', reported: false },
          ] });
        } else if (command.type === 'edit') {
          applied.push(command);
          if (command.value === 'reject-me') {
            acknowledgements.push({ requestId: command.requestId, ok: false, error: 'Custom setter rejected value' });
          } else {
            liveNode = { ...liveNode, [command.target]: { ...liveNode[command.target], [command.key]: command.value } };
            acknowledgements.push({ requestId: command.requestId, ok: true, ...(command.mode ? { readback: { key: command.key, inputType: command.key === 'color' ? 'color' : 'boolean', readable: true, value: command.value } } : {}) });
          }
        } else if (command.type === 'state') {
          liveNode = { ...liveNode, s: { enabled: true }, e: { ...liveNode.e, s: { enabled: 'Boolean' } } };
        }
      }
    }, 20);
    const editArgs = ['edit', '--pager', 'inspect-1', '--id', '7', '--target', 'p'];
    try {
      const props = await inspect(['props', '--pager', 'inspect-1', '--id', '7'], project);
      assert.equal(props.status, 0, props.stderr || props.stdout);
      assert.equal(JSON.parse(props.stdout).properties[0].key, 'color');
      const added = await inspect([...editArgs, '--key', 'color', '--value', '"#80112233"', '--set-supported'], project);
      assert.equal(added.status, 0, added.stderr || added.stdout);
      assert.equal(JSON.parse(added.stdout).value, '0x80112233');
      assert.equal(applied.at(-1).value, 2148606515);
      assert.equal(applied.at(-1).schemaToken, 'test-node-7');
      const boolean = await inspect([...editArgs, '--key', 'visibility', '--value', 'false', '--set-supported'], project);
      assert.equal(boolean.status, 0, boolean.stderr || boolean.stdout);
      assert.equal(JSON.parse(boolean.stdout).value, false);
      assert.equal(leakedSchemas.length, 0, 'schema queries must only reach their requesting socket');
      const edited = await inspect([...editArgs, '--key', 'width', '--value', '125.5'], project);
      assert.equal(edited.status, 0, edited.stderr || edited.stdout);
      assert.equal(JSON.parse(edited.stdout).ok, true);
      assert.equal(JSON.parse(edited.stdout).value, 125.5);
      const color = await inspect([...editArgs, '--key', 'backgroundColor', '--value', '"#80112233"'], project);
      assert.equal(color.status, 0, color.stderr || color.stdout);
      assert.equal(JSON.parse(color.stdout).value, '0x80112233');
      assert.equal(applied.at(-1).value, '2148606515');
      const state = await inspect(['state', '--pager', 'inspect-1', '--id', '7'], project);
      assert.equal(state.status, 0, state.stderr || state.stdout);
      assert.equal(JSON.parse(state.stdout).node.e.s.enabled, 'Boolean');
      const stateEdit = await inspect(['edit', '--pager', 'inspect-1', '--id', '7', '--target', 's', '--key', 'enabled', '--value', 'false'], project);
      assert.equal(stateEdit.status, 0, stateEdit.stderr || stateEdit.stdout);
      assert.equal(JSON.parse(stateEdit.stdout).value, false);
      const beforeInvalid = applied.length;
      for (const args of [
        [...editArgs, '--key', 'width', '--value', '"invalid"'],
        [...editArgs, '--key', 'readOnly', '--value', '1'],
        [...editArgs, '--key', 'hint', '--value', 'not-json'],
      ]) {
        const invalid = await inspect(args, project);
        assert.notEqual(invalid.status, 0);
      }
      assert.equal(applied.length, beforeInvalid, 'invalid CLI edits must not reach the device');
      const rejected = await inspect([...editArgs, '--key', 'hint', '--value', '"reject-me"'], project);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr + rejected.stdout, /Custom setter rejected/);
      assert.equal(applied.length, beforeInvalid + 1, 'failed edits must never be automatically replayed');
    } finally { clearInterval(poller); observer.close(); }
    const timedOut = await inspect([...editArgs, '--key', 'width', '--value', '140', '--timeout-ms', '100'], project);
    assert.notEqual(timedOut.status, 0);
    assert.match(timedOut.stdout + timedOut.stderr, /may still apply/);

    assert.strictEqual(commandInitSkill({ project, force: false }), 0);
    for (const client of ['.codex', '.claude', '.cursor']) {
      assert.ok(fs.existsSync(path.join(project, client, 'skills', 'kuikly-page-inspect', 'SKILL.md')));
    }
  } finally {
    await servers.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
}

run()
  .then(() => process.stdout.write('inspect: ok\n'))
  .catch((error) => {
    process.stderr.write(`inspect: FAILED\n${error.stack || error.message}\n`);
    process.exit(1);
  });
