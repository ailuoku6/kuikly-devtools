import type { DevtoolsStore } from './store';
import type { LogDto, NetworkDto, NodeDto } from './protocol';

/**
 * Feeds the store synthetic traffic so the panel can be developed without a device.
 * Enable with `?mock=1`.
 */
export function startMock(store: DevtoolsStore): void {
  const pagerId = 'mock-1';
  const nodes = buildMockTree();

  store.handle({
    type: 'hello',
    sessions: [summary(pagerId, nodes.length)],
  });
  store.handle({
    type: 'snapshot',
    session: {
      ...summary(pagerId, nodes.length),
      device: {
        platform: 'android',
        osVersion: '14',
        appVersion: '9.20.0',
        density: 3,
        pageWidth: 393,
        pageHeight: 852,
        deviceWidth: 393,
        deviceHeight: 852,
        statusBarHeight: 44,
      },
      nodes,
      logs: [],
      network: [],
      stateNodeIds: [],
    },
  });

  let logSeq = 0;
  let requestSeq = 0;
  const inFlight: NetworkDto[] = [];
  let streamFrame = 0;
  const streamId = 'll_mock_1';
  let streamOpened = false;

  setInterval(() => {
    const touched = nodes.filter(() => Math.random() < 0.02).map((node) => ({
      ...node,
      f: node.f && ([node.f[0], node.f[1] + Math.round(Math.random() * 4 - 2), node.f[2], node.f[3]] as
        [number, number, number, number]),
    }));

    const logs: LogDto[] = Math.random() < 0.7 ? [mockLog(logSeq++)] : [];
    const network: NetworkDto[] = [];

    if (!streamOpened) {
      streamOpened = true;
      network.push({
        id: streamId,
        url: 'longlink://devtools/test?event=diagnosticStream',
        method: 'SUB',
        stack: 'TDF/TMLongLinkModule',
        kind: 'stream',
        req: JSON.stringify({ eventName: 'diagnosticStream', source: 'mock' }),
        ts: Date.now(),
        msgs: [],
        frames: 0,
      });
    } else if (Math.random() < 0.35) {
      const seq = streamFrame++;
      network.push({
        id: streamId,
        url: 'longlink://devtools/test?event=diagnosticStream',
        method: 'SUB',
        stack: 'TDF/TMLongLinkModule',
        kind: 'stream',
        ts: Date.now(),
        msgs: [{
          seq,
          dir: 'down',
          ts: Date.now(),
          data: JSON.stringify({ batch: seq + 1, dataKey: seq === 0 ? 'bootstrap' : 'update' }),
        }],
      });
    }

    if (Math.random() < 0.3) {
      requestSeq += 1;
      const started: NetworkDto = {
        id: `cb_${requestSeq}`,
        url: `https://devtools.test/api/diagnostics?id=${requestSeq}`,
        method: 'POST',
        stack: requestSeq % 2 === 0 ? 'TDF/network.fetch' : 'KRNetworkModule',
        req: JSON.stringify({ requestId: `diagnostic-${requestSeq}`, from: 'mock' }),
        hdr: JSON.stringify({
          'Content-Type': 'application/json',
          Cookie: 'session=mock',
          'User-Agent': 'Kuikly-Devtools-Mock',
        }),
        ts: Date.now(),
      };
      inFlight.push(started);
      network.push(started);
    }

    // The agent re-sends the whole record on completion, so the mock does the same.
    if (inFlight.length > 0 && Math.random() < 0.5) {
      const finished = inFlight.shift()!;
      const ok = Math.random() < 0.85;
      network.push({
        ...finished,
        status: ok ? 200 : 502,
        ok,
        cost: Math.round(60 + Math.random() * 400),
        rsp: JSON.stringify({ info: ok ? 'ok' : 'bad gateway', data: { records: 24 } }),
        err: ok ? undefined : 'upstream timeout',
      });
    }

    store.handle({
      type: 'delta',
      pagerId,
      full: false,
      meta: summary(pagerId, nodes.length),
      device: null,
      nodes: touched,
      removed: [],
      logs,
      network,
    });
  }, 300);
}

function summary(pagerId: string, nodeCount: number) {
  return {
    pagerId,
    page: 'DevToolsTestPage',
    className: 'DevToolsTestPage',
    platform: 'android',
    nodeCount,
    logCount: 0,
    networkCount: 0,
    droppedLogs: 0,
    sampleMs: 300,
    lastSeenAt: Date.now(),
    firstSeenAt: Date.now(),
    stale: false,
  };
}

function mockLog(seq: number): LogDto {
  const samples: Array<[LogDto['lv'], string, string]> = [
    ['i', 'DevToolsTestPage', 'onPageDidAppear, restoring diagnostic viewport offset=120'],
    ['d', 'DiagnosticsPoller', 'poll tick interval=5000 activeTask=2'],
    ['e', 'DevToolsFixture', 'parse failed: missing field `payload`'],
    ['p', 'println', 'test stage changed -> 2'],
  ];
  const [lv, tag, msg] = samples[seq % samples.length];
  return { seq, lv, tag, msg: `${msg} (#${seq})`, ts: Date.now() };
}

function buildMockTree(): NodeDto[] {
  const nodes: NodeDto[] = [];
  let nextId = 1;

  const push = (pid: number, name: string, cls: string, extra: Partial<NodeDto> = {}): number => {
    const id = nextId++;
    const siblings = nodes.filter((node) => node.pid === pid).length;
    nodes.push({
      id,
      pid,
      ci: siblings,
      n: name,
      c: cls,
      r: true,
      cv: false,
      f: [0, siblings * 44, 393, 44],
      lf: [0, siblings * 44],
      p: {},
      hs: false,
      ...extra,
    });
    return id;
  };

  const root = push(-1, 'DivView', 'DevToolsTestPage', { cv: true, f: [0, 0, 393, 852], lf: [0, 0] });
  const preview = push(root, 'DivView', 'DevToolsPreviewView', { cv: true, f: [0, 0, 393, 360] });
  push(preview, 'TextView', 'TextView', {
    f: [16, 16, 360, 24],
    p: { text: 'DevTools fixture preview', color: '#FF1A1A1A', fontSize: 16 },
  });
  const card = push(root, 'DivView', 'DevToolsTestCardView', { cv: true, f: [0, 420, 393, 432] });

  const dialog = push(card, 'DivView', 'DevToolsTestDialogView', {
    cv: true,
    hs: true,
    f: [0, 260, 393, 560],
    s: {
      selectedTabForward: 0,
      selectedDirection: 1,
      slideCount: 3,
      expandedKeys: ['09:00', '10:00'],
      scrollerRef: '<unreadable: lateinit property scrollerRef has not been initialized>',
    },
    as: { showDialog: true, title: 'DevTools test dialog', initialTab: 0 },
  });

  for (let i = 0; i < 6; i += 1) {
    const row = push(dialog, 'DivView', 'TestDataRow', { f: [0, 40 + i * 40, 393, 40] });
    push(row, 'TextView', 'TextView', {
      f: [16, 48 + i * 40, 120, 20],
      p: { text: `fixture ${i + 1}`, color: '#FF1A1A1A', fontSize: 14 },
    });
    push(row, 'TextView', 'TextView', {
      r: false,
      f: [280, 48 + i * 40, 90, 20],
      p: { text: `${3 + i} items`, color: '#FF0066FF', fontSize: 13 },
    });
  }

  for (let i = 0; i < 240; i += 1) {
    const group = push(card, 'DivView', 'TestListItem', { f: [0, i * 30, 393, 30] });
    push(group, 'TextView', 'TextView', {
      f: [12, i * 30 + 6, 200, 18],
      p: { text: `test item ${i + 1}`, color: '#FF333333', fontSize: 13 },
    });
  }

  return nodes;
}
