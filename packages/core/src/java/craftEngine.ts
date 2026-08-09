import {
  asRecord,
  parseColor,
  parseScaleMagnitude,
  stripFormatting,
  stripNamespace,
  type ConfigHints,
} from "./configShared.js";

/**
 * CraftEngine (`plugins/CraftEngine/resources/<pack>/configuration/*.yml`).
 *
 * Unlike Oraxen/Nexo/ItemsAdder, CraftEngine keys items by a full namespaced id
 * and splits every concern into its own section:
 *
 *   items:
 *     default:ruby_sword:
 *       material: golden_sword          # the vanilla host item
 *       custom_model_data: 10001        # root-level, not nested under Pack
 *       item_model: default:ruby_sword  # root-level; defaults to the item id
 *       texture: minecraft:item/custom/ruby_sword   # simplified model
 *       model:                          # or a full model tree / bare path
 *         type: minecraft:model
 *         path: minecraft:item/custom/ruby_sword
 *       data:
 *         item_name: "<!i><#FF8C00>Ruby Sword"
 *         dyed_color: 255,128,64
 *         equippable: { slot: head, asset_id: minecraft:topaz }
 *       settings:
 *         equipment: { asset_id: default:topaz, slot: head }
 *       behavior:
 *         type: furniture_item
 *         furniture: default:bench      # id reference, or an inline definition
 *
 *   furniture:
 *     default:bench:
 *       settings: { item: default:bench }
 *       variants:
 *         ground:
 *           elements:
 *             - item: default:bench_model      # the item the display entity holds
 *               display_transform: none
 *               scale: 1,1,1
 *
 * The furniture indirection matters for Bedrock: the display entity holds the
 * *element* item, not the item the player placed, so that's the model
 * GeyserDisplayEntity has to render. Element references are collected across
 * every file and resolved once all items are known, since a furniture block can
 * sit in a different file than the item it displays.
 */

/** Cross-file state: furniture references resolve only after every item is read. */
export interface CraftEngineState {
  /** Item ids referenced by a furniture element, or carrying a furniture_item behaviour. */
  furnitureRefs: Set<string>;
  /** Furniture ref → placement transform read from the display element. */
  refTransforms: Map<string, { none: boolean; scale: number }>;
  /** Item key → the model aliases registered for it, so refs can flag those too. */
  aliasesByKey: Map<string, string[]>;
}

export function newCraftEngineState(): CraftEngineState {
  return { furnitureRefs: new Set(), refTransforms: new Map(), aliasesByKey: new Map() };
}

/**
 * Does this YAML document belong to CraftEngine? Its `furniture:` and
 * `equipments:` sections are unique to it, and its `items:` keys are always
 * namespaced ids — ItemsAdder, the other plugin with an `items:` section, uses
 * bare keys. Anything else falls through to the Oraxen/Nexo/ItemsAdder parser.
 */
export function isCraftEngineDoc(root: Record<string, unknown>): boolean {
  if (asRecord(root["furniture"]) !== undefined) return true;
  if (asRecord(root["equipments"]) !== undefined) return true;
  const items = asRecord(root["items"]);
  if (items === undefined) return false;
  const keys = Object.keys(items);
  return keys.length > 0 && keys.every((k) => k.includes(":"));
}

/**
 * Parse one CraftEngine document into `hints`, recording furniture references
 * in `state` for {@link finalizeCraftEngine}. Returns the number of items found.
 */
export function parseCraftEngineDoc(
  root: Record<string, unknown>,
  hints: ConfigHints,
  state: CraftEngineState,
): number {
  let found = 0;
  for (const [id, raw] of Object.entries(asRecord(root["items"]) ?? {})) {
    const item = asRecord(raw);
    if (item === undefined) continue;
    if (registerItem(id, item, hints, state)) found++;
  }
  for (const [id, raw] of Object.entries(asRecord(root["furniture"]) ?? {})) {
    const furniture = asRecord(raw);
    if (furniture !== undefined) registerFurniture(id, furniture, state);
  }
  return found;
}

/**
 * Fold collected furniture references into the hints. Runs after every file in
 * every zip so a `furniture:` block can reference an item defined anywhere.
 */
export function finalizeCraftEngine(
  state: CraftEngineState,
  furnitureSet: Set<string>,
  hints: ConfigHints,
): void {
  for (const ref of state.furnitureRefs) {
    const transform = state.refTransforms.get(ref);
    // Flag the item key itself plus every model alias registered for it — the
    // pipeline matches furniture by config key, item_model path, or model name,
    // and which of the three it has depends on how the item was configured.
    for (const key of [ref, ...(state.aliasesByKey.get(ref) ?? [])]) {
      furnitureSet.add(key);
      if (transform !== undefined) hints.furnitureTransforms[key] = transform;
    }
  }
}

/** Register one `items:` entry. Returns whether it looked like a real item. */
function registerItem(
  id: string,
  item: Record<string, unknown>,
  hints: ConfigHints,
  state: CraftEngineState,
): boolean {
  const key = stripNamespace(id);
  const aliases = modelAliases(id, item).filter((a) => a !== key);
  const material = item["material"];
  const base = typeof material === "string" && /^[A-Za-z_]+$/.test(material)
    ? `minecraft:${material.toLowerCase()}`
    : undefined;
  const data = asRecord(item["data"]) ?? {};
  const displayName = stripFormatting(data["item_name"] ?? data["custom_name"] ?? data["display_name"]);
  const color = parseColor(data["dyed_color"]);
  const equippable = extractEquippable(item, data);

  if (base === undefined && displayName === undefined && aliases.length === 0) return false;

  for (const target of [key, ...aliases]) {
    if (base !== undefined) hints.baseItems[target] = base;
    if (displayName !== undefined) hints.displayNames[target] = displayName;
    if (color !== undefined) hints.colors[target] = color;
    if (equippable !== undefined) hints.equippables[target] = equippable;
  }
  state.aliasesByKey.set(key, aliases);

  const cmd = item["custom_model_data"];
  if (typeof cmd === "number" && base !== undefined) hints.cmdKeys[`${base}|${cmd}`] = key;

  registerFurnitureBehavior(key, item, state);
  return true;
}

/**
 * Every name the pipeline might look this item up by: the `item_model` path
 * (matched against modern item-model ids), and the model file's last path
 * segment (matched against legacy model names). CraftEngine defaults
 * `item_model` to the item id, so an item with only a `texture` still resolves.
 */
function modelAliases(id: string, item: Record<string, unknown>): string[] {
  const aliases = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const path = stripNamespace(value);
    aliases.add(path);
    const last = path.split("/").pop();
    if (last !== undefined && last !== path) aliases.add(last);
  };

  add(item["item_model"] ?? id);
  add(item["texture"]);
  // `model` is either a bare path or a node in the model tree; `path` carries
  // the file in the object form. Nested branch nodes (condition/select/…) are
  // not walked: their children are variant states of the same item, and the
  // pipeline resolves those from the pack's own item definition JSON.
  const model = item["model"];
  add(typeof model === "string" ? model : asRecord(model)?.["path"]);
  // Multi-slot materials (bow, crossbow, fishing rod) list one entry per state.
  for (const listKey of ["models", "textures"]) {
    const list = item[listKey];
    if (Array.isArray(list)) for (const entry of list) add(entry);
  }
  return [...aliases];
}

/** `data.equippable` (1.21.2+) or `settings.equipment` — the armor-set link. */
function extractEquippable(
  item: Record<string, unknown>,
  data: Record<string, unknown>,
): { asset: string; slot: string } | undefined {
  const sources = [asRecord(data["equippable"]), asRecord(asRecord(item["settings"])?.["equipment"])];
  for (const source of sources) {
    if (source === undefined) continue;
    const asset = source["asset_id"];
    const slot = source["slot"];
    if (typeof asset !== "string" || typeof slot !== "string") continue;
    return { asset: stripNamespace(asset), slot: slot.toLowerCase() };
  }
  return undefined;
}

/**
 * An item with a `furniture_item` behaviour places furniture. `furniture:` is
 * either an id reference (the definition lives elsewhere) or an inline
 * definition registered under the item's own id.
 */
function registerFurnitureBehavior(
  key: string,
  item: Record<string, unknown>,
  state: CraftEngineState,
): void {
  // `behavior` may be a single object or a list of them.
  const raw = item["behavior"] ?? item["behaviors"];
  const behaviors = (Array.isArray(raw) ? raw : [raw]).map(asRecord);
  for (const behavior of behaviors) {
    if (behavior?.["type"] !== "furniture_item") continue;
    state.furnitureRefs.add(key);
    const furniture = behavior["furniture"];
    const inline = asRecord(furniture);
    if (inline !== undefined) registerFurniture(key, inline, state);
    // An id reference needs no work here: the referenced definition is parsed
    // on its own and contributes its element items directly.
  }
}

/** Record the item ids a furniture definition's variants display, with their transforms. */
function registerFurniture(
  id: string,
  furniture: Record<string, unknown>,
  state: CraftEngineState,
): void {
  // `settings.item` is the item players place — flag it so the held form is
  // recognised even when the display element uses a separate model item.
  const settingsItem = asRecord(furniture["settings"])?.["item"];
  if (typeof settingsItem === "string") state.furnitureRefs.add(stripNamespace(settingsItem));
  else state.furnitureRefs.add(stripNamespace(id));

  for (const raw of Object.values(asRecord(furniture["variants"]) ?? {})) {
    const variant = asRecord(raw);
    const elements = variant?.["elements"];
    if (!Array.isArray(elements)) continue;
    for (const entry of elements) {
      const element = asRecord(entry);
      const elementItem = element?.["item"];
      if (typeof elementItem !== "string") continue;
      const ref = stripNamespace(elementItem);
      state.furnitureRefs.add(ref);
      // First variant wins: `ground` is listed first by convention and is the
      // placement Bedrock players see most.
      if (state.refTransforms.has(ref)) continue;
      const transform = element!["display_transform"];
      state.refTransforms.set(ref, {
        none: typeof transform === "string" && transform.trim().toUpperCase() === "NONE",
        scale: parseScaleMagnitude(element!["scale"]),
      });
    }
  }
}
