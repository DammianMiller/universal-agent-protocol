/**
 * enforcement-infra-protect: the model must not kill or displace the inference
 * stack it runs on (llama :8080 / UAP proxy :4000 / embeddings :8081).
 */
import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ENFORCER = join(process.cwd(), 'src', 'policies', 'enforcers', 'enforcement_infra_protect.py');

type Verdict = { exit: number; allowed: boolean; reason: string };

function invoke(command: string, op: string, env?: NodeJS.ProcessEnv): Verdict {
  const r = spawnSync('python3', [ENFORCER, '--operation', op, '--args', JSON.stringify({ command })], {
    encoding: 'utf8',
    env: { ...process.env, UAP_INFRA_PROTECT_OFF: '', ...env },
  });
  let parsed: { allowed?: boolean; reason?: string } = {};
  try {
    parsed = JSON.parse(r.stdout || '{}');
  } catch {
    /* leave empty */
  }
  return { exit: r.status ?? -1, allowed: parsed.allowed ?? false, reason: parsed.reason ?? '' };
}

function run(command: string, op = 'Bash'): Verdict {
  return invoke(command, op);
}

/** Rule 9 resolves the deliver lock relative to the repo root, so point it at a fixture. */
function runWithRoot(command: string, root: string, op = 'Bash'): Verdict {
  return invoke(command, op, { UAP_REPO_ROOT: root });
}

describe('enforcement-infra-protect enforcer', () => {
  it('blocks a bare-interpreter pkill (would kill the proxy)', () => {
    const r = run('pkill -9 -f python3');
    expect(r.exit).toBe(2);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/infra/i);
  });

  it('blocks kill-by-infra-port and named service kills', () => {
    expect(run('kill $(lsof -t -i:8080)').exit).toBe(2);
    expect(run('pkill -f llama-server').exit).toBe(2);
    expect(run('systemctl --user restart uap-anthropic-proxy').exit).toBe(2);
  });

  it('blocks binding an infra port with a dev/file server', () => {
    expect(run('python3 -m http.server 8080').exit).toBe(2);
    expect(run('vite --port 4000').exit).toBe(2);
  });

  it('allows a SPECIFIC kill pattern and serving on a non-infra port', () => {
    expect(run('pkill -f "python3 -m http.server 8765"').exit).toBe(0);
    expect(run('python3 -m http.server 8765').exit).toBe(0);
    expect(run('npm run build').exit).toBe(0);
  });

  it('ignores non-shell operations', () => {
    const r = run('anything', 'Edit');
    expect(r.exit).toBe(0);
    expect(r.allowed).toBe(true);
  });

  // Rules 1-7 each scan a single shell SEGMENT (`[^|;&\n]*`), so holding the
  // kill verb apart from its target blinded all of them. Observed live
  // 2026-07-31 (octopus_invaders_v3, qwen on opencode): a direct pkill of a
  // deliver run was refused at 11:13:46Z and EIGHT SECONDS later the xargs form
  // ran and reported "cleaned". Closing only that spelling closes nothing — the
  // `;` and loop twins are the same thought one keystroke away.
  describe('rule 8: kills held apart from their target', () => {
    it('blocks the pipe/xargs forms', () => {
      expect(run("ps aux | grep llama-server | awk '{print $2}' | xargs kill -9").exit).toBe(2);
      expect(run('lsof -t -i:4000 | xargs kill -9').exit).toBe(2);
      expect(run("kill -9 $(ps aux | grep llama-server | awk '{print $2}')").exit).toBe(2);
    });

    it('blocks the lookup-then-kill forms across a statement boundary', () => {
      expect(run('PIDS=$(pgrep -f llama-server); kill -9 $PIDS').exit).toBe(2);
      expect(run('for p in $(pgrep -f llama-server); do kill -9 $p; done').exit).toBe(2);
      expect(run('P=$(lsof -t -i:4000); kill -9 $P').exit).toBe(2);
      // The token lives inside quotes here, so tokens must be read from the RAW
      // text even though the kill verb is read from the blanked view.
      expect(run('pgrep -f "uap deliver" | while read p; do kill -9 $p; done').exit).toBe(2);
    });

    it('blocks a variable holding the stack name, and a port used as the pattern', () => {
      expect(run('X=llama-server; pkill -f "$X"').exit).toBe(2);
      expect(run('pkill -f 8080').exit).toBe(2);
      expect(run('pkill -f deliver').exit).toBe(2);
    });

    it('does not fire on inspection, or on an unrelated kill', () => {
      expect(run('ps aux | grep llama-server | grep -v grep').exit).toBe(0);
      expect(run('lsof -t -i:4000').exit).toBe(0);
      expect(run("pkill -f 'python3 -m http.server 8765'").exit).toBe(0);
      // A lookup with no stack token does not taint a later kill.
      expect(run('ps aux | grep http.server; kill -9 99999999').exit).toBe(0);
    });

    it('reads the kill VERB from a data-stripped view, so prose is not a kill', () => {
      // Quoted multi-word data is blanked before the verb scan, so rule 8 does
      // not fire here. (This command IS still refused, by pre-existing rule 2,
      // which matches `kill … llama-server` in raw text — unchanged by this
      // change and the reason the escape-hatch tests concatenate their strings.)
      expect(run('uap memory store "the deliver loop kept killing itself"').exit).toBe(0);
    });
  });

  // A bare numeric kill names nothing, so no text rule can see what it hits.
  // The model killed its own in-flight deliver this way six times in one hour.
  // Resolution is SEMANTIC — the numbers are looked up in /proc — so unlike
  // rules 1-8 it cannot be spelled around.
  describe('rule 9: kill by bare PID', () => {
    function fixture(): string {
      const dir = mkdtempSync(join(tmpdir(), 'uap-infra-'));
      mkdirSync(join(dir, '.uap'), { recursive: true });
      return dir;
    }

    // 4194303 is at/above the default pid_max, so it is reliably not a process.
    const DEAD_PID = '4194303';

    it('does NOT protect a dead PID left behind in a stale lock', () => {
      // The wedge this avoids: a crashed deliver leaves its lock, and without a
      // liveness check the number becomes permanently unkillable while the
      // message says "wait for the deliver run" — recreating the very stall
      // rule 9 exists to prevent.
      const dir = fixture();
      try {
        writeFileSync(join(dir, '.uap', 'deliver.lock'), `${DEAD_PID}|2026-07-31T11:15:13.760Z`);
        expect(runWithRoot(`kill -9 ${DEAD_PID}`, dir).exit).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does NOT protect a live PID that recycled a stale lock number', () => {
      // This process is alive but is not a deliver run, so the lock's claim
      // must not transfer to it on PID reuse.
      const dir = fixture();
      try {
        writeFileSync(join(dir, '.uap', 'deliver.lock'), `${process.pid}|2026-07-31T11:15:13.760Z`);
        expect(runWithRoot(`kill -9 ${process.pid}`, dir).exit).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('protects a live process whose argv IS the stack, by PID and by pgid', () => {
      // A real process actually named llama-server — copy `sleep` under that
      // name rather than relying on `exec -a`, which is bash-only and left the
      // fixture dead (and the assertion vacuously passing) under dash.
      const dir = fixture();
      const stand = join(dir, 'llama-server');
      // A tiny script under that name. Copying the real `sleep` does NOT work:
      // on a busybox/toybox-style multi-call binary the applet is selected by
      // argv[0], so the renamed copy exits immediately with an empty cmdline
      // and the assertion passes for the wrong reason.
      writeFileSync(stand, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
      const proc = spawn(stand, [], { detached: true, stdio: 'ignore' });
      proc.unref();
      const pid = String(proc.pid);
      try {
        expect(/^\d+$/.test(pid)).toBe(true);
        const r = runWithRoot(`kill -9 ${pid}`, dir);
        expect(r.exit).toBe(2);
        expect(r.reason).toMatch(/llama-server/i);
        // A stack hit must NOT get the deliver "wait and poll" advice.
        expect(r.reason).not.toMatch(/follow:true/);
        // `kill -9 -<pgid>` kills the whole group — strictly more destructive,
        // and invisible if the sign is treated as part of the PID token.
        expect(runWithRoot(`kill -9 -${pid}`, dir).exit).toBe(2);
      } finally {
        try { process.kill(Number(pid), 'SIGKILL'); } catch { /* already gone */ }
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('leaves an unrelated PID alone', () => {
      expect(runWithRoot('kill -9 99999999', fixture()).exit).toBe(0);
    });
  });
});

/** A real process whose /proc cmdline genuinely contains `uap deliver`. */
function deliverShaped(): { pid: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'uap-deliverish-'));
  const script = join(dir, 'uap');
  writeFileSync(script, 'setTimeout(() => {}, 30000);\n');
  const proc = spawn(process.execPath, [script, 'deliver', '--project-root', dir], {
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();
  return {
    pid: String(proc.pid),
    cleanup: () => {
      try { process.kill(Number(proc.pid), 'SIGKILL'); } catch { /* already gone */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('a deliver run is not the inference stack (false positive, 2026-08-09)', () => {
  /**
   * `_STACK_ARGV_RE` already recognised a deliver process, but `_identify_pid`
   * returned the raw matched text, and only the LOCK-HOLDER path produced the
   * deliver label — and that path fires only when the lock is under THIS repo.
   * A mission launched against another project (the usual case) was therefore
   * refused as "the inference stack answering this session's own requests",
   * telling the operator that stopping their own run would end the session and
   * pointing at llama-server and the proxy. None of it true, and the remedy was
   * wrong too. It cost several round-trips in one live session.
   */
  it('names it as a deliver run, not as the inference stack', () => {
    const { pid, cleanup } = deliverShaped();
    try {
      const r = run(`kill -TERM ${pid}`);
      expect(r.exit).toBe(2);
      expect(r.reason).toMatch(/deliver run in progress/i);
      expect(r.reason).not.toMatch(/inference stack/i);
      expect(r.reason).not.toMatch(/llama-server/i);
    } finally {
      cleanup();
    }
  });

  it('offers the cooperative stop, and names a path a shell can act on', () => {
    // The CLI docs say never to kill a deliver by hand: the STOP file lets the
    // loop exit at a turn boundary with its work checkpointed and the lock
    // released, which a signal does not. `requestStop` is a TypeScript symbol
    // with no CLI surface, so the refusal must name the file, not the function.
    const { pid, cleanup } = deliverShaped();
    try {
      const reason = run(`kill -9 ${pid}`).reason;
      expect(reason).toMatch(/do NOT kill it/i);
      expect(reason).toMatch(/cooperative/i);
      expect(reason).toMatch(/deliver-runs\/<runId>\/STOP/);
    } finally {
      cleanup();
    }
  });

  it('still protects the real stack with the stack message', () => {
    const r = run('pkill -9 -f llama-server');
    expect(r.exit).toBe(2);
    expect(r.reason).toMatch(/inference stack/i);
    expect(r.reason).not.toMatch(/deliver run in progress/i);
  });
});

describe('kill -0 is a liveness probe, not a kill', () => {
  /**
   * Signal 0 performs error checking only — it tests whether the PID exists and
   * is signalable, and delivers nothing. Refusing it protected nothing and
   * denied the cheapest way to ask "is that run still alive?".
   *
   * The exemption is scoped PER STATEMENT. A whole-command exemption let one
   * probe anywhere switch rule 9 off for every PID in the text — and rule 9 is
   * the ONLY guard on a bare-PID kill, since rules 1-8 all need pkill/killall,
   * a service name, a -f pattern or a lookup verb.
   */
  it('allows a probe', () => {
    const { pid, cleanup } = deliverShaped();
    try {
      expect(run(`kill -0 ${pid}`).exit).toBe(0);
      expect(run(`kill -s 0 ${pid}`).exit).toBe(0);
      expect(run(`kill -0 ${pid} && kill -0 ${pid}`).exit).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('does NOT let -0 launder a BARE-PID kill', () => {
    // An earlier version of this test used `pkill -f llama-server`, which rule 2
    // catches by NAME before the exemption is ever consulted — so it passed
    // whether the exemption was scoped or not, while the real hole stayed open.
    // A bare PID has no name to match on.
    const { pid, cleanup } = deliverShaped();
    try {
      expect(run(`kill -0 ${pid} && kill -9 ${pid}`).exit).toBe(2);
      expect(run(`kill -9 ${pid}; kill -0 ${pid}`).exit).toBe(2);
      // The canonical "kill it if it is alive" idiom — the spelling a model
      // reaches for by default, which is why a whole-text exemption was unsafe.
      expect(run(`if kill -0 ${pid}; then kill -9 ${pid}; fi`).exit).toBe(2);
      // Merely NAMING the probe must not buy an exemption either.
      expect(run(`echo "probe with kill -0"; kill -9 ${pid}`).exit).toBe(2);
    } finally {
      cleanup();
    }
  });
});
