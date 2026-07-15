import type { ConversionContext, PipelineStage } from "../context.js";
import { parseLenientJson } from "../../java/json.js";

/**
 * Converts Java lang JSON files into Bedrock .lang files.
 * Java locale codes are lowercase (en_us); Bedrock uses xx_XX.
 * Custom translation keys pass through 1:1 (Geyser sends them verbatim);
 * vanilla key renames are not attempted.
 */
export const langStage: PipelineStage = {
  name: "lang",
  run(ctx: ConversionContext): void {
    // locale → merged key/value map (across namespaces).
    const locales = new Map<string, Map<string, string>>();

    for (const ns of ctx.java.namespaces()) {
      const prefix = `assets/${ns}/lang/`;
      for (const path of ctx.java.list({ prefix, suffix: ".json" })) {
        const code = path.slice(prefix.length, -".json".length);
        const entries = parseLenientJson<Record<string, string>>(ctx.java.readText(path) ?? "");
        if (entries === undefined) {
          ctx.report.error("lang", path, "could not parse lang file");
          continue;
        }
        const bedrockCode = toBedrockLocale(code);
        const map = locales.get(bedrockCode) ?? new Map<string, string>();
        for (const [key, value] of Object.entries(entries)) {
          if (typeof value === "string") map.set(key, value);
        }
        locales.set(bedrockCode, map);
        ctx.report.converted("lang", path, [`texts/${bedrockCode}.lang`]);
      }
    }

    if (locales.size === 0) return;

    for (const [code, entries] of locales) {
      const lines: string[] = [];
      for (const [key, value] of entries) {
        // Java positional args (%1$s, %2$d, %3$f, …) → Bedrock's %1 / %2 syntax;
        // .lang format: key=value, newlines escaped.
        const converted = value.replace(/%(\d+)\$[sdefgxXcboh]/g, "%$1").replace(/\r?\n/g, "%1");
        lines.push(`${key}=${converted}`);
      }
      ctx.bedrock.writeText(`texts/${code}.lang`, lines.join("\n") + "\n");
    }
    ctx.bedrock.writeJson("texts/languages.json", [...locales.keys()].sort());
  },
};

function toBedrockLocale(code: string): string {
  const parts = code.toLowerCase().split("_");
  if (parts.length === 2) return `${parts[0]}_${parts[1]!.toUpperCase()}`;
  return code;
}
