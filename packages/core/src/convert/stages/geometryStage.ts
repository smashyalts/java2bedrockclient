import type { ConversionContext, PendingGeometry, PipelineStage } from "../context.js";
import { buildAtlas } from "../../image/atlas.js";
import { buildGeometry } from "../../bedrock/geometry.js";
import { buildDisplayAnimations } from "../../bedrock/animations.js";
import { buildFlipbookRenderController, buildItemAttachable } from "../../bedrock/attachable.js";
import { parseLenientJson } from "../../java/json.js";
import { alphaBleed, decodePng, encodePng, type RgbaImage } from "../../image/png.js";
import { timeOp } from "../../report/timings.js";
import { renderModelIcon } from "../../image/modelRender.js";
import { defaultUv } from "../../bedrock/geometry.js";
import { buildDefinition, safeName } from "./itemsStage.js";
import { parseResourceLocation } from "../../java/javaPack.js";
import type { JavaElement, JavaFaceName } from "../../java/model.js";
import type { ResolvedModel } from "../../resolve/modelResolver.js";

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

/**
 * Fast content hash for atlas dedup keys. Two independent FNV-1a lanes give a
 * 64-bit digest — collision odds across a pack's frames are ~1e-12, so we skip
 * a cryptographic hash (sha256 here cost ~12s on a large pack). Dedup only
 * needs "same pixels → same key", not tamper resistance.
 */
function fastHash(data: Uint8Array): string {
  let h1 = 0x811c9dc5 ^ data.length;
  let h2 = 0xc2b2ae35 ^ data.length;
  for (let i = 0; i < data.length; i++) {
    const b = data[i]!;
    h1 = Math.imul(h1 ^ b, 0x01000193);
    h2 = Math.imul(h2 ^ b, 0x85ebca77);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
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
  const out = new Uint8Array(a.data.length);
  const bd = b.data.length === a.data.length ? b.data : a.data;
  for (let i = 0; i < a.data.length; i++) {
    out[i] = Math.round(a.data[i]! + (bd[i]! - a.data[i]!) * t);
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
 */
function loadTexture(ctx: ConversionContext, textureId: string): LoadedTexture | undefined {
  const path = ctx.java.assetPath("textures", textureId, ".png");
  const bytes = ctx.java.read(path);
  if (bytes === undefined) return undefined;
  const image = decodePng(bytes);

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
export const geometryStage: PipelineStage = {
  name: "items-3d",
  run(ctx: ConversionContext): void {
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

    let done = 0;
    for (const [modelId, group] of byModel) {
      done++;
      ctx.progress("items-3d", done, byModel.size);
      try {
        convertModel(ctx, modelId, group, atlasCache);
      } catch (err) {
        ctx.report.error("items-3d", modelId, err instanceof Error ? err.message : String(err));
      }
    }
  },
};

function convertModel(
  ctx: ConversionContext,
  modelId: string,
  group: PendingGeometry[],
  atlasCache: Map<string, string>,
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
    const tex = loadTexture(ctx, id);
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
      ctx.bedrock.write(path + ".png", encodePng(frameAtlas.image));
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
  const geo = timeOp("geometry.build", () =>
    buildGeometry(geometryId, elements, faceTexture, {
      width: atlas.image.width,
      height: atlas.image.height,
    }),
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
  const iconKey = pickIcon(ctx, modelId, name, resolved, images);

  // 8. Register a mapping entry per variant, and an attachable per unique
  // bedrock identifier (definitions may get item-model based identifiers, so
  // one shared model can back several bedrock items).
  const attachableIds = new Set<string>();
  for (const { variant } of group) {
    const definition = buildDefinition(ctx, variant, { icon: iconKey, displayHandheld: false });
    ctx.definitionTextures.set(definition, [...textureIds]);
    const identifier = definition.bedrock_identifier!;
    if (attachableIds.has(identifier)) continue;
    attachableIds.add(identifier);
    ctx.bedrock.writeJson(
      `attachables/geyser_custom/${safeName(identifier.split(":")[1] ?? identifier)}.json`,
      buildItemAttachable({
        identifier,
        material: ctx.options.attachableMaterial,
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

/** custom_model_data value of a variant (legacy field or modern range_dispatch predicate). */
function cmdOf(variant: PendingGeometry["variant"]): number | undefined {
  if (variant.source.kind === "legacy") return variant.source.customModelData;
  const p = variant.predicates.find(
    (p) => p.type === "range_dispatch" && p.property === "custom_model_data",
  );
  return p !== undefined && "threshold" in p ? p.threshold : undefined;
}

function resolveFaceTexture(textures: Record<string, string>, ref: string): string | undefined {
  let value = ref;
  const seen = new Set<string>();
  while (value.startsWith("#")) {
    const key = value.slice(1);
    if (seen.has(key)) return undefined;
    seen.add(key);
    const next = textures[key];
    if (next === undefined) return undefined;
    value = next;
  }
  return value;
}

function pickIcon(
  ctx: ConversionContext,
  modelId: string,
  name: string,
  resolved: ResolvedModel,
  images: Map<string, RgbaImage>,
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
  ctx.bedrock.write(path + ".png", encodePng(image));
  ctx.itemTextures.set(iconKey, { textures: path });
  return iconKey;
}
