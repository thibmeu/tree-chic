import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { manifest } from './generated.ts';
import { comparisonLayouts } from './comparison-generated.ts';
import { readVariable } from './read-variable.ts';
import { withLocalUpstream } from './local-comparison.ts';
import type { Transport } from './types.ts';

test('all layouts return exact bytes, navigate boundaries, and reject tampering', async () => {
  const path = process.env.WIKI_DUMP || '/tmp/tree-chic-wiki.xml.bz2';
  const file = await open(path, 'r');
  try {
    await withLocalUpstream(path, async transport => {
      for (const layout of comparisonLayouts) {
        const url = `https://demo.test/compare/${layout.name}/object`;
        for (const article of manifest.articles) {
          for (const padding of [0, 33]) {
            const start = article.start - padding, end = article.end + padding;
            const result = await readVariable(url, layout.root, start, end, transport);
            const expected = Buffer.alloc(end - start + 1);
            await file.read(expected, 0, expected.length, start);
            assert.deepEqual(result.bytes, expected);
            if (!padding) {
              const xml = execFileSync('bzip2', ['-dc'], { input: result.bytes, maxBuffer: 32 * 1024 * 1024 }).toString();
              assert.ok(xml.includes(`<title>${article.title}</title>`));
              assert.equal(result.stats.payloadOverfetch, 0);
              assert.equal(result.stats.requests, result.stats.depth + 2);
              assert.equal(result.stats.rounds, result.stats.depth + 2);
            }
          }
        }
        // Last partial leaf and zero-length padding are reached by byte navigation.
        const tail = await readVariable(url, layout.root, layout.size - 7, layout.size - 1, transport);
        const expectedTail = Buffer.alloc(7);
        await file.read(expectedTail, 0, 7, layout.size - 7);
        assert.deepEqual(tail.bytes, expectedTail);
        const article = manifest.articles.at(-1)!;
        for (const kind of ['bootstrap', 'proof', 'payload']) {
          const corrupt: Transport = async (url, options) => {
            const response = await transport(url, options);
            const start = Number(/^bytes=(\d+)-/.exec(new Headers(options?.headers).get('Range') || '')![1]);
            const selected = kind === 'bootstrap' ? start === 0 : kind === 'proof' ? start > 0 && start < layout.headerSize : start >= layout.headerSize;
            if (!selected) return response;
            const bytes = new Uint8Array(await response.arrayBuffer());
            bytes[0] ^= 1;
            return new Response(bytes, response);
          };
          await assert.rejects(readVariable(url, layout.root, article.start, article.end, corrupt), /mismatch/);
        }
      }
    });
  } finally { await file.close(); }
});
