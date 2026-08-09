import { VirtualFs } from "../io/vfs.js";
import { parseLenientJson } from "./json.js";

export interface PackMcmeta {
  pack?: {
    pack_format?: number;
    description?: unknown;
  };
}

/** A parsed resource location like "minecraft:item/stick". */
export interface ResourceLocation {
  namespace: string;
  path: string;
}

export function parseResourceLocation(id: string, defaultNamespace = "minecraft"): ResourceLocation {
  const idx = id.indexOf(":");
  if (idx === -1) return { namespace: defaultNamespace, path: id };
  return { namespace: id.slice(0, idx), path: id.slice(idx + 1) };
}

/**
 * Indexed view over a Java resource pack living in a VirtualFs.
 * Handles packs that are nested one directory deep inside the zip
 * (common when people zip the containing folder).
 */
export class JavaPack {
  readonly vfs: VirtualFs;
  /** Prefix inside the zip where the pack root lives ("" or "SomeFolder/"). */
  readonly root: string;
  readonly mcmeta: PackMcmeta | undefined;
  readonly packFormat: number;
  /** Sorted namespace list — recomputing it walks every path in the pack. */
  private cachedNamespaces: string[] | undefined;

  private constructor(vfs: VirtualFs, root: string) {
    this.vfs = vfs;
    this.root = root;
    const raw = vfs.readText(root + "pack.mcmeta");
    this.mcmeta = raw !== undefined ? parseLenientJson<PackMcmeta>(raw) : undefined;
    this.packFormat = this.mcmeta?.pack?.pack_format ?? 0;
  }

  static open(vfs: VirtualFs): JavaPack {
    if (vfs.has("pack.mcmeta")) return new JavaPack(vfs, "");
    // Look for a single-level nested root.
    const candidates = new Set<string>();
    for (const path of vfs.list({ suffix: "pack.mcmeta" })) {
      const parts = path.split("/");
      if (parts.length === 2) candidates.add(parts[0]! + "/");
    }
    if (candidates.size === 1) {
      return new JavaPack(vfs, [...candidates][0]!);
    }
    // Fall back: treat as root even without pack.mcmeta (some packs omit it).
    return new JavaPack(vfs, "");
  }

  /** Namespaces present under assets/. */
  namespaces(): string[] {
    if (this.cachedNamespaces !== undefined) return this.cachedNamespaces;
    const out = new Set<string>();
    for (const path of this.vfs.list({ prefix: this.root + "assets/" })) {
      const rest = path.slice((this.root + "assets/").length);
      const ns = rest.split("/")[0];
      if (ns) out.add(ns);
    }
    this.cachedNamespaces = [...out].sort();
    return this.cachedNamespaces;
  }

  /** Read a file relative to the pack root. */
  read(relPath: string): Uint8Array | undefined {
    return this.vfs.read(this.root + relPath);
  }

  readText(relPath: string): string | undefined {
    return this.vfs.readText(this.root + relPath);
  }

  readJson<T = unknown>(relPath: string): T | undefined {
    // Memoize parses: the pack is read-only during conversion, and the same
    // model/items JSON is read by several passes (bow-pull detection, variant
    // extraction, parent-chain resolution). Callers must treat the result as
    // immutable — it's shared across those readers.
    if (this.jsonCache.has(relPath)) return this.jsonCache.get(relPath) as T | undefined;
    const text = this.readText(relPath);
    const value = text !== undefined ? parseLenientJson<T>(text) : undefined;
    this.jsonCache.set(relPath, value);
    return value;
  }
  private readonly jsonCache = new Map<string, unknown>();

  has(relPath: string): boolean {
    return this.vfs.has(this.root + relPath);
  }

  /** List paths relative to the pack root. */
  list(options?: { prefix?: string; suffix?: string }): string[] {
    const prefix = this.root + (options?.prefix ?? "");
    return this.vfs
      .list({ prefix, suffix: options?.suffix })
      .map((p) => p.slice(this.root.length));
  }

  /** Resolve "ns:path" within a category, e.g. texture("minecraft:item/stick") → assets path. */
  assetPath(category: "textures" | "models" | "items" | "equipment", id: string, ext: string): string {
    const loc = parseResourceLocation(id);
    const path = `assets/${loc.namespace}/${category}/${loc.path}${ext}`;
    if (category !== "textures" || this.vfs.has(this.root + path)) return path;
    // Sprite aliases: an atlas may publish a texture under a different name
    // (`{"type":"single","resource":"set:foo","sprite":"ia:12"}`), and models
    // then reference the alias. ItemsAdder does this for every custom texture,
    // so without this the whole pack resolves to missing textures.
    const target = this.spriteAliases().get(`${loc.namespace}:${loc.path}`);
    if (target === undefined) return path;
    const alias = parseResourceLocation(target);
    return `assets/${alias.namespace}/${category}/${alias.path}${ext}`;
  }

  /** Sprite alias → real texture id, collected from every atlas in the pack. */
  private spriteAliases(): Map<string, string> {
    if (this.aliasCache !== undefined) return this.aliasCache;
    const aliases = new Map<string, string>();
    for (const path of this.list({ suffix: ".json" })) {
      if (!/^assets\/[^/]+\/atlases\//.test(path)) continue;
      const atlas = this.readJson<{ sources?: { type?: string; resource?: string; sprite?: string }[] }>(path);
      for (const source of atlas?.sources ?? []) {
        if (source.type !== "single" || source.resource === undefined) continue;
        if (source.sprite === undefined || source.sprite === source.resource) continue;
        const sprite = parseResourceLocation(source.sprite);
        aliases.set(`${sprite.namespace}:${sprite.path}`, source.resource);
      }
    }
    this.aliasCache = aliases;
    return aliases;
  }
  private aliasCache: Map<string, string> | undefined;
}
