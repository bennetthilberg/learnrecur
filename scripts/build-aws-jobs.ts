import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { build } from "esbuild";

async function main() {
  const destination = resolve(".aws-build/jobs");
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  await build({
    entryPoints: ["src/lib/jobs/lambda.ts"], outfile: resolve(destination, "index.mjs"),
    bundle: true, platform: "node", target: "node24", format: "esm",
    conditions: ["react-server"], sourcemap: "external", sourcesContent: false,
    banner: { js: 'import { createRequire as __learnrecurCreateRequire } from "node:module"; const require = __learnrecurCreateRequire(import.meta.url);' },
    external: ["pdfjs-dist", "bufferutil", "utf-8-validate"],
    metafile: true,
  }).then((result) => writeFileSync(resolve(destination, "metafile.json"), JSON.stringify(result.metafile)));
  // PDF.js needs its worker module and canvas support at runtime. Copy the
  // installed, locked JS packages and fetch only the matching Linux binary.
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  for (const name of ["pdfjs-dist", "@napi-rs/canvas"]) {
    cpSync(resolve("node_modules", name), resolve(destination, "node_modules", name), { recursive: true });
  }
  const nativeName = "@napi-rs/canvas-linux-arm64-gnu";
  const native = lock.packages[`node_modules/${nativeName}`];
  const packed = JSON.parse(execFileSync("npm", ["pack", `${nativeName}@${native.version}`, "--ignore-scripts", "--json", "--pack-destination", destination], { encoding: "utf8" }))[0];
  const archive = resolve(destination, packed.filename);
  const integrity = `sha512-${createHash("sha512").update(readFileSync(archive)).digest("base64")}`;
  if (integrity !== native.integrity) throw new Error("Native worker dependency does not match package-lock.json");
  const nativeDirectory = resolve(destination, "node_modules", nativeName);
  mkdirSync(nativeDirectory, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", nativeDirectory]);
  rmSync(archive);
  writeFileSync(resolve(destination, "package.json"), JSON.stringify({ private: true, type: "module" }));
  const zip = resolve(".aws-build/jobs.zip");
  rmSync(zip, { force: true });
  execFileSync("zip", ["-q", "-r", zip, "index.mjs", "index.mjs.map", "package.json", "node_modules"], { cwd: destination });
  console.info(`Built ${zip}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
