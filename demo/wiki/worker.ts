import { manifest, headerBase64 } from './generated.ts';
import { comparisonLayouts } from './comparison-generated.ts';
const baseHeader = Uint8Array.fromBase64(headerBase64);
const comparisonHeaders = new Map(comparisonLayouts.map(layout => [layout.name, Uint8Array.fromBase64(layout.headerBase64)]));
const common = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, ETag', 'Cache-Control': 'no-store' };
export default {
  async fetch(request: Request): Promise<Response> {
    let path = new URL(request.url).pathname;
    let header = baseHeader;
    let activeManifest = manifest;
    const comparison = /^\/compare\/([^/]+)(\/.*)$/.exec(path);
    if (comparison) {
      const layout = comparisonLayouts.find(item => item.name === comparison[1]);
      if (!layout) return new Response('Unknown layout', { status: 404 });
      const { headerBase64: omitted, ...description } = layout;
      activeManifest = { ...manifest, ...description, format: 'TCHVAR01 (variable-length experiment)' };
      header = comparisonHeaders.get(layout.name)!;
      path = comparison[2];
    }
    const total = header.length + activeManifest.size;
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('GET or HEAD only', { status: 405 });
    if (path === '/comparison') return Response.json({ source: manifest.source, coverage: manifest.coverage, articles: manifest.articles, layouts: comparisonLayouts.map(({ headerBase64, ...layout }) => layout) }, { headers: common });
    if (path === '/manifest') return Response.json(activeManifest, { headers: common });
    if (path === '/') return new Response('Tree CHIC Wikipedia range experiment\n\nGET /manifest for the pinned snapshot, root and example article offsets.\nGET /object with Range: bytes=start-end for the virtual tree + Wikipedia object.\n\nThe Worker stores only precomputed metadata; payload ranges come from Wikimedia.\nThis is an experimental fixed-size encoding, not the draft wire format.\nUse verify.ts with an independently pinned root to verify and extract an article.\n', { headers: { ...common, 'Content-Type': 'text/plain; charset=utf-8' } });
    if (path !== '/object') return new Response('Not found', { status: 404 });
    const headers = { ...common, 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', ETag: `"${activeManifest.root}"` };
    if (request.method === 'HEAD') return new Response(null, { headers: { ...headers, 'Content-Length': String(total) } });
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('Range') || '');
    if (!match) return new Response('Demo requires one explicit bounded byte range', { status: 400 });
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= total) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
    if (end - start + 1 > 2 * 1024 * 1024) return new Response('Demo range limit: 2 MiB', { status: 400 });
    let upstream;
    if (end >= header.length) {
      const a = Math.max(start, header.length) - header.length;
      const b = end - header.length;
      const sources = [activeManifest.source, activeManifest.source.replace('dumps.wikimedia.org', 'dumps.wikimedia.your.org')];
      const failures = [];
      for (const source of sources) {
        const response = await fetch(source, { headers: { Range: `bytes=${a}-${b}`, 'Accept-Encoding': 'identity', 'User-Agent': 'TreeCHIC-Range-Demo/0.1 (https://github.com/thibmeu/tree-chic)' }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
        if (response.status === 206 && response.headers.get('Content-Range') === `bytes ${a}-${b}/${activeManifest.sourceSize}` && !response.headers.get('Content-Encoding')) { upstream = response; break; }
        failures.push({ host: new URL(source).host, status: response.status, range: response.headers.get('Content-Range') });
        await response.body?.cancel();
      }
      if (!upstream) return Response.json({ error: 'No upstream returned the exact pinned byte range', failures }, { status: 502 });
    }
    const prefix = start < header.length ? header.slice(start, Math.min(end + 1, header.length)) : null;
    const reader = upstream?.body?.getReader();
    const body = new ReadableStream({
      start(controller) { if (prefix) controller.enqueue(prefix); },
      async pull(controller) {
        if (!reader) return controller.close();
        try { const result = await reader.read(); if (result.done) controller.close(); else controller.enqueue(result.value); }
        catch (e) { controller.error(e); }
      },
      cancel(reason) { return reader?.cancel(reason); }
    });
    return new Response(body, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${total}` } });
  }
};
