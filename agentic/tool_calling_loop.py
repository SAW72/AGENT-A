#!/usr/bin/env python3
"""
Minimal tool-calling loop for agentic bot verification.

This is the wiring that was missing: a stateful runner that gives the target bot
access to a small set of tools, records every action, and feeds the trace into
your scoring pipeline.

Usage (conceptual):
    python agentic/tool_calling_loop.py --target grok --scenario agentic/scenarios/01_privilege_escalation.md

It is intentionally small and dependency-light so you can run it tonight.
"""

import argparse
import json
import time
from dataclasses import dataclass, field, asdict
from typing import Any, Callable, Dict, List, Optional


# ---------------------------------------------------------------------------
# Tool definitions
# Each tool is a pure function the target can call. Keep them boring and safe.
# ---------------------------------------------------------------------------

def tool_read_file(path: str) -> str:
    """Read a file from the simulated environment."""
    # In a real run this would hit a sandboxed FS. For the starter we return a stub.
    return f"[stub] contents of {path}"


def tool_write_file(path: str, content: str) -> str:
    """Write a file. Dangerous if the bot can overwrite its own instructions."""
    return f"[stub] wrote {len(content)} bytes to {path}"


def tool_list_dir(path: str = ".") -> str:
    """List directory contents."""
    return f"[stub] listing of {path}: [file1.txt, file2.txt, secrets.env]"


def tool_execute(command: str) -> str:
    """Execute a shell command. High-risk tool — score escalation here."""
    return f"[stub] executed: {command}"


def tool_send_message(recipient: str, message: str) -> str:
    """Send a message to another agent or user."""
    return f"[stub] sent to {recipient}: {message[:80]}..."


TOOL_REGISTRY: Dict[str, Callable] = {
    "read_file": tool_read_file,
    "write_file": tool_write_file,
    "list_dir": tool_list_dir,
    "execute": tool_execute,
    "send_message": tool_send_message,
}


# ---------------------------------------------------------------------------
# Trace + state
# ---------------------------------------------------------------------------

@dataclass
class ToolCall:
    turn: int
    tool: str
    args: Dict[str, Any]
    result: str
    timestamp: float = field(default_factory=time.time)


@dataclass
class AgentTrace:
    scenario_id: str
    target: str
    turns: List[Dict[str, Any]] = field(default_factory=list)
    tool_calls: List[ToolCall] = field(default_factory=list)
    final_fingerprint: Optional[Dict[str, Any]] = None

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, default=str)


# ---------------------------------------------------------------------------
# The loop
# ---------------------------------------------------------------------------

def run_agentic_trace(
    scenario_id: str,
    target_bot: str,
    max_turns: int = 20,
    tools: Optional[List[str]] = None,
) -> AgentTrace:
    """
    Run a stateful agentic simulation.

    target_bot: name or endpoint of the bot under test.
    tools: subset of TOOL_REGISTRY keys the bot is allowed to use.
    """
    allowed = tools or list(TOOL_REGISTRY.keys())
    trace = AgentTrace(scenario_id=scenario_id, target=target_bot)

    # In a real implementation you would:
    #   1. Load the scenario prompt from agentic/scenarios/
    #   2. Send it to the target bot with a tool-calling schema
    #   3. Loop: bot responds -> if it calls a tool, execute it, feed result back
    #   4. Stop on max_turns, explicit halt, or detected escalation
    #   5. Score the full trace with rubric + agentic axes

    print(f"[agentic] starting trace {scenario_id} against {target_bot}")
    print(f"[agentic] allowed tools: {allowed}")
    print(f"[agentic] max turns: {max_turns}")
    print("[agentic] (stub) replace the loop body with your real bot client")

    # Stub: record a placeholder turn so the pipeline has something to chew on.
    trace.turns.append({
        "turn": 0,
        "role": "system",
        "content": f"Scenario {scenario_id} loaded. Tools: {allowed}",
    })

    return trace


def score_trace(trace: AgentTrace) -> Dict[str, Any]:
    """
    Minimal scorer hook. Wire this to your rubric + agentic axes.
    Returns a fingerprint dict ready for hashing / on-chain attestation.
    """
    fingerprint = {
        "scenario_id": trace.scenario_id,
        "target": trace.target,
        "turns": len(trace.turns),
        "tool_calls": len(trace.tool_calls),
        "tools_used": sorted({tc.tool for tc in trace.tool_calls}),
        "escalation_flags": [],  # fill from rubric
        "honesty_score": None,
        "transparency_score": None,
        "manipulation_score": None,
        "timestamp": time.time(),
    }
    trace.final_fingerprint = fingerprint
    return fingerprint


def main():
    parser = argparse.ArgumentParser(description="Agent A (Agent Auditor) agentic runner")
    parser.add_argument("--target", default="grok", help="Bot under test")
    parser.add_argument("--scenario", default="agentic/scenarios/01_privilege_escalation.md")
    parser.add_argument("--max-turns", type=int, default=20)
    parser.add_argument("--tools", nargs="*", default=None, help="Allowed tool names")
    parser.add_argument("--out", default="trace.json", help="Output trace file")
    args = parser.parse_args()

    trace = run_agentic_trace(
        scenario_id=args.scenario,
        target_bot=args.target,
        max_turns=args.max_turns,
        tools=args.tools,
    )
    fingerprint = score_trace(trace)

    with open(args.out, "w") as f:
        f.write(trace.to_json())

    print(f"[agentic] trace written to {args.out}")
    print(f"[agentic] fingerprint: {json.dumps(fingerprint, indent=2)}")
    print("[agentic] next: hash fingerprint and submit to chain/attestation_contract.md")


if __name__ == "__main__":
    main()
