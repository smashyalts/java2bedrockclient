import type { ConversionContext, PendingGeometry, PipelineStage } from "../context.js";
import { buildAtlas } from "../../image/atlas.js";
import { buildGeometry } from "../../bedrock/geometry.js";
import { buildDisplayAnimations } from "../../bedrock/animations.js";
import { buildFlipbookRenderController, buildItemAttachable } from "../../bedrock/attachable.js";
import { parseLenientJson } from "../../java/json.js";
import { alphaBleed, decodePng, encodePng, type RgbaImage } from "../../image/png.js";
import { sha256 } from "@noble/hashes/sha2";
import { renderModelIcon } from "../../image/modelRender.js";
import { defaultUv } from "../../bedrock/geometry.js";
import { buildDefinition, safeName } from "./itemsStage.js";
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

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
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
    frames?: (number | { index: number; time?: number })[];
  };
}

/** Load a texture, splitting mcmeta flipbook strips into ordered frames. */
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
  // Custom frame order (per-frame times collapse to the global frametime).
  const order = meta.animation.frames?.map((f) => (typeof f === "number" ? f : f.index));
  const frames =
    order !== undefined && order.length > 0
      ? order.map((i) => strip[Math.min(i, strip.length - 1)]!)
      : strip;
  return { frames, frametime: Math.max(1, meta.animation.frametime ?? 1) };
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

    // Content-hash cache for atlas PNGs: items sharing texture sets (bow_0/1/2
    // charge variants) and repeated animation frames reuse one file.
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
  const animated = [...loaded.values()].filter((t) => t.frames.length > 1);
  const maxSourceFrames = Math.max(1, ...animated.map((t) => t.frames.length));
  // 0 = unlimited: keep the full animation (default).
  const frameCap = ctx.options.maxAnimationFrames > 0 ? ctx.options.maxAnimationFrames : maxSourceFrames;
  const timelineFrames = Math.min(maxSourceFrames, frameCap);
  const frametime = animated.length > 0 ? Math.min(...animated.map((t) => t.frametime)) : 1;
  // fps for the render controller; compensates when the timeline is subsampled.
  const fps = (timelineFrames * 20) / (maxSourceFrames * frametime);

  const framePaths: string[] = [];
  let atlas!: ReturnType<typeof buildAtlas>;
  for (let f = 0; f < timelineFrames; f++) {
    const sourceIndex = Math.floor((f * maxSourceFrames) / timelineFrames);
    // Same insertion order every frame → identical atlas placements.
    const frameImages = new Map<string, RgbaImage>();
    for (const [id, tex] of loaded) {
      frameImages.set(id, tex.frames[sourceIndex % tex.frames.length]!);
    }
    const frameAtlas = buildAtlas(frameImages);
    alphaBleed(frameAtlas.image);
    if (f === 0) atlas = frameAtlas;

    const png = encodePng(frameAtlas.image);
    const hash = toHex(sha256(png));
    const cached = atlasCache.get(hash);
    if (cached !== undefined) {
      framePaths.push(cached);
    } else {
      const path =
        f === 0 ? `textures/geyser_custom/atlases/${name}` : `textures/geyser_custom/atlases/${name}_f${f}`;
      ctx.bedrock.write(path + ".png", png);
      atlasCache.set(hash, path);
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
  const geo = buildGeometry(geometryId, elements, faceTexture, {
    width: atlas.image.width,
    height: atlas.image.height,
  });
  ctx.bedrock.writeJson(`models/entity/geyser_custom/${name}.geo.json`, geo.geometry);

  // 5. Display-transform animations.
  const anims = buildDisplayAnimations(name, resolved.display);
  ctx.bedrock.writeJson(`animations/geyser_custom/${name}.animation.json`, anims.file);

  // 6. Attachable (+ flipbook render controller when animated).
  const identifier = `geyser_custom:${name}`;
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
  ctx.bedrock.writeJson(
    `attachables/geyser_custom/${name}.json`,
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

  // 7. Icon: sprites.json override → isometric software render of the model.
  const iconKey = pickIcon(ctx, modelId, name, resolved, images);

  // 8. Register one mapping entry per variant that used this model.
  for (const { variant } of group) {
    const definition = buildDefinition(ctx, variant, { icon: iconKey, displayHandheld: false });
    ctx.definitionTextures.set(definition, [...textureIds]);
  }

  const outputs = [
    atlasPath + ".png",
    `models/entity/geyser_custom/${name}.geo.json`,
    `animations/geyser_custom/${name}.animation.json`,
    `attachables/geyser_custom/${name}.json`,
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
