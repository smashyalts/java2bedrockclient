import type { ConversionContext, GeyserItemDefinition, PipelineStage } from "../context.js";
import {
  extractBowPullGroups,
  extractLegacyVariants,
  extractModernVariants,
  type ItemVariant,
} from "../../java/itemVariants.js";
import { resolveModel, spriteLayers, type ResolvedModel } from "../../resolve/modelResolver.js";
import { parseResourceLocation } from "../../java/javaPack.js";
import { alphaBleed, compositeLayers, decodeCached, encodePng, firstFrame, tint, type RgbaImage } from "../../image/png.js";

/** Sanitize a resource location into a safe identifier chunk. */
export function safeName(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
}

interface EncodeJob {
  path: string;
  image: RgbaImage;
}

const ENCODE_POOL_THRESHOLD = 24;

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
  async run(ctx: ConversionContext): Promise<void> {
    // Detect bow-pull groups first so their overrides are skipped in legacy extraction.
    const { groups: bowPullGroups, consumedKeys } = extractBowPullGroups(ctx.java);
    ctx.bowPullGroups = bowPullGroups;
    const legacy = extractLegacyVariants(ctx.java, consumedKeys);
    const modern = extractModernVariants(ctx.java);
    for (const u of [...legacy.unsupported, ...modern.unsupported]) {
      ctx.report.skipped("items", u.origin, u.reason);
    }

    const variants = [...legacy.variants, ...modern.variants];
    const seen = new Set<string>();
    const encodeJobs: EncodeJob[] = [];
    let done = 0;
    for (const variant of variants) {
      done++;
      if (done % 25 === 0) ctx.progress("items", done, variants.length);
      const dedupeKey = `${variant.baseItem ?? "?"}|${variant.source.kind}|${variant.model}|${variant.predicates.length}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      try {
        convertVariant(ctx, variant, encodeJobs);
      } catch (err) {
        ctx.report.error("items", `${variant.origin} → ${variant.model}`, err instanceof Error ? err.message : String(err));
      }
    }

    // Flush PNG encodes in parallel via the worker pool when available.
    if (encodeJobs.length > 0) {
      const encoder = ctx.options.pngEncoder;
      if (encoder !== undefined && encodeJobs.length >= ENCODE_POOL_THRESHOLD) {
        const pngs = await encoder.encode(encodeJobs.map((j) => j.image));
        encodeJobs.forEach((j, i) => ctx.bedrock.write(j.path, pngs[i]!));
      } else {
        for (const j of encodeJobs) ctx.bedrock.write(j.path, encodePng(j.image));
      }
    }

    ctx.progress("items", variants.length, variants.length);
  },
};

function convertVariant(ctx: ConversionContext, variant: ItemVariant, encodeJobs: EncodeJob[]): void {
  const origin = `${variant.origin} → ${variant.model}`;
  const resolved = resolveModel(ctx.java, variant.model);
  if (resolved === undefined) {
    ctx.report.skipped("items", origin, `model ${variant.model} not found in pack (vanilla or missing)`);
    return;
  }

  switch (resolved.kind) {
    case "sprite":
    case "sprite_handheld":
      convertSpriteVariant(ctx, variant, resolved, encodeJobs);
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

function convertSpriteVariant(ctx: ConversionContext, variant: ItemVariant, resolved: ResolvedModel, encodeJobs: EncodeJob[]): void {
  const origin = `${variant.origin} → ${variant.model}`;
  // Fixed dye colour from plugin configs — bake the server-side tint into the icon.
  const colorHint = variant.baseItem !== undefined && TINTED_BASE_ITEMS.has(variant.baseItem)
    ? findColorHint(ctx, variant)
    : undefined;
  if (variant.baseItem !== undefined && TINTED_BASE_ITEMS.has(variant.baseItem)) {
    if (colorHint !== undefined) {
      ctx.report.converted("items-hints", origin, [
        `config colour #${colorHint.toString(16).padStart(6, "0")} baked into layer0`,
      ]);
    } else {
      ctx.report.approximated(
        "items",
        origin,
        `${variant.baseItem} tints layer0 server-side on Java — the tint cannot be applied statically, icon may look uncoloured (add "color:" to the plugin config to bake it)`,
      );
    }
  }
  const layers = spriteLayers(resolved);
  if (layers.length === 0) {
    ctx.report.skipped("items", origin, "sprite model has no layer textures");
    return;
  }

  const name = safeName(variant.model);
  const iconKey = colorHint !== undefined ? `${name}_${colorHint.toString(16)}` : name;
  const outPath = `textures/geyser_custom/${iconKey}.png`;

  if (!ctx.itemTextures.has(iconKey)) {
    const images = [];
    for (const layerId of layers) {
      const texPath = ctx.java.assetPath("textures", layerId, ".png");
      const image = decodeCached(ctx.java.read.bind(ctx.java), texPath, ctx.textureCache);
      if (image === undefined) {
        ctx.report.approximated("items", origin, `layer texture ${layerId} missing from pack — layer dropped`);
        continue;
      }
      let img = image;
      // Animated sprite (mcmeta flipbook): Bedrock cannot animate item icons,
      // so crop the vertical frame strip to its first frame.
      if (img.height > img.width && ctx.java.has(texPath + ".mcmeta")) {
        img = firstFrame(img);
        ctx.report.approximated("items", origin, `animated icon ${layerId} — Bedrock item icons cannot animate, first frame used`);
      }
      images.push(img);
    }
    if (images.length === 0) {
      ctx.report.skipped("items", origin, "no layer textures found in pack");
      return;
    }
    // Java tints layer0 only; overlay layers stay uncoloured.
    if (colorHint !== undefined && images.length > 0) {
      tint(images[0]!, colorHint);
    }
    // Alpha-bleed so bilinear filtering doesn't fringe black at sprite edges.
    // (No padding: Bedrock stretches icons to the slot, and padding shrinks
    // the visible art — a 16x17 sprite would render at half size.)
    const icon = compositeLayers(images);
    alphaBleed(icon);
    encodeJobs.push({ path: outPath, image: icon });
    ctx.itemTextures.set(iconKey, { textures: `textures/geyser_custom/${iconKey}` });
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
  // Resolve the host item early — it also keys the config cmd lookup below.
  const baseItem = resolveBaseItem(ctx, variant);

  // Config item key via (material, custom_model_data): the strongest link for
  // packs that dispatch everything off vanilla items with cmd (Nexo/Oraxen).
  const cmdValue =
    variant.source.kind === "legacy"
      ? variant.source.customModelData
      : variant.predicates.find(
          (p): p is Extract<typeof p, { type: "range_dispatch" }> =>
            p.type === "range_dispatch" && p.property === "custom_model_data",
        )?.threshold;
  const configKey =
    cmdValue !== undefined ? ctx.options.cmdItemKeys[`${baseItem}|${cmdValue}`] : undefined;

  // Prefer the real display name from plugin configs over a filename guess.
  const nameKeys = [
    ...(configKey !== undefined ? [configKey] : []),
    ...(variant.source.kind === "modern"
      ? [parseResourceLocation(variant.source.itemModelId).path.toLowerCase()]
      : []),
    parseResourceLocation(variant.model).path.split("/").pop()!.toLowerCase(),
  ];
  const hintedName = nameKeys.map((k) => ctx.options.displayNameHints[k]).find((v) => v !== undefined);

  // Identifier priority: config item key → item-model id (unless it's a
  // generic vanilla id) → model path. Readable and stable even when the pack
  // obfuscates model paths (Nexo UUID shuffling); model path disambiguates
  // multi-model items (condition branches).
  const modernPath =
    variant.source.kind === "modern" ? parseResourceLocation(variant.source.itemModelId) : undefined;
  const base =
    configKey !== undefined
      ? safeName(configKey)
      : modernPath !== undefined && modernPath.namespace !== "minecraft"
        ? safeName(modernPath.path)
        : safeName(variant.model);
  let identifierName = base;
  if (ctx.usedBedrockIdentifiers.has(identifierName)) {
    identifierName = `${base}_${safeName(variant.model)}`;
    for (let i = 2; ctx.usedBedrockIdentifiers.has(identifierName); i++) {
      identifierName = `${base}_${safeName(variant.model)}_${i}`;
    }
  }
  ctx.usedBedrockIdentifiers.add(identifierName);

  const definition: GeyserItemDefinition = {
    type: variant.source.kind === "legacy" ? "legacy" : "definition",
    bedrock_identifier: `geyser_custom:${identifierName}`,
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

  // Furniture (display-entity items from plugin configs): record a
  // GeyserDisplayEntity extension mapping so world-placed furniture renders
  // for Bedrock players (offsets tunable in the emitted YAML).
  if (ctx.options.furnitureItems.length > 0) {
    const furnitureKey = nameKeys.find((k) => ctx.options.furnitureItems.includes(k));
    if (furnitureKey !== undefined) {
      // Prefer GeyserDisplayEntity's legacy match (model-data) whenever the
      // furniture item is custom_model_data-dispatched — legacy or modern.
      // It matches the placed item's cmd directly instead of relying on
      // Geyser having already translated it to the custom bedrock item, which
      // hide-unmapped-vanilla-displays would otherwise hide.
      ctx.displayEntityMappings.push({
        key: identifierName,
        type: baseItem,
        identifier: identifierName,
        ...(cmdValue !== undefined ? { modelData: cmdValue } : {}),
      });
    }
  }

  (ctx.geyserMappings.items[baseItem] ??= []).push(definition);
  return definition;
}

/** Fixed dye colour hint for the variant (config key via cmd, item-model name, model name). */
function findColorHint(ctx: ConversionContext, variant: ItemVariant): number | undefined {
  const keys: string[] = [];
  const cmd =
    variant.source.kind === "legacy"
      ? variant.source.customModelData
      : variant.predicates.find(
          (p): p is Extract<typeof p, { type: "range_dispatch" }> =>
            p.type === "range_dispatch" && p.property === "custom_model_data",
        )?.threshold;
  if (variant.baseItem !== undefined && cmd !== undefined) {
    const configKey = ctx.options.cmdItemKeys[`${variant.baseItem}|${cmd}`];
    if (configKey !== undefined) keys.push(configKey);
  }
  if (variant.source.kind === "modern") {
    keys.push(parseResourceLocation(variant.source.itemModelId).path.toLowerCase());
  }
  keys.push(parseResourceLocation(variant.model).path.split("/").pop()!.toLowerCase());
  return keys.map((k) => ctx.options.colorHints[k]).find((v) => v !== undefined);
}

/** Host item: pack-declared → config hints → configurable fallback. */
function resolveBaseItem(ctx: ConversionContext, variant: ItemVariant): string {
  if (variant.baseItem !== undefined) return variant.baseItem;
  // Base-item hints (parsed from Oraxen/Nexo server configs) beat the
  // generic fallback: try the item-model name, then the model's last segment.
  const hintKeys =
    variant.source.kind === "modern"
      ? [parseResourceLocation(variant.source.itemModelId).path.toLowerCase()]
      : [];
  hintKeys.push(parseResourceLocation(variant.model).path.split("/").pop()!.toLowerCase());
  const hinted = hintKeys.map((k) => ctx.options.baseItemHints[k]).find((v) => v !== undefined);
  if (hinted !== undefined) {
    ctx.report.converted("items-hints", `${variant.origin} → ${variant.model}`, [`mapped under ${hinted}`]);
    return hinted;
  }
  ctx.report.approximated(
    "items",
    `${variant.origin} → ${variant.model}`,
    `item-model asset has no fixed host item — mapped under ${ctx.options.modernBaseItem}; upload your Oraxen/Nexo config zip or change the "modern base item" option`,
  );
  ctx.fallbackBaseItemHits++;
  return ctx.options.modernBaseItem;
}
