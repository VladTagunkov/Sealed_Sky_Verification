// One-shot CLI uploader — pushes a new Trusted Applet ELF to the device
// over the bridge. The Trusted OS persists it to SD and reboots; on the
// next boot the new applet is live.
//
//   bun run upload target/armv7a-none-eabi/release/trusted_applet

const path = Bun.argv[2];
if (!path) {
  console.error('usage: upload.ts <path/to/trusted_applet.elf>');
  process.exit(2);
}

const DEVICE_HOST = Bun.env.DEVICE_HOST ?? '10.0.0.1';
const DEVICE_PORT = Number(Bun.env.DEVICE_PORT ?? 4000);

const elf = await Bun.file(path).bytes();
const payload =
  JSON.stringify({
    Method: '__upload',
    Input: Buffer.from(elf).toString('base64'),
  }) + '\n';

const proc = Bun.spawn(['nc', '-w', '10', DEVICE_HOST, String(DEVICE_PORT)], {
  stdin: 'pipe',
  stdout: 'pipe',
  stderr: 'pipe',
});
proc.stdin.write(payload);
await proc.stdin.end();

const [stdout, stderr, exit] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);

// Expected reply is "ok, rebooting". The device's reset can race past
// nc's read, so we often see no reply even though the upload landed.
// BSD nc (macOS) exits 0 in that case; openbsd-netcat (Linux) exits 1.
// Treat both as probable success and only fail loud on real TCP-level
// errors (connect refused / host unreachable / no route).
const connFailed = /refused|unreachable|no route|name or service/i.test(stderr);
if (connFailed) {
  console.error('upload failed:', stderr.trim());
  process.exit(1);
}

const reply = stdout.trim();
if (reply) {
  console.log(reply);
} else {
  console.log(`ok, probably rebooting (no reply captured; nc exited ${exit})`);
  console.log('  verify in ~8s after re-running ./scripts/armory-link.sh:');
  console.log('    printf \'{"Method":"__probe","Input":""}\\n\' | nc -w 2 10.0.0.1 4000');
  console.log('  any reply (even {"Output":""}) means the device is back up.');
}
