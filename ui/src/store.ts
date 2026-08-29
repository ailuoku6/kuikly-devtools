import type {
  BodyBlobDto,
  DeviceCommand,
  DeviceInfo,
  FullSessionState,
  LogDto,
  NativeCallDto,
  NetworkDto,
  NodeDto,
  ScreenshotDto,
  ServerMessage,
  SessionSummary,
} from './protocol';
import { applyBlobs } from './blobs';
import { isLogOrNetworkNative, LIVE_SHOT_INTERVAL_MS } from './protocol';

// Keep enough client-side history for the large-log virtual-list mock; the server still owns
// the production archive limit, while the panel can render a deliberately oversized snapshot.
const MAX_LOGS = 50000;
const MAX_NETWORK = 2000;
const MAX_NATIVE = 2000;
const MAX_FRAMES = 500;

export type ConnectionState = 'connecting' | 'open' | 'closed';

/**
 * Same rule as the server: a blank field in a later payload must not erase what an earlier one
 * already told us, so a completion notice cannot turn a row anonymous.
 */
function mergeRecord<T extends { msgs?: NetworkDto['msgs']; frames?: number; ok?: boolean }>(
  existing: T,
  update: Partial<T>
): T {
  const merged: T = { ...existing };
  const writable = merged as unknown as Record<string, unknown>;
  for (const key of Object.keys(update) as Array<keyof T>) {
    if (key === 'msgs') continue;
    const value = update[key];
    if (value === undefined || value === null || value === '') continue;
    writable[key as string] = value;
  }
  if (typeof update.ok === 'boolean') merged.ok = update.ok;
  if (update.msgs?.length) {
    const seen = new Set((merged.msgs ?? []).map((frame) => frame.seq));
    const extra = update.msgs.filter((frame) => typeof frame.seq === 'number' && !seen.has(frame.seq));
    merged.msgs = (merged.msgs ?? []).concat(extra);
    if (merged.msgs.length > MAX_FRAMES) {
      merged.msgs = merged.msgs.slice(-MAX_FRAMES);
    }
    merged.frames = merged.msgs.length;
  } else if (typeof update.frames === 'number') {
    merged.frames = update.frames;
  }
  return merged;
}

export interface SessionView {
  summary: SessionSummary;
  device: DeviceInfo | null;
  nodes: Map<number, NodeDto>;
  logs: LogDto[];
  network: NetworkDto[];
  networkIndex: Map<string, number>;
  native: NativeCallDto[];
  nativeIndex: Map<string, number>;
  screenshot: ScreenshotDto | null;
  hydrated: boolean;
  bodyBuf: Map<string, unknown>;
}

/**
 * Applies the same merge the server performs, so both sides converge on one tree.
 *
 * Deliberately not React state: a busy page pushes a delta every 500 ms and the tree can hold
 * thousands of nodes, so mutations happen in plain maps and components subscribe to a version
 * counter that is bumped at most once per animation frame.
 */
export class DevtoolsStore {
  readonly sessions = new Map<string, SessionView>();

  activePagerId: string | null = null;

  connection: ConnectionState = 'connecting';

  lastError: string | null = null;

  /** When set, no socket is opened; `mock.ts` drives `handle()` directly. */
  mockMode = false;

  private version = 0;

  private listeners = new Set<() => void>();

  private notifyScheduled = false;

  private socket: WebSocket | null = null;

  private reconnectTimer: number | null = null;

  private mockLiveTimer: number | null = null;

  private readonly wsUrl: string;

  constructor(wsUrl?: string) {
    this.wsUrl =
      wsUrl ?? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  }

  // ------------------------------------------------------------- subscription

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  /** Coalesces bursts into one render per frame. */
  private notify(): void {
    this.version += 1;
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    requestAnimationFrame(() => {
      this.notifyScheduled = false;
      this.listeners.forEach((listener) => listener());
    });
  }

  // -------------------------------------------------------------- connection

  connect(): void {
    if (this.socket) return;
    if (this.mockMode) {
      this.connection = 'open';
      this.notify();
      return;
    }
    this.connection = 'connecting';
    this.notify();

    const socket = new WebSocket(this.wsUrl);
    this.socket = socket;

    socket.onopen = () => {
      this.connection = 'open';
      this.lastError = null;
      this.notify();
    };
    socket.onclose = () => {
      this.connection = 'closed';
      this.socket = null;
      this.notify();
      if (this.reconnectTimer === null) {
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, 1500);
      }
    };
    socket.onerror = () => {
      this.lastError = 'WebSocket 连接失败';
      this.notify();
    };
    socket.onmessage = (event) => {
      try {
        this.handle(JSON.parse(event.data as string) as ServerMessage);
      } catch (error) {
        this.lastError = String(error);
        this.notify();
      }
    };
  }

  send(message: unknown): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  sendCommand(command: DeviceCommand, pagerId = this.activePagerId): void {
    if (!pagerId) return;
    if (this.mockMode) {
      if (command.type === 'shot') {
        this.applyMockScreenshot(pagerId, command.id ?? 0, command.sample ?? 2, false);
        return;
      }
      if (command.type === 'live') {
        this.setMockLive(pagerId, command.on, command.sample ?? 2);
        return;
      }
    }
    this.send({ type: 'command', pagerId, command });
  }

  selectSession(pagerId: string): void {
    this.activePagerId = pagerId;
    const session = this.sessions.get(pagerId);
    if (!session || !session.hydrated) {
      this.send({ type: 'subscribe', pagerId });
    }
    this.notify();
  }

  /**
   * Hides logs/network/native in this tab only. The server keeps the archive until the Kuikly page is
   * destroyed, so reopening the panel still shows the full history.
   */
  clearActiveBuffers(): void {
    const pagerId = this.activePagerId;
    if (!pagerId) return;
    const session = this.sessions.get(pagerId);
    if (session) {
      session.logs = [];
      session.network = [];
      session.networkIndex = new Map();
      session.native = [];
      session.nativeIndex = new Map();
      session.bodyBuf = new Map();
    }
    this.notify();
  }

  // ----------------------------------------------------------------- messages

  handle(message: ServerMessage): void {
    switch (message.type) {
      case 'hello': {
        const seen = new Set(message.sessions.map((summary) => summary.pagerId));
        for (const pagerId of Array.from(this.sessions.keys())) {
          if (!seen.has(pagerId)) this.sessions.delete(pagerId);
        }
        if (this.activePagerId && !this.sessions.has(this.activePagerId)) {
          this.activePagerId = null;
        }
        message.sessions.forEach((summary) => this.ensureSession(summary));
        this.autoSelect();
        break;
      }
      case 'session-added':
        this.ensureSession(message.summary);
        this.autoSelect();
        break;
      case 'session-removed':
        this.sessions.delete(message.pagerId);
        if (this.activePagerId === message.pagerId) {
          this.activePagerId = null;
          this.autoSelect();
        }
        break;
      case 'snapshot':
        this.applySnapshot(message.session);
        break;
      case 'delta':
        this.applyDelta(message);
        break;
      case 'cleared': {
        const session = this.sessions.get(message.pagerId);
        if (session) {
          session.logs = [];
          session.network = [];
          session.networkIndex = new Map();
          session.native = [];
          session.nativeIndex = new Map();
          session.bodyBuf = new Map();
        }
        break;
      }
      case 'error':
        this.lastError = message.message;
        break;
    }
    this.notify();
  }

  private ensureSession(summary: SessionSummary): SessionView {
    const existing = this.sessions.get(summary.pagerId);
    if (existing) {
      if (summary.firstSeenAt && existing.summary.firstSeenAt &&
          summary.firstSeenAt !== existing.summary.firstSeenAt) {
        // Same pagerId, new page lifetime — the previous archive belongs to a destroyed pager.
        existing.logs = [];
        existing.network = [];
        existing.networkIndex = new Map();
        existing.native = [];
        existing.nativeIndex = new Map();
        existing.bodyBuf = new Map();
        existing.nodes = new Map();
        existing.device = null;
        existing.screenshot = null;
        existing.hydrated = false;
      }
      existing.summary = summary;
      return existing;
    }
    const created: SessionView = {
      summary,
      device: null,
      nodes: new Map(),
      logs: [],
      network: [],
      networkIndex: new Map(),
      native: [],
      nativeIndex: new Map(),
      screenshot: null,
      hydrated: false,
      bodyBuf: new Map(),
    };
    this.sessions.set(summary.pagerId, created);
    return created;
  }

  private autoSelect(): void {
    if (this.activePagerId && this.sessions.has(this.activePagerId)) return;
    const live = Array.from(this.sessions.values())
      .sort((a, b) => b.summary.lastSeenAt - a.summary.lastSeenAt)
      .find((session) => !session.summary.stale) ?? this.sessions.values().next().value;
    if (live) this.selectSession(live.summary.pagerId);
  }

  private applySnapshot(state: FullSessionState): void {
    const session = this.ensureSession(state);
    session.device = state.device;
    session.nodes = new Map(state.nodes.map((node) => [node.id, node]));
    // Union, never replace: a delta that arrived before this snapshot must not be thrown away.
    this.appendArchive(session, state.logs, state.network, state.native);
    if (state.screenshot !== undefined) session.screenshot = state.screenshot;
    session.hydrated = true;
  }

  private applyDelta(delta: {
    pagerId: string;
    full: boolean;
    meta: SessionSummary;
    device: DeviceInfo | null;
    nodes: NodeDto[];
    removed: number[];
    logs: LogDto[];
    network: NetworkDto[];
    native?: NativeCallDto[];
    screenshot?: ScreenshotDto;
    blobs?: BodyBlobDto[];
  }): void {
    const session = this.ensureSession(delta.meta);
    if (delta.device) session.device = delta.device;
    if (delta.full) {
      session.nodes = new Map();
      session.hydrated = true;
    }

    // Logs/network are an append-only archive and must be kept even before the tree is hydrated,
    // otherwise a late-opening panel would drop everything that arrived between hello and snapshot.
    this.appendArchive(session, delta.logs, delta.network, delta.native, delta.blobs);
    if (delta.screenshot) session.screenshot = delta.screenshot;

    // A delta for a session we never hydrated would give a tree with dangling parents; ask for the
    // authoritative state instead of rendering something broken.
    if (!session.hydrated) {
      this.send({ type: 'subscribe', pagerId: delta.pagerId });
      return;
    }

    for (const node of delta.nodes ?? []) {
      session.nodes.set(node.id, node);
    }
    for (const id of delta.removed ?? []) {
      session.nodes.delete(id);
    }
  }

  private appendArchive(
    session: SessionView,
    logs: LogDto[] | undefined,
    network: NetworkDto[] | undefined,
    native?: NativeCallDto[],
    blobs?: BodyBlobDto[]
  ): void {
    if (logs?.length) {
      const seen = new Set(session.logs.map((item) => item.seq));
      const extra = logs.filter((item) => typeof item.seq === 'number' && !seen.has(item.seq));
      if (extra.length) {
        session.logs = session.logs.concat(extra);
        if (session.logs.length > MAX_LOGS) {
          session.logs = session.logs.slice(-MAX_LOGS);
        }
      }
    }

    for (const record of network ?? []) {
      if (!record) continue;
      const index = session.networkIndex.get(record.id);
      if (index === undefined) {
        session.networkIndex.set(record.id, session.network.length);
        session.network = session.network.concat(record);
        if (session.network.length > MAX_NETWORK) {
          session.network = session.network.slice(-MAX_NETWORK);
          session.networkIndex = new Map(session.network.map((item, i) => [item.id, i]));
        }
      } else {
        session.network = session.network.slice();
        session.network[index] = mergeRecord(session.network[index], record);
      }
    }

    for (const record of native ?? []) {
      if (!record) continue;
      if (isLogOrNetworkNative(record.mod)) continue;
      const index = session.nativeIndex.get(record.id);
      if (index === undefined) {
        if (!record.mod) continue;
        session.nativeIndex.set(record.id, session.native.length);
        session.native = session.native.concat(record);
        if (session.native.length > MAX_NATIVE) {
          session.native = session.native.slice(-MAX_NATIVE);
          session.nativeIndex = new Map(session.native.map((item, i) => [item.id, i]));
        }
      } else {
        session.native = session.native.slice();
        session.native[index] = mergeRecord(session.native[index], record);
      }
    }

    if (blobs?.length) {
      const networkMap = new Map<string, NetworkDto>();
      for (const item of session.network) networkMap.set(item.id, item);
      const nativeMap = new Map<string, NativeCallDto>();
      for (const item of session.native) nativeMap.set(item.id, item);
      applyBlobs(
        { network: networkMap, native: nativeMap, networkOrder: [], nativeOrder: [], bodyBuf: session.bodyBuf },
        blobs
      );
      session.network = session.network.slice();
      for (const rec of networkMap.values()) {
        const index = session.networkIndex.get(rec.id);
        if (index === undefined) {
          session.networkIndex.set(rec.id, session.network.length);
          session.network = session.network.concat(rec);
        } else {
          session.network[index] = rec;
        }
      }
      session.native = session.native.slice();
      for (const rec of nativeMap.values()) {
        const index = session.nativeIndex.get(rec.id);
        if (index === undefined) {
          session.nativeIndex.set(rec.id, session.native.length);
          session.native = session.native.concat(rec);
        } else {
          session.native[index] = rec;
        }
      }
    }
  }

  get active(): SessionView | null {
    return this.activePagerId ? this.sessions.get(this.activePagerId) ?? null : null;
  }

  /** 1×1 PNG so `?mock=1` can exercise the Inspector capture buttons without a device. */
  private applyMockScreenshot(pagerId: string, nodeId: number, sample: number, live: boolean): void {
    const session = this.sessions.get(pagerId);
    if (!session) return;
    const root = session.nodes.get(nodeId > 0 ? nodeId : [...session.nodes.keys()][0]);
    const frame = root?.f ?? [0, 0, 393, 852];
    const apply = () => {
      session.screenshot = {
        id: nodeId > 0 ? nodeId : root?.id ?? 1,
        ts: Date.now(),
        sample,
        live,
        ox: frame[0],
        oy: frame[1],
        ow: frame[2],
        oh: frame[3],
        data:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      };
      this.notify();
    };
    if (live) apply();
    else window.setTimeout(apply, 180);
  }

  private setMockLive(pagerId: string, on: boolean, sample: number): void {
    if (this.mockLiveTimer !== null) {
      window.clearInterval(this.mockLiveTimer);
      this.mockLiveTimer = null;
    }
    if (!on) return;
    this.applyMockScreenshot(pagerId, 0, sample, true);
    this.mockLiveTimer = window.setInterval(() => {
      this.applyMockScreenshot(pagerId, 0, sample, true);
    }, LIVE_SHOT_INTERVAL_MS);
  }
}
