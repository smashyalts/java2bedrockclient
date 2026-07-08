# GeyserConverter

Java Edition → Bedrock Edition resource pack converter with a web UI. Upload a Java `.zip` pack in your browser and get back:

- **`<pack>.mcpack`** — a Bedrock resource pack
- **`geyser_mappings.json`** — Geyser Custom Item API **v2** mappings
- **`conversion_report.json`** — per-asset status: converted / approximated / skipped, with reasons

Everything runs client-side (Web Worker) — files never leave your PC. Static-hostable.

## What it converts

| Feature | Status |
| --- | --- |
| Vanilla texture retextures (blocks/items/entity/armor/environment) | ✅ rename table + parity-name passthrough |
| Legacy custom items (`custom_model_data` overrides, 1.14+) | ✅ v2 `legacy` mappings |
| Modern item definitions (`assets/<ns>/items/*.json`, 1.21.4+) | ✅ v2 `definition` mappings incl. condition/range_dispatch/select predicates |
| 2D sprites (generated/handheld, multi-layer) | ✅ composited icons + `item_texture.json` |
| 3D models | ✅ geometry + texture atlas + attachable + display-transform animations |
| Custom armor (modern `equipment/` assets + legacy layer textures) | ✅ armor attachables on vanilla armor geometry, equippable components |
| Elytra wings layers | ✅ elytra attachable |
| Animated textures (`.png.mcmeta` flipbooks) | ✅ blocks via `flipbook_textures.json`; item icons cropped to first frame (Bedrock limit) |
| Custom sounds (`sounds.json` + ogg) | ✅ `sound_definitions.json` |
| Languages | ✅ `texts/*.lang` |
| Bitmap fonts (PUA glyphs) | ✅ `font/glyph_XX.png` sheets |
| Paintings | ✅ stitched `kz.png` atlas |
| Core shaders, custom GUI, TTF fonts, `builtin/entity` items | ❌ reported as skipped (no Bedrock equivalent) |

## Usage

```bash
pnpm install
pnpm dev        # web UI on http://localhost:5173
pnpm test       # core conversion tests
pnpm build      # production build (apps/web/dist — deployable to any static host)
```

Server setup: drop the `.mcpack` into Geyser's `packs/` folder and `geyser_mappings.json` into `custom_mappings/`, then restart.

## Repo layout

- `packages/core` — conversion engine (environment-agnostic TypeScript; usable from Node or browser)
  - `src/java` — Java pack parsing (models, item definitions, mcmeta)
  - `src/resolve` — model parent-chain resolution and variant flattening
  - `src/bedrock` — Bedrock emitters (geometry, attachables, animations, armor, manifest)
  - `src/convert` — pipeline stages
  - `src/data` — Java→Bedrock vanilla texture rename tables
- `apps/web` — Vite + React UI, conversion in a Web Worker

## Credits & attribution

This converter stands on the shoulders of the projects and documentation below. Thank you to all of them:

- **[java2bedrock.sh](https://github.com/Kas-tle/java2bedrock.sh)** by Kas-tle — the Java→Bedrock element/cube coordinate math, attachable bone structure (`geysercmd` chain), and per-slot display-transform constants follow the conventions this project established and proved in the wild.
- **[GeyserMC](https://geysermc.org/)** — the whole reason this converter can exist: the [Custom Items API v2](https://geysermc.org/wiki/geyser/custom-items/) and [Custom Blocks](https://geysermc.org/wiki/geyser/custom-blocks/) mapping formats this tool emits, plus their wiki documentation.
- **[GeyserMC Rainbow](https://github.com/GeyserMC/Rainbow)** — inspiration for the overall approach and the target output format (Bedrock pack + Geyser mappings).
- **[GeyserMC PackConverter](https://github.com/GeyserMC/PackConverter)** and **[ConvertJavaTextureToBedrock](https://github.com/ModifiedCommand/ConvertJavaTextureToBedrock)** — prior art for the vanilla Java→Bedrock texture path mappings.
- **[wiki.bedrock.dev](https://wiki.bedrock.dev/)** — Bedrock render controllers (texture arrays powering the flipbook animation technique), attachables, glyph/emoji sheet documentation.
- **[Oraxen](https://github.com/oraxen/oraxen)**, **[Nexo](https://docs.nexomc.com/)**, **[ItemsAdder](https://itemsadder.devs.beer/)** — config formats parsed for base-item and display-name hints.
- Libraries: [fflate](https://github.com/101arrowz/fflate), [fast-png](https://github.com/image-js/fast-png), [UPNG.js](https://github.com/photopea/UPNG.js), [js-yaml](https://github.com/nodeca/js-yaml), [jsonc-parser](https://github.com/microsoft/node-jsonc-parser), [@noble/hashes](https://github.com/paulmillr/noble-hashes), [React](https://react.dev/), [Vite](https://vitejs.dev/), [comlink](https://github.com/GoogleChromeLabs/comlink).

## License

[GPL-3.0](LICENSE). Free software: use, study, share, improve — derivatives stay free.

## Notes

- Modern item-model assets don't declare their host item in the pack (servers apply them via the `minecraft:item_model` component). Those map under a configurable fallback base item (default `minecraft:paper`) — see Advanced options.
- 3D icon fallback: a model texture is used as inventory icon. Provide a `sprites.json` at pack root (`{"<model id>": "<texture id>"}`) to override.
- Coordinate/animation math follows [java2bedrock.sh](https://github.com/Kas-tle/java2bedrock.sh) conventions; mappings follow the [Geyser custom items v2 format](https://geysermc.org/wiki/geyser/custom-items/).
