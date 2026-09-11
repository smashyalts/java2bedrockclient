import type { JavaDisplayContext, JavaDisplayTransform } from "../java/model.js";
import { BONE_ROOT, BONE_X, BONE_Y, BONE_Z } from "./geometry.js";

/**
 * Converts Java display transforms into static Bedrock attachable animations.
 *
 * The bone chain mirrors how Java composes an item pose. The root bone carries
 * Bedrock's own hand/head placement — the constants that turn the item-slot
 * bone's frame into Java's item space — and the `_x`/`_y`/`_z` bones carry the
 * model's own display transform inside it. The Java translation therefore has
 * to live on `_x`, not on the root: the root's rotation applies to everything
 * below it, so folding the translation into the root position would apply it in
 * Bedrock's hand frame instead of Java's item frame (a 90° axis swap for the
 * third-person pose).
 *
 * Off-hand slots additionally mirror the transform. Java's ItemTransform.apply
 * negates the X translation and the Y/Z rotations when the item is in the left
 * hand, and the authored `*_lefthand` values are pre-mirror, so a converter that
 * feeds them through the right-hand formula puts the item on the wrong side
 * facing the wrong way.
 */

type Vec3 = [number, number, number];

interface SlotSpec {
  animationKey: string;
  javaContext: JavaDisplayContext;
  /** Root-bone pose: Bedrock's placement for this slot, before the Java transform. */
  baseRotation?: Vec3;
  basePosition: Vec3;
  /** Root-bone scale; scales the Java translation with the model, as Java does. */
  baseScale?: number;
  /** Head-slot values are authored in skull space and shrink by the render scale. */
  valueScale: number;
  /** Left-hand slots mirror the Java transform the way Java's renderer does. */
  leftHand: boolean;
}

const SLOTS: SlotSpec[] = [
  {
    animationKey: "thirdperson_main_hand",
    javaContext: "thirdperson_righthand",
    baseRotation: [90, 0, 0],
    basePosition: [0, 13, -3],
    valueScale: 1,
    leftHand: false,
  },
  {
    animationKey: "thirdperson_off_hand",
    javaContext: "thirdperson_lefthand",
    baseRotation: [90, 0, 0],
    basePosition: [0, 13, -3],
    valueScale: 1,
    leftHand: true,
  },
  {
    animationKey: "firstperson_main_hand",
    javaContext: "firstperson_righthand",
    baseRotation: [90, 60, -40],
    basePosition: [0, 15, 2],
    baseScale: 1.4,
    valueScale: 1,
    leftHand: false,
  },
  {
    // The off hand sits on the other side of the screen facing the other way,
    // so it needs its own base pose rather than the main hand's.
    animationKey: "firstperson_off_hand",
    javaContext: "firstperson_lefthand",
    baseRotation: [180, 0, 180],
    basePosition: [-18.5, 18.3, 15],
    baseScale: 1.2,
    valueScale: 1,
    leftHand: true,
  },
  {
    animationKey: "head",
    javaContext: "head",
    basePosition: [0, 19.9, 0],
    valueScale: 0.625,
    leftHand: false,
  },
];

export interface BuiltAnimations {
  /** animations file content (animations/<name>.animation.json). */
  file: object;
  /** animation key → full animation identifier, for the attachable. */
  refs: Record<string, string>;
}

export function buildDisplayAnimations(
  name: string,
  display: Partial<Record<JavaDisplayContext, JavaDisplayTransform>>,
  options?: {
    /**
     * Extra Y offset (geometry units, 16 = one block) added to the head-slot
     * base position. Bedrock renders armor-stand head items (HMCCosmetics
     * backpacks/wings) lower than Java; +12 ≈ the observed gap.
     */
    headLift?: number;
  },
): BuiltAnimations {
  const animations: Record<string, object> = {};
  const refs: Record<string, string> = {};

  for (const slot of SLOTS) {
    const id = `animation.geyser_custom.${name}.${slot.animationKey}`;
    refs[slot.animationKey] = id;

    const java = display[slot.javaContext] ?? fallbackContext(display, slot.javaContext);
    const rotation: Vec3 = java?.rotation ?? [0, 0, 0];
    const translation: Vec3 = java?.translation ?? [0, 0, 0];
    const scale: Vec3 = java?.scale ?? [1, 1, 1];
    const vs = slot.valueScale;
    // Java's left-hand mirror: -X translation, -Y and -Z rotation.
    const mirror = slot.leftHand ? -1 : 1;

    const lift = slot.animationKey === "head" ? (options?.headLift ?? 0) : 0;
    const root: Record<string, unknown> = {
      position: [slot.basePosition[0], slot.basePosition[1] + lift, slot.basePosition[2]],
    };
    if (slot.baseRotation !== undefined) root.rotation = slot.baseRotation;
    if (slot.baseScale !== undefined) root.scale = slot.baseScale;

    // Bedrock mirrors Java's X axis, so a Java X translation flips sign here;
    // the left-hand mirror flips it back.
    const boneX: Record<string, unknown> = {
      rotation: [-rotation[0], 0, 0],
      position: [-mirror * translation[0] * vs, translation[1] * vs, translation[2] * vs],
    };
    if (scale[0] !== 1 || scale[1] !== 1 || scale[2] !== 1 || vs !== 1) {
      boneX.scale = [scale[0] * vs, scale[1] * vs, scale[2] * vs];
    }

    animations[id] = {
      loop: true,
      bones: {
        [BONE_ROOT]: root,
        [BONE_X]: boneX,
        [BONE_Y]: { rotation: [0, -mirror * rotation[1], 0] },
        [BONE_Z]: { rotation: [0, 0, mirror * rotation[2]] },
      },
    };
  }

  return {
    file: { format_version: "1.8.0", animations },
    refs,
  };
}

/** Java falls back left→right hand contexts when one is missing. */
function fallbackContext(
  display: Partial<Record<JavaDisplayContext, JavaDisplayTransform>>,
  context: JavaDisplayContext,
): JavaDisplayTransform | undefined {
  if (context === "thirdperson_lefthand") return display["thirdperson_righthand"];
  if (context === "firstperson_lefthand") return display["firstperson_righthand"];
  return undefined;
}
