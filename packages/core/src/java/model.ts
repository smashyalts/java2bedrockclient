/** Java Edition block/item model JSON structures. */

export interface JavaModel {
  parent?: string;
  textures?: Record<string, string>;
  elements?: JavaElement[];
  overrides?: JavaOverride[];
  display?: Partial<Record<JavaDisplayContext, JavaDisplayTransform>>;
  ambientocclusion?: boolean;
  gui_light?: "front" | "side";
}

export interface JavaElement {
  from: [number, number, number];
  to: [number, number, number];
  rotation?: {
    origin: [number, number, number];
    axis: "x" | "y" | "z";
    angle: number;
    rescale?: boolean;
  };
  faces?: Partial<Record<JavaFaceName, JavaFace>>;
  shade?: boolean;
}

export type JavaFaceName = "north" | "south" | "east" | "west" | "up" | "down";

export interface JavaFace {
  uv?: [number, number, number, number];
  texture: string;
  rotation?: 0 | 90 | 180 | 270;
  tintindex?: number;
  cullface?: string;
}

export type JavaDisplayContext =
  | "thirdperson_righthand"
  | "thirdperson_lefthand"
  | "firstperson_righthand"
  | "firstperson_lefthand"
  | "gui"
  | "head"
  | "ground"
  | "fixed";

export interface JavaDisplayTransform {
  rotation?: [number, number, number];
  translation?: [number, number, number];
  scale?: [number, number, number];
}

export interface JavaOverride {
  predicate: Record<string, number>;
  model: string;
}

/** Vanilla parents that mean "flat sprite" rendering. */
const GENERATED_PARENTS = new Set([
  "minecraft:item/generated",
  "item/generated",
  "minecraft:builtin/generated",
  "builtin/generated",
]);

const HANDHELD_PARENTS = new Set([
  "minecraft:item/handheld",
  "item/handheld",
  "minecraft:item/handheld_rod",
  "item/handheld_rod",
  "minecraft:item/handheld_mace",
  "item/handheld_mace",
]);

export function isGeneratedParent(id: string): boolean {
  return GENERATED_PARENTS.has(id);
}

export function isHandheldParent(id: string): boolean {
  return HANDHELD_PARENTS.has(id);
}

export function isBuiltinEntityParent(id: string): boolean {
  return id === "minecraft:builtin/entity" || id === "builtin/entity";
}
