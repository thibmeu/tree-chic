import type { Manifest } from './types.ts';
// Experimental fixed-size format; not a proposed Tree CHIC wire encoding.
import { createHash } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const [dump, index] = process.argv.slice(2);
if (!dump || !index) throw Error('Usage: node prepare.ts dump.xml.bz2 index.txt.bz2');
const hash = (...parts: Uint8Array[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
const f = await open(dump, 'r');
const available = (await f.stat()).size;
const sourceSize = 387919857;
const lines = execFileSync('bzip2', ['-dc', index], { maxBuffer: 128 * 1024 * 1024 }).toString().trim().split('\n');
const allEntries = lines.map(line => { const m = /^(\d+):(\d+):(.*)$/.exec(line); if (!m) throw Error('Invalid index line'); return { start: Number(m[1]), id: m[2], title: m[3] }; });
const prefix = process.argv.includes('--available-prefix');
if (available !== sourceSize && !prefix) throw Error('Expected the complete snapshot; --available-prefix explicitly selects a complete-stream prefix instead');
const size = prefix ? allEntries.reduce((end, e) => e.start <= available ? Math.max(end, e.start) : end, 0) : sourceSize;
if (!size || size > sourceSize) throw Error('Invalid snapshot size');
const chunk = 65536;
const count = Math.ceil(size / chunk);
const leaves = 2 ** Math.ceil(Math.log2(count));
const records = Buffer.alloc((2 * leaves - 1) * 40);
const record = (i: number) => records.subarray((i - 1) * 40, i * 40);
for (let i = 0; i < leaves; i++) {
  const bytes = Buffer.alloc(Math.max(0, Math.min(chunk, size - i * chunk)));
  if (bytes.length) {
    const { bytesRead } = await f.read(bytes, 0, bytes.length, i * chunk);
    if (bytesRead !== bytes.length) throw Error('Short file read');
  }
  record(leaves + i).writeBigUInt64BE(BigInt(bytes.length));
  hash(Buffer.from([0]), bytes).copy(record(leaves + i), 8);
}
await f.close();
for (let i = leaves - 1; i >= 1; i--) {
  record(i).writeBigUInt64BE(record(2 * i).readBigUInt64BE() + record(2 * i + 1).readBigUInt64BE());
  hash(Buffer.from([1]), record(2 * i), record(2 * i + 1)).copy(record(i), 8);
}
const bootstrap = Buffer.alloc(32);
bootstrap.write('TCHDEMO1');
bootstrap.writeBigUInt64BE(BigInt(size), 8);
bootstrap.writeUInt32BE(chunk, 16);
bootstrap.writeUInt32BE(leaves, 20);
bootstrap.writeUInt32BE(records.length, 24);
const root = hash(Buffer.from([2]), bootstrap, record(1)).toString('hex');
const header = Buffer.concat([bootstrap, records]);
const entries = allEntries.filter(e => e.start < size);
const offsets = [...new Set(entries.map(e => e.start)), size];
const ends = new Map(offsets.slice(0, -1).map((n, i) => [n, offsets[i + 1] - 1]));
const selected = entries.filter(e => ['Paris', 'Cryptography', 'Wikipedia'].includes(e.title));
const late = entries.find(e => e.start > size * 0.9 && !e.title.includes(':'));
if (late) selected.push(late);
const manifest: Manifest = { format: 'TCHDEMO1 (experimental; not standardized)', coverage: size === sourceSize ? 'full snapshot' : 'complete-stream prefix only; not the full Wikipedia snapshot', source: 'https://dumps.wikimedia.org/simplewiki/20261001/simplewiki-20261001-pages-articles-multistream.xml.bz2', sourceSize, root, size, chunk, leaves, headerSize: header.length, articles: selected.map(e => ({ ...e, end: ends.get(e.start)! })) };
await writeFile(new URL('generated.ts', import.meta.url), `import type { Manifest } from './types.ts';\nexport const manifest: Manifest = ${JSON.stringify(manifest)};\nexport const headerBase64 = ${JSON.stringify(header.toBase64())};\n`);
await writeFile(new URL('manifest.json', import.meta.url), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
