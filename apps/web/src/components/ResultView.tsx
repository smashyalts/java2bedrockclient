import { useMemo, useState } from "react";
import type { ConvertResult } from "@geyser-converter/core";
import { buttonStyle } from "../App.js";

function download(name: string, data: Uint8Array | string, mime: string) {
  const blob =
    typeof data === "string"
      ? new Blob([data], { type: mime })
      : new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const STATUS_META: Record<string, { icon: string; color: string }> = {
  converted: { icon: "✅", color: "var(--accent)" },
  approximated: { icon: "⚠️", color: "var(--warn)" },
  skipped: { icon: "⏭️", color: "var(--muted)" },
  error: { icon: "❌", color: "var(--err)" },
};

export function ResultView({
  result,
  packName,
  onReset,
}: {
  result: ConvertResult;
  packName: string;
  onReset: () => void;
}) {
  const [filter, setFilter] = useState<string>("all");
  const { summary, entries } = result.report;

  const visible = useMemo(
    () => (filter === "all" ? entries : entries.filter((e) => e.status === filter)),
    [entries, filter],
  );

  return (
    <div>
      <div
        style={{
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          padding: 24,
          marginBottom: 20,
        }}
      >
        <h2 style={{ marginTop: 0 }}>Conversion complete</h2>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button
            style={buttonStyle}
            onClick={() => download(`${packName}.mcpack`, result.mcpack, "application/zip")}
          >
            ⬇ {packName}.mcpack
          </button>
          {result.geyserMappings !== undefined && (
            <button
              style={{ ...buttonStyle, background: "var(--panel)", color: "var(--accent)", border: "1px solid var(--accent)" }}
              onClick={() => download("geyser_mappings.json", result.geyserMappings!, "application/json")}
            >
              ⬇ geyser_mappings.json
            </button>
          )}
          {result.geyserBlockMappings !== undefined && (
            <button
              style={{ ...buttonStyle, background: "var(--panel)", color: "var(--accent)", border: "1px solid var(--accent)" }}
              onClick={() => download("geyser_blocks.json", result.geyserBlockMappings!, "application/json")}
            >
              ⬇ geyser_blocks.json
            </button>
          )}
          {result.displayEntityMappings !== undefined && (
            <button
              style={{ ...buttonStyle, background: "var(--panel)", color: "var(--accent)", border: "1px solid var(--accent)" }}
              onClick={() => download("geyser_displayentity_mappings.yml", result.displayEntityMappings!, "text/yaml")}
            >
              ⬇ furniture mappings.yml
            </button>
          )}
          {result.displayEntityConfig !== undefined && (
            <button
              style={{ ...buttonStyle, background: "var(--panel)", color: "var(--warn)", border: "1px solid var(--warn)" }}
              onClick={() => download("geyserdisplayentity_config.yml", result.displayEntityConfig!, "text/yaml")}
            >
              ⬇ furniture config.yml (seats furniture)
            </button>
          )}
          {result.modelEngineInput !== undefined && (
            <button
              style={{ ...buttonStyle, background: "var(--panel)", color: "var(--accent)", border: "1px solid var(--accent)" }}
              onClick={() => download("modelengine_input.zip", result.modelEngineInput!, "application/zip")}
            >
              ⬇ ModelEngine models (input.zip)
            </button>
          )}
          <button
            style={{ ...buttonStyle, background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)" }}
            onClick={() =>
              download("conversion_report.json", JSON.stringify(result.report, null, 2), "application/json")
            }
          >
            ⬇ report.json
          </button>
          <button
            style={{ ...buttonStyle, background: "transparent", color: "var(--muted)", border: "1px solid var(--border)" }}
            onClick={onReset}
          >
            Convert another
          </button>
        </div>
      </div>

      <RequiredPlugins result={result} />

      <SetupGuide result={result} />

      <ConfigNudgeBanner entries={result.report.entries} onReset={onReset} />

      <PerfPanel timings={result.timings} />

      <div
        style={{
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          padding: 24,
        }}
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          {(["all", "converted", "approximated", "skipped", "error"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              style={{
                background: filter === s ? "var(--accent-dim)" : "transparent",
                color: filter === s ? "var(--accent)" : "var(--muted)",
                border: `1px solid ${filter === s ? "var(--accent)" : "var(--border)"}`,
                borderRadius: 20,
                padding: "4px 14px",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {s === "all"
                ? `all (${entries.length})`
                : `${STATUS_META[s]?.icon ?? ""} ${s} (${summary[s]})`}
            </button>
          ))}
        </div>
        <div style={{ maxHeight: 420, overflowY: "auto", fontSize: 13 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--muted)" }}>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Stage</th>
                <th style={thStyle}>Source</th>
                <th style={thStyle}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {visible.slice(0, 2000).map((e, i) => (
                <tr key={i} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ ...tdStyle, color: STATUS_META[e.status]?.color }}>
                    {STATUS_META[e.status]?.icon} {e.status}
                  </td>
                  <td style={tdStyle}>{e.stage}</td>
                  <td style={{ ...tdStyle, wordBreak: "break-all" }}>{e.source}</td>
                  <td style={{ ...tdStyle, color: "var(--muted)" }}>
                    {e.detail ?? (e.outputs && e.outputs.length > 0 ? e.outputs.join("; ") : "")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length > 2000 && (
            <p style={{ color: "var(--muted)" }}>…and {visible.length - 2000} more (see report.json)</p>
          )}
        </div>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = { padding: "6px 10px", position: "sticky", top: 0, background: "var(--panel)" };
const tdStyle: React.CSSProperties = { padding: "6px 10px", verticalAlign: "top" };

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** Collapsible performance breakdown: per-stage durations + hot-op costs. */
function PerfPanel({ timings }: { timings: ConvertResult["timings"] }) {
  const [open, setOpen] = useState(false);
  const stages = [...timings.stages].filter((s) => s.ms > 0).sort((a, b) => b.ms - a.ms);
  const total = timings.totalMs;
  return (
    <div
      style={{
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        padding: open ? 24 : "14px 24px",
        marginBottom: 20,
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ background: "transparent", color: "var(--muted)", border: "none", cursor: "pointer", fontSize: 14, padding: 0 }}
      >
        {open ? "▾" : "▸"} Performance — {fmtMs(total)} total
      </button>
      {open && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginTop: 16, fontSize: 13 }}>
          <div>
            <div style={{ color: "var(--muted)", marginBottom: 8 }}>By stage</div>
            {stages.map((s) => (
              <PerfBar key={s.name} label={s.name} ms={s.ms} total={total} />
            ))}
          </div>
          <div>
            <div style={{ color: "var(--muted)", marginBottom: 8 }}>Hot operations</div>
            {timings.ops.slice(0, 8).map((o) => (
              <PerfBar key={o.category} label={`${o.category} (${o.count}×)`} ms={o.totalMs} total={total} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PerfBar({ label, ms, total }: { label: string; ms: number; total: number }) {
  const pct = total > 0 ? Math.round((ms / total) * 100) : 0;
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span style={{ wordBreak: "break-all" }}>{label}</span>
        <span style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{fmtMs(ms)} · {pct}%</span>
      </div>
      <div style={{ height: 4, background: "var(--bg)", borderRadius: 2, marginTop: 2 }}>
        <div style={{ height: 4, width: `${pct}%`, background: "var(--accent)", borderRadius: 2 }} />
      </div>
    </div>
  );
}

/** The Geyser plugins/extensions needed to actually use the converted output,
 * shown conditionally on what the conversion produced. */
function RequiredPlugins({ result }: { result: ConvertResult }) {
  const plugins: { name: string; url: string; note: string }[] = [
    { name: "Geyser", url: "https://geysermc.org/download?project=geyser", note: "lets Bedrock players join; loads the .mcpack + mappings" },
    { name: "Floodgate", url: "https://geysermc.org/download?project=floodgate", note: "Bedrock auth (no Java account needed)" },
  ];
  if (result.displayEntityMappings !== undefined) {
    plugins.push({
      name: "GeyserDisplayEntity",
      url: "https://github.com/GeyserExtensionists/GeyserDisplayEntity",
      note: "renders furniture / placed display-entity items on Bedrock",
    });
  }
  if (result.modelEngineInput !== undefined) {
    plugins.push(
      {
        name: "GeyserModelEngine (extension + Spigot plugin)",
        url: "https://github.com/GeyserExtensionists/GeyserModelEngine",
        note: "renders ModelEngine / MythicMobs mob models on Bedrock (generates the pack from input.zip)",
      },
      {
        name: "GeyserUtils",
        url: "https://github.com/GeyserExtensionists/GeyserUtils",
        note: "required by GeyserModelEngine to call Bedrock-side features",
      },
    );
  }

  return (
    <div
      style={{
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: 12,
        padding: 16,
        marginTop: 16,
      }}
    >
      <strong style={{ fontSize: 14 }}>Required plugins &amp; extensions</strong>
      <p style={{ color: "var(--muted)", fontSize: 12, margin: "4px 0 10px" }}>
        Install these on your server so Bedrock players see the converted content.
      </p>
      <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
        {plugins.map((p) => (
          <li key={p.name} style={{ fontSize: 13 }}>
            <a
              href={p.url}
              target="_blank"
              rel="noreferrer"
              style={{ color: "var(--accent)", fontWeight: 600 }}
            >
              {p.name}
            </a>
            <span style={{ color: "var(--muted)" }}> — {p.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Step-by-step install guide for the converted output, per artifact type. */
function SetupGuide({ result }: { result: ConvertResult }) {
  const code = (t: string) => <code style={{ background: "var(--bg)", padding: "1px 4px", borderRadius: 4 }}>{t}</code>;
  const sections: { title: string; steps: React.ReactNode[] }[] = [];

  // 1. Base pack — always.
  const baseSteps: React.ReactNode[] = [
    <>Install <b>Geyser</b> and <b>Floodgate</b> on your server (or proxy).</>,
    <>Drop the <b>.mcpack</b> into Geyser's {code("packs/")} folder.</>,
  ];
  if (result.geyserMappings !== undefined || result.geyserBlockMappings !== undefined) {
    baseSteps.push(
      <>Put the mapping json ({[result.geyserMappings && "geyser_mappings.json", result.geyserBlockMappings && "geyser_blocks.json"].filter(Boolean).join(", ")}) into Geyser's {code("custom_mappings/")} folder.</>,
    );
  }
  if (result.geyserBlockMappings !== undefined) {
    baseSteps.push(<>Set {code("enable-custom-content: true")} in Geyser's {code("config.yml")} (needed for custom blocks).</>);
  }
  baseSteps.push(<>Restart Geyser. Bedrock players now see the custom items/textures.</>);
  sections.push({ title: "1. Resource pack + Geyser", steps: baseSteps });

  // 2. Furniture.
  if (result.displayEntityMappings !== undefined) {
    const f: React.ReactNode[] = [
      <>Download the <b>GeyserDisplayEntity</b> extension jar and drop it in Geyser's {code("extensions/")} folder. Restart once so it creates its folders.</>,
      <>Put {code("geyser_displayentity_mappings.yml")} in {code("extensions/geyserdisplayentity/Mappings/")}.</>,
    ];
    if (result.displayEntityConfig !== undefined) {
      f.push(<>Put {code("geyserdisplayentity_config.yml")} in {code("extensions/geyserdisplayentity/")} (back up your own first). <b>Required</b> — its global y-offset/height seat furniture on the floor; without it pieces float ~1 block up.</>);
    }
    f.push(<>Restart Geyser. Furniture your Nexo/Oraxen/ItemsAdder/CraftEngine plugin places now renders for Bedrock.</>);
    sections.push({ title: "2. Furniture (GeyserDisplayEntity)", steps: f });
  }

  // 3. ModelEngine mobs.
  if (result.modelEngineInput !== undefined) {
    const n = result.displayEntityMappings !== undefined ? 3 : 2;
    sections.push({
      title: `${n}. ModelEngine / MythicMobs mobs (GeyserModelEngine)`,
      steps: [
        <>Server plugins: keep your <b>ModelEngine</b> + <b>MythicMobs</b>, and add <b>GeyserModelEngine</b> (Spigot) and <b>GeyserUtils</b> (spigot).</>,
        <>Geyser extensions: put <b>GeyserModelEngineExtension</b> and <b>geyserutils-geyser</b> in Geyser's {code("extensions/")} folder.</>,
        <>If you run a proxy (Velocity/Bungee), set {code("send-floodgate-data: true")} in Floodgate and copy {code("key.pem")} to the backend servers.</>,
        <>Start the server once so the extension creates its folders, then unzip {code("modelengine_input.zip")} into {code("extensions/geysermodelengineextension/input/")} (each model keeps its own subfolder — the zip is already laid out this way).</>,
        <>Reload Geyser (or restart). The extension generates the Bedrock pack from {code("input/")} and applies it automatically — no manual pack install.</>,
        <>Spawn a mob via MythicMobs/MCPets as usual; Bedrock players now see the model.</>,
      ],
    });
  }

  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, padding: 16, marginTop: 16 }}>
      <strong style={{ fontSize: 14 }}>Setup guide</strong>
      <div style={{ display: "grid", gap: 14, marginTop: 10 }}>
        {sections.map((s) => (
          <div key={s.title}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{s.title}</div>
            <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4, color: "var(--muted)", fontSize: 13 }}>
              {s.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConfigNudgeBanner({
  entries,
  onReset,
}: {
  entries: ConvertResult["report"]["entries"];
  onReset: () => void;
}) {
  const nudge = entries.find((e) => e.stage === "config-nudge");
  if (nudge === undefined) return null;
  return (
    <div
      style={{
        background: "var(--panel)",
        border: "1px solid var(--warn)",
        borderRadius: 16,
        padding: 20,
        marginBottom: 20,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <strong style={{ color: "var(--warn)", fontSize: 14 }}>
        Items may not map correctly — upload a plugin config zip
      </strong>
      <p style={{ color: "var(--muted)", margin: 0, fontSize: 13 }}>
        {nudge.detail}
      </p>
      <button
        onClick={onReset}
        style={{
          ...buttonStyle,
          background: "var(--warn)",
          alignSelf: "flex-start",
          fontSize: 13,
          padding: "6px 16px",
        }}
      >
        Convert again with config
      </button>
    </div>
  );
}
