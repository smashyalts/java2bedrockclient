import { VirtualFs } from "../io/vfs.js";
import { readZipDetailed } from "../io/zip.js";
import { parseStrictJson } from "./json.js";
import { asRecord } from "./configShared.js";

/**
 * Merge several Java resource packs into one tree, the way the client would if
 * they were all enabled at once.
 *
 * Servers routinely run a stack of packs — a base pack, a furniture pack, a HUD
 * pack, a datapack's companion RP — and a Bedrock player can only be sent one.
 * Zipping them together by hand does not work: the archives collide on
 * `pack.mcmeta`, on `sounds.json`, on the atlas and font files that every pack
 * appends to, and whichever copy lands last silently deletes the others'
 * entries.
 *
 * So paths fall into two classes:
 *
 *   *Additive* files (sounds.json, lang, atlases, fonts, pack.mcmeta) are
 *   **deep merged** — every pack's entries survive. These are the ones a naive
 *   file-level merge destroys, and they are why this module exists.
 *
 *   Everything else (textures, models, item definitions) is a single asset that
 *   only one pack can own. The highest-priority pack keeps it and the collision
 *   is reported, so a texture quietly losing to another pack is visible rather
 *   than a mystery in game.
 *
 * Priority is list order, first wins — matching Minecraft, where the pack at the
 * top of the selection list overrides the ones beneath it.
 */

export interface MergeInput {
  /** Display name used in conflict reports (usually the uploaded filename). */
  name: string;
  bytes: Uint8Array;
}

export interface MergeConflict {
  path: string;
  /** Pack whose copy is in the output. */
  kept: string;
  /** Packs whose copy was dropped. */
  overridden: string[];
}

/** An additive file where a key existed in more than one pack. */
export interface MergedFile {
  path: string;
  /** How many packs contributed entries. */
  sources: number;
  /** Keys a later pack also defined, which the earlier pack's value won. */
  shadowedKeys: string[];
}

export interface MergeResult {
  vfs: VirtualFs;
  /** Entries no reader could extract, per source pack. */
  unreadable: { pack: string; name: string; reason: string }[];
  /** Source packs that could not be opened at all. */
  failedPacks: string[];
  /** Single-owner paths more than one pack supplied. */
  conflicts: MergeConflict[];
  /** Additive files combined from several packs. */
  mergedFiles: MergedFile[];
  /** Per-pack file counts, in priority order. */
  packs: { name: string; files: number }[];
}

/** One pack's contribution to an additive path. */
interface Contribution {
  pack: string;
  /** Parsed document, or undefined when the file did not parse. */
  doc: unknown;
  bytes: Uint8Array;
}

/**
 * Read and combine every pack.
 *
 * A single input is returned untouched — not even re-serialised — so a one-pack
 * conversion behaves exactly as it did before merging existed. This matters
 * because the lenient parser recovers what it can from a malformed file, and
 * writing that recovery back over the original would discard whatever it could
 * not parse before any stage ever saw it. For the same reason the multi-pack
 * path parses additive files with {@link parseStrictJson}.
 */
export function mergeJavaPacks(inputs: MergeInput[]): MergeResult {
  const result: MergeResult = {
    vfs: new VirtualFs(),
    unreadable: [],
    failedPacks: [],
    conflicts: [],
    mergedFiles: [],
    packs: [],
  };

  const opened: { name: string; vfs: VirtualFs; root: string }[] = [];
  for (const input of inputs) {
    try {
      const read = readZipDetailed(input.bytes);
      for (const entry of read.failed) {
        result.unreadable.push({ pack: input.name, name: entry.name, reason: entry.reason });
      }
      opened.push({ name: input.name, vfs: read.vfs, root: packRoot(read.vfs) });
      result.packs.push({ name: input.name, files: read.vfs.list().length });
    } catch (error) {
      result.failedPacks.push(input.name);
      result.unreadable.push({
        pack: input.name,
        name: input.name,
        reason: error instanceof Error ? error.message : "unreadable archive",
      });
    }
  }

  if (opened.length === 1) {
    result.vfs = opened[0]!.vfs;
    return result;
  }

  // path -> the packs that supplied it, in priority order. Keyed for O(1)
  // conflict lookup: two packs overriding a common base collide on thousands of
  // paths, and a linear scan of the conflict list would make that quadratic.
  const owners = new Map<string, string[]>();
  const conflicts = new Map<string, MergeConflict>();
  const additive = new Map<string, Contribution[]>();

  for (const pack of opened) {
    for (const path of pack.vfs.list()) {
      const bytes = pack.vfs.read(path);
      if (bytes === undefined) continue;
      // Packs zipped from their containing folder sit one directory deep. Strip
      // each pack's own root so every tree lands at a common one — otherwise
      // JavaPack.open resolves a single root and everything under the others is
      // invisible, with no conflict and no error to show for it.
      if (!path.startsWith(pack.root)) continue;
      const rel = path.slice(pack.root.length);
      if (rel === "") continue;

      if (isAdditive(rel)) {
        const list = additive.get(rel) ?? [];
        list.push({ pack: pack.name, doc: parseStrictJson(pack.vfs.readText(path) ?? ""), bytes });
        additive.set(rel, list);
        continue;
      }

      const seen = owners.get(rel);
      if (seen === undefined) {
        owners.set(rel, [pack.name]);
        result.vfs.write(rel, bytes);
        continue;
      }
      // A later pack lost this path; record it unless it is byte-identical
      // (packs sharing a common upstream asset is not a conflict).
      seen.push(pack.name);
      const existing = result.vfs.read(rel);
      if (existing !== undefined && !sameBytes(existing, bytes)) {
        recordConflict(conflicts, rel, seen[0]!, pack.name);
      }
    }
  }

  // Combine the additive files now that every contributor is known.
  const encoder = new TextEncoder();
  for (const [path, contributions] of additive) {
    const first = contributions[0]!;
    if (contributions.length === 1) {
      // Sole contributor: keep its bytes verbatim rather than round-tripping
      // through the parser.
      result.vfs.write(path, first.bytes);
      continue;
    }
    // A file we cannot parse cannot be merged, so the path falls back to
    // single-owner semantics — first pack wins, and the rest are reported.
    // Without this a later pack's parsed copy would overwrite an earlier
    // pack's unparseable one, inverting priority silently.
    const unparsed = contributions.filter((c) => c.doc === undefined);
    if (unparsed.length > 0) {
      result.vfs.write(path, first.bytes);
      for (const loser of contributions.slice(1)) {
        if (!sameBytes(first.bytes, loser.bytes)) {
          recordConflict(conflicts, path, first.pack, loser.pack);
        }
      }
      continue;
    }

    const shadowed: string[] = [];
    const combined = mergeAdditive(path, contributions.map((c) => c.doc), shadowed);
    result.vfs.write(path, encoder.encode(JSON.stringify(combined)));
    result.mergedFiles.push({ path, sources: contributions.length, shadowedKeys: shadowed });
  }

  result.conflicts = [...conflicts.values()];
  return result;
}

function recordConflict(
  conflicts: Map<string, MergeConflict>,
  path: string,
  kept: string,
  overridden: string,
): void {
  const existing = conflicts.get(path);
  if (existing === undefined) conflicts.set(path, { path, kept, overridden: [overridden] });
  else existing.overridden.push(overridden);
}

/**
 * Where this pack's root sits inside its archive, mirroring
 * {@link JavaPack.open}: "" normally, or "Folder/" when the pack was zipped
 * from its containing directory.
 */
function packRoot(vfs: VirtualFs): string {
  if (vfs.has("pack.mcmeta")) return "";
  const candidates = new Set<string>();
  for (const path of vfs.list({ suffix: "pack.mcmeta" })) {
    const parts = path.split("/");
    if (parts.length === 2 && parts[1] === "pack.mcmeta") candidates.add(parts[0]! + "/");
  }
  return candidates.size === 1 ? [...candidates][0]! : "";
}

/**
 * Files every pack appends to rather than owns. Overwriting one of these drops
 * the other packs' entries entirely — a pack's sounds go silent, its glyphs
 * vanish, its atlas sources stop being stitched.
 */
function isAdditive(path: string): boolean {
  if (path === "pack.mcmeta" || path.endsWith("/pack.mcmeta")) return true;
  if (!path.endsWith(".json")) return false;
  return (
    /(?:^|\/)assets\/[^/]+\/sounds\.json$/.test(path) ||
    /(?:^|\/)assets\/[^/]+\/lang\/[^/]+\.json$/.test(path) ||
    /(?:^|\/)assets\/[^/]+\/atlases\/[^/]+\.json$/.test(path) ||
    /(?:^|\/)assets\/[^/]+\/font\/[^/]+\.json$/.test(path)
  );
}

/** Dispatch an additive path to the merge its schema needs. */
function mergeAdditive(path: string, docs: unknown[], shadowed: string[]): unknown {
  if (path === "pack.mcmeta" || path.endsWith("/pack.mcmeta")) return mergePackMeta(docs);
  if (/(?:^|\/)assets\/[^/]+\/atlases\//.test(path)) return mergeListField(docs, "sources");
  if (/(?:^|\/)assets\/[^/]+\/font\//.test(path)) return mergeListField(docs, "providers");
  // sounds.json and lang: flat key -> value maps; first pack wins a shared key.
  return mergeKeys(docs, shadowed);
}

/**
 * Shallow key union, first contributor winning a duplicate key. Shared keys are
 * recorded: they are a real (if small) loss, and the report must not claim
 * every pack's entries survived when one pack's value was dropped.
 */
function mergeKeys(docs: unknown[], shadowed: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const doc of docs) {
    const obj = asRecord(doc);
    if (obj === undefined) continue;
    for (const [key, value] of Object.entries(obj)) {
      if (key in out) {
        if (!shadowed.includes(key)) shadowed.push(key);
        continue;
      }
      out[key] = value;
    }
  }
  return out;
}

/**
 * Concatenate one array field across packs (atlas `sources`, font `providers`),
 * dropping entries that are structurally identical so a shared upstream file
 * does not get stitched or drawn twice.
 */
function mergeListField(docs: unknown[], field: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const items: unknown[] = [];
  const seen = new Set<string>();
  for (const doc of docs) {
    const obj = asRecord(doc);
    if (obj === undefined) continue;
    for (const [key, value] of Object.entries(obj)) {
      if (key !== field && !(key in out)) out[key] = value;
    }
    const list = obj[field];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const fingerprint = JSON.stringify(entry);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      items.push(entry);
    }
  }
  out[field] = items;
  return out;
}

/**
 * Combine pack.mcmeta.
 *
 * Every top-level section is carried over (`language`, `filter`, … — not just
 * `pack` and `overlays`), overlay entries are unioned by directory since each
 * pack brings its own, and the declared format range only ever widens: the
 * merged pack must still load on every client any input pack supported. A pack
 * that declares `supported_formats` gets that range honoured rather than having
 * it recomputed from `pack_format` alone, which would narrow it.
 */
function mergePackMeta(docs: unknown[]): unknown {
  const out: Record<string, unknown> = {};
  const packSection: Record<string, unknown> = {};
  const overlays: unknown[] = [];
  const overlayDirs = new Set<string>();
  let format: number | undefined;
  let min: number | undefined;
  let max: number | undefined;

  for (const doc of docs) {
    const obj = asRecord(doc);
    if (obj === undefined) continue;
    for (const [key, value] of Object.entries(obj)) {
      if (key !== "pack" && key !== "overlays" && !(key in out)) out[key] = value;
    }
    const pack = asRecord(obj["pack"]);
    if (pack !== undefined) {
      for (const [key, value] of Object.entries(pack)) {
        if (!(key in packSection)) packSection[key] = value;
      }
      const declared = formatRange(pack);
      format = pickMax(format, pack["pack_format"]);
      min = pickMin(min, declared.min);
      max = pickMax(max, declared.max);
    }
    const entries = asRecord(obj["overlays"])?.["entries"];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const dir = asRecord(entry)?.["directory"];
      if (typeof dir !== "string" || overlayDirs.has(dir)) continue;
      overlayDirs.add(dir);
      overlays.push(entry);
    }
  }

  if (format !== undefined) packSection["pack_format"] = format;
  if (min !== undefined) packSection["min_format"] = min;
  if (max !== undefined) packSection["max_format"] = max;
  // supported_formats has to agree with the widened range, or the client
  // rejects the pack on the versions the range just gained.
  if (min !== undefined && max !== undefined) packSection["supported_formats"] = [min, max];

  out["pack"] = packSection;
  if (overlays.length > 0) out["overlays"] = { entries: overlays };
  return out;
}

/**
 * The format range one pack declares. `supported_formats` may be a two-element
 * array or an object with `min_inclusive`/`max_inclusive`; either way it is
 * authoritative and wider than `pack_format` alone.
 */
function formatRange(pack: Record<string, unknown>): { min?: number; max?: number } {
  let min = numberOf(pack["min_format"]);
  let max = numberOf(pack["max_format"]);
  const supported = pack["supported_formats"];
  if (Array.isArray(supported) && supported.length === 2) {
    min = pickMin(min, supported[0]);
    max = pickMax(max, supported[1]);
  } else {
    const range = asRecord(supported);
    if (range !== undefined) {
      min = pickMin(min, range["min_inclusive"]);
      max = pickMax(max, range["max_inclusive"]);
    } else {
      const single = numberOf(supported);
      if (single !== undefined) {
        min = pickMin(min, single);
        max = pickMax(max, single);
      }
    }
  }
  const format = numberOf(pack["pack_format"]);
  return { min: pickMin(min, format), max: pickMax(max, format) };
}

function numberOf(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function pickMax(current: number | undefined, raw: unknown): number | undefined {
  const value = numberOf(raw);
  if (value === undefined) return current;
  return current === undefined ? value : Math.max(current, value);
}

function pickMin(current: number | undefined, raw: unknown): number | undefined {
  const value = numberOf(raw);
  if (value === undefined) return current;
  return current === undefined ? value : Math.min(current, value);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
