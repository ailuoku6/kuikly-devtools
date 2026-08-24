import type { NetworkDto } from './protocol';

const PLAIN_HTTP_STACKS = new Set(['KRNetworkModule', 'TDF/network.fetch']);
/** Hippy Android folds client timeout into the headers map; it is not sent on the wire. */
const PSEUDO_HEADERS = new Set(['timeout']);

/** KRNetworkModule / TDF `network.fetch` only — long-link, MQTT and MapSSO are not replayable as curl. */
export function isPlainHttp(record: NetworkDto): boolean {
  if (record.kind === 'stream') return false;
  if (!PLAIN_HTTP_STACKS.has(record.stack)) return false;
  const method = record.method.trim().toUpperCase();
  if (method === 'SUB' || method === 'OBS' || method === 'PUB') return false;
  return true;
}

/** Chrome-style `copy as cURL` for a captured HTTP record. */
export function toCurl(record: NetworkDto): string {
  const method = (record.method || 'GET').trim().toUpperCase() || 'GET';
  const headers = parseHeaders(record.hdr);
  let url = record.url || '';
  let body = record.req ?? '';

  if ((method === 'GET' || method === 'HEAD') && body.trim()) {
    const merged = mergeFlatQuery(url, body);
    if (merged) {
      url = merged;
      body = '';
    }
  }

  const lines: string[] = [];
  const head = ['curl'];
  if (method !== 'GET') head.push('-X', method);
  head.push(shQuote(url));
  lines.push(head.join(' '));

  for (const [name, value] of Object.entries(headers)) {
    if (PSEUDO_HEADERS.has(name.toLowerCase())) continue;
    lines.push(`  -H ${shQuote(`${name}: ${value}`)}`);
  }
  if (body !== '') {
    lines.push(`  --data-raw ${shQuote(body)}`);
  }

  if (lines.length === 1) return lines[0];
  return lines.map((line, index) => (index === lines.length - 1 ? line : `${line} \\`)).join('\n');
}

export function parseHeaders(raw?: string): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value == null) continue;
      out[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    return out;
  } catch {
    return {};
  }
}

function mergeFlatQuery(url: string, body: string): string | null {
  let params: Record<string, unknown>;
  try {
    params = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const entries = Object.entries(params);
  if (entries.some(([, value]) => value != null && typeof value === 'object')) return null;
  try {
    const parsed = new URL(url);
    for (const [key, value] of entries) {
      if (value == null) continue;
      if (!parsed.searchParams.has(key)) parsed.searchParams.set(key, String(value));
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
