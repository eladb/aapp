// markdown-lite (safe) — ported verbatim from the vanilla app.html so the React
// port renders identical output: bold/italic, inline code, links + autolink,
// headings, lists, GFM tables, fenced code blocks (with a Copy button), and
// ```diff blocks colored +green/-red with the prefix kept for a faithful copy.

export function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function safeUrl(u) {
  return /^(https?:|mailto:)/i.test(u) ? u : "#";
}
export function renderInline(s) {
  // s is already HTML-escaped
  s = s.replace(/`([^`\n]+?)`/g, function (_, c) {
    return '<code class="inline">' + c + "</code>";
  });
  // Links in ONE left-to-right pass: [text](url) OR a bare url. Doing both in
  // a single alternation means a markdown link's url is never also autolinked
  // (and a bare url never mistaken for link text).
  s = s.replace(
    /\[([^\]]+?)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g,
    function (m, t, u1, u2) {
      if (u1 != null)
        return '<a href="' + safeUrl(u1) + '" target="_blank" rel="noopener noreferrer">' + t + "</a>";
      return '<a href="' + safeUrl(u2) + '" target="_blank" rel="noopener noreferrer">' + u2 + "</a>";
    }
  );
  s = s.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
  return s;
}
function mdSplitRow(line) {
  var s = line.trim();
  if (s.charAt(0) === "|") s = s.slice(1);
  if (s.charAt(s.length - 1) === "|") s = s.slice(0, -1);
  return s.split("|").map(function (c) {
    return c.trim();
  });
}
function mdIsSep(line) {
  if (line.indexOf("|") < 0) return false;
  var cells = mdSplitRow(line);
  if (!cells.length) return false;
  return cells.every(function (c) {
    return /^:?-{1,}:?$/.test(c);
  });
}
function mdAlign(c) {
  var l = c.charAt(0) === ":",
    r = c.charAt(c.length - 1) === ":";
  return l && r ? "center" : r ? "right" : l ? "left" : "";
}
// Friendly display names for the code header's language label.
var LANG_NAMES = {
  js: "JavaScript", jsx: "JavaScript", ts: "TypeScript", tsx: "TypeScript",
  py: "Python", rb: "Ruby", go: "Go", rs: "Rust", java: "Java", c: "C",
  cpp: "C++", cs: "C#", php: "PHP", sh: "Shell", bash: "Shell", zsh: "Shell",
  json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", html: "HTML",
  css: "CSS", scss: "SCSS", sql: "SQL", md: "Markdown", diff: "Diff",
  xml: "XML", swift: "Swift", kt: "Kotlin", txt: "Text",
};
var COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2.5"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
function codeBar(lang) {
  // Beautiful UI 17 header: mono filename + language name, Copy button.
  var key = (lang || "").toLowerCase();
  var name = key || "code";
  var pretty = LANG_NAMES[key] || (key ? key.toUpperCase() : "");
  return (
    '<div class="codebar"><span class="cbl"><span class="cbname">' +
    esc(name) +
    "</span>" +
    (pretty ? '<span class="cblang">' + esc(pretty) + "</span>" : "") +
    '</span><button class="copy">' + COPY_ICON + '<span class="copylbl">Copy</span></button></div>'
  );
}
function renderCodeBlock(lines, lang) {
  // lines are already HTML-escaped. A ```diff fence colors +/- lines (the
  // prefix char stays in the text so the Copy button yields a real diff).
  if (/^diff$/i.test(lang || "")) {
    var body = lines
      .map(function (ln) {
        var ch = ln.charAt(0),
          c = "ctx";
        if (ch === "+" && ln.slice(0, 3) !== "+++") c = "add";
        else if (ch === "-" && ln.slice(0, 3) !== "---") c = "del";
        return '<span class="dl ' + c + '">' + (ln.length ? ln : " ") + "</span>";
      })
      .join("");
    return '<div class="codewrap">' + codeBar(lang) + '<pre class="diff"><code>' + body + "</code></pre></div>";
  }
  return '<div class="codewrap">' + codeBar(lang) + "<pre><code>" + lines.join("\n") + "</code></pre></div>";
}
export function renderMarkdown(text) {
  var out = [];
  var lines = esc(text).split(/\n/);
  var i = 0,
    inCode = false,
    code = [],
    codeLang = "",
    listType = null,
    list = [];
  function closeList() {
    if (listType) {
      out.push("<" + listType + ">" + list.join("") + "</" + listType + ">");
      list = [];
      listType = null;
    }
  }
  while (i < lines.length) {
    var ln = lines[i];
    var fence = ln.match(/^\s*```(.*)$/);
    if (fence) {
      if (!inCode) {
        closeList();
        inCode = true;
        codeLang = fence[1].trim();
        code = [];
      } else {
        inCode = false;
        out.push(renderCodeBlock(code, codeLang));
      }
      i++;
      continue;
    }
    if (inCode) {
      code.push(ln);
      i++;
      continue;
    }
    var h = ln.match(/^\s*(#{1,3})\s+(.*)$/);
    if (h) {
      closeList();
      out.push("<h" + h[1].length + ">" + renderInline(h[2]) + "</h" + h[1].length + ">");
      i++;
      continue;
    }
    // GFM table: a row with pipes followed by a delimiter row
    if (ln.indexOf("|") >= 0 && i + 1 < lines.length && mdIsSep(lines[i + 1])) {
      closeList();
      var head = mdSplitRow(ln),
        aligns = mdSplitRow(lines[i + 1]).map(mdAlign),
        body = [],
        j = i + 2;
      while (j < lines.length && lines[j].indexOf("|") >= 0 && lines[j].trim() !== "") {
        body.push(mdSplitRow(lines[j]));
        j++;
      }
      var t = '<div class="tablewrap"><table><thead><tr>';
      head.forEach(function (c, k) {
        t += "<th" + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "") + ">" + renderInline(c) + "</th>";
      });
      t += "</tr></thead><tbody>";
      body.forEach(function (r) {
        t += "<tr>";
        head.forEach(function (_, k) {
          var c = r[k] !== undefined ? r[k] : "";
          t += "<td" + (aligns[k] ? ' style="text-align:' + aligns[k] + '"' : "") + ">" + renderInline(c) + "</td>";
        });
        t += "</tr>";
      });
      out.push(t + "</tbody></table></div>");
      i = j;
      continue;
    }
    var ul = ln.match(/^\s*[-*]\s+(.*)$/);
    var ol = ln.match(/^\s*\d+\.\s+(.*)$/);
    if (ul) {
      if (listType !== "ul") {
        closeList();
        listType = "ul";
      }
      list.push("<li>" + renderInline(ul[1]) + "</li>");
      i++;
      continue;
    }
    if (ol) {
      if (listType !== "ol") {
        closeList();
        listType = "ol";
      }
      list.push("<li>" + renderInline(ol[1]) + "</li>");
      i++;
      continue;
    }
    closeList();
    if (ln.trim() === "") {
      i++;
      continue;
    }
    // gather a paragraph (consecutive non-empty, non-special lines)
    var para = [ln];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*(#{1,3})\s/.test(lines[i]) &&
      !/^\s*[-*]\s/.test(lines[i]) &&
      !/^\s*\d+\.\s/.test(lines[i]) &&
      // stop if this line begins a GFM table (pipe row + delimiter row), so a
      // table glued directly under a line of text still renders as a table
      !(lines[i].indexOf("|") >= 0 && i + 1 < lines.length && mdIsSep(lines[i + 1]))
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push("<p>" + para.map(renderInline).join("<br>") + "</p>");
  }
  if (inCode) out.push(renderCodeBlock(code, codeLang));
  closeList();
  return out.join("");
}
