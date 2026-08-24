import { useMemo, useState } from 'react';
import type { NodeDto, ScreenshotDto } from '../protocol';
import { buildRows } from '../tree';
import { Inspector } from './Inspector';
import { VirtualTree } from './VirtualTree';

interface Props {
  nodes: Map<number, NodeDto>;
  composeOnly: boolean;
  selectedId: number | null;
  onSelectedIdChange: (id: number | null) => void;
  stateNodeIds: number[];
  onRequestState: (ids: number[]) => void;
  onRequestFull: () => void;
  screenshot: ScreenshotDto | null;
  onCapture: (id: number, sample: number) => void;
  onLive: (on: boolean, sample: number) => void;
}

export function ElementsPanel({
  nodes,
  composeOnly,
  selectedId,
  onSelectedIdChange,
  stateNodeIds,
  onRequestState,
  onRequestFull,
  screenshot,
  onCapture,
  onLive,
}: Props) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const [scrollToId, setScrollToId] = useState<number | null>(null);

  const rows = useMemo(
    () => buildRows(nodes, collapsed, query.trim(), composeOnly),
    [nodes, collapsed, query, composeOnly]
  );

  const selected = selectedId !== null ? nodes.get(selectedId) ?? null : null;

  const pickNode = (id: number) => {
    onSelectedIdChange(id);
    setScrollToId(id);
    setCollapsed((previous) => {
      const next = new Set(previous);
      let cursor = nodes.get(id);
      while (cursor && cursor.pid !== -1) {
        next.delete(cursor.pid);
        cursor = nodes.get(cursor.pid);
      }
      return next;
    });
    const picked = nodes.get(id);
    if (picked?.hs && !stateNodeIds.includes(id)) onRequestState([id]);
  };

  const toggle = (id: number) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="panel-body">
      <div className="split-left">
        <div className="toolbar">
          <input
            className="grow"
            placeholder={composeOnly ? '筛选组件…' : '按视图名、类名、属性或 nativeRef 筛选'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className="badge">{rows.length} 行</span>
          <span className="badge">{nodes.size} 节点</span>
          <button onClick={() => setCollapsed(new Set())}>全部展开</button>
          <button
            onClick={() => {
              const withChildren = new Set<number>();
              for (const node of nodes.values()) {
                if (node.pid !== -1) withChildren.add(node.pid);
              }
              setCollapsed(withChildren);
            }}
          >
            全部折叠
          </button>
          <button onClick={onRequestFull} title="向设备请求完整快照">
            重新同步
          </button>
        </div>
        {nodes.size === 0 ? (
          <div className="empty">
            还没有节点树。请在设备上打开已插桩的 Kuikly 页面。
          </div>
        ) : (
          <VirtualTree
            rows={rows}
            selectedId={selectedId}
            scrollToId={scrollToId}
            onSelect={pickNode}
            onToggle={toggle}
          />
        )}
      </div>
      <div className="split-right">
        <Inspector
          node={selected}
          nodes={nodes}
          stateRequested={selectedId !== null && stateNodeIds.includes(selectedId)}
          screenshot={screenshot}
          onRequestState={() => selectedId !== null && onRequestState([selectedId])}
          onSelect={pickNode}
          onCapture={onCapture}
          onLive={onLive}
        />
      </div>
    </div>
  );
}
