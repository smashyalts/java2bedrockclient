import { fastHashString } from "./hash.js";

/**
 * Bedrock warns on every pack file whose path reaches 80 characters ("this will
 * cause problems on some Bedrock platforms") and some platforms fail to read
 * them at all, so no path we generate may reach it.
 *
 * The squeeze comes from the name in the middle: plugins that obfuscate their
 * pack replace model ids with UUIDs (Nexo ships `nexo:0c702f35-4d5e-4593-b3c8-
 * 8efed2ddd7a7`), which alone is 41 characters once `safeName` has run — more
 * than the folder and suffix around it leave room for.
 */
export const MAX_PACK_PATH = 79;

/** Hex characters of name hash appended when a name has to be cut. */
const HASH_CHARS = 8;

/**
 * Shorten a generated name so `reserved + name` stays under
 * {@link MAX_PACK_PATH}, where `reserved` is the length of the longest path
 * the name is interpolated into, minus the name itself.
 *
 * The readable head is kept and a hash of the *full* name is appended, so names
 * that share a prefix — exactly the UUID case — can't collide once truncated.
 * Names that already fit are returned untouched, so ordinary packs keep their
 * descriptive file names.
 */
export function fitPathName(name: string, reserved: number): string {
  const budget = MAX_PACK_PATH - reserved;
  if (name.length <= budget) return name;
  const hash = fastHashString(name).slice(0, HASH_CHARS);
  // Pathologically small budget (a template with almost no room): the hash
  // alone still identifies the name uniquely.
  if (budget <= hash.length + 1) return hash.slice(0, Math.max(1, budget));
  return name.slice(0, budget - hash.length - 1).replace(/_+$/, "") + "_" + hash;
}

/**
 * Build `<dir><name><suffix>` for a file Bedrock locates by the identifier
 * *inside* it — animations, geometries, render controllers and attachables are
 * all found by scanning their folder and reading the id, so their file names
 * only have to be unique. Shortening here keeps the model name intact
 * everywhere it's actually referenced (texture paths, geometry ids), instead of
 * cutting it back to whatever the longest file name template allows.
 *
 * `dir` must end with `/` and `suffix` must start with `.`.
 */
export function fitFilePath(dir: string, name: string, suffix: string): string {
  return dir + fitPathName(name, dir.length + suffix.length) + suffix;
}
