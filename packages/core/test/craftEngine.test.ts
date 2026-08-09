import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { parseOraxenConfigZip, parseOraxenConfigZips } from "../src/index.js";

function configZip(files: Record<string, string>): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    tree[path] = new TextEncoder().encode(content);
  }
  return zipSync(tree);
}

describe("CraftEngine config parsing", () => {
  it("reads material, name, colour, cmd and model aliases from an items section", () => {
    const hints = parseOraxenConfigZip(
      configZip({
        "resources/demo/configuration/items.yml": `
items:
  default:ruby_sword:
    material: golden_sword
    custom_model_data: 10001
    item_model: default:weapons/ruby_sword
    data:
      item_name: "<!i><#FF8C00>Ruby Sword"
      dyed_color: 255,128,64
`,
      }),
    );

    // The item id, the item_model path, and its last segment all resolve — the
    // pipeline looks furniture/name hints up by whichever of the three it has.
    for (const key of ["ruby_sword", "weapons/ruby_sword"]) {
      expect(hints.baseItems[key]).toBe("minecraft:golden_sword");
      expect(hints.displayNames[key]).toBe("Ruby Sword");
      expect(hints.colors[key]).toBe(0xff8040);
    }
    expect(hints.cmdKeys["minecraft:golden_sword|10001"]).toBe("ruby_sword");
    expect(hints.items).toBe(1);
  });

  it("flags the item a furniture variant displays, not just the item that places it", () => {
    const hints = parseOraxenConfigZip(
      configZip({
        "configuration/bench.yml": `
items:
  default:bench:
    material: paper
    behavior:
      type: furniture_item
      furniture: default:bench
  default:bench_model:
    material: paper
    item_model: default:bench_model
furniture:
  default:bench:
    settings:
      item: default:bench
    variants:
      ground:
        elements:
          - item: default:bench_model
            display_transform: none
            scale: 1.5,1.5,1.5
`,
      }),
    );

    // The display entity holds bench_model — that is the model Bedrock renders.
    expect(hints.furniture).toContain("bench_model");
    expect(hints.furniture).toContain("bench");
    expect(hints.furnitureTransforms["bench_model"]).toEqual({ none: true, scale: 1.5 });
  });

  it("resolves an inline furniture definition and a cross-file element reference", () => {
    const hints = parseOraxenConfigZips([
      configZip({
        "configuration/chair.yaml": `
items:
  default:chair:
    material: paper
    behavior:
      type: furniture_item
      furniture:
        settings:
          item: default:chair
        variants:
          ground:
            elements:
              - item: default:chair_display
`,
      }),
      // A separate zip, parsed after the furniture that references it.
      configZip({
        "configuration/models.yml": `
items:
  default:chair_display:
    material: paper
    item_model: default:furniture/chair
`,
      }),
    ]);

    // The element's own aliases get flagged too, so the model file resolves.
    expect(hints.furniture).toEqual(expect.arrayContaining(["chair_display", "furniture/chair", "chair"]));
  });

  it("reads equippable from data and from settings.equipment", () => {
    const hints = parseOraxenConfigZip(
      configZip({
        "configuration/armor.yml": `
items:
  default:topaz_helmet:
    material: diamond_helmet
    data:
      equippable:
        slot: head
        asset_id: minecraft:topaz
  default:topaz_boots:
    material: diamond_boots
    settings:
      equipment:
        asset_id: default:topaz
        slot: feet
`,
      }),
    );

    expect(hints.equippables["topaz_helmet"]).toEqual({ asset: "topaz", slot: "head" });
    expect(hints.equippables["topaz_boots"]).toEqual({ asset: "topaz", slot: "feet" });
  });

  it("leaves ItemsAdder documents to the ItemsAdder parser", () => {
    // Both plugins use an `items:` section; only CraftEngine namespaces its keys.
    const hints = parseOraxenConfigZip(
      configZip({
        "contents/myitems/configs/items.yml": `
info:
  namespace: myitems
items:
  ruby_sword:
    display_name: "&cRuby Sword"
    resource:
      material: DIAMOND_SWORD
      model_path: item/ruby_sword
`,
      }),
    );

    expect(hints.baseItems["ruby_sword"]).toBe("minecraft:diamond_sword");
    expect(hints.displayNames["ruby_sword"]).toBe("Ruby Sword");
  });
});
