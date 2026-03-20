#!/usr/bin/env python3
"""
UAP Anthropic-to-OpenAI Proxy
==============================

A lightweight, production-ready proxy that translates Anthropic Messages API
requests into OpenAI Chat Completions API requests. Designed for use with
local LLM servers (llama.cpp, vLLM, Ollama, etc.) that expose an OpenAI-
compatible endpoint but need to be accessed from clients that speak the
Anthropic protocol (e.g., Claude Code, Forge Code).

Architecture
------------
    Claude Code  --(Anthropic API)-->  This Proxy  --(OpenAI API)-->  llama.cpp
       :4000                                                             :8080

Key Features
- Full streaming support (SSE translation between protocols)
- Tool/function calling translation (both streaming and non-streaming)
- Module-level httpx.AsyncClient with connection pooling and keep-alive
- Granular timeouts (short connect, long read for LLM generation)
- Graceful error recovery on upstream connection drops
- Proper upstream cleanup on client disconnect

Configuration (Environment Variables)
--------------------------------------
    LLAMA_CPP_BASE     Base URL of the OpenAI-compatible server
                       Default: http://192.168.1.165:8080/v1

    PROXY_PORT         Port for this proxy to listen on
                       Default: 4000

    PROXY_HOST         Host/IP to bind to
                       Default: 0.0.0.0

    PROXY_LOG_LEVEL    Logging level (DEBUG, INFO, WARNING, ERROR)
                       Default: INFO

    PROXY_READ_TIMEOUT   Read timeout in seconds for upstream LLM streaming
                         Default: 600 (10 minutes)

    PROXY_MAX_CONNECTIONS   Max concurrent connections to upstream
                            Default: 20

Usage
-----
    # Basic usage (connects to llama.cpp on default port):
    python anthropic_proxy.py

    # Custom upstream server:
    LLAMA_CPP_BASE=http://localhost:8080/v1 python anthropic_proxy.py

    # Custom proxy port:
    PROXY_PORT=5000 python anthropic_proxy.py

    # Via npx (after npm install):
    npx uap-anthropic-proxy

Dependencies
------------
    pip install fastapi uvicorn httpx

    Or from the project root:
    pip install -r tools/agents/scripts/requirements-proxy.txt
"""

import asyncio
import json
import logging
import os
import sys
import time
import uuid

import httpx
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse
import uvicorn

# ---------------------------------------------------------------------------
# Configuration (all configurable via environment variables)
# ---------------------------------------------------------------------------
LLAMA_CPP_BASE = os.environ.get("LLAMA_CPP_BASE", "http://192.168.1.165:8080/v1")
PROXY_PORT = int(os.environ.get("PROXY_PORT", "4000"))
PROXY_HOST = os.environ.get("PROXY_HOST", "0.0.0.0")
PROXY_LOG_LEVEL = os.environ.get("PROXY_LOG_LEVEL", "INFO").upper()
PROXY_READ_TIMEOUT = float(os.environ.get("PROXY_READ_TIMEOUT", "600"))
PROXY_MAX_CONNECTIONS = int(os.environ.get("PROXY_MAX_CONNECTIONS", "20"))

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=getattr(logging, PROXY_LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("uap.anthropic_proxy")

# ---------------------------------------------------------------------------
# HTTP Client Lifecycle
# ---------------------------------------------------------------------------
# Module-level httpx.AsyncClient for connection reuse + keep-alive.
# Granular timeouts: short connect, long read for streaming LLM output.
http_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage the httpx client lifecycle with the FastAPI app."""
    global http_client
    http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(
            connect=10.0,                  # 10s to establish connection
            read=PROXY_READ_TIMEOUT,       # configurable (default 10 min)
            write=30.0,                    # 30s to send the request body
            pool=10.0,                     # 10s to acquire a pool connection
        ),
        limits=httpx.Limits(
            max_connections=PROXY_MAX_CONNECTIONS,
            max_keepalive_connections=PROXY_MAX_CONNECTIONS // 2,
            keepalive_expiry=120,
        ),
    )
    logger.info(
        "Proxy started: listening on %s:%d -> upstream %s",
        PROXY_HOST, PROXY_PORT, LLAMA_CPP_BASE,
    )
    yield
    await http_client.aclose()
    http_client = None
    logger.info("Proxy shut down")


app = FastAPI(
    title="UAP Anthropic Proxy",
    description="Translates Anthropic Messages API to OpenAI Chat Completions API",
    version="1.0.0",
    lifespan=lifespan,
)


# ===========================================================================
# Request Translation: Anthropic -> OpenAI
# ===========================================================================

def anthropic_to_openai_messages(anthropic_body: dict) -> list[dict]:
    """Convert Anthropic message format to OpenAI message format.

    Handles:
    - System prompt (string or content block array)
    - Text content blocks
    - Tool use blocks (-> OpenAI function calls)
    - Tool result blocks (-> OpenAI tool messages)
    """
    messages = []

    # Anthropic has system as a top-level param
    system = anthropic_body.get("system")
    if system:
        if isinstance(system, str):
            messages.append({"role": "system", "content": system})
        elif isinstance(system, list):
            text = "\n".join(
                b.get("text", "") for b in system if b.get("type") == "text"
            )
            if text:
                messages.append({"role": "system", "content": text})

    for msg in anthropic_body.get("messages", []):
        role = msg["role"]
        content = msg.get("content")

        if isinstance(content, str):
            messages.append({"role": role, "content": content})
        elif isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, str):
                    parts.append(block)
                elif block.get("type") == "text":
                    parts.append(block.get("text", ""))
                elif block.get("type") == "tool_use":
                    messages.append({
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": block.get("id", f"call_{uuid.uuid4().hex[:8]}"),
                            "type": "function",
                            "function": {
                                "name": block["name"],
                                "arguments": json.dumps(block.get("input", {})),
                            },
                        }],
                    })
                    continue
                elif block.get("type") == "tool_result":
                    messages.append({
                        "role": "tool",
                        "tool_call_id": block.get("tool_use_id", ""),
                        "content": _extract_text(block.get("content", "")),
                    })
                    continue
            if parts:
                messages.append({"role": role, "content": "\n".join(parts)})

    return messages


def _extract_text(content) -> str:
    """Extract plain text from Anthropic content (string, list, or other)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            b.get("text", "") if isinstance(b, dict) else str(b) for b in content
        )
    return str(content)


def build_openai_request(anthropic_body: dict) -> dict:
    """Build an OpenAI Chat Completions request from an Anthropic Messages request."""
    openai_body = {
        "model": anthropic_body.get("model", "default"),
        "messages": anthropic_to_openai_messages(anthropic_body),
        "stream": anthropic_body.get("stream", False),
    }

    if "max_tokens" in anthropic_body:
        openai_body["max_tokens"] = anthropic_body["max_tokens"]
    if "temperature" in anthropic_body:
        openai_body["temperature"] = anthropic_body["temperature"]
    if "top_p" in anthropic_body:
        openai_body["top_p"] = anthropic_body["top_p"]
    if "stop_sequences" in anthropic_body:
        openai_body["stop"] = anthropic_body["stop_sequences"]

    # Convert Anthropic tools to OpenAI function-calling tools
    if "tools" in anthropic_body:
        openai_body["tools"] = []
        for tool in anthropic_body["tools"]:
            openai_body["tools"].append({
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": tool.get("description", ""),
                    "parameters": tool.get("input_schema", {}),
                },
            })

    return openai_body


# ===========================================================================
# Response Translation: OpenAI -> Anthropic
# ===========================================================================

def openai_to_anthropic_response(openai_resp: dict, model: str) -> dict:
    """Convert an OpenAI Chat Completions response to Anthropic Messages format."""
    choice = openai_resp.get("choices", [{}])[0]
    message = choice.get("message", {})
    finish = choice.get("finish_reason", "stop")

    content = []
    if message.get("content"):
        content.append({"type": "text", "text": message["content"]})

    # Convert tool calls
    for tc in message.get("tool_calls", []):
        fn = tc.get("function", {})
        try:
            args = json.loads(fn.get("arguments", "{}"))
        except json.JSONDecodeError:
            args = {}
        content.append({
            "type": "tool_use",
            "id": tc.get("id", f"toolu_{uuid.uuid4().hex[:12]}"),
            "name": fn.get("name", ""),
            "input": args,
        })

    stop_reason_map = {
        "stop": "end_turn",
        "length": "max_tokens",
        "tool_calls": "tool_use",
        "function_call": "tool_use",
    }

    usage = openai_resp.get("usage", {})

    return {
        "id": f"msg_{uuid.uuid4().hex[:24]}",
        "type": "message",
        "role": "assistant",
        "content": content if content else [{"type": "text", "text": ""}],
        "model": model,
        "stop_reason": stop_reason_map.get(finish, "end_turn"),
        "stop_sequence": None,
        "usage": {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
        },
    }


# ===========================================================================
# Streaming Translation: OpenAI SSE -> Anthropic SSE
# ===========================================================================

async def stream_anthropic_response(openai_stream: httpx.Response, model: str):
    """Convert an OpenAI streaming response to Anthropic SSE stream format.

    Handles:
    - Text content deltas -> content_block_delta (text_delta)
    - Tool call deltas -> content_block_start (tool_use) + input_json_delta
    - Graceful error recovery on upstream connection drops
    - Proper upstream response closure on client disconnect
    """
    msg_id = f"msg_{uuid.uuid4().hex[:24]}"

    # message_start
    yield (
        f"event: message_start\n"
        f"data: {json.dumps({'type': 'message_start', 'message': {'id': msg_id, 'type': 'message', 'role': 'assistant', 'content': [], 'model': model, 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 0, 'output_tokens': 0}}})}\n\n"
    )

    # content_block_start for text (index 0)
    yield (
        f"event: content_block_start\n"
        f"data: {json.dumps({'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}})}\n\n"
    )

    yield "event: ping\ndata: {\"type\": \"ping\"}\n\n"

    output_tokens = 0
    finish_reason = "end_turn"

    # Track tool call state for streaming tool_calls
    tool_calls_by_index: dict[int, dict] = {}
    tool_block_index = 1  # anthropic block index (0 = text)

    try:
        async for line in openai_stream.aiter_lines():
            if not line.startswith("data: "):
                continue
            data = line[6:].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue

            choice = (chunk.get("choices") or [{}])[0]
            delta = choice.get("delta", {})

            # Handle text content deltas
            if delta.get("content"):
                output_tokens += 1  # rough token estimate
                yield (
                    f"event: content_block_delta\n"
                    f"data: {json.dumps({'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': delta['content']}})}\n\n"
                )

            # Handle tool_calls deltas
            if delta.get("tool_calls"):
                for tc_delta in delta["tool_calls"]:
                    tc_idx = tc_delta.get("index", 0)

                    if tc_idx not in tool_calls_by_index:
                        # New tool call starting
                        tc_id = tc_delta.get("id", f"toolu_{uuid.uuid4().hex[:12]}")
                        fn = tc_delta.get("function", {})
                        tool_calls_by_index[tc_idx] = {
                            "id": tc_id,
                            "name": fn.get("name", ""),
                            "arguments": fn.get("arguments", ""),
                            "block_index": tool_block_index,
                        }

                        # Close text block before first tool block
                        if tool_block_index == 1:
                            yield (
                                f"event: content_block_stop\n"
                                f"data: {json.dumps({'type': 'content_block_stop', 'index': 0})}\n\n"
                            )

                        # Emit content_block_start for this tool_use
                        yield (
                            f"event: content_block_start\n"
                            f"data: {json.dumps({'type': 'content_block_start', 'index': tool_block_index, 'content_block': {'type': 'tool_use', 'id': tc_id, 'name': fn.get('name', '')}})}\n\n"
                        )
                        tool_block_index += 1
                    else:
                        # Continuation: argument chunks
                        fn = tc_delta.get("function", {})
                        arg_chunk = fn.get("arguments", "")
                        if arg_chunk:
                            tool_calls_by_index[tc_idx]["arguments"] += arg_chunk
                            bidx = tool_calls_by_index[tc_idx]["block_index"]
                            yield (
                                f"event: content_block_delta\n"
                                f"data: {json.dumps({'type': 'content_block_delta', 'index': bidx, 'delta': {'type': 'input_json_delta', 'partial_json': arg_chunk}})}\n\n"
                            )

            if choice.get("finish_reason"):
                fr = choice["finish_reason"]
                finish_reason = {
                    "stop": "end_turn",
                    "length": "max_tokens",
                    "tool_calls": "tool_use",
                }.get(fr, "end_turn")

    except (httpx.ReadError, httpx.RemoteProtocolError, httpx.StreamClosed) as exc:
        logger.warning("Upstream stream error: %s: %s", type(exc).__name__, exc)
        finish_reason = "end_turn"
    except asyncio.CancelledError:
        logger.info("Client disconnected, closing upstream stream")
        raise
    except Exception as exc:
        logger.error("Unexpected stream error: %s: %s", type(exc).__name__, exc)
        finish_reason = "end_turn"
    finally:
        # Always close the upstream response to stop LLM generation
        await openai_stream.aclose()

    # Close any open tool call blocks
    if tool_calls_by_index:
        for tc in tool_calls_by_index.values():
            yield (
                f"event: content_block_stop\n"
                f"data: {json.dumps({'type': 'content_block_stop', 'index': tc['block_index']})}\n\n"
            )
    else:
        yield (
            f"event: content_block_stop\n"
            f"data: {json.dumps({'type': 'content_block_stop', 'index': 0})}\n\n"
        )

    # message_delta with final stop reason
    yield (
        f"event: message_delta\n"
        f"data: {json.dumps({'type': 'message_delta', 'delta': {'stop_reason': finish_reason, 'stop_sequence': None}, 'usage': {'output_tokens': output_tokens}})}\n\n"
    )

    # message_stop
    yield f"event: message_stop\ndata: {json.dumps({'type': 'message_stop'})}\n\n"


# ===========================================================================
# API Endpoints
# ===========================================================================

@app.post("/v1/messages")
async def messages(request: Request):
    """Handle Anthropic Messages API requests (streaming and non-streaming)."""
    body = await request.json()
    model = body.get("model", "default")
    is_stream = body.get("stream", False)
    openai_body = build_openai_request(body)

    client = http_client
    if client is None:
        return Response(
            content=json.dumps({"error": "Proxy not initialized"}),
            status_code=503,
            media_type="application/json",
        )

    if is_stream:
        openai_body["stream"] = True
        resp = await client.send(
            client.build_request(
                "POST",
                f"{LLAMA_CPP_BASE}/chat/completions",
                json=openai_body,
                headers={"Content-Type": "application/json"},
            ),
            stream=True,
        )
        return StreamingResponse(
            stream_anthropic_response(resp, model),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )
    else:
        resp = await client.post(
            f"{LLAMA_CPP_BASE}/chat/completions",
            json=openai_body,
            headers={"Content-Type": "application/json"},
        )
        openai_resp = resp.json()
        anthropic_resp = openai_to_anthropic_response(openai_resp, model)
        return anthropic_resp


@app.post("/anthropic/v1/messages")
async def messages_anthropic(request: Request):
    """Alternative endpoint path used by some Claude Code configurations."""
    return await messages(request)


@app.get("/v1/models")
async def models():
    """Return available model list (spoofs Anthropic model IDs for client compatibility)."""
    return {
        "data": [
            {"id": "claude-sonnet-4-20250514", "object": "model"},
            {"id": "claude-3-5-sonnet-20241022", "object": "model"},
        ]
    }


@app.get("/health")
async def health():
    """Health check endpoint for monitoring and load balancers."""
    upstream_ok = False
    try:
        if http_client:
            resp = await http_client.get(
                LLAMA_CPP_BASE.replace("/v1", "/health"),
                timeout=5.0,
            )
            upstream_ok = resp.status_code == 200
    except Exception:
        pass

    return {
        "status": "ok" if upstream_ok else "degraded",
        "proxy": "ok",
        "upstream": "ok" if upstream_ok else "unreachable",
        "upstream_url": LLAMA_CPP_BASE,
    }


# ===========================================================================
# Entry Point
# ===========================================================================

if __name__ == "__main__":
    uvicorn.run(
        app,
        host=PROXY_HOST,
        port=PROXY_PORT,
        log_level=PROXY_LOG_LEVEL.lower(),
    )
