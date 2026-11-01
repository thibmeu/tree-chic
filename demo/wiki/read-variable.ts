import { createHash } from 'node:crypto';
import type { Transport } from './types.ts';
import type { ComparisonRead } from './comparison-types.ts';

const hash = (...parts: Uint8Array[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
interface Node { index: number; start: number; length: number; record: Buffer }

// No trusted leaf index or boundary table: navigate by authenticated byte lengths.
export async function readVariable(url: string, root: string, start: number, end: number, transport: Transport = fetch) {
  const began = performance.now();
  const trace: ComparisonRead[] = [];
  let round = 1;
  let total: number | undefined;
  let peakProofBatchBytes = 0;
  async function range(a: number, b: number, kind: ComparisonRead['kind']) {
    const response = await transport(url, { headers: { Range: `bytes=${a}-${b}` } });
    const cr = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
    if (response.status !== 206 || !cr || Number(cr[1]) !== a || Number(cr[2]) !== b || (total !== undefined && Number(cr[3]) !== total)) throw Error(`Invalid ${kind} response: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length !== b - a + 1) throw Error('Short range');
    trace.push({ round, kind, start: a, end: b, bytes: bytes.length });
    return bytes;
  }
  const initial = await range(0, 71, 'bootstrap');
  const bootstrap = initial.subarray(0, 32), rootRecord = initial.subarray(32);
  if (hash(Buffer.from([2]), bootstrap, rootRecord).toString('hex') !== root) throw Error('Root mismatch');
  if (bootstrap.subarray(0, 8).toString() !== 'TCHVAR01') throw Error('Invalid format');
  const size = Number(bootstrap.readBigUInt64BE(8));
  const fanout = bootstrap.readUInt32BE(16), capacity = bootstrap.readUInt32BE(20), recordBytes = bootstrap.readUInt32BE(24);
  const depth = Math.round(Math.log(capacity) / Math.log(fanout));
  if (![2, 16, 64].includes(fanout) || capacity < 1 || capacity > 1048576 || fanout ** depth !== capacity || !Number.isSafeInteger(size) || Number(rootRecord.readBigUInt64BE()) !== size) throw Error('Invalid parameters');
  const leafStart = (capacity - 1) / (fanout - 1);
  if (recordBytes !== (leafStart + capacity) * 40) throw Error('Invalid record size');
  const headerSize = 32 + recordBytes;
  total = headerSize + size;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= size) throw Error('Invalid requested interval');
  let active: Node[] = [{ index: 0, start: 0, length: size, record: rootRecord }];
  const leaves: Node[] = [];
  while (active.length) {
    const branches: Node[] = [];
    for (const node of active) { if (node.index >= leafStart) leaves.push(node); else branches.push(node); }
    if (!branches.length) break;
    round++;
    const responses = await Promise.all(branches.map(node => {
      const child = node.index * fanout + 1;
      return range(32 + child * 40, 32 + (child + fanout) * 40 - 1, 'proof');
    }));
    peakProofBatchBytes = Math.max(peakProofBatchBytes, responses.reduce((n, bytes) => n + bytes.length, 0));
    active = [];
    for (let b = 0; b < branches.length; b++) {
      const parent = branches[b], children = responses[b];
      if (!hash(Buffer.from([1]), children).equals(parent.record.subarray(8))) throw Error('Branch hash mismatch');
      let offset = parent.start;
      for (let j = 0; j < fanout; j++) {
        const record = children.subarray(j * 40, (j + 1) * 40);
        const length = Number(record.readBigUInt64BE());
        if (!Number.isSafeInteger(length) || length > parent.length) throw Error('Invalid child length');
        if (length > 0 && offset <= end && offset + length > start) active.push({ index: parent.index * fanout + 1 + j, start: offset, length, record: Buffer.from(record) });
        offset += length;
      }
      if (offset !== parent.start + parent.length) throw Error('Subtree length mismatch');
    }
  }
  leaves.sort((a, b) => a.start - b.start);
  if (!leaves.length || leaves[0].start > start || leaves.at(-1)!.start + leaves.at(-1)!.length <= end) throw Error('Incomplete interval proof');
  for (let i = 1; i < leaves.length; i++) if (leaves[i - 1].start + leaves[i - 1].length !== leaves[i].start) throw Error('Noncontiguous proof');
  const dataStart = leaves[0].start, dataEnd = leaves.at(-1)!.start + leaves.at(-1)!.length - 1;
  // Bounded experiment: buffer the covering interval, accounting for this in results.
  if (dataEnd - dataStart + 1 > 2 * 1024 * 1024) throw Error('Experiment payload buffer limit exceeded');
  round++;
  const payload = await range(headerSize + dataStart, headerSize + dataEnd, 'payload');
  for (const leaf of leaves) {
    const bytes = payload.subarray(leaf.start - dataStart, leaf.start - dataStart + leaf.length);
    if (!hash(Buffer.from([0]), bytes).equals(leaf.record.subarray(8))) throw Error('Payload hash mismatch');
  }
  return {
    bytes: payload.subarray(start - dataStart, end - dataStart + 1),
    stats: { fanout, depth, metadataBytes: trace.filter(t => t.kind !== 'payload').reduce((n, t) => n + t.bytes, 0), payloadBytes: payload.length, payloadOverfetch: payload.length - (end - start + 1), requests: trace.length, rounds: round, payloadBufferBytes: payload.length, peakProofBatchBytes, elapsedMs: performance.now() - began, trace }
  };
}
