'use strict';

/**
 * Mirrors ui/src/tree.ts `hitTestNode` / `visualFrame`. Kept as a plain Node test so a
 * click-to-select regression cannot hide behind a TypeScript-only compile.
 *
 *   node test/hit-test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function scrollOffset(node) {
  const offset = node.so;
  if (!Array.isArray(offset) || offset.length < 2) return null;
  const x = Number(offset[0]);
  const y = Number(offset[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

function pathTo(nodes, id) {
  const chain = [];
  let cursor = nodes.get(id);
  while (cursor) {
    chain.unshift(cursor);
    cursor = nodes.get(cursor.pid);
  }
  return chain;
}

function scrollAdjustedOrigin(nodes, node) {
  const frame = node.f;
  if (!frame) return null;
  let x = frame[0];
  let y = frame[1];
  let ancestor = nodes.get(node.pid);
  while (ancestor) {
    const offset = scrollOffset(ancestor);
    if (offset) {
      x -= offset[0];
      y -= offset[1];
    }
    ancestor = nodes.get(ancestor.pid);
  }
  return [x, y, frame[2], frame[3]];
}

function parseTransform(raw) {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('|');
  if (parts.length < 4) return null;
  const scale = parts[1].trim().split(/\s+/);
  const translate = parts[2].trim().split(/\s+/);
  const anchor = parts[3].trim().split(/\s+/);
  const rotate = Number(parts[0]);
  const scaleX = Number(scale[0]);
  const scaleY = Number(scale[1] ?? scale[0]);
  const translateX = Number(translate[0]);
  const translateY = Number(translate[1] ?? 0);
  const anchorX = Number(anchor[0]);
  const anchorY = Number(anchor[1] ?? 0.5);
  if (![rotate, scaleX, scaleY, translateX, translateY, anchorX, anchorY].every(Number.isFinite)) {
    return null;
  }
  return { rotate, scaleX, scaleY, translateX, translateY, anchorX, anchorY };
}

function isIdentityTransform(transform) {
  return (
    transform.rotate === 0 &&
    transform.scaleX === 1 &&
    transform.scaleY === 1 &&
    transform.translateX === 0 &&
    transform.translateY === 0
  );
}

function applyTransform(x, y, transform, width, height) {
  const anchorX = transform.anchorX * width;
  const anchorY = transform.anchorY * height;
  let px = anchorX + (x - anchorX) * transform.scaleX;
  let py = anchorY + (y - anchorY) * transform.scaleY;
  if (transform.rotate !== 0) {
    const rad = (transform.rotate * Math.PI) / 180;
    const dx = px - anchorX;
    const dy = py - anchorY;
    px = anchorX + dx * Math.cos(rad) - dy * Math.sin(rad);
    py = anchorY + dx * Math.sin(rad) + dy * Math.cos(rad);
  }
  px += transform.translateX * width;
  py += transform.translateY * height;
  return [px, py];
}

function transformRect(rect, transform, originX, originY, originW, originH) {
  const corners = [
    [rect[0], rect[1]],
    [rect[0] + rect[2], rect[1]],
    [rect[0] + rect[2], rect[1] + rect[3]],
    [rect[0], rect[1] + rect[3]],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [pageX, pageY] of corners) {
    const [localX, localY] = applyTransform(
      pageX - originX,
      pageY - originY,
      transform,
      originW,
      originH
    );
    const x = originX + localX;
    const y = originY + localY;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX - minX, maxY - minY];
}

function visualFrame(nodes, node) {
  const frame = node.f;
  if (!frame || frame[2] <= 0 || frame[3] <= 0) return null;
  let x = frame[0];
  let y = frame[1];
  let ancestor = nodes.get(node.pid);
  while (ancestor) {
    const offset = scrollOffset(ancestor);
    if (offset) {
      x -= offset[0];
      y -= offset[1];
    }
    ancestor = nodes.get(ancestor.pid);
  }
  let rect = [x, y, frame[2], frame[3]];
  const chain = pathTo(nodes, node.id);
  for (let i = chain.length - 1; i >= 0; i--) {
    const item = chain[i];
    const transform = parseTransform(item.p && item.p.transform);
    if (!transform || isIdentityTransform(transform)) continue;
    const origin = scrollAdjustedOrigin(nodes, item);
    if (!origin) continue;
    rect = transformRect(rect, transform, origin[0], origin[1], origin[2], origin[3]);
  }
  return rect;
}

function containsPoint(frame, x, y) {
  return x >= frame[0] && y >= frame[1] && x < frame[0] + frame[2] && y < frame[1] + frame[3];
}

function clipsContent(node) {
  const overflow = node.p && node.p.overflow;
  if (overflow === 0 || overflow === false) return false;
  if (overflow === 1 || overflow === true) return true;
  return Array.isArray(node.so);
}

function clippedByAncestor(nodes, node, x, y, visualOf) {
  let ancestor = nodes.get(node.pid);
  while (ancestor) {
    if (clipsContent(ancestor)) {
      const clip = visualOf(ancestor);
      if (!clip || !containsPoint(clip, x, y)) return true;
    }
    ancestor = nodes.get(ancestor.pid);
  }
  return false;
}

function hitTestNode(nodes, x, y) {
  let best = null;
  let bestDepth = -1;
  let bestArea = Infinity;
  const cache = new Map();
  const visualOf = (item) => {
    if (cache.has(item.id)) return cache.get(item.id);
    const frame = visualFrame(nodes, item);
    cache.set(item.id, frame);
    return frame;
  };

  for (const node of nodes.values()) {
    const frame = visualOf(node);
    if (!frame || frame[2] <= 0 || frame[3] <= 0) continue;
    if (!containsPoint(frame, x, y)) continue;
    if (clippedByAncestor(nodes, node, x, y, visualOf)) continue;

    let depth = 0;
    let parentId = node.pid;
    while (parentId !== -1) {
      const parent = nodes.get(parentId);
      if (!parent) break;
      depth += 1;
      parentId = parent.pid;
    }
    const area = frame[2] * frame[3];
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

// Nested scroller: layout `f` stays in content space; screenshot is shifted by contentOffset.
const nested = new Map([
  [1, { id: 1, pid: -1, n: 'Page', f: [0, 0, 393, 852] }],
  [2, { id: 2, pid: 1, n: 'Scroller', f: [0, 0, 393, 852], so: [0, 400], p: { overflow: 1 } }],
  [3, { id: 3, pid: 2, n: 'Content', f: [0, 0, 393, 1400] }],
  [4, { id: 4, pid: 3, n: 'Pad', f: [0, 0, 393, 600] }],
  [5, { id: 5, pid: 3, n: 'Sheet', f: [0, 600, 393, 800] }],
  [6, { id: 6, pid: 5, n: 'Handle', f: [160, 612, 72, 20] }],
]);

assert.strictEqual(
  hitTestNode(nested, 20, 220).n,
  'Sheet',
  'click on the visible sheet, not the layout-space pad that used to cover that y'
);
assert.strictEqual(
  hitTestNode(nested, 180, 222).n,
  'Handle',
  'scrolled child keeps winning by depth after offset correction'
);
assert.strictEqual(
  hitTestNode(nested, 20, 50).n,
  'Pad',
  'the unclipped remainder of the pad is still visible at the top of the scroller'
);
assert.strictEqual(
  hitTestNode(nested, 20, 900),
  null,
  'below the scroller viewport is clipped away'
);

// Inner list item scrolled so its visual box overlaps the header; overflow clip must reject it.
const clipped = new Map([
  [1, { id: 1, pid: -1, n: 'Page', f: [0, 0, 393, 852] }],
  [2, { id: 2, pid: 1, n: 'Header', f: [0, 0, 393, 80] }],
  [3, { id: 3, pid: 1, n: 'List', f: [0, 80, 393, 400], so: [0, 500], p: { overflow: 1 } }],
  [4, { id: 4, pid: 3, n: 'Row', f: [0, 500, 393, 40] }],
]);
assert.strictEqual(
  hitTestNode(clipped, 20, 40).n,
  'Header',
  'row visual y overlaps the header but sits outside the list viewport'
);
assert.strictEqual(
  hitTestNode(clipped, 20, 100).n,
  'List',
  'list viewport is empty at this offset, so the list itself is the hit'
);

// Scale around center on a full-page wrapper (sheet chrome).
const scaled = new Map([
  [1, { id: 1, pid: -1, n: 'Page', f: [0, 0, 200, 200] }],
  [2, {
    id: 2,
    pid: 1,
    n: 'Scaled',
    f: [0, 0, 200, 200],
    p: { transform: '0.0|0.5 0.5|0.0 0.0|0.5 0.5|0.0 0.0|0.0 0.0' },
  }],
  [3, { id: 3, pid: 2, n: 'Inner', f: [0, 0, 200, 200] }],
]);
assert.strictEqual(
  hitTestNode(scaled, 100, 100).n,
  'Inner',
  'center of a 0.5 scale still hits the inner node'
);
assert.strictEqual(
  hitTestNode(scaled, 10, 10).n,
  'Page',
  'outside the scaled box falls through to the page'
);

const ts = fs.readFileSync(path.join(__dirname, '..', 'ui', 'src', 'tree.ts'), 'utf8');
assert.ok(ts.includes('export function hitTestNode'), 'tree.ts must export hitTestNode');
assert.ok(ts.includes('export function visualFrame'), 'tree.ts must export visualFrame');
assert.ok(ts.includes('node.so'), 'tree.ts must read scroller contentOffset');

process.stdout.write('hit-test: ok\n');
