import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { manifest } from './generated.ts';
import { comparisonLayouts, chunkStatistics } from './comparison-generated.ts';
import { readVariable } from './read-variable.ts';
import { withLocalUpstream } from './local-comparison.ts';
import type { Transport } from './types.ts';

const [base = 'local', output = 'comparison-results.json', repeatsInput = '3'] = process.argv.slice(2);
const repeats = Number(repeatsInput);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw Error('Repeat count must be 1..10');
const workloads = [
  ...manifest.articles.map(a => ({ name: a.title, start: a.start, end: a.end, title: a.title })),
  ...[manifest.articles[0], manifest.articles.at(-1)!].map(a => ({ name: `${a.title} (cross boundaries)`, start: a.start - 33, end: a.end + 33, title: null }))
];
const runs: { workload: string; layout: string; repeat: number; contentHash: string; stats: Awaited<ReturnType<typeof readVariable>>['stats'] }[] = [];
const knownHashes = new Map<string, string>();
async function run(transport: Transport) {
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (let w = 0; w < workloads.length; w++) {
      const workload = workloads[w];
      // Rotate order to avoid assigning every first/warm upstream request to one layout.
      for (let j = 0; j < comparisonLayouts.length; j++) {
        const layout = comparisonLayouts[(j + repeat + w) % comparisonLayouts.length];
        const url = `${base === 'local' ? 'https://demo.test' : base}/compare/${layout.name}/object`;
        const { bytes, stats } = await readVariable(url, layout.root, workload.start, workload.end, transport);
        const contentHash = createHash('sha256').update(bytes).digest('hex');
        if (knownHashes.has(workload.name) && knownHashes.get(workload.name) !== contentHash) throw Error('Layouts returned different content');
        knownHashes.set(workload.name, contentHash);
        if (workload.title) {
          const xml = execFileSync('bzip2', ['-dc'], { input: bytes, maxBuffer: 32 * 1024 * 1024 }).toString();
          if (!xml.includes(`<title>${workload.title}</title>`)) throw Error('Authenticated stream does not contain requested article');
        }
        runs.push({ workload: workload.name, layout: layout.name, repeat, contentHash, stats });
        console.log(`${repeat + 1}/${repeats} ${layout.name} ${workload.name}: ${Math.round(stats.elapsedMs)} ms, ${stats.metadataBytes} metadata bytes, ${stats.requests} requests, ${stats.rounds} rounds`);
      }
    }
  }
}
if (base === 'local') await withLocalUpstream(process.env.WIKI_DUMP || '/tmp/tree-chic-wiki.xml.bz2', run);
else await run(fetch);
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); const i = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2; };
const summary = workloads.flatMap(workload => comparisonLayouts.map(layout => {
  const samples = runs.filter(r => r.workload === workload.name && r.layout === layout.name);
  const { trace, elapsedMs, ...counts } = samples[0].stats;
  return { workload: workload.name, layout: layout.name, headerBytes: layout.headerSize, ...counts, medianMs: median(samples.map(s => s.stats.elapsedMs)), minMs: Math.min(...samples.map(s => s.stats.elapsedMs)), maxMs: Math.max(...samples.map(s => s.stats.elapsedMs)) };
}));
await writeFile(output, JSON.stringify({ measuredAt: new Date().toISOString(), base, repeats, coverage: manifest.coverage, size: manifest.size, chunkStatistics, method: 'Cold client metadata on each run; title-to-byte-range hints and roots supplied locally; no manifest request counted; sequential authenticated navigation; no speculative payload fetch. Layout order rotates. Time includes verified byte retrieval, excludes bzip2 extraction. HTTP headers/TLS bytes and decompressor memory excluded. Payload buffer is actual full covering interval; proof buffer is peak fetched batch, not total process RSS. Upstream caches are not controlled.', layouts: comparisonLayouts.map(({ headerBase64, ...layout }) => layout), workloads, summary, runs }, null, 2) + '\n');
console.table(summary.map(s => ({ workload: s.workload, layout: s.layout, metadata: s.metadataBytes, payload: s.payloadBytes, requests: s.requests, rounds: s.rounds, medianMs: Math.round(s.medianMs) })));
