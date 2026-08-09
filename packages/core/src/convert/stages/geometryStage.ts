import type { ConversionContext, PendingGeometry, PipelineStage } from "../context.js";
import { buildAtlas } from "../../image/atlas.js";
import { buildGeometry } from "../../bedrock/geometry.js";
import { buildDisplayAnimations } from "../../bedrock/animations.js";
import { buildFlipbookRenderController, buildItemAttachable } from "../../bedrock/attachable.js";
import { parseLenientJson } from "../../java/json.js";
import { alphaBleed, decodeCached, decodePng, encodePng, type RgbaImage } from "../../image/png.js";
import { timeOp, timeOpAsync } from "../../report/timings.js";
import { renderModelIcon } from "../../image/modelRender.js";
import { defaultUv } from "../../bedrock/geometry.js";
import { buildDefinition, safeName } from "./itemsStage.js";
import { parseResourceLocation } from "../../java/javaPack.js";
import { frameTicks } from "../../java/mcmeta.js";
import { fastHash } from "../../util/hash.js";
import { fitFilePath, fitPathName } from "../../util/packPath.js";
import type { JavaElement, JavaFaceName } from "../../java/model.js";
import type { ResolvedModel } from "../../resolve/modelResolver.js";
import { inferHostItemFromModel } from "../../resolve/modelResolver.js";
import { resolveTextureRef } from "../../resolve/modelResolver.js";
/** 2x2 magenta placeholder for missing textures (classic "missing texture" look). */
function missingTexture(): RgbaImage {
  const data = new Uint8Array(2 * 2 * 4);
  const px = [
    [255, 0, 255, 255],
    [0, 0, 0, 255],
    [0, 0, 0, 255],
    [255, 0, 255, 255],
  ];
  px.forEach((p, i) => data.set(p, i * 4));
  return { width: 2, height: 2, data };
}

interface LoadedTexture {
  /** Frame images (single entry for static textures). */
  frames: RgbaImage[];
  /** Java frametime in ticks (1 tick = 1/20 s). */
  frametime: number;
}

interface McmetaAnimation {
  animation?: {
    frametime?: number;
    interpolate?: boolean;
    frames?: (number | { index: number; time?: number })[];
  };
}

/** Linear blend of two same-size images (t=0 → a, t=1 → b), as Java's interpolate does. */
function blendImages(a: RgbaImage, b: RgbaImage, t: number): RgbaImage {
  if (a.width !== b.width || a.height !== b.height) {
    // Size mismatch — can't blend, return a copy of a (resting frame).
    return { width: a.width, height: a.height, data: a.data.slice() };
  }
  const out = new Uint8Array(a.data.length);
  for (let i = 0; i < a.data.length; i++) {
    out[i] = Math.round(a.data[i]! + (b.data[i]! - a.data[i]!) * t);
  }
  return { width: a.width, height: a.height, data: out };
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

/**
 * Load a texture, splitting mcmeta flipbook strips into ordered frames.
 * Per-frame `time` values are honoured by expanding frames on a gcd tick
 * grid, so a frame lasting 2× the base frametime appears twice.
 *
 * Results are memoized by texture id for the whole stage: a source texture
 * shared by many models (particle sheets, reused flipbooks) is decoded and
 * split once. Downstream never mutates the returned frames (atlas blit copies
 * pixels out), so sharing them is safe.
 */
function loadTexture(
  ctx: ConversionContext,
  textureId: string,
  cache: Map<string, LoadedTexture | undefined>,
): LoadedTexture | undefined {
  const cached = cache.get(textureId);
  if (cached !== undefined || cache.has(textureId)) return cached;
  const result = loadTextureUncached(ctx, textureId);
  cache.set(textureId, result);
  return result;
}

function loadTextureUncached(ctx: ConversionContext, textureId: string): LoadedTexture | undefined {
  const path = ctx.java.assetPath("textures", textureId, ".png");
  // Record that this texture is handled by the geometry stage so the flipbook
  // stage doesn't report it as "skipped: animation on a non-block texture".
  ctx.geometryHandledTextures.add(path);
  const image = decodeCached(ctx.java.read.bind(ctx.java), path, ctx.textureCache);
  if (image === undefined) return undefined;

  const metaText = ctx.java.readText(path + ".mcmeta");
  const meta = metaText !== undefined ? parseLenientJson<McmetaAnimation>(metaText) : undefined;
  if (meta?.animation === undefined || image.height <= image.width) {
    return { frames: [image], frametime: 1 };
  }

  const frameH = image.width;
  const stripCount = Math.floor(image.height / frameH);
  const strip: RgbaImage[] = [];
  for (let i = 0; i < stripCount; i++) {
    strip.push({
      width: image.width,
      height: frameH,
      data: image.data.slice(i * image.width * frameH * 4, (i + 1) * image.width * frameH * 4),
    });
  }

  const baseTime = frameTicks(meta.animation.frametime);
  const entries = (meta.animation.frames ?? strip.map((_, i) => i)).map((f) => {
    if (typeof f === "number") return { index: f, ticks: baseTime };
    return { index: f.index, ticks: frameTicks(f.time ?? baseTime) };
  });
  if (entries.length === 0) return { frames: strip, frametime: baseTime };

  // Interpolated animation: Java cross-fades between frames every tick, so
  // resample the whole cycle on a 1-tick grid with per-tick blends. (Frame
  // dedupe + the frame-cap option keep pack size in check.)
  if (meta.animation.interpolate === true) {
    const frames: RgbaImage[] = [];
    for (let i = 0; i < entries.length; i++) {
      const cur = strip[Math.min(entries[i]!.index, strip.length - 1)]!;
      const next = strip[Math.min(entries[(i + 1) % entries.length]!.index, strip.length - 1)]!;
      for (let s = 0; s < entries[i]!.ticks; s++) {
        const t = s / entries[i]!.ticks;
        frames.push(t === 0 ? cur : blendImages(cur, next, t));
      }
    }
    return { frames, frametime: 1 };
  }

  // Uniform tick grid: gcd of all durations; repeat frames to their length.
  const unit = entries.reduce((acc, e) => gcd(acc, e.ticks), entries[0]!.ticks);
  const frames: RgbaImage[] = [];
  for (const e of entries) {
    const img = strip[Math.min(e.index, strip.length - 1)]!;
    for (let r = 0; r < e.ticks / unit; r++) frames.push(img);
  }
  return { frames, frametime: unit };
}

/**
 * Converts 3D item models collected by the items stage into Bedrock
 * geometry + attachable + animation trios, and registers Geyser mappings.
 */
/** A PNG encode deferred until the batch flush (path + the image to encode). */
interface EncodeJob {
  path: string;
  image: RgbaImage;
}

/** Below this many deferred encodes, the pool round-trip isn't worth it; encode inline. */
const ENCODE_POOL_THRESHOLD = 24;

/**
 * Path budget for the model name (see {@link fitPathName}). Only the texture
 * paths pin it down — they're referenced by path from the attachable, so the
 * name in them can't be shortened independently. Every other file this stage
 * writes is found by the identifier inside it, so those get {@link fitFilePath}
 * at the write instead of dragging the name down to their longer templates.
 *
 * `_f99` is the widest animation-frame suffix a timeline realistically reaches.
 */
const ATLAS_TEXTURE_RESERVED = "textures/geyser_custom/atlases/_f99.png".length;

/** Attachable file for a bedrock identifier; Bedrock reads the id inside, so the name only has to be unique. */
function attachablePath(identifier: string): string {
  return fitFilePath("attachables/geyser_custom/", safeName(identifier.split(":")[1] ?? identifier), ".json");
}

export const geometryStage: PipelineStage = {
  name: "items-3d",
  async run(ctx: ConversionContext): Promise<void> {
    // Group variants by model so shared models produce one geometry/attachable.
    const byModel = new Map<string, PendingGeometry[]>();
    for (const pending of ctx.pendingGeometry) {
      const list = byModel.get(pending.variant.model) ?? [];
      list.push(pending);
      byModel.set(pending.variant.model, list);
    }
    ctx.pendingGeometry.length = 0;

    // Global content cache (fast FNV of atlas pixels): dedups identical atlas
    // frames across the whole pack — repeated animation frames and shared
    // texture sets (bow_0/1/2 charge variants) reuse one PNG.
    const atlasCache = new Map<string, string>();
    // PNG encoding is the stage hotspot. Every atlas/icon path and all geometry
    // is emitted synchronously below, but the pixel encodes are collected here
    // and flushed once — in parallel across the injected worker pool when present.
    const encodeJobs: EncodeJob[] = [];
    // Decode each source texture once, even when many models share it.
    const textureCache = new Map<string, LoadedTexture | undefined>();
    // Read sprites.json once instead of re-parsing it per model.
    const spritesJson = ctx.java.readJson<Record<string, string>>("sprites.json") ?? {};

    let done = 0;
    for (const [modelId, group] of byModel) {
      done++;
      ctx.progress("items-3d", done, byModel.size);
      try {
        convertModel(ctx, modelId, group, atlasCache, encodeJobs, textureCache, spritesJson);
      } catch (err) {
        ctx.report.error("items-3d", modelId, err instanceof Error ? err.message : String(err));
      }
    }

    const encoder = ctx.options.pngEncoder;
    if (encoder !== undefined && encodeJobs.length >= ENCODE_POOL_THRESHOLD) {
      const pngs = await timeOpAsync("png.encode.pool", () =>
        encoder.encode(encodeJobs.map((j) => j.image)),
      );
      encodeJobs.forEach((j, i) => ctx.bedrock.write(j.path, pngs[i]!));
    } else {
      for (const j of encodeJobs) ctx.bedrock.write(j.path, encodePng(j.image));
    }
  },
};

function convertModel(
  ctx: ConversionContext,
  modelId: string,
  group: PendingGeometry[],
  atlasCache: Map<string, string>,
  encodeJobs: EncodeJob[],
  textureCache: Map<string, LoadedTexture | undefined>,
  spritesJson: Record<string, string>,
): void {
  const resolved = group[0]!.resolved;
  const elements = resolved.elements ?? [];

  // 1. Collect the distinct textures used by element faces.
  const textureIds = new Set<string>();
  for (const element of elements) {
    for (const face of Object.values(element.faces ?? {})) {
      const id = resolveTextureRef(resolved.textures, face.texture);
      if (id !== undefined) textureIds.add(id);
    }
  }
  if (textureIds.size === 0) {
    ctx.report.skipped("items-3d", modelId, "3D model has no textured faces");
    return;
  }

  // 2. Load textures (magenta placeholder for missing ones), splitting
  // mcmeta flipbook strips into frames.
  const loaded = new Map<string, LoadedTexture>();
  for (const id of textureIds) {
    const tex = loadTexture(ctx, id, textureCache);
    if (tex === undefined) {
      ctx.report.approximated("items-3d", modelId, `texture ${id} missing — magenta placeholder used`);
      loaded.set(id, { frames: [missingTexture()], frametime: 1 });
    } else {
      loaded.set(id, tex);
    }
  }

  // 3. Flipbook timeline: Bedrock attachables have no native texture
  // animation, so we bake one atlas per timeline frame and cycle them with a
  // render controller (time-indexed texture array). Static models get one atlas.
  // Tick-accurate timeline: textures may have different frametimes and frame
  // counts (multi-strip items). The timeline runs on the gcd of all
  // frametimes for the duration of the LONGEST cycle; each texture picks its
  // frame by real time, so every strip plays at its own correct speed.
  const animated = [...loaded.values()].filter((t) => t.frames.length > 1);
  const unit = animated.length > 0 ? animated.map((t) => t.frametime).reduce(gcd) : 1;
  const durationTicks = Math.max(1, ...animated.map((t) => t.frames.length * t.frametime));
  const fullSlots = Math.ceil(durationTicks / unit);
  // 0 = unlimited: keep the full animation (default).
  const frameCap = ctx.options.maxAnimationFrames > 0 ? ctx.options.maxAnimationFrames : fullSlots;
  const timelineFrames = Math.min(fullSlots, frameCap);
  const maxSourceFrames = fullSlots; // for the subsample report note
  // fps for the render controller; compensates when the timeline is subsampled.
  const fps = (timelineFrames * 20) / durationTicks;

  // Name every generated file after the model, short enough that its atlas
  // texture path stays under the Bedrock limit.
  const name = fitPathName(safeName(modelId), ATLAS_TEXTURE_RESERVED);

  const framePaths: string[] = [];
  let atlas!: ReturnType<typeof buildAtlas>;
  // Two-level dedup, cheapest first:
  //  1. selection key (which source frame each texture sits on) — a perfect
  //     within-model key, so consecutive timeline slots that resolve to the
  //     same selection skip the stitch + alpha-bleed + encode entirely;
  //  2. content hash of the stitched pixels — catches distinct selections that
  //     still render identical atlases (repeated/interpolated source frames)
  //     and duplicates across models, skipping the encode.
  const selectionCache = new Map<string, string>();
  for (let f = 0; f < timelineFrames; f++) {
    // Real time (ticks) this timeline slot represents.
    const ticks = (f * durationTicks) / timelineFrames;
    // Same insertion order every frame → identical atlas placements.
    const frameImages = new Map<string, RgbaImage>();
    const selection: string[] = [];
    for (const [id, tex] of loaded) {
      const idx = Math.floor(ticks / tex.frametime) % tex.frames.length;
      frameImages.set(id, tex.frames[idx]!);
      selection.push(`${id}:${idx}`);
    }
    const selKey = selection.join("|");
    const bySelection = f === 0 ? undefined : selectionCache.get(selKey);
    if (bySelection !== undefined) {
      framePaths.push(bySelection);
      continue;
    }

    const frameAtlas = buildAtlas(frameImages);
    alphaBleed(frameAtlas.image);
    if (f === 0) atlas = frameAtlas;

    const hash = timeOp("atlas.hash", () => fastHash(frameAtlas.image.data));
    const byContent = atlasCache.get(hash);
    if (byContent !== undefined) {
      selectionCache.set(selKey, byContent);
      framePaths.push(byContent);
    } else {
      const path =
        f === 0 ? `textures/geyser_custom/atlases/${name}` : `textures/geyser_custom/atlases/${name}_f${f}`;
      encodeJobs.push({ path: path + ".png", image: frameAtlas.image });
      atlasCache.set(hash, path);
      selectionCache.set(selKey, path);
      framePaths.push(path);
    }
  }
  const atlasPath = framePaths[0]!;
  const images = new Map<string, RgbaImage>([...loaded].map(([id, t]) => [id, t.frames[0]!]));

  // 4. Geometry.
  const geometryId = `geometry.geyser_custom.${name}`;
  const faceTexture = (element: JavaElement, faceName: JavaFaceName) => {
    const face = element.faces?.[faceName];
    if (face === undefined) return undefined;
    const id = resolveTextureRef(resolved.textures, face.texture);
    return id !== undefined ? atlas.placements.get(id) : undefined;
  };
  // Crossbows render backward on Bedrock (its native crossbow hold aims the
  // item bone opposite to the Java model), so re-aim their geometry 180°.
  const flipFacing = groupBaseItem(ctx, group) === "minecraft:crossbow";
  const geo = timeOp("geometry.build", () =>
    buildGeometry(
      geometryId,
      elements,
      faceTexture,
      { width: atlas.image.width, height: atlas.image.height },
      { flipFacing, textureSize: resolved.textureSize },
    ),
  );
  timeOp("json.write", () =>
    ctx.bedrock.writeJson(fitFilePath("models/entity/geyser_custom/", name, ".geo.json"), geo.geometry),
  );

  // 5. Display-transform animations. Back cosmetics (HMCCosmetics backpacks —
  // armor-stand head items) get a head lift: Bedrock renders those lower than Java.
  const backpacks = ctx.options.backpackItems;
  const isBackpack =
    backpacks.length > 0 &&
    group.some(({ variant }) => {
      const keys = [
        ...(variant.source.kind === "modern"
          ? [parseResourceLocation(variant.source.itemModelId).path.toLowerCase()]
          : []),
        parseResourceLocation(variant.model).path.split("/").pop()!.toLowerCase(),
        ...(variant.baseItem !== undefined && cmdOf(variant) !== undefined
          ? [ctx.options.cmdItemKeys[`${variant.baseItem}|${cmdOf(variant)}`] ?? ""]
          : []),
      ];
      return keys.some((k) => k !== "" && backpacks.includes(k));
    });
  const anims = buildDisplayAnimations(name, resolved.display, isBackpack ? { headLift: 12 } : undefined);
  ctx.bedrock.writeJson(fitFilePath("animations/geyser_custom/", name, ".animation.json"), anims.file);
  if (isBackpack) {
    ctx.report.approximated(
      "items-3d",
      modelId,
      "back cosmetic (HMCCosmetics backpack): head position lifted +12 units to compensate Bedrock armor-stand rendering — report over/under-shoot for tuning",
    );
  }

  // 6. Flipbook render controller when animated (shared by all attachables).
  let renderController: string | undefined;
  let extraTextures: Record<string, string> | undefined;
  if (timelineFrames > 1) {
    renderController = `controller.render.gc_${name}`;
    extraTextures = {};
    const shortnames = ["default"];
    for (let f = 1; f < timelineFrames; f++) {
      extraTextures[`frame${f}`] = framePaths[f]!;
      shortnames.push(`frame${f}`);
    }
    ctx.bedrock.writeJson(
      fitFilePath("render_controllers/geyser_custom/", name, ".render_controllers.json"),
      buildFlipbookRenderController({ id: renderController, frameShortnames: shortnames, fps }),
    );
  }

  // 7. Icon: sprites.json override → isometric software render of the model.
  const iconKey = pickIcon(ctx, modelId, name, resolved, images, encodeJobs, spritesJson);

  // 8. Register a mapping entry per variant, and an attachable per unique
  // bedrock identifier (definitions may get item-model based identifiers, so
  // one shared model can back several bedrock items).
  // Furniture (GeyserDisplayEntity) placement. The extension reads the server
  // item_display entity's transform and applies it at runtime, so pieces whose
  // plugin uses a real display transform (FIXED etc.) are repositioned live and
  // need no baked offset. But furniture placed with `display_transform: NONE`
  // (common for Nexo furniture) carries NO runtime transform — it's authored
  // upright in block space and the extension just hangs it at the stand-in's
  // item anchor, ~1.3 blocks up, so it floats. For those we seat it by its
  // vertical centre. vanilla-scale comes from the plugin's own furniture scale
  // (authoritative — Nexo sets the transform in its config, not the model's
  // display.fixed), falling back to the model when no plugin hint exists.
  const furnitureTransform = furnitureTransformForGroup(ctx, group);
  const furnitureVanillaScale =
    furnitureTransform !== undefined
      ? furnitureTransform.scale !== 1
      : (resolved.display?.fixed?.scale?.some((s) => Math.abs(s - 1) > 0.01) ?? false);
  const furnitureYOffset =
    furnitureTransform?.none === true && elements.length > 0
      ? furnitureSeatOffset(elements)
      : 0;

  const attachableMaterial = ctx.options.attachableMaterial;

  // Head cosmetic heuristic: a 3D model that defines a `head` display transform
  // but no hand transforms (thirdperson/firstperson) is a hat / head cosmetic
  // (HMCCosmetics-style), not a held item. Emit an equippable head component so
  // Geyser renders it on the player's head instead of in the hand.
  const headCosmetic =
    elements.length > 0 &&
    resolved.display?.head !== undefined &&
    resolved.display.thirdperson_righthand === undefined &&
    resolved.display.firstperson_righthand === undefined;

  const attachableIds = new Set<string>();
  for (const { variant } of group) {
    const definition = buildDefinition(ctx, variant, {
      icon: iconKey,
      displayHandheld: false,
      furnitureVanillaScale,
      furnitureYOffset,
    });
    if (headCosmetic) {
      definition.components = {
        ...definition.components,
        "minecraft:equippable": { slot: "head" },
      };
    }
    ctx.definitionTextures.set(definition, [...textureIds]);
    const identifier = definition.bedrock_identifier!;
    if (attachableIds.has(identifier)) continue;
    attachableIds.add(identifier);
    ctx.bedrock.writeJson(
      attachablePath(identifier),
      buildItemAttachable({
        identifier,
        material: attachableMaterial,
        texture: atlasPath,
        geometry: geometryId,
        animations: anims.refs,
        extraTextures,
        renderController,
      }),
    );
  }

  const outputs = [
    atlasPath + ".png",
    fitFilePath("models/entity/geyser_custom/", name, ".geo.json"),
    fitFilePath("animations/geyser_custom/", name, ".animation.json"),
    ...[...attachableIds].map(attachablePath),
  ];
  if (timelineFrames > 1) {
    const note =
      timelineFrames < maxSourceFrames
        ? ` (subsampled from ${maxSourceFrames} source frames)`
        : "";
    ctx.report.converted("items-3d", modelId, [
      ...outputs,
      `animated: ${timelineFrames} frames @ ${fps.toFixed(1)} fps via render controller${note}`,
    ]);
  } else if (geo.usedUvRotation) {
    ctx.report.approximated("items-3d", modelId, "face UV rotation used — requires Bedrock 1.21+ client", outputs);
  } else {
    ctx.report.converted("items-3d", modelId, outputs);
  }
}

/**
 * Look up the plugin furniture transform for a group by matching its config
 * key / item-model id / model name against `furnitureTransforms` — mirrors the
 * furniture-key matching in itemsStage's buildDefinition. Undefined when the
 * group isn't furniture or the plugin config carried no transform hint.
 */
function furnitureTransformForGroup(
  ctx: ConversionContext,
  group: PendingGeometry[],
): { none: boolean; scale: number } | undefined {
  const transforms = ctx.options.furnitureTransforms;
  for (const { variant } of group) {
    const keys: string[] = [];
    const baseItem = variant.baseItem ?? groupBaseItem(ctx, group);
    const cmd = cmdOf(variant);
    if (baseItem !== undefined && cmd !== undefined) {
      const k = ctx.options.cmdItemKeys[`${baseItem}|${cmd}`];
      if (k !== undefined) keys.push(k);
    }
    if (variant.source.kind === "modern") {
      keys.push(parseResourceLocation(variant.source.itemModelId).path.toLowerCase());
    }
    keys.push(parseResourceLocation(variant.model).path.split("/").pop()!.toLowerCase());
    for (const k of keys) {
      if (transforms[k] !== undefined) return transforms[k];
    }
  }
  return undefined;
}

/**
 * GeyserDisplayEntity y-offset (blocks) that seats a NONE-transform furniture
 * piece: negate the model's vertical centre. Java units are 1/16 block; a model
 * centred at y=8 gives 0, taller pieces get pulled down proportionally so they
 * don't hang at the stand-in's item anchor.
 */
function furnitureSeatOffset(elements: JavaElement[]): number {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    minY = Math.min(minY, el.from[1], el.to[1]);
    maxY = Math.max(maxY, el.from[1], el.to[1]);
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return 0;
  return -((minY + maxY) / 2 / 16);
}

/**
 * Resolve the vanilla host item for a geometry group (pack-declared, then
 * config base-item hints, then model parent chain) — mirrors resolveBaseItem's
 * lookup without its reporting side effects. Used to detect crossbows for the
 * facing flip.
 */
function groupBaseItem(ctx: ConversionContext, group: PendingGeometry[]): string | undefined {
  for (const { variant } of group) {
    if (variant.baseItem !== undefined) return variant.baseItem;
    const keys: string[] = [];
    if (variant.source.kind === "modern") {
      keys.push(parseResourceLocation(variant.source.itemModelId).path.toLowerCase());
    }
    keys.push(parseResourceLocation(variant.model).path.split("/").pop()!.toLowerCase());
    for (const k of keys) {
      const hinted = ctx.options.baseItemHints[k];
      if (hinted !== undefined) return hinted;
    }
    const inferred = inferHostItemFromModel(ctx.java, variant.model, ctx.inferredHostItems);
    if (inferred !== undefined) return inferred;
  }
  return undefined;
}

/** custom_model_data value of a variant (legacy field or modern range_dispatch predicate). */
function cmdOf(variant: PendingGeometry["variant"]): number | undefined {
  if (variant.source.kind === "legacy") return variant.source.customModelData;
  const p = variant.predicates.find(
    (p) => p.type === "range_dispatch" && p.property === "custom_model_data",
  );
  return p !== undefined && "threshold" in p ? p.threshold : undefined;
}

/**
 * GeyserDisplayEntity y-offset for a furniture model: negate the model's
 * vertical centre in blocks. Java model units are 1/16 block; the extension's
 * default -0.5 corresponds to a model centred at y=8, so this generalises it to
 * any height (rotations ignored — the axis-aligned span is a good approximation
 * for the near-upright furniture models this targets).
 */
function furnitureOffsetFromElements(elements: JavaElement[]): number {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    minY = Math.min(minY, el.from[1], el.to[1]);
    maxY = Math.max(maxY, el.from[1], el.to[1]);
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return -0.5;
  return -((minY + maxY) / 2 / 16);
}

function pickIcon(
  ctx: ConversionContext,
  modelId: string,
  name: string,
  resolved: ResolvedModel,
  images: Map<string, RgbaImage>,
  encodeJobs: EncodeJob[],
  spritesJson: Record<string, string>,
): string {
  const iconKey = `${name}_icon`;
  if (ctx.itemTextures.has(iconKey)) return iconKey;
  const path = `textures/geyser_custom/icons/${name}`;

  // Optional pack-provided icon overrides: sprites.json at pack root mapping
  // model id → texture resource location (same convention as java2bedrock).
  const override = spritesJson[modelId];
  let image: RgbaImage | undefined;
  if (override !== undefined) {
    const bytes = ctx.java.read(ctx.java.assetPath("textures", override, ".png"));
    image = bytes !== undefined ? decodePng(bytes) : undefined;
  }

  if (image === undefined) {
    // Render the model itself to an isometric icon.
    image = renderModelIcon(
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
      64,
      resolved.textureSize ?? [16, 16],
    );
  }

  alphaBleed(image);
  encodeJobs.push({ path: path + ".png", image });
  ctx.itemTextures.set(iconKey, { textures: path });
  return iconKey;
}
