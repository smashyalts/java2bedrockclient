import type { ConversionContext, GeyserItemDefinition, PipelineStage } from "../context.js";
import { buildBowPullAttachable, buildBowPullRenderController } from "../../bedrock/attachable.js";
import { buildDisplayAnimations } from "../../bedrock/animations.js";
import { buildGeometry, defaultUv } from "../../bedrock/geometry.js";
import { resolveModel, spriteLayers, type ResolvedModel } from "../../resolve/modelResolver.js";
import { alphaBleed, compositeLayers, decodeCached, encodePng, firstFrame } from "../../image/png.js";
import { safeName } from "./itemsStage.js";
import { parseResourceLocation } from "../../java/javaPack.js";
import type { BowPullGroup } from "../../java/itemVariants.js";

/**
 * Converts bow-pull override groups into Bedrock attachables with
 * charge-progress render controllers. Sprite-based only (vanilla bow
 * style); 3D bow models fall through to the geometry stage.
 */
export const bowPullStage: PipelineStage = {
  name: "bow-pull",
  run(ctx: ConversionContext): void {
    const groups = ctx.bowPullGroups;
    if (groups.length === 0) return;

    let done = 0;
    for (const group of groups) {
      done++;
      ctx.progress("bow-pull", done, groups.length);
      try {
        convertBowPullGroup(ctx, group);
      } catch (err) {
        ctx.report.error("bow-pull", group.origin, err instanceof Error ? err.message : String(err));
      }
    }
    ctx.progress("bow-pull", groups.length, groups.length);
  },
};

function convertBowPullGroup(ctx: ConversionContext, group: BowPullGroup): void {
  const origin = group.origin;

  // Collect all models: standby first, then pull stages in order.
  const modelIds = [group.standbyModel, ...group.stages.map((s) => s.model)];
  const resolved: ResolvedModel[] = [];
  for (const id of modelIds) {
    const r = resolveModel(ctx.java, id);
    if (r === undefined) {
      ctx.report.skipped("bow-pull", origin, `model ${id} not found in pack`);
      return;
    }
    // Only sprite-based bow models are supported in this prototype.
    if (r.kind !== "sprite" && r.kind !== "sprite_handheld") {
      ctx.report.skipped(
        "bow-pull",
        origin,
        `bow-pull model ${id} is not a sprite (${r.kind}) — 3D bow models not yet supported in bow-pull prototype`,
      );
      return;
    }
    resolved.push(r);
  }

  // Extract the layer0 texture id for each stage.
  const textureIds = resolved.map((r) => {
    const layers = spriteLayers(r);
    return layers.length > 0 ? layers[0]! : undefined;
  });
  if (textureIds.some((t) => t === undefined)) {
    ctx.report.skipped("bow-pull", origin, "one or more bow-pull models have no layer0 texture");
    return;
  }

  // Load and composite each stage texture.
  const name = safeName(group.baseItem);
  const stageTextures: { key: string; path: string }[] = [];
  const shortnames: string[] = [];
  const extraTextures: Record<string, string> = {};

  const allTextureIds = new Set<string>();
  for (let i = 0; i < textureIds.length; i++) {
    const texId = textureIds[i]!;
    allTextureIds.add(texId);
    const stageKey = i === 0 ? "default" : `pull${i}`;
    shortnames.push(stageKey);
    const outPath = `textures/geyser_custom/bow_${name}_${stageKey}`;

    if (!ctx.itemTextures.has(`bow_${name}_${stageKey}`)) {
      const texPath = ctx.java.assetPath("textures", texId, ".png");
      const decoded = decodeCached(ctx.java.read.bind(ctx.java), texPath, ctx.textureCache);
      if (decoded === undefined) {
        ctx.report.approximated("bow-pull", origin, `texture ${texId} missing — stage ${i} skipped`);
        continue;
      }
      let image = decoded;
      // Animated texture: crop to first frame (same as itemsStage).
      if (image.height > image.width && ctx.java.has(texPath + ".mcmeta")) {
        image = firstFrame(image);
      }
      const icon = compositeLayers([image]);
      alphaBleed(icon);
      ctx.bedrock.write(outPath + ".png", encodePng(icon));
      ctx.itemTextures.set(`bow_${name}_${stageKey}`, { textures: outPath });
    }

    stageTextures.push({ key: stageKey, path: outPath });
    if (i > 0) {
      extraTextures[stageKey] = outPath;
    }
  }

  if (stageTextures.length < 2) {
    ctx.report.skipped("bow-pull", origin, "not enough valid pull stages to build a render controller");
    return;
  }

  // Geometry: a simple flat sprite box (same as vanilla item rendering).
  const geometryId = `geometry.geyser_custom.bow_${name}`;
  // Use the standby texture dimensions for the atlas; bows are always 1-pixel-wide
  // strips on a 16×16 sprite, so use a 16×16 UV for the flat face.
  const standbyTexPath = ctx.java.assetPath("textures", textureIds[0]!, ".png");
  const standbyImg = decodeCached(ctx.java.read.bind(ctx.java), standbyTexPath, ctx.textureCache) ?? { width: 16, height: 16, data: new Uint8Array(0) };
  const atlasW = standbyImg.width;
  const atlasH = standbyImg.height;

  // Single flat element like a vanilla held item.
  const elements = [{
    from: [0, 0, 8] as [number, number, number],
    to: [16, 16, 8] as [number, number, number],
    faces: {
      north: { uv: [0, 0, 16, 16] as [number, number, number, number], texture: "#default" },
      south: { uv: [0, 0, 16, 16] as [number, number, number, number], texture: "#default" },
    },
  }];
  const faceTexture = () => ({ x: 0, y: 0, width: atlasW, height: atlasH });
  const geo = buildGeometry(geometryId, elements, faceTexture, { width: atlasW, height: atlasH });
  ctx.bedrock.writeJson(`models/entity/geyser_custom/bow_${name}.geo.json`, geo.geometry);

  // Display animations (bow uses vanilla display transforms).
  const standbyDisplay = resolved[0]!.display;
  const anims = buildDisplayAnimations(`bow_${name}`, standbyDisplay);
  ctx.bedrock.writeJson(`animations/geyser_custom/bow_${name}.animation.json`, anims.file);

  // Render controller.
  const renderControllerId = `controller.render.gc_bow_${name}`;
  ctx.bedrock.writeJson(
    `render_controllers/geyser_custom/bow_${name}.render_controllers.json`,
    buildBowPullRenderController({ id: renderControllerId, frameShortnames: shortnames }),
  );

  // Icon: use the standby texture.
  const iconKey = `bow_${name}_icon`;
  if (!ctx.itemTextures.has(iconKey)) {
    const texPath = ctx.java.assetPath("textures", textureIds[0]!, ".png");
    const decoded = decodeCached(ctx.java.read.bind(ctx.java), texPath, ctx.textureCache);
    if (decoded !== undefined) {
      let image = decoded;
      if (image.height > image.width && ctx.java.has(texPath + ".mcmeta")) {
        image = firstFrame(image);
      }
      const icon = compositeLayers([image]);
      alphaBleed(icon);
      ctx.bedrock.write(`textures/geyser_custom/icons/bow_${name}.png`, encodePng(icon));
      ctx.itemTextures.set(iconKey, { textures: `textures/geyser_custom/icons/bow_${name}` });
    }
  }

  // Geyser mapping on the base item (e.g. minecraft:bow).
  // Build a definition-type mapping keyed on the standby model id, so Geyser
  // matches the vanilla item's default model. This avoids custom_model_data
  // which doesn't apply to vanilla pull-based overrides.
  const loc = parseResourceLocation(group.standbyModel);
  const modelKey = `${loc.namespace}:${loc.path}`;
  const identifierName = `bow_${name}`;
  let bedrockId = `geyser_custom:${identifierName}`;
  // Deduplicate identifier.
  if (ctx.usedBedrockIdentifiers.has(identifierName)) {
    for (let i = 2; ; i++) {
      const candidate = `${identifierName}_${i}`;
      if (!ctx.usedBedrockIdentifiers.has(candidate)) {
        bedrockId = `geyser_custom:${candidate}`;
        ctx.usedBedrockIdentifiers.add(candidate);
        break;
      }
    }
  } else {
    ctx.usedBedrockIdentifiers.add(identifierName);
  }

  const definition: GeyserItemDefinition = {
    type: "definition",
    model: modelKey,
    bedrock_identifier: bedrockId,
    display_name: "Bow",
    bedrock_options: {
      icon: iconKey,
      display_handheld: false,
      allow_offhand: true,
    },
  };
  (ctx.geyserMappings.items[group.baseItem] ??= []).push(definition);
  ctx.definitionTextures.set(definition, [...allTextureIds]);

  // Attachable.
  const isCrossbow = group.baseItem === "minecraft:crossbow";
  const attachablePath = `attachables/geyser_custom/${safeName(bedrockId.split(":")[1] ?? bedrockId)}.json`;
  ctx.bedrock.writeJson(
    attachablePath,
    buildBowPullAttachable({
      identifier: bedrockId,
      material: ctx.options.attachableMaterial,
      texture: stageTextures[0]!.path,
      geometry: geometryId,
      animations: anims.refs,
      extraTextures,
      renderController: renderControllerId,
      maxUseDuration: isCrossbow ? 25 : 72000,
    }),
  );

  const outputs = [
    ...stageTextures.map((s) => s.path + ".png"),
    `models/entity/geyser_custom/bow_${name}.geo.json`,
    `animations/geyser_custom/bow_${name}.animation.json`,
    `render_controllers/geyser_custom/bow_${name}.render_controllers.json`,
    attachablePath,
  ];
  ctx.report.converted("bow-pull", origin, [
    ...outputs,
    `bow-pull render controller: ${shortnames.length} frames (standby + ${shortnames.length - 1} pull stages)`,
    "NOTE: charge-progress Molang is a prototype — verify in-game; tune q.use_duration / 72000 if frames don't align",
  ]);
}
