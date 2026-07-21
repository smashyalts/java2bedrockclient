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
import { fastHash } from "../../util/hash.js";
import type { JavaDisplayTransform, JavaElement, JavaFaceName } from "../../java/model.js";
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

  const baseTime = Math.max(1, meta.animation.frametime ?? 1);
  const entries = (meta.animation.frames ?? strip.map((_, i) => i)).map((f) => {
    if (typeof f === "number") return { index: f, ticks: baseTime };
    return { index: f.index, ticks: Math.max(1, f.time ?? baseTime) };
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

    let done = 0;
    for (const [modelId, group] of byModel) {
      done++;
      ctx.progress("items-3d", done, byModel.size);
      try {
        convertModel(ctx, modelId, group, atlasCache, encodeJobs, textureCache);
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
): void {
  const resolved = group[0]!.resolved;
  const elements = resolved.elements ?? [];
  const name = safeName(modelId);

  // 1. Collect the distinct textures used by element faces.
  const textureIds = new Set<string>();
  for (const element of elements) {
    for (const face of Object.values(element.faces ?? {})) {
      const id = resolveFaceTexture(resolved.textures, face.texture);
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
    const id = resolveFaceTexture(resolved.textures, face.texture);
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
      { flipFacing },
    ),
  );
  timeOp("json.write", () =>
    ctx.bedrock.writeJson(`models/entity/geyser_custom/${name}.geo.json`, geo.geometry),
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
  ctx.bedrock.writeJson(`animations/geyser_custom/${name}.animation.json`, anims.file);
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
      `render_controllers/geyser_custom/${name}.render_controllers.json`,
      buildFlipbookRenderController({ id: renderController, frameShortnames: shortnames, fps }),
    );
  }

  // 7. Icon: sprites.json override → isometric software render of the model.
  const iconKey = pickIcon(ctx, modelId, name, resolved, images, encodeJobs);

  // 8. Register a mapping entry per variant, and an attachable per unique
  // bedrock identifier (definitions may get item-model based identifiers, so
  // one shared model can back several bedrock items).
  // Furniture (GeyserDisplayEntity) placement. Java renders an item_display
  // with the model's `display.fixed` transform baked in — critically a rotation
  // (e.g. -90° about X) that stands a model authored lying-down upright, plus a
  // scale. The Bedrock attachable carries none of that, so furniture renders
  // flat / at the wrong height. We (a) emit the fixed rotation into the
  // extension's `displayentityoptions.rotation` so it stands up, and (b) derive
  // the y-offset from the model bounds AFTER applying that rotation+scale, so a
  // stood-up chair is seated by its real (tall) height, not its flat one.
  const furnitureFixed = resolved.display?.fixed;
  const furnitureYOffset =
    elements.length > 0 ? furnitureOffsetFromElements(elements, furnitureFixed) : undefined;
  const furnitureRotation = nonZeroRotation(furnitureFixed?.rotation);

  // Furniture whose faces sample only opaque texels can render with the vanilla
  // `entity_nocull` material, which disables back-face culling so concave pieces
  // (sofas, chairs) keep the interior faces Bedrock would otherwise cull — the
  // "missing faces" bug. This is a stock vanilla material (no custom .material
  // file, which needs a materials/common.json manifest — too fragile to ship).
  // It has no alpha test, so a cutout texture would render its transparent
  // pixels as solid; we therefore check the texels the model actually samples
  // (not the whole atlas — furniture textures carry transparent padding that
  // never lands on a face). Genuinely cutout furniture (lamps, plants) still
  // samples transparency and stays one-sided.
  const attachableMaterial =
    isFurnitureGroup(ctx, group) && furnitureFacesOpaque(elements, resolved.textures, images)
      ? "entity_nocull"
      : ctx.options.attachableMaterial;

  const attachableIds = new Set<string>();
  for (const { variant } of group) {
    const definition = buildDefinition(ctx, variant, {
      icon: iconKey,
      displayHandheld: false,
      furnitureYOffset,
      furnitureRotation,
    });
    ctx.definitionTextures.set(definition, [...textureIds]);
    const identifier = definition.bedrock_identifier!;
    if (attachableIds.has(identifier)) continue;
    attachableIds.add(identifier);
    ctx.bedrock.writeJson(
      `attachables/geyser_custom/${safeName(identifier.split(":")[1] ?? identifier)}.json`,
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
    `models/entity/geyser_custom/${name}.geo.json`,
    `animations/geyser_custom/${name}.animation.json`,
    ...[...attachableIds].map((id) => `attachables/geyser_custom/${safeName(id.split(":")[1] ?? id)}.json`),
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

/**
 * True when any variant in the group is a world-placed furniture item (matched
 * by config key / item-model id / model name against `furnitureItems`). Mirrors
 * the furniture-key matching in itemsStage's buildDefinition.
 */
function isFurnitureGroup(ctx: ConversionContext, group: PendingGeometry[]): boolean {
  const furniture = ctx.options.furnitureItems;
  if (furniture.length === 0) return false;
  return group.some(({ variant }) => {
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
    return keys.some((k) => furniture.includes(k));
  });
}

const FACE_NAMES: JavaFaceName[] = ["north", "south", "east", "west", "up", "down"];

/**
 * True when every texel the model's faces actually sample is fully opaque
 * (alpha === 255). Unlike scanning the whole texture, this ignores transparent
 * padding around the used regions — furniture atlases are mostly padding — so
 * solid furniture qualifies for the double-sided `entity_nocull` material while
 * genuinely cutout pieces (which sample transparent texels) don't. Returns
 * false if nothing is sampled (no faces → nothing to double-side).
 */
function furnitureFacesOpaque(
  elements: JavaElement[],
  textures: Record<string, string>,
  images: Map<string, RgbaImage>,
): boolean {
  let sampledAny = false;
  for (const el of elements) {
    if (el.faces === undefined) continue;
    for (const faceName of FACE_NAMES) {
      const face = el.faces[faceName];
      if (face === undefined) continue;
      const id = resolveFaceTexture(textures, face.texture);
      if (id === undefined) continue;
      const image = images.get(id);
      if (image === undefined) continue;
      const uv = face.uv ?? defaultUv(faceName, el.from, el.to);
      if (!regionOpaque(image, uv)) return false;
      sampledAny = true;
    }
  }
  return sampledAny;
}

/** True when every texel in the Java 0–16 UV rect of the image is opaque. */
function regionOpaque(image: RgbaImage, uv: [number, number, number, number]): boolean {
  const { width, height, data } = image;
  const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
  const x0 = clamp(Math.floor((Math.min(uv[0], uv[2]) / 16) * width), width);
  const x1 = clamp(Math.ceil((Math.max(uv[0], uv[2]) / 16) * width), width);
  const y0 = clamp(Math.floor((Math.min(uv[1], uv[3]) / 16) * height), height);
  const y1 = clamp(Math.ceil((Math.max(uv[1], uv[3]) / 16) * height), height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (data[(y * width + x) * 4 + 3] !== 255) return false;
    }
  }
  return true;
}

/** custom_model_data value of a variant (legacy field or modern range_dispatch predicate). */
function cmdOf(variant: PendingGeometry["variant"]): number | undefined {
  if (variant.source.kind === "legacy") return variant.source.customModelData;
  const p = variant.predicates.find(
    (p) => p.type === "range_dispatch" && p.property === "custom_model_data",
  );
  return p !== undefined && "threshold" in p ? p.threshold : undefined;
}

function resolveFaceTexture(textures: Record<string, string>, ref: string): string | undefined {
  return resolveTextureRef(textures, ref);
}

/**
 * GeyserDisplayEntity y-offset for a furniture model: negate the model's
 * vertical centre in blocks. Java model units are 1/16 block; the extension's
 * default -0.5 corresponds to a model centred at y=8. When the model carries a
 * `display.fixed` rotation (item_displays bake it in, and we emit it too), we
 * rotate the element corners first, so a chair authored lying down — whose
 * height comes from its Z span until a -90° X rotation stands it up — is seated
 * by its true upright height rather than its flat one. The fixed scale is left
 * out: the attachable renders at the model's natural size unless the tester
 * turns on `vanilla-scale`, so folding scale in here would overshoot.
 */
function furnitureOffsetFromElements(
  elements: JavaElement[],
  fixed?: JavaDisplayTransform,
): number {
  // Match the rotation the extension actually applies: it negates the Y and Z
  // euler components (Java→Bedrock handedness) in pushRotationProperties, so a
  // chair's [-90,90,0] renders as [-90,-90,0]. Computing the offset from the
  // raw Java rotation instead seated chairs (ry≠0) wrong while sofas (ry=0)
  // stayed correct.
  const r = fixed?.rotation ?? [0, 0, 0];
  const rot: [number, number, number] = [r[0]!, -r[1]!, -r[2]!];
  const pivot = 8; // Minecraft display transforms pivot about the [8,8,8] centre.
  let minY = Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    for (const x of [el.from[0], el.to[0]]) {
      for (const y of [el.from[1], el.to[1]]) {
        for (const z of [el.from[2], el.to[2]]) {
          const v: [number, number, number] = [x - pivot, y - pivot, z - pivot];
          const ty = rotateXYZ(v, rot)[1] + pivot;
          minY = Math.min(minY, ty);
          maxY = Math.max(maxY, ty);
        }
      }
    }
  }
  if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return -0.5;
  return -((minY + maxY) / 2 / 16);
}

/** Rotate a vector by Euler angles (degrees) in Minecraft's X·Y·Z order. */
function rotateXYZ(
  v: [number, number, number],
  deg: [number, number, number],
): [number, number, number] {
  const [ax, ay, az] = deg.map((d) => (d * Math.PI) / 180) as [number, number, number];
  let [x, y, z] = v;
  // (Rx·Ry·Rz)·v — apply Rz, then Ry, then Rx.
  let c = Math.cos(az), s = Math.sin(az);
  [x, y] = [x * c - y * s, x * s + y * c];
  c = Math.cos(ay), s = Math.sin(ay);
  [x, z] = [x * c + z * s, -x * s + z * c];
  c = Math.cos(ax), s = Math.sin(ax);
  [y, z] = [y * c - z * s, y * s + z * c];
  return [x, y, z];
}

/** A fixed rotation worth emitting — undefined when absent or all-zero. */
function nonZeroRotation(
  rot?: [number, number, number],
): [number, number, number] | undefined {
  if (rot === undefined) return undefined;
  return rot.some((a) => a !== 0) ? rot : undefined;
}

function pickIcon(
  ctx: ConversionContext,
  modelId: string,
  name: string,
  resolved: ResolvedModel,
  images: Map<string, RgbaImage>,
  encodeJobs: EncodeJob[],
): string {
  const iconKey = `${name}_icon`;
  if (ctx.itemTextures.has(iconKey)) return iconKey;
  const path = `textures/geyser_custom/icons/${name}`;

  // Optional pack-provided icon overrides: sprites.json at pack root mapping
  // model id → texture resource location (same convention as java2bedrock).
  const sprites = ctx.java.readJson<Record<string, string>>("sprites.json");
  const override = sprites?.[modelId];
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
        const id = resolveFaceTexture(resolved.textures, face.texture);
        const tex = id !== undefined ? images.get(id) : undefined;
        if (tex === undefined) return undefined;
        return { image: tex, uv: face.uv ?? defaultUv(faceName, element.from, element.to) };
      },
      resolved.display["gui"],
    );
  }

  alphaBleed(image);
  encodeJobs.push({ path: path + ".png", image });
  ctx.itemTextures.set(iconKey, { textures: path });
  return iconKey;
}
