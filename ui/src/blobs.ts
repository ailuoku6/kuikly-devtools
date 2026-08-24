import type { BodyBlobDto, NetworkDto, NetworkFrameDto } from './protocol';

interface BodyBuf {
  count: number;
  parts: Array<string | undefined>;
  got: number;
  chars: number;
  field: string;
  id: string;
  seq?: number;
  dir?: string;
  ts?: number;
}

export interface BlobSession {
  network: Map<string, NetworkDto>;
  networkOrder?: string[];
  bodyBuf: Map<string, unknown>;
}

function blobKey(blob: BodyBlobDto): string {
  if (blob.field === 'frame') return `${blob.id}#frame#${blob.seq}`;
  return `${blob.id}#${blob.field}`;
}

export function applyBlobs(session: BlobSession, blobs?: BodyBlobDto[]): void {
  if (!blobs?.length) return;
  for (const blob of blobs) {
    if (!blob || blob.id == null || typeof blob.field !== 'string' || typeof blob.data !== 'string') {
      continue;
    }
    if (typeof blob.index !== 'number' || typeof blob.count !== 'number') continue;
    if (blob.count < 1 || blob.index < 0 || blob.index >= blob.count) continue;
    const id = String(blob.id);
    const key = blobKey({ ...blob, id });
    let buf = session.bodyBuf.get(key) as BodyBuf | undefined;
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

function stampProgress(rec: NetworkDto, buf: BodyBuf) {
  if (buf.field === 'req') rec.reqGot = buf.chars;
  else if (buf.field === 'rsp') rec.rspGot = buf.chars;
}

function attachAssembled(session: BlobSession, buf: BodyBuf, text: string) {
  let rec = session.network.get(buf.id);
  if (!rec) {
    rec = { id: buf.id, url: '', method: '', stack: '', ts: 0 };
    session.network.set(buf.id, rec);
    session.networkOrder?.push(buf.id);
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
    if (!rec.msgs) rec.msgs = [];
    let frame: NetworkFrameDto | undefined = rec.msgs.find((item) => item.seq === buf.seq);
    if (!frame) {
      frame = { seq: buf.seq ?? 0, dir: buf.dir === 'up' ? 'up' : 'down', ts: buf.ts ?? 0, data: text };
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
