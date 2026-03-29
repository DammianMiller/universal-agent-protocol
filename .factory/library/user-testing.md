# User Testing

## Validation Surface
- Proxy-first coding-agent checks: `curl http://localhost:4000/v1/messages`
- Raw llama.cpp checks: `curl http://localhost:8080/v1/chat/completions`
- Raw llama.cpp health: `curl http://localhost:8080/health`
- Raw llama.cpp slots: `curl http://localhost:8080/slots`
- Proxy health: `curl http://localhost:4000/health`

## Notes
- Use port 4000 for Claude Code / Droid style validation.
- Use port 8080 for direct llama.cpp smoke tests and server debugging.
