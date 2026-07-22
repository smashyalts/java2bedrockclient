import type { JavaPack } from "../java/javaPack.js";
import {
  isBuiltinEntityParent,
  isGeneratedParent,
  isHandheldParent,
  isVanillaItemParent,
  type JavaDisplayContext,
  type JavaDisplayTransform,
  type JavaElement,
  type JavaModel,
} from "../java/model.js";
import { parseResourceLocation } from "../java/javaPack.js";
import { lookupBuiltinModel } from "../data/builtinModels.js";

export type ModelKind = "sprite" | "sprite_handheld" | "geometry" | "builtin_entity" | "unknown";

export interface ResolvedModel {
  /** The model id this resolution started from ("ns:path"). */
  id: string;
  kind: ModelKind;
  /** Merged texture map with #refs fully resolved to resource locations. */
  textures: Record<string, string>;
  /** Elements from the nearest model in the chain that defines them. */
  elements: JavaElement[] | undefined;
  /** Display transforms merged along the chain (child wins per context). */
  display: Partial<Record<JavaDisplayContext, JavaDisplayTransform>>;
  /** Deepest parent id that was NOT found in the pack (a vanilla parent), if any. */
  terminalParent: string | undefined;
  /** Chain of model ids that were loaded from the pack, child first. */
  chain: string[];
}

function modelAssetPath(id: string): string {
  const loc = parseResourceLocation(id);
  return `assets/${loc.namespace}/models/${loc.path}.json`;
}

export function loadModel(pack: JavaPack, id: string): JavaModel | undefined {
  return pack.readJson<JavaModel>(modelAssetPath(id));
}

/**
 * Resolve a model's parent chain. Vanilla parents (not present in the pack)
 * terminate the chain and determine classification for models without elements.
 */
export function resolveModel(pack: JavaPack, id: string): ResolvedModel | undefined {
  const chain: string[] = [];
  const models: JavaModel[] = [];
  let terminalParent: string | undefined;

  let current: string | undefined = id;
  for (let depth = 0; current !== undefined && depth < 32; depth++) {
    let model = loadModel(pack, current);
    if (model === undefined) {
      // Terminal sprite/entity markers stay terminal; other vanilla parents
      // (block/cube_all, block/cross, …) resolve against the built-in library.
      if (!isGeneratedParent(current) && !isHandheldParent(current) && !isBuiltinEntityParent(current)) {
        model = lookupBuiltinModel(current);
        // Fallback: a vanilla item model (minecraft:item/<name>) not in the
        // builtin library and not in the pack — synthesize a minimal model
        // that parents to item/generated so the chain walks through it. This
        // lets inferHostItemFromModel find the host item in the chain and
        // gives non-handheld items the correct sprite classification.
        // Handheld-family items (swords, tools, …) are in BUILTIN_MODELS and
        // route to item/handheld* for sprite_handheld classification.
        if (model === undefined && isVanillaItemParent(current)) {
          model = { parent: "minecraft:item/generated" };
        }
      }
      if (model === undefined) {
        terminalParent = current;
        break;
      }
    }
    chain.push(current);
    models.push(model);
    current = model.parent;
  }
  if (models.length === 0) return undefined;

  // Merge textures child-first (child entries win).
  const textures: Record<string, string> = {};
  for (let i = models.length - 1; i >= 0; i--) {
    Object.assign(textures, models[i]!.textures ?? {});
  }
  resolveTextureRefs(textures);

  // Elements: nearest model in the chain that defines them wins.
  let elements: JavaElement[] | undefined;
  for (const model of models) {
    if (model.elements !== undefined) {
      elements = model.elements;
      break;
    }
  }

  // Display: merge, child wins per context.
  const display: ResolvedModel["display"] = {};
  for (let i = models.length - 1; i >= 0; i--) {
    Object.assign(display, models[i]!.display ?? {});
  }

  let kind: ModelKind = "unknown";
  if (elements !== undefined && elements.length > 0) {
    kind = "geometry";
  } else if (terminalParent !== undefined) {
    if (isGeneratedParent(terminalParent)) kind = "sprite";
    else if (isHandheldParent(terminalParent)) kind = "sprite_handheld";
    else if (isBuiltinEntityParent(terminalParent)) kind = "builtin_entity";
    else if (isVanillaItemParent(terminalParent)) kind = "sprite";
    else kind = "unknown"; // vanilla block parent etc. — resolved against builtin library later
  } else if (Object.keys(textures).length > 0) {
    // Model with textures but no elements and no unknown parent — treat as sprite.
    kind = "sprite";
  }

  return { id, kind, textures, elements, display, terminalParent, chain };
}

/** Resolve a single "#name" texture reference to a resource location, or undefined on cycle/missing. */
export function resolveTextureRef(textures: Record<string, string>, ref: string): string | undefined {
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

/** Resolve "#name" indirections inside a texture map, in place. */
function resolveTextureRefs(textures: Record<string, string>): void {
  for (const key of Object.keys(textures)) {
    const resolved = resolveTextureRef(textures, textures[key]!);
    if (resolved !== undefined) textures[key] = resolved;
  }
}

/**
 * Infer a vanilla host item from a custom model's parent chain. When a custom
 * item model parents to a specific vanilla item model (e.g.
 * `minecraft:item/diamond_sword`) to inherit its display transforms, the host
 * item is almost certainly that vanilla item. Returns `minecraft:<name>` or
 * undefined when no specific vanilla item ancestor is found.
 *
 * The model id itself is checked first (handles `special`-type `base` refs and
 * direct vanilla model references whose file isn't in the pack), then the
 * terminal parent (deepest ancestor not in the pack), then ancestors loaded
 * from the pack (deepest first). Generic parents (`item/generated`,
 * `item/handheld`, `builtin/entity`, …) are excluded — they don't identify a
 * specific vanilla item.
 */
export function inferHostItemFromModel(
  pack: JavaPack,
  modelId: string,
  cache?: Map<string, string | undefined>,
): string | undefined {
  if (cache?.has(modelId)) return cache.get(modelId);
  const inferred = inferHostItemImpl(pack, modelId);
  cache?.set(modelId, inferred);
  return inferred;
}

function inferHostItemImpl(pack: JavaPack, modelId: string): string | undefined {
  const direct = hostItemFromModelId(modelId);
  if (direct !== undefined) return direct;
  const resolved = resolveModel(pack, modelId);
  if (resolved === undefined) return undefined;
  const candidates = [
    resolved.terminalParent,
    ...resolved.chain.slice(1).reverse(),
  ].filter((id): id is string => id !== undefined);
  for (const candidate of candidates) {
    const host = hostItemFromModelId(candidate);
    if (host !== undefined) return host;
  }
  return undefined;
}

/** `minecraft:item/<name>` → `minecraft:<name>`, excluding generic parents. */
function hostItemFromModelId(id: string): string | undefined {
  if (!isVanillaItemParent(id)) return undefined;
  const loc = parseResourceLocation(id);
  return `minecraft:${loc.path.slice("item/".length)}`;
}

/** Sprite layers in order (layer0, layer1, …) as resource locations. */
export function spriteLayers(resolved: ResolvedModel): string[] {
  const layers: string[] = [];
  for (let i = 0; ; i++) {
    const layer = resolved.textures[`layer${i}`];
    if (layer === undefined) break;
    if (!layer.startsWith("#")) layers.push(layer);
  }
  // Some models use a single non-layer texture for the sprite.
  if (layers.length === 0) {
    const fallback =
      resolved.textures["texture"] ?? resolved.textures["all"] ?? resolved.textures["particle"];
    if (fallback !== undefined && !fallback.startsWith("#")) layers.push(fallback);
  }
  return layers;
}
