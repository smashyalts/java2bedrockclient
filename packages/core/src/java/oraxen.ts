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
  /**
   * item key → fixed dye colour (0xRRGGBB) from the config (leather armor,
   * potions). Java applies it server-side; Bedrock icons need it baked in.
   */
  colors: Record<string, number>;
  /** "minecraft:material|cmd" → item key (for packs dispatching on custom_model_data). */
  cmdKeys: Record<string, string>;
  /**
   * Item keys worn as back cosmetics (HMCCosmetics BACKPACK entries — armor
   * stand head items that Bedrock renders lower than Java).
   */
  backpacks: string[];
  /**
   * Item keys placed in the world as furniture (Oraxen/Nexo Mechanics.furniture,
   * ItemsAdder behaviours.furniture) — display-entity items that need the
   * GeyserDisplayEntity extension to show on Bedrock.
   */
  furniture: string[];
  /** yml files parsed / items discovered, for reporting. */
  files: number;
  items: number;
}

export function parseOraxenConfigZip(zipBytes: Uint8Array): OraxenHints {
  return parseOraxenConfigZips([zipBytes]);
}

/**
 * Parse any number of plugin config zips (Nexo/Oraxen items, ItemsAdder
 * contents, HMCCosmetics cosmetics — in any combination and order) into one
 * merged hint set. Cross-zip references (an HMCC backpack pointing at a Nexo
 * item by material+cmd) resolve after all files are read.
 */
export function parseOraxenConfigZips(zips: Uint8Array[]): OraxenHints {
  const hints: OraxenHints = {
    baseItems: {},
    displayNames: {},
    equippables: {},
    colors: {},
    cmdKeys: {},
    backpacks: [],
    furniture: [],
    files: 0,
    items: 0,
  };
  const backpackSet = new Set<string>();
  const furnitureSet = new Set<string>();
  for (const zipBytes of zips) {
    parseOne(zipBytes, hints, backpackSet, furnitureSet);
  }
  // Resolve material+cmd backpack refs now that every item is known.
  for (const ref of backpackSet) {
    if (ref.includes("|") && hints.cmdKeys[ref] !== undefined) backpackSet.add(hints.cmdKeys[ref]!);
  }
  hints.backpacks = [...backpackSet].filter((k) => !k.includes("|"));
  hints.furniture = [...furnitureSet];
  return hints;
}

function parseOne(
  zipBytes: Uint8Array,
  hints: OraxenHints,
  backpackSet: Set<string>,
  furnitureSet: Set<string>,
): void {
  const { vfs } = readZipDetailed(zipBytes);

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
      const color = extractColor(value);
      if (color !== undefined) hints.colors[lowerKey] = color;
      const cmd = extractCmd(value);
      if (cmd !== undefined) {
        hints.cmdKeys[`${base}|${cmd}`] = lowerKey;
        // Resolve cmd-style backpack refs (HMCC "material + model-data" form).
        if (backpackSet.has(`${base}|${cmd}`)) backpackSet.add(lowerKey);
      }
      found++;
      const isFurniture = extractIsFurniture(value);
      if (isFurniture) furnitureSet.add(lowerKey);
      // Model-id overrides (Oraxen Components.item_model / Pack.model,
      // ItemsAdder resource.model_path) — register those names too.
      for (const alias of extractModelAliases(value)) {
        hints.baseItems[alias] = base;
        if (displayName !== undefined) hints.displayNames[alias] = displayName;
        if (isFurniture) furnitureSet.add(alias);
        if (color !== undefined) hints.colors[alias] = color;
      }
    };

    // HMCCosmetics layout: entries with type/slot BACKPACK reference an item
    // (often a Nexo/Oraxen key via "material: nexo:<key>" or an ItemsAdder id).
    for (const value of Object.values(root)) {
      if (value === null || typeof value !== "object") continue;
      const obj = value as Record<string, unknown>;
      const kind = obj["type"] ?? obj["slot"];
      if (typeof kind !== "string" || !kind.toUpperCase().includes("BACKPACK")) continue;
      const item = obj["item"];
      if (item === null || typeof item === "undefined" || typeof item !== "object") continue;
      const material = (item as Record<string, unknown>)["material"];
      if (typeof material === "string" && material.includes(":")) {
        backpackSet.add(stripNamespace(material));
      }
      const modelData = (item as Record<string, unknown>)["model-data"];
      if (typeof material === "string" && !material.includes(":") && typeof modelData === "number") {
        // vanilla material + cmd — resolve to the config key later via cmdKeys
        backpackSet.add(`minecraft:${material.toLowerCase()}|${modelData}`);
      }
    }

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
  // Custom plugins (e.g. oxywire): top-level `item-model` / `item_model`, whose
  // path can be nested (oxywire:cosmetics/hats/farmer_hat). Register both the
  // full path (matches the modern item-model lookup) and the last segment
  // (matches the model's last-segment lookup).
  const topModel = obj["item-model"] ?? obj["item_model"];
  if (typeof topModel === "string") {
    aliases.push(stripNamespace(topModel));
    const last = topModel.split("/").pop();
    if (last !== undefined && last !== topModel) aliases.push(stripNamespace(last));
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

/**
 * Fixed dye colour: Oraxen/Nexo top-level `color` ("R,G,B" or "#RRGGBB"),
 * or Components.dyed_color. Returns 0xRRGGBB.
 */
function extractColor(item: unknown): number | undefined {
  if (item === null || typeof item !== "object") return undefined;
  const obj = item as Record<string, unknown>;
  let raw: unknown = obj["color"];
  if (raw === undefined) {
    const components = obj["Components"];
    if (components !== null && typeof components === "object") {
      raw = (components as Record<string, unknown>)["dyed_color"];
    }
  }
  if (typeof raw === "number" && Number.isInteger(raw)) return raw & 0xffffff;
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  const hex = text.match(/^#?([0-9a-fA-F]{6})$/);
  if (hex) return parseInt(hex[1]!, 16);
  const rgb = text.match(/^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})$/);
  if (rgb) {
    const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    if (r <= 255 && g <= 255 && b <= 255) return (r << 16) | (g << 8) | b;
  }
  // Packed decimal integer (custom plugins like oxywire: color: "10568504").
  // Only 7+ digits — a 6-digit value is ambiguous with bare hex, handled above.
  if (/^\d{7,}$/.test(text)) {
    const n = Number.parseInt(text, 10);
    if (Number.isFinite(n)) return n & 0xffffff;
  }
  return undefined;
}

/** Oraxen/Nexo Mechanics.furniture, ItemsAdder behaviours.furniture — world-placed display-entity items. */
function extractIsFurniture(item: unknown): boolean {
  if (item === null || typeof item !== "object") return false;
  const obj = item as Record<string, unknown>;
  for (const sectionKey of ["Mechanics", "mechanics", "behaviours", "behaviors"]) {
    const section = obj[sectionKey];
    if (section !== null && typeof section === "object" && "furniture" in (section as object)) {
      return true;
    }
  }
  return false;
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
  // Oraxen displayname / Nexo customname / ItemsAdder display_name / itemname,
  // plus plain `name` (custom plugins like oxywire).
  const raw =
    obj["displayname"] ?? obj["customname"] ?? obj["display_name"] ?? obj["itemname"] ?? obj["name"];
  if (typeof raw !== "string") return undefined;
  const stripped = raw
    .replace(/[§&][0-9a-fk-orx]/gi, "") // legacy colour codes
    .replace(/<[^<>]+>/g, "") // MiniMessage tags
    .trim();
  return stripped.length > 0 ? stripped : undefined;
}
