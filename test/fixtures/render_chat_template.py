#!/usr/bin/env python3
"""Render a chat template and print the result.

Usage: render_chat_template.py <template.jinja>  < payload.json

payload.json is {messages, tools, add_generation_prompt, kwargs}. On a template
raise_exception() this prints "RAISE: <message>" and exits 0 -- the caller asserts on
that string, because "which inputs raise" is itself a contract we pin.

Why this exists: the chat-template tests used to grep template SOURCE. That cannot
see render-time properties -- a template that splices its system block twice, or
replaces the caller's system prompt instead of appending to it, or flips its
tool-call wire format -- still contains all the expected substrings.
"""
import json
import sys

try:
    from jinja2 import Environment
except ImportError:
    print("SKIP: jinja2 not installed")
    raise SystemExit(0)


class TemplateRaise(Exception):
    pass


def main() -> int:
    src = open(sys.argv[1], encoding="utf-8").read()
    payload = json.load(sys.stdin)

    env = Environment()

    def _raise(msg):
        raise TemplateRaise(msg)

    env.globals["raise_exception"] = _raise

    try:
        out = env.from_string(src).render(
            messages=payload.get("messages", []),
            tools=payload.get("tools", []),
            add_generation_prompt=payload.get("add_generation_prompt", True),
            **payload.get("kwargs", {}),
        )
    except TemplateRaise as exc:
        print(f"RAISE: {exc}", end="")
        return 0

    print(out, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
