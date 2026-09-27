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

// The probe is spawned by the user-validation runner (runCliPath →
// spawnJourneyStep) with env: sanitizedEnv(), and the manifest-server spawn
// site (startManifestServer) bases its child env on sanitizedEnv() as well —
// so the env this process inherited is exactly what those spawn sites pass.
// CI=true is the marker sanitizedEnv() sets; its absence means a spawn site
// regressed to the raw host env. secrets=0 proves the secret-stripping.
const secretCount = Object.keys(process.env).filter((k) => SECRET_ENV_RE.test(k)).length;
const ci = process.env.CI ?? 'unset';
if (ci !== 'true' || secretCount !== 0) {
  console.error(`sanitizedEnv FAIL: CI=${ci} secrets=${secretCount} — spawn site regressed to raw host env`);
  process.exit(1);
}
console.log(`sanitizedEnv ok: CI=${ci} secrets=${secretCount} keys=${Object.keys(process.env).length}`);
