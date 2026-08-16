#!/usr/bin/env bash
# Resolve the live llama.cpp upstream for the Anthropic proxy.
#
# WHY: the upstream is not always a fixed port. Unsloth Studio restarts its
# bundled llama-server on a NEW random port every launch (observed :50047 ->
# :34407 -> :59879), while LLAMA_CPP_BASE is pinned in the proxy env file. The
# moment Studio restarts, every local request fails with
#   "Upstream connect failed after 3 attempts: ConnectError"  -> HTTP 529
# and stays broken until someone hand-edits the env file. That env file is also
# self-protect'd, so the agent cannot repair it — the stack sits dead.
#
# TRUST MODEL. A discovered endpoint receives every prompt and its replies drive
# tool execution, so discovery is deliberately narrow:
#   - The pin wins whenever it answers. A deliberate operator pin (remote host,
#     second server) is never silently overridden by a local process.
#   - Only loopback and wildcard binds are accepted. A llama-server bound to a
#     specific non-loopback address is REJECTED rather than assumed to also be
#     on 127.0.0.1 — that address may belong to a different user's socket.
#   - A candidate must prove it is a chat-capable llama-server (/props shape +
#     completion capability), not merely something returning 200. That rejects
#     a decoy and, just as importantly, the embedding llama-server that also
#     runs on this host.
# Residual risk, accepted: a process running as THIS user can still name itself
# llama-server and pass the shape checks. Such a process can already read the
# source tree and the agent's files.
#
# Sourced by scripts/run-anthropic-proxy-continuity.sh. Also runnable directly:
#   scripts/lib/llama-upstream.sh resolve http://127.0.0.1:8080/v1
#
# `curl` and `ss` are invoked by bare name (never absolute) so tests can stub
# them on PATH and exercise the real code path. The TS counterpart is
# src/utils/llama-discovery.ts — the two MUST agree; test/llama-upstream-parity
# asserts it.

# Strip the trailing /v1 (and any trailing slash) off an OpenAI-compatible base.
llama_upstream_root() {
    local base="${1:-}"
    base="${base%/}"
    base="${base%/v1}"
    printf '%s' "$base"
}

# 0 if the base answers llama-server's /health with 200. Liveness only.
# `--` terminates curl's options: a base beginning with `-` would otherwise be
# read as a flag (e.g. -K reads an attacker-named config file).
llama_upstream_alive() {
    local base="${1:-}"
    [ -n "$base" ] || return 1
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time "${UAP_LLAMA_PROBE_TIMEOUT:-2}" \
        -- "$(llama_upstream_root "$base")/health" 2>/dev/null || true)"
    [ "$code" = "200" ]
}

# 0 if the base looks like a chat-capable llama.cpp server. Applied to
# DISCOVERED candidates only — an operator pin is taken at its word.
llama_upstream_is_chat_server() {
    local base="${1:-}" root props models
    root="$(llama_upstream_root "$base")"

    # /props carries llama-server's generation settings. A bare HTTP server, an
    # error page, or a still-loading server does not.
    props="$(curl -s --max-time "${UAP_LLAMA_PROBE_TIMEOUT:-2}" -- "${root}/props" 2>/dev/null || true)"
    case "$props" in
        *'"default_generation_settings"'*) ;;
        *) return 1 ;;
    esac

    # Reject an embedding-only server (this host runs one). When the build does
    # not report capabilities at all, accept — older llama.cpp omits the field.
    models="$(curl -s --max-time "${UAP_LLAMA_PROBE_TIMEOUT:-2}" -- "${root}/v1/models" 2>/dev/null || true)"
    case "$models" in
        *'"capabilities"'*)
            case "$models" in
                *'"completion"'*) ;;
                *) return 1 ;;
            esac
            ;;
    esac
    return 0
}

# Print the host:port of every locally listening llama-server, one per line,
# already normalised to a loopback authority. Non-loopback binds are dropped.
#
# `ss -ltnp` attributes a process only to sockets the caller owns, which is the
# case here (the server runs as the same user). Column 4 is Local Address:Port;
# the port is the segment after the LAST colon so IPv6 forms survive.
llama_upstream_candidate_authorities() {
    ss -ltnp 2>/dev/null \
        | grep -i 'users:(("llama-server"' \
        | awk '{
            n = split($4, a, ":");
            port = a[n];
            if (port !~ /^[0-9]+$/ || port+0 <= 0 || port+0 >= 65536) next;
            addr = substr($4, 1, length($4) - length(port) - 1);
            # Wildcard binds cover loopback, so 127.0.0.1 reaches the same
            # socket. A specific non-loopback address does NOT imply loopback.
            # Emit "port <tab> family-rank <tab> authority" so ordering is
            # numeric by port and deterministic (IPv4 wins a tie) — matching
            # src/utils/llama-discovery.ts exactly. Sorting the authority
            # strings instead would order 10001 before 8080 and mangle [::1].
            if (addr == "0.0.0.0" || addr == "*" || addr == "127.0.0.1") print port "\t0\t127.0.0.1:" port;
            else if (addr == "[::]" || addr == "[::1]") print port "\t1\t[::1]:" port;
        }' \
        | sort -n -k1,1 -k2,2 \
        | awk '!seen[$1]++ { print $3 }'
}

# Resolve the base to use. Echoes the preferred base untouched when it is
# healthy, or when nothing better can be proven — never worse than the pin.
llama_upstream_resolve() {
    local preferred="${1:-}"

    if llama_upstream_alive "$preferred"; then
        printf '%s' "$preferred"
        return 0
    fi

    if [ "${UAP_LLAMA_UPSTREAM_AUTODISCOVER:-on}" != "on" ]; then
        printf '%s' "$preferred"
        return 0
    fi

    local authority candidate
    for authority in $(llama_upstream_candidate_authorities); do
        candidate="http://${authority}/v1"
        [ "$candidate" = "$preferred" ] && continue
        if llama_upstream_alive "$candidate" && llama_upstream_is_chat_server "$candidate"; then
            printf '%s' "$candidate"
            return 0
        fi
    done

    printf '%s' "$preferred"
}

# Port of a base URL ("http://192.168.1.165:8080/v1" -> "8080"). Empty when the
# base carries no explicit port.
llama_upstream_port() {
    local authority="${1:-}"
    authority="${authority#*://}"
    authority="${authority%%/*}"
    case "$authority" in
        \[*\]:*) printf '%s' "${authority##*]:}" ;;   # [::1]:8080
        \[*\]) : ;;                                   # [::1], no port
        *:*) printf '%s' "${authority##*:}" ;;
    esac
}

# Field 22 of /proc/<pid>/stat is the process start time. PID + starttime is an
# identity; PID alone is not, and this repo has already been bitten by PID reuse
# (see the deliver lock). Empty when the pid is gone.
llama_upstream_pid_token() {
    local pid="${1:-}"
    [ -n "$pid" ] || return 0
    awk '{ print $22 }' "/proc/${pid}/stat" 2>/dev/null || true
}

# Background guard: startup resolution alone still strands a LONG-LIVED proxy,
# because llama can move ports hours after the proxy came up. Watch the upstream
# and, once it is dead AND a DIFFERENT live server exists, stop the proxy so its
# supervisor restarts it through resolve.
#
# ONLY safe under a supervisor — the caller gates on that. Two consecutive
# failures are required before acting: a llama restart briefly shows no listener
# at all, and reacting to that gap would bounce the proxy for nothing. Never
# acts on a dead upstream alone, only on a proven live alternative, so an
# intentionally stopped server does not cause a restart loop.
llama_upstream_watch() {
    local base="${1:-}" target_pid="${2:-}"
    local interval="${UAP_LLAMA_UPSTREAM_WATCH_SECS:-20}"
    local misses=0 found token now_token

    case "$target_pid" in
        ''|*[!0-9]*) return 0 ;;   # never signal a non-PID (kill -TERM -1 sprays)
    esac
    # A non-numeric interval makes `sleep` fail, which would end the loop and
    # silently disable the guard. Fall back rather than vanish.
    case "$interval" in
        ''|*[!0-9.]*) interval=20 ;;
    esac
    token="$(llama_upstream_pid_token "$target_pid")"

    while sleep "$interval"; do
        now_token="$(llama_upstream_pid_token "$target_pid")"
        # Gone, or the PID was recycled into someone else's process.
        [ -n "$now_token" ] || return 0
        [ "$now_token" = "$token" ] || return 0

        if llama_upstream_alive "$base"; then
            misses=0
            continue
        fi

        misses=$((misses + 1))
        [ "$misses" -ge 2 ] || continue

        found="$(llama_upstream_resolve "$base")"
        # "Moved" means a DIFFERENT PORT, not a different URL string. The
        # documented pin is a LAN or localhost form (http://192.168.1.165:8080/v1,
        # http://localhost:8080/v1) while a discovered candidate is always
        # 127.0.0.1 — so comparing URLs calls the SAME server "moved" and bounces
        # a healthy proxy every time the pin's address blips. A port change is
        # the actual failure mode this watches for.
        if [ -n "$found" ] && [ "$(llama_upstream_port "$found")" != "$(llama_upstream_port "$base")" ]; then
            # Re-verify identity: resolve() above can take seconds.
            now_token="$(llama_upstream_pid_token "$target_pid")"
            [ "$now_token" = "$token" ] || return 0
            echo "[proxy-upstream] upstream moved ${base} -> ${found}; restarting proxy to re-resolve" >&2
            kill -TERM "$target_pid" 2>/dev/null || true
            return 0
        fi
        misses=1
    done
}

# Direct invocation: `llama-upstream.sh resolve <base>` / `alive <base>`.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    case "${1:-}" in
        resolve) llama_upstream_resolve "${2:-}"; echo ;;
        alive) llama_upstream_alive "${2:-}" ;;
        authorities) llama_upstream_candidate_authorities ;;
        *) echo "usage: ${0##*/} {resolve|alive|authorities} [base]" >&2; exit 2 ;;
    esac
fi
