import { execSync } from "node:child_process";
import { readFileSync, rmSync, mkdirSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "src");
const distDir = join(here, "dist");

const manifest = JSON.parse(readFileSync(join(srcDir, "manifest.json"), "utf8"));
const version = manifest.version;

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const common = {
  bundle: true,
  minify: true,
  sourcemap: true,
  target: ["chrome120"],
  logLevel: "info",
};

// Service worker — declared as `"type": "module"` in manifest.
await esbuild.build({
  ...common,
  entryPoints: [join(srcDir, "background.js")],
  outdir: distDir,
  format: "esm",
});

// Content scripts + popup script run as classic scripts. Bundle as
// IIFE so module syntax doesn't leak into a non-module context.
await esbuild.build({
  ...common,
  entryPoints: [
    join(srcDir, "bridge.js"),
    join(srcDir, "injected.js"),
    join(srcDir, "popup.js"),
  ],
  outdir: distDir,
  format: "iife",
});

function copyTree(srcRoot, destRoot) {
  for (const name of readdirSync(srcRoot)) {
    if (name.endsWith(".js")) continue;
    const s = join(srcRoot, name);
    const d = join(destRoot, name);
    if (statSync(s).isDirectory()) {
      mkdirSync(d, { recursive: true });
      copyTree(s, d);
    } else {
      copyFileSync(s, d);
    }
  }
}
copyTree(srcDir, distDir);

const zipName = `istoria-extension-${version}.zip`;
const zipPath = resolve(here, "..", "dist", zipName);
mkdirSync(dirname(zipPath), { recursive: true });
rmSync(zipPath, { force: true });
execSync(`zip -qr ${JSON.stringify(zipPath)} . -x "*.DS_Store"`, {
  cwd: distDir,
  stdio: "inherit",
});

console.log(`✓ built dist/ (v${version})`);
console.log(`✓ packaged ${zipPath}`);
