#!/usr/bin/env python3
"""Serveur local minimal pour PILOT : écoute uniquement sur 127.0.0.1 et ne sert que index.html."""
import http.server, os, sys
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ROOT = os.path.dirname(os.path.abspath(__file__))
CSP = ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; "
       "connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'")
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.split("?")[0] not in ("/", "/index.html"):
            self.send_error(404); return
        data = open(os.path.join(ROOT, "index.html"), "rb").read()
        self.send_response(200)
        for k, v in {"Content-Type": "text/html; charset=utf-8", "Content-Length": str(len(data)),
                     "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                     "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
                     "Content-Security-Policy": CSP}.items():
            self.send_header(k, v)
        self.end_headers(); self.wfile.write(data)
    def log_message(self, *a): pass
print(f"PILOT : http://localhost:{PORT}  (Ctrl+C pour arrêter)")
http.server.HTTPServer(("127.0.0.1", PORT), H).serve_forever()
