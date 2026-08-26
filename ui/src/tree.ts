import type { NodeDto } from './protocol';

export interface TreeRow {
  node: NodeDto;
  depth: number;
  childCount: number;
  expanded: boolean;
}

export interface TreeIndex {
  childrenOf: Map<number, NodeDto[]>;
  roots: NodeDto[];
}

/** Groups nodes by parent and orders siblings by template index (falling back to nativeRef). */
export function indexTree(nodes: Map<number, NodeDto>): TreeIndex {
  const childrenOf = new Map<number, NodeDto[]>();
  const roots: NodeDto[] = [];

  for (const node of nodes.values()) {
    if (node.pid === -1 || !nodes.has(node.pid)) {
      roots.push(node);
      continue;
    }
    const bucket = childrenOf.get(node.pid);
    if (bucket) bucket.push(node);
    else childrenOf.set(node.pid, [node]);
  }

  const byOrder = (a: NodeDto, b: NodeDto) => (a.ci ?? a.id) - (b.ci ?? b.id) || a.id - b.id;
  roots.sort(byOrder);
  for (const bucket of childrenOf.values()) bucket.sort(byOrder);

  return { childrenOf, roots };
}

export function matchesQuery(node: NodeDto, query: string): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  if (node.n.toLowerCase().includes(needle)) return true;
  if (node.c.toLowerCase().includes(needle)) return true;
  if (String(node.id) === query) return true;
  if (node.p) {
    for (const [key, value] of Object.entries(node.p)) {
      if (key.toLowerCase().includes(needle)) return true;
      if (typeof value === 'string' && value.toLowerCase().includes(needle)) return true;
    }
  }
  return false;
}

/**
 * Flattens the tree into the visible row list.
 *
 * With a query the set of kept nodes is matches plus all their ancestors, so a hit deep in the tree
 * stays reachable; those ancestors are force-expanded regardless of the collapsed set.
 */
export function buildRows(
  nodes: Map<number, NodeDto>,
  collapsed: Set<number>,
  query: string,
  composeOnly: boolean
): TreeRow[] {
  const { childrenOf, roots } = indexTree(nodes);
  const filtering = query.length > 0 || composeOnly;

  let keep: Set<number> | null = null;
  if (filtering) {
    keep = new Set<number>();
    for (const node of nodes.values()) {
      const hit = (!composeOnly || node.cv) && matchesQuery(node, query);
      if (!hit) continue;
      let cursor: NodeDto | undefined = node;
      while (cursor && !keep.has(cursor.id)) {
        keep.add(cursor.id);
        cursor = nodes.get(cursor.pid);
      }
    }
  }

  const rows: TreeRow[] = [];
  const walk = (node: NodeDto, depth: number): void => {
    if (keep && !keep.has(node.id)) return;
    const allChildren = childrenOf.get(node.id) ?? [];
    const children = keep ? allChildren.filter((child) => keep!.has(child.id)) : allChildren;
    const expanded = filtering || !collapsed.has(node.id);
    rows.push({ node, depth, childCount: children.length, expanded });
    if (!expanded) return;
    for (const child of children) walk(child, depth + 1);
  };

  for (const root of roots) walk(root, 0);
  return rows;
}

export function pathTo(nodes: Map<number, NodeDto>, id: number): NodeDto[] {
  const path: NodeDto[] = [];
  let cursor = nodes.get(id);
  while (cursor) {
    path.unshift(cursor);
    cursor = nodes.get(cursor.pid);
  }
  return path;
}

export type VisualFrame = [number, number, number, number];

/**
 * Layout `f` is convertFrame (page-root, scroll/transform ignored). Screenshots are what was
 * actually drawn, so pick/overlay walk ancestor `so` (ScrollerView contentOffset) and `p.transform`.
 */
export function visualFrame(nodes: Map<number, NodeDto>, node: NodeDto): VisualFrame | null {
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

  let rect: VisualFrame = [x, y, frame[2], frame[3]];
  const chain = pathTo(nodes, node.id);
  for (let i = chain.length - 1; i >= 0; i--) {
    const item = chain[i];
    const transform = parseTransform(item.p?.transform);
    if (!transform || isIdentityTransform(transform)) continue;
    const origin = scrollAdjustedOrigin(nodes, item);
    if (!origin) continue;
    rect = transformRect(rect, transform, origin[0], origin[1], origin[2], origin[3]);
  }
  return rect;
}

function scrollOffset(node: NodeDto): [number, number] | null {
  const offset = node.so;
  if (!Array.isArray(offset) || offset.length < 2) return null;
  const x = Number(offset[0]);
  const y = Number(offset[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return [x, y];
}

function scrollAdjustedOrigin(nodes: Map<number, NodeDto>, node: NodeDto): VisualFrame | null {
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

interface ViewTransform {
  rotate: number;
  scaleX: number;
  scaleY: number;
  translateX: number;
  translateY: number;
  anchorX: number;
  anchorY: number;
}

/** Kuikly Attr.transform wire form: `rotate|sx sy|tx ty|ax ay|skewH skewV|rx ry`. */
function parseTransform(raw: unknown): ViewTransform | null {
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
  if (
    ![rotate, scaleX, scaleY, translateX, translateY, anchorX, anchorY].every((value) =>
      Number.isFinite(value)
    )
  ) {
    return null;
  }
  return { rotate, scaleX, scaleY, translateX, translateY, anchorX, anchorY };
}

function isIdentityTransform(transform: ViewTransform): boolean {
  return (
    transform.rotate === 0 &&
    transform.scaleX === 1 &&
    transform.scaleY === 1 &&
    transform.translateX === 0 &&
    transform.translateY === 0
  );
}

function transformRect(
  rect: VisualFrame,
  transform: ViewTransform,
  originX: number,
  originY: number,
  originW: number,
  originH: number
): VisualFrame {
  const corners: Array<[number, number]> = [
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

function applyTransform(
  x: number,
  y: number,
  transform: ViewTransform,
  width: number,
  height: number
): [number, number] {
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

function containsPoint(frame: VisualFrame, x: number, y: number): boolean {
  return x >= frame[0] && y >= frame[1] && x < frame[0] + frame[2] && y < frame[1] + frame[3];
}

/** Scrollers clip by default; `overflow: 0` opts out (content may paint outside the viewport). */
function clipsContent(node: NodeDto): boolean {
  const overflow = node.p?.overflow;
  if (overflow === 0 || overflow === false) return false;
  if (overflow === 1 || overflow === true) return true;
  return Array.isArray(node.so);
}

function clippedByAncestor(
  nodes: Map<number, NodeDto>,
  node: NodeDto,
  x: number,
  y: number,
  visualOf: (item: NodeDto) => VisualFrame | null
): boolean {
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

function zIndexOf(node: NodeDto): number {
  const value = node.p?.zIndex;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function siblingIndex(node: NodeDto): number {
  return node.ci ?? node.id;
}

/**
 * Highest `zIndex` on [branchRoot] or any hit that sits in that subtree. A FAB with
 * `zIndex: 100` must beat the card even when the first diverging sibling has z=0.
 */
function branchZ(nodes: Map<number, NodeDto>, branchRoot: NodeDto, hits: NodeDto[]): number {
  let max = zIndexOf(branchRoot);
  for (const hit of hits) {
    if (hit.id !== branchRoot.id && !ancestorOf(nodes, hit.id, branchRoot.id)) continue;
    const z = zIndexOf(hit);
    if (z > max) max = z;
  }
  return max;
}

/**
 * Kuikly paints like Android `View.z`: among siblings, higher `zIndex` wins, then later
 * template order (`ci`). A descendant is painted on top of its ancestor.
 *
 * When `hits` is passed, each diverging sibling uses the max `zIndex` in its subtree so a
 * floating button still wins over a full-page scroller that happens to contain the same pixel.
 */
export function comparePaintOrder(
  nodes: Map<number, NodeDto>,
  left: NodeDto,
  right: NodeDto,
  hits: NodeDto[] = []
): number {
  if (left.id === right.id) return 0;
  const pathLeft = pathTo(nodes, left.id);
  const pathRight = pathTo(nodes, right.id);
  const shared = Math.min(pathLeft.length, pathRight.length);
  for (let i = 0; i < shared; i++) {
    if (pathLeft[i].id === pathRight[i].id) continue;
    const zDelta =
      (hits.length > 0 ? branchZ(nodes, pathLeft[i], hits) : zIndexOf(pathLeft[i])) -
      (hits.length > 0 ? branchZ(nodes, pathRight[i], hits) : zIndexOf(pathRight[i]));
    if (zDelta !== 0) return zDelta;
    return siblingIndex(pathLeft[i]) - siblingIndex(pathRight[i]);
  }
  return pathLeft.length - pathRight.length;
}

function opacityOf(node: NodeDto): number {
  const value = node.p?.opacity;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 1;
}

function hasOwnFill(node: NodeDto): boolean {
  const props = node.p ?? {};
  if (props.backgroundImage) return true;
  const background = props.backgroundColor;
  if (typeof background === 'string' && background.length > 0 && background !== 'transparent') {
    if (/^0x00/i.test(background)) return false;
    return true;
  }
  if (typeof background === 'number' && background !== 0) return true;
  const name = node.n ?? '';
  return /Text|Image|RichText/i.test(name);
}

function isLeaf(nodes: Map<number, NodeDto>, node: NodeDto): boolean {
  for (const child of nodes.values()) {
    if (child.pid === node.id) return false;
  }
  return true;
}

function ancestorOf(nodes: Map<number, NodeDto>, nodeId: number, ancestorId: number): boolean {
  let cursor = nodes.get(nodeId);
  while (cursor) {
    if (cursor.pid === ancestorId) return true;
    cursor = nodes.get(cursor.pid);
  }
  return false;
}

function intersectionArea(a: VisualFrame, b: VisualFrame): number {
  const left = Math.max(a[0], b[0]);
  const top = Math.max(a[1], b[1]);
  const right = Math.min(a[0] + a[2], b[0] + b[2]);
  const bottom = Math.min(a[1] + a[3], b[1] + b[3]);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function coversRoot(nodes: Map<number, NodeDto>, frame: VisualFrame): boolean {
  let root: NodeDto | undefined;
  for (const item of nodes.values()) {
    if (item.pid === -1 || !nodes.has(item.pid)) {
      root = item;
      break;
    }
  }
  const rootFrame = root?.f;
  if (!rootFrame || rootFrame[2] <= 0 || rootFrame[3] <= 0) return false;
  const rootArea = rootFrame[2] * rootFrame[3];
  return intersectionArea(frame, rootFrame) / rootArea >= 0.9;
}

/** Text / image / filled box actually draws this pixel. Virtual wrappers do not. */
function paintsPixel(nodes: Map<number, NodeDto>, node: NodeDto): boolean {
  if (node.r === false) return false;
  return isLeaf(nodes, node) || hasOwnFill(node);
}

/**
 * Full-screen overlays (FAB / bottom bar hosts) fill the page but only paint their children.
 * Empty space must fall through to whatever is underneath. Virtual nodes never paint.
 *
 * A scrolled list column whose visual box covers the page (after subtracting `so`) is the same
 * kind of host: it must not steal a click unless a real painted descendant sits on that pixel.
 */
function isPaintedHit(
  nodes: Map<number, NodeDto>,
  node: NodeDto,
  hits: NodeDto[],
  frame: VisualFrame
): boolean {
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

/**
 * Map a page-root point onto the front-most painted node.
 *
 * Visual boxes are layout `f` minus ancestor scroller `so`, then ancestor `p.transform`.
 * Overflow-clip ancestors (scrollers included) must also contain the point.
 * Among overlapping hits, paint order wins: `zIndex`, then later sibling, then descendant.
 * Unpainted overlay hosts (no fill, no child under the point) are skipped so a bottom bar
 * or floating button does not steal clicks across the rest of the page.
 */
export function hitTestNode(nodes: Map<number, NodeDto>, x: number, y: number): NodeDto | null {
  const cache = new Map<number, VisualFrame | null>();
  const visualOf = (item: NodeDto): VisualFrame | null => {
    if (cache.has(item.id)) return cache.get(item.id) ?? null;
    const frame = visualFrame(nodes, item);
    cache.set(item.id, frame);
    return frame;
  };

  const containing: NodeDto[] = [];
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

  let best: NodeDto | null = null;
  let bestArea = Infinity;
  for (const node of pool) {
    if (best === null) {
      best = node;
      bestArea = (visualOf(node)?.[2] ?? 0) * (visualOf(node)?.[3] ?? 0);
      continue;
    }
    const order = comparePaintOrder(nodes, node, best, containing);
    const area = (visualOf(node)?.[2] ?? 0) * (visualOf(node)?.[3] ?? 0);
    if (order > 0 || (order === 0 && area < bestArea)) {
      best = node;
      bestArea = area;
    }
  }
  return best;
}

/** CSS % box of the visual frame inside a captured rect (`ox,oy,ow,oh`), or null if no overlap. */
export function overlayBox(
  node: NodeDto,
  originX: number,
  originY: number,
  originW: number,
  originH: number,
  nodes?: Map<number, NodeDto>
): { left: number; top: number; width: number; height: number } | null {
  const frame = nodes ? visualFrame(nodes, node) : node.f;
  if (!frame || originW <= 0 || originH <= 0) return null;
  const left = ((frame[0] - originX) / originW) * 100;
  const top = ((frame[1] - originY) / originH) * 100;
  const width = (frame[2] / originW) * 100;
  const height = (frame[3] / originH) * 100;
  if (width <= 0 || height <= 0) return null;
  if (left + width <= 0 || top + height <= 0 || left >= 100 || top >= 100) return null;
  return { left, top, width, height };
}
