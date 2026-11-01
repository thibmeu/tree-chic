import { open } from 'node:fs/promises';
import { manifest } from './generated.ts';
import worker from './worker.ts';
import type { Transport } from './types.ts';

export async function withLocalUpstream<T>(filePath: string, run: (transport: Transport) => Promise<T>): Promise<T> {
  const file = await open(filePath, 'r');
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url) !== manifest.source) throw Error('Unexpected upstream URL');
    const match = /^bytes=(\d+)-(\d+)$/.exec(new Headers(options?.headers).get('Range') || '');
    if (!match) throw Error('Expected bounded upstream range');
    const start = Number(match[1]), end = Number(match[2]);
    const bytes = Buffer.alloc(end - start + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, start);
    if (bytesRead !== bytes.length) throw Error('Short local fixture');
    return new Response(bytes, { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${manifest.sourceSize}` } });
  };
  try { return await run((url, options) => worker.fetch(new Request(url, options))); }
  finally { globalThis.fetch = previous; await file.close(); }
}
