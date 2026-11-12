/**
 * Web Crypto API PBKDF2 + AES-GCM 256-bit Encryption
 * Zero external npm dependencies.
 */

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes.buffer;
}

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function deriveKey(pinOrPass: string, saltBuffer: ArrayBuffer): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(pinOrPass),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBuffer,
      iterations: 100000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptPayload(
  payloadText: string,
  pinOrPass: string
): Promise<{ ciphertext: string; salt: string; iv: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pinOrPass, salt.buffer);

  const enc = new TextEncoder();
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(payloadText)
  );

  return {
    ciphertext: bufferToBase64(cipherBuffer),
    salt: bufferToHex(salt.buffer),
    iv: bufferToHex(iv.buffer),
  };
}

export async function decryptPayload(
  ciphertextBase64: string,
  pinOrPass: string,
  saltHex: string,
  ivHex: string
): Promise<string> {
  const salt = hexToBuffer(saltHex);
  const iv = hexToBuffer(ivHex);
  const key = await deriveKey(pinOrPass, salt);
  const cipherBuffer = base64ToBuffer(ciphertextBase64);

  try {
    const plainBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(iv) },
      key,
      cipherBuffer
    );
    const dec = new TextDecoder();
    return dec.decode(plainBuffer);
  } catch {
    throw new Error('Incorrect decryption PIN or corrupted backup file.');
  }
}
