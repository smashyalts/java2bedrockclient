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
  URL.revokeObjectURL(url);
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
        <p style={{ color: "var(--muted)", fontSize: 13, marginBottom: 0 }}>
          Geyser setup: put the <code>.mcpack</code> in Geyser's <code>packs/</code> folder
          {result.geyserMappings !== undefined && (
            <> and the mapping json files in <code>custom_mappings/</code></>
          )}
          , then restart.
          {result.geyserBlockMappings !== undefined && (
            <> Custom blocks also need <code>enable-custom-content: true</code> in Geyser's config.</>
          )}
          {result.displayEntityMappings !== undefined && (
            <>
              {" "}Furniture needs the{" "}
              <a
                href="https://github.com/GeyserExtensionists/GeyserDisplayEntity"
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--accent)" }}
              >
                GeyserDisplayEntity
              </a>{" "}
              extension: drop its jar in Geyser's <code>extensions/</code> folder and put the
              furniture mappings yml in <code>extensions/geyserdisplayentity/Mappings/</code>.
            </>
          )}
        </p>
      </div>

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
