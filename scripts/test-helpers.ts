// Shared helpers for the example tests (`examples/*/*.test.ts`).
//
// Each test file calls `setupApplet("<name>")` once in `beforeAll` and then
// uses `callApplet(method, input)` to drive the bridge. `setupApplet` is
// the slow step (~15 s): it rebuilds the Rust applet from
// examples/<name>/main.rs, uploads it, waits for the device to come back
// after the reboot, and re-arms the host-side IP.

import { $ } from 'bun';

const DEVICE_HOST = Bun.env.DEVICE_HOST ?? '10.0.0.1';
const DEVICE_PORT = Number(Bun.env.DEVICE_PORT ?? 4000);
const REPO_ROOT = new URL('../', import.meta.url).pathname;

type Example = 'square' | 'crypto' | 'attestation';

// Single TCP round-trip to the bridge via nc. Shells out per call because
// Bun's native TCP APIs (Bun.connect, node:net) get process-wedged after
// the USB-CDC-ECM link cycles on a hot-swap reboot.
export async function callApplet(
  method: string,
  input: string,
  timeoutSec = 3,
): Promise<string> {
  const req = JSON.stringify({ Method: method, Input: input }) + '\n';
  const proc = Bun.spawn(
    ['nc', '-w', String(timeoutSec), DEVICE_HOST, String(DEVICE_PORT)],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
  );
  proc.stdin.write(req);
  await proc.stdin.end();

  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exit !== 0 || !stdout) {
    throw new Error(stderr.trim() || `nc exited ${exit}`);
  }

  const nl = stdout.indexOf('\n');
  const reply = JSON.parse(nl >= 0 ? stdout.slice(0, nl) : stdout);
  if (reply.Error) throw new Error(reply.Error);
  return reply.Output ?? '';
}

// Poll the bridge until it answers. Uses an arbitrary method name — the
// Trusted OS forwards unknown methods to the applet, which replies with
// an empty string, so any reply (even empty) means "device alive".
export async function waitForDevice(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await callApplet('__probe', '', 2);
      return;
    } catch (e) {
      lastErr = e;
      await Bun.sleep(500);
    }
  }
  throw new Error(
    `device did not answer on ${DEVICE_HOST}:${DEVICE_PORT} within ${timeoutMs} ms (last: ${(lastErr as Error)?.message})`,
  );
}

// Refresh the sudo credential timestamp without prompting. Returns true
// if a non-interactive sudo is currently usable, false otherwise. Used
// before every rearmLink call so the test never blocks on a password
// prompt when the 5-minute cache expires mid-run.
async function refreshSudo(): Promise<boolean> {
  const proc = Bun.spawn(['sudo', '-n', '-v'], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await proc.exited;
  return proc.exitCode === 0;
}

// Re-assign the host-side IP on the CDC-ECM interface. macOS drops it on
// every device disconnect, so after every reboot we need to run this.
// The armory-link.sh script uses sudo — run `sudo -v` before `bun test`
// so it can succeed non-interactively. We refresh the cache here too.
export async function rearmLink(): Promise<void> {
  if (!(await refreshSudo())) {
    throw new Error(
      `sudo cache expired mid-run. Re-run 'sudo -v' and try again.`,
    );
  }
  const proc = Bun.spawn(['./scripts/armory-link.sh'], {
    cwd: REPO_ROOT,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, exit] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) {
    throw new Error(
      `armory-link.sh failed (exit ${exit}): ${stderr.trim()}`,
    );
  }
}

// Build the Rust applet on the host (cargo via root Makefile → docker/Makefile).
async function makeApplet(): Promise<void> {
  const proc = Bun.spawn(['make', 'applet'], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) {
    throw new Error(`make applet failed:\n${stdout}\n${stderr}`);
  }
}

// Upload the built applet ELF. Expected reply is "ok, rebooting", but
// the device's reset can race past nc's read so we may see exit 0 with
// empty stdout — that's still a probable success. waitForDevice is the
// real proof the upload landed.
async function uploadApplet(): Promise<string> {
  const proc = Bun.spawn(
    ['bun', 'run', 'scripts/upload.ts', 'target/armv7a-none-eabi/release/trusted_applet'],
    { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' },
  );
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) {
    throw new Error(`upload failed:\n${stdout}\n${stderr}`);
  }
  return stdout.trim();
}

// One-shot: copy an example over src/main.rs, rebuild, upload, wait for
// reboot, rearm the host IP. Called once per test file in beforeAll.
// Logs each step so failures show which phase is slow.
export async function setupApplet(name: Example): Promise<void> {
  const t0 = Date.now();
  const step = (msg: string) =>
    console.log(`[${name}] +${((Date.now() - t0) / 1000).toFixed(1)}s ${msg}`);

  step('cp examples/' + name + '/main.rs → src/main.rs');
  await $`cp examples/${name}/main.rs src/main.rs`.cwd(REPO_ROOT).quiet();

  step('make applet');
  await makeApplet();

  step('upload (~5 s)');
  await uploadApplet();

  step('wait 2 s for device reboot');
  await Bun.sleep(2000);

  step('rearm host IP');
  await rearmLink();

  step('waitForDevice');
  await waitForDevice();

  step('ready');
}

// Sanity-check the environment before touching the device. Fails loudly
// if prerequisites aren't met so participants get one actionable error
// instead of dozens of cryptic timeouts.
export async function preflight(): Promise<void> {
  // 1. sudo credential must be primed (non-interactive check).
  const sudoCheck = Bun.spawn(['sudo', '-n', 'true'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await sudoCheck.exited;
  if (sudoCheck.exitCode !== 0) {
    throw new Error(
      `sudo not primed. Run 'sudo -v' before 'bun test' so the test runner can re-arm the host IP between device reboots.`,
    );
  }

  // 2. Device must be reachable on the bridge. (Assumes the user has
  // already built, flashed, plugged, and run armory-link.sh at least once.)
  try {
    await callApplet('__probe', '', 2);
  } catch (e) {
    throw new Error(
      `Armory not reachable at ${DEVICE_HOST}:${DEVICE_PORT}. ` +
        `Did you flash the SD, set the boot switch to uSD, plug in USB, ` +
        `and run './scripts/armory-link.sh'? (last error: ${(e as Error).message})`,
    );
  }
}
