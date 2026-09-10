/**
 * Fast non-cryptographic content hash for dedup keys. Two independent FNV-1a
 * lanes give a 64-bit digest — collision odds across a pack's textures are
 * ~1e-12, so we skip a cryptographic hash (sha256 cost ~12s on a large pack).
 * Dedup only needs "same bytes → same key", not tamper resistance.
 */
export function fastHash(data: Uint8Array): string {
  let h1 = 0x811c9dc5 ^ data.length;
  let h2 = 0xc2b2ae35 ^ data.length;
  // One byte at a time, deliberately. A 32-bit-word "fast path" used to sit
  // here, but it performed the same eight Math.imul calls per four bytes as
  // this loop — no speedup, in exchange for a typed-array view allocation, an
  // alignment branch that silently fell back on unaligned Buffer slices, and a
  // byte order that only matched this loop on little-endian hosts.
  for (let i = 0; i < data.length; i++) {
    const b = data[i]!;
    h1 = Math.imul(h1 ^ b, 0x01000193);
    h2 = Math.imul(h2 ^ b, 0x85ebca77);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/** {@link fastHash} over a string's UTF-8 bytes — for name/path keys. */
export function fastHashString(text: string): string {
  return fastHash(new TextEncoder().encode(text));
}
