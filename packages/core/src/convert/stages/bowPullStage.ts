import type { ConversionContext, GeyserItemDefinition, PipelineStage } from "../context.js";
import { buildBowPullAttachable, buildBowPullRenderController } from "../../bedrock/attachable.js";
import { buildDisplayAnimations } from "../../bedrock/animations.js";
import { buildGeometry, defaultUv } from "../../bedrock/geometry.js";
import { buildAtlas } from "../../image/atlas.js";
import {
  resolveModel,
  resolveTextureRef,
  spriteLayers,
  inferHostItemFromModel,
  type ResolvedModel,
} from "../../resolve/modelResolver.js";
import {
  alphaBleed,
  compositeLayers,
  decodeCached,
  encodePng,
  firstFrame,
  type RgbaImage,
} from "../../image/png.js";
import { renderModelIcon } from "../../image/modelRender.js";
import { safeName } from "./itemsStage.js";
import { parseResourceLocation } from "../../java/javaPack.js";
import type { BowPullGroup } from "../../java/itemVariants.js";
import type { JavaElement, JavaFaceName } from "../../java/model.js";

/**
 * Converts bow-pull groups (legacy `pulling` overrides or modern
 * `condition(using_item) → range_dispatch(use_duration)` item definitions)
 * into Bedrock attachables with a charge-progress render controller. Handles
 * both flat sprite bows and custom 3D bow models (each pull stage gets its own
 * mesh, selected by a geometry array in the render controller).
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

/** A resolved pull stage: shortname (frame key) + the model rendering it. */
interface StageResolved {
  shortname: string;
  resolved: ResolvedModel;
}

function convertBowPullGroup(ctx: ConversionContext, group: BowPullGroup): void {
  const origin = group.origin;
  const name = safeName(group.itemModelId ?? group.baseItem ?? group.standbyModel);

  // Resolve every model: standby first (frame 0 = "default"), then pull stages.
  const modelIds = [group.standbyModel, ...group.stages.map((s) => s.model)];
  const stages: StageResolved[] = [];
  for (let i = 0; i < modelIds.length; i++) {
    const id = modelIds[i]!;
    const resolved = resolveModel(ctx.java, id);
    if (resolved === undefined) {
      ctx.report.skipped("bow-pull", origin, `model ${id} not found in pack`);
      return;
    }
    stages.push({ shortname: i === 0 ? "default" : `pull${i}`, resolved });
  }

  const kinds = new Set(stages.map((s) => s.resolved.kind));
  const isSprite = [...kinds].every((k) => k === "sprite" || k === "sprite_handheld");
  const isGeometry = kinds.size === 1 && kinds.has("geometry");
  if (!isSprite && !isGeometry) {
    ctx.report.skipped(
      "bow-pull",
      origin,
      `bow-pull stages mix sprite and 3D models (${[...kinds].join(", ")}) — not supported`,
    );
    return;
  }

  const built = isGeometry ? buildGeometryBow(ctx, name, stages) : buildSpriteBow(ctx, name, stages);
  if (built === undefined) {
    // buildX already reported the reason.
    return;
  }

  // Display-transform animations from the standby model.
  const anims = buildDisplayAnimations(`bow_${name}`, stages[0]!.resolved.display);
  ctx.bedrock.writeJson(`animations/geyser_custom/bow_${name}.animation.json`, anims.file);

  // Render controller: charge ladder selects the texture (and geometry, for 3D).
  const renderControllerId = `controller.render.gc_bow_${name}`;
  ctx.bedrock.writeJson(
    `render_controllers/geyser_custom/bow_${name}.render_controllers.json`,
    buildBowPullRenderController({
      id: renderControllerId,
      frameShortnames: built.shortnames,
      stageThresholds: group.stages.map((s) => s.pull),
      geometryShortnames: built.is3d ? built.shortnames : undefined,
    }),
  );

  // Host vanilla item + mapping. Modern custom bows key on the item-model id;
  // legacy vanilla bows key on the item's model path.
  const baseItem = resolveBowBaseItem(ctx, group);
  const modelKey = group.isModern
    ? group.modelKey
    : (() => {
        const loc = parseResourceLocation(group.modelKey);
        return `${loc.namespace}:${loc.path}`;
      })();
  const displayName = resolveBowDisplayName(ctx, group);

  const identifierBase = `bow_${name}`;
  let identifierName = identifierBase;
  if (ctx.usedBedrockIdentifiers.has(identifierName)) {
    for (let i = 2; ctx.usedBedrockIdentifiers.has(identifierName); i++) {
      identifierName = `${identifierBase}_${i}`;
    }
  }
  ctx.usedBedrockIdentifiers.add(identifierName);
  const bedrockId = `geyser_custom:${identifierName}`;

  const definition: GeyserItemDefinition = {
    type: "definition",
    model: modelKey,
    bedrock_identifier: bedrockId,
    display_name: displayName,
    bedrock_options: {
      icon: built.iconKey,
      display_handheld: false,
      allow_offhand: true,
    },
  };
  (ctx.geyserMappings.items[baseItem] ??= []).push(definition);
  ctx.definitionTextures.set(definition, [...built.allTextureIds]);

  const attachablePath = `attachables/geyser_custom/${safeName(identifierName)}.json`;
  ctx.bedrock.writeJson(
    attachablePath,
    buildBowPullAttachable({
      identifier: bedrockId,
      material: ctx.options.attachableMaterial,
      textures: built.textureMap,
      geometries: built.geometryMap,
      animations: anims.refs,
      renderController: renderControllerId,
      scale: group.scale,
    }),
  );

  ctx.report.converted("bow-pull", origin, [
    ...built.outputs,
    attachablePath,
    `mapped under ${baseItem}; ${built.is3d ? "3D" : "sprite"} bow, ${built.shortnames.length} frames (standby + ${built.shortnames.length - 1} pull stages)`,
    "NOTE: draw animation uses q.main_hand_item_use_duration — verify in-game; tune the charge multiplier if frames don't align",
  ]);
}

/** Result shared by the sprite + 3D builders. */
interface BuiltBow {
  is3d: boolean;
  /** Frame shortnames in order: ["default", "pull1", …]. */
  shortnames: string[];
  /** Texture shortname → bedrock path (no extension). Includes "default". */
  textureMap: Record<string, string>;
  /** Geometry shortname → geometry id. Sprite: one "default"; 3D: one per frame. */
  geometryMap: Record<string, string>;
  iconKey: string;
  allTextureIds: Set<string>;
  outputs: string[];
}

/** Flat sprite bow: one shared quad geometry, one texture per pull stage. */
function buildSpriteBow(
  ctx: ConversionContext,
  name: string,
  stages: StageResolved[],
): BuiltBow | undefined {
  const allTextureIds = new Set<string>();
  const textureMap: Record<string, string> = {};
  const outputs: string[] = [];

  // layer0 texture id of each stage.
  const texIds: string[] = [];
  for (const stage of stages) {
    const layers = spriteLayers(stage.resolved);
    if (layers.length === 0) {
      ctx.report.skipped("bow-pull", stage.resolved.id, "sprite bow model has no layer0 texture");
      return undefined;
    }
    texIds.push(layers[0]!);
  }

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]!;
    const texId = texIds[i]!;
    allTextureIds.add(texId);
    const outPath = `textures/geyser_custom/bow_${name}_${stage.shortname}`;
    const image = loadFirstFrame(ctx, texId);
    if (image === undefined) {
      ctx.report.skipped("bow-pull", stage.resolved.id, `texture ${texId} missing from pack`);
      return undefined;
    }
    const icon = compositeLayers([image]);
    alphaBleed(icon);
    ctx.bedrock.write(outPath + ".png", encodePng(icon));
    textureMap[stage.shortname] = outPath;
    outputs.push(outPath + ".png");
  }

  // One flat 16×16 quad geometry, shared by all frames.
  const geometryId = `geometry.geyser_custom.bow_${name}`;
  const elements: JavaElement[] = [
    {
      from: [0, 0, 8],
      to: [16, 16, 8],
      faces: {
        north: { uv: [0, 0, 16, 16], texture: "#default" },
        south: { uv: [0, 0, 16, 16], texture: "#default" },
      },
    } as JavaElement,
  ];
  const stdImg = loadFirstFrame(ctx, texIds[0]!) ?? { width: 16, height: 16, data: new Uint8Array(16 * 16 * 4) };
  const geo = buildGeometry(geometryId, elements, () => ({ x: 0, y: 0, width: stdImg.width, height: stdImg.height }), {
    width: stdImg.width,
    height: stdImg.height,
  });
  ctx.bedrock.writeJson(`models/entity/geyser_custom/bow_${name}.geo.json`, geo.geometry);
  outputs.push(`models/entity/geyser_custom/bow_${name}.geo.json`);

  return {
    is3d: false,
    shortnames: stages.map((s) => s.shortname),
    textureMap,
    geometryMap: { default: geometryId },
    iconKey: registerIcon(ctx, name, textureMap["default"]!),
    allTextureIds,
    outputs,
  };
}

/** Custom 3D bow: each pull stage gets its own mesh + atlas, selected per frame. */
function buildGeometryBow(
  ctx: ConversionContext,
  name: string,
  stages: StageResolved[],
): BuiltBow | undefined {
  const allTextureIds = new Set<string>();
  const textureMap: Record<string, string> = {};
  const geometryMap: Record<string, string> = {};
  const outputs: string[] = [];

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i]!;
    const resolved = stage.resolved;
    const elements = resolved.elements ?? [];

    // Distinct textures used by this stage's faces.
    const textureIds = new Set<string>();
    for (const element of elements) {
      for (const face of Object.values(element.faces ?? {})) {
        const id = resolveTextureRef(resolved.textures, face.texture);
        if (id !== undefined) {
          textureIds.add(id);
          allTextureIds.add(id);
        }
      }
    }
    if (textureIds.size === 0) {
      ctx.report.skipped("bow-pull", resolved.id, "3D bow stage has no textured faces");
      return undefined;
    }

    const images = new Map<string, RgbaImage>();
    for (const id of textureIds) {
      const img = loadFirstFrame(ctx, id);
      if (img !== undefined) images.set(id, img);
    }
    if (images.size === 0) {
      ctx.report.skipped("bow-pull", resolved.id, "3D bow stage textures missing from pack");
      return undefined;
    }

    const atlas = buildAtlas(images);
    alphaBleed(atlas.image);
    const atlasPath = `textures/geyser_custom/bow_${name}_${stage.shortname}`;
    ctx.bedrock.write(atlasPath + ".png", encodePng(atlas.image));
    textureMap[stage.shortname] = atlasPath;
    outputs.push(atlasPath + ".png");

    const geometryId = `geometry.geyser_custom.bow_${name}_${stage.shortname}`;
    const faceTexture = (element: JavaElement, faceName: JavaFaceName) => {
      const face = element.faces?.[faceName];
      if (face === undefined) return undefined;
      const id = resolveTextureRef(resolved.textures, face.texture);
      return id !== undefined ? atlas.placements.get(id) : undefined;
    };
    const geo = buildGeometry(geometryId, elements, faceTexture, {
      width: atlas.image.width,
      height: atlas.image.height,
    });
    const geoPath = `models/entity/geyser_custom/bow_${name}_${stage.shortname}.geo.json`;
    ctx.bedrock.writeJson(geoPath, geo.geometry);
    geometryMap[stage.shortname] = geometryId;
    outputs.push(geoPath);
  }

  // Icon: isometric render of the standby model.
  const iconKey = renderStandbyIcon(ctx, name, stages[0]!.resolved);

  return {
    is3d: true,
    shortnames: stages.map((s) => s.shortname),
    textureMap,
    geometryMap,
    iconKey,
    allTextureIds,
    outputs,
  };
}

/** Load a texture's first frame (crops animated flipbook strips). */
function loadFirstFrame(ctx: ConversionContext, textureId: string): RgbaImage | undefined {
  const texPath = ctx.java.assetPath("textures", textureId, ".png");
  const decoded = decodeCached(ctx.java.read.bind(ctx.java), texPath, ctx.textureCache);
  if (decoded === undefined) return undefined;
  if (decoded.height > decoded.width && ctx.java.has(texPath + ".mcmeta")) return firstFrame(decoded);
  return decoded;
}

/** Register a flat icon that reuses an already-written stage texture path. */
function registerIcon(ctx: ConversionContext, name: string, texturePath: string): string {
  const iconKey = `bow_${name}_icon`;
  if (!ctx.itemTextures.has(iconKey)) {
    ctx.itemTextures.set(iconKey, { textures: texturePath });
  }
  return iconKey;
}

/** Render an isometric icon of the standby 3D model. */
function renderStandbyIcon(ctx: ConversionContext, name: string, resolved: ResolvedModel): string {
  const iconKey = `bow_${name}_icon`;
  if (ctx.itemTextures.has(iconKey)) return iconKey;
  const images = new Map<string, RgbaImage>();
  for (const element of resolved.elements ?? []) {
    for (const face of Object.values(element.faces ?? {})) {
      const id = resolveTextureRef(resolved.textures, face.texture);
      if (id !== undefined && !images.has(id)) {
        const img = loadFirstFrame(ctx, id);
        if (img !== undefined) images.set(id, img);
      }
    }
  }
  const icon = renderModelIcon(
    resolved.elements ?? [],
    (element, faceName) => {
      const face = element.faces?.[faceName];
      if (face === undefined) return undefined;
      const id = resolveTextureRef(resolved.textures, face.texture);
      const tex = id !== undefined ? images.get(id) : undefined;
      if (tex === undefined) return undefined;
      return { image: tex, uv: face.uv ?? defaultUv(faceName, element.from, element.to) };
    },
    resolved.display["gui"],
  );
  alphaBleed(icon);
  const path = `textures/geyser_custom/icons/bow_${name}`;
  ctx.bedrock.write(path + ".png", encodePng(icon));
  ctx.itemTextures.set(iconKey, { textures: path });
  return iconKey;
}

/** Resolve the vanilla host item for a bow-pull group. */
function resolveBowBaseItem(ctx: ConversionContext, group: BowPullGroup): string {
  if (group.baseItem !== undefined) return group.baseItem;
  if (group.itemModelId !== undefined) {
    const key = parseResourceLocation(group.itemModelId).path.toLowerCase();
    const hinted = ctx.options.baseItemHints[key];
    if (hinted !== undefined) return hinted;
  }
  // Model parent chain: a custom bow that parents to minecraft:item/bow
  // (or a specific vanilla bow model) infers the host from that ancestor.
  const inferred = inferHostItemFromModel(ctx.java, group.standbyModel, ctx.inferredHostItems);
  if (inferred !== undefined) return inferred;
  return "minecraft:bow";
}

/** Prefer a config-hinted display name; else a readable name from the id. */
function resolveBowDisplayName(ctx: ConversionContext, group: BowPullGroup): string {
  if (group.itemModelId !== undefined) {
    const key = parseResourceLocation(group.itemModelId).path.toLowerCase();
    const hinted = ctx.options.displayNameHints[key];
    if (hinted !== undefined) return hinted;
    const last = key.split("/").pop() ?? key;
    return last.split(/[_-]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }
  return "Bow";
}
