/** Readable random password (no 0/O/1/l/I), 12 characters, from the platform's secure RNG. */
export function generatePassword(length = 12): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  // Guarantee at least one digit so it never looks like a plain word.
  if (!/\d/.test(out)) out = out.slice(0, -1) + String(2 + (bytes[0] % 8));
  return out;
}
