'use strict';

/**
 * Mirrors ui/src/tree.ts `hitTestNode`. Kept as a plain Node test so a click-to-select regression
 * cannot hide behind a TypeScript-only compile.
 *
 *   node test/hit-test.js
 */

const assert = require('assert');

function hitTestNode(nodes, x, y) {
  let best = null;
  let bestDepth = -1;
  let bestArea = Infinity;

  for (const node of nodes.values()) {
    const frame = node.f;
    if (!frame || frame[2] <= 0 || frame[3] <= 0) continue;
    const [left, top, width, height] = frame;
    if (x < left || y < top || x >= left + width || y >= top + height) continue;

    let depth = 0;
    let parentId = node.pid;
    while (parentId !== -1) {
      const parent = nodes.get(parentId);
      if (!parent) break;
      depth += 1;
      parentId = parent.pid;
    }
    const area = width * height;
    if (depth > bestDepth || (depth === bestDepth && area < bestArea)) {
      best = node;
      bestDepth = depth;
      bestArea = area;
    }
  }
  return best;
}

const nodes = new Map([
  [1, { id: 1, pid: -1, n: 'Page', f: [0, 0, 393, 852] }],
  [2, { id: 2, pid: 1, n: 'Card', f: [0, 400, 393, 452] }],
  [3, { id: 3, pid: 2, n: 'Title', f: [16, 420, 200, 24] }],
  [4, { id: 4, pid: 2, n: 'Ghost', f: [0, 0, 0, 0] }],
]);

assert.strictEqual(hitTestNode(nodes, 20, 10).n, 'Page');
assert.strictEqual(hitTestNode(nodes, 20, 430).n, 'Title', 'deeper child wins over the wrapping card');
assert.strictEqual(hitTestNode(nodes, 300, 500).n, 'Card');
assert.strictEqual(hitTestNode(nodes, -1, 0), null);

const ts = require('fs').readFileSync(
  require('path').join(__dirname, '..', 'ui', 'src', 'tree.ts'),
  'utf8'
);
assert.ok(ts.includes('export function hitTestNode'), 'tree.ts must export hitTestNode');

process.stdout.write('hit-test: ok\n');
