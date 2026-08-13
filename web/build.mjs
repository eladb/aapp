// Build the aapp phone app: bundle the React + liquid-gooey source with esbuild,
// then inline the JS (and CSS) into a single self-contained app.html so it still
// installs as a PWA and serves from any static host with no runtime deps.
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_CANDIDATE = process.env.AAPP_OUT || join(HERE, "dist", "app.html");
mkdirSync(dirname(OUT_CANDIDATE), { recursive: true });

// Derive src/aapp-client.cjs from the canonical wire library so the bundled
// copy can never drift from the tested source. The file is CommonJS (UMD sets
// module.exports); we append a shim exposing a named `AappClient` for esbuild.
const CANON = join(HERE, "..", ".claude", "skills", "aapp", "aapp-client.js");
const SHIM =
  "\n\n// --- esbuild interop shim (appended by build.mjs; UMD above is verbatim) ---\n" +
  'if (typeof module === "object" && module.exports) { module.exports.AappClient = module.exports; }\n';
writeFileSync(join(HERE, "src", "aapp-client.cjs"), readFileSync(CANON, "utf8") + SHIM);

const result = await build({
  entryPoints: [join(HERE, "src", "main.jsx")],
  bundle: true,
  minify: true,
  format: "iife",
  jsx: "automatic",
  target: ["es2019", "safari14"],
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  write: false,
});
const js = result.outputFiles.map((f) => f.text).join("\n");

let css = "";
try { css = readFileSync(join(HERE, "src", "app.css"), "utf8"); } catch {}

const shell = readFileSync(join(HERE, "shell.html"), "utf8");
const html = shell
  .replace("/*__AAPP_CSS__*/", () => css)
  .replace("//__AAPP_JS__", () => js);

writeFileSync(OUT_CANDIDATE, html);
console.log("built", OUT_CANDIDATE, "(" + Math.round(html.length / 1024) + " KB)");
