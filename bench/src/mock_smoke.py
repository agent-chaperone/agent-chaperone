"""Exercise run.py and score.py against a fake API so the live run cannot fail on parsing."""
import json, os, random, subprocess, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import httpx2  # vendored by the SDK
from typesafe_sdk import TypeSafeClient
import run

random.seed(1)

def handler(request):
    body = json.loads(request.content)
    answers = {}
    for k, q in body["questions"].items():
        if q["type"] == "noul":
            answers[k] = {"type": "noul", "noul": round(random.random(), 3)}
        elif q["type"] == "score":
            n = len(q["criteria"]); ps = [random.random() for _ in range(n)]; s = sum(ps); ps = [p / s for p in ps]
            answers[k] = {"type": "score", "score": round(sum(i * p for i, p in enumerate(ps)), 3), "legend": {str(i): c for i, c in enumerate(q["criteria"])}, "probabilities": {str(i): p for i, p in enumerate(ps)}, "confidence": 0.5}
    return httpx2.Response(200, json={"model": "jev-1.13.0", "answers": answers, "usage": {"input_tokens": len(request.content) // 4, "output_tokens": 10}})

client = TypeSafeClient(api_key="fake", model=run.MODEL, transport=httpx2.MockTransport(handler))
row = json.loads(next(open(run.SETS / "injecagent.jsonl")))
resp = client.system_one(row["state"], run.RESULT_BATTERY)
print("answers:", {k: (v.model_dump() if hasattr(v, "model_dump") else v) for k, v in resp.answers.items()})
print("usage:", resp.usage.model_dump(), "model:", resp.model)
