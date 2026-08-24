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

/**
 * Map a page-root point onto the smallest, deepest node whose `f` contains it.
 *
 * Frames are the same coordinate space as a `Pager.toImage` capture (`ox/oy/ow/oh` on the
 * screenshot). Among overlapping hits, depth wins, then smaller area — so a ComposeView wrapping
 * a child of the same size still loses to the child.
 */
export function hitTestNode(nodes: Map<number, NodeDto>, x: number, y: number): NodeDto | null {
  let best: NodeDto | null = null;
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

/** CSS % box of `node.f` inside a captured rect (`ox,oy,ow,oh`), or null if it does not overlap. */
export function overlayBox(
  node: NodeDto,
  originX: number,
  originY: number,
  originW: number,
  originH: number
): { left: number; top: number; width: number; height: number } | null {
  const frame = node.f;
  if (!frame || originW <= 0 || originH <= 0) return null;
  const left = ((frame[0] - originX) / originW) * 100;
  const top = ((frame[1] - originY) / originH) * 100;
  const width = (frame[2] / originW) * 100;
  const height = (frame[3] / originH) * 100;
  if (width <= 0 || height <= 0) return null;
  if (left + width <= 0 || top + height <= 0 || left >= 100 || top >= 100) return null;
  return { left, top, width, height };
}
