#!/usr/bin/env node
// env-probe: tiny CLI used by the user-paths manifest to exercise the
// sanitizedEnv() contract end-to-end. It reports the environment it
// INHERITED — i.e. what the user-validation spawn sites actually passed:
//   - CI=<value>: the marker sanitizedEnv() sets ('unset' ⇒ the spawn site
//     regressed to passing the raw host env)
//   - secrets=<n>: count of secret-looking keys VISIBLE to this process.
//     The journey harness spawns this probe via sanitizedEnv(), so n must be
//     0 — if a spawn site ever regresses to the raw host env, boxes carrying
//     real tokens report n>0 and the journey fails. (On secret-free boxes
//     the tripwire is vacuous either way; CI=unset still catches regression.)
// SECRET_ENV_RE duplicates src/delivery/sanitized-env.ts — a test pins the
// two in sync so drift fails loudly instead of undercounting.
const SECRET_ENV_RE =
  /(API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|AUTH_SOCK|SESSION|COOKIE|_DSN|SA_KEY|KUBECONFIG|(^|_)(DATABASE|REDIS|MONGO|POSTGRES|MYSQL|AMQP)_?URL|_URI$)/i;

const secretCount = Object.keys(process.env).filter((k) => SECRET_ENV_RE.test(k)).length;
console.log(`sanitizedEnv ok: CI=${process.env.CI ?? 'unset'} secrets=${secretCount} keys=${Object.keys(process.env).length}`);
