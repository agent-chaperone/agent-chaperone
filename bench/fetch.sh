#!/usr/bin/env bash
# Download the public datasets and the benign "discusses injection" documents.
# Nothing here is redistributed with the repository; run this before build_sets.py.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p data/injecagent data/bipia data/deepset data/discusses

IA=https://raw.githubusercontent.com/uiuc-kang-lab/InjecAgent/main/data
for f in user_cases.jsonl attacker_cases_dh.jsonl attacker_cases_ds.jsonl; do
  curl -fsSL "$IA/$f" -o "data/injecagent/$f"
done

BIPIA=https://raw.githubusercontent.com/microsoft/BIPIA/main/benchmark
curl -fsSL "$BIPIA/email/test.jsonl" -o data/bipia/email_test.jsonl
curl -fsSL "$BIPIA/text_attack_test.json" -o data/bipia/text_attack_test.json

DS='https://datasets-server.huggingface.co/rows?dataset=deepset%2Fprompt-injections&config=default&split=test'
curl -fsSL "$DS&offset=0&length=100" -o data/deepset/rows_test_0.json
curl -fsSL "$DS&offset=100&length=100" -o data/deepset/rows_test_100.json

curl -fsSL https://raw.githubusercontent.com/OWASP/www-project-top-10-for-large-language-model-applications/main/2_0_vulns/LLM01_PromptInjection.md -o data/discusses/owasp-llm01.md
curl -fsSL 'https://en.wikipedia.org/w/index.php?title=Prompt_injection&action=raw' -o data/discusses/wikipedia-prompt-injection.txt
curl -fsSL https://docs.typesafe.ai/cookbooks/llm_guardrails.md -o data/discusses/typesafe-guardrails.md
curl -fsSL https://raw.githubusercontent.com/ethz-spylab/agentdojo/main/README.md -o data/discusses/agentdojo-readme.md
curl -fsSL https://raw.githubusercontent.com/microsoft/BIPIA/main/README.md -o data/discusses/bipia-readme.md

wc -c data/*/* | tail -1
