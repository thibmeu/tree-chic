import { stripTypeScriptTypes } from 'node:module';
// Uses Cloudflare's documented provisioning/previews API. No permanent account.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
if (!process.argv.includes('--accept-cloudflare-policies')) throw Error('First accept https://www.cloudflare.com/terms/ and https://www.cloudflare.com/privacypolicy/, then pass --accept-cloudflare-policies');
const directory = process.env.TREE_CHIC_PREVIEW_STATE;
if (!directory) throw Error('Set TREE_CHIC_PREVIEW_STATE to a private directory outside the repository');
await mkdir(directory, { recursive: true, mode: 0o700 });
interface PreviewState { account: { id: string; apiToken: string; expiresAt: string }; claim: { url: string; expiresAt: string } }
interface Challenge { challengeToken: string; seed: string; k: number; g: number }
const api = 'https://api.cloudflare.com/client/v4';
async function json<T = unknown>(path: string, options: RequestInit): Promise<T> {
  const response = await fetch(api + path, options);
  const body = await response.json() as { success: boolean; errors: unknown; result: T };
  if (!response.ok || !body.success) throw Error(`Cloudflare ${response.status}: ${JSON.stringify(body.errors)}`);
  return body.result;
}
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
let state: PreviewState;
if (process.argv.includes('--reuse')) {
  state = JSON.parse(await readFile(join(directory, 'credentials.json'), 'utf8'));
  if (Date.parse(state.account.expiresAt) <= Date.now()) throw Error('Temporary account has expired');
} else {
  console.log('Requesting temporary-account challenge');
  const { challengeToken, seed, k, g } = await json<Challenge>('/provisioning/previews/challenge', post({}));
  const seedBytes = Buffer.from(seed, 'base64url');
  if (seedBytes.length !== 32 || !Number.isInteger(k) || !Number.isInteger(g) || k <= 0 || g <= 0 || k * g > 64000000) throw Error('Invalid proof-of-work parameters');
  const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();
  let h = sha(seedBytes);
  const checkpoints = Buffer.alloc((k + 1) * 32);
  h.copy(checkpoints);
  console.log(`Solving ${k * g} SHA-256 steps`);
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < g; j++) h = sha(h);
    h.copy(checkpoints, (i + 1) * 32);
  }
  state = await json<PreviewState>('/provisioning/previews', post({ termsOfService: 'https://www.cloudflare.com/terms/', privacyPolicy: 'https://www.cloudflare.com/privacypolicy/', acceptTermsOfService: 'yes', challengeToken, solution: { checkpoints: checkpoints.toBase64() } }));
  if (!state.account?.id || !state.account.apiToken || !state.account.expiresAt || !state.claim?.url || !state.claim.expiresAt) throw Error('Incomplete temporary account response');
  await writeFile(join(directory, 'credentials.json'), JSON.stringify(state), { mode: 0o600 });
  await writeFile(join(directory, 'claim-url'), state.claim.url + '\n', { mode: 0o600 });
}
const name = 'tree-chic-wikipedia';
const generated = await readFile(new URL('generated.ts', import.meta.url), 'utf8');
const comparison = await readFile(new URL('comparison-generated.ts', import.meta.url), 'utf8');
const worker = await readFile(new URL('worker.ts', import.meta.url), 'utf8');
const source = stripTypeScriptTypes(comparison).replaceAll('export const ', 'const ') + stripTypeScriptTypes(generated).replaceAll('export const ', 'const ') + stripTypeScriptTypes(worker).replace("import { manifest, headerBase64 } from './generated.ts';", '').replace("import { comparisonLayouts } from './comparison-generated.ts';", '');
const form = new FormData();
form.append('metadata', new Blob([JSON.stringify({ main_module: 'worker.mjs', compatibility_date: '2026-10-31' })], { type: 'application/json' }));
form.append('worker.mjs', new Blob([source], { type: 'application/javascript+module' }), 'worker.mjs');
const headers = { Authorization: `Bearer ${state.account.apiToken}` };
await json(`/accounts/${state.account.id}/workers/scripts/${name}`, { method: 'PUT', headers, body: form });
await json(`/accounts/${state.account.id}/workers/scripts/${name}/subdomain`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
const { subdomain } = await json<{ subdomain: string }>(`/accounts/${state.account.id}/workers/subdomain`, { headers });
const deployment = { url: `https://${name}.${subdomain}.workers.dev`, expiresAt: state.account.expiresAt, claimExpiresAt: state.claim.expiresAt };
await writeFile(join(directory, 'deployment.json'), JSON.stringify(deployment, null, 2), { mode: 0o600 });
console.log(JSON.stringify(deployment, null, 2));
console.log('Private claim URL saved in the preview state directory; never publish it with the demo.');
