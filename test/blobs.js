'use strict';

/**
 * Body chunks must reassemble to the original string with no character cap.
 *
 *   node test/blobs.js
 */

const assert = require('assert');
const { applyBlobs, slimForDelta } = require('../src/server/blobs');

function session() {
  return { network: new Map(), networkOrder: [], bodyBuf: new Map() };
}

function chunksOf(id, field, text, size) {
  const count = Math.ceil(text.length / size);
  const blobs = [];
  for (let i = 0; i < count; i += 1) {
    blobs.push({
      id,
      field,
      index: i,
      count,
      data: text.slice(i * size, (i + 1) * size),
    });
  }
  return blobs;
}

const mega = '中'.repeat(250000) + 'A'.repeat(750000);
assert.strictEqual(mega.length, 1_000_000);

const store = session();
store.network.set('m1', { id: 'm1', rspChars: mega.length });
const pieces = chunksOf('m1', 'rsp', mega, 80_000);
assert.ok(pieces.length > 2, 'a megabyte body must span many ingest chunks');

applyBlobs(store, pieces.slice(0, 1));
assert.notStrictEqual(store.network.get('m1').rsp, mega);
applyBlobs(store, pieces.slice(1).reverse());
assert.strictEqual(store.network.get('m1').rsp, mega);
assert.strictEqual(store.network.get('m1').rsp.length, 1_000_000);
assert.strictEqual(store.bodyBuf.size, 0);

const slim = slimForDelta(store.network.get('m1'));
assert.strictEqual(slim.rsp, undefined);
assert.strictEqual(slim.rspChars, 1_000_000);
assert.strictEqual(store.network.get('m1').rsp, mega, 'slimForDelta must not mutate the archive');

const nativeStore = { network: new Map(), native: new Map(), nativeOrder: [], bodyBuf: new Map() };
const argsText = 'A'.repeat(200000);
nativeStore.native.set('n1', { id: 'n1', argsChars: argsText.length });
applyBlobs(nativeStore, chunksOf('n1', 'args', argsText, 80_000));
assert.strictEqual(nativeStore.native.get('n1').args, argsText);
const slimNative = slimForDelta(nativeStore.native.get('n1'));
assert.strictEqual(slimNative.args, undefined);
assert.strictEqual(slimNative.argsChars, 200000);

const orphanArgs = { network: new Map(), native: new Map(), nativeOrder: [], bodyBuf: new Map() };
applyBlobs(orphanArgs, chunksOf('dropped', 'args', 'A'.repeat(1000), 400));
assert.strictEqual(orphanArgs.native.size, 0, 'arg chunks must not create a native row that ingest already dropped');

process.stdout.write('blobs: ok\n');
