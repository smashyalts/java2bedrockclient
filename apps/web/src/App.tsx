import { useCallback, useRef, useState } from "react";
import { wrap, proxy, transfer, type Remote } from "comlink";
import type { ConvertResult } from "@geyser-converter/core";
import type { WorkerApi } from "./worker/convert.worker.js";
import { DropZone } from "./components/DropZone.js";
import { ProgressView } from "./components/ProgressView.js";
import { ResultView } from "./components/ResultView.js";

type Phase =
  | { kind: "idle" }
  | { kind: "converting"; stage: string; done: number; total: number; fileName: string }
  | { kind: "done"; result: ConvertResult; fileName: string; packName: string }
  | { kind: "error"; message: string };

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [attachableMaterial, setAttachableMaterial] = useState("entity_alphatest_one_sided");
  const [modernBaseItem, setModernBaseItem] = useState("minecraft:paper");
  const [maxAnimationFrames, setMaxAnimationFrames] = useState(0);
  const [optimizePack, setOptimizePack] = useState(true);
  const [maxCompression, setMaxCompression] = useState(false);
  const [animate2dHeldItems, setAnimate2dHeldItems] = useState(false);
  const [oxipngLevel, setOxipngLevel] = useState(4);
  const [showOptions, setShowOptions] = useState(false);
  const [configZips, setConfigZips] = useState<{ name: string; bytes: Uint8Array }[]>([]);
  const workerRef = useRef<Remote<WorkerApi> | null>(null);

  const getWorker = useCallback((): Remote<WorkerApi> => {
    if (workerRef.current === null) {
      const worker = new Worker(new URL("./worker/convert.worker.ts", import.meta.url), {
        type: "module",
      });
      workerRef.current = wrap<WorkerApi>(worker);
    }
    return workerRef.current;
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      const packName = file.name.replace(/\.(zip|mcpack|tgz|tar\.gz)$/i, "");
      setPhase({ kind: "converting", stage: "reading file", done: 0, total: 1, fileName: file.name });
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const api = getWorker();
        const result = await api.convert(
          transfer(bytes, [bytes.buffer]),
          { packName, attachableMaterial, modernBaseItem, maxAnimationFrames, optimizePack, maxCompression, animate2dHeldItems },
          proxy((stage: string, done: number, total: number) => {
            setPhase({ kind: "converting", stage, done, total, fileName: file.name });
          }),
          configZips.map((c) => {
            // Copy once — configZips state may be reused on a later conversion,
            // and transfer() neuters the buffer we hand off.
            const copy = c.bytes.slice();
            return transfer(copy, [copy.buffer]);
          }),
          oxipngLevel,
        );
        setPhase({ kind: "done", result, fileName: file.name, packName });
      } catch (err) {
        setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    },
    [getWorker, attachableMaterial, modernBaseItem, maxAnimationFrames, optimizePack, maxCompression, animate2dHeldItems, oxipngLevel, configZips],
  );

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "40px 20px" }}>
      <header style={{ textAlign: "center", marginBottom: 32 }}>
        <h1 style={{ margin: 0, fontSize: 32 }}>
          Geyser<span style={{ color: "var(--accent)" }}>Converter</span>
        </h1>
        <p style={{ color: "var(--muted)", marginTop: 8 }}>
          Java Edition resource pack → Bedrock pack + Geyser mappings. Everything runs in your
          browser — files never leave your PC.
        </p>
      </header>

      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <a
          href="https://ko-fi.com/progamingdk"
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            background: "#ff5e5b",
            color: "#fff",
            fontWeight: 700,
            fontSize: 15,
            textDecoration: "none",
            padding: "10px 22px",
            borderRadius: 999,
            boxShadow: "0 2px 10px rgba(255,94,91,0.4)",
          }}
        >
          ☕ Support development on Ko-fi
        </a>
        <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 8 }}>
          Free & open source — donations help cover dev costs.
        </div>
      </div>

      {phase.kind === "idle" && (
        <>
          <DropZone onFile={handleFile} />

          {/* Compression controls — surfaced (not buried under Advanced) since size is what most people tune. */}
          <div
            style={{
              background: "var(--panel)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: 16,
              marginTop: 16,
              display: "grid",
              gap: 12,
            }}
          >
            <label style={{ ...labelStyle, display: "flex", flexDirection: "row", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={optimizePack}
                onChange={(e) => setOptimizePack(e.target.checked)}
              />
              Lossless pack optimization — minify JSON, merge duplicate + drop unused textures (never
              changes what players see)
            </label>
            <label style={{ ...labelStyle, display: "flex", flexDirection: "row", alignItems: "center", gap: 8 }}>
              <input
                type="checkbox"
                checked={animate2dHeldItems}
                onChange={(e) => setAnimate2dHeldItems(e.target.checked)}
              />
              Animate held 2D items — plays an animated sprite's frames while the item is held.
              Bedrock can't animate item icons, so the inventory picture stays on the first frame,
              and held items render as a flat card instead of Bedrock's extruded sprite.
            </label>
            {optimizePack && (
              <label style={{ ...labelStyle, display: "flex", flexDirection: "row", alignItems: "center", gap: 8 }}>
                <input
                  type="checkbox"
                  checked={maxCompression}
                  onChange={(e) => setMaxCompression(e.target.checked)}
                />
                Maximum compression — losslessly recompress large textures (oxipng) for ~12% more off
                them. Runs in a background thread; adds a minute or two on big packs.
              </label>
            )}
            {optimizePack && maxCompression && (
              <label style={{ ...labelStyle, paddingLeft: 24 }}>
                Compression effort — level {oxipngLevel}{" "}
                {oxipngLevel === 4 ? "(fastest)" : oxipngLevel === 6 ? "(smallest, slowest)" : "(balanced)"}
                <input
                  type="range"
                  min={4}
                  max={6}
                  step={1}
                  value={oxipngLevel}
                  onChange={(e) => setOxipngLevel(Number(e.target.value))}
                  style={{ width: "100%", maxWidth: 280 }}
                />
                <span style={{ fontSize: 12 }}>
                  Higher levels trade minutes for a few % more; the gain past 4 is usually small.
                </span>
              </label>
            )}
          </div>

          {/* Plugin config zips — always visible since they're critical for accuracy. */}
          <div
            style={{
              background: "var(--panel)",
              border: "1px solid var(--border)",
              borderRadius: 12,
              padding: 16,
              marginTop: 16,
              display: "grid",
              gap: 12,
            }}
          >
            <label style={labelStyle}>
              Plugin config zips (optional, multiple allowed) — Oraxen / Nexo / ItemsAdder items
              and HMCCosmetics cosmetics. Zip each plugin's config folder (e.g.{" "}
              <code>plugins/Nexo/items/</code>, <code>plugins/HMCCosmetics/cosmetics/</code>) —
              upload them together or as separate zips. Enables real base items, display names,
              armor sets, and back-cosmetic positioning.
              <input
                type="file"
                accept=".zip"
                multiple
                style={{ ...inputStyle, padding: 6 }}
                onChange={async (e) => {
                  const files = [...(e.target.files ?? [])];
                  const loaded = await Promise.all(
                    files.map(async (file) => ({
                      name: file.name,
                      bytes: new Uint8Array(await file.arrayBuffer()),
                    })),
                  );
                  setConfigZips(loaded);
                }}
              />
              {configZips.length > 0 && (
                <span style={{ color: "var(--accent)" }}>
                  ✓ {configZips.map((c) => c.name).join(", ")} loaded
                </span>
              )}
            </label>
          </div>

          <div style={{ marginTop: 16 }}>
            <button
              onClick={() => setShowOptions((v) => !v)}
              style={{
                background: "transparent",
                color: "var(--muted)",
                border: "none",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {showOptions ? "▾" : "▸"} Advanced options
            </button>
            {showOptions && (
              <div
                style={{
                  background: "var(--panel)",
                  border: "1px solid var(--border)",
                  borderRadius: 12,
                  padding: 16,
                  marginTop: 8,
                  display: "grid",
                  gap: 12,
                }}
              >
                <label style={labelStyle}>
                  Attachable material (3D items)
                  <select
                    value={attachableMaterial}
                    onChange={(e) => setAttachableMaterial(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="entity_alphatest_one_sided">entity_alphatest_one_sided (default)</option>
                    <option value="entity_alphatest">entity_alphatest</option>
                    <option value="entity">entity (opaque)</option>
                    <option value="entity_alphablend">entity_alphablend</option>
                  </select>
                </label>
                <label style={labelStyle}>
                  Fallback base item for modern item-model assets
                  <input
                    value={modernBaseItem}
                    onChange={(e) => setModernBaseItem(e.target.value)}
                    style={inputStyle}
                    placeholder="minecraft:paper"
                  />
                </label>
                <label style={labelStyle}>
                  Animation quality (max flipbook frames) — lower = smaller pack, faster downloads
                  <select
                    value={maxAnimationFrames}
                    onChange={(e) => setMaxAnimationFrames(Number(e.target.value))}
                    style={inputStyle}
                  >
                    <option value={0}>Full animation (default)</option>
                    <option value={20}>20 frames</option>
                    <option value={10}>10 frames (balanced)</option>
                    <option value={5}>5 frames (small pack)</option>
                    <option value={1}>1 frame (no animation, smallest)</option>
                  </select>
                </label>
              </div>
            )}
          </div>
        </>
      )}
      {phase.kind === "converting" && (
        <ProgressView stage={phase.stage} done={phase.done} total={phase.total} fileName={phase.fileName} />
      )}
      {phase.kind === "done" && (
        <ResultView
          result={phase.result}
          packName={phase.packName}
          onReset={() => setPhase({ kind: "idle" })}
        />
      )}
      {phase.kind === "error" && (
        <div
          style={{
            background: "var(--panel)",
            border: "1px solid var(--err)",
            borderRadius: 12,
            padding: 24,
          }}
        >
          <strong style={{ color: "var(--err)" }}>Conversion failed</strong>
          <p style={{ color: "var(--muted)" }}>{phase.message}</p>
          <button onClick={() => setPhase({ kind: "idle" })} style={buttonStyle}>
            Try again
          </button>
        </div>
      )}

      <footer
        style={{
          textAlign: "center",
          marginTop: 48,
          paddingTop: 24,
          borderTop: "1px solid var(--border)",
          color: "var(--muted)",
          fontSize: 13,
        }}
      >
        Free & open source. If it saved you time, you can{" "}
        <a
          href="https://ko-fi.com/progamingdk"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--accent)", fontWeight: 600 }}
        >
          support development on Ko-fi ☕
        </a>{" "}
        to help cover dev costs.
      </footer>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: "grid",
  gap: 4,
  fontSize: 13,
  color: "var(--muted)",
};

const inputStyle: React.CSSProperties = {
  background: "var(--bg)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "8px 10px",
  fontSize: 14,
};

export const buttonStyle: React.CSSProperties = {
  background: "var(--accent)",
  color: "#0f1115",
  border: "none",
  borderRadius: 8,
  padding: "10px 20px",
  fontSize: 15,
  fontWeight: 600,
  cursor: "pointer",
};
