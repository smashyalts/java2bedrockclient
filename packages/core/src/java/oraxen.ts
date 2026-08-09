import { load } from "js-yaml";
import { readZipDetailed } from "../io/zip.js";
import type { VirtualFs } from "../io/vfs.js";
import {
  parseColor,
  parseScaleMagnitude,
  stripFormatting,
  stripNamespace,
  type ConfigHints,
} from "./configShared.js";
import {
  finalizeCraftEngine,
  isCraftEngineDoc,
  newCraftEngineState,
  parseCraftEngineDoc,
  type CraftEngineState,
} from "./craftEngine.js";

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
 * CraftEngine's layout is different enough to warrant its own parser — see
 * {@link ./craftEngine.ts} — but it produces the same hints and its documents
 * are routed here, so callers pass every plugin's config zips to one function.
 *
 * The item key doubles as the item-model / model name, and the material is
 * the vanilla item the server actually gives players — exactly the "host
 * item" our Geyser mappings need, so parsing these files removes manual
 * per-item base assignment entirely.
 */
export type OraxenHints = ConfigHints;

export function parseOraxenConfigZip(zipBytes: Uint8Array): OraxenHints {
  return parseOraxenConfigZips([zipBytes]);
}

/**
 * Parse any number of plugin config zips (Nexo/Oraxen items, ItemsAdder
 * contents, CraftEngine configuration, HMCCosmetics cosmetics — in any
 * combination and order) into one merged hint set. Cross-zip references (an
 * HMCC backpack pointing at a Nexo item by material+cmd, a CraftEngine
 * furniture block displaying an item defined in another file) resolve after all
 * files are read.
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
    furnitureTransforms: {},
    files: 0,
    items: 0,
  };
  const backpackSet = new Set<string>();
  const furnitureSet = new Set<string>();
  // Pre-pass: collect every top-level entry across all zips so `template:`
  // references (Nexo templates that carry the material/model, often in a
  // separate core file) resolve regardless of file/zip order.
  const templates = new Map<string, Record<string, unknown>>();
  for (const zipBytes of zips) collectTemplates(zipBytes, templates);
  const craftEngine = newCraftEngineState();
  for (const zipBytes of zips) {
    parseOne(zipBytes, hints, backpackSet, furnitureSet, templates, craftEngine);
  }
  // Resolve material+cmd backpack refs now that every item is known.
  for (const ref of backpackSet) {
    if (ref.includes("|") && hints.cmdKeys[ref] !== undefined) backpackSet.add(hints.cmdKeys[ref]!);
  }
  finalizeCraftEngine(craftEngine, furnitureSet, hints);
  hints.backpacks = [...backpackSet].filter((k) => !k.includes("|"));
  hints.furniture = [...furnitureSet];
  return hints;
}

/** Every YAML file in the zip — CraftEngine packs use `.yaml`, the rest `.yml`. */
function listYaml(vfs: VirtualFs): string[] {
  return [...vfs.list({ suffix: ".yml" }), ...vfs.list({ suffix: ".yaml" })];
}

/** Collect every top-level yml entry (potential `template:` target) by key. */
function collectTemplates(zipBytes: Uint8Array, templates: Map<string, Record<string, unknown>>): void {
  const { vfs } = readZipDetailed(zipBytes);
  for (const path of listYaml(vfs)) {
    const text = vfs.readText(path);
    if (text === undefined) continue;
    let doc: unknown;
    try {
      doc = load(text);
    } catch {
      continue;
    }
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) continue;
    const root = doc as Record<string, unknown>;
    const add = (key: string, value: unknown): void => {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        templates.set(key.toLowerCase(), value as Record<string, unknown>);
      }
    };
    for (const [key, value] of Object.entries(root)) add(key, value);
    // ItemsAdder nests item/template definitions under an `items:` section, and
    // references templates with `variant_of` (see resolveTemplate).
    const items = root["items"];
    if (items !== null && typeof items === "object" && !Array.isArray(items)) {
      for (const [key, value] of Object.entries(items as Record<string, unknown>)) add(key, value);
    }
  }
}

/** The template a Nexo (`template`) or ItemsAdder (`variant_of`) item inherits. */
function templateRef(obj: Record<string, unknown>): string | undefined {
  const t = obj["template"];
  if (typeof t === "string") return t;
  const v = obj["variant_of"];
  return typeof v === "string" ? v : undefined;
}

/**
 * Resolve a Nexo `template:` chain: deep-merge each referenced template's fields
 * as defaults (the item's own fields win), then substitute the `<item_id>`
 * placeholder (used in template model paths) with the item's key. Returns the
 * value unchanged when it has no template.
 */
function resolveTemplate(
  key: string,
  value: unknown,
  templates: Map<string, Record<string, unknown>>,
): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  let obj = value as Record<string, unknown>;
  let ref = templateRef(obj);
  if (ref === undefined) return substitutePlaceholders(obj, key);

  const chain: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  while (ref !== undefined && !seen.has(ref.toLowerCase())) {
    seen.add(ref.toLowerCase());
    const tmpl = templates.get(ref.toLowerCase());
    if (tmpl === undefined) break;
    chain.push(tmpl);
    ref = templateRef(tmpl);
  }
  // Merge templates root-first (deepest default), then the item on top.
  let merged: Record<string, unknown> = {};
  for (const t of chain.reverse()) merged = deepMerge(merged, t);
  merged = deepMerge(merged, obj);
  delete merged["template"];
  delete merged["variant_of"];
  obj = merged;
  return substitutePlaceholders(obj, key);
}

/** Deep-merge `over` onto `base` (objects merge recursively, scalars/arrays overwrite). */
function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    if (
      b !== null && typeof b === "object" && !Array.isArray(b) &&
      v !== null && typeof v === "object" && !Array.isArray(v)
    ) {
      out[k] = deepMerge(b as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Replace the Nexo `<item_id>` placeholder with the item key in all strings. */
function substitutePlaceholders(value: unknown, itemId: string): unknown {
  if (typeof value === "string") return value.replace(/<item_id>/g, itemId);
  if (Array.isArray(value)) return value.map((v) => substitutePlaceholders(v, itemId));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substitutePlaceholders(v, itemId);
    }
    return out;
  }
  return value;
}

function parseOne(
  zipBytes: Uint8Array,
  hints: OraxenHints,
  backpackSet: Set<string>,
  furnitureSet: Set<string>,
  templates: Map<string, Record<string, unknown>>,
  craftEngine: CraftEngineState,
): void {
  const { vfs } = readZipDetailed(zipBytes);

  for (const path of listYaml(vfs)) {
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

    // CraftEngine's sections collide with ItemsAdder's `items:` but mean
    // different things, so route its documents away from the generic parser.
    if (isCraftEngineDoc(root)) {
      const ceFound = parseCraftEngineDoc(root, hints, craftEngine);
      if (ceFound > 0) {
        hints.files++;
        hints.items += ceFound;
      }
      continue;
    }

    let found = 0;
    const register = (key: string, value: unknown): void => {
      // Skip pure template definitions (ItemsAdder marks them `template: true`).
      if (value !== null && typeof value === "object" && (value as Record<string, unknown>)["template"] === true) {
        return;
      }
      // Material is optional: ItemsAdder 1.21.4+ items declare only an
      // item_model and inherit their base item from ItemsAdder's default, so we
      // still register their display name, furniture flag and model aliases
      // (the base item falls back to the modern base item downstream).
      const material = extractMaterial(value);
      const base = material !== undefined ? `minecraft:${material.toLowerCase()}` : undefined;
      const lowerKey = key.toLowerCase();
      const displayName = extractDisplayName(value);
      const color = extractColor(value);
      const aliases = extractModelAliases(value);
      const isFurniture = extractIsFurniture(value);
      const furnitureTransform = isFurniture ? extractFurnitureTransform(value) : undefined;

      // Nothing identifying → not one of our item entries.
      if (base === undefined && displayName === undefined && aliases.length === 0 && !isFurniture) return;
      found++;

      if (base !== undefined) hints.baseItems[lowerKey] = base;
      if (displayName !== undefined) hints.displayNames[lowerKey] = displayName;
      const equippable = extractEquippable(value);
      if (equippable !== undefined) hints.equippables[lowerKey] = equippable;
      if (color !== undefined) hints.colors[lowerKey] = color;
      const cmd = extractCmd(value);
      if (cmd !== undefined && base !== undefined) {
        hints.cmdKeys[`${base}|${cmd}`] = lowerKey;
        // Resolve cmd-style backpack refs (HMCC "material + model-data" form).
        if (backpackSet.has(`${base}|${cmd}`)) backpackSet.add(lowerKey);
      }
      if (isFurniture) {
        furnitureSet.add(lowerKey);
        if (furnitureTransform !== undefined) hints.furnitureTransforms[lowerKey] = furnitureTransform;
      }
      // Model-id overrides (Oraxen Components.item_model / Pack.model,
      // ItemsAdder item_model / resource.model_path) — register those names too.
      for (const alias of aliases) {
        if (base !== undefined) hints.baseItems[alias] = base;
        if (displayName !== undefined) hints.displayNames[alias] = displayName;
        if (isFurniture) {
          furnitureSet.add(alias);
          if (furnitureTransform !== undefined) hints.furnitureTransforms[alias] = furnitureTransform;
        }
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
        register(key, resolveTemplate(key, value, templates));
      }
    }
    // Oraxen/Nexo layout: items are top-level keys.
    for (const [key, value] of Object.entries(root)) {
      if (key === "items" || key === "info") continue;
      register(key, resolveTemplate(key, value, templates));
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
  return parseColor(raw);
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

/**
 * Furniture placement transform from the plugin's furniture mechanic. Reads
 * `Mechanics.furniture.properties.display_transform` (NONE/FIXED/HEAD/…) and
 * `scale` (e.g. "1,1,1" or [1,1,1]). NONE means the item_display carries no
 * transform, so the piece is authored upright in block space and gets no
 * runtime reposition — the converter must seat it by y-offset. scale drives
 * whether the extension should apply the entity's vanilla scale.
 */
function extractFurnitureTransform(
  item: unknown,
): { none: boolean; scale: number } | undefined {
  if (item === null || typeof item !== "object") return undefined;
  const obj = item as Record<string, unknown>;
  for (const sectionKey of ["Mechanics", "mechanics", "behaviours", "behaviors"]) {
    const section = obj[sectionKey];
    if (section === null || typeof section !== "object") continue;
    const furniture = (section as Record<string, unknown>)["furniture"];
    if (furniture === null || typeof furniture !== "object") continue;
    const props = (furniture as Record<string, unknown>)["properties"];
    const p = (props !== null && typeof props === "object" ? props : furniture) as Record<
      string,
      unknown
    >;
    const dt = p["display_transform"] ?? p["displayTransform"];
    const none = typeof dt === "string" && dt.trim().toUpperCase() === "NONE";
    const scale = parseScaleMagnitude(p["scale"]);
    return { none, scale };
  }
  return undefined;
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
  return stripFormatting(
    obj["displayname"] ?? obj["customname"] ?? obj["display_name"] ?? obj["itemname"] ?? obj["name"],
  );
}
