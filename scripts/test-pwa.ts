import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

async function main() {
const root = process.cwd();
const manifest = JSON.parse(await readFile(path.join(root, "public", "manifest.webmanifest"), "utf8")) as {
  id: string;
  start_url: string;
  scope: string;
  display: string;
  icons: Array<{ src: string; sizes: string; type: string }>;
  share_target?: { action: string; method: string; params: Record<string, string> };
};
assert.equal(manifest.id, "/");
assert.equal(manifest.start_url, "/");
assert.equal(manifest.scope, "/");
assert.equal(manifest.display, "standalone");
assert.deepEqual(manifest.share_target, { action: "/", method: "GET", params: { title: "title", text: "text", url: "url" } });
for (const size of ["192", "512"]) {
  const icon = manifest.icons.find((candidate) => candidate.sizes === size + "x" + size && candidate.type === "image/png");
  assert.ok(icon, "Missing " + size + "px PNG icon");
  const png = await readFile(path.join(root, "public", icon.src));
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [Number(size), Number(size)]);
}

const worker = await readFile(path.join(root, "public", "sw.js"), "utf8");
assert.match(worker, /sockdrawer-shell-v5/);
assert.match(worker, /pathname\.startsWith\("\/api\/"\)/);
const icon = await readFile(path.join(root, "public", "icon.svg"), "utf8");
assert.match(icon, /class="eye"/);
const app = await readFile(path.join(root, "src", "components", "memory-app.tsx"), "utf8");
assert.match(app, /Label for recall \(optional\)/);
assert.match(app, /memory\.title \|\| extracted\.title/);
const proxy = await readFile(path.join(root, "src", "proxy.ts"), "utf8");
for (const directive of ["default-src 'self'", "'strict-dynamic'", "object-src 'none'", "frame-ancestors 'none'"]) assert.match(proxy, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { dependencies: Record<string, string>; scripts: Record<string, string> };
assert.equal(packageJson.dependencies.pg, undefined);
assert.equal(packageJson.dependencies.zod, undefined);
assert.equal(packageJson.scripts["sites:build"], "vinext build");
for (const removed of ["Dockerfile", "docker-compose.yml", path.join("db", "migrations", "001_initial.sql"), path.join("extension", "manifest.json"), path.join("src", "worker", "index.ts")]) {
  await assert.rejects(access(path.join(root, removed)));
}

console.log("PWA validation tests passed");
}

void main();
