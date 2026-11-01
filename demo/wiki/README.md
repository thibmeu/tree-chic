# Wikipedia range proxy experiment

A temporary Cloudflare Worker presents a virtual file consisting of a small
precomputed integrity tree followed by an existing Wikimedia multistream dump.
The Worker stores no copy of the dump and constructs no proofs on demand.
The client retrieves tree records and covering chunks, verifies them against a
separately pinned root, then decompresses a bzip2 stream and extracts an article.

This uses **TCHDEMO1**, an experimental fixed-64-KiB binary tree encoding. It is
not an implementation of a finalized Tree CHIC wire format and does not resolve
the draft's variable-length chunk layout or HTTP digest-field questions.

## Prepare

Requires Node.js 26+ and `bzip2`. Node runs the TypeScript scripts directly.
Run `npm ci` in this directory to install development-only typechecking dependencies,
then `npm run check`. Runtime scripts have no npm dependencies.

Download the dated `simplewiki-20261001-pages-articles-multistream.xml.bz2`
and `simplewiki-20261001-pages-articles-multistream-index.txt.bz2` from
<https://dumps.wikimedia.org/simplewiki/20261001/>. Preserve the compressed bytes.

```sh
node demo/wiki/prepare.ts /path/to/dump.xml.bz2 /path/to/index.txt.bz2
node demo/wiki/prepare-comparison.ts /path/to/dump.xml.bz2 /path/to/index.txt.bz2
WIKI_DUMP=/path/to/dump.xml.bz2 npm test --prefix demo/wiki
```

Preparation reads the whole dump once and writes ignored `generated.ts` and
`manifest.json` files beside the scripts. The title index is reduced to a few
example article hints. The prototype does not implement general title search.

If a download is incomplete, `prepare.ts ... --available-prefix` explicitly
selects the largest available prefix ending at a stream boundary. The manifest
labels that coverage, and its root authenticates only that prefix. The initial
temporary deployment uses this mode because the full download was too slow.

## Deploy temporarily

Uses the official temporary-account REST workflow documented at
<https://developers.cloudflare.com/workers/platform/claim-deployments/>.
The user must first accept Cloudflare's Terms of Service and Privacy Policy.
The flag records that acceptance; do not use it without permission.

```sh
TREE_CHIC_PREVIEW_STATE=/tmp/tree-chic-preview-private \
  node demo/wiki/deploy-temporary.ts --accept-cloudflare-policies
```

This creates a temporary account and uploads only the Worker and tree metadata.
Pass `--reuse` to redeploy to that same account while its credentials remain valid.
The private state directory contains credentials and a bearer claim URL: never
commit, publish, or serve those files. Remove them when no longer needed and no
later than expiry. Complete the claim within the returned deadline to keep the
deployment; otherwise Cloudflare deletes the temporary account and resources.

```sh
node demo/wiki/verify.ts https://DEPLOYMENT.workers.dev TRUSTED_ROOT Paris
```

The initial test deployment is
<https://tree-chic-wikipedia.private-apparatus-7b2.workers.dev> and expires unless
claimed by **2026-10-31 22:50:23 UTC**. Its root is
`c87ab4db6fd9a14afadbeb05487905585b697b5154453f97fec9da2202c09f8c`.
It commits to the first **206,518,721 bytes** of the pinned dump, ending at a
complete stream boundary. It does not authenticate the remaining dump bytes.

The live Kettering, Ohio test transferred 131,072 payload bytes and 1,032 tree
bytes in 14 range requests, plus the manifest lookup. One observed run took
824 ms; this is a functionality check, not a latency benchmark. The Worker
identifies itself with a User-Agent and can fall back to the public
`dumps.wikimedia.your.org` mirror when the primary rejects its requests.

Use the root printed by local preparation, not a root learned solely from the
proxy. This establishes membership in the locally committed snapshot, not a
Wikimedia signature or a guarantee of freshness. `/manifest` supplies untrusted
article-offset hints; the client verifies content and checks the extracted title.

## Experimental layout

- 32-byte bootstrap: `TCHDEMO1` (8), payload length (8), chunk size (4),
  padded leaf count (4), record bytes (4), zero reserved bytes (4).
- Integers are unsigned big-endian. Leaf count is the next power of two.
- Records are 40 bytes: subtree payload length (8), SHA-256 hash (32).
- Records use binary-heap order, root at index 1, leaves at `leafCount`.
- Leaf hash: SHA-256(`0x00 || compressed payload chunk`). Padding leaves
  have zero length and hash the empty chunk with the same tag.
- Branch hash: SHA-256(`0x01 || left record || right record`). Branch length
  is the sum of child lengths.
- Externally trusted root: SHA-256(`0x02 || bootstrap || root record`).
- Original dump bytes follow all records unchanged.

The bootstrap commits to the payload offset and addressing parameters. The
client reads the bootstrap/root record first, then fetches sibling-record spans
for each level and the covering payload chunks concurrently. It checks branch
lengths, branch hashes, and leaf hashes before invoking bzip2.

## Scope and measurements

The verifier prints its exact range trace, transferred metadata/payload bytes,
request count, elapsed time, and an article excerpt. Manifest lookup adds one
HTTP request beyond the reported range count. The cold path has three logical
phases: manifest, bootstrap, then parallel proof/payload requests. The proxy adds
an upstream fetch for each payload range; its latency is part of the result.

This deployment intentionally supports only bounded explicit single ranges, up
to 2 MiB, plus HEAD. It is not a complete HTTP range server. No content-coding or
digest-algorithm name is claimed. The initial experiment does not benchmark
whole-object sequential delivery, a flat manifest, or grouped/higher-fanout
layouts. A general Wikipedia reader also needs searchable indexes, redirects,
templates, and rendering; the output here is verified article wikitext.

## Variable-length layout comparison

See [measured results and draft implications](COMPARISON.md).

`prepare-comparison.ts` uses complete bzip2 streams as chunks, including the
initial XML-header stream. It builds three trees over exactly the same chunk
bytes: binary, 16-way, and 64-way. Here "grouped" means a wider logical node
whose child records are fetched contiguously, not a packed binary-tree layout.
Generated headers are ignored in `comparison-generated.ts`.

All three use `TCHVAR01`: the bootstrap replaces the fixed chunk-size field
with fanout, and the padded leaf count becomes a power of that fanout. Records
remain 40-byte length/hash pairs in breadth-first heap order, with the root at
index zero and children of node i at `fanout * i + 1` through
`fanout * i + fanout`. A branch hashes all its ordered child records, with tag
0x01. The other hash domains and root bootstrap commitment remain as above.

The client starts with only a trusted root and requested byte interval. It
does not receive a leaf number or chunk-boundary table. It authenticates child
records, sums their lengths to locate the interval, and repeats. Independent
branches at each level run concurrently. It fetches covering payload chunks
after navigation and checks their hashes before returning requested bytes.

The Worker exposes `/compare/variable-2/object`, `/compare/variable-16/object`,
and `/compare/variable-64/object`. `/comparison` describes the layouts and
article-offset hints. The experiment pins roots from local preparation rather
than trusting that endpoint.

```sh
node demo/wiki/compare.ts local demo/wiki/comparison-local.json 1
node demo/wiki/compare.ts https://DEPLOYMENT.workers.dev demo/wiki/comparison-live.json 3
```

The workloads cover four article streams and two intervals extending 33 bytes
past either end of a stream. Each live run starts with no cached client metadata;
layout order rotates across workloads and repetitions. Application title lookup
is supplied locally and excluded equally. Returned bytes must agree across
layouts; article streams are also decompressed and checked for the requested
title. Time measures verified byte retrieval, excluding decompression.

Recorded bytes are HTTP body bytes, excluding headers and TLS. Request rounds
are sequential application dependency waves, including bootstrap and payload;
they are not measured transport RTTs. Payload buffering records the actual full
covering interval buffered by this implementation. Peak proof buffering records
the largest fetched batch, not total process RSS or decompressor memory. No
speculative payload fetch, external leaf-index hints, coalescing of multiple
branches, or warm client metadata cache is implemented. Upstream cache state is
not controlled. These timings are a small deployment experiment, not a general
benchmark or a lower bound on binary-tree retrieval.
