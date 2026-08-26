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

/**
 * Map a page-root point onto the smallest, deepest node whose visual box contains it.
 *
 * Visual boxes are layout `f` minus ancestor scroller `so`, then ancestor `p.transform`.
 * Overflow-clip ancestors (scrollers included) must also contain the point, so off-screen
 * scrolled content cannot steal the click.
 */
export function hitTestNode(nodes: Map<number, NodeDto>, x: number, y: number): NodeDto | null {
  let best: NodeDto | null = null;
  let bestDepth = -1;
  let bestArea = Infinity;
  const cache = new Map<number, VisualFrame | null>();
  const visualOf = (item: NodeDto): VisualFrame | null => {
    if (cache.has(item.id)) return cache.get(item.id) ?? null;
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
