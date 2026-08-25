import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TreeRow } from '../tree';

const ROW_HEIGHT = 22;
const OVERSCAN = 12;

interface Props {
  rows: TreeRow[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onToggle: (id: number) => void;
  scrollToId: number | null;
}

/**
 * Windowed tree renderer.
 *
 * A page like DevToolsTestPage produces thousands of nodes and the tree re-renders on every 500 ms
 * delta, so only the visible slice is mounted.
 */
export function VirtualTree({ rows, selectedId, onSelect, onToggle, scrollToId }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return undefined;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    setHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (scrollToId === null) return;
    const index = rows.findIndex((row) => row.node.id === scrollToId);
    if (index < 0) return;
    const element = viewportRef.current;
    if (!element) return;
    const top = index * ROW_HEIGHT;
    if (top < element.scrollTop || top > element.scrollTop + element.clientHeight - ROW_HEIGHT) {
      element.scrollTop = Math.max(0, top - element.clientHeight / 2);
    }
  }, [scrollToId, rows]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const visible = rows.slice(first, last);

  return (
    <div className="scroll" ref={viewportRef} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
      <div className="tree-viewport" style={{ height: rows.length * ROW_HEIGHT }}>
        {visible.map((row, offset) => {
          const { node } = row;
          const index = first + offset;
          return (
            <div
              key={node.id}
              className={`tree-row${node.id === selectedId ? ' selected' : ''}${node.cv ? ' compose' : ''}`}
              style={{ top: index * ROW_HEIGHT, paddingLeft: 4 + row.depth * 12 }}
              onClick={() => onSelect(node.id)}
            >
              <span
                className="twisty"
                onClick={(event) => {
                  event.stopPropagation();
                  if (row.childCount > 0) onToggle(node.id);
                }}
              >
                {row.childCount > 0 ? (row.expanded ? '▾' : '▸') : ''}
              </span>
              <span className="tag">&lt;{node.n}&gt;</span>
              {node.c !== node.n && <span className="cls">{node.c}</span>}
              {!node.r && <span className="virtual" title="虚拟节点，没有原生视图">◌</span>}
              {node.hs && <span className="state-mark" title="含可调试状态">S</span>}
              {node.f && (
                <span className="hint">
                  {node.f[0]},{node.f[1]} · {node.f[2]}×{node.f[3]}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
