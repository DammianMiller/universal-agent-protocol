// Exercises the REAL relaunchDetached. The first invocation re-launches itself
// into its own session; the detached child idles briefly so the test can kill the
// wrapper and assert the mission outlives it.
//
// Each side records its pid to a file. The test reads pids from those files
// rather than `pgrep -f`, which would self-match the shell running it.
import { writeFileSync } from 'fs';
import { join } from 'path';
import { relaunchDetached, isDetachedChild } from '../../dist/cli/deliver-detach.js';

if (isDetachedChild()) {
  writeFileSync(join(process.cwd(), 'child.pid'), String(process.pid));
  console.log('child alive');
  // Bounded: a never-exiting child would leak out of a failed test run.
  const t = setInterval(() => console.log('working'), 300);
  setTimeout(() => { clearInterval(t); process.exit(0); }, 20_000);
} else {
  writeFileSync(join(process.cwd(), 'wrapper.pid'), String(process.pid));
  const code = await relaunchDetached(process.cwd(), '20260714T000000');
  process.exit(code);
}
