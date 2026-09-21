"""Check that a failed request is retried, and that a gap stops the scorer.

A failure used to be appended to the response cache, and the runner picked work
with "is this key in the cache", so the row counted as done and was never sent
again. The scorer then skipped it and printed a smaller n. Nothing in that chain
says anything is wrong: a run reports success, a report looks ordinary, and the
published count quietly shrinks. One expired key is enough to do it.

Both halves are checked here. The runner has to offer a failed row again, and
the scorer has to refuse to print a report while anything is unanswered.

    .venv/bin/python src/mock_retry.py
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import run  # noqa: E402

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
failures = 0


def check(what, got, want):
    global failures
    if got == want:
        print(f"  ok    {what}")
        return
    failures += 1
    print(f"  FAIL  {what}: got {got!r}, wanted {want!r}")


ANSWER = {"key": "k", "id": "row-1", "answers": {}}
ERROR = {"key": "k", "id": "row-1", "error": "TypeSafePermissionDeniedError('403')"}

check("a success counts as answered", run.answered({"k": ANSWER}, "k"), True)
check("a failure does not", run.answered({"k": ERROR}, "k"), False)
check("a key with nothing behind it does not", run.answered({}, "k"), False)

# load_cache keeps the last line for a key, so a retry supersedes an older
# failure without anything having to go back and clean the file up.
with tempfile.TemporaryDirectory() as tmp:
    doctored = Path(tmp) / "cache.jsonl"
    doctored.write_text(json.dumps(ERROR) + "\n" + json.dumps(ANSWER) + "\n")
    was, run.CACHE = run.CACHE, doctored
    check("a later success supersedes the failure", run.answered(run.load_cache(), "k"), True)
    run.CACHE = was

# The scorer, against a cache with one answer replaced by a failure.
real = ROOT / "results/cache.jsonl"
if not real.exists():
    print("  skip  scorer checks: results/cache.jsonl is not there to copy")
else:
    # The cache carries entries for requests no current row asks for any more, so
    # the row to break has to be one the sets actually key to. Doctoring an
    # arbitrary line tests nothing: the scorer would never look it up.
    live = None
    for line in (ROOT / "data/sets/injecagent.jsonl").open():
        row = json.loads(line)
        live = run.req_key(row["state"], run.battery_for(row))
        break

    with tempfile.TemporaryDirectory() as tmp:
        doctored = Path(tmp) / "cache.jsonl"
        lines = []
        for line in real.read_text().splitlines():
            entry = json.loads(line)
            if entry["key"] == live:
                entry = {
                    "key": live,
                    "id": entry["id"],
                    "error": "deliberate, from mock_retry.py",
                }
                line = json.dumps(entry)
            lines.append(line)
        doctored.write_text("\n".join(lines) + "\n")
        env = {**os.environ, "BENCH_CACHE": str(doctored)}

        stopped = subprocess.run(
            [sys.executable, str(HERE / "score.py")], env=env, capture_output=True, text=True
        )
        check("the scorer stops on a gap", stopped.returncode, 1)
        check("and names the row", "deliberate, from mock_retry.py" in stopped.stderr, True)
        check("and prints no report", stopped.stdout.strip(), "")

        anyway = subprocess.run(
            [sys.executable, str(HERE / "score.py"), "--allow-errors"],
            env=env,
            capture_output=True,
            text=True,
        )
        check("it scores anyway when asked", anyway.returncode, 0)
        check("and the report counts the error", ", 1 errors, " in anyway.stdout, True)

print("mock_retry: all checks passed" if failures == 0 else f"mock_retry: {failures} failed")
sys.exit(1 if failures else 0)
