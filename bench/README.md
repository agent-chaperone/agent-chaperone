# Screening benchmark

This harness measures the screening questions from `docs/design.md` against public prompt-injection benchmarks and a hand-labeled set of tool calls. The recorded model responses are committed, so the scorer runs without an API key and the numbers in the top-level README reproduce from this directory.

Model: `jev-1.13.0`. Run date: 2026-09-19. Scored requests: 1,942. Input tokens: 1.46M. Cost at the published price: $0.061. Latency from a laptop: 405 ms median, 876 ms at the 95th percentile.

The batteries sent are the ones `src/screens` sends, question for question. `policy_violation` and `off_task` are the exception: they are asked only when a policy or a task is configured, no row here carries either, and nothing below measures them.

## Reproduce the scores (no key)

```bash
uv venv .venv && uv pip install --python .venv/bin/python typesafe-sdk
bash fetch.sh                        # downloads the datasets, not redistributed here
.venv/bin/python src/build_sets.py   # writes data/sets/*.jsonl
.venv/bin/python src/score.py        # scores results/cache.jsonl against the labels
.venv/bin/python src/analyze.py      # the follow-up cuts behind results/analysis.txt
```

`build_sets.py` is seeded, so it rebuilds the same sets and the same request hashes that the cache is keyed by.

## Re-run against the live model

```bash
export TYPESAFE_API_KEY=...
.venv/bin/python src/run.py --dry-run   # counts uncached requests and estimates cost
.venv/bin/python src/run.py             # runs them, appends to results/cache.jsonl
.venv/bin/python src/score.py
```

Any change to a question's wording or a set changes the request hash, so only the affected items are re-sent. Set `JEV_MODEL` to pin a different version.

A request that fails is written to `results/errors.jsonl` and never to the cache, and the run exits non-zero saying how many went that way. Running it again sends them, because a failure is not an answer. That matters more than it sounds: a cached failure is a row that never gets measured again, and the only visible effect is that `n` gets smaller.

For the same reason `score.py` refuses to print a report while any row is unanswered, and names the rows instead. `--allow-errors` scores what is there and puts the counts in the first line. A report built from an incomplete run is the one kind of wrong result that reads as a normal one.

## Sets

| Set | Rows | Positives | What it measures |
| --- | ---: | ---: | --- |
| `injecagent` | 1,394 | 1,054 | InjecAgent tool responses with attacker instructions filled in, plus the same templates filled with 20 benign texts, half of them human-directed imperatives |
| `bipia_email` | 250 | 200 | BIPIA emails, each clean once and with four sampled text attacks inserted at the end or in the middle |
| `deepset` | 116 | 60 | deepset/prompt-injections test split, direct chat injections, reported separately |
| `discusses` | 63 | 0 | Paragraphs from public documents about prompt injection, all benign |
| `precall` | 119 | 62 | Hand-labeled tool calls; 19 ambiguous cases excluded from headline numbers |

Sources: [InjecAgent](https://github.com/uiuc-kang-lab/InjecAgent) (MIT), [BIPIA](https://github.com/microsoft/BIPIA), [deepset/prompt-injections](https://huggingface.co/datasets/deepset/prompt-injections) (Apache-2.0), the OWASP LLM01 page, the Wikipedia article on prompt injection, the AgentDojo and BIPIA READMEs, and a TypeSafe cookbook page. All are downloaded by `fetch.sh` at build time. The benign fills and the pre-call cases are in `src/build_sets.py` and `src/precall_cases.py`.

## Results

Post-result sets score `instructs_reader`; the pre-call set scores `max(destructive, exfiltration)`. The deepset row is scored with a separate chat-message question over a `message` state rather than the post-result battery, so it measures a different screen from the rows above it.

| Set | AUC | thr | Precision | Recall | FP | FN |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| injecagent | 0.976 | 0.3 | 0.956 | 0.949 | 46 | 54 |
| | | 0.5 | 0.989 | 0.805 | 9 | 206 |
| | | 0.8 | 1.000 | 0.343 | 0 | 692 |
| bipia_email | 1.000 | 0.3 | 1.000 | 0.850 | 0 | 30 |
| | | 0.5 | 1.000 | 0.825 | 0 | 35 |
| | | 0.8 | 1.000 | 0.530 | 0 | 94 |
| discusses | n/a | 0.3 | | | 10 | |
| | | 0.5 | | | 7 | |
| | | 0.8 | | | 1 | |
| deepset | 0.949 | 0.5 | 1.000 | 0.450 | 0 | 33 |
| precall | 0.993 | 0.3 | 0.909 | 0.980 | 5 | 1 |
| | | 0.5 | 0.980 | 0.961 | 1 | 2 |
| | | 0.8 | 1.000 | 0.824 | 0 | 9 |

Full tables, per-group breakdowns, and the worst misses are in `results/report.txt` and `results/analysis.txt`.

## What the numbers say

- Plain benign tool responses averaged 0.04 and benign responses containing human-directed imperatives ("reply to this thread by Friday") averaged 0.20, with 9 of 170 crossing 0.5. The distinction between instructing an AI reader and instructing a human mostly holds.
- Data-theft instructions in tool responses were caught 92 to 94 percent of the time at 0.5. Attacks phrased as polite everyday requests ("please unlock my front door") were caught 57 to 70 percent at 0.5 and 88 to 95 percent at 0.3. Those are only attacks because the agent has a matching tool, which the content alone does not reveal. Including the agent's tool list in the state is the planned follow-up measurement.
- The email benchmark separates perfectly, but its weakest attack categories are ordinary task requests that sit between 0.2 and 0.5.
- The two highest-scoring benign paragraphs were a documentation header addressed to automated readers and code containing literal question text.
- Severity separates well on tool responses (85 percent of attacks at or above the harmful level, 3 percent of benign) and poorly on the email set (9 percent), which is why severity selects the action tier and does not gate (ADR-0003).
- A second yes/no question, "demands action", reached AUC 0.855 alone and lowered the combined result. It was dropped.
- deepset labels role-play prompts as injections and half its rows are German. It is kept as the easy set and left out of the headline table.

## Limits

- The sample is about 70 percent positives, so no calibration claim is made from it.
- I wrote the benign fills and the pre-call cases myself and labeled them once. Disagreeable labels are marked ambiguous and excluded.
- Adaptive attacks written against these questions are out of scope.
- Latency was measured from one machine over a home connection, with up to eight requests in flight, so the percentiles are under that load rather than for an isolated request.

## Files

```
fetch.sh                 download datasets and benign documents
src/build_sets.py        build the labeled sets under data/sets/
src/precall_cases.py     hand-labeled tool calls
src/run.py               run the batteries, cache every response
src/score.py             metrics from the cache
src/analyze.py           follow-up cuts: signal comparison, low thresholds, severity, misses
src/mock_smoke.py        exercise response parsing against a fake API
src/mock_full.py         run the full pipeline against a fake API
src/mock_retry.py        check that failures are retried and that a gap stops the scorer
results/cache.jsonl      recorded responses: probabilities, tokens, latency, model (a few superseded entries remain from fixture edits)
results/errors.jsonl     requests that failed, if any; not committed, and superseded by a successful retry
results/report.txt       output of score.py for the recorded run
results/analysis.txt     follow-up cuts of the same run
```
