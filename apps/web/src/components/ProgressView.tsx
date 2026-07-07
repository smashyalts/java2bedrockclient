export function ProgressView({
  stage,
  done,
  total,
  fileName,
}: {
  stage: string;
  done: number;
  total: number;
  fileName: string;
}) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div
      style={{
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: 16,
        padding: 32,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Converting {fileName}…</div>
      <div style={{ color: "var(--muted)", marginBottom: 16 }}>
        Stage: {stage} ({done}/{total})
      </div>
      <div style={{ background: "var(--bg)", borderRadius: 6, height: 10, overflow: "hidden" }}>
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: "var(--accent)",
            transition: "width 0.1s ease",
          }}
        />
      </div>
    </div>
  );
}
