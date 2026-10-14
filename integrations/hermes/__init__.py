"""agent-chaperone for Hermes Agent.

Hermes runs a shell hook's answer to ``pre_tool_call``, so a call can be refused
or put in front of the person without this plugin. A result cannot: Hermes
ignores what a ``post_tool_call`` hook prints, and only a plugin's
``transform_tool_result`` can change what the model reads. So both sides live
here, and each one hands the call to ``agent-chaperone hook pre|post`` and does
what it answers.

Every failure lets the call through, the same as the Claude Code plugin: a
missing command, a crash, a timeout or an answer that does not parse is not a
judgment. The timeout stays under the bound Hermes puts on a plugin callback,
because past it Hermes refuses the call outright.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from typing import Any, Dict, Optional

# Kept identical to HERMES_PRE_TOOLS and HERMES_POST_TOOLS in src/hooks/clients.ts.
# Checked here so that a tool nobody screens does not start a process.
PRE_TOOLS = frozenset({
    "terminal",
    "process_manage",
    "write_file",
    "patch",
    "execute_code",
    "web_extract",
    "browser_navigate",
    "browser_exec",
    "browser_cdp",
})

POST_TOOLS = frozenset({
    "terminal",
    "process_manage",
    "read_file",
    "search_files",
    "web_search",
    "web_extract",
    "execute_code",
    "browser_snapshot",
    "browser_console",
    "browser_exec",
})

# Hermes refuses a call whose pre_tool_call callback runs past 30 seconds.
TIMEOUT_SECONDS = 25


def _command() -> Optional[str]:
    return os.environ.get("AGENT_CHAPERONE_BIN") or shutil.which("agent-chaperone")


def _ask(side: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    command = _command()
    if command is None:
        return None
    try:
        done = subprocess.run(
            [command, "hook", side, "--client", "hermes"],
            input=json.dumps(payload, default=str),
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    text = done.stdout.strip()
    if not text:
        return None
    try:
        answer = json.loads(text)
    except ValueError:
        return None
    return answer if isinstance(answer, dict) else None


def _payload(event: str, tool_name: str, args: Any, session_id: str) -> Dict[str, Any]:
    return {
        "hook_event_name": event,
        "tool_name": tool_name,
        "tool_input": args if isinstance(args, dict) else None,
        "session_id": session_id or "",
        "cwd": os.getcwd(),
    }


def on_pre_tool_call(tool_name: str = "", args: Any = None, session_id: str = "", **_: Any) -> Optional[Dict[str, Any]]:
    if tool_name not in PRE_TOOLS:
        return None
    answer = _ask("pre", _payload("pre_tool_call", tool_name, args, session_id))
    if answer is None:
        return None
    if answer.get("decision") == "block":
        reason = answer.get("reason")
        return {"action": "block", "message": reason if isinstance(reason, str) and reason else "Blocked by agent-chaperone."}
    if answer.get("action") == "approve":
        directive: Dict[str, Any] = {"action": "approve"}
        for key in ("message", "rule_key"):
            value = answer.get(key)
            if isinstance(value, str) and value:
                directive[key] = value
        return directive
    return None


def on_transform_tool_result(
    tool_name: str = "", args: Any = None, result: Any = None, session_id: str = "", status: str = "", **_: Any
) -> Optional[str]:
    # A multimodal result arrives as a dict, and is left as it came.
    if tool_name not in POST_TOOLS or not isinstance(result, str):
        return None
    payload = _payload("post_tool_call", tool_name, args, session_id)
    payload["extra"] = {"result": result, "status": status or ""}
    answer = _ask("post", payload)
    if answer is None:
        return None
    replaced = answer.get("result")
    base = replaced if isinstance(replaced, str) else result
    context = answer.get("context")
    if isinstance(context, str) and context:
        return f"{base}\n\n{context}"
    return base if isinstance(replaced, str) else None


def register(ctx: Any) -> None:
    ctx.register_hook("pre_tool_call", on_pre_tool_call)
    ctx.register_hook("transform_tool_result", on_transform_tool_result)
