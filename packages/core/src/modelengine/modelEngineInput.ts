import type { VirtualFs } from "../io/vfs.js";
import { parseLenientJson } from "../java/json.js";
import { type BbModel, extractTextures } from "./bbmodel.js";
import { bbmodelToGeometry } from "./bbmodelGeometry.js";
import { bbmodelToAnimations } from "./bbmodelAnimation.js";

/**
 * Scan an uploaded bundle for Blockbench `.bbmodel` files (ModelEngine /
 * MythicMobs mob models) and produce the `input/` folder the GeyserModelEngine
 * extension consumes. Each model becomes `input/<model>/` containing a Bedrock
 * geometry, an optional animation file, the extracted textures, and a
 * `config.json` (per-texture UV sizes). The extension turns that folder into a
 * full Bedrock entity pack at runtime, so we don't generate entity/render
 * controllers ourselves.
 */
export interface ModelEngineResult {
  /** Files keyed by path under `input/` (e.g. "input/drone/drone.geo.json"). */
  files: Map<string, Uint8Array>;
  /** One entry per model converted, for the report. */
  models: { id: string; source: string; textures: number; animations: number }[];
  /** bbmodels that could not be parsed, with a reason. */
  failed: { source: string; reason: string }[];
}

interface ModelConfig {
  per_texture_uv_size: Record<string, [number, number]>;
  anim_textures: Record<string, { frametime: number }>;
  binding_bones?: Record<string, string[]>;
}

export function buildModelEngineInput(vfs: VirtualFs): ModelEngineResult {
  const result: ModelEngineResult = { files: new Map(), models: [], failed: [] };
  const encoder = new TextEncoder();
  const usedIds = new Set<string>();

  for (const path of vfs.list({ suffix: ".bbmodel" })) {
    const text = vfs.readText(path);
    if (text === undefined) continue;
    const model = parseLenientJson<BbModel>(text);
    if (model === undefined || typeof model !== "object") {
      result.failed.push({ source: path, reason: "unparseable .bbmodel JSON" });
      continue;
    }
    const rawId = model.name ?? baseName(path);
    const modelId = uniqueId(sanitizeId(rawId), usedIds);
    const identifier = `geometry.${modelId}`;

    const { geometry, boneNames, boneTextures } = bbmodelToGeometry(model, identifier);
    if (geometry["minecraft:geometry"][0].bones.length === 0) {
      result.failed.push({ source: path, reason: "no convertible cubes/bones" });
      continue;
    }

    const dir = `input/${modelId}`;
    result.files.set(`${dir}/${modelId}.geo.json`, encoder.encode(JSON.stringify(geometry)));

    const textures = extractTextures(model);
    const perTextureUvSize: Record<string, [number, number]> = {};
    const animTextures: Record<string, { frametime: number }> = {};
    const resW = model.resolution?.width && model.resolution.width > 0 ? model.resolution.width : 16;
    const resH = model.resolution?.height && model.resolution.height > 0 ? model.resolution.height : 16;
    for (const tex of textures) {
      result.files.set(`${dir}/${tex.name}.png`, tex.bytes);
      // UVs are authored in the model's resolution space; tell the extension so
      // it doesn't fall back to a 16×16 assumption on HD textures.
      perTextureUvSize[tex.name] = [resW, resH];
      if (tex.animated) animTextures[tex.name] = { frametime: tex.frameTime };
    }

    // binding_bones: which bones each texture is applied to. Only emit when the
    // model has >1 texture (multi-texture); single-texture defaults to all bones
    // in the extension. Map texture index → name via the textures list order.
    const config: ModelConfig = { per_texture_uv_size: perTextureUvSize, anim_textures: animTextures };
    if (textures.length > 1) {
      const binding: Record<string, string[]> = {};
      for (const [boneName, indices] of boneTextures) {
        for (const idx of indices) {
          const tname = textures[idx]?.name;
          if (tname === undefined) continue;
          (binding[tname] ??= []).push(boneName);
        }
      }
      if (Object.keys(binding).length > 0) config.binding_bones = binding;
    }
    result.files.set(`${dir}/config.json`, encoder.encode(JSON.stringify(config, null, 2)));

    const animations = bbmodelToAnimations(model, modelId, boneNames);
    if (animations !== undefined) {
      result.files.set(`${dir}/${modelId}.animation.json`, encoder.encode(JSON.stringify(animations)));
    }

    result.models.push({
      id: modelId,
      source: path,
      textures: textures.length,
      animations: animations !== undefined ? Object.keys(animations.animations).length : 0,
    });
  }

  return result;
}

function baseName(path: string): string {
  const file = path.split("/").pop() ?? path;
  return file.replace(/\.bbmodel$/i, "");
}

function sanitizeId(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s.length > 0 ? s : "model";
}

function uniqueId(base: string, used: Set<string>): string {
  let candidate = base;
  for (let i = 2; used.has(candidate); i++) candidate = `${base}_${i}`;
  used.add(candidate);
  return candidate;
}
