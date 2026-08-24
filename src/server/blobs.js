'use strict';

/**
 * Reassembles chunked HTTP / stream bodies that the device split so a single ingest POST stays
 * small enough for Kuikly's NetworkModule.toNative path.
 */
function blobKey(blob) {
  if (blob.field === 'frame') return `${blob.id}#frame#${blob.seq}`;
  return `${blob.id}#${blob.field}`;
}

function applyBlobs(session, blobs) {
  if (!Array.isArray(blobs) || blobs.length === 0) return;
  if (!session.bodyBuf) session.bodyBuf = new Map();
  for (const blob of blobs) {
    if (!blob || blob.id == null || typeof blob.field !== 'string' || typeof blob.data !== 'string') {
      continue;
    }
    if (typeof blob.index !== 'number' || typeof blob.count !== 'number') continue;
    if (blob.count < 1 || blob.index < 0 || blob.index >= blob.count) continue;
    const id = String(blob.id);
    const key = blobKey({ ...blob, id });
    let buf = session.bodyBuf.get(key);
    if (!buf) {
      buf = {
        count: blob.count,
        parts: new Array(blob.count),
        got: 0,
        chars: 0,
        field: blob.field,
        id,
        seq: blob.seq,
        dir: blob.dir,
        ts: blob.ts,
      };
      session.bodyBuf.set(key, buf);
    }
    if (buf.parts[blob.index] == null) {
      buf.parts[blob.index] = blob.data;
      buf.got += 1;
      buf.chars += blob.data.length;
    }
    const rec = session.network.get(id);
    if (rec) stampProgress(rec, buf);
    if (buf.got === buf.count) {
      attachAssembled(session, buf, buf.parts.join(''));
      session.bodyBuf.delete(key);
    }
  }
}

function stampProgress(rec, buf) {
  if (buf.field === 'req') rec.reqGot = buf.chars;
  else if (buf.field === 'rsp') rec.rspGot = buf.chars;
}

function attachAssembled(session, buf, text) {
  let rec = session.network.get(buf.id);
  if (!rec) {
    rec = { id: buf.id };
    session.network.set(buf.id, rec);
    if (session.networkOrder) session.networkOrder.push(buf.id);
  }
  if (buf.field === 'req') {
    rec.req = text;
    rec.reqGot = text.length;
    rec.reqChars = text.length;
  } else if (buf.field === 'rsp') {
    rec.rsp = text;
    rec.rspGot = text.length;
    rec.rspChars = text.length;
  } else if (buf.field === 'frame') {
    if (!Array.isArray(rec.msgs)) rec.msgs = [];
    let frame = rec.msgs.find((item) => item.seq === buf.seq);
    if (!frame) {
      frame = { seq: buf.seq, dir: buf.dir || 'down', ts: buf.ts || 0, data: text };
      rec.msgs.push(frame);
    } else {
      frame.data = text;
    }
    rec.frames = rec.msgs.length;
    rec.rsp = text;
    rec.rspGot = text.length;
    rec.rspChars = text.length;
  }
}

function dropBodyBuf(session, id) {
  if (!session.bodyBuf) return;
  const prefix = `${id}#`;
  for (const key of Array.from(session.bodyBuf.keys())) {
    if (key.startsWith(prefix)) session.bodyBuf.delete(key);
  }
}

/** Keep live deltas small: assembled megabyte strings ride on snapshot, not on every tick. */
function slimForDelta(record) {
  if (!record) return record;
  const copy = { ...record };
  if (shouldOmit(copy.rsp)) {
    copy.rspGot = copy.rsp.length;
    copy.rspChars = copy.rspChars || copy.rsp.length;
    delete copy.rsp;
  }
  if (shouldOmit(copy.req)) {
    copy.reqGot = copy.req.length;
    copy.reqChars = copy.reqChars || copy.req.length;
    delete copy.req;
  }
  if (Array.isArray(copy.msgs)) {
    copy.msgs = copy.msgs.map((frame) => {
      if (!frame || !shouldOmit(frame.data)) return frame;
      const next = { ...frame, dataChars: frame.data.length };
      delete next.data;
      return next;
    });
  }
  return copy;
}

function shouldOmit(text) {
  return typeof text === 'string' && text.length > 80_000;
}

module.exports = { applyBlobs, blobKey, dropBodyBuf, slimForDelta };
