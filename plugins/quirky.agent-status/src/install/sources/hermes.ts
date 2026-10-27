import { OWNED_MARKER } from './post.ts'

export const HERMES_PLUGIN_NAME = 'quirky-status'

export const HERMES_EVENTS = [
  'on_session_start',
  'pre_llm_call',
  'post_llm_call',
  'pre_tool_call',
  'post_tool_call',
  'pre_approval_request',
  'post_approval_response',
  'on_session_end',
  'on_session_finalize',
  'on_session_reset'
] as const

export function hermesManifest(): string {
  return [
    `# ${OWNED_MARKER}`,
    `name: ${HERMES_PLUGIN_NAME}`,
    'version: 1.0.0',
    'description: "Reports Hermes Agent lifecycle events to Quirky."',
    'author: "Quirky"',
    'kind: standalone',
    'provides_hooks:',
    ...HERMES_EVENTS.map((event) => `  - ${event}`),
    ''
  ].join('\n')
}

/** The Hermes plugin module; it does nothing outside a Quirky session and never raises into Hermes. */
export function hermesInitSource(): string {
  return `# ${OWNED_MARKER}
from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from typing import Any, Callable

AGENT = "hermes"
EVENTS = ${JSON.stringify(HERMES_EVENTS)}
TIMEOUT_SECONDS = 1.0
MAX_DEPTH = 5
MAX_ITEMS = 50
MAX_NODES = 500
MAX_STRING = 8192
TRUNCATED = "...[truncated]"
SELECTED_KEYS = {
    "on_session_start": ("session_id", "model", "platform"),
    "pre_llm_call": ("session_id", "user_message", "is_first_turn", "model", "platform", "sender_id"),
    "post_llm_call": ("session_id", "user_message", "assistant_response", "model", "platform"),
    "pre_tool_call": ("session_id", "task_id", "tool_call_id", "tool_name", "args"),
    "post_tool_call": ("session_id", "task_id", "tool_call_id", "tool_name", "args", "result", "duration_ms"),
    "pre_approval_request": ("command", "description", "pattern_key", "pattern_keys", "session_key", "surface"),
    "post_approval_response": ("command", "description", "pattern_key", "pattern_keys", "session_key", "surface", "choice"),
    "on_session_end": ("session_id",),
    "on_session_finalize": ("session_id", "platform"),
    "on_session_reset": ("session_id", "platform"),
}


def _truncate(value: str) -> str:
    return value if len(value) <= MAX_STRING else value[:MAX_STRING] + TRUNCATED


def _jsonable(value: Any, depth: int = 0, budget: list | None = None) -> Any:
    if budget is None:
        budget = [MAX_NODES]
    if budget[0] <= 0:
        return TRUNCATED
    budget[0] -= 1
    if depth > MAX_DEPTH:
        return _truncate(repr(value))
    if value is None or isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, str):
        return _truncate(value)
    if isinstance(value, dict):
        out = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= MAX_ITEMS:
                out[TRUNCATED] = True
                break
            out[_truncate(str(key))] = _jsonable(item, depth + 1, budget)
        return out
    if isinstance(value, (list, tuple, set)):
        out_list = []
        for index, item in enumerate(value):
            if index >= MAX_ITEMS:
                out_list.append(TRUNCATED)
                break
            out_list.append(_jsonable(item, depth + 1, budget))
        return out_list
    return _truncate(repr(value))


def _base_url() -> str:
    home = os.environ.get("QUIRKY_HOME", "")
    if home:
        try:
            with open(os.path.join(home, "runtime.json"), "r", encoding="utf-8") as handle:
                port = json.load(handle).get("port")
            if isinstance(port, int) and port > 0:
                return "http://127.0.0.1:%d/hook" % port
        except (OSError, ValueError, AttributeError):
            pass
    return os.environ.get("QUIRKY_HOOK_URL", "").rstrip("/")


def _post(payload: dict) -> None:
    session = os.environ.get("QUIRKY_SESSION_ID", "")
    if not session:
        return
    base = _base_url()
    if not base:
        return
    url = "%s/%s?session=%s" % (base, AGENT, urllib.parse.quote(session, safe=""))
    request = urllib.request.Request(
        url,
        data=json.dumps(payload, separators=(",", ":")).encode("utf-8"),
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-quirky-hook-token": os.environ.get("QUIRKY_HOOK_TOKEN", ""),
        },
    )
    # a proxy in the environment must not sit between the agent and the local daemon
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=TIMEOUT_SECONDS):
        pass


def _payload_for_event(event_name: str, kwargs: dict) -> dict:
    payload: dict = {"hook_event_name": event_name, "cwd": os.getcwd()}
    for key in SELECTED_KEYS.get(event_name, ()):
        if key in kwargs:
            payload[key] = _jsonable(kwargs[key])
    if "user_message" in payload:
        payload["prompt"] = payload["user_message"]
    if "assistant_response" in payload:
        payload["last_assistant_message"] = payload["assistant_response"]
    if "args" in payload:
        payload["tool_input"] = payload["args"]
    if event_name in ("pre_approval_request", "post_approval_response"):
        payload["tool_name"] = "approval"
        payload["tool_input"] = {
            "command": payload.get("command", ""),
            "description": payload.get("description", ""),
        }
    return payload


def _make_hook(event_name: str) -> Callable[..., None]:
    def _hook(**kwargs: Any) -> None:
        try:
            _post(_payload_for_event(event_name, kwargs))
        except Exception:
            return

    return _hook


def register(ctx: Any) -> None:
    for event_name in EVENTS:
        ctx.register_hook(event_name, _make_hook(event_name))
`
}
