import type { JavaDisplayContext, JavaDisplayTransform } from "../java/model.js";
import { BONE_ROOT, BONE_X, BONE_Y, BONE_Z } from "./geometry.js";

/**
 * Converts Java display transforms into static Bedrock attachable animations.
 * Base offsets per slot replicate how Bedrock positions held/worn items so the
 * Java display values can be layered on top (constants from java2bedrock.sh).
 */

type Vec3 = [number, number, number];

interface SlotSpec {
  animationKey: string;
  javaContext: JavaDisplayContext;
  baseRotation: Vec3;
  basePosition: Vec3;
  baseScale: number;
  /** Head-slot values are shrunk by the skull render scale. */
  valueScale: number;
}

const SLOTS: SlotSpec[] = [
  {
    animationKey: "thirdperson_main_hand",
    javaContext: "thirdperson_righthand",
    baseRotation: [90, 0, 0],
    basePosition: [0, 13, -3],
    baseScale: 1,
    valueScale: 1,
  },
  {
    animationKey: "thirdperson_off_hand",
    javaContext: "thirdperson_lefthand",
    baseRotation: [90, 0, 0],
    basePosition: [0, 13, -3],
    baseScale: 1,
    valueScale: 1,
  },
  {
    animationKey: "firstperson_main_hand",
    javaContext: "firstperson_righthand",
    baseRotation: [90, 60, -40],
    basePosition: [4, 10, 4],
    baseScale: 1.5,
    valueScale: 1,
  },
  {
    animationKey: "firstperson_off_hand",
    javaContext: "firstperson_lefthand",
    baseRotation: [90, 60, -40],
    basePosition: [4, 10, 4],
    baseScale: 1.5,
    valueScale: 1,
  },
  {
    animationKey: "head",
    javaContext: "head",
    baseRotation: [0, 0, 0],
    basePosition: [0, 19.5, 0],
    baseScale: 0.625,
    valueScale: 0.625,
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

    const bones: Record<string, object> = {
      [BONE_ROOT]: {
        rotation: slot.baseRotation,
        position: [
          slot.basePosition[0] - translation[0] * vs,
          slot.basePosition[1] + translation[1] * vs,
          slot.basePosition[2] + translation[2] * vs,
        ],
      },
      [BONE_X]: { rotation: [-rotation[0], 0, 0] },
      [BONE_Y]: { rotation: [0, -rotation[1], 0] },
      [BONE_Z]: {
        rotation: [0, 0, rotation[2]],
        scale: [scale[0] * slot.baseScale, scale[1] * slot.baseScale, scale[2] * slot.baseScale],
      },
    };

    animations[id] = { loop: true, bones };
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
