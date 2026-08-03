import type { BbModel, BbKeyframe } from "./bbmodel.js";

/**
 * Convert a bbmodel's animations to a Bedrock `animations` file.
 *
 * Each bbmodel animator is keyed by its bone uuid; we resolve that to the final
 * Bedrock bone name (from the geometry build) so keyframes bind after any bone
 * renaming. Values are transformed for Bedrock's X-mirrored space: rotation
 * negates X and Y, position negates X, scale is unchanged. Keyframes become a
 * time → value map (linear); catmullrom smoothing is not reproduced.
 */
export interface BedrockAnimations {
  format_version: string;
  animations: Record<string, BedrockAnimation>;
}

interface BedrockAnimation {
  loop?: boolean;
  animation_length?: number;
  bones: Record<string, BedrockBoneChannels>;
}

interface BedrockBoneChannels {
  rotation?: Record<string, [number, number, number]>;
  position?: Record<string, [number, number, number]>;
  scale?: Record<string, [number, number, number]>;
}

export function bbmodelToAnimations(
  model: BbModel,
  modelId: string,
  boneNames: Map<string, string>,
): BedrockAnimations | undefined {
  const anims = model.animations ?? [];
  if (anims.length === 0) return undefined;

  const animations: Record<string, BedrockAnimation> = {};
  for (const anim of anims) {
    const bones: Record<string, BedrockBoneChannels> = {};
    for (const [boneUuid, animator] of Object.entries(anim.animators ?? {})) {
      const boneName = boneNames.get(boneUuid) ?? sanitize(animator.name);
      if (boneName === undefined) continue;
      const channels: BedrockBoneChannels = {};
      for (const kf of animator.keyframes ?? []) {
        const value = keyframeValue(kf);
        if (value === undefined) continue;
        const time = timeKey(kf.time);
        if (kf.channel === "rotation") (channels.rotation ??= {})[time] = value;
        else if (kf.channel === "position") (channels.position ??= {})[time] = value;
        else if (kf.channel === "scale") (channels.scale ??= {})[time] = value;
      }
      if (channels.rotation || channels.position || channels.scale) bones[boneName] = channels;
    }
    if (Object.keys(bones).length === 0) continue;
    const name = `animation.${modelId}.${sanitize(anim.name) ?? "anim"}`;
    animations[name] = {
      loop: anim.loop === "loop" || anim.loop === true ? true : undefined,
      animation_length: anim.length,
      bones,
    };
  }

  if (Object.keys(animations).length === 0) return undefined;
  return { format_version: "1.8.0", animations };
}

/** First data point → Bedrock-space value for the keyframe's channel. */
function keyframeValue(kf: BbKeyframe): [number, number, number] | undefined {
  const dp = kf.data_points?.[0];
  if (dp === undefined) return undefined;
  const x = num(dp.x);
  const y = num(dp.y);
  const z = num(dp.z);
  if (kf.channel === "rotation") return [-x, -y, z];
  if (kf.channel === "position") return [-x, y, z];
  return [x, y, z]; // scale
}

function num(v: number | string | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Bedrock animation time keys are decimal strings ("0.0", "0.25"). */
function timeKey(t: number): string {
  return Number.isFinite(t) ? String(t) : "0.0";
}

function sanitize(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s.length > 0 ? s : undefined;
}
