import { describe, expect, it } from "vitest";
import { VirtualFs } from "../src/io/vfs.js";
import { JavaPack } from "../src/java/javaPack.js";
import { inferHostItemFromDefinition } from "../src/java/definitionHost.js";

function packWith(definition: unknown, id = "demo:thing"): JavaPack {
  const vfs = new VirtualFs();
  const [ns, path] = id.split(":") as [string, string];
  vfs.writeText(`assets/${ns}/items/${path}.json`, JSON.stringify(definition));
  return JavaPack.open(vfs);
}

describe("host item inferred from an item definition", () => {
  it("reads a property only one vanilla item has", () => {
    // Nothing but a crossbow has a charge_type, so a retextured crossbow
    // identifies itself even with no datapack or plugin config.
    const pack = packWith({
      model: {
        type: "minecraft:select",
        property: "minecraft:charge_type",
        cases: [{ when: "arrow", model: { type: "minecraft:model", model: "demo:item/x_arrow" } }],
        fallback: { type: "minecraft:model", model: "demo:item/x" },
      },
    });
    expect(inferHostItemFromDefinition(pack, "demo:thing")).toBe("minecraft:crossbow");
  });

  it("finds the property however deeply it is nested", () => {
    // This is the real shape of a retextured bow: vanilla dispatches on
    // `use_duration`, not the 1.20 predicate name `bow/pull`. `using_item` on
    // the outer condition is shared by five items and must not decide it.
    const pack = packWith({
      model: {
        type: "minecraft:condition",
        property: "minecraft:using_item",
        on_true: {
          type: "minecraft:range_dispatch",
          property: "minecraft:use_duration",
          entries: [{ threshold: 0.5, model: { type: "minecraft:model", model: "demo:item/pulling" } }],
        },
        on_false: { type: "minecraft:model", model: "demo:item/idle" },
      },
    });
    expect(inferHostItemFromDefinition(pack, "demo:thing")).toBe("minecraft:bow");
  });

  it("rejects legacy 1.20 predicate names and properties vanilla shares", () => {
    // Every one of these was in an earlier version of the table. `bow/pull` and
    // friends simply do not exist as item-definition properties, and `compass`
    // is used by both compass and recovery_compass — so guessing from it would
    // mis-host every retextured recovery compass.
    for (const property of [
      "minecraft:bow/pull",
      "minecraft:bow/pulling",
      "minecraft:crossbow/pulling",
      "minecraft:compass/angle",
      "minecraft:brushable",
      "minecraft:compass",
      "minecraft:bundle/has_selected_item",
      "minecraft:local_time",
    ]) {
      const pack = packWith({ model: { type: "minecraft:select", property, cases: [] } });
      expect(inferHostItemFromDefinition(pack, "demo:thing")).toBeUndefined();
    }
  });

  it("maps every property vanilla uses on exactly one item", () => {
    // Derived from the vanilla client's own item definitions; if a future
    // version reassigns one of these to a second item it must leave this table.
    const cases: [string, string][] = [
      ["minecraft:use_duration", "minecraft:bow"],
      ["minecraft:use_cycle", "minecraft:brush"],
      ["minecraft:time", "minecraft:clock"],
      ["minecraft:context_dimension", "minecraft:clock"],
      ["minecraft:crossbow/pull", "minecraft:crossbow"],
      ["minecraft:charge_type", "minecraft:crossbow"],
      ["minecraft:broken", "minecraft:elytra"],
      ["minecraft:fishing_rod/cast", "minecraft:fishing_rod"],
    ];
    for (const [property, host] of cases) {
      const pack = packWith({ model: { type: "minecraft:select", property, cases: [] } });
      expect(inferHostItemFromDefinition(pack, "demo:thing")).toBe(host);
    }
  });

  it("ignores properties shared by many items", () => {
    // custom_model_data, display_context, trim_material and using_item all
    // appear on dozens of items — guessing from them would be wrong more often
    // than right, so the generic fallback stays in charge.
    for (const property of [
      "minecraft:custom_model_data",
      "minecraft:display_context",
      "minecraft:trim_material",
      "minecraft:using_item",
      "minecraft:damage",
    ]) {
      const pack = packWith({ model: { type: "minecraft:select", property, cases: [] } });
      expect(inferHostItemFromDefinition(pack, "demo:thing")).toBeUndefined();
    }
  });

  it("falls back to a conditioned component when no property identifies the item", () => {
    const pack = packWith({
      model: {
        type: "minecraft:condition",
        component: "minecraft:lodestone_tracker",
        on_true: { type: "minecraft:model", model: "demo:item/active" },
        on_false: { type: "minecraft:model", model: "demo:item/idle" },
      },
    });
    expect(inferHostItemFromDefinition(pack, "demo:thing")).toBe("minecraft:compass");
  });

  it("accepts the un-namespaced spelling packs also use", () => {
    const pack = packWith({ model: { type: "minecraft:select", property: "charge_type", cases: [] } });
    expect(inferHostItemFromDefinition(pack, "demo:thing")).toBe("minecraft:crossbow");
  });

  it("returns nothing for a plain model or a missing definition", () => {
    const plain = packWith({ model: { type: "minecraft:model", model: "demo:item/x" } });
    expect(inferHostItemFromDefinition(plain, "demo:thing")).toBeUndefined();
    expect(inferHostItemFromDefinition(plain, "demo:absent")).toBeUndefined();
  });

  it("caches per item-model id", () => {
    const pack = packWith({ model: { type: "minecraft:select", property: "minecraft:charge_type", cases: [] } });
    const cache = new Map<string, string | undefined>();
    expect(inferHostItemFromDefinition(pack, "demo:thing", cache)).toBe("minecraft:crossbow");
    expect(cache.get("demo:thing")).toBe("minecraft:crossbow");
    // Second call is served from the cache even if the pack no longer has it.
    expect(inferHostItemFromDefinition(JavaPack.open(new VirtualFs()), "demo:thing", cache)).toBe(
      "minecraft:crossbow",
    );
  });
});
