import type { Transport } from './types.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { open } from 'node:fs/promises';
import worker from './worker.ts';
import { manifest, headerBase64 } from './generated.ts';
import { verify } from './verify.ts';

test('virtual ranges, sparse extraction, and tamper rejection', async () => {
  const file = await open(process.env.WIKI_DUMP || '/tmp/tree-chic-wiki.xml.bz2', 'r');
  const originalFetch = globalThis.fetch;
  let badUpstream = false;
  globalThis.fetch = async (url, options) => {
    assert.ok([manifest.source, manifest.source.replace('dumps.wikimedia.org', 'dumps.wikimedia.your.org')].includes(String(url)));
    if (badUpstream) return new Response('not a range');
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(new Headers(options?.headers).get('Range') || '')!;
    const bytes = Buffer.alloc(Number(b) - Number(a) + 1);
    const result = await file.read(bytes, 0, bytes.length, Number(a));
    assert.equal(result.bytesRead, bytes.length);
    return new Response(bytes, { status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/${manifest.sourceSize}` } });
  };
  const local: Transport = (url, options) => worker.fetch(new Request(url, options));
  const get = (range: string) => local('https://demo.test/object', { headers: { Range: range } });
  try {
    const header = Buffer.from(headerBase64, 'base64');
    const cross = await get(`bytes=${header.length - 4}-${header.length + 3}`);
    assert.equal(cross.status, 206);
    assert.deepEqual(Buffer.from(await cross.arrayBuffer()), Buffer.concat([header.subarray(-4), Buffer.from('BZh9')]));
    assert.equal((await get('bytes=9-1')).status, 416);
    assert.equal((await get('bytes=0-999999999')).status, 416);
    assert.equal((await get('bytes=0-3000000')).status, 400);
    assert.equal((await get('bytes=0-1,3-4')).status, 400);
    const paris = await verify('https://demo.test', manifest.root, 'Paris', local);
    assert.match(paris.text, /Paris/);
    const late = await verify('https://demo.test', manifest.root, manifest.articles.at(-1)!.title, local);
    assert.ok(late.text.length > 0);
    assert.ok(late.payloadBytes < manifest.size / 100);
    for (const region of ['bootstrap', 'proof', 'payload']) {
      const corrupt: Transport = async (url, options) => {
        const response = await local(url, options);
        if (!url.endsWith('/object')) return response;
        const start = Number(/^bytes=(\d+)-/.exec(new Headers(options?.headers).get('Range') || '')![1]);
        const matches = region === 'bootstrap' ? start === 0 : region === 'payload' ? start >= header.length : start > 0 && start < header.length;
        if (!matches) return response;
        const body = new Uint8Array(await response.arrayBuffer());
        body[0] ^= 1;
        return new Response(body, response);
      };
      await assert.rejects(verify('https://demo.test', manifest.root, 'Paris', corrupt), /mismatch/);
    }
    badUpstream = true;
    assert.equal((await get(`bytes=${header.length}-${header.length + 3}`)).status, 502);
    console.log(JSON.stringify({ paris: { bytes: paris.payloadBytes + paris.metadataBytes, requests: paris.rangeRequests }, late: { title: late.title, bytes: late.payloadBytes + late.metadataBytes } }));
  } finally {
    globalThis.fetch = originalFetch;
    await file.close();
  }
});
