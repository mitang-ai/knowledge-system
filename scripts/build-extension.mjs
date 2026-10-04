import { build as viteBuild } from "vite";
import react from "@vitejs/plugin-react";
import { build as bundle } from "esbuild";
import sharp from "sharp";
import { mkdir, readFile, writeFile, cp, rm, readdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = join(root, "build", "browser-extension");
const output = join(home, "unpacked");
const marker = join(home, ".sediment-extension-build");
await mkdir(home, { recursive: true });
const existing = await readdir(home);
if (existing.length && !existing.includes(".sediment-extension-build"))
  throw new Error("Refusing to overwrite an unowned build directory: " + home);
await writeFile(marker, "sediment-extension-v1\n");
// Only this build-owned output is removed; no repository or user data is copied.
if (!output.startsWith(home + "\\") && !output.startsWith(home + "/"))
  throw new Error("Invalid build target");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await viteBuild({
  configFile: false,
  root: join(root, "extension"),
  base: "./",
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: output,
    emptyOutDir: false,
    target: "chrome116",
    sourcemap: false,
    rollupOptions: { input: join(root, "extension", "panel.html") },
  },
});
await bundle({
  entryPoints: [join(root, "extension", "src", "background.ts")],
  outfile: join(output, "background.js"),
  bundle: true,
  format: "esm",
  target: "chrome116",
  minify: true,
  legalComments: "eof",
});
await bundle({
  entryPoints: [join(root, "extension", "src", "capture", "entry.ts")],
  outfile: join(output, "capture.js"),
  bundle: true,
  format: "iife",
  target: "chrome116",
  minify: true,
  legalComments: "eof",
});
await mkdir(join(output, "sdk"), { recursive: true });
await bundle({
  entryPoints: [join(root, "extension", "src", "sdk.ts")],
  outfile: join(output, "sdk", "capture.mjs"),
  bundle: true,
  format: "esm",
  target: "es2022",
  minify: false,
});
execFileSync(
  process.execPath,
  [
    join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    join(root, "extension", "tsconfig.sdk.json"),
    "--outDir",
    join(output, "sdk", "types"),
  ],
  { cwd: root, stdio: "inherit" },
);
await writeFile(
  join(output, "sdk", "capture.d.ts"),
  "export * from './types/extension/src/sdk';\n",
);
await writeFile(
  join(output, "sdk", "package.json"),
  JSON.stringify(
    {
      name: "@sediment/capture-sdk",
      version: "0.1.0",
      type: "module",
      private: true,
      exports: { ".": { types: "./capture.d.ts", import: "./capture.mjs" } },
    },
    null,
    2,
  ),
);
await cp(
  join(root, "extension", "manifest.json"),
  join(output, "manifest.json"),
);
await cp(
  join(root, "extension", "capture.schema.json"),
  join(output, "capture.schema.json"),
);
await cp(join(root, "extension", "README.md"), join(output, "INSTALL.md"));
await mkdir(join(output, "docs"), { recursive: true });
for (const name of ["浏览器插件设计与调研.md", "浏览器插件开发与验收.md"]) {
  await cp(join(root, "docs", name), join(output, "docs", name));
}
await mkdir(join(output, "icons"), { recursive: true });
for (const size of [16, 32, 48, 128])
  await sharp(join(root, "public", "brand", "app-icon.svg"))
    .resize(size, size)
    .png()
    .toFile(join(output, "icons", size + ".png"));
await mkdir(join(output, "licenses"), { recursive: true });
for (const [pkg, path] of [
  ["@mozilla/readability", "LICENSE.md"],
  ["turndown", "LICENSE"],
  ["react", "LICENSE"],
  ["react-dom", "LICENSE"],
  ["lucide-react", "LICENSE"],
])
  await cp(
    join(root, "node_modules", pkg, path),
    join(output, "licenses", pkg.replace("/", "-") + ".txt"),
  );
const zip = join(home, "sediment-browser-extension-0.1.0.zip");
execFileSync(
  process.env.PYTHON || "python",
  [
    "-c",
    "import pathlib,sys,zipfile\np=pathlib.Path(sys.argv[1]); z=pathlib.Path(sys.argv[2])\nwith zipfile.ZipFile(z,'w',zipfile.ZIP_DEFLATED) as f:\n for a in sorted(p.rglob('*')):\n  if a.is_file(): f.write(a,a.relative_to(p))",
    output,
    zip,
  ],
  { stdio: "inherit" },
);
const hash = createHash("sha256")
  .update(await readFile(zip))
  .digest("hex");
await writeFile(
  join(home, "artifact.json"),
  JSON.stringify(
    { version: "0.1.0", zip, sha256: hash, unpacked: output },
    null,
    2,
  ),
);
console.log("Extension:", output, "\nZIP:", zip, "\nSHA256:", hash);
