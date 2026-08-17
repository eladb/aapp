"use strict";
// Regression tests for the app's markdown-lite renderer, focused on GFM tables.
// The renderer is the ES module web/src/markdown.js that main.jsx bundles into
// the app; we load it here by stripping its `export` keywords and evaluating it
// in isolation, so the test stays dependency-free. Run: `node test/markdown.test.js`.
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const vm = require("vm");

const modPath = path.join(__dirname, "..", "web", "src", "markdown.js");
const src = fs.readFileSync(modPath, "utf8").replace(/^export\s+/gm, "") +
  "\n;this.renderMarkdown = renderMarkdown;";
const sandbox = {};
vm.runInNewContext(src, sandbox);
const renderMarkdown = sandbox.renderMarkdown;

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; console.log("  ✓ " + name); }
const hasTable = (s) => s.includes("<table>");

// blank line before the table (canonical)
ok("table after a blank line renders", hasTable(renderMarkdown("Results:\n\n| A | B |\n|---|---|\n| 1 | 2 |")));
// glued directly under a line of text — the reported bug
ok("table glued under text renders (no blank line)", hasTable(renderMarkdown("Results:\n| A | B |\n|---|---|\n| 1 | 2 |")));
// no outer pipes
ok("table without outer pipes renders", hasTable(renderMarkdown("A | B\n--|--\n1 | 2")));
// alignment colons
const al = renderMarkdown("| L | C | R |\n|:--|:-:|--:|\n| a | b | c |");
ok("aligned table renders with text-align", hasTable(al) && al.includes("text-align:center") && al.includes("text-align:right"));
// intro paragraph, glued table, trailing paragraph — all three kept distinct
const mix = renderMarkdown("Intro text.\n| A | B |\n|---|---|\n| 1 | 2 |\nAfter text.");
ok("intro <p> preserved before glued table", mix.includes("<p>Intro text.</p>"));
ok("trailing <p> preserved after glued table", mix.includes("<p>After text.</p>") && hasTable(mix));
// cell inline formatting still applies
const fmt = renderMarkdown("| Name | Note |\n|---|---|\n| **bold** | `code` |");
ok("inline markdown inside cells renders", fmt.includes("<strong>bold</strong>") && fmt.includes('<code class="inline">code</code>'));
// a lone pipe line that is NOT a table stays a paragraph
ok("non-table pipe line stays a paragraph", !hasTable(renderMarkdown("a | b but no delimiter row here")));

console.log("\nmarkdown.test.js: all " + passed + " assertions passed ✅");
