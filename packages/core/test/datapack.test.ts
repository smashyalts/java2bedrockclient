import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { parseOraxenConfigZip } from "../src/index.js";

function datapackZip(files: Record<string, string>): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    tree[path] = new TextEncoder().encode(content);
  }
  return zipSync(tree);
}

describe("datapack parsing", () => {
  it("binds an item model to the host item named by a loot table entry", () => {
    const hints = parseOraxenConfigZip(
      datapackZip({
        "pack.mcmeta": `{"pack":{"pack_format":88,"description":""}}`,
        "data/demo/loot_table/block/altar.json": JSON.stringify({
          pools: [
            {
              rolls: 1,
              entries: [
                {
                  type: "minecraft:item",
                  name: "minecraft:chiseled_quartz_block",
                  functions: [
                    {
                      function: "minecraft:set_components",
                      components: {
                        "minecraft:item_model": "demo:altar",
                        "minecraft:item_name": { translate: "block.demo.altar", fallback: "Altar" },
                        "minecraft:dyed_color": 0xff8040,
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      }),
    );

    expect(hints.baseItems["altar"]).toBe("minecraft:chiseled_quartz_block");
    expect(hints.displayNames["altar"]).toBe("Altar");
    expect(hints.colors["altar"]).toBe(0xff8040);
  });

  it("reads the bare and namespaced component spellings, which packs mix freely", () => {
    const hints = parseOraxenConfigZip(
      datapackZip({
        "data/demo/recipe/wand.json": JSON.stringify({
          type: "minecraft:crafting_shaped",
          result: { id: "minecraft:stick", components: { item_model: "demo:wand" } },
        }),
      }),
    );
    expect(hints.baseItems["wand"]).toBe("minecraft:stick");
  });

  it("prefers a loot table's host item over an advancement icon's stand-in", () => {
    // An icon is decoration and may use any item; a loot table is what the
    // player is actually handed. Order the files so the icon is read first.
    const hints = parseOraxenConfigZip(
      datapackZip({
        "data/demo/advancement/a.json": JSON.stringify({
          display: { icon: { id: "minecraft:book", components: { item_model: "demo:tome" } } },
        }),
        "data/demo/loot_table/z.json": JSON.stringify({
          pools: [
            {
              entries: [
                {
                  type: "minecraft:item",
                  name: "minecraft:enchanted_book",
                  functions: [
                    { function: "minecraft:set_components", components: { "minecraft:item_model": "demo:tome" } },
                  ],
                },
              ],
            },
          ],
        }),
      }),
    );
    expect(hints.baseItems["tome"]).toBe("minecraft:enchanted_book");
  });

  it("follows a loot table reference so variants layered on a base table resolve", () => {
    const hints = parseOraxenConfigZip(
      datapackZip({
        "data/demo/loot_table/food/candy/base.json": JSON.stringify({
          pools: [{ entries: [{ type: "minecraft:item", name: "minecraft:poisonous_potato" }] }],
        }),
        "data/demo/loot_table/food/candy/black.json": JSON.stringify({
          pools: [
            {
              entries: [
                {
                  type: "minecraft:loot_table",
                  value: "demo:food/candy/base",
                  functions: [
                    { function: "minecraft:set_components", components: { "minecraft:item_model": "demo:candy/black" } },
                  ],
                },
              ],
            },
          ],
        }),
      }),
    );
    // Registered by full path, and by the leaf the pipeline may look up instead.
    expect(hints.baseItems["candy/black"]).toBe("minecraft:poisonous_potato");
    expect(hints.baseItems["black"]).toBe("minecraft:poisonous_potato");
  });

  it("does not alias a leaf name two folders disagree on", () => {
    const hints = parseOraxenConfigZip(
      datapackZip({
        "data/demo/loot_table/a.json": JSON.stringify({
          pools: [
            {
              entries: [
                {
                  type: "minecraft:item",
                  name: "minecraft:stone",
                  functions: [
                    { function: "minecraft:set_components", components: { item_model: "demo:one/dup" } },
                  ],
                },
              ],
            },
          ],
        }),
        "data/demo/loot_table/b.json": JSON.stringify({
          pools: [
            {
              entries: [
                {
                  type: "minecraft:item",
                  name: "minecraft:dirt",
                  functions: [
                    { function: "minecraft:set_components", components: { item_model: "demo:two/dup" } },
                  ],
                },
              ],
            },
          ],
        }),
      }),
    );
    expect(hints.baseItems["one/dup"]).toBe("minecraft:stone");
    expect(hints.baseItems["two/dup"]).toBe("minecraft:dirt");
    expect(hints.baseItems["dup"]).toBeUndefined();
  });

  it("binds from a function's give and inline-SNBT commands, but not from a retarget", () => {
    const hints = parseOraxenConfigZip(
      datapackZip({
        "data/demo/function/give.mcfunction":
          `give @s minecraft:iron_sword[minecraft:item_model="demo:knife"]\n`,
        "data/demo/function/summon.mcfunction":
          `summon item_display ~ ~ ~ {item: {id: "minecraft:cobblestone", count: 1, ` +
          `components: {"minecraft:item_model": "demo:bottle"}}}\n`,
        // Retargeting an existing entity never says what the item is; binding
        // this to an id from an earlier line would be a guess.
        "data/demo/function/retarget.mcfunction":
          `give @s minecraft:diamond[minecraft:item_model="demo:gem"]\n` +
          `data modify entity @s item.components."minecraft:item_model" set value "demo:basin"\n`,
      }),
    );
    expect(hints.baseItems["knife"]).toBe("minecraft:iron_sword");
    expect(hints.baseItems["bottle"]).toBe("minecraft:cobblestone");
    expect(hints.baseItems["gem"]).toBe("minecraft:diamond");
    expect(hints.baseItems["basin"]).toBeUndefined();
  });

  it("ignores macro placeholders, which name no concrete model", () => {
    const hints = parseOraxenConfigZip(
      datapackZip({
        "data/demo/function/particle.mcfunction":
          `$data merge entity @s {item:{id:"minecraft:paper",count:1,` +
          `components:{"minecraft:item_model":'$(model)'}}}\n`,
      }),
    );
    expect(Object.keys(hints.baseItems)).toHaveLength(0);
  });

  it("reads equippable and both dyed_color spellings, and skips a bare translate key", () => {
    const hints = parseOraxenConfigZip(
      datapackZip({
        "data/demo/loot_table/armor.json": JSON.stringify({
          pools: [
            {
              entries: [
                {
                  type: "minecraft:item",
                  name: "minecraft:leather_boots",
                  functions: [
                    {
                      function: "minecraft:set_components",
                      components: {
                        "minecraft:item_model": "demo:boots",
                        // No fallback: a translate key is an id, not a name.
                        "minecraft:item_name": { translate: "item.demo.boots" },
                        "minecraft:dyed_color": { rgb: 0x102030 },
                        "minecraft:equippable": { slot: "feet", asset_id: "demo:champion" },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      }),
    );
    expect(hints.baseItems["boots"]).toBe("minecraft:leather_boots");
    expect(hints.displayNames["boots"]).toBeUndefined();
    expect(hints.colors["boots"]).toBe(0x102030);
    expect(hints.equippables["boots"]).toEqual({ asset: "champion", slot: "feet" });
  });

  it("finds data inside version overlay directories", () => {
    const hints = parseOraxenConfigZip(
      datapackZip({
        "overlay_26_1/data/demo/loot_table/x.json": JSON.stringify({
          pools: [
            {
              entries: [
                {
                  type: "minecraft:item",
                  name: "minecraft:apple",
                  functions: [
                    { function: "minecraft:set_components", components: { item_model: "demo:snack" } },
                  ],
                },
              ],
            },
          ],
        }),
      }),
    );
    expect(hints.baseItems["snack"]).toBe("minecraft:apple");
  });

  it("never overrides a hint a plugin config already supplied", () => {
    // A plugin YAML names the material outright; a datapack binding is inferred,
    // so the explicit one must win regardless of which zip is read first.
    const hints = parseOraxenConfigZip(
      datapackZip({
        "data/demo/loot_table/x.json": JSON.stringify({
          pools: [
            {
              entries: [
                {
                  type: "minecraft:item",
                  name: "minecraft:air",
                  functions: [
                    { function: "minecraft:set_components", components: { item_model: "demo:thing" } },
                  ],
                },
              ],
            },
          ],
        }),
      }),
    );
    // `air` is the "no item" placeholder and must never become a host.
    expect(hints.baseItems["thing"]).toBeUndefined();
  });
  it("reads the pre-1.21 plural directory names too", () => {
    // Datapack folders were pluralised before 1.21, and overlays inside modern
    // packs often still are. Missing the alias left lootItems empty, so every
    // reference-based variant went unbound.
    const hints = parseOraxenConfigZip(
      datapackZip({
        "data/demo/loot_tables/food/base.json": JSON.stringify({
          pools: [{ entries: [{ type: "minecraft:item", name: "minecraft:poisonous_potato" }] }],
        }),
        "data/demo/loot_tables/food/black.json": JSON.stringify({
          pools: [
            {
              entries: [
                {
                  type: "minecraft:loot_table",
                  value: "demo:food/base",
                  functions: [
                    { function: "minecraft:set_components", components: { item_model: "demo:candy/black" } },
                  ],
                },
              ],
            },
          ],
        }),
      }),
    );
    expect(hints.baseItems["candy/black"]).toBe("minecraft:poisonous_potato");
  });

  it("still reads plugin YAML from a zip that also contains a datapack", () => {
    // A zipped `plugins/` folder legitimately holds both. Returning early after
    // the datapack scan dropped every YAML-derived hint for that upload.
    const hints = parseOraxenConfigZip(
      datapackZip({
        "data/demo/loot_table/x.json": JSON.stringify({
          pools: [
            {
              entries: [
                {
                  type: "minecraft:item",
                  name: "minecraft:apple",
                  functions: [
                    { function: "minecraft:set_components", components: { item_model: "demo:snack" } },
                  ],
                },
              ],
            },
          ],
        }),
        "plugins/Nexo/items/weapons.yml": `
ruby_sword:
  material: DIAMOND_SWORD
  displayname: "Ruby Sword"
`,
      }),
    );
    expect(hints.baseItems["snack"]).toBe("minecraft:apple");
    expect(hints.baseItems["ruby_sword"]).toBe("minecraft:diamond_sword");
    expect(hints.displayNames["ruby_sword"]).toBe("Ruby Sword");
  });
});
