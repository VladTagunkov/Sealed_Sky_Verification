import { beforeAll, describe, expect, test } from 'bun:test';
import { callApplet, preflight, setupApplet } from '../../scripts/test-helpers';

// The Attest applet passes the raw JSON-RPC reply from the Trusted OS
// back to the host verbatim. Shape (on real hardware):
//   {"id":1,"result":{"DerivedKey":"<base64>","Error":""},"error":null}
// On emulation (or no crypto engine) the result has Error set instead.
function parseAttest(raw: string): { key: string; error: string } {
  const rpc = JSON.parse(raw);
  const result = rpc.result ?? {};
  return {
    key: result.DerivedKey ?? '',   // base64 (Go's default []byte encoding)
    error: result.Error ?? '',
  };
}

describe('Attestation applet', () => {
  beforeAll(async () => {
    await preflight();
    await setupApplet('attestation');
  }, 120_000);

  test('returns a non-empty DerivedKey on real hardware', async () => {
    const raw = await callApplet('Attest', '');
    const { key, error } = parseAttest(raw);
    expect(error).toBe('');
    expect(key).not.toBe('');
    // Base64 of at least 16 bytes (DCP) / 32 bytes (CAAM).
    expect(key.length).toBeGreaterThanOrEqual(16);
  });

  test('DerivedKey is not all zeros', async () => {
    const raw = await callApplet('Attest', '');
    const { key } = parseAttest(raw);
    const bytes = Buffer.from(key, 'base64');
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.every((b) => b === 0)).toBe(false);
  });

  test('two successive calls return the same DerivedKey (deterministic)', async () => {
    const a = parseAttest(await callApplet('Attest', ''));
    const b = parseAttest(await callApplet('Attest', ''));
    expect(a.key).toBe(b.key);
  });
});
