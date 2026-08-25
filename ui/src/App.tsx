import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ConsolePanel } from './components/ConsolePanel';
import { ElementsPanel } from './components/ElementsPanel';
import { NetworkPanel } from './components/NetworkPanel';
import { SessionBar } from './components/SessionBar';
import type { NodeDto } from './protocol';
import { LIVE_SHOT_INTERVAL_MS } from './protocol';
import type { DevtoolsStore, SessionView } from './store';

type Tab = 'elements' | 'components' | 'console' | 'network';

const EMPTY_NODES: Map<number, NodeDto> = new Map();

export function App({ store }: { store: DevtoolsStore }) {
  // The store mutates plain maps and bumps a version counter once per frame; this is what turns
  // those mutations into renders without copying thousands of nodes on every delta.
  useSyncExternalStore(store.subscribe, store.getVersion);

  const [tab, setTab] = useState<Tab>('elements');
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    store.connect();
  }, [store]);

  const session = store.active;
  const sessions = Array.from(store.sessions.values()).map((item) => item.summary);
  const nodes = session?.nodes ?? EMPTY_NODES;

  // A reload on the device yields a fresh pagerId, so a stale selection must not stick around.
  useEffect(() => {
    if (selectedId !== null && session && !session.nodes.has(selectedId)) {
      setSelectedId(null);
    }
  }, [session, selectedId]);

  const requestState = useCallback((ids: number[]) => store.sendCommand({ type: 'state', ids }), [store]);
  const requestFull = useCallback(() => store.sendCommand({ type: 'full' }), [store]);
  const requestShot = useCallback(
    (id: number, sample: number) => store.sendCommand({ type: 'shot', id, sample }),
    [store]
  );
  const requestLive = useCallback(
    (on: boolean, sample: number) =>
      store.sendCommand({ type: 'live', on, interval: LIVE_SHOT_INTERVAL_MS, sample }),
    [store]
  );

  return (
    <div className="app">
      <SessionBar
        connection={store.connection}
        sessions={sessions}
        activePagerId={store.activePagerId}
        device={session?.device ?? null}
        sampleMs={session?.summary.sampleMs ?? 500}
        onSelect={(pagerId) => {
          setSelectedId(null);
          store.selectSession(pagerId);
        }}
        onSampleChange={(value) => store.sendCommand({ type: 'sample', value })}
      />

      <div className="tab-bar">
        <TabButton id="elements" tab={tab} onClick={setTab} label="元素" count={nodes.size} />
        <TabButton id="components" tab={tab} onClick={setTab} label="组件" count={countCompose(session)} />
        <TabButton id="console" tab={tab} onClick={setTab} label="控制台" count={session?.logs.length ?? 0} />
        <TabButton id="network" tab={tab} onClick={setTab} label="网络" count={session?.network.length ?? 0} />
        <span style={{ flex: 1 }} />
        {store.lastError && <span className="badge">{store.lastError}</span>}
      </div>

      {!session ? (
        <div className="empty">
          等待 Kuikly 页面接入。
          <br />
          <br />
          请先开启插桩编译：<code>npx kuikly-devtools dev</code>
          <br />
          然后在设备上打开页面。
        </div>
      ) : tab === 'console' ? (
        <ConsolePanel
          logs={session.logs}
          droppedLogs={session.summary.droppedLogs ?? 0}
          onClear={() => store.clearActiveBuffers()}
        />
      ) : tab === 'network' ? (
        <NetworkPanel network={session.network} onClear={() => store.clearActiveBuffers()} />
      ) : (
        <ElementsPanel
          key={tab}
          nodes={nodes}
          composeOnly={tab === 'components'}
          selectedId={selectedId}
          onSelectedIdChange={setSelectedId}
          stateNodeIds={dumpedStateIds(nodes)}
          onRequestState={requestState}
          onRequestFull={requestFull}
          screenshot={session.screenshot}
          onCapture={requestShot}
          onLive={requestLive}
        />
      )}
    </div>
  );
}

/** Nodes whose member variables the device has already dumped. */
function dumpedStateIds(nodes: Map<number, NodeDto>): number[] {
  const ids: number[] = [];
  for (const node of nodes.values()) {
    if (node.s || node.as) ids.push(node.id);
  }
  return ids;
}

function countCompose(session: SessionView | null): number {
  if (!session) return 0;
  let count = 0;
  for (const node of session.nodes.values()) {
    if (node.cv) count += 1;
  }
  return count;
}

function TabButton({
  id,
  tab,
  label,
  count,
  onClick,
}: {
  id: Tab;
  tab: Tab;
  label: string;
  count: number;
  onClick: (tab: Tab) => void;
}) {
  return (
    <button className={tab === id ? 'active' : ''} onClick={() => onClick(id)}>
      {label}
      <span className="badge">{count}</span>
    </button>
  );
}
