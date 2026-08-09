import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { encode } from "fast-png";
import { convertPack } from "../src/index.js";
import { readZipDetailed } from "../src/io/zip.js";
import { fitPathName, MAX_PACK_PATH } from "../src/util/packPath.js";

function png(): Uint8Array {
  const data = new Uint8Array(16 * 16 * 4).fill(200);
  return new Uint8Array(encode({ width: 16, height: 16, data, channels: 4 }));
}

/** A 2-frame animation strip, so the model needs a flipbook render controller. */
function animatedPng(): Uint8Array {
  const data = new Uint8Array(16 * 32 * 4);
  for (let i = 0; i < data.length; i++) data[i] = i < data.length / 2 ? 30 : 220;
  return new Uint8Array(encode({ width: 16, height: 32, data, channels: 4 }));
}

function cube(texture: string): string {
  return JSON.stringify({
    textures: { "0": texture },
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: Object.fromEntries(
          ["up", "down", "north", "south", "east", "west"].map((f) => [f, { texture: "#0" }]),
        ),
      },
    ],
    display: { thirdperson_righthand: { translation: [0, 2, 0] } },
  });
}

describe("fitPathName", () => {
  it("leaves names that already fit untouched", () => {
    expect(fitPathName("minecraft_item_ruby_sword", 40)).toBe("minecraft_item_ruby_sword");
  });

  it("shortens to the budget and keeps names with a shared prefix distinct", () => {
    const reserved = 57;
    const a = fitPathName("nexo_0c702f35_4d5e_4593_b3c8_8efed2ddd7a7", reserved);
    const b = fitPathName("nexo_0c702f35_4d5e_4593_b3c8_8efed2ddd7a8", reserved);
    expect(a.length).toBeLessThanOrEqual(MAX_PACK_PATH - reserved);
    // Truncation alone would collapse these two into the same name.
    expect(a).not.toBe(b);
    // Same input twice → same output, so references stay consistent.
    expect(fitPathName("nexo_0c702f35_4d5e_4593_b3c8_8efed2ddd7a7", reserved)).toBe(a);
  });
});

describe("generated pack paths", () => {
  it("stays under the Bedrock path limit for UUID-obfuscated model ids", () => {
    // Nexo replaces every model id with a UUID; those alone are longer than the
    // folder and suffix around them leave room for.
    const uuids = [
      "0c702f35-4d5e-4593-b3c8-8efed2ddd7a7",
      "16d0e201-f291-425d-a18a-d4cbe9ae876e",
      "2e949c47-4d52-45e1-ba4d-0814fd0d75f1",
    ];
    const files: Record<string, Uint8Array> = {
      "pack.mcmeta": new TextEncoder().encode(JSON.stringify({ pack: { pack_format: 46 } })),
    };
    for (const [i, uuid] of uuids.entries()) {
      // The third model is animated, so it also emits a render controller —
      // the longest path template in the pipeline.
      const animated = i === 2;
      files[`assets/nexo/textures/${uuid}.png`] = animated ? animatedPng() : png();
      if (animated) {
        files[`assets/nexo/textures/${uuid}.png.mcmeta`] = new TextEncoder().encode(
          JSON.stringify({ animation: { frametime: 2 } }),
        );
      }
      files[`assets/nexo/models/${uuid}.json`] = new TextEncoder().encode(cube(`nexo:${uuid}`));
      // A furniture-style item definition whose own path is long too.
      files[`assets/nexo/items/${uuid}.json`] = new TextEncoder().encode(
        JSON.stringify({ model: { type: "model", model: `nexo:${uuid}` } }),
      );
    }

    return convertPack(zipSync(files), { packName: "p", optimizePack: false }).then((result) => {
      const { vfs } = readZipDetailed(result.mcpack);
      const paths = vfs.list();
      expect(paths.length).toBeGreaterThan(5);
      const tooLong = paths.filter((p) => p.length > MAX_PACK_PATH);
      expect(tooLong).toEqual([]);
      // The render controller only exists if the animated model was converted —
      // otherwise this test would pass by not exercising the longest template.
      expect(paths.some((p) => p.startsWith("render_controllers/"))).toBe(true);
    });
  });
});
