#!/usr/bin/env python3
"""Keep app.html's inlined copy of aapp-client.js in sync with the source file.

app.html must be a single self-contained file (it is served from raw/static
hosts with no build step and installed as a PWA), so it carries a *verbatim*
inline copy of ../aapp-client.js between two HTML-comment markers. This script
is the one allowed way to update that copy, and the check the CI runs so the
two can never silently drift.

    scripts/sync-client.py --write    # regenerate the inlined copy from the source
    scripts/sync-client.py --check    # exit 1 if the inlined copy is stale

Stdlib only; no dependencies.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL = os.path.dirname(HERE)
APP = os.path.join(SKILL, "app.html")
LIB = os.path.join(SKILL, "aapp-client.js")

BEGIN = "<!-- aapp-client.js:begin"
END = "<!-- aapp-client.js:end -->"


def read(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def split_region(html):
    """Return (prefix, begin_comment_line, suffix) around the inline region.

    prefix ends just after the begin marker's own line; suffix starts at the
    end marker. Everything between is the managed <script> block.
    """
    b = html.find(BEGIN)
    if b < 0:
        sys.exit("error: begin marker not found in app.html")
    # keep the whole begin comment (it may span multiple lines) up to its close
    b_close = html.find("-->", b)
    if b_close < 0:
        sys.exit("error: unterminated begin marker")
    b_close += len("-->")
    e = html.find(END, b_close)
    if e < 0:
        sys.exit("error: end marker not found in app.html")
    return html[:b_close], html[b_close:e], html[e:]


def wrap(lib_source):
    return "\n<script>\n" + lib_source.rstrip("\n") + "\n</script>\n"


def current_inline(region):
    """Extract the library source from the managed region, or None if absent."""
    s = region.find("<script>")
    e = region.rfind("</script>")
    if s < 0 or e < 0:
        return None
    inner = region[s + len("<script>"):e]
    return inner.strip("\n")


def main(argv):
    if len(argv) != 1 or argv[0] not in ("--write", "--check"):
        sys.exit(__doc__)
    mode = argv[0]
    html = read(APP)
    lib = read(LIB)
    prefix, region, suffix = split_region(html)

    if mode == "--write":
        new_html = prefix + wrap(lib) + suffix
        if new_html != html:
            with open(APP, "w", encoding="utf-8") as f:
                f.write(new_html)
            print("updated app.html inline copy from aapp-client.js")
        else:
            print("app.html already in sync")
        return 0

    # --check
    inline = current_inline(region)
    if inline is None:
        print("FAIL: no inlined <script> found between markers in app.html", file=sys.stderr)
        return 1
    if inline != lib.strip("\n"):
        print(
            "FAIL: app.html inline copy is out of sync with aapp-client.js\n"
            "      run: scripts/sync-client.py --write",
            file=sys.stderr,
        )
        return 1
    print("OK: app.html inline copy matches aapp-client.js")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
