import { load } from "js-yaml";
import { readZipDetailed } from "../io/zip.js";

/**
 * Extracts base-item hints from item-plugin server config YAMLs.
 *
 * Oraxen/Nexo (plugins/Oraxen/items/*.yml):
 *   ruby_sword:
 *     displayname: "&cRuby Sword"
 *     material: DIAMOND_SWORD
 *     Pack: { ... }
 *
 * ItemsAdder (plugins/ItemsAdder/contents/&lt;ns&gt;/configs/*.yml):
 *   info:
 *     namespace: myitems
 *   items:
 *     ruby_sword:
 *       resource:
 *         material: DIAMOND_SWORD
 *         model_path: item/ruby_sword
 *
 * The item key doubles as the item-model / model name, and the material is
 * the vanilla item the server actually gives players — exactly the "host
 * item" our Geyser mappings need, so parsing these files removes manual
 * per-item base assignment entirely.
 */
export interface OraxenHints {
  /** item key (e.g. "ruby_sword") → java item id (e.g. "minecraft:diamond_sword"). */
  baseItems: Record<string, string>;
  /** item key → display name from the config (colour codes stripped). */
  displayNames: Record<string, string>;
  /** item key → equippable armor link from the config. */
  equippables: Record<string, { asset: string; slot: string }>;
  /** "minecraft:material|cmd" → item key (for packs dispatching on custom_model_data). */
  cmdKeys: Record<string, string>;
  /** yml files parsed / items discovered, for reporting. */
  files: number;
  items: number;
}

export function parseOraxenConfigZip(zipBytes: Uint8Array): OraxenHints {
  const { vfs } = readZipDetailed(zipBytes);
  const hints: OraxenHints = { baseItems: {}, displayNames: {}, equippables: {}, cmdKeys: {}, files: 0, items: 0 };

  for (const path of vfs.list({ suffix: ".yml" })) {
    const text = vfs.readText(path);
    if (text === undefined) continue;
    let doc: unknown;
    try {
      doc = load(text);
    } catch {
      continue; // not our yml / template with invalid syntax
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) continue;
    const root = doc as Record<string, unknown>;

    let found = 0;
    const register = (key: string, value: unknown): void => {
      const material = extractMaterial(value);
      if (material === undefined) return;
      const base = `minecraft:${material.toLowerCase()}`;
      const lowerKey = key.toLowerCase();
      hints.baseItems[lowerKey] = base;
      const displayName = extractDisplayName(value);
      if (displayName !== undefined) hints.displayNames[lowerKey] = displayName;
      const equippable = extractEquippable(value);
      if (equippable !== undefined) hints.equippables[lowerKey] = equippable;
      const cmd = extractCmd(value);
      if (cmd !== undefined) hints.cmdKeys[`${base}|${cmd}`] = lowerKey;
      found++;
      // Model-id overrides (Oraxen Components.item_model / Pack.model,
      // ItemsAdder resource.model_path) — register those names too.
      for (const alias of extractModelAliases(value)) {
        hints.baseItems[alias] = base;
        if (displayName !== undefined) hints.displayNames[alias] = displayName;
      }
    };

    // ItemsAdder layout: items live under an "items" section.
    const iaItems = root["items"];
    if (iaItems !== null && typeof iaItems === "object" && !Array.isArray(iaItems)) {
      for (const [key, value] of Object.entries(iaItems as Record<string, unknown>)) {
        register(key, value);
      }
    }
    // Oraxen/Nexo layout: items are top-level keys.
    for (const [key, value] of Object.entries(root)) {
      if (key === "items" || key === "info") continue;
      register(key, value);
    }

    if (found > 0) {
      hints.files++;
      hints.items += found;
    }
  }
  return hints;
}

function extractMaterial(item: unknown): string | undefined {
  if (item === null || typeof item !== "object") return undefined;
  const obj = item as Record<string, unknown>;
  // Oraxen/Nexo: top-level material. ItemsAdder: resource.material.
  let material = obj["material"];
  if (material === undefined) {
    const resource = obj["resource"];
    if (resource !== null && typeof resource === "object") {
      material = (resource as Record<string, unknown>)["material"];
      // ItemsAdder defaults to PAPER when a generated item omits material.
      if (material === undefined && (resource as Record<string, unknown>)["generate"] === true) {
        material = "PAPER";
      }
    }
  }
  return typeof material === "string" && /^[A-Za-z_]+$/.test(material) ? material : undefined;
}

function extractModelAliases(item: unknown): string[] {
  const aliases: string[] = [];
  if (item === null || typeof item !== "object") return aliases;
  const obj = item as Record<string, unknown>;
  const components = obj["Components"];
  if (components !== null && typeof components === "object") {
    const itemModel = (components as Record<string, unknown>)["item_model"];
    if (typeof itemModel === "string") aliases.push(stripNamespace(itemModel));
  }
  const pack = obj["Pack"];
  if (pack !== null && typeof pack === "object") {
    const model = (pack as Record<string, unknown>)["model"];
    if (typeof model === "string") aliases.push(stripNamespace(model));
  }
  // ItemsAdder: resource.model_path ("item/ruby_sword") — register the last
  // path segment, which is how models are matched against hints.
  const resource = obj["resource"];
  if (resource !== null && typeof resource === "object") {
    const modelPath = (resource as Record<string, unknown>)["model_path"];
    if (typeof modelPath === "string") {
      const last = modelPath.split("/").pop();
      if (last) aliases.push(stripNamespace(last));
    }
  }
  return aliases;
}

function stripNamespace(id: string): string {
  const idx = id.indexOf(":");
  return (idx === -1 ? id : id.slice(idx + 1)).toLowerCase();
}

/** Pack.custom_model_data (Oraxen/Nexo) — links cmd-dispatched items to their config key. */
function extractCmd(item: unknown): number | undefined {
  if (item === null || typeof item !== "object") return undefined;
  const pack = (item as Record<string, unknown>)["Pack"];
  if (pack === null || typeof pack !== "object") return undefined;
  const cmd = (pack as Record<string, unknown>)["custom_model_data"];
  return typeof cmd === "number" ? cmd : undefined;
}

/** Components.equippable (slot + asset_id / model) — the armor-set link. */
function extractEquippable(item: unknown): { asset: string; slot: string } | undefined {
  if (item === null || typeof item !== "object") return undefined;
  const components = (item as Record<string, unknown>)["Components"];
  if (components === null || typeof components !== "object") return undefined;
  const equippable = (components as Record<string, unknown>)["equippable"];
  if (equippable === null || typeof equippable !== "object") return undefined;
  const eq = equippable as Record<string, unknown>;
  const asset = eq["asset_id"] ?? eq["model"];
  const slot = eq["slot"];
  if (typeof asset !== "string" || typeof slot !== "string") return undefined;
  return { asset: stripNamespace(asset), slot: slot.toLowerCase() };
}

/** Oraxen `displayname` / Nexo `customname` / ItemsAdder `display_name`, colour codes stripped. */
function extractDisplayName(item: unknown): string | undefined {
  if (item === null || typeof item !== "object") return undefined;
  const obj = item as Record<string, unknown>;
  const raw = obj["displayname"] ?? obj["customname"] ?? obj["display_name"] ?? obj["itemname"];
  if (typeof raw !== "string") return undefined;
  const stripped = raw
    .replace(/[§&][0-9a-fk-orx]/gi, "") // legacy colour codes
    .replace(/<[^<>]+>/g, "") // MiniMessage tags
    .trim();
  return stripped.length > 0 ? stripped : undefined;
}
