'use strict';

/**
 * Pins the wire field names on both sides of the protocol.
 *
 * The Kotlin agent and the JS server/panel are separate codebases that only agree by convention, so
 * a rename on either side would silently produce empty panels. This test reads the actual `put("x")`
 * keys out of the Kotlin runtime and compares them with what the TypeScript types declare.
 *
 *   node test/protocol-contract.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime', 'kotlin', 'com', 'ailuoku6', 'kuikly', 'devtools');
const PROTOCOL_TS = path.join(ROOT, 'ui', 'src', 'protocol.ts');

function kotlinKeys(fileName) {
  const source = fs.readFileSync(path.join(RUNTIME, fileName), 'utf8');
  const keys = new Set();
  for (const match of source.matchAll(/put\("([^"]+)"/g)) {
    keys.add(match[1]);
  }
  // Body field names are constants (`FIELD_REQ = "req"`) passed to `put(field, …)`.
  for (const match of source.matchAll(/const val FIELD_\w+\s*=\s*"([^"]+)"/g)) {
    keys.add(match[1]);
  }
  return keys;
}

function assertContains(actual, expected, label) {
  const missing = expected.filter((key) => !actual.has(key));
  assert.strictEqual(
    missing.length,
    0,
    `${label}: Kotlin no longer emits ${missing.join(', ')} (found: ${[...actual].sort().join(', ')})`
  );
}

// --- envelope + tree ------------------------------------------------------------
const sessionKeys = kotlinKeys('KDevtoolsSession.kt');
assertContains(
  sessionKeys,
  ['v', 'pagerId', 'sid', 'page', 'class', 'platform', 'seq', 'ts', 'full', 'sampleMs', 'droppedLogs',
    'tree', 'logs', 'network', 'blobs', 'device', 'nodes', 'removed', 'total', 'changed', 'destroyed',
    'screenshot', 'id', 'sample', 'data', 'err', 'ox', 'oy', 'ow', 'oh', 'live'],
  'payload envelope'
);

const treeKeys = kotlinKeys('KDevtoolsTree.kt');
assertContains(treeKeys, ['id', 'pid', 'ci', 'n', 'c', 'r', 'cv', 'f', 'lf', 'so', 'p', 'hs', 's', 'as'], 'NodeDto');

const logKeys = kotlinKeys('KDevtoolsLog.kt');
assertContains(logKeys, ['seq', 'lv', 'tag', 'msg', 'ts'], 'LogDto');
assertContains(
  logKeys,
  ['id', 'url', 'method', 'stack', 'req', 'hdr', 'ts', 'cost', 'status', 'ok', 'rsp', 'err',
    'kind', 'msgs', 'frames', 'dir', 'data', 'field', 'index', 'count', 'dataChars'],
  'NetworkDto'
);

// --- the TypeScript side must declare every key the agent sends ----------------
const protocolTs = fs.readFileSync(PROTOCOL_TS, 'utf8');
for (const key of ['ci', 'hs', 'cv', 'lf', 'so', 'stack', 'droppedLogs', 'sampleMs', 'sid', 'destroyed', 'kind', 'msgs', 'frames', 'screenshot', 'shot', 'live', 'ox', 'oy', 'ow', 'oh', 'blobs', 'rspChars', 'reqChars', 'hdr']) {
  assert.ok(protocolTs.includes(key), `protocol.ts is missing the "${key}" field`);
}

// --- the ingest path must be identical on both sides ---------------------------
const transport = fs.readFileSync(path.join(RUNTIME, 'KDevtoolsTransport.kt'), 'utf8');
const { INGEST_PATH } = require('../src/server/ingest');
assert.ok(
  transport.includes(`"${INGEST_PATH}"`),
  `Kotlin transport path does not match the server's ${INGEST_PATH}`
);

// The bridge tap drops the agent's own uploads by matching this same path.
const tap = fs.readFileSync(path.join(RUNTIME, 'KDevtoolsBridgeTap.kt'), 'utf8');
assert.ok(
  tap.includes('KDevtoolsTransport.isOwnServeUrl') &&
    tap.includes('isEmittingOwnUpload'),
  'the bridge tap must filter the agent\'s own uploads (URL marker + upload reentrancy)'
);
assert.ok(
  transport.includes('SERVE_PATH_MARKER') && transport.includes('"__kuikly_devtools"'),
  'transport must expose a slash-free serve marker (Kuikly JSON escapes / as \\/)'
);
const { SERVE_PATH_MARKER } = require('../src/server/ingest');
assert.equal(
  SERVE_PATH_MARKER,
  '__kuikly_devtools',
  'server serve-path marker must stay aligned with the Kotlin agent'
);

assert.ok(
  tap.includes('TMLongLinkModule') && tap.includes('UPDATE_INSTANCE'),
  'the bridge tap must capture TMLongLinkModule subscribe/observe and pager-event pushes'
);
assert.ok(
  tap.includes('isHttpEnvelope') && tap.includes('extractHttpBody') && tap.includes('respBody'),
  'HTTP callbacks must keep the full body; nested API `data` is not the envelope'
);
assert.ok(
  fs.readFileSync(path.join(RUNTIME, 'KDevtoolsLog.kt'), 'utf8').includes('CHUNK_SIZE') &&
    fs.readFileSync(path.join(RUNTIME, 'KDevtoolsLog.kt'), 'utf8').includes('enqueueChunks') &&
    fs.readFileSync(path.join(RUNTIME, 'KDevtoolsLog.kt'), 'utf8').includes('snapshotBlobs'),
  'bodies larger than INLINE_MAX must be split into ingest blobs, not truncated'
);
assert.ok(
  !fs.readFileSync(path.join(RUNTIME, 'KDevtoolsLog.kt'), 'utf8').includes('MAX_BODY_CHARS'),
  'must not clamp network bodies to a fixed character cap'
);

// --- log levels ---------------------------------------------------------------
const agent = fs.readFileSync(path.join(RUNTIME, 'KDevtools.kt'), 'utf8');
for (const level of ['"i"', '"d"', '"e"', '"p"']) {
  assert.ok(agent.includes(level), `log level ${level} missing from the agent`);
}
const consolePanel = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'components', 'ConsolePanel.tsx'), 'utf8');
for (const level of ["'i'", "'d'", "'e'", "'p'"]) {
  assert.ok(consolePanel.includes(level), `log level ${level} missing from the console panel`);
}

// --- device commands ----------------------------------------------------------
for (const command of ['"full"', '"state"', '"sample"', '"clear"', '"shot"', '"live"']) {
  assert.ok(
    fs.readFileSync(path.join(RUNTIME, 'KDevtoolsSession.kt'), 'utf8').includes(command),
    `command ${command} not handled by the agent`
  );
}

assert.ok(
  fs.readFileSync(path.join(RUNTIME, 'KDevtoolsSession.kt'), 'utf8').includes('toImage') &&
    fs.readFileSync(path.join(RUNTIME, 'KDevtoolsSession.kt'), 'utf8').includes('DATA_URI'),
  'the agent must capture screenshots via DeclarativeBaseView.toImage(DATA_URI)'
);

const sessionSrc = fs.readFileSync(path.join(RUNTIME, 'KDevtoolsSession.kt'), 'utf8');
assert.ok(
  sessionSrc.includes('BLOB_BUDGET_CHARS') &&
    !sessionSrc.includes('Int.MAX_VALUE / 4'),
  'destroy ingest must keep chunking leftover bodies instead of stuffing them into one POST'
);
assert.ok(
  sessionSrc.includes('const val DEFAULT_LIVE_MS = 2000'),
  'live screenshots must default to 2000ms — 500ms toImage cooks the device'
);
assert.ok(
  sessionSrc.includes('liveNeedsFrame'),
  'live screenshots must skip toImage while the tree is unchanged'
);
assert.ok(
  protocolTs.includes('LIVE_SHOT_INTERVAL_MS = 2000'),
  'the panel must request live screenshots at 2000ms'
);
assert.ok(
  sessionSrc.includes('const val AUX_FLUSH_MS = 1500L'),
  'logs and network must be held in the agent buffer instead of POSTing on every sample tick'
);

assert.ok(
  tap.includes('extractRequestHeaders') && tap.includes('cookie'),
  'HTTP capture must collect request headers (and fold KRNetworkModule cookie into them)'
);
assert.ok(
  fs.readFileSync(path.join(ROOT, 'ui', 'src', 'components', 'NetworkPanel.tsx'), 'utf8').includes('复制为 curl'),
  'the network panel must offer copy-as-curl for ordinary HTTP'
);
assert.ok(
  fs.readFileSync(path.join(ROOT, 'ui', 'src', 'curl.ts'), 'utf8').includes('--data-raw'),
  'copy-as-curl must emit a replayable curl command'
);

const jsonSrc = fs.readFileSync(path.join(RUNTIME, 'KDevtoolsJson.kt'), 'utf8');
assert.ok(
  jsonSrc.includes('sortBy { it.first }'),
  'copyPropsMap keys must be sorted before they hit JSONObject, otherwise one prop update reshuffles the inspector'
);
const inspectorSrc = fs.readFileSync(path.join(ROOT, 'ui', 'src', 'components', 'Inspector.tsx'), 'utf8');
assert.ok(
  inspectorSrc.includes('sortedEntries') && inspectorSrc.includes('sortedJson'),
  'the inspector must sort props before rendering'
);
assert.ok(
  jsonSrc.includes('fun isColorKey') && jsonSrc.includes('0x'),
  'colour props must be encoded as 0xAARRGGBB, not a signed Int'
);
assert.ok(
  inspectorSrc.includes('toArgbHex') && inspectorSrc.includes('0x'),
  'the inspector must render colour props as 0xAARRGGBB'
);
{
  const bits = -14101165 >>> 0;
  const hex = `0x${bits.toString(16).toUpperCase().padStart(8, '0')}`;
  assert.strictEqual(hex.length, 10, 'ARGB hex is 0x + 8 digits');
  assert.ok(hex.startsWith('0xFF') || hex.startsWith('0x'), hex);
}

process.stdout.write('protocol-contract: ok\n');
