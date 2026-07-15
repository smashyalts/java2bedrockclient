import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { encode } from "fast-png";
import { convertPack, readZip, encodePng, type PngEncoder, type RawImage } from "../src/index.js";

function png(rgba: [number, number, number, number]): Uint8Array {
  const data = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) data.set(rgba, i * 4);
  return new Uint8Array(encode({ width: 16, height: 16, data, channels: 4 }));
}

const cubeModel = (tex: string) => ({
  textures: { all: tex, particle: tex },
  elements: [
    {
      from: [4, 4, 4],
      to: [12, 12, 12],
      faces: {
        north: { uv: [0, 0, 8, 8], texture: "#all" },
        south: { uv: [0, 0, 8, 8], texture: "#all" },
        east: { uv: [0, 0, 8, 8], texture: "#all" },
        west: { uv: [0, 0, 8, 8], texture: "#all" },
        up: { uv: [0, 0, 8, 8], texture: "#all" },
        down: { uv: [0, 0, 8, 8], texture: "#all" },
      },
    },
  ],
  display: { thirdperson_righthand: { rotation: [0, 0, 0], translation: [0, 0, 0], scale: [1, 1, 1] } },
});

/** A pack with enough distinct 3D models to exceed the encode-pool threshold. */
function manyModelsZip(count: number): Uint8Array {
  const enc = new TextEncoder();
  const json = (v: unknown): Uint8Array => enc.encode(JSON.stringify(v));
  const files: Record<string, Uint8Array> = {
    "pack.mcmeta": json({ pack: { pack_format: 15 } }),
    "assets/minecraft/models/item/paper.json": json({
      parent: "minecraft:item/generated",
      textures: { layer0: "minecraft:item/paper" },
      overrides: Array.from({ length: count }, (_, i) => ({
        predicate: { custom_model_data: i + 1 },
        model: `custom:item/cube_${i}`,
      })),
    }),
  };
  for (let i = 0; i < count; i++) {
    files[`assets/custom/models/item/cube_${i}.json`] = json(cubeModel(`custom:item/tex_${i}`));
    // Distinct colour per model so every atlas encodes to different bytes.
    files[`assets/custom/textures/item/tex_${i}.png`] = png([i * 7, 40, 255 - i * 5, 255]);
  }
  return zipSync(files);
}

describe("parallel PNG encoder", () => {
  it("produces byte-identical output to the in-process path and is used above threshold", async () => {
    const zip = manyModelsZip(30);

    let calls = 0;
    let imagesEncoded = 0;
    // In-process encoder standing in for the worker pool — must be output-equivalent.
    const encoder: PngEncoder = {
      async encode(images: RawImage[]): Promise<Uint8Array[]> {
        calls++;
        imagesEncoded += images.length;
        return images.map((img) => encodePng(img));
      },
    };

    const sync = await convertPack(zip, { packName: "P" });
    const pooled = await convertPack(zip, { packName: "P", pngEncoder: encoder });

    // The encoder ran once for the whole batch, over the 30 atlases + 30 icons.
    expect(calls).toBe(1);
    expect(imagesEncoded).toBeGreaterThanOrEqual(30);

    // Deferring encodes to the pool must not change a single output byte.
    const a = readZip(sync.mcpack);
    const b = readZip(pooled.mcpack);
    const paths = a.list().sort();
    expect(b.list().sort()).toEqual(paths);
    for (const p of paths) {
      expect([...b.read(p)!]).toEqual([...a.read(p)!]);
    }
  });

  it("encodes in-process when no encoder is injected (node/CLI path)", async () => {
    const result = await convertPack(manyModelsZip(30), { packName: "Q" });
    const out = readZip(result.mcpack);
    expect(out.list({ prefix: "textures/geyser_custom/atlases/", suffix: ".png" }).length).toBeGreaterThan(0);
  });
});
