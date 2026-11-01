import type { Manifest, Transport, RangeTrace } from './types.ts';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const hash = (...parts: Uint8Array[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
export async function verify(base: string, root: string, title: string, transport: Transport = fetch) {
  if (!/^[a-f0-9]{64}$/.test(root)) throw Error('Supply the independently pinned SHA-256 root');
  const began = performance.now();
  const manifestResponse = await transport(`${base}/manifest`);
  if (!manifestResponse.ok) throw Error('Manifest unavailable');
  const manifest = await manifestResponse.json() as Manifest;
  const article = manifest.articles.find(a => a.title === title);
  if (!article) throw Error(`Choose one of: ${manifest.articles.map(a => a.title).join(', ')}`);
  const trace: RangeTrace[] = [];
  let total: number | undefined;
  async function range(start: number, end: number, kind: RangeTrace['kind']) {
    const response = await transport(`${base}/object`, { headers: { Range: `bytes=${start}-${end}` } });
    const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
    if (response.status !== 206 || !cr || Number(cr[1]) !== start || Number(cr[2]) !== end || (total && Number(cr[3]) !== total)) throw Error(`Invalid range response for ${kind}: HTTP ${response.status}, ${response.headers.get('Content-Range')}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== end - start + 1) throw Error('Short response');
    trace.push({ kind, start, end, bytes: bytes.length });
    return bytes;
  }
  const initial = await range(0, 71, 'bootstrap');
  const bootstrap = initial.subarray(0, 32);
  const rootRecord = initial.subarray(32);
  if (hash(Buffer.from([2]), bootstrap, rootRecord).toString('hex') !== root) throw Error('Root mismatch');
  if (bootstrap.subarray(0, 8).toString() !== 'TCHDEMO1') throw Error('Unknown format');
  const size = Number(bootstrap.readBigUInt64BE(8));
  const chunk = bootstrap.readUInt32BE(16);
  const leaves = bootstrap.readUInt32BE(20);
  const recordBytes = bootstrap.readUInt32BE(24);
  if (!Number.isSafeInteger(size) || chunk !== 65536 || leaves < 1 || leaves > 1048576 || (leaves & (leaves - 1)) || recordBytes !== (2 * leaves - 1) * 40 || size > leaves * chunk || Number(rootRecord.readBigUInt64BE()) !== size) throw Error('Invalid format parameters');
  const headerSize = 32 + recordBytes;
  total = headerSize + size;
  if (!Number.isSafeInteger(article.start) || !Number.isSafeInteger(article.end) || article.start < 0 || article.end < article.start || article.end >= size || article.end - article.start > 1024 * 1024) throw Error('Invalid article hint');
  const first = Math.floor(article.start / chunk);
  const last = Math.floor(article.end / chunk);
  const spans: [number, number][] = [];
  for (let a = leaves + first, b = leaves + last; a > 1; a = Math.floor(a / 2), b = Math.floor(b / 2)) spans.push([a - a % 2, b % 2 ? b : b + 1]);
  spans.reverse();
  const dataStart = first * chunk;
  const dataEnd = Math.min(size, (last + 1) * chunk) - 1;
  const [metadata, data] = await Promise.all([
    Promise.all(spans.map(([a, b]) => range(32 + (a - 1) * 40, 32 + b * 40 - 1, 'proof'))),
    range(headerSize + dataStart, headerSize + dataEnd, 'payload')
  ]);
  const nodes = new Map([[1, rootRecord]]);
  for (let level = 0; level < spans.length; level++) {
    const [a, b] = spans[level];
    const bytes = metadata[level];
    for (let i = a; i <= b; i++) nodes.set(i, bytes.subarray((i - a) * 40, (i - a + 1) * 40));
    for (let i = a; i <= b; i += 2) {
      const left = nodes.get(i), right = nodes.get(i + 1), parent = nodes.get(i / 2);
      if (!parent || !left || !right || left.readBigUInt64BE() + right.readBigUInt64BE() !== parent.readBigUInt64BE() || !hash(Buffer.from([1]), left, right).equals(parent.subarray(8))) throw Error('Tree proof mismatch');
    }
  }
  for (let i = first; i <= last; i++) {
    const bytes = data.subarray((i - first) * chunk, Math.min(data.length, (i - first + 1) * chunk));
    const leaf = nodes.get(leaves + i);
    if (!leaf || Number(leaf.readBigUInt64BE()) !== bytes.length || !hash(Buffer.from([0]), bytes).equals(leaf.subarray(8))) throw Error('Payload integrity mismatch');
  }
  // Only decompress after every covering chunk has authenticated successfully.
  const stream = data.subarray(article.start - dataStart, article.end - dataStart + 1);
  const xml = execFileSync('bzip2', ['-dc'], { input: stream, maxBuffer: 32 * 1024 * 1024 }).toString();
  const decode = (s: string) => s.replace(/&#(x[0-9a-f]+|\d+);/gi, (_: string, n: string) => String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n))).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const page = [...xml.matchAll(/<page>([\s\S]*?)<\/page>/g)].find(m => decode(/<title>([\s\S]*?)<\/title>/.exec(m[1])?.[1] || '') === title);
  if (!page) throw Error('Requested title absent from authenticated stream');
  const text = decode(/<text\b[^>]*>([\s\S]*?)<\/text>/.exec(page[1])?.[1] || '');
  return { title, root, snapshotBytes: size, streamBytes: stream.length, payloadBytes: data.length, metadataBytes: trace.filter(t => t.kind !== 'payload').reduce((n, t) => n + t.bytes, 0), rangeRequests: trace.length, elapsedMs: Math.round(performance.now() - began), trace, text };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, root, title = 'Paris'] = process.argv.slice(2);
  if (!base || !root) throw Error('Usage: node verify.ts URL TRUSTED_ROOT [ARTICLE_TITLE]');
  const { text, ...result } = await verify(base.replace(/\/$/, ''), root, title);
  console.log(JSON.stringify(result, null, 2));
  console.log('\nVerified article excerpt:\n' + text.slice(0, 1600));
}
