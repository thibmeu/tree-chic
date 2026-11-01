import { createHash } from 'node:crypto';
import { open, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { manifest } from './generated.ts';
import type { ComparisonLayout } from './comparison-types.ts';

const [dump, index] = process.argv.slice(2);
if (!dump || !index) throw Error('Usage: node prepare-comparison.ts dump.xml.bz2 index.txt.bz2');
const hash = (...parts: Uint8Array[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
const lines = execFileSync('bzip2', ['-dc', index], { maxBuffer: 128 * 1024 * 1024 }).toString().trim().split('\n');
const boundaries = [...new Set([0, ...lines.map(line => Number(line.slice(0, line.indexOf(':')))).filter(n => n < manifest.size), manifest.size])].sort((a, b) => a - b);
const file = await open(dump, 'r');
const leafRecords: Buffer[] = [];
const lengths: number[] = [];
for (let i = 0; i < boundaries.length - 1; i++) {
  const size = boundaries[i + 1] - boundaries[i];
  const bytes = Buffer.alloc(size);
  const { bytesRead } = await file.read(bytes, 0, size, boundaries[i]);
  if (bytesRead !== size) throw Error('Incomplete input');
  const record = Buffer.alloc(40);
  record.writeBigUInt64BE(BigInt(size));
  hash(Buffer.from([0]), bytes).copy(record, 8);
  leafRecords.push(record);
  lengths.push(size);
}
await file.close();
const comparisonLayouts: ComparisonLayout[] = [];
for (const fanout of [2, 16, 64]) {
  const capacity = fanout ** Math.ceil(Math.log(leafRecords.length) / Math.log(fanout));
  const leafStart = (capacity - 1) / (fanout - 1);
  const records = Buffer.alloc((leafStart + capacity) * 40);
  const record = (i: number) => records.subarray(i * 40, (i + 1) * 40);
  const empty = Buffer.alloc(40);
  hash(Buffer.from([0])).copy(empty, 8);
  for (let i = 0; i < capacity; i++) (leafRecords[i] || empty).copy(record(leafStart + i));
  for (let i = leafStart - 1; i >= 0; i--) {
    const firstChild = fanout * i + 1;
    let size = 0n;
    for (let j = 0; j < fanout; j++) size += record(firstChild + j).readBigUInt64BE();
    record(i).writeBigUInt64BE(size);
    hash(Buffer.from([1]), records.subarray(firstChild * 40, (firstChild + fanout) * 40)).copy(record(i), 8);
  }
  const bootstrap = Buffer.alloc(32);
  bootstrap.write('TCHVAR01');
  bootstrap.writeBigUInt64BE(BigInt(manifest.size), 8);
  bootstrap.writeUInt32BE(fanout, 16);
  bootstrap.writeUInt32BE(capacity, 20);
  bootstrap.writeUInt32BE(records.length, 24);
  const header = Buffer.concat([bootstrap, records]);
  comparisonLayouts.push({ name: `variable-${fanout}`, root: hash(Buffer.from([2]), bootstrap, record(0)).toString('hex'), fanout, capacity, leafCount: leafRecords.length, size: manifest.size, headerSize: header.length, headerBase64: header.toBase64() });
}
lengths.sort((a, b) => a - b);
const chunkStatistics = { count: lengths.length, min: lengths[0], median: lengths[Math.floor(lengths.length / 2)], p95: lengths[Math.floor(lengths.length * 0.95)], max: lengths.at(-1), total: manifest.size };
await writeFile(new URL('comparison-generated.ts', import.meta.url), `import type { ComparisonLayout } from './comparison-types.ts';\nexport const comparisonLayouts: ComparisonLayout[] = ${JSON.stringify(comparisonLayouts)};\nexport const chunkStatistics = ${JSON.stringify(chunkStatistics)};\n`);
console.log(JSON.stringify({ chunkStatistics, layouts: comparisonLayouts.map(({ headerBase64, ...rest }) => rest) }, null, 2));
