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

export function resourceLocationToString(loc: ResourceLocation): string {
  return `${loc.namespace}:${loc.path}`;
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
    const out = new Set<string>();
    for (const path of this.vfs.list({ prefix: this.root + "assets/" })) {
      const rest = path.slice((this.root + "assets/").length);
      const ns = rest.split("/")[0];
      if (ns) out.add(ns);
    }
    return [...out].sort();
  }

  /** Read a file relative to the pack root. */
  read(relPath: string): Uint8Array | undefined {
    return this.vfs.read(this.root + relPath);
  }

  readText(relPath: string): string | undefined {
    return this.vfs.readText(this.root + relPath);
  }

  readJson<T = unknown>(relPath: string): T | undefined {
    const text = this.readText(relPath);
    return text !== undefined ? parseLenientJson<T>(text) : undefined;
  }

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
    return `assets/${loc.namespace}/${category}/${loc.path}${ext}`;
  }
}
