import type { JavaPack } from "./javaPack.js";
import { parseResourceLocation } from "./javaPack.js";
import { asRecord } from "./configShared.js";

/**
 * Infer a custom item's host item from what its 1.21.4+ item definition
 * *dispatches on*.
 *
 * Most custom models parent to `minecraft:item/generated` or `item/handheld` —
 * the generic sprite and tool parents — which name hundreds of vanilla items
 * and so tell us nothing. But a definition that branches on a property only one
 * vanilla item has does identify it: nothing but a crossbow has a
 * `minecraft:charge_type`, nothing but a fishing rod has `fishing_rod/cast`.
 * A retextured crossbow therefore announces itself even when no datapack or
 * plugin config says so, e.g.
 *
 *   { "model": { "type": "minecraft:select", "property": "minecraft:charge_type", … } }
 *
 * This runs only after the pack, config hints and model parent chain have all
 * come up empty — it replaces the blunt `modernBaseItem` fallback, never a
 * known answer.
 */

/**
 * Dispatch properties used by exactly one vanilla item.
 *
 * Derived mechanically from the vanilla client's own 1,537 item definitions
 * (`assets/minecraft/items/*.json`, 26.2) by counting which items dispatch on
 * each property — not from memory, because the 1.21.4+ item-definition
 * properties are *not* the old 1.20 model-predicate names. A bow dispatches on
 * `use_duration`, never `bow/pull`; a brush on `use_cycle`, never `brushable`.
 *
 * Everything vanilla uses on more than one item is deliberately absent, with
 * the count that disqualified it:
 *   local_time (2)   compass (2: compass + recovery_compass)
 *   has_component(2) using_item (5)      block_state (12)
 *   bundle/has_selected_item (17: every dyed bundle)
 *   display_context (26)                 trim_material (29)
 */
const PROPERTY_HOST: Record<string, string> = {
  "minecraft:use_duration": "minecraft:bow",
  "minecraft:use_cycle": "minecraft:brush",
  "minecraft:time": "minecraft:clock",
  "minecraft:context_dimension": "minecraft:clock",
  "minecraft:crossbow/pull": "minecraft:crossbow",
  "minecraft:charge_type": "minecraft:crossbow",
  "minecraft:broken": "minecraft:elytra",
  "minecraft:fishing_rod/cast": "minecraft:fishing_rod",
};

/**
 * Components a definition *conditions on* that only one vanilla item conditions
 * on. Same derivation as above. Weaker than the property table — a pack is free
 * to put any component on any item — so these are consulted second and still
 * only ever beat the generic fallback.
 *
 * `minecraft:dyed_color` is excluded even though vanilla conditions on it only
 * for wolf_armor: dyeing is common to leather armor too, so a retextured
 * leather set would be mis-hosted as wolf armor.
 */
const COMPONENT_HOST: Record<string, string> = {
  "minecraft:lodestone_tracker": "minecraft:compass",
};

/**
 * Host item implied by the item definition `itemModelId` resolves to, or
 * undefined when it dispatches on nothing item-specific.
 */
export function inferHostItemFromDefinition(
  pack: JavaPack,
  itemModelId: string,
  cache?: Map<string, string | undefined>,
): string | undefined {
  if (cache?.has(itemModelId)) return cache.get(itemModelId);
  const host = inferImpl(pack, itemModelId);
  cache?.set(itemModelId, host);
  return host;
}

function inferImpl(pack: JavaPack, itemModelId: string): string | undefined {
  const loc = parseResourceLocation(itemModelId);
  const definition = pack.readJson(`assets/${loc.namespace}/items/${loc.path}.json`);
  if (definition === undefined) return undefined;

  const properties = new Set<string>();
  const components = new Set<string>();
  collect(definition, properties, components);

  for (const property of properties) {
    const host = PROPERTY_HOST[property];
    if (host !== undefined) return host;
  }
  for (const component of components) {
    const host = COMPONENT_HOST[component];
    if (host !== undefined) return host;
  }
  return undefined;
}

/** Gather every `property` / `component` string anywhere in the definition. */
function collect(node: unknown, properties: Set<string>, components: Set<string>): void {
  if (Array.isArray(node)) {
    for (const child of node) collect(child, properties, components);
    return;
  }
  const obj = asRecord(node);
  if (obj === undefined) return;
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && (key === "property" || key === "component")) {
      // Definitions write these with or without the namespace.
      const id = value.includes(":") ? value : `minecraft:${value}`;
      (key === "property" ? properties : components).add(id);
      continue;
    }
    collect(value, properties, components);
  }
}
