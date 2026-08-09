import type { JavaPack } from "./javaPack.js";
import type { JavaModel } from "./model.js";
import { parseLenientJson } from "./json.js";

/** One predicate condition attached to an item variant, in Geyser v2 predicate shape. */
export type VariantPredicate =
  /**
   * `component` is mandatory for `has_component` and `index` optional for
   * `custom_model_data` — Geyser throws on the whole mappings file if a
   * `has_component` predicate arrives without one.
   */
  | { type: "condition"; property: string; expected?: boolean; component?: string; index?: number }
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
        const extraPredicates = legacyOverridePredicates(predicate, `${path} → ${override.model}`, out);

        if (cmd !== undefined) {
          out.variants.push({
            baseItem,
            model: override.model,
            source: { kind: "legacy", customModelData: cmd },
            predicates: extraPredicates,
            origin: path,
          });
          continue;
        }

        // No custom_model_data. If the override still carries a Geyser-mappable
        // predicate (damaged/broken/damage/cast), it's a vanilla-behavior
        // retexture (e.g. a damaged-elytra skin) that Geyser CAN express as a
        // v2 definition keyed on the vanilla item's own item_model plus that
        // predicate. Only vanilla items have a stable item_model to key on.
        if (extraPredicates.length > 0 && baseItem !== undefined) {
          out.variants.push({
            baseItem,
            model: override.model,
            source: { kind: "modern", itemModelId: baseItem },
            predicates: extraPredicates,
            origin: path,
          });
        } else {
          out.unsupported.push({
            origin: `${path} → ${override.model}`,
            reason: `override predicate without custom_model_data or a mappable predicate (${Object.keys(predicate).join(", ") || "empty"}) — vanilla-behavior retexture, not mappable statically`,
          });
        }
      }
    }
  }
  return out;
}

/**
 * Translate a legacy override predicate's non-cmd keys into Geyser v2
 * predicates. charged/firework fold into one charge_type match;
 * damaged/broken/damage/cast map to their Geyser equivalents; anything else is
 * reported and dropped. custom_model_data itself is handled by the caller.
 */
function legacyOverridePredicates(
  predicate: Record<string, number>,
  origin: string,
  out: VariantExtraction,
): VariantPredicate[] {
  const extraPredicates: VariantPredicate[] = [];
  const charged = predicate["charged"];
  const firework = predicate["firework"];
  if (firework !== undefined && firework !== 0) {
    extraPredicates.push({ type: "match", property: "charge_type", value: "rocket" });
  } else if (charged !== undefined && charged !== 0) {
    extraPredicates.push({ type: "match", property: "charge_type", value: "arrow" });
  } else if (charged === 0) {
    // "not charged" needs a negated match, which the v2 format has no syntax
    // for — emit the model unconditionally rather than an unreadable predicate.
    out.unsupported.push({
      origin,
      reason: `"charged: 0" (uncharged crossbow) can't be expressed as a Geyser match predicate — model used for every charge state`,
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
      out.unsupported.push({ origin, reason: `unsupported extra predicate "${key}" ignored` });
    }
  }
  return extraPredicates;
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

/**
 * Values Geyser accepts for a match property whose value is an enum rather than
 * a free identifier. Geyser resolves these with `Enum.valueOf`, so a value
 * outside the set throws and the whole definition is dropped from the mappings.
 *
 * Java's `charge_type` has a third case, `none`, that Geyser's ChargedProjectile
 * .ChargeType doesn't — and a match predicate can't be negated, so "not
 * charged" has no v2 equivalent at all.
 */
const GEYSER_MATCH_VALUES: Record<string, Set<string>> = {
  charge_type: new Set(["arrow", "rocket"]),
};

/**
 * Geyser's ItemRangeDispatchProperty. Java has several more range properties
 * (`time`, `compass`, `crossbow/pull`, `use_duration`, …) that fall through to
 * the fallback model — deliberately absent rather than mapped to a name Geyser
 * would reject.
 */
const GEYSER_RANGE_PROPERTIES: Record<string, string> = {
  damage: "damage",
  count: "count",
  custom_model_data: "custom_model_data",
  "bundle/fullness": "bundle_fullness",
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
  /** `has_component` condition: the data component whose presence is tested. */
  component?: string;
  /** `custom_model_data` condition: which entry of the component's list to read. */
  index?: number;
  [key: string]: unknown;
}

interface ItemsAsset {
  model?: ItemModelNode;
}

/** Extract variants from modern item definition assets (assets/&lt;ns&gt;/items/*.json).
 * `bowPullConsumed` — item-model ids already handled by a bow-pull group are skipped. */
export function extractModernVariants(
  pack: JavaPack,
  bowPullConsumed?: Set<string>,
): VariantExtraction {
  const out: VariantExtraction = { variants: [], unsupported: [] };
  for (const ns of pack.namespaces()) {
    const prefix = `assets/${ns}/items/`;
    for (const path of pack.list({ prefix, suffix: ".json" })) {
      const asset = pack.readJson<ItemsAsset>(path);
      const name = path.slice(prefix.length, -".json".length);
      const itemModelId = `${ns}:${name}`;
      if (bowPullConsumed?.has(itemModelId)) continue;
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
      // `has_component` carries the component it tests for, and Geyser rejects
      // the entire mappings file if it's missing — treat an absent one the same
      // as an unsupported condition rather than emitting an unloadable file.
      const extra =
        geyserProperty === "has_component"
          ? typeof node.component === "string"
            ? { component: node.component }
            : undefined
          : geyserProperty === "custom_model_data" && typeof node.index === "number"
            ? { index: node.index }
            : {};
      if (geyserProperty === undefined || extra === undefined) {
        // Geyser can't test this state (using_item, selected, carried, …):
        // the "false" branch is the item's resting look — emit it without the
        // predicate; the state-specific branch cannot be expressed.
        const reason =
          extra === undefined
            ? `condition "${property}" has no "component" to test — default (false) branch used`
            : `condition "${property}" not supported by Geyser — default (false) branch used, "${property}" state keeps the default look on Bedrock`;
        ctx.out.unsupported.push({ origin: ctx.origin, reason });
        if (node.on_false) flattenNode(node.on_false, predicates, ctx, priority);
        return;
      }
      if (node.on_true) {
        flattenNode(node.on_true, [...predicates, { type: "condition", property: geyserProperty, ...extra }], ctx, priority);
      }
      if (node.on_false) {
        flattenNode(node.on_false, [...predicates, { type: "condition", property: geyserProperty, expected: false, ...extra }], ctx, priority);
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
          const allowed = GEYSER_MATCH_VALUES[geyserProperty];
          if (whenStr !== undefined && allowed !== undefined && !allowed.has(whenStr.toLowerCase())) {
            // Geyser reads this value as an enum constant; an unknown one makes
            // it reject the definition, so drop the case instead.
            ctx.out.unsupported.push({
              origin: ctx.origin,
              reason: `select case "${whenStr}" on ${property} has no Geyser equivalent — that state keeps the default look on Bedrock`,
            });
          } else if (whenStr !== undefined) {
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
 * A group of models on a bow-like item that cycle through frames as the item
 * is drawn — detected from either legacy `pulling`/`pull` overrides or a modern
 * `condition(using_item) → range_dispatch(use_duration)` item definition — so a
 * charge-progress render controller can be emitted.
 */
export interface BowPullGroup {
  /** Vanilla host item (e.g. "minecraft:bow"). Known for legacy; undefined for
   * modern (resolved from config hints / default in the stage). */
  baseItem?: string;
  /** Modern item-model id (e.g. "oraxen:abyss_bow") — hint lookup + naming. */
  itemModelId?: string;
  /** Value for the Geyser mapping `model` field: legacy → "ns:item/name",
   * modern → the item-model id. */
  modelKey: string;
  /** True for modern item-definition bows (Geyser `type: "definition"`). */
  isModern: boolean;
  /** Model shown when the bow is NOT being drawn. */
  standbyModel: string;
  /** Ordered pull stages (ascending pull threshold). */
  stages: BowPullStage[];
  /**
   * Java range_dispatch scale on the pull property (bow `use_duration` = 0.05).
   * The stage thresholds are already in the post-scale [0,1] domain; this is
   * kept so the render controller can map Bedrock's use-duration query to the
   * same domain.
   */
  scale: number;
  /** Human-readable origin for the report. */
  origin: string;
}

/** Pick a single representative standby model from an on_false node. */
function standbyModelOf(node: ItemModelNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  const type = (node.type ?? "").replace(/^minecraft:/, "");
  if (type === "model" && typeof node.model === "string") return node.model;
  return undefined; // select/composite/etc. → not a plain-standby bow
}

/** Build ordered pull stages from a range_dispatch node (fallback = pull 0). */
function pullStagesOf(node: ItemModelNode): BowPullStage[] | undefined {
  const stages: BowPullStage[] = [];
  const fallbackModel = standbyModelOf(node.fallback);
  if (fallbackModel !== undefined) stages.push({ pull: 0, model: fallbackModel });
  for (const entry of node.entries ?? []) {
    const m = standbyModelOf(entry.model);
    if (m === undefined) return undefined; // 3D / nested stage model — not supported here
    stages.push({ pull: entry.threshold, model: m });
  }
  stages.sort((a, b) => a.pull - b.pull);
  return stages.length >= 2 ? stages : undefined;
}

/**
 * Detect bow-pull groups from both legacy overrides and modern item definitions.
 *
 * Legacy `minecraft:item/bow.json`:
 *   { predicate: { pulling: 1 }, model: "…/bow_pulling_0" }
 *   { predicate: { pulling: 1, pull: 0.65 }, model: "…/bow_pulling_1" }
 *
 * Modern `assets/oraxen/items/abyss_bow.json`:
 *   condition(using_item){ on_false: model(bow), on_true: range_dispatch(use_duration){…} }
 *
 * Only bows whose resting (on_false) look is a single plain model are handled —
 * crossbows put a `select(charge_type)` there (charged-arrow/rocket states),
 * which the normal pipeline already converts, so they stay on that path.
 */
export function extractBowPullGroups(pack: JavaPack): {
  groups: BowPullGroup[];
  /** Legacy vanilla item keys consumed — skip in legacy override extraction. */
  consumedKeys: Set<string>;
  /** Modern item-model ids consumed — skip in modern definition extraction. */
  consumedModernKeys: Set<string>;
} {
  const groups: BowPullGroup[] = [];
  const consumedKeys = new Set<string>();
  const consumedModernKeys = new Set<string>();

  // --- Legacy overrides (vanilla-namespace pulling bows). ---
  for (const ns of pack.namespaces()) {
    const prefix = `assets/${ns}/models/item/`;
    for (const path of pack.list({ prefix, suffix: ".json" })) {
      const model = pack.readJson<JavaModel>(path);
      if (model?.overrides === undefined || model.overrides.length === 0) continue;
      const itemName = path.slice(prefix.length, -".json".length);
      const baseItem = ns === "minecraft" ? `minecraft:${itemName}` : undefined;
      if (baseItem === undefined) continue; // Only vanilla-namespace legacy bow-pull

      const pulling: { override: NonNullable<JavaModel["overrides"]>[number]; pull: number }[] = [];
      let hasNonPulling = false;
      for (const override of model.overrides) {
        const predicate = override.predicate ?? {};
        if (predicate["pulling"] !== undefined) {
          if (predicate["pulling"] === 0) continue;
          const pull = typeof predicate["pull"] === "number" ? predicate["pull"] : 0;
          pulling.push({ override, pull });
        } else {
          hasNonPulling = true;
        }
      }
      if (pulling.length === 0 || hasNonPulling) continue;

      pulling.sort((a, b) => a.pull - b.pull);
      const standbyModel = `${ns}:item/${itemName}`;
      const stages: BowPullStage[] = pulling.map((p) => ({ pull: p.pull, model: p.override.model }));
      groups.push({
        baseItem,
        modelKey: standbyModel,
        isModern: false,
        standbyModel,
        stages,
        scale: 0.05, // vanilla pull predicate: 0..1 over a ~20-tick draw
        origin: path,
      });
      consumedKeys.add(baseItem);
    }
  }

  // --- Modern item definitions (custom-model bows, incl. Oraxen/Nexo). ---
  for (const ns of pack.namespaces()) {
    const prefix = `assets/${ns}/items/`;
    for (const path of pack.list({ prefix, suffix: ".json" })) {
      const asset = pack.readJson<ItemsAsset>(path);
      const root = asset?.model;
      if (root === undefined) continue;
      if ((root.type ?? "").replace(/^minecraft:/, "") !== "condition") continue;
      if ((root.property ?? "").replace(/^minecraft:/, "") !== "using_item") continue;

      const standbyModel = standbyModelOf(root.on_false);
      const onTrue = root.on_true;
      if (standbyModel === undefined || onTrue === undefined) continue;
      if ((onTrue.type ?? "").replace(/^minecraft:/, "") !== "range_dispatch") continue;
      // Bows use `use_duration`; crossbows use `crossbow/pull` and put a
      // charge-state select in on_false (handled above → skipped here).
      if ((onTrue.property ?? "").replace(/^minecraft:/, "") !== "use_duration") continue;

      const stages = pullStagesOf(onTrue);
      if (stages === undefined) continue;

      const name = path.slice(prefix.length, -".json".length);
      const itemModelId = `${ns}:${name}`;
      const scale = typeof onTrue["scale"] === "number" ? (onTrue["scale"] as number) : 1;
      groups.push({
        itemModelId,
        modelKey: itemModelId,
        isModern: true,
        standbyModel,
        stages,
        scale,
        origin: path,
      });
      consumedModernKeys.add(itemModelId);
    }
  }

  return { groups, consumedKeys, consumedModernKeys };
}
