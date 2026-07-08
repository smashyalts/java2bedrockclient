import type { ConversionContext, GeyserItemDefinition, PipelineStage } from "../context.js";
import { ARMOR_SLOTS, buildArmorAttachable, buildElytraAttachable, type ArmorPiece } from "../../bedrock/armor.js";
import { parseResourceLocation } from "../../java/javaPack.js";
import { safeName } from "./itemsStage.js";

interface EquipmentAsset {
  layers?: {
    humanoid?: { texture: string }[];
    humanoid_leggings?: { texture: string }[];
    wings?: { texture: string }[];
  };
}

/** One custom armor material discovered in the pack. */
interface ArmorSet {
  /** e.g. "custom:ruby". */
  id: string;
  name: string;
  /** Pack paths of the layer textures. */
  layer1?: string;
  layer2?: string;
  wings?: string;
  origin: string;
}

/**
 * Custom armor conversion. Detects armor materials from:
 *  - modern equipment assets (assets/&lt;ns&gt;/equipment/*.json, 1.21.2+)
 *  - legacy custom layer textures (assets/&lt;ns&gt;/textures/models/armor/&lt;name&gt;_layer_N.png)
 * and generates Bedrock armor attachables bound to the item mappings created by
 * the earlier stages (matched by name), adding equippable components.
 *
 * Runs after items/geometry stages so the Geyser mappings are populated.
 */
export const armorStage: PipelineStage = {
  name: "armor",
  run(ctx: ConversionContext): void {
    const sets = new Map<string, ArmorSet>();

    // Modern equipment assets.
    for (const ns of ctx.java.namespaces()) {
      const prefix = `assets/${ns}/equipment/`;
      for (const path of ctx.java.list({ prefix, suffix: ".json" })) {
        const name = path.slice(prefix.length, -".json".length);
        // Vanilla materials in the minecraft namespace are plain retextures —
        // the textures stage already remapped their layer textures.
        if (ns === "minecraft" && VANILLA_MATERIALS.has(name)) continue;
        const asset = ctx.java.readJson<EquipmentAsset>(path);
        if (asset?.layers === undefined) continue;
        const set: ArmorSet = { id: `${ns}:${name}`, name: safeName(`${ns}_${name}`), origin: path };
        const tex = (id: string | undefined, kind: string): string | undefined => {
          if (id === undefined) return undefined;
          const loc = parseResourceLocation(id);
          return `assets/${loc.namespace}/textures/entity/equipment/${kind}/${loc.path}.png`;
        };
        set.layer1 = tex(asset.layers.humanoid?.[0]?.texture, "humanoid");
        set.layer2 = tex(asset.layers.humanoid_leggings?.[0]?.texture, "humanoid_leggings");
        set.wings = tex(asset.layers.wings?.[0]?.texture, "wings");
        sets.set(set.id, set);
      }
    }

    // Legacy custom layer textures (non-vanilla material names, any namespace).
    for (const ns of ctx.java.namespaces()) {
      const prefix = `assets/${ns}/textures/models/armor/`;
      for (const path of ctx.java.list({ prefix, suffix: ".png" })) {
        const match = path.slice(prefix.length).match(/^(.+?)_layer_(\d)\.png$/);
        if (!match) continue;
        const [, material, layer] = match;
        if (ns === "minecraft" && VANILLA_MATERIALS.has(material!)) continue;
        const id = `${ns}:${material}`;
        const set = sets.get(id) ?? { id, name: safeName(`${ns}_${material}`), origin: path };
        if (layer === "1") set.layer1 ??= path;
        else set.layer2 ??= path;
        sets.set(id, set);
      }
    }

    let done = 0;
    for (const set of sets.values()) {
      done++;
      ctx.progress("armor", done, sets.size);
      try {
        convertArmorSet(ctx, set);
      } catch (err) {
        ctx.report.error("armor", set.origin, err instanceof Error ? err.message : String(err));
      }
    }
  },
};

const VANILLA_MATERIALS = new Set([
  "leather", "chainmail", "iron", "gold", "golden", "diamond", "netherite", "turtle", "elytra",
  "turtle_scute", "armadillo_scute", "wolf",
]);

const PIECES: ArmorPiece[] = ["helmet", "chestplate", "leggings", "boots"];

function convertArmorSet(ctx: ConversionContext, set: ArmorSet): void {
  // Copy layer textures.
  const outputs: string[] = [];
  const texturePaths: Partial<Record<"layer1" | "layer2" | "wings", string>> = {};
  for (const key of ["layer1", "layer2", "wings"] as const) {
    const src = set[key];
    if (src === undefined) continue;
    const bytes = ctx.java.read(src);
    if (bytes === undefined) {
      ctx.report.approximated("armor", set.origin, `${key} texture ${src} missing from pack`);
      continue;
    }
    const out = `textures/geyser_custom/armor/${set.name}_${key}`;
    ctx.bedrock.write(out + ".png", bytes);
    texturePaths[key] = out;
    outputs.push(out + ".png");
  }

  // Find item mapping definitions that look like pieces of this set.
  const material = parseResourceLocation(set.id).path.toLowerCase();
  let matchedAny = false;

  for (const piece of PIECES) {
    const layerKey = piece === "leggings" ? "layer2" : "layer1";
    const texture = texturePaths[layerKey];
    if (texture === undefined) continue;

    // Match by identifier name, or — for renamed items (e.g. "solar_boots"
    // whose art lives under "akiraset/") — by the textures their model used.
    const matches = findDefinitions(ctx, (name, textures) => {
      const materialHit = name.includes(material) || textures.some((t) => t.includes(material));
      const pieceHit = name.includes(piece) || textures.some((t) => t.includes(piece));
      return materialHit && pieceHit;
    });
    if (matches.length === 0) {
      // Emit a standalone attachable so server-side item APIs can still use it.
      const identifier = `geyser_custom:${set.name}_${piece}`;
      ctx.bedrock.writeJson(
        `attachables/geyser_custom/armor/${set.name}_${piece}.json`,
        buildArmorAttachable({ identifier, piece, texture }),
      );
      ctx.report.approximated(
        "armor",
        set.origin,
        `no item mapping matched ${material} ${piece} — standalone attachable ${identifier} emitted`,
      );
      continue;
    }
    for (const def of matches) {
      ctx.bedrock.writeJson(
        `attachables/geyser_custom/armor/${safeName(def.bedrock_identifier!)}.json`,
        buildArmorAttachable({ identifier: def.bedrock_identifier!, piece, texture }),
      );
      def.components = {
        ...def.components,
        "minecraft:equippable": { slot: ARMOR_SLOTS[piece] },
      };
      matchedAny = true;
    }
  }

  if (texturePaths.wings !== undefined) {
    const matches = findDefinitions(ctx, (name, textures) => {
      const materialHit = name.includes(material) || textures.some((t) => t.includes(material));
      const kindHit = ["elytra", "wings", "cape"].some(
        (k) => name.includes(k) || textures.some((t) => t.includes(k)),
      );
      return materialHit && kindHit;
    });
    if (matches.length === 0) {
      const identifier = `geyser_custom:${set.name}_elytra`;
      ctx.bedrock.writeJson(
        `attachables/geyser_custom/armor/${set.name}_elytra.json`,
        buildElytraAttachable({ identifier, texture: texturePaths.wings }),
      );
      ctx.report.approximated("armor", set.origin, `no item mapping matched ${material} elytra — standalone attachable emitted`);
    }
    for (const def of matches) {
      ctx.bedrock.writeJson(
        `attachables/geyser_custom/armor/${safeName(def.bedrock_identifier!)}.json`,
        buildElytraAttachable({ identifier: def.bedrock_identifier!, texture: texturePaths.wings }),
      );
      def.components = {
        ...def.components,
        "minecraft:equippable": { slot: "chest" },
      };
      matchedAny = true;
    }
  }

  if (matchedAny) {
    ctx.report.converted("armor", set.origin, outputs);
  }
}

function findDefinitions(
  ctx: ConversionContext,
  match: (identifierName: string, textureIds: string[]) => boolean,
): GeyserItemDefinition[] {
  const out: GeyserItemDefinition[] = [];
  for (const defs of Object.values(ctx.geyserMappings.items)) {
    for (const def of defs) {
      const id = def.bedrock_identifier;
      if (id === undefined) continue;
      const textures = (ctx.definitionTextures.get(def) ?? []).map((t) => t.toLowerCase());
      if (match(id.toLowerCase(), textures)) out.push(def);
    }
  }
  return out;
}
