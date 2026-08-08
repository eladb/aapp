#!/usr/bin/env python3
"""
Serve app.html locally for tunnel-mode hosting.

Usage:
    python3 serve.py [--port 8787] [--host 127.0.0.1]

Then expose it publicly, e.g. with a Cloudflare quick tunnel (no account):
    cloudflared tunnel --url http://127.0.0.1:8787
and use  https://<random>.trycloudflare.com/app.html#s=...&t=...  as the link.

This is only needed when you'd rather not publish app.html to a static host
(see reference/hosting.md). The relay itself is still ntfy over HTTPS.
"""
import argparse
import http.server
import os
import socketserver

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)  # the skill dir, which contains app.html


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=APP_DIR, **k)

    def end_headers(self):
        # allow the page to be embedded/opened anywhere; no caching during dev
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # quiet


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((args.host, args.port), Handler) as httpd:
        url = "http://%s:%d/app.html" % (args.host, args.port)
        print("serving app.html at %s" % url)
        print("expose publicly, e.g.:")
        print("  cloudflared tunnel --url http://%s:%d" % (args.host, args.port))
        print("then share  https://<tunnel-domain>/app.html#s=<server>&t=<topic>")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
