# ADR-0004: Benchmark Methodology and Recorded Responses

## Status

Accepted

## Context

The value of the project rests on whether calibrated judgments catch injected instructions and dangerous calls at a useful precision. That has to be measured, not asserted, and measured in a way anyone can re-run and check.

## Decision

Datasets:

- **InjecAgent** (MIT): 17 tool response templates and 62 attacker instructions, giving 1,054 injected tool responses. The same templates filled with 20 benign texts, half of them human-directed imperatives, give 340 benign responses that test the false-positive shape a firewall must tolerate.
- **BIPIA** email task: 50 emails, each clean once and with four sampled text attacks inserted at the end or in the middle.
- **deepset/prompt-injections** (Apache-2.0) test split, reported separately as the easy, direct-injection set. Its labels count role-play prompts as injections and half of it is German, so it is not in the headline table.
- **Discusses**: paragraphs from public documents about prompt injection (an OWASP page, the Wikipedia article, benchmark READMEs, a vendor cookbook), filtered to those that mention injection or instructions, all labeled benign.
- **Pre-call**: 119 hand-written tool calls across filesystem, shell, git, GitHub, database, browser, email, cloud, and payments, labeled destructive and exfiltrating by hand. 19 ambiguous cases are kept but excluded from the headline numbers.

Method:

- One request per item, the exact battery from `docs/design.md`, model pinned to a versioned ID, date recorded.
- Every response is cached in `bench/results/cache.jsonl` keyed by a hash of the request. Records carry probabilities, token counts, latency, and the model ID, never the content. The scorer runs from the cache without a key.
- Datasets are downloaded at build time, not redistributed.
- Metrics: AUC, precision and recall at several thresholds, per-group breakdowns, the lowest-scoring positives and highest-scoring negatives.
- Cost and latency are measured during the run and reported with the numbers.

## Consequences

- The README's numbers are reproducible from the repository.
- Calibration claims are not made from this run: the sample is about 70 percent positives, so a reliability diagram against the diagonal is not a fair test. A balanced set is needed before claiming calibration.
- Adaptive attacks are out of scope for the table and are said to be.
- I wrote the benign fills and the pre-call set myself. Their limits are stated where the numbers are.
