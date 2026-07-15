import type { JavaPack } from "./javaPack.js";
import type { JavaModel } from "./model.js";
import { parseLenientJson } from "./json.js";

/** One predicate condition attached to an item variant, in Geyser v2 predicate shape. */
export type VariantPredicate =
  | { type: "condition"; property: string; expected?: boolean }
  | { type: "match"; property: string; value: string }
  | { type: "range_dispatch"; property: string; threshold: number; scale?: number; normalize?: boolean };

export interface ItemVariant {
  /** Vanilla item this variant attaches to, e.g. "minecraft:stick". Undefined for
   * modern item-model assets whose host item cannot be known statically. */
  baseItem: string | undefined;
  /** Model to render, as a resource location. */
  model: string;
  /** Mapping mechanism. */
  source:
    | { kind: "legacy"; customModelData: number }
    | { kind: "modern"; itemModelId: string };
  /** Extra Geyser v2 predicates (damage, broken, …). */
  predicates: VariantPredicate[];
  /**
   * Matching order. Java range_dispatch picks the highest threshold ≤ value,
   * so higher-threshold entries must be checked first (higher priority).
   */
  priority?: number;
  /** Human-readable origin for the report. */
  origin: string;
}

export interface VariantExtraction {
  variants: ItemVariant[];
  /** Sources that could not be handled, with reasons (for the report). */
  unsupported: { origin: string; reason: string }[];
}

/**
 * Extract legacy override-based variants from assets/&lt;ns&gt;/models/item/*.json.
 * `bowPullConsumed` — base items consumed by a bow-pull group are skipped entirely.
 */
export function extractLegacyVariants(
  pack: JavaPack,
  bowPullConsumed?: Set<string>,
): VariantExtraction {
  const out: VariantExtraction = { variants: [], unsupported: [] };
  for (const ns of pack.namespaces()) {
    const prefix = `assets/${ns}/models/item/`;
    for (const path of pack.list({ prefix, suffix: ".json" })) {
      const model = pack.readJson<JavaModel>(path);
      if (model?.overrides === undefined || model.overrides.length === 0) continue;
      const itemName = path.slice(prefix.length, -".json".length);
      // Overrides on non-minecraft namespaces do not attach to a vanilla item.
      const baseItem = ns === "minecraft" ? `minecraft:${itemName}` : undefined;

      // Skip items fully consumed by a bow-pull group.
      if (baseItem !== undefined && bowPullConsumed?.has(baseItem)) continue;

      for (const override of model.overrides) {
        const predicate = override.predicate ?? {};
        const cmd = predicate["custom_model_data"];
        if (cmd === undefined) {
          out.unsupported.push({
            origin: `${path} → ${override.model}`,
            reason: `override predicate without custom_model_data (${Object.keys(predicate).join(", ") || "empty"}) — vanilla-behavior retexture, not mappable statically`,
          });
          continue;
        }
        const extraPredicates: VariantPredicate[] = [];
        // charged/firework combine into one Geyser charge_type match.
        const charged = predicate["charged"];
        const firework = predicate["firework"];
        if (firework !== undefined && firework !== 0) {
          extraPredicates.push({ type: "match", property: "charge_type", value: "rocket" });
        } else if (charged !== undefined) {
          extraPredicates.push({
            type: "match",
            property: "charge_type",
            value: charged !== 0 ? "arrow" : "none",
          });
        }
        for (const [key, value] of Object.entries(predicate)) {
          if (key === "custom_model_data" || key === "charged" || key === "firework") continue;
          if (key === "damaged" || key === "broken") {
            extraPredicates.push({ type: "condition", property: key, expected: value !== 0 });
          } else if (key === "damage") {
            extraPredicates.push({ type: "range_dispatch", property: "damage", threshold: value, normalize: true });
          } else if (key === "cast") {
            extraPredicates.push({ type: "condition", property: "fishing_rod_cast", expected: value !== 0 });
          } else {
            out.unsupported.push({
              origin: `${path} → ${override.model}`,
              reason: `unsupported extra predicate "${key}" ignored`,
            });
          }
        }
        out.variants.push({
          baseItem,
          model: override.model,
          source: { kind: "legacy", customModelData: cmd },
          predicates: extraPredicates,
          origin: path,
        });
      }
    }
  }
  return out;
}

/* ---------- Modern (1.21.4+) items/*.json definitions ---------- */

/**
 * Predicate properties Geyser's v2 mappings can evaluate (from Geyser's
 * ItemConditionProperty / match / range_dispatch readers). Java property →
 * Geyser property name; anything absent cannot be expressed and falls back to
 * the item's default look.
 */
const GEYSER_CONDITIONS: Record<string, string> = {
  broken: "broken",
  damaged: "damaged",
  custom_model_data: "custom_model_data",
  has_component: "has_component",
  "fishing_rod/cast": "fishing_rod_cast",
};

const GEYSER_MATCH_PROPERTIES: Record<string, string> = {
  charge_type: "charge_type",
  trim_material: "trim_material",
  context_dimension: "context_dimension",
  custom_model_data: "custom_model_data",
};

const GEYSER_RANGE_PROPERTIES: Record<string, string> = {
  damage: "damage",
  count: "count",
  custom_model_data: "custom_model_data",
  "bundle/fullness": "bundle_fullness",
  "compass_angle": "compass_angle",
  "clock": "clock",
};

interface ItemModelNode {
  type?: string;
  model?: ItemModelNode | string;
  models?: ItemModelNode[];
  property?: string;
  entries?: { threshold: number; model: ItemModelNode }[];
  fallback?: ItemModelNode;
  on_true?: ItemModelNode;
  on_false?: ItemModelNode;
  cases?: { when: unknown; model: ItemModelNode }[];
  base?: string;
  [key: string]: unknown;
}

interface ItemsAsset {
  model?: ItemModelNode;
}

/** Extract variants from modern item definition assets (assets/&lt;ns&gt;/items/*.json). */
export function extractModernVariants(pack: JavaPack): VariantExtraction {
  const out: VariantExtraction = { variants: [], unsupported: [] };
  for (const ns of pack.namespaces()) {
    const prefix = `assets/${ns}/items/`;
    for (const path of pack.list({ prefix, suffix: ".json" })) {
      const asset = pack.readJson<ItemsAsset>(path);
      const name = path.slice(prefix.length, -".json".length);
      const itemModelId = `${ns}:${name}`;
      if (asset?.model === undefined) {
        out.unsupported.push({ origin: path, reason: "items asset without model node" });
        continue;
      }
      // A definition for a vanilla item name in the minecraft namespace overrides
      // that item's default look; a custom namespace is addressed via the
      // minecraft:item_model component.
      const baseItem = ns === "minecraft" ? `minecraft:${name}` : undefined;
      flattenNode(asset.model, [], { pack: itemModelId, baseItem, origin: path, out });
    }
  }
  return out;
}

function flattenNode(
  node: ItemModelNode,
  predicates: VariantPredicate[],
  ctx: { pack: string; baseItem: string | undefined; origin: string; out: VariantExtraction },
  priority?: number,
): void {
  const type = (node.type ?? "").replace(/^minecraft:/, "");
  switch (type) {
    case "model": {
      if (typeof node.model === "string") {
        ctx.out.variants.push({
          baseItem: ctx.baseItem,
          model: node.model,
          source: { kind: "modern", itemModelId: ctx.pack },
          predicates,
          priority,
          origin: ctx.origin,
        });
      }
      return;
    }
    case "composite": {
      // Bedrock cannot layer multiple models on one item; take the first and flag it.
      const models = node.models ?? [];
      if (models.length > 0) {
        ctx.out.unsupported.push({
          origin: ctx.origin,
          reason: `composite model — only the first of ${models.length} sub-models is converted`,
        });
        flattenNode(models[0]!, predicates, ctx, priority);
      }
      return;
    }
    case "condition": {
      const property = (node.property ?? "").replace(/^minecraft:/, "");
      const geyserProperty = GEYSER_CONDITIONS[property];
      if (geyserProperty === undefined) {
        // Geyser can't test this state (using_item, selected, carried, …):
        // the "false" branch is the item's resting look — emit it without the
        // predicate; the state-specific branch cannot be expressed.
        ctx.out.unsupported.push({
          origin: ctx.origin,
          reason: `condition "${property}" not supported by Geyser — default (false) branch used, "${property}" state keeps the default look on Bedrock`,
        });
        if (node.on_false) flattenNode(node.on_false, predicates, ctx, priority);
        return;
      }
      if (node.on_true) {
        flattenNode(node.on_true, [...predicates, { type: "condition", property: geyserProperty }], ctx, priority);
      }
      if (node.on_false) {
        flattenNode(node.on_false, [...predicates, { type: "condition", property: geyserProperty, expected: false }], ctx, priority);
      }
      return;
    }
    case "range_dispatch": {
      const property = (node.property ?? "").replace(/^minecraft:/, "");
      const geyserProperty = GEYSER_RANGE_PROPERTIES[property];
      if (geyserProperty === undefined) {
        ctx.out.unsupported.push({
          origin: ctx.origin,
          reason: `range_dispatch on "${property}" not supported by Geyser — fallback model used for all values`,
        });
        if (node.fallback) flattenNode(node.fallback, predicates, ctx, priority);
        return;
      }
      // Java scales the property value before threshold comparison; forward it.
      const scale = typeof node["scale"] === "number" ? (node["scale"] as number) : undefined;
      const entries = [...(node.entries ?? [])].sort((a, b) => a.threshold - b.threshold);
      entries.forEach((entry, i) => {
        flattenNode(
          entry.model,
          [
            ...predicates,
            {
              type: "range_dispatch",
              property: geyserProperty,
              threshold: entry.threshold,
              ...(scale !== undefined ? { scale } : {}),
            },
          ],
          ctx,
          (priority ?? 0) + i + 1,
        );
      });
      // Fallback matches when no threshold does — lowest priority.
      if (node.fallback) flattenNode(node.fallback, predicates, ctx, priority ?? 0);
      return;
    }
    case "select": {
      const property = (node.property ?? "").replace(/^minecraft:/, "");
      const geyserProperty = GEYSER_MATCH_PROPERTIES[property];
      if (geyserProperty === undefined) {
        ctx.out.unsupported.push({
          origin: ctx.origin,
          reason: `select on "${property}" not supported by Geyser — fallback model used for all cases`,
        });
        if (node.fallback) flattenNode(node.fallback, predicates, ctx, priority);
        return;
      }
      for (const c of node.cases ?? []) {
        const whens = Array.isArray(c.when) ? c.when : [c.when];
        for (const when of whens) {
          // Convert non-string when values (numbers, booleans) to strings.
          const whenStr = typeof when === "string" ? when
            : typeof when === "number" || typeof when === "boolean" ? String(when)
            : undefined;
          if (whenStr !== undefined) {
            flattenNode(c.model, [...predicates, { type: "match", property: geyserProperty, value: whenStr }], ctx, priority);
          } else {
            ctx.out.unsupported.push({
              origin: ctx.origin,
              reason: `select case with non-primitive "when" on ${property} — skipped`,
            });
          }
        }
      }
      if (node.fallback) flattenNode(node.fallback, predicates, ctx, priority);
      return;
    }
    case "special": {
      ctx.out.unsupported.push({
        origin: ctx.origin,
        reason: `special model type (${JSON.stringify((node.model as ItemModelNode | undefined)?.type ?? "?")}) — uses ${node.base ?? "?"} as base model`,
      });
      if (typeof node.base === "string") {
        ctx.out.variants.push({
          baseItem: ctx.baseItem,
          model: node.base,
          source: { kind: "modern", itemModelId: ctx.pack },
          predicates,
          priority,
          origin: ctx.origin,
        });
      }
      return;
    }
    case "empty":
      return;
    default:
      ctx.out.unsupported.push({
        origin: ctx.origin,
        reason: `unsupported item model node type "${node.type ?? "(none)"}"`,
      });
  }
}

/** One staged pull entry inside a bow-pull group. */
export interface BowPullStage {
  /** Pull progress threshold (0 = start of pull, 1 = fully charged). */
  pull: number;
  /** Model to render at this stage, as a resource location. */
  model: string;
}

/**
 * A group of overrides on a bow (or bow-like item) that cycle through models
 * based on the `pulling` and `pull` predicates — detected from legacy
 * overrides so a charge-progress render controller can be emitted.
 */
export interface BowPullGroup {
  /** Vanilla item the overrides attach to, e.g. "minecraft:bow". */
  baseItem: string;
  /** Model shown when the bow is NOT being pulled. */
  standbyModel: string;
  /** Ordered pull stages (ascending pull threshold). */
  stages: BowPullStage[];
  /** Human-readable origin for the report. */
  origin: string;
}

/**
 * Detect bow-pull override groups from legacy model overrides.
 *
 * Vanilla `minecraft:item/bow.json` has overrides like:
 *   { predicate: { pulling: 1 }, model: "minecraft:item/bow_pulling_0" }
 *   { predicate: { pulling: 1, pull: 0.65 }, model: "minecraft:item/bow_pulling_1" }
 *   { predicate: { pulling: 1, pull: 0.9 }, model: "minecraft:item/bow_pulling_2" }
 *
 * This groups them into a `BowPullGroup` with a standby model + ordered pull
 * stages, and returns the grouped base items so callers can skip them in the
 * normal variant pipeline.
 */
export function extractBowPullGroups(pack: JavaPack): {
  groups: BowPullGroup[];
  /** Keys ("namespace:itemName") consumed by bow-pull groups — skip in legacy extraction. */
  consumedKeys: Set<string>;
} {
  const groups: BowPullGroup[] = [];
  const consumedKeys = new Set<string>();

  for (const ns of pack.namespaces()) {
    const prefix = `assets/${ns}/models/item/`;
    for (const path of pack.list({ prefix, suffix: ".json" })) {
      const model = pack.readJson<JavaModel>(path);
      if (model?.overrides === undefined || model.overrides.length === 0) continue;
      const itemName = path.slice(prefix.length, -".json".length);
      const baseItem = ns === "minecraft" ? `minecraft:${itemName}` : undefined;
      if (baseItem === undefined) continue; // Only vanilla-namespace bow-pull for now

      // Partition overrides: pulling-predicate vs everything else.
      const pulling: { override: NonNullable<JavaModel["overrides"]>[number]; pull: number }[] = [];
      let hasNonPulling = false;
      for (const override of model.overrides) {
        const predicate = override.predicate ?? {};
        const isPulling = predicate["pulling"] !== undefined;
        if (isPulling) {
          // Only accept pulling:1 (actually pulling the bow).
          if (predicate["pulling"] === 0) continue;
          const pull = typeof predicate["pull"] === "number" ? predicate["pull"] : 0;
          pulling.push({ override, pull });
        } else {
          hasNonPulling = true;
        }
      }

      // Need at least one pulling override to form a bow-pull group.
      // If there are non-pulling overrides (custom_model_data etc.), this
      // item uses a different dispatch mechanism — skip.
      if (pulling.length === 0) continue;
      if (hasNonPulling) continue;

      // Sort by pull threshold ascending.
      pulling.sort((a, b) => a.pull - b.pull);

      // The lowest pull threshold (usually 0) is the "start of pull" model;
      // use the item's parent or the first pull model's implicit standby.
      // For vanilla bows the standby is the item's own default model
      // (no override matches → base model). We represent it as the
      // item model path itself (e.g. "minecraft:item/bow").
      const standbyModel = `${ns}:item/${itemName}`;
      const stages: BowPullStage[] = pulling.map((p) => ({
        pull: p.pull,
        model: p.override.model,
      }));

      groups.push({ baseItem, standbyModel, stages, origin: path });
      consumedKeys.add(baseItem);
    }
  }

  return { groups, consumedKeys };
}

/** Convenience: read + lenient-parse a JSON file that may not exist. */
export function tryParse<T>(text: string | undefined): T | undefined {
  return text === undefined ? undefined : parseLenientJson<T>(text);
}
