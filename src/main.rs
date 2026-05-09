#![no_std]
#![no_main]

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

static DEVICE_SECRET: &[u8] = b"hackathon-demo-key-32bytes!!!!";

/// Tiny hex encoder for no_std
fn hex_encode(input: &[u8], out: &mut [u8]) -> usize {
    const HEX: &[u8; 16] = b"0123456789abcdef";

    let mut j = 0;

    for &b in input {
        if j + 2 > out.len() {
            break;
        }

        out[j] = HEX[(b >> 4) as usize];
        out[j + 1] = HEX[(b & 0x0f) as usize];

        j += 2;
    }

    j
}

/// Sign inference payload: HMAC-SHA256 over the exact UTF-8 `Input` string.
///
/// Input example:
///   my_sealed_sky_message|123456|0xabc
fn sign_inference(input: &[u8], out: &mut [u8]) -> usize {
    let mut mac = HmacSha256::new_from_slice(DEVICE_SECRET).expect("HMAC accepts any key size");
    mac.update(input);
    let result = mac.finalize().into_bytes();
    hex_encode(result.as_slice(), out)
}

fn handle(method: &str, input: &[u8], out: &mut [u8]) -> usize {
    match method {
        // -----------------------------------------
        // Echo
        // -----------------------------------------

        "Echo" => {
            let n = input.len().min(out.len());

            out[..n].copy_from_slice(&input[..n]);

            n
        }

        // -----------------------------------------
        // Trusted AI inference signing
        // -----------------------------------------

        "SignInference" => sign_inference(input, out),

        // -----------------------------------------
        // Unknown method
        // -----------------------------------------

        _ => {
            let msg = b"unknown_method";

            let n = msg.len().min(out.len());

            out[..n].copy_from_slice(&msg[..n]);

            n
        }
    }
}

#[no_mangle]
pub extern "C" fn _start() -> ! {
    gotee_syscall::serve(handle)
}