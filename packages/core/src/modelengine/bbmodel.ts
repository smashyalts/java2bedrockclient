/**
 * Blockbench `.bbmodel` model parsing for ModelEngine / MythicMobs mob models.
 *
 * A bbmodel is Blockbench's native JSON: a `resolution` (UV space), a flat
 * `elements` list (cubes), an `outliner` bone tree that references elements by
 * uuid, embedded `textures` (base64 data URIs), and `animations` (per-bone
 * keyframe channels). We convert these to the Bedrock entity geometry +
 * animation the GeyserModelEngine extension consumes from its `input/` folder.
 */

export interface BbModel {
  resolution?: { width: number; height: number };
  elements?: BbElement[];
  outliner?: BbOutlinerNode[];
  textures?: BbTexture[];
  animations?: BbAnimation[];
  name?: string;
}

export interface BbElement {
  uuid: string;
  name?: string;
  type?: string; // "cube" (only cubes are convertible); meshes/locators skipped
  from?: [number, number, number];
  to?: [number, number, number];
  origin?: [number, number, number]; // rotation pivot
  rotation?: [number, number, number]; // euler degrees, may be multi-axis
  inflate?: number;
  faces?: Partial<Record<BbFaceName, BbFace>>;
}

export type BbFaceName = "north" | "south" | "east" | "west" | "up" | "down";

export interface BbFace {
  uv?: [number, number, number, number];
  texture?: number | null; // index into textures[]
  rotation?: number;
}

/** A bone (group) or a raw element uuid (string) referencing an element. */
export type BbOutlinerNode = string | BbGroup;

export interface BbGroup {
  uuid: string;
  name: string;
  origin?: [number, number, number]; // bone pivot
  rotation?: [number, number, number];
  children?: BbOutlinerNode[];
}

export interface BbTexture {
  name?: string;
  width?: number;
  height?: number;
  source?: string; // "data:image/png;base64,..."
  frame_time?: number;
  /** Blockbench animated-texture flag (vertical strip). */
  animation?: boolean;
}

export interface BbAnimation {
  name: string;
  loop?: "loop" | "once" | "hold" | boolean;
  length?: number;
  animators?: Record<string, BbAnimator>;
}

export interface BbAnimator {
  name?: string; // bone name this animator drives
  keyframes?: BbKeyframe[];
}

export interface BbKeyframe {
  channel: "rotation" | "position" | "scale";
  time: number;
  interpolation?: string;
  data_points?: { x?: number | string; y?: number | string; z?: number | string }[];
}

export function isCube(el: BbElement): boolean {
  return (el.type ?? "cube") === "cube" && el.from !== undefined && el.to !== undefined;
}

/** A texture extracted from a bbmodel's embedded base64 source. */
export interface BbExtractedTexture {
  name: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  animated: boolean;
  frameTime: number;
}

/** Decode the base64 `source` of every texture with usable image data. */
export function extractTextures(model: BbModel): BbExtractedTexture[] {
  const out: BbExtractedTexture[] = [];
  const textures = model.textures ?? [];
  textures.forEach((tex, i) => {
    const src = tex.source;
    if (typeof src !== "string") return;
    const comma = src.indexOf(",");
    const b64 = comma >= 0 && src.startsWith("data:") ? src.slice(comma + 1) : src;
    let bytes: Uint8Array;
    try {
      bytes = base64Decode(b64);
    } catch {
      return;
    }
    if (bytes.length === 0) return;
    const width = tex.width && tex.width > 0 ? tex.width : (model.resolution?.width ?? 16);
    const height = tex.height && tex.height > 0 ? tex.height : (model.resolution?.height ?? 16);
    out.push({
      name: sanitizeTextureName(tex.name ?? `texture_${i}`),
      bytes,
      width,
      height,
      // A texture taller than wide is a vertical flipbook strip.
      animated: tex.animation === true || height > width,
      frameTime: tex.frame_time ?? 1,
    });
  });
  return out;
}

/** Strip a trailing .png and lowercase; keep it filesystem-safe. */
export function sanitizeTextureName(name: string): string {
  return name
    .replace(/\.png$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_CHARS.length; i++) t[B64_CHARS.charCodeAt(i)] = i;
  return t;
})();

/** Environment-agnostic base64 → bytes (no atob/Buffer dependency). */
function base64Decode(input: string): Uint8Array {
  const s = input.replace(/[^A-Za-z0-9+/]/g, "");
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  const len = Math.floor((s.length * 3) / 4) - pad;
  const out = new Uint8Array(Math.max(0, len));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const a = B64_LOOKUP[s.charCodeAt(i)] ?? 0;
    const b = B64_LOOKUP[s.charCodeAt(i + 1)] ?? 0;
    const c = B64_LOOKUP[s.charCodeAt(i + 2)] ?? 0;
    const d = B64_LOOKUP[s.charCodeAt(i + 3)] ?? 0;
    const chunk = (a << 18) | (b << 12) | (c << 6) | d;
    if (o < len) out[o++] = (chunk >> 16) & 0xff;
    if (o < len) out[o++] = (chunk >> 8) & 0xff;
    if (o < len) out[o++] = chunk & 0xff;
  }
  return out;
}
