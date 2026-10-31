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
area: "ART"
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

{{CHIC}} describe a chained hash integrity coding for HTTP. To allow for partial validation of an HTTP resource, using a merkle tree based construction seems more appropriate. It would allow for ranges, sending content out-of-order, while maintaining integrity and minimal overhead.

~~~aasvg
TODO
~~~
{: #figure-overview title="Overview of Format"}


# Conventions and Definitions

{::boilerplate bcp14-tagged}


# Security Considerations {#security}

TODO Security


# IANA Considerations {#iana}

This document has no IANA actions.


--- back

# Acknowledgments
{:numbered="false"}

TODO acknowledge.
