import { useCallback, useRef, useState } from "react";
import { wrap, proxy, type Remote } from "comlink";
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
  const [showOptions, setShowOptions] = useState(false);
  const [configZip, setConfigZip] = useState<{ name: string; bytes: Uint8Array } | null>(null);
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
      const packName = file.name.replace(/\.(zip|mcpack)$/i, "");
      setPhase({ kind: "converting", stage: "reading file", done: 0, total: 1, fileName: file.name });
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const api = getWorker();
        const result = await api.convert(
          bytes,
          { packName, attachableMaterial, modernBaseItem, maxAnimationFrames },
          proxy((stage: string, done: number, total: number) => {
            setPhase({ kind: "converting", stage, done, total, fileName: file.name });
          }),
          configZip?.bytes,
        );
        setPhase({ kind: "done", result, fileName: file.name, packName });
      } catch (err) {
        setPhase({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    },
    [getWorker, attachableMaterial, modernBaseItem, maxAnimationFrames, configZip],
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

      {phase.kind === "idle" && (
        <>
          <DropZone onFile={handleFile} />
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
                <label style={labelStyle}>
                  Oraxen / Nexo / ItemsAdder config zip (optional) — auto-detects each item's
                  real base item. Zip your <code>plugins/Oraxen/items/</code> or{" "}
                  <code>plugins/ItemsAdder/contents/</code> folder (whole plugin folder also works).
                  <input
                    type="file"
                    accept=".zip"
                    style={{ ...inputStyle, padding: 6 }}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) {
                        setConfigZip(null);
                        return;
                      }
                      setConfigZip({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
                    }}
                  />
                  {configZip && (
                    <span style={{ color: "var(--accent)" }}>
                      ✓ {configZip.name} loaded — items will map to their real base items
                    </span>
                  )}
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
