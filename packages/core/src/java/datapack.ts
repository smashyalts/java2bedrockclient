import type { VirtualFs } from "../io/vfs.js";
import { parseLenientJson } from "./json.js";
import { asRecord, parseColor, stripNamespace, type ConfigHints } from "./configShared.js";

/**
 * Extracts base-item hints from a vanilla **datapack**.
 *
 * Oraxen/Nexo/ItemsAdder/CraftEngine declare an item's host material in a
 * server-plugin YAML (see {@link ./oraxen.ts}). Datapacks have no such file:
 * they are pure vanilla, and a custom item is just a real item carrying a
 * `minecraft:item_model` component. The binding we need — *which* vanilla item
 * that is — is therefore scattered across whatever data the pack ships:
 *
 *   loot_table   {"type":"minecraft:item","name":"minecraft:chiseled_quartz_block",
 *                 "functions":[{"function":"minecraft:set_components",
 *                               "components":{"minecraft:item_model":"stellarity:altar_of_the_sacred"}}]}
 *   advancement  {"display":{"icon":{"id":"minecraft:book",
 *                                    "components":{"item_model":"stellarity:endonomicon"}}}}
 *   recipe       {"result":{"id":"minecraft:poisonous_potato","components":{...}}}
 *   function     give @s minecraft:iron_sword[minecraft:item_model="cnk:netherite_knife"]
 *
 * Rather than hard-code each of those schemas — there are more (villager_trade,
 * item_modifier) and the list grows every version — the JSON side is a single
 * generic walk: any object declaring a vanilla item id scopes its subtree, and
 * an `item_model` found inside binds to the nearest enclosing id. That handles
 * every container above, and formats added later, without new code.
 *
 * Without this the pipeline sees only the resource pack's
 * `assets/<ns>/items/<key>.json` and has no idea what to hang it off, so every
 * item falls back to the generic host (`minecraft:paper`) — wrong stack size,
 * wrong tooltip, wrong behaviour on Bedrock.
 */

/**
 * Where a binding was found, highest priority first. An advancement icon is
 * decoration and may use a stand-in item (a plain `book` for a lectern-like
 * custom item), while a loot table or recipe result is the item a player
 * actually receives — so a weaker source must never overwrite a stronger one.
 */
const SOURCE_RANK: Record<string, number> = {
  loot_table: 4,
  recipe: 4,
  item_modifier: 3,
  villager_trade: 3,
  function: 2,
  advancement: 1,
};

/**
 * Datapack directories were pluralised before 1.21 (`loot_tables/`, `recipes/`,
 * `advancements/`, `functions/`, `item_modifiers/`). Packs in the wild still ship
 * the old layout — and an overlay inside a modern pack often *is* the old layout
 * — so both spellings must resolve to the same category. Without this the whole
 * loot-table index comes up empty and every reference-based binding is lost.
 */
const CATEGORY_ALIASES: Record<string, string> = {
  loot_tables: "loot_table",
  recipes: "recipe",
  advancements: "advancement",
  functions: "function",
  item_modifiers: "item_modifier",
  predicates: "predicate",
  structures: "structure",
  tags: "tags",
};

/** Canonical (singular, 1.21+) name for a datapack category directory. */
function canonicalCategory(name: string): string {
  return CATEGORY_ALIASES[name] ?? name;
}

/** Rank used for a data category not listed above. */
const DEFAULT_RANK = 2;

/**
 * A vanilla item id: no namespace, or an explicit `minecraft:` one. Item ids
 * never contain `/`, which is what keeps model paths ("stellarity:block/altar")
 * and function ids ("cnk:basin/main") from being mistaken for one.
 */
const ITEM_ID = /^(?:minecraft:)?([a-z0-9_]+)$/;

/**
 * An item id written in a command: the bracket form that `give`/`item … with`
 * use (`minecraft:iron_sword[…]`), or the SNBT field that `summon` and
 * `data merge` use (`item: {id: "minecraft:cobblestone", …}`).
 */
const COMMAND_ITEM_ID = /(?:\bid\s*:\s*["']?|\b(?:give\s+\S+|with)\s+)(?:minecraft:)?([a-z0-9_]+)["']?\s*[[,}]/g;

/** `minecraft:item_model="ns:key"` (bracket form) or `"minecraft:item_model": "ns:key"` (SNBT). */
const COMMAND_ITEM_MODEL = /["']?(?:minecraft:)?item_model["']?\s*[:=]\s*["']([^"']+)["']/g;

/** A candidate binding, kept with its rank so the strongest source wins. */
interface Binding {
  base: string;
  rank: number;
}

interface DatapackScan {
  bindings: Map<string, Binding>;
  names: Map<string, string>;
  colors: Map<string, number>;
  equippables: Map<string, { asset: string; slot: string }>;
  /** Loot table id ("cnk:food/candy/base") → the vanilla item it yields. */
  lootItems: Map<string, string>;
  files: number;
}

/**
 * True when this archive is a datapack rather than a plugin config bundle:
 * it has a `data/<namespace>/<category>/` tree. Overlay directories
 * (`overlay_26_1/data/...`) count, so version-split packs are recognised.
 */
export function isDatapack(vfs: VirtualFs): boolean {
  for (const path of vfs.list()) {
    if (dataCategory(path) !== undefined) return true;
  }
  return false;
}

/**
 * Parse every data file in the pack, merging what it learns into `hints`.
 * Returns the number of distinct item models bound to a host item.
 *
 * Existing hints are never overwritten: a plugin config that named the material
 * outright is more authoritative than anything inferred here.
 */
export function parseDatapack(vfs: VirtualFs, hints: ConfigHints): number {
  const scan: DatapackScan = {
    bindings: new Map(),
    names: new Map(),
    colors: new Map(),
    equippables: new Map(),
    lootItems: indexLootTables(vfs),
    files: 0,
  };

  for (const path of vfs.list()) {
    const category = dataCategory(path);
    if (category === undefined) continue;
    const text = vfs.readText(path);
    if (text === undefined) continue;
    const rank = SOURCE_RANK[category] ?? DEFAULT_RANK;

    if (path.endsWith(".json")) {
      const doc = parseLenientJson(text);
      if (doc === undefined) continue;
      scan.files++;
      walk(doc, undefined, rank, scan);
    } else if (path.endsWith(".mcfunction")) {
      scan.files++;
      scanFunction(text, SOURCE_RANK["function"]!, scan);
    }
  }

  let bound = 0;
  for (const [key, binding] of scan.bindings) {
    if (hints.baseItems[key] !== undefined) continue;
    hints.baseItems[key] = binding.base;
    bound++;
  }
  // Item models live in subfolders ("stellarity:_particle/spark" ->
  // assets/stellarity/items/_particle/spark.json) and the pipeline looks an
  // item up by either the full path or the file's last segment, so register the
  // short form too. Skipped where two folders share a leaf name and disagree on
  // the host item — an ambiguous alias is worse than none.
  for (const [alias, base] of shortAliases(scan.bindings)) {
    hints.baseItems[alias] ??= base;
  }
  for (const [key, name] of scan.names) {
    hints.displayNames[key] ??= name;
  }
  for (const [key, color] of scan.colors) {
    if (hints.colors[key] === undefined) hints.colors[key] = color;
  }
  for (const [key, equippable] of scan.equippables) {
    hints.equippables[key] ??= equippable;
  }
  hints.files += scan.files;
  hints.items += bound;
  return bound;
}

/**
 * Map every loot table to the vanilla item it ultimately yields.
 *
 * A pack factors shared item definitions into a base table and layers variants
 * on top by *reference*, which leaves the variant naming no item at all:
 *
 *   food/candy/base.json   {"type":"minecraft:item","name":"minecraft:poisonous_potato", …}
 *   food/candy/black.json  {"type":"minecraft:loot_table","value":"cnk:food/candy/base",
 *                           "functions":[… "minecraft:item_model":"cnk:candy/black"]}
 *
 * Without following that reference every such variant is unresolvable. Tables
 * are indexed first (direct item, or the table they defer to), then chains are
 * flattened — with a visited set, since a pack is free to make them cyclic.
 */
function indexLootTables(vfs: VirtualFs): Map<string, string> {
  const direct = new Map<string, string>();
  const refs = new Map<string, string>();

  for (const path of vfs.list({ suffix: ".json" })) {
    if (dataCategory(path) !== "loot_table") continue;
    const id = lootTableId(path);
    if (id === undefined) continue;
    const doc = parseLenientJson(vfs.readText(path) ?? "");
    if (doc === undefined) continue;
    const found = firstEntry(doc);
    if (found === undefined) continue;
    if (found.kind === "item") direct.set(id, found.value);
    else refs.set(id, found.value);
  }

  const resolved = new Map<string, string>(direct);
  for (const start of refs.keys()) {
    const seen = new Set<string>();
    let at: string | undefined = start;
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      const item = direct.get(at);
      if (item !== undefined) {
        resolved.set(start, item);
        break;
      }
      at = refs.get(at);
    }
  }
  return resolved;
}

/** "data/cnk/loot_table/food/candy/base.json" → "cnk:food/candy/base". */
function lootTableId(path: string): string | undefined {
  const parts = path.split("/");
  const at = parts.indexOf("data");
  if (at === -1 || at > 1 || parts.length < at + 4) return undefined;
  return `${parts[at + 1]}:${parts.slice(at + 3).join("/").replace(/\.json$/, "")}`;
}

/**
 * The first loot entry in a table: either the vanilla item it drops, or the id
 * of another table it defers to. Only the first is needed — tables that mix
 * several different host items cannot be reduced to one binding anyway.
 */
function firstEntry(node: unknown): { kind: "item" | "ref"; value: string } | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = firstEntry(child);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const obj = asRecord(node);
  if (obj === undefined) return undefined;

  const type = obj["type"];
  if (typeof type === "string") {
    const kind = stripNamespace(type);
    if (kind === "item") {
      const item = itemIdOf(obj);
      if (item !== undefined) return { kind: "item", value: item };
    } else if (kind === "loot_table") {
      const value = obj["value"];
      // `value` may be an inlined table object rather than a reference id.
      if (typeof value === "string" && value.trim() !== "") {
        return { kind: "ref", value: value.trim().toLowerCase() };
      }
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    // Component blocks describe the item, not which entry it came from.
    if (key === "components") continue;
    const found = firstEntry(value);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Last-path-segment aliases for nested item models ("candy/black" -> "black").
 * A leaf claimed by two folders is only aliased when both agree on the host
 * item; otherwise the alias is dropped so no item silently gets the other's.
 */
function shortAliases(bindings: Map<string, Binding>): Map<string, string> {
  const aliases = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const [key, binding] of bindings) {
    const slash = key.lastIndexOf("/");
    if (slash === -1) continue;
    const leaf = key.slice(slash + 1);
    if (leaf === "" || bindings.has(leaf) || conflicted.has(leaf)) continue;
    const existing = aliases.get(leaf);
    if (existing !== undefined && existing !== binding.base) {
      aliases.delete(leaf);
      conflicted.add(leaf);
      continue;
    }
    aliases.set(leaf, binding.base);
  }
  return aliases;
}

/**
 * The datapack category a path belongs to ("loot_table", "advancement", …), or
 * undefined when the path is not datapack data. Matches both the pack root and
 * any overlay directory, and only accepts the file types we can read.
 */
function dataCategory(path: string): string | undefined {
  if (!path.endsWith(".json") && !path.endsWith(".mcfunction")) return undefined;
  const parts = path.split("/");
  // …/data/<namespace>/<category>/<rest> — find the `data` segment, which is at
  // the root for a plain pack and one deeper inside an overlay.
  const at = parts.indexOf("data");
  if (at === -1 || at > 1) return undefined;
  if (parts.length < at + 4) return undefined;
  return canonicalCategory(parts[at + 2]!);
}

/**
 * Recursive descent carrying the nearest enclosing vanilla item id. Any object
 * that names one re-scopes its whole subtree, so `components` nested under a
 * loot-table `functions` array still bind to the entry's item.
 */
function walk(node: unknown, base: string | undefined, rank: number, scan: DatapackScan): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, base, rank, scan);
    return;
  }
  const obj = asRecord(node);
  if (obj === undefined) return;

  const scope = itemIdOf(obj) ?? lootRefItem(obj, scan) ?? base;
  const components = asRecord(obj["components"]);
  if (components !== undefined) applyComponents(components, scope, rank, scan);

  for (const [key, value] of Object.entries(obj)) {
    if (key === "components") continue;
    walk(value, scope, rank, scan);
  }
}

/**
 * For a `{"type":"minecraft:loot_table","value":"cnk:food/candy/base"}` entry,
 * the item that referenced table yields — so components layered on top of a
 * shared base table bind to the base's item.
 */
function lootRefItem(obj: Record<string, unknown>, scan: DatapackScan): string | undefined {
  const type = obj["type"];
  if (typeof type !== "string" || stripNamespace(type) !== "loot_table") return undefined;
  const value = obj["value"];
  if (typeof value !== "string") return undefined;
  return scan.lootItems.get(value.trim().toLowerCase());
}

/**
 * The vanilla item this object declares, if any. Loot entries use `name`,
 * recipe results and advancement icons use `id`. `air` is skipped — it is the
 * "no item" placeholder, never a real host.
 */
function itemIdOf(obj: Record<string, unknown>): string | undefined {
  for (const field of ["id", "name", "item"]) {
    const raw = obj[field];
    if (typeof raw !== "string") continue;
    const match = ITEM_ID.exec(raw.trim().toLowerCase());
    if (match === null) continue;
    if (match[1] === "air") continue;
    return `minecraft:${match[1]}`;
  }
  return undefined;
}

/**
 * Pull the hints out of one `components` block. Both the namespaced
 * (`minecraft:item_model`) and bare (`item_model`) spellings occur, often in
 * the same file, so every lookup accepts either.
 */
function applyComponents(
  components: Record<string, unknown>,
  base: string | undefined,
  rank: number,
  scan: DatapackScan,
): void {
  const model = component(components, "item_model");
  if (typeof model !== "string" || model.trim() === "") return;
  const key = stripNamespace(model.trim());

  if (base !== undefined) {
    const existing = scan.bindings.get(key);
    if (existing === undefined || rank > existing.rank) scan.bindings.set(key, { base, rank });
  }

  const name = plainText(component(components, "item_name"));
  if (name !== undefined && !scan.names.has(key)) scan.names.set(key, name);

  const color = dyedColor(component(components, "dyed_color"));
  if (color !== undefined && !scan.colors.has(key)) scan.colors.set(key, color);

  const equippable = asRecord(component(components, "equippable"));
  if (equippable !== undefined && !scan.equippables.has(key)) {
    const asset = equippable["asset_id"];
    const slot = equippable["slot"];
    if (typeof asset === "string" && typeof slot === "string") {
      scan.equippables.set(key, { asset: stripNamespace(asset), slot: slot.toLowerCase() });
    }
  }
}

/** A component by name, accepting the `minecraft:`-prefixed or bare spelling. */
function component(components: Record<string, unknown>, name: string): unknown {
  return components[`minecraft:${name}`] ?? components[name];
}

/**
 * Flatten a text component to something printable. Only literal text counts:
 * a bare `translate` key ("block.stellarity.ashen_froglight") is an id, not a
 * name, so it is skipped unless the author supplied a `fallback`.
 */
function plainText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value.trim();
  if (Array.isArray(value)) {
    for (const part of value) {
      const text = plainText(part);
      if (text !== undefined) return text;
    }
    return undefined;
  }
  const obj = asRecord(value);
  if (obj === undefined) return undefined;
  for (const field of ["fallback", "text"]) {
    const raw = obj[field];
    if (typeof raw === "string" && raw.trim() !== "") return raw.trim();
  }
  return undefined;
}

/**
 * `minecraft:dyed_color` is a packed integer in modern packs and was
 * `{"rgb": <int>}` before 1.21.5; accept both.
 */
function dyedColor(value: unknown): number | undefined {
  if (typeof value === "number") return value & 0xffffff;
  const obj = asRecord(value);
  if (obj !== undefined) return parseColor(obj["rgb"]);
  return parseColor(value);
}

/**
 * Scan an .mcfunction for commands that name an item and its model together.
 * This is the linear counterpart of {@link walk}: a model binds to the nearest
 * item id written before it.
 *
 * Scoping is per line, and that is what makes it safe. A `summon` puts both
 * halves on one line:
 *
 *   summon item_display … {item: {id: "minecraft:cobblestone", count: 1,
 *                                 components: {"minecraft:item_model": "cnk:booze_bottle"}}}
 *
 * whereas retargeting an existing entity's model never says what the item is:
 *
 *   data modify entity @s item.components."minecraft:item_model" set value "cnk:basin"
 *
 * With no id on that line the model is correctly left unbound, instead of
 * latching onto whatever id happened to appear on an earlier line.
 */
function scanFunction(text: string, rank: number, scan: DatapackScan): void {
  if (!text.includes("item_model")) return;
  for (const line of text.split("\n")) {
    if (!line.includes("item_model")) continue;

    const ids: { at: number; item: string }[] = [];
    COMMAND_ITEM_ID.lastIndex = 0;
    for (let m = COMMAND_ITEM_ID.exec(line); m !== null; m = COMMAND_ITEM_ID.exec(line)) {
      if (m[1] !== "air") ids.push({ at: m.index, item: m[1]! });
    }
    if (ids.length === 0) continue;

    COMMAND_ITEM_MODEL.lastIndex = 0;
    for (let m = COMMAND_ITEM_MODEL.exec(line); m !== null; m = COMMAND_ITEM_MODEL.exec(line)) {
      const model = m[1]!;
      // Macro placeholders ($(model)) are substituted per call site, so the
      // line names no concrete model.
      if (model.includes("$(") || model.trim() === "") continue;
      let base: string | undefined;
      for (const id of ids) {
        if (id.at < m.index) base = `minecraft:${id.item}`;
        else break;
      }
      if (base === undefined) continue;
      const key = stripNamespace(model);
      const existing = scan.bindings.get(key);
      if (existing === undefined || rank > existing.rank) scan.bindings.set(key, { base, rank });
    }
  }
}
