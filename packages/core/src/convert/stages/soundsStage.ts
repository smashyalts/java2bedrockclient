import type { ConversionContext, PipelineStage } from "../context.js";
import { parseResourceLocation } from "../../java/javaPack.js";

interface JavaSoundEvent {
  category?: string;
  subtitle?: string;
  replace?: boolean;
  sounds?: (string | { name: string; volume?: number; pitch?: number; stream?: boolean })[];
}

/**
 * Converts sounds.json → sound_definitions.json and copies .ogg files.
 * Sound event identifiers keep their Java namespace, so server-side
 * playsound commands pass through Geyser unchanged.
 */
export const soundsStage: PipelineStage = {
  name: "sounds",
  run(ctx: ConversionContext): void {
    const definitions: Record<string, object> = {};

    for (const ns of ctx.java.namespaces()) {
      // Copy sound files.
      const soundPrefix = `assets/${ns}/sounds/`;
      for (const path of ctx.java.list({ prefix: soundPrefix, suffix: ".ogg" })) {
        const rel = path.slice(soundPrefix.length);
        const out = `sounds/${ns}/${rel}`;
        const data = ctx.java.read(path);
        if (data !== undefined) {
          ctx.bedrock.write(out, data);
          ctx.report.converted("sounds", path, [out]);
        }
      }

      const soundsJson = ctx.java.readJson<Record<string, JavaSoundEvent>>(`assets/${ns}/sounds.json`);
      if (soundsJson === undefined) continue;

      for (const [event, def] of Object.entries(soundsJson)) {
        const eventId = ns === "minecraft" ? event : `${ns}:${event}`;
        const sounds = (def.sounds ?? []).map((s) => {
          const entry = typeof s === "string" ? { name: s } : s;
          const loc = parseResourceLocation(entry.name, ns);
          if (!ctx.java.has(`assets/${loc.namespace}/sounds/${loc.path}.ogg`)) {
            ctx.report.approximated(
              "sounds",
              `assets/${ns}/sounds.json → ${eventId}`,
              `references ${loc.namespace}:${loc.path} which is not in the pack (vanilla Java sound?) — will be silent on Bedrock`,
            );
          }
          return {
            name: `sounds/${loc.namespace}/${loc.path}`,
            ...(entry.volume !== undefined ? { volume: entry.volume } : {}),
            ...(entry.pitch !== undefined ? { pitch: entry.pitch } : {}),
            ...(entry.stream !== undefined ? { stream: entry.stream } : {}),
          };
        });
        if (sounds.length === 0) continue;
        definitions[eventId] = {
          category: mapCategory(def.category),
          sounds,
        };
      }
      ctx.report.converted("sounds", `assets/${ns}/sounds.json`, ["sounds/sound_definitions.json"]);
    }

    if (Object.keys(definitions).length > 0) {
      ctx.bedrock.writeJson("sounds/sound_definitions.json", {
        format_version: "1.14.0",
        sound_definitions: definitions,
      });
    }
  },
};

function mapCategory(category: string | undefined): string {
  switch (category) {
    case "master": return "master";
    case "music": return "music";
    case "record": return "record";
    case "weather": return "weather";
    case "hostile": return "hostile";
    case "neutral": return "neutral";
    case "player": return "player";
    case "block": return "block";
    case "ambient": return "ambient";
    case "voice": return "ui"; // closest Bedrock category
    default: return "neutral";
  }
}
