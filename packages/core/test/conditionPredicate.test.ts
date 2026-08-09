import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { encode } from "fast-png";
import { convertPack } from "../src/index.js";

function png(): Uint8Array {
  const data = new Uint8Array(16 * 16 * 4).fill(180);
  return new Uint8Array(encode({ width: 16, height: 16, data, channels: 4 }));
}

function sprite(texture: string): string {
  return JSON.stringify({ parent: "minecraft:item/generated", textures: { layer0: texture } });
}

/**
 * Nexo emits a `has_component` condition to swap between a dyeable and a plain
 * model. Geyser reads `component` with readOrThrow, so a predicate without it
 * aborts the whole mappings file at server start.
 */
function packWith(conditionNode: unknown): Uint8Array {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  return zipSync({
    "pack.mcmeta": enc(JSON.stringify({ pack: { pack_format: 46 } })),
    "assets/nexo/textures/dyed.png": png(),
    "assets/nexo/textures/plain.png": png(),
    "assets/nexo/models/dyed.json": enc(sprite("nexo:dyed")),
    "assets/nexo/models/plain.json": enc(sprite("nexo:plain")),
    "assets/nexo/items/coffee_table.json": enc(JSON.stringify({ model: conditionNode })),
  });
}

const BRANCHES = {
  on_true: { type: "model", model: "nexo:dyed" },
  on_false: { type: "model", model: "nexo:plain" },
};

describe("has_component condition predicates", () => {
  it("carries the tested component through to the Geyser predicate", async () => {
    const result = await convertPack(
      packWith({
        type: "condition",
        property: "has_component",
        component: "minecraft:dyed_color",
        ...BRANCHES,
      }),
      { packName: "p", optimizePack: false },
    );

    const mappings = JSON.parse(result.geyserMappings!) as {
      items: Record<string, { predicate?: { type: string; property: string; component?: string }[] }[]>;
    };
    const predicates = Object.values(mappings.items)
      .flat()
      .flatMap((d) => d.predicate ?? [])
      .filter((p) => p.type === "condition");

    expect(predicates.length).toBeGreaterThan(0);
    for (const p of predicates) {
      expect(p.property).toBe("has_component");
      // Geyser throws on the whole file if this is missing.
      expect(p.component).toBe("minecraft:dyed_color");
    }
  });

  it("drops the predicate entirely when the pack omits the component", async () => {
    const result = await convertPack(
      packWith({ type: "condition", property: "has_component", ...BRANCHES }),
      { packName: "p", optimizePack: false },
    );

    const mappings = JSON.parse(result.geyserMappings!) as {
      items: Record<string, { predicate?: { type: string }[] }[]>;
    };
    const conditions = Object.values(mappings.items)
      .flat()
      .flatMap((d) => d.predicate ?? [])
      .filter((p) => p.type === "condition");

    // An unloadable predicate is worse than none: the false branch ships alone.
    expect(conditions).toEqual([]);
    expect(result.report.entries.some((e) => e.detail?.includes('no "component" to test'))).toBe(true);
  });
});
