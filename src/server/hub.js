'use strict';

const { EventEmitter } = require('events');
const { applyBlobs, dropBodyBuf, slimForDelta } = require('./blobs');
const { SERVE_PATH_MARKER } = require('./ingest');

const MAX_LOGS = 20000;
const MAX_NETWORK = 2000;
const STALE_AFTER_MS = 15000;
const TOMBSTONE_TTL_MS = 60 * 1000;
const MAX_FRAMES = 500;
/** After `destroyed`, keep the session until body chunks finish (or this elapses). */
const CLOSE_DRAIN_MS = 60 * 1000;

/**
 * Server-side mirror of one live Kuikly pager.
 *
 * The device only ever sends changed nodes, so the authoritative full tree lives here. Logs and
 * network records are an append-only archive: they survive a browser that connects late, and are
 * dropped only when the device reports that the pager was destroyed.
 */
class Session {
  constructor(pagerId) {
    this.pagerId = pagerId;
    this.sid = '';
    this.page = '';
    this.className = '';
    this.platform = '';
    this.device = null;
    this.sampleMs = 0;
    this.lastSeq = -1;
    this.lastSeenAt = 0;
    this.firstSeenAt = Date.now();

    this.nodes = new Map();
    this.logs = [];
    this.logSeqs = new Set();
    this.network = new Map();
    this.networkOrder = [];
    this.bodyBuf = new Map();

    this.droppedLogs = 0;
    this.pendingCommands = [];
    this.stateNodeIds = [];
    this.screenshot = null;
    this.closing = false;
    this.closingAt = 0;
  }

  get stale() {
    return Date.now() - this.lastSeenAt > STALE_AFTER_MS;
  }

  summary() {
    return {
      pagerId: this.pagerId,
      page: this.page,
      className: this.className,
      platform: this.platform,
      nodeCount: this.nodes.size,
      logCount: this.logs.length,
      networkCount: this.networkOrder.length,
      droppedLogs: this.droppedLogs,
      sampleMs: this.sampleMs,
      lastSeenAt: this.lastSeenAt,
      firstSeenAt: this.firstSeenAt,
      stale: this.stale,
    };
  }

  fullState() {
    return {
      ...this.summary(),
      device: this.device,
      nodes: Array.from(this.nodes.values()),
      logs: this.logs,
      network: this.networkOrder.map((id) => this.network.get(id)).filter(Boolean),
      stateNodeIds: this.stateNodeIds,
      screenshot: this.screenshot,
    };
  }
}

/**
 * Merges a network update into the record we already hold.
 *
 * A blank or absent field in the newer payload must never erase what the earlier one told us -
 * otherwise a completion notice that omits the url would leave an anonymous row in the panel.
 */
function mergeRecord(existing, update) {
  if (!existing) return finalizeStream(update);
  const merged = { ...existing };
  for (const [key, value] of Object.entries(update)) {
    if (key === 'msgs') continue;
    if (value === undefined || value === null || value === '') continue;
    merged[key] = value;
  }
  if (typeof update.ok === 'boolean') merged.ok = update.ok;
  merged.msgs = mergeFrames(existing.msgs, update.msgs);
  return finalizeStream(merged);
}

function mergeFrames(existing, incoming) {
  const previous = Array.isArray(existing) ? existing : [];
  const extra = Array.isArray(incoming) ? incoming : [];
  if (extra.length === 0) return previous;
  const seen = new Set();
  for (const frame of previous) {
    if (frame && typeof frame.seq === 'number') seen.add(frame.seq);
  }
  const combined = previous.slice();
  for (const frame of extra) {
    if (!frame || typeof frame.seq !== 'number' || seen.has(frame.seq)) continue;
    seen.add(frame.seq);
    combined.push(frame);
  }
  return combined.length > MAX_FRAMES ? combined.slice(-MAX_FRAMES) : combined;
}

function finalizeStream(record) {
  if (!record) return record;
  if (Array.isArray(record.msgs)) {
    record.frames = record.msgs.length;
  }
  return record;
}

function bodyIncomplete(record) {
  if (!record) return false;
  if (typeof record.rspChars === 'number' && record.rspChars > 0 &&
      (typeof record.rsp !== 'string' || record.rsp.length < record.rspChars)) {
    return true;
  }
  if (typeof record.reqChars === 'number' && record.reqChars > 0 &&
      (typeof record.req !== 'string' || record.req.length < record.reqChars)) {
    return true;
  }
  return false;
}

function bodiesPending(session) {
  if (session.bodyBuf && session.bodyBuf.size > 0) return true;
  for (const rec of session.network.values()) {
    if (bodyIncomplete(rec)) return true;
  }
  return false;
}

class Hub extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, Session>} */
    this.sessions = new Map();
    /** sid → timestamp, so a late packet from a destroyed attach cannot resurrect it. */
    this.deadSids = new Map();
    /** pagerId → timestamp, fallback when the dying payload had no `sid`. */
    this.pagerTombs = new Map();
  }

  session(pagerId) {
    let session = this.sessions.get(pagerId);
    if (!session) {
      session = new Session(pagerId);
      this.sessions.set(pagerId, session);
      this.emit('session-added', session.summary());
    }
    return session;
  }

  summaries() {
    return Array.from(this.sessions.values()).map((session) => session.summary());
  }

  /**
   * Applies one device payload and returns the commands the device should act on.
   * @returns {{commands: Array<object>}}
   */
  ingest(payload) {
    const pagerId = String(payload.pagerId || '');
    if (!pagerId) return { commands: [] };

    const sid = payload.sid != null ? String(payload.sid) : '';
    this.pruneTombstones();

    if (payload.destroyed === true) {
      return this.destroySession(pagerId, sid, payload);
    }

    if (sid && this.deadSids.has(sid)) {
      const closing = this.sessions.get(pagerId);
      if (closing && closing.closing && (!closing.sid || closing.sid === sid)) {
        return this.drainClosingSession(closing, pagerId, payload);
      }
      return { commands: [] };
    }
    if (!sid && this.pagerTombs.has(pagerId) && payload.full !== true) {
      return { commands: [] };
    }
    if (!sid && this.pagerTombs.has(pagerId) && payload.full === true) {
      this.pagerTombs.delete(pagerId);
    }

    const existing = this.sessions.get(pagerId);
    if (existing && sid && existing.sid && existing.sid !== sid) {
      // pagerId was recycled by a new attach; the previous page's archive must not mix in.
      this.dropSession(pagerId);
    }

    const session = this.session(pagerId);
    if (sid) session.sid = sid;

    const { changedNodes, removed, logs, network } = this.applyPayload(session, payload);

    const commands = session.pendingCommands;
    session.pendingCommands = [];

    const delta = {
      type: 'delta',
      pagerId,
      full: payload.full === true,
      meta: session.summary(),
      device: payload.device || null,
      nodes: changedNodes,
      removed,
      logs,
      network: network.map((record) => slimForDelta(session.network.get(record.id))).filter(Boolean),
    };
    if (payload.screenshot) delta.screenshot = payload.screenshot;
    if (Array.isArray(payload.blobs) && payload.blobs.length) delta.blobs = payload.blobs;
    this.emit('delta', delta);

    return { commands };
  }

  /**
   * Page gone: apply any last logs/network/blobs, then drop the session once bodies have
   * reassembled. Chunked destroy notices arrive as several POSTs; dropping on the first one
   * would discard the rest.
   */
  destroySession(pagerId, sid, payload) {
    if (sid) this.deadSids.set(sid, Date.now());
    let session = this.sessions.get(pagerId);
    const sameGeneration = !session || !sid || !session.sid || session.sid === sid;
    if (session && !sameGeneration) {
      if (!sid) this.pagerTombs.set(pagerId, Date.now());
      return { commands: [] };
    }
    const hasArchive = (Array.isArray(payload.logs) && payload.logs.length) ||
      (Array.isArray(payload.network) && payload.network.length) ||
      (Array.isArray(payload.blobs) && payload.blobs.length);
    if (!session && hasArchive) {
      session = this.session(pagerId);
      if (sid) session.sid = sid;
    }
    if (session) {
      if (sid && !session.sid) session.sid = sid;
      this.applyLogsAndNetwork(session, payload);
      session.closing = true;
      session.closingAt = Date.now();
      this.emitArchiveDelta(session, pagerId, payload);
      if (!bodiesPending(session)) {
        this.dropSession(pagerId);
      }
    }
    if (!sid) this.pagerTombs.set(pagerId, Date.now());
    return { commands: [] };
  }

  drainClosingSession(session, pagerId, payload) {
    this.applyLogsAndNetwork(session, payload);
    session.closingAt = Date.now();
    this.emitArchiveDelta(session, pagerId, payload);
    if (!bodiesPending(session)) {
      this.dropSession(pagerId);
    }
    return { commands: [] };
  }

  emitArchiveDelta(session, pagerId, payload) {
    const network = Array.isArray(payload.network) ? payload.network : [];
    const logs = Array.isArray(payload.logs) ? payload.logs : [];
    const delta = {
      type: 'delta',
      pagerId,
      full: false,
      meta: session.summary(),
      device: null,
      nodes: [],
      removed: [],
      logs,
      network: network.map((record) => slimForDelta(session.network.get(record.id))).filter(Boolean),
    };
    if (Array.isArray(payload.blobs) && payload.blobs.length) delta.blobs = payload.blobs;
    this.emit('delta', delta);
  }

  applyPayload(session, payload) {
    session.page = payload.page || session.page;
    session.className = payload.class || session.className;
    session.platform = payload.platform || session.platform;
    session.sampleMs = payload.sampleMs || session.sampleMs;
    session.lastSeq = typeof payload.seq === 'number' ? payload.seq : session.lastSeq;
    session.lastSeenAt = Date.now();
    if (payload.device) session.device = payload.device;
    if (payload.droppedLogs) session.droppedLogs += payload.droppedLogs;

    const tree = payload.tree || {};
    const isFull = payload.full === true;
    if (isFull) session.nodes.clear();

    const changedNodes = Array.isArray(tree.nodes) ? tree.nodes : [];
    for (const node of changedNodes) {
      session.nodes.set(node.id, node);
    }
    const removed = Array.isArray(tree.removed) ? tree.removed : [];
    for (const id of removed) {
      session.nodes.delete(id);
    }

    const logs = this.applyLogsAndNetwork(session, payload);
    if (payload.screenshot) session.screenshot = payload.screenshot;
    return { changedNodes, removed, logs: logs.logs, network: logs.network };
  }

  applyLogsAndNetwork(session, payload) {
    const logs = Array.isArray(payload.logs) ? payload.logs : [];
    for (const entry of logs) {
      if (!entry || typeof entry.seq !== 'number') continue;
      if (session.logSeqs.has(entry.seq)) continue;
      session.logSeqs.add(entry.seq);
      session.logs.push(entry);
    }
    if (session.logs.length > MAX_LOGS) {
      const extra = session.logs.length - MAX_LOGS;
      const evicted = session.logs.splice(0, extra);
      for (const entry of evicted) session.logSeqs.delete(entry.seq);
    }

    const network = Array.isArray(payload.network) ? payload.network : [];
    for (const record of network) {
      if (!record || record.id == null) continue;
      // Drop the agent's own ingest/ping traffic if an older runtime still captured it.
      if (typeof record.url === 'string' && record.url.includes(SERVE_PATH_MARKER)) continue;
      if (!session.network.has(record.id)) {
        session.networkOrder.push(record.id);
        if (session.networkOrder.length > MAX_NETWORK) {
          const evicted = session.networkOrder.shift();
          session.network.delete(evicted);
          dropBodyBuf(session, evicted);
        }
      }
      // A record arrives once when the request starts and again once it completes; merging keeps the
      // request fields that the completion payload does not repeat.
      session.network.set(record.id, mergeRecord(session.network.get(record.id), record));
    }

    applyBlobs(session, payload.blobs);

    return { logs, network };
  }

  pruneTombstones() {
    const now = Date.now();
    for (const [key, at] of this.deadSids) {
      if (now - at > TOMBSTONE_TTL_MS) this.deadSids.delete(key);
    }
    for (const [key, at] of this.pagerTombs) {
      if (now - at > TOMBSTONE_TTL_MS) this.pagerTombs.delete(key);
    }
    for (const session of Array.from(this.sessions.values())) {
      if (session.closing && now - session.closingAt > CLOSE_DRAIN_MS) {
        this.dropSession(session.pagerId);
      }
    }
  }

  /** Queues a panel command; the device picks it up on its next ingest round trip. */
  enqueueCommand(pagerId, command) {
    const session = this.sessions.get(pagerId);
    if (!session || !command || !command.type) return false;
    if (command.type === 'state' && Array.isArray(command.ids)) {
      session.stateNodeIds = command.ids;
    }
    // Collapse duplicates of idempotent commands so a chatty panel cannot build a backlog.
    if (command.type === 'full' || command.type === 'state' || command.type === 'sample' || command.type === 'shot' || command.type === 'live') {
      session.pendingCommands = session.pendingCommands.filter((queued) => queued.type !== command.type);
    }
    session.pendingCommands.push(command);
    return true;
  }

  dropSession(pagerId) {
    if (this.sessions.delete(pagerId)) {
      this.emit('session-removed', { pagerId });
      return true;
    }
    return false;
  }
}

module.exports = { Hub, Session, mergeRecord, MAX_LOGS, MAX_NETWORK };
