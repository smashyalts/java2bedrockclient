import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { mergeJavaPacks } from "../src/index.js";

function packZip(files: Record<string, string>): Uint8Array {
  const tree: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    tree[path] = new TextEncoder().encode(content);
  }
  return zipSync(tree);
}

function readJson(bytes: Uint8Array | undefined): unknown {
  return JSON.parse(new TextDecoder().decode(bytes!));
}

describe("merging Java resource packs", () => {
  it("unions plain assets from every pack", () => {
    const result = mergeJavaPacks([
      { name: "a", bytes: packZip({ "assets/a/textures/one.png": "1" }) },
      { name: "b", bytes: packZip({ "assets/b/textures/two.png": "2" }) },
    ]);
    expect(result.vfs.has("assets/a/textures/one.png")).toBe(true);
    expect(result.vfs.has("assets/b/textures/two.png")).toBe(true);
    expect(result.conflicts).toHaveLength(0);
  });

  it("gives a contested path to the first pack and reports the loss", () => {
    const result = mergeJavaPacks([
      { name: "top", bytes: packZip({ "assets/x/textures/t.png": "winner" }) },
      { name: "middle", bytes: packZip({ "assets/x/textures/t.png": "loser" }) },
      { name: "bottom", bytes: packZip({ "assets/x/textures/t.png": "also-loser" }) },
    ]);
    expect(new TextDecoder().decode(result.vfs.read("assets/x/textures/t.png"))).toBe("winner");
    expect(result.conflicts).toEqual([
      { path: "assets/x/textures/t.png", kept: "top", overridden: ["middle", "bottom"] },
    ]);
  });

  it("does not call a byte-identical duplicate a conflict", () => {
    // Two packs built on the same upstream asset is normal, not a collision.
    const same = "identical";
    const result = mergeJavaPacks([
      { name: "a", bytes: packZip({ "assets/x/textures/t.png": same }) },
      { name: "b", bytes: packZip({ "assets/x/textures/t.png": same }) },
    ]);
    expect(result.conflicts).toHaveLength(0);
  });

  it("deep merges sounds.json instead of letting one pack silence the other", () => {
    const result = mergeJavaPacks([
      {
        name: "a",
        bytes: packZip({
          "assets/minecraft/sounds.json": JSON.stringify({ "a.hit": { sounds: ["a/hit"] } }),
        }),
      },
      {
        name: "b",
        bytes: packZip({
          "assets/minecraft/sounds.json": JSON.stringify({ "b.step": { sounds: ["b/step"] } }),
        }),
      },
    ]);
    expect(readJson(result.vfs.read("assets/minecraft/sounds.json"))).toEqual({
      "a.hit": { sounds: ["a/hit"] },
      "b.step": { sounds: ["b/step"] },
    });
    expect(result.mergedFiles).toContainEqual({
      path: "assets/minecraft/sounds.json",
      sources: 2,
      shadowedKeys: [],
    });
    // A merged file is not a conflict — nothing was lost.
    expect(result.conflicts).toHaveLength(0);
  });

  it("concatenates atlas sources and font providers", () => {
    const result = mergeJavaPacks([
      {
        name: "a",
        bytes: packZip({
          "assets/minecraft/atlases/blocks.json": JSON.stringify({ sources: [{ type: "directory", source: "a" }] }),
          "assets/minecraft/font/default.json": JSON.stringify({ providers: [{ type: "bitmap", file: "a.png" }] }),
        }),
      },
      {
        name: "b",
        bytes: packZip({
          "assets/minecraft/atlases/blocks.json": JSON.stringify({ sources: [{ type: "directory", source: "b" }] }),
          "assets/minecraft/font/default.json": JSON.stringify({ providers: [{ type: "bitmap", file: "b.png" }] }),
        }),
      },
    ]);
    expect(readJson(result.vfs.read("assets/minecraft/atlases/blocks.json"))).toEqual({
      sources: [
        { type: "directory", source: "a" },
        { type: "directory", source: "b" },
      ],
    });
    expect(readJson(result.vfs.read("assets/minecraft/font/default.json"))).toEqual({
      providers: [
        { type: "bitmap", file: "a.png" },
        { type: "bitmap", file: "b.png" },
      ],
    });
  });

  it("does not stitch or draw a shared entry twice", () => {
    const shared = JSON.stringify({ sources: [{ type: "directory", source: "shared" }] });
    const result = mergeJavaPacks([
      { name: "a", bytes: packZip({ "assets/minecraft/atlases/blocks.json": shared }) },
      { name: "b", bytes: packZip({ "assets/minecraft/atlases/blocks.json": shared }) },
    ]);
    expect(readJson(result.vfs.read("assets/minecraft/atlases/blocks.json"))).toEqual({
      sources: [{ type: "directory", source: "shared" }],
    });
  });

  it("widens pack.mcmeta to the range every pack supported and unions overlays", () => {
    const result = mergeJavaPacks([
      {
        name: "a",
        bytes: packZip({
          "pack.mcmeta": JSON.stringify({
            pack: { pack_format: 46, min_format: 46, max_format: 60, description: "A" },
            overlays: { entries: [{ directory: "overlay_a", formats: [46, 60] }] },
          }),
        }),
      },
      {
        name: "b",
        bytes: packZip({
          "pack.mcmeta": JSON.stringify({
            pack: { pack_format: 88, min_format: 75, max_format: 88, description: "B" },
            overlays: { entries: [{ directory: "overlay_b", formats: [75, 88] }] },
          }),
        }),
      },
    ]);
    const meta = readJson(result.vfs.read("pack.mcmeta")) as {
      pack: Record<string, unknown>;
      overlays: { entries: { directory: string }[] };
    };
    expect(meta.pack["pack_format"]).toBe(88);
    expect(meta.pack["min_format"]).toBe(46);
    expect(meta.pack["max_format"]).toBe(88);
    // supported_formats must agree with the widened range or clients on the
    // newly-covered versions reject the pack.
    expect(meta.pack["supported_formats"]).toEqual([46, 88]);
    // First pack's description survives, so the merged pack keeps its identity.
    expect(meta.pack["description"]).toBe("A");
    expect(meta.overlays.entries.map((e) => e.directory)).toEqual(["overlay_a", "overlay_b"]);
  });

  it("merges lang files key-wise, first pack winning a shared key", () => {
    const result = mergeJavaPacks([
      { name: "a", bytes: packZip({ "assets/minecraft/lang/en_us.json": JSON.stringify({ shared: "from-a", only_a: "a" }) }) },
      { name: "b", bytes: packZip({ "assets/minecraft/lang/en_us.json": JSON.stringify({ shared: "from-b", only_b: "b" }) }) },
    ]);
    expect(readJson(result.vfs.read("assets/minecraft/lang/en_us.json"))).toEqual({
      shared: "from-a",
      only_a: "a",
      only_b: "b",
    });
  });

  it("passes a single pack through byte-for-byte, additive files included", () => {
    // Not merely "no conflicts": a lone pack must not be round-tripped through
    // the JSON parser at all. parseLenientJson recovers what it can from a
    // malformed file, and writing that recovery back would silently drop
    // whatever it could not parse before any stage read it.
    const mcmeta = `{"pack":{"pack_format":88},  "language": {"x": {}}}`;
    const sounds = `{"a.hit":{"sounds":["a/hit"]}}`;
    const result = mergeJavaPacks([
      {
        name: "solo",
        bytes: packZip({
          "assets/x/textures/t.png": "x",
          "pack.mcmeta": mcmeta,
          "assets/minecraft/sounds.json": sounds,
        }),
      },
    ]);
    expect(result.packs).toHaveLength(1);
    expect(result.conflicts).toHaveLength(0);
    expect(result.mergedFiles).toHaveLength(0);
    expect(result.vfs.readText("pack.mcmeta")).toBe(mcmeta);
    expect(result.vfs.readText("assets/minecraft/sounds.json")).toBe(sounds);
  });

  it("keeps going when one pack is not a readable archive", () => {
    const result = mergeJavaPacks([
      { name: "good", bytes: packZip({ "assets/x/textures/t.png": "x" }) },
      { name: "broken", bytes: new Uint8Array([1, 2, 3, 4]) },
    ]);
    expect(result.vfs.has("assets/x/textures/t.png")).toBe(true);
    expect(result.unreadable.map((u) => u.pack)).toContain("broken");
  });
  it("normalises each pack's own nested root so folder-zipped packs still merge", () => {
    // Zipping the containing folder is the single most common packaging mistake.
    // JavaPack.open resolves ONE root, so without per-pack normalisation every
    // file under the second pack's folder is invisible downstream — no conflict,
    // no error, just a pack that contributed nothing.
    const result = mergeJavaPacks([
      { name: "flat", bytes: packZip({ "pack.mcmeta": `{"pack":{"pack_format":88}}`, "assets/a/textures/one.png": "1" }) },
      { name: "nested", bytes: packZip({ "Furniture/pack.mcmeta": `{"pack":{"pack_format":88}}`, "Furniture/assets/b/textures/two.png": "2" }) },
    ]);
    expect(result.vfs.has("assets/a/textures/one.png")).toBe(true);
    expect(result.vfs.has("assets/b/textures/two.png")).toBe(true);
    expect(result.vfs.has("Furniture/assets/b/textures/two.png")).toBe(false);
  });

  it("keeps the higher-priority copy when an additive file will not parse", () => {
    // The unparseable file cannot be merged, so the path falls back to
    // single-owner rules. Previously the lower-priority pack's parsed copy was
    // written last and silently won — priority inversion with nothing reported.
    const broken = `{"a.hit": {"sounds": [`;
    const result = mergeJavaPacks([
      { name: "top", bytes: packZip({ "assets/minecraft/sounds.json": broken }) },
      { name: "bottom", bytes: packZip({ "assets/minecraft/sounds.json": JSON.stringify({ "b.step": {} }) }) },
    ]);
    expect(result.vfs.readText("assets/minecraft/sounds.json")).toBe(broken);
    expect(result.conflicts).toEqual([
      { path: "assets/minecraft/sounds.json", kept: "top", overridden: ["bottom"] },
    ]);
  });

  it("reports keys a later pack also defined instead of claiming a lossless merge", () => {
    const result = mergeJavaPacks([
      { name: "a", bytes: packZip({ "assets/minecraft/lang/en_us.json": JSON.stringify({ shared: "from-a" }) }) },
      { name: "b", bytes: packZip({ "assets/minecraft/lang/en_us.json": JSON.stringify({ shared: "from-b", only_b: "b" }) }) },
    ]);
    expect(result.mergedFiles).toEqual([
      { path: "assets/minecraft/lang/en_us.json", sources: 2, shadowedKeys: ["shared"] },
    ]);
  });

  it("never narrows a declared supported_formats range", () => {
    // Recomputing the range from pack_format alone would hand back [15,15] and
    // lock out every client between 16 and 34 that pack A explicitly supported.
    const result = mergeJavaPacks([
      { name: "a", bytes: packZip({ "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15, supported_formats: [15, 34] }, language: { en_us: {} }, filter: { block: [] } }) }) },
      { name: "b", bytes: packZip({ "pack.mcmeta": JSON.stringify({ pack: { pack_format: 15 } }) }) },
    ]);
    const meta = readJson(result.vfs.read("pack.mcmeta")) as Record<string, Record<string, unknown>>;
    expect(meta["pack"]!["supported_formats"]).toEqual([15, 34]);
    // Sections other than pack/overlays must survive the rebuild.
    expect(meta["language"]).toEqual({ en_us: {} });
    expect(meta["filter"]).toEqual({ block: [] });
  });

  it("reports an archive it could not open at all", () => {
    const result = mergeJavaPacks([
      { name: "good", bytes: packZip({ "assets/x/textures/t.png": "x" }) },
      { name: "broken", bytes: new Uint8Array([1, 2, 3, 4]) },
    ]);
    expect(result.vfs.has("assets/x/textures/t.png")).toBe(true);
    expect(result.failedPacks).toEqual(["broken"]);
  });
});
