'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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
    });

    const logs = await inspect(['logs', '--pager', 'inspect-1', '--query', 'timeout'], project);
    assert.strictEqual(logs.status, 0, logs.stderr);
    const logResult = JSON.parse(logs.stdout);
    assert.strictEqual(logResult.total, 1);
    assert.strictEqual(logResult.logs[0].tag, 'Search');

    const nodes = await inspect(['nodes', '--pager', 'inspect-1', '--query', 'SearchBar'], project);
    assert.strictEqual(nodes.status, 0, nodes.stderr);
    assert.strictEqual(JSON.parse(nodes.stdout).nodes[0].id, 7);

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
    assert.ok(detailResult.savedTo.startsWith(path.join(project, '.kuiklyPageTemp')));
    const saved = JSON.parse(fs.readFileSync(detailResult.savedTo, 'utf8'));
    assert.strictEqual(saved.network.id, 'request-1');
    assert.strictEqual(saved.network.rsp.length > 16 * 1024, true);

    const cleaned = await inspect(['clean-temp'], project);
    assert.strictEqual(cleaned.status, 0, cleaned.stderr);
    assert.strictEqual(JSON.parse(cleaned.stdout).removed, 1);

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
