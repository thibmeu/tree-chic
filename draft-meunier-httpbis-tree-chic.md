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
 - blockchain
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
  CHIC: I-D.draft-thomson-httpbis-chic

...

--- abstract

This describes a content-coding for HTTP that enables progressive processing of content, with ranges, without sacrificing integrity.


--- middle

# Introduction {#intro}

{{CHIC}} splits content into chunks. Each non-final chunk carries the hash
of the next. Verification follows the chain from the first chunk. Starting
from its hash, reading a later range requires verifying the preceding chunks.

This document replaces the chain with a Merkle tree. A trusted root hash
and a proof allow a recipient to verify a chunk without reading earlier
content. Chunks can be read sequentially, by range, or out of order.

- Variable-length chunks, as in {{CHIC}}. Boundaries can follow application
  needs, such as progressive image rendering.
- Subtree content lengths authenticate chunk positions in the byte stream.
- Precompute and store the tree with the content. Serve both from ordinary
  object storage, such as S3, using range requests. No server-generated proofs.
- Share proof hashes across chunks. TODO: overhead and verifier state.
- Finish the content before publishing the root hash, as with CHIC.

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
hash; verify branches before trusting their child hashes and content lengths.
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

TODO: header length, chunk size, and tree depth limits; verifier buffering.


# HTTP Usage

## Content-Coding

Use `tree-chi` as a placeholder content-coding name.

## Digest Format

Use `tree-chi` as a placeholder digest algorithm name. Value: root hash.

TODO: interaction with Content-Digest and Repr-Digest for partial responses.

## Example

Full response, following the header layout in {{CHIC}}.
Angle-bracket values are placeholders, not valid wire syntax.

~~~http-message
HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Encoding: tree-chi
Content-Length: <encoded length>
Content-Digest: tree-chi=:<base64 root hash>:
Accept-Ranges: bytes
~~~

Range retrieval from the stored encoding:

~~~http-message
GET /object HTTP/1.1
Host: example.com
Range: bytes=<start>-<end>
~~~

~~~http-message
HTTP/1.1 206 Partial Content
Content-Type: application/octet-stream
Content-Encoding: tree-chi
Content-Range: bytes <start>-<end>/<encoded length>
Content-Length: <range length>
~~~

The recipient already holds the trusted root. Additional ranges may be
needed for tree header records. These offsets address the stored encoding,
including the length prefix and tree header.

TODO: define decoding of partial responses.


# Security Considerations {#security}

TODO Security


# IANA Considerations {#iana}

TODO: content-coding and digest algorithm registrations.


--- back

# Acknowledgments
{:numbered="false"}

TODO acknowledge.
