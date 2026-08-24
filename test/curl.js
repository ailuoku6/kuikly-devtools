'use strict';

/**
 * Golden tests for copy-as-curl. Keep the helpers aligned with ui/src/curl.ts.
 *
 *   node test/curl.js
 */

const assert = require('assert');

const PLAIN_HTTP_STACKS = new Set(['KRNetworkModule', 'TDF/network.fetch']);
const PSEUDO_HEADERS = new Set(['timeout']);

function isPlainHttp(record) {
  if (record.kind === 'stream') return false;
  if (!PLAIN_HTTP_STACKS.has(record.stack)) return false;
  const method = String(record.method || '').trim().toUpperCase();
  if (method === 'SUB' || method === 'OBS' || method === 'PUB') return false;
  return true;
}

function toCurl(record) {
  const method = (record.method || 'GET').trim().toUpperCase() || 'GET';
  const headers = parseHeaders(record.hdr);
  let url = record.url || '';
  let body = record.req ?? '';

  if ((method === 'GET' || method === 'HEAD') && String(body).trim()) {
    const merged = mergeFlatQuery(url, body);
    if (merged) {
      url = merged;
      body = '';
    }
  }

  const lines = [];
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

function parseHeaders(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value == null) continue;
      out[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    return out;
  } catch {
    return {};
  }
}

function mergeFlatQuery(url, body) {
  let params;
  try {
    params = JSON.parse(body);
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

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

assert.strictEqual(isPlainHttp({ kind: 'stream', stack: 'KRNetworkModule', method: 'GET' }), false);
assert.strictEqual(isPlainHttp({ stack: 'TMNetworkModule.fetchMapServer', method: 'POST' }), false);
assert.strictEqual(isPlainHttp({ stack: 'TMKuiklyMQTTModule', method: 'PUB' }), false);
assert.strictEqual(isPlainHttp({ stack: 'KRNetworkModule', method: 'POST' }), true);
assert.strictEqual(isPlainHttp({ stack: 'TDF/network.fetch', method: 'GET' }), true);

const post = toCurl({
  url: "https://apimap.qq.com/ws/bus/detail?line=1",
  method: 'POST',
  stack: 'KRNetworkModule',
  hdr: JSON.stringify({
    'Content-Type': 'application/json',
    Cookie: "sid=a'b",
    timeout: '30',
  }),
  req: '{"lineId":"line-1"}',
});
assert.ok(post.startsWith("curl -X POST 'https://apimap.qq.com/ws/bus/detail?line=1' \\"));
assert.ok(post.includes("  -H 'Content-Type: application/json' \\"));
assert.ok(post.includes("  -H 'Cookie: sid=a'\\''b' \\"));
assert.ok(!post.includes('timeout'), 'client timeout must not become an HTTP header');
assert.ok(post.endsWith("  --data-raw '{\"lineId\":\"line-1\"}'"));

const get = toCurl({
  url: 'https://example.com/search',
  method: 'GET',
  stack: 'TDF/network.fetch',
  hdr: '{"Accept":"application/json"}',
  req: '{"q":"北京","page":1}',
});
assert.strictEqual(
  get,
  [
    "curl 'https://example.com/search?q=%E5%8C%97%E4%BA%AC&page=1' \\",
    "  -H 'Accept: application/json'",
  ].join('\n')
);

process.stdout.write('curl: ok\n');
