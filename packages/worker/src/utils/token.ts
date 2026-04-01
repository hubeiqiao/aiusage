interface TokenPayload {
  siteId: string;
  deviceId: string;
  tokenVersion: number;
  issuedAt: string;
}

export async function signDeviceToken(payload: TokenPayload, secret: string): Promise<string> {
  const data = JSON.stringify(payload);
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const b64Payload = btoa(data);
  const b64Sig = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return `dtok_${b64Payload}.${b64Sig}`;
}

export async function verifyDeviceToken(token: string, secret: string): Promise<TokenPayload | null> {
  if (!token.startsWith('dtok_')) return null;
  const raw = token.slice(5);
  const dotIndex = raw.lastIndexOf('.');
  if (dotIndex === -1) return null;

  const b64Payload = raw.slice(0, dotIndex);
  const b64Sig = raw.slice(dotIndex + 1);

  const data = atob(b64Payload);
  const key = await importKey(secret);
  const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sig = Uint8Array.from(atob(b64Sig), c => c.charCodeAt(0));

  if (!timingSafeEqual(new Uint8Array(expected), sig)) return null;

  try {
    return JSON.parse(data) as TokenPayload;
  } catch {
    return null;
  }
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}
