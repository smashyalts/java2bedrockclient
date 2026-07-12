/**
 * GeyserConverter HTTP API — self-hostable, no GUI.
 *
 *   POST /convert
 *     Content-Type: application/zip           → body is the Java pack zip
 *     Content-Type: multipart/form-data       → fields:
 *         pack    (file, required)  Java resource pack zip
 *         config  (file, optional)  Oraxen/Nexo/ItemsAdder config zip
 *     Query params (both modes):
 *         packName, attachableMaterial, modernBaseItem, maxAnimationFrames
 *
 *   Response: application/zip containing
 *     <packName>.mcpack, geyser_mappings.json, geyser_blocks.json, report.json
 *
 *   GET /healthz → 200 "ok"
 */
import http from "node:http";
import { URL } from "node:url";
import Busboy from "busboy";
import { zipSync } from "fflate";
import { convertPack, parseOraxenConfigZips, type ConvertOptions } from "@geyser-converter/core";

const PORT = Number(process.env.PORT ?? 3000);
/** Reject uploads larger than this (default 512 MB). */
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_BYTES ?? 512 * 1024 * 1024);

const USAGE = `GeyserConverter API
POST /convert with the Java pack zip (application/zip body, or multipart fields "pack" + optional "config").
Query params: packName, attachableMaterial, modernBaseItem, maxAnimationFrames.
Returns a zip: <packName>.mcpack + geyser_mappings.json + geyser_blocks.json + report.json
`;

async function handleConvert(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const contentType = req.headers["content-type"] ?? "";

  let packBytes: Uint8Array | undefined;
  let configZips: Uint8Array[] = [];

  if (contentType.startsWith("multipart/form-data")) {
    ({ packBytes, configZips } = await readMultipart(req));
  } else {
    packBytes = await readBody(req);
  }
  if (packBytes === undefined || packBytes.length === 0) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end('missing pack zip (raw body or multipart field "pack")');
    return;
  }

  const packName = url.searchParams.get("packName") ?? "converted_pack";
  const options: Partial<ConvertOptions> = { packName };
  const material = url.searchParams.get("attachableMaterial");
  if (material) options.attachableMaterial = material;
  const baseItem = url.searchParams.get("modernBaseItem");
  if (baseItem) options.modernBaseItem = baseItem;
  const maxFrames = url.searchParams.get("maxAnimationFrames");
  if (maxFrames) options.maxAnimationFrames = Number(maxFrames);
  if (configZips.length > 0) {
    const hints = parseOraxenConfigZips(configZips);
    options.baseItemHints = hints.baseItems;
    options.displayNameHints = hints.displayNames;
    options.equippableHints = hints.equippables;
    options.cmdItemKeys = hints.cmdKeys;
    options.colorHints = hints.colors;
    options.backpackItems = hints.backpacks;
    options.furnitureItems = hints.furniture;
  }

  const result = await convertPack(packBytes, options);

  const bundle: Record<string, Uint8Array> = {
    [`${packName}.mcpack`]: result.mcpack,
    "report.json": new TextEncoder().encode(JSON.stringify(result.report, null, 2)),
  };
  if (result.geyserMappings) bundle["geyser_mappings.json"] = new TextEncoder().encode(result.geyserMappings);
  if (result.geyserBlockMappings) bundle["geyser_blocks.json"] = new TextEncoder().encode(result.geyserBlockMappings);
  if (result.displayEntityMappings) bundle["geyser_displayentity_mappings.yml"] = new TextEncoder().encode(result.displayEntityMappings);

  const out = zipSync(bundle, { level: 0 });
  res.writeHead(200, {
    "content-type": "application/zip",
    "content-disposition": `attachment; filename="${packName}_bedrock.zip"`,
    "content-length": out.length,
  });
  res.end(Buffer.from(out));
}

function readBody(req: http.IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_UPLOAD) {
        reject(new Error("upload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

function readMultipart(
  req: http.IncomingMessage,
): Promise<{ packBytes?: Uint8Array; configZips: Uint8Array[] }> {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD } });
    const out: { packBytes?: Uint8Array; configZips: Uint8Array[] } = { configZips: [] };
    bb.on("file", (field, stream) => {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        const bytes = new Uint8Array(Buffer.concat(chunks));
        if (field === "pack") out.packBytes = bytes;
        // Repeatable: -F config=@nexo.zip -F config=@hmcc.zip
        else if (field === "config") out.configZips.push(bytes);
      });
    });
    bb.on("finish", () => resolve(out));
    bb.on("error", reject);
    req.pipe(bb);
  });
}

const server = http.createServer((req, res) => {
  // CORS: allow browser tools to call the API too.
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET" && (req.url === "/" || req.url === "/healthz")) {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(req.url === "/healthz" ? "ok" : USAGE);
    return;
  }
  if (req.method === "POST" && req.url?.startsWith("/convert")) {
    handleConvert(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(`conversion failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end(USAGE);
});

server.listen(PORT, () => {
  console.log(`GeyserConverter API listening on http://localhost:${PORT}`);
});
