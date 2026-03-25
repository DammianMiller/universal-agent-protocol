# User Testing

## Validation Surface
All validation is done through HTTP API queries:
- **llama-server**: `curl http://localhost:8080/v1/chat/completions` (OpenAI-compatible)
- **Anthropic proxy**: `curl http://localhost:4000/v1/messages` (Anthropic Messages API)
- **Server health**: `curl http://localhost:8080/health`
- **Server slots**: `curl http://localhost:8080/slots`
- **Server logs**: `/home/cogtek/llama.cpp/llama-server.log`
- **systemd status**: `systemctl --user status uap-llama-server.service`

No browser testing surface needed. All validation is CLI/curl based.

## Validation Concurrency
- Max concurrent validators: 1 (single GPU, single server instance)
- Server must be idle before running validation queries
- Each validation query is sequential (model generates one response at a time with --parallel 1)

## Testing Tools
- curl for HTTP queries
- python3 for JSON parsing of responses
- grep for log analysis
- systemctl for service management

## Resource Notes
- Server startup (model load) takes ~30-45 seconds
- 262k context window uses ~20.5GB VRAM
- Draft model adds ~811MB VRAM
