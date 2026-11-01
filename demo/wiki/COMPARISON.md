# Variable-length tree comparison

Measured 2026-10-31T22:06:40.428Z. This is a small deployment experiment, not a general
performance benchmark. [Raw live results](comparison-live.json) contain all
54 runs and byte-range traces; [local results](comparison-local.json) record
the deterministic byte/request counts.

## Setup

- Same 206,518,721-byte prefix of the 2026-10-01 Simple English Wikipedia dump.
- Same 2,733 variable-length chunks for every layout: complete bzip2 streams.
  Chunk lengths: minimum 552 bytes, median 71,550, p95 131,007, maximum 509,781.
- Binary, 16-way, and 64-way trees. Each branch's ordered child length/hash
  records occupy one contiguous range. Grouping changes logical fanout here;
  this does not test a packed binary tree with the same logical hashes.
- Same temporary Cloudflare Worker, same upstream source/mirror policy.
  Only metadata is hosted on Cloudflare; payload is proxied from a dump server.
- Four article streams plus two ranges extending 33 bytes across both stream
  boundaries. Three live repetitions each, rotating layout order.
- Each read starts without cached client metadata. Only the trusted root and
  requested byte interval are supplied locally; no leaf indices or boundary
  table are supplied. The reader navigates using authenticated subtree lengths.
- Timings include verified byte retrieval, excluding decompression. Article
  streams are subsequently decompressed and checked for the requested title.
  All layouts returned identical bytes for each workload.

## Results

| Workload | Fanout | Metadata bytes | Payload bytes | Requests | Dependency rounds | Median ms (min–max) |
|---|---:|---:|---:|---:|---:|---:|
| Paris | 2 | 1,032 | 303,037 | 14 | 14 | 590 (580–1396) |
| Paris | 16 | 1,992 | 303,037 | 5 | 5 | 330 (265–367) |
| Paris | 64 | 5,192 | 303,037 | 4 | 4 | 249 (240–316) |
| Cryptography | 2 | 1,032 | 103,022 | 14 | 14 | 495 (478–507) |
| Cryptography | 16 | 1,992 | 103,022 | 5 | 5 | 247 (239–310) |
| Cryptography | 64 | 5,192 | 103,022 | 4 | 4 | 211 (206–211) |
| Wikipedia | 2 | 1,032 | 91,070 | 14 | 14 | 504 (489–603) |
| Wikipedia | 16 | 1,992 | 91,070 | 5 | 5 | 257 (239–333) |
| Wikipedia | 64 | 5,192 | 91,070 | 4 | 4 | 216 (215–248) |
| Kettering, Ohio | 2 | 1,032 | 58,400 | 14 | 14 | 494 (482–499) |
| Kettering, Ohio | 16 | 1,992 | 58,400 | 5 | 5 | 234 (233–244) |
| Kettering, Ohio | 64 | 5,192 | 58,400 | 4 | 4 | 213 (204–213) |
| Paris (cross boundaries) | 2 | 1,112 | 704,702 | 15 | 14 | 698 (662–768) |
| Paris (cross boundaries) | 16 | 1,992 | 704,702 | 5 | 5 | 360 (327–464) |
| Paris (cross boundaries) | 64 | 5,192 | 704,702 | 4 | 4 | 438 (313–523) |
| Kettering, Ohio (cross boundaries) | 2 | 1,112 | 156,997 | 15 | 14 | 520 (485–534) |
| Kettering, Ohio (cross boundaries) | 16 | 1,992 | 156,997 | 5 | 5 | 245 (234–247) |
| Kettering, Ohio (cross boundaries) | 64 | 5,192 | 156,997 | 4 | 4 | 223 (212–237) |

Bytes are response-body bytes: HTTP header and TLS overhead are excluded.
Manifest/title lookup is supplied locally and excluded equally for every layout.
For a single-stream article there is one request per dependency round; in the
binary cross-boundary cases two proof reads can share one round.

## Storage and buffering

| Fanout | Total stored header bytes | Single-stream peak proof batch | Tree depth |
|---|---:|---:|---:|
| 2 | 327,672 | 80 | 12 |
| 16 | 174,792 | 640 | 3 |
| 64 | 166,472 | 2,560 | 2 |

All candidates pad to 4,096 leaf slots for this dataset. Padding to the next
power of fanout can be much more expensive at other leaf counts, so these
storage numbers do not establish a general size advantage for wider trees.

The current reader buffers the whole covering payload interval before
verification. That is 58,400 bytes for Kettering and 303,037 for Paris, regardless
of fanout; cross-boundary Paris buffers 704,702 bytes. These are actual
implementation buffer sizes, not minimum requirements: a streaming reader could
verify and release chunks individually. The proof-batch metric excludes retained
node descriptors, runtime overhead, and decompression memory.

## Implications for the draft

1. Authenticated subtree lengths support byte-range navigation with real
   variable-length chunks. No trusted leaf-index mapping was needed. This is
   evidence for the proposed navigation mechanism, not a cryptographic proof.
2. Reading a wider child-record group trades a few kilobytes for fewer dependent
   requests. For one stream, 16-way spends 960 extra metadata bytes relative
   to binary and saves nine rounds; 64-way spends 3,200 more than 16-way and
   saves one additional round. Both wider layouts beat binary on every tested
   workload's median; 64-way was not fastest on every workload.
3. A 16-way layout is a reasonable next reference implementation: it captures
   most of the round reduction with less metadata than 64-way. This experiment
   does not establish an optimal or mandatory fanout.
4. Chunk policy and tree fanout are separate choices. Aligning chunks to bzip2
   streams eliminates integrity-chunk overfetch for exact-stream reads, but
   bytes for other articles in that stream remain. The cross-boundary cases
   show the downside for arbitrary ranges. Grouping cannot fix that overfetch.
5. The draft should make serialization and navigation concrete: how a verified
   node locates the next contiguous record group, what authenticates the byte
   lengths and payload offset, and how ranges cutting through chunks are
   verified. The prototype commits the bootstrap and root record together.

## Limits and next controls

The reader waits for verified navigation before fetching payload; it does not
use speculative reads, a leaf locator, coalesced binary subtrees, or cached
metadata. These are policy-dependent request counts, not a lower bound on binary
trees. In particular, untrusted leaf-index hints could enable parallel proof
fetching if the client subsequently verifies position and coverage. Such hints
need not enlarge the trust boundary, though they add an indexing interface.

Upstream/CDN caches and connection state were not reset. Layout order rotates,
but three samples cannot characterize network variance; the first Paris binary
read was notably slower. The results cover one network path and one dataset
size. They do not test complete sequential delivery, content-coding composition,
HTTP digest-field semantics, publisher signatures, or freshness.

Useful next controls are packed binary metadata or untrusted locator hints,
warm-client metadata reuse, and a chunk policy that caps large stream chunks
without losing too much alignment. Those should precede freezing the wire format.
