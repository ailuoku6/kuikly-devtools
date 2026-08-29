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

function zIndexOf(node) {
  const value = node.p && node.p.zIndex;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function siblingIndex(node) {
  return node.ci ?? node.id;
}

function comparePaintOrder(nodes, left, right, hits) {
  if (left.id === right.id) return 0;
  const pathLeft = pathTo(nodes, left.id);
  const pathRight = pathTo(nodes, right.id);
  const shared = Math.min(pathLeft.length, pathRight.length);
  const stack = hits || [];
  for (let i = 0; i < shared; i++) {
    if (pathLeft[i].id === pathRight[i].id) continue;
    const zDelta =
      (stack.length > 0 ? branchZ(nodes, pathLeft[i], stack) : zIndexOf(pathLeft[i])) -
      (stack.length > 0 ? branchZ(nodes, pathRight[i], stack) : zIndexOf(pathRight[i]));
    if (zDelta !== 0) return zDelta;
    return siblingIndex(pathLeft[i]) - siblingIndex(pathRight[i]);
  }
  return pathLeft.length - pathRight.length;
}

function branchZ(nodes, branchRoot, hits) {
  let max = zIndexOf(branchRoot);
  for (const hit of hits) {
    if (hit.id !== branchRoot.id && !ancestorOf(nodes, hit.id, branchRoot.id)) continue;
    const z = zIndexOf(hit);
    if (z > max) max = z;
  }
  return max;
}

function opacityOf(node) {
  const value = node.p && node.p.opacity;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 1;
}

function hasOwnFill(node) {
  const props = node.p || {};
  if (props.backgroundImage) return true;
  const background = props.backgroundColor;
  if (typeof background === 'string' && background.length > 0 && background !== 'transparent') {
    if (/^0x00/i.test(background)) return false;
    return true;
  }
  if (typeof background === 'number' && background !== 0) return true;
  const name = node.n || '';
  return /Text|Image|RichText/i.test(name);
}

function isLeaf(nodes, node) {
  for (const child of nodes.values()) {
    if (child.pid === node.id) return false;
  }
  return true;
}

function ancestorOf(nodes, nodeId, ancestorId) {
  let cursor = nodes.get(nodeId);
  while (cursor) {
    if (cursor.pid === ancestorId) return true;
    cursor = nodes.get(cursor.pid);
  }
  return false;
}

function intersectionArea(a, b) {
  const left = Math.max(a[0], b[0]);
  const top = Math.max(a[1], b[1]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function coversRoot(nodes, frame) {
  let root;
  for (const item of nodes.values()) {
    if (item.pid === -1 || !nodes.has(item.pid)) {
      root = item;
      break;
    }
  }
  const rootFrame = root && root.f;
  if (!rootFrame || rootFrame[2] <= 0 || rootFrame[3] <= 0) return false;
  return intersectionArea(frame, rootFrame) / (rootFrame[2] * rootFrame[3]) >= 0.9;
}

function paintsPixel(nodes, node) {
  if (node.r === false) return false;
  return isLeaf(nodes, node) || hasOwnFill(node);
}

function isPaintedHit(nodes, node, hits, frame) {
  if (node.r === false) return false;
  if (opacityOf(node) <= 0) return false;
  if (paintsPixel(nodes, node)) return true;
  if (
    hits.some(
      (hit) => hit.id !== node.id && paintsPixel(nodes, hit) && ancestorOf(nodes, hit.id, node.id)
    )
  ) {
    return true;
  }
  return !coversRoot(nodes, frame);
}

function hitTestNode(nodes, x, y) {
  const cache = new Map();
  const visualOf = (item) => {
    if (cache.has(item.id)) return cache.get(item.id);
    const frame = visualFrame(nodes, item);
    cache.set(item.id, frame);
    return frame;
  };

  const containing = [];
  for (const node of nodes.values()) {
    const frame = visualOf(node);
    if (!frame || frame[2] <= 0 || frame[3] <= 0) continue;
    if (!containsPoint(frame, x, y)) continue;
    if (clippedByAncestor(nodes, node, x, y, visualOf)) continue;
    containing.push(node);
  }
  if (containing.length === 0) return null;

  const painted = containing.filter((node) => {
    const frame = visualOf(node);
    return frame ? isPaintedHit(nodes, node, containing, frame) : false;
  });
  const rendered = containing.filter((node) => node.r !== false);
  const pool = painted.length > 0 ? painted : rendered.length > 0 ? rendered : containing;

  let best = null;
  let bestArea = Infinity;
  for (const node of pool) {
    if (best === null) {
      best = node;
      bestArea = (visualOf(node)[2] || 0) * (visualOf(node)[3] || 0);
      continue;
    }
    const order = comparePaintOrder(nodes, node, best, containing);
    const area = (visualOf(node)[2] || 0) * (visualOf(node)[3] || 0);
    if (order > 0 || (order === 0 && area < bestArea)) {
      best = node;
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

// Floating button + bottom bar sit in a later full-page overlay. Tree depth must not beat paint order.
const overlay = new Map([
  [1, { id: 1, pid: -1, ci: 0, n: 'Page', r: true, f: [0, 0, 393, 852] }],
  [2, { id: 2, pid: 1, ci: 0, n: 'Map', r: true, f: [0, 0, 393, 852], p: { zIndex: -2 } }],
  [3, { id: 3, pid: 1, ci: 1, n: 'Card', r: true, f: [0, 400, 393, 452], p: { backgroundColor: '0xFFFFFFFF' } }],
  [4, { id: 4, pid: 3, ci: 0, n: 'Row', r: true, f: [0, 740, 393, 80], p: { backgroundColor: '0xFFEEEEEE' } }],
  [5, { id: 5, pid: 1, ci: 2, n: 'Menus', r: false, cv: true, f: [0, 0, 393, 852] }],
  [6, { id: 6, pid: 5, ci: 0, n: 'Fab', r: true, f: [333, 742, 48, 48], p: { zIndex: 100, backgroundColor: '0xFFFFFFFF' } }],
  [7, { id: 7, pid: 5, ci: 1, n: 'BarHost', r: true, f: [0, 0, 393, 852] }],
  [8, { id: 8, pid: 7, ci: 0, n: 'Bar', r: true, f: [0, 756, 393, 96], p: { backgroundImage: 'linear-gradient' } }],
  [9, { id: 9, pid: 8, ci: 0, n: 'Go', r: true, f: [200, 780, 120, 48], p: { backgroundColor: '0xFF00B83D' } }],
]);

assert.strictEqual(
  hitTestNode(overlay, 350, 760).n,
  'Fab',
  'zIndex 100 FAB wins over a deeper card row under the same pixel'
);
assert.strictEqual(
  hitTestNode(overlay, 220, 800).n,
  'Go',
  'bottom bar button wins over the card row it covers'
);
assert.strictEqual(
  hitTestNode(overlay, 20, 500).n,
  'Card',
  'empty overlay space falls through to the card'
);
assert.strictEqual(
  hitTestNode(overlay, 20, 100).n,
  'Map',
  'empty overlay space over the map falls through to the map'
);

// Nested scroller + virtual list rows covering the page + later FAB overlay.
// ItemDetail-style: inner list `so` pulls the content column over the FAB pixel;
// virtual (r=false) rows must not make that column a painted hit.
const nestedOverlay = new Map([
  [1, { id: 1, pid: -1, ci: 0, n: 'Page', c: 'Page', r: true, f: [0, 0, 393, 886] }],
  [2, { id: 2, pid: 1, ci: 0, n: 'Root', c: 'DivView', r: true, f: [0, 0, 393, 886] }],
  [30, { id: 30, pid: 2, ci: 3, n: 'Card', c: 'TouchControl', r: true, f: [0, 0, 393, 886] }],
  [37, { id: 37, pid: 30, ci: 0, n: 'Scroller', c: 'ScrollerView', r: true, f: [0, 0, 393, 886], so: [0, 638], p: { overflow: 1 } }],
  [54, { id: 54, pid: 37, ci: 0, n: 'List', c: 'WaterfallListView', r: true, f: [0, 687, 393, 837], so: [0, 266], p: { overflow: 1 } }],
  [721, { id: 721, pid: 54, ci: 0, n: 'Content', c: 'ItemDetailContent', r: true, cv: true, f: [0, 903, 393, 888] }],
  [722, { id: 722, pid: 721, ci: 0, n: 'Col', c: 'DivView', r: true, f: [0, 903, 393, 888] }],
  [875, { id: 875, pid: 722, ci: 10, n: 'Row', c: 'DivView', r: false, f: [0, 1612, 393, 83] }],
  [881, { id: 881, pid: 875, ci: 0, n: 'Stop', c: 'TextView', r: true, f: [54, 1612, 72, 21] }],
  [321, { id: 321, pid: 2, ci: 6, n: 'Host', c: 'ConditionView', r: false, f: [0, 0, 0, 0] }],
  [322, { id: 322, pid: 321, ci: 0, n: 'Menus', c: 'BottomMenusView', r: false, cv: true, f: [0, 0, 393, 886] }],
  [389, { id: 389, pid: 322, ci: 0, n: 'Fab', c: 'DivView', r: true, f: [333, 742, 48, 48], p: { zIndex: 100, backgroundColor: '0xFFFFFFFF' } }],
  [391, { id: 391, pid: 389, ci: 0, n: 'Icon', c: 'ImageView', r: true, f: [347, 748, 20, 20] }],
  [324, { id: 324, pid: 322, ci: 1, n: 'Bar', c: 'DivView', r: true, f: [0, 790, 393, 96], p: { backgroundImage: 'linear-gradient' } }],
]);

assert.strictEqual(
  hitTestNode(nestedOverlay, 357, 766).c,
  'ImageView',
  'FAB icon wins over a scrolled ItemDetailContent column that visually covers the same pixel'
);
assert.strictEqual(
  hitTestNode(nestedOverlay, 340, 750).n,
  'Fab',
  'FAB padding (not the 20px icon) still wins over ItemDetailContent'
);
assert.strictEqual(
  hitTestNode(nestedOverlay, 200, 830).n,
  'Bar',
  'bottom bar wins over the scrolled content column'
);
assert.strictEqual(
  hitTestNode(nestedOverlay, 70, 715).n,
  'Stop',
  'clicking a real list text still selects the text, not the overlay'
);

const ts = fs.readFileSync(path.join(__dirname, '..', 'ui', 'src', 'tree.ts'), 'utf8');
assert.ok(ts.includes('export function hitTestNode'), 'tree.ts must export hitTestNode');
assert.ok(ts.includes('export function visualFrame'), 'tree.ts must export visualFrame');
assert.ok(ts.includes('export function comparePaintOrder'), 'tree.ts must export comparePaintOrder');
assert.ok(ts.includes('node.so'), 'tree.ts must read scroller contentOffset');
assert.ok(ts.includes('zIndex'), 'tree.ts must read zIndex for paint order');

process.stdout.write('hit-test: ok\n');
