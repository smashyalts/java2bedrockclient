import type { ConversionContext, GeyserItemDefinition, PipelineStage } from "../context.js";
import {
  extractLegacyVariants,
  extractModernVariants,
  type ItemVariant,
} from "../../java/itemVariants.js";
import { resolveModel, spriteLayers, type ResolvedModel } from "../../resolve/modelResolver.js";
import { parseResourceLocation } from "../../java/javaPack.js";
import { alphaBleed, compositeLayers, decodePng, encodePng, firstFrame } from "../../image/png.js";

/** Sanitize a resource location into a safe identifier chunk. */
export function safeName(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

function prettyName(id: string): string {
  const path = parseResourceLocation(id).path;
  const last = path.split("/").pop() ?? path;
  return last
    .split(/[_\-]/)
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Converts custom item variants (legacy custom_model_data overrides and modern
 * item definitions). 2D sprites are fully handled here; 3D geometry variants
 * are collected and handed to the geometry stage via ctx (milestone 3).
 */
export const itemsStage: PipelineStage = {
  name: "items",
  run(ctx: ConversionContext): void {
    const legacy = extractLegacyVariants(ctx.java);
    const modern = extractModernVariants(ctx.java);
    for (const u of [...legacy.unsupported, ...modern.unsupported]) {
      ctx.report.skipped("items", u.origin, u.reason);
    }

    const variants = [...legacy.variants, ...modern.variants];
    const seen = new Set<string>();
    let done = 0;
    for (const variant of variants) {
      done++;
      if (done % 25 === 0) ctx.progress("items", done, variants.length);
      const dedupeKey = JSON.stringify([variant.baseItem, variant.source, variant.predicates, variant.model]);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      try {
        convertVariant(ctx, variant);
      } catch (err) {
        ctx.report.error("items", `${variant.origin} → ${variant.model}`, err instanceof Error ? err.message : String(err));
      }
    }
    ctx.progress("items", variants.length, variants.length);
  },
};

function convertVariant(ctx: ConversionContext, variant: ItemVariant): void {
  const origin = `${variant.origin} → ${variant.model}`;
  const resolved = resolveModel(ctx.java, variant.model);
  if (resolved === undefined) {
    ctx.report.skipped("items", origin, `model ${variant.model} not found in pack (vanilla or missing)`);
    return;
  }

  switch (resolved.kind) {
    case "sprite":
    case "sprite_handheld":
      convertSpriteVariant(ctx, variant, resolved);
      return;
    case "geometry":
      // Handed off to the 3D geometry stage.
      ctx.pendingGeometry.push({ variant, resolved });
      return;
    case "builtin_entity":
      ctx.report.skipped("items", origin, "builtin/entity model (chest/shield/trident style) — needs hardcoded geometry, not yet supported");
      return;
    default:
      ctx.report.skipped("items", origin, `unclassifiable model (terminal parent: ${resolved.terminalParent ?? "none"})`);
  }
}

/** Vanilla items whose layer0 gets a server-side colour tint Java applies at render time. */
const TINTED_BASE_ITEMS = new Set([
  "minecraft:leather_helmet", "minecraft:leather_chestplate", "minecraft:leather_leggings",
  "minecraft:leather_boots", "minecraft:leather_horse_armor", "minecraft:potion",
  "minecraft:splash_potion", "minecraft:lingering_potion", "minecraft:tipped_arrow",
  "minecraft:filled_map", "minecraft:firework_star",
]);

function convertSpriteVariant(ctx: ConversionContext, variant: ItemVariant, resolved: ResolvedModel): void {
  const origin = `${variant.origin} → ${variant.model}`;
  if (variant.baseItem !== undefined && TINTED_BASE_ITEMS.has(variant.baseItem)) {
    ctx.report.approximated(
      "items",
      origin,
      `${variant.baseItem} tints layer0 server-side on Java — the tint cannot be applied statically, icon may look uncoloured`,
    );
  }
  const layers = spriteLayers(resolved);
  if (layers.length === 0) {
    ctx.report.skipped("items", origin, "sprite model has no layer textures");
    return;
  }

  const name = safeName(variant.model);
  const iconKey = name;
  const outPath = `textures/geyser_custom/${name}.png`;

  if (!ctx.itemTextures.has(iconKey)) {
    const images = [];
    for (const layerId of layers) {
      const texPath = ctx.java.assetPath("textures", layerId, ".png");
      const bytes = ctx.java.read(texPath);
      if (bytes === undefined) {
        ctx.report.approximated("items", origin, `layer texture ${layerId} missing from pack — layer dropped`);
        continue;
      }
      let image = decodePng(bytes);
      // Animated sprite (mcmeta flipbook): Bedrock cannot animate item icons,
      // so crop the vertical frame strip to its first frame.
      if (image.height > image.width && ctx.java.has(texPath + ".mcmeta")) {
        image = firstFrame(image);
        ctx.report.approximated("items", origin, `animated icon ${layerId} — Bedrock item icons cannot animate, first frame used`);
      }
      images.push(image);
    }
    if (images.length === 0) {
      ctx.report.skipped("items", origin, "no layer textures found in pack");
      return;
    }
    // Alpha-bleed so bilinear filtering doesn't fringe black at sprite edges.
    // (No padding: Bedrock stretches icons to the slot, and padding shrinks
    // the visible art — a 16x17 sprite would render at half size.)
    const icon = compositeLayers(images);
    alphaBleed(icon);
    ctx.bedrock.write(outPath, encodePng(icon));
    ctx.itemTextures.set(iconKey, { textures: `textures/geyser_custom/${name}` });
  }

  const definition = buildDefinition(ctx, variant, {
    icon: iconKey,
    displayHandheld: resolved.kind === "sprite_handheld",
  });
  ctx.definitionTextures.set(definition, layers);
  ctx.report.converted("items", origin, [outPath]);
}

/** Registers a Geyser v2 mapping entry for the variant. */
export function buildDefinition(
  ctx: ConversionContext,
  variant: ItemVariant,
  bedrock: { icon: string; displayHandheld: boolean; protectionValue?: number },
): GeyserItemDefinition {
  const name = safeName(variant.model);
  // Prefer the real display name from plugin configs over a filename guess.
  const nameKeys = [
    ...(variant.source.kind === "modern"
      ? [parseResourceLocation(variant.source.itemModelId).path.toLowerCase()]
      : []),
    parseResourceLocation(variant.model).path.split("/").pop()!.toLowerCase(),
  ];
  const hintedName = nameKeys.map((k) => ctx.options.displayNameHints[k]).find((v) => v !== undefined);
  const definition: GeyserItemDefinition = {
    type: variant.source.kind === "legacy" ? "legacy" : "definition",
    bedrock_identifier: `geyser_custom:${name}`,
    display_name: hintedName ?? prettyName(variant.model),
    bedrock_options: {
      icon: bedrock.icon,
      display_handheld: bedrock.displayHandheld,
      allow_offhand: true,
      ...(bedrock.protectionValue !== undefined ? { protection_value: bedrock.protectionValue } : {}),
    },
  };
  if (variant.source.kind === "legacy") {
    definition.custom_model_data = variant.source.customModelData;
  } else {
    definition.model = variant.source.itemModelId;
  }
  if (variant.predicates.length > 0) {
    definition.predicate = variant.predicates;
    definition.predicate_strategy = "and";
  }
  if (variant.priority !== undefined) {
    definition.priority = variant.priority;
  }

  let baseItem = variant.baseItem;
  if (baseItem === undefined) {
    // Base-item hints (parsed from Oraxen/Nexo server configs) beat the
    // generic fallback: try the item-model name, then the model's last segment.
    const hintKeys =
      variant.source.kind === "modern"
        ? [parseResourceLocation(variant.source.itemModelId).path.toLowerCase()]
        : [];
    hintKeys.push(parseResourceLocation(variant.model).path.split("/").pop()!.toLowerCase());
    const hinted = hintKeys.map((k) => ctx.options.baseItemHints[k]).find((v) => v !== undefined);

    if (hinted !== undefined) {
      baseItem = hinted;
      ctx.report.converted("items-hints", `${variant.origin} → ${variant.model}`, [`mapped under ${baseItem}`]);
    } else {
      baseItem = ctx.options.modernBaseItem;
      ctx.report.approximated(
        "items",
        `${variant.origin} → ${variant.model}`,
        `item-model asset has no fixed host item — mapped under ${baseItem}; upload your Oraxen/Nexo config zip or change the "modern base item" option`,
      );
    }
  }
  (ctx.geyserMappings.items[baseItem] ??= []).push(definition);
  return definition;
}
