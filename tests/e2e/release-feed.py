#!/usr/bin/env python3
"""The update check's release feed, as GitHub's API serves it (E2E `update-release`).

  release-feed.py <port> <dir>      serves <dir>/latest.json on 127.0.0.1:<port>

Like api.github.com, it refuses a request without a User-Agent header (403, GitHub's
own body): a check that leaves it out never sees a release. Each request is logged
to <dir>/requests.jsonl: path, user agent, status.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

PORT, DIR = int(sys.argv[1]), Path(sys.argv[2])
# api.github.com's answer to a request with no User-Agent (as of 2026-11).
NO_UA = ("\r\nRequest forbidden by administrative rules. Please make sure your request has a User-Agent header "
         "(https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#user-agent-required). "
         "Check https://developer.github.com for other possible causes.\r\n")


class Feed(BaseHTTPRequestHandler):
    def do_GET(self):
        ua = self.headers.get("User-Agent")
        path = DIR / self.path.lstrip("/").split("?")[0]
        if not ua:
            status, body, kind = 403, NO_UA.encode(), "text/plain"
        elif path.is_file() and path.parent == DIR:
            status, body, kind = 200, path.read_bytes(), "application/json"
        else:
            status, body, kind = 404, b'{"message": "Not Found"}', "application/json"
        with open(DIR / "requests.jsonl", "a") as log:
            log.write(json.dumps({"path": self.path, "userAgent": ua, "status": status}) + "\n")
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        pass


HTTPServer(("127.0.0.1", PORT), Feed).serve_forever()
