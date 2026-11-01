---
title: "Tree-based Chained Hash Integrity Coding for HTTP"
abbrev: "Tree CHIC"
category: std

docname: draft-meunier-httpbis-tree-chic-latest
submissiontype: IETF
number:
date:
consensus: true
v: 3
area: "Web and Internet Transport"
workgroup: "HTTP"
keyword:
 - tree
venue:
  group: "HTTP"
  mail: "ietf-http-wg@w3.org"
  arch: "https://lists.w3.org/Archives/Public/ietf-http-wg/"
  github: "thibmeu/tree-chic"
  latest: "https://thibmeu.github.io/tree-chic/draft-meunier-httpbis-tree-chic.html"

author:
 -
    fullname: Thibault
    organization: Cloudflare
    email: ot-ietf@thibault.uk

normative:

informative:
  HTTP: RFC9110
  DIGEST: RFC9530
  CHIC: I-D.draft-thomson-httpbis-chic

...

--- abstract

This document describes a content-coding for HTTP that supports progressive
integrity verification and verification of selected ranges.


--- middle

# Introduction {#intro}

{{CHIC}} splits content into chunks. Each non-final chunk carries the hash
of the next. A recipient that starts with the first hash follows this chain
to verify the content. Verifying a later chunk requires reading the earlier
chunks.

This document replaces the chain with a Merkle tree. A trusted root hash
and a proof allow a recipient to verify a chunk without reading earlier
content. Chunks can be read sequentially, by range, or out of order.

The sender computes the tree in advance and stores it with the content.
The server serves byte ranges of this encoded representation without
constructing proofs for individual requests.

# Example {#example}

A client wants one article from a Wikipedia archive. The archive consists
of independently compressed streams, with an index that locates the stream
containing each article. The client has a trusted root hash for the archive
encoded with the `tree-chi` content coding.

In this example, the encoded representation is 1,004,096 bytes long. Its
length prefix and tree occupy the first 4,096 bytes. The compressed archive
follows unchanged. These sizes are illustrative.

The client first requests the beginning of the encoded representation:

~~~http-message
GET /wikipedia.xml.bz2 HTTP/1.1
Host: example.com
Accept-Encoding: tree-chi
Range: bytes=0-4095
~~~

~~~http-message
HTTP/1.1 206 Partial Content
Content-Type: application/octet-stream
Content-Encoding: tree-chi
Content-Range: bytes 0-4095/1004096
Content-Length: 4096
ETag: "wiki-tree-1"
Vary: Accept-Encoding

[4096 bytes containing the length prefix and tree]
~~~

The client verifies the tree against its trusted root. The article index
locates a compressed stream at archive offsets 65,536 through 98,303.
That stream is also one chunk of the coding. The verified tree establishes
its position, length, and expected hash.

Byte ranges address the encoded representation ({{Section 14.1.2 of HTTP}}).
Adding the 4,096-byte prefix gives the range 69,632 through 102,399:

~~~http-message
GET /wikipedia.xml.bz2 HTTP/1.1
Host: example.com
Accept-Encoding: tree-chi
If-Match: "wiki-tree-1"
Range: bytes=69632-102399
~~~

~~~http-message
HTTP/1.1 206 Partial Content
Content-Type: application/octet-stream
Content-Encoding: tree-chi
Content-Range: bytes 69632-102399/1004096
Content-Length: 32768
ETag: "wiki-tree-1"
Vary: Accept-Encoding

[32768 bytes containing the compressed stream]
~~~

Using the retained tree, the client verifies the chunk, decompresses the
stream, and extracts the article. This retrieves 36,864 bytes of the encoded
representation. The compressed stream can contain other articles, but the
client does not need the rest of the archive.

The If-Match header field ({{Section 13.1.1 of HTTP}}) makes the second
request conditional on the same representation. The trusted root provides
the integrity check.

For a larger tree, the client could retrieve only the records needed for
the selected chunks. A full response carries the tree followed by the
archive, allowing the client to verify chunks as they arrive.

## Comparison with CHIC

Both codings require a particular encoded representation. Starting with
only the initial hash, CHIC requires the preceding chunks to verify a
selected range. Tree CHIC uses tree records to verify that range without
retrieving the preceding content.

# Format Overview

Chunks can have different lengths. Branches commit to the lengths and
hashes of their children. This lets a reader verify a chunk and its position
in the content. As with {{CHIC}}, construction requires the complete content.

Lengths and hashes sit in a tree header before the content. The content
bytes stay contiguous, with no framing between chunks. A header length
allows a reader to skip the tree and locate the content.

The tree header contains records of this form (tags omitted):

~~~aasvg
                           Root hash
                               ^
                              Hash
                               |
                 +---------------+---------------+
                 | Len L, Hash L | Len R, Hash R |
                 +---------------+---------------+
                       /               \
                     Hash              Hash
                      |                 |
          +----------+----------+ +----------+----------+
          | Len 0,H0 | Len 1,H1 | | Len 2,H2 | Len 3,H3 |
          +----------+----------+ +----------+----------+
                |           |           |           |
               Hash        Hash        Hash        Hash
                |           |           |           |
             Chunk 0     Chunk 1     Chunk 2     Chunk 3
~~~
{: #figure-tree title="Tree Header (Logical Structure)"}

On the wire:

~~~aasvg
  +------------+----------------+----~~~~----+----~~~~----+
  | Header Len | Tree Header    |  Chunk 0   |  Chunk 1 ...|
  +------------+----------------+----~~~~----+----~~~~----+
  <-- First byte                              Last byte -->
                                <-- Continuous content -->
~~~
{: #figure-overview title="Overview of Format"}

- Header length counts tree header bytes, excluding the length field itself.
- Length beside a hash counts content bytes covered by that hash.
- A sequential reader receives the tree header before the first chunk.

TODO: node encoding and layout that keeps proof retrieval to a few requests.


# Conventions and Definitions

{::boilerplate bcp14-tagged}


# Chained Hash Integrity Format

## Format Description

- Encoding: header length, tree header, original content bytes.
- Tree header: branch records with a content length beside each child hash.
- Leaf hashes cover chunks in the continuous content region.
- Branch hashes commit to child lengths as well as child hashes.
- Root hash carried outside the content.

TODO: tagged hash inputs, tree shape, header-length commitment, and compact
proof encoding. Skipping a branch record needs an encoded size or a layout
from which that size can be derived.

## Consumption and Validation

Read the header length and parse the tree header. Start with a trusted root
hash. Verify branches before trusting their child hashes and content lengths.
Use the lengths to split the content into chunks. Verify each chunk before
releasing it.

For a range, retrieve the covering chunks and the required header records.
Content offsets are sums of preceding chunk lengths. Stored offsets add the
length field size and tree header length.

TODO: partial header retrieval and ranges that cut through chunks.

## Construction

Split content into chunks. Hash leaves, then branches, up to the root.
Chunks can be hashed independently. Write the header length and tree header,
then copy the original content unchanged.

TODO: order of records within the tree header and index for range retrieval.

## Length Constraints

TODO: header length, chunk size, tree depth, and verifier buffering limits.


# HTTP Usage

## Content-Coding

Use `tree-chi` as a placeholder content-coding name.

## Digest Format

Use `tree-chi` as a placeholder digest algorithm name, with the root hash
as its value. Following {{CHIC}}, this could be carried in Content-Digest
or Repr-Digest ({{DIGEST}}).

TODO:

- Define the digest calculation and value encoding.
- Define its meaning in Content-Digest and Repr-Digest, including for
  partial responses.
- Define which bytes it covers when other content codings are applied.
- Describe how the recipient obtains a trusted value. The example in
  {{example}} assumes it already has one.

## Compression

Content-Encoding can list multiple codings in the order they were applied
({{Section 8.4 of HTTP}}). For example, `Content-Encoding: gzip, tree-chi`
applies gzip first, then this coding. The recipient verifies the compressed
chunks while removing the tree coding, then decompresses them.

The order `Content-Encoding: tree-chi, gzip` compresses the tree and content
together. The recipient decompresses before verifying. Byte ranges then
address that outer compressed representation, so the offsets in
{{example}} would no longer apply.

Neither order makes a gzip stream independently decompressible at arbitrary
offsets. The archive in {{example}} already has independently compressed
streams. A client can decompress a selected stream after verifying its
bytes. This compression is part of the archive format.


# Security Considerations {#security}

TODO Security


# IANA Considerations {#iana}

TODO: content-coding and digest algorithm registrations.


--- back

# Acknowledgments
{:numbered="false"}

TODO acknowledge.
