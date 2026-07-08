// Dump zip structure diagnostics. Usage: tsx scripts/inspect-zip.mts <file.zip>
import fs from "node:fs";

const b = new Uint8Array(fs.readFileSync(process.argv[2]!));
const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
console.log("file size:", b.length);
console.log("first 4 bytes:", [...b.slice(0, 4)].map((x) => x.toString(16).padStart(2, "0")).join(" "));

const eocds: number[] = [];
for (let i = b.length - 22; i >= 0 && eocds.length < 5; i--) {
  if (v.getUint32(i, true) === 0x06054b50) eocds.push(i);
}
console.log("EOCD positions:", eocds);
for (const e of eocds) {
  console.log(
    `EOCD@${e} entries=${v.getUint16(e + 10, true)} cdirSize=${v.getUint32(e + 12, true)} cdirOffset=${v.getUint32(e + 16, true)} commentLen=${v.getUint16(e + 20, true)}`,
  );
}

let cd = 0, loc = 0, firstCd = -1, firstLoc = -1;
for (let i = 0; i < b.length - 4; i++) {
  const s = v.getUint32(i, true);
  if (s === 0x02014b50) { cd++; if (firstCd < 0) firstCd = i; }
  else if (s === 0x04034b50) { loc++; if (firstLoc < 0) firstLoc = i; }
}
console.log("central sigs:", cd, "first@", firstCd, "| local sigs:", loc, "first@", firstLoc);

for (let i = b.length - 4; i >= Math.max(0, b.length - 1024); i--) {
  if (v.getUint32(i, true) === 0x06064b50) console.log("ZIP64 EOCD @", i);
}

// Decode first few central directory entries at firstCd.
if (firstCd >= 0) {
  let ptr = firstCd;
  const dec = new TextDecoder();
  for (let i = 0; i < 8 && ptr + 46 <= b.length; i++) {
    if (v.getUint32(ptr, true) !== 0x02014b50) { console.log("chain break @", ptr); break; }
    const method = v.getUint16(ptr + 10, true);
    const csize = v.getUint32(ptr + 20, true);
    const usize = v.getUint32(ptr + 24, true);
    const nlen = v.getUint16(ptr + 28, true);
    const elen = v.getUint16(ptr + 30, true);
    const clen = v.getUint16(ptr + 32, true);
    const off = v.getUint32(ptr + 42, true);
    const name = dec.decode(b.subarray(ptr + 46, ptr + 46 + Math.min(nlen, 120)));
    console.log(`cd[${i}] method=${method} csize=${csize} usize=${usize} nlen=${nlen} off=${off} name=${JSON.stringify(name)}`);
    ptr += 46 + nlen + elen + clen;
  }
}
