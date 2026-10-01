import { PNG } from "pngjs"; import fs from "fs";
const r = process.argv[2];
const meta = JSON.parse(fs.readFileSync(`public/data/${r}/terrain.json`));
const p = PNG.sync.read(fs.readFileSync(`public/data/${r}/terrain.png`));
const hist = {}; let max = 0, at = null, n = 0;
for (let i = 0; i < p.width * p.height; i++) {
  if (p.data[i*4+2] === 0) continue; n++;
  const e = p.data[i*4]*256 + p.data[i*4+1];
  const b = Math.floor(e / 250) * 250; hist[b] = (hist[b] || 0) + 1;
  if (e > max) { max = e; at = [i % p.width, Math.floor(i / p.width)]; }
}
console.log(r, "land px", n, "max", max, "at px", at, "world", at && [meta.minX + at[0]*meta.pxKm, meta.minZ + at[1]*meta.pxKm]);
console.log(Object.entries(hist).map(([k,v]) => `${k}:${v}`).join(" "));
