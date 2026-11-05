"""
Local Playboy (518382) HLS relay.

Why this exists
---------------
The provider's playlist lists 4 x 2 s segments, but each segment URL has a very
short life (a few seconds) and the newest entry is often not published yet.
VLC picks the oldest entry, gets a 404 a second later, and kills the input:
"Program doesn't contain anymore ES" -> dead input after ~14 s.

This service sits on 127.0.0.1, talks to the provider directly (no Cloudflare,
which the provider's entry host blocks), serves a playlist that only lists
segments that are actually downloadable right now, and proxies the bytes.

Usage
-----
    python pb_relay.py [--port 8791]

Then play http://127.0.0.1:8791/live.m3u8 in VLC, or point a page at it.
"""

import argparse
import threading
import time
import urllib.error
import urllib.request
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, quote

CHANNEL_URL = "http://vividmedia.xyz:80/live/judith11/judith11/518382.m3u8"
UA = "VLC/3.0.20 LibVLC/3.0.20"
ORIGIN_TIMEOUT = 8
# How many of the freshest segments to expose. The provider's own list is 4;
# the last one is often not published yet, the first one is often already gone.
KEEP_SEGMENTS = 3
SEG_CACHE_SECONDS = 12

_lock = threading.Lock()
_seg_cache = {}  # url -> (bytes, content_type, expires_at)


def http_get(url, timeout=ORIGIN_TIMEOUT, headers=None):
    hdrs = {"User-Agent": UA, "Accept": "*/*"}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, headers=hdrs)
    return urllib.request.urlopen(req, timeout=timeout)


def fetch_manifest():
    """Return (media_sequence, [(seq_no, absolute_url), ...], target_duration)."""
    with http_get(CHANNEL_URL) as r:
        body = r.read().decode("utf-8", "replace")
        final = r.geturl()

    parts = final.split("//")
    origin = parts[0] + "//" + parts[1].split("/")[0]

    seq = 0
    target = 4
    pending = None
    segs = []
    for raw in body.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            seq = int(line.split(":", 1)[1])
        elif line.startswith("#EXT-X-TARGETDURATION:"):
            target = int(float(line.split(":", 1)[1]))
        elif line.startswith("#EXTINF:"):
            pending = line
        elif not line.startswith("#"):
            url = line if line.startswith("http") else origin + line
            segs.append((pending or "#EXTINF:2.000000,", url))
            pending = None

    numbered = [(seq + i, inf, u) for i, (inf, u) in enumerate(segs)]
    return numbered, target


def probe_segment(url):
    """Cheap existence check. Returns bytes on success, None when missing."""
    try:
        with http_get(url) as r:
            data = r.read()
            ctype = r.headers.get("Content-Type", "video/mp2t")
            return data, ctype
    except urllib.error.HTTPError:
        return None
    except Exception:
        return None


def get_segment(url):
    now = time.time()
    with _lock:
        hit = _seg_cache.get(url)
        if hit and hit[2] > now:
            return hit[0], hit[1]
    got = probe_segment(url)
    if not got:
        return None
    data, ctype = got
    with _lock:
        if len(_seg_cache) > 24:
            for k in [k for k, v in _seg_cache.items() if v[2] <= now]:
                _seg_cache.pop(k, None)
            while len(_seg_cache) > 24:
                _seg_cache.pop(next(iter(_seg_cache)))
        _seg_cache[url] = (data, ctype, now + SEG_CACHE_SECONDS)
    return data, ctype


def build_playlist(base):
    """Fetch a manifest and return a playlist containing only live segments."""
    numbered, target = fetch_manifest()
    if not numbered:
        raise RuntimeError("empty manifest")

    # Keep provider order and include every segment that is downloadable right
    # now. Consecutive refreshes then overlap, so the player never has to skip
    # a sequence number (a skip shows up as a TS discontinuity / 2 s gap).
    live = []
    for seqno, inf, url in numbered:
        got = get_segment(url)
        if got:
            data, ctype = got
            live.append((seqno, inf, url, len(data)))
    if not live:
        raise RuntimeError("no live segments")
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        f"#EXT-X-TARGETDURATION:{max(target, 4)}",
        f"#EXT-X-MEDIA-SEQUENCE:{live[0][0]}",
    ]
    for seqno, inf, url, size in live:
        lines.append(inf if inf.endswith(",") else inf + ",")
        lines.append(base + "/seg?u=" + quote(url, safe=""))
    return "\n".join(lines) + "\n", live


stats = {"playlist": 0, "seg": 0, "miss": 0, "fail": 0}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        if "--verbose" in _ARGS:
            print("  " + fmt % args, flush=True)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send(self, code, body, ctype, cache="no-store"):
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        base = "http://" + self.headers.get("Host", f"127.0.0.1:{_PORT}")

        if path in ("/live.m3u8", "/pb.m3u8", "/"):
            try:
                text, live = build_playlist(base)
            except Exception as e:
                stats["fail"] += 1
                self._send(502, f"origin error: {e}\n".encode(), "text/plain")
                return
            stats["playlist"] += 1
            if "--verbose" in _ARGS:
                print(f"[{time.strftime('%H:%M:%S')}] playlist seq={live[0][0]} "
                      f"segs={len(live)} sizes={[l[3] for l in live]}", flush=True)
            self._send(200, text.encode(), "application/vnd.apple.mpegurl")
            return

        if path == "/seg":
            u = (parse_qs(parsed.query).get("u") or [""])[0]
            if not u.startswith("http"):
                self._send(400, b"bad url", "text/plain")
                return
            got = get_segment(u)
            if not got:
                stats["miss"] += 1
                self._send(404, b"gone", "text/plain")
                return
            stats["seg"] += 1
            self._send(200, got[0], got[1])
            return

        if path == "/stats":
            self._send(200, (str(stats) + "\n").encode(), "text/plain")
            return

        self._send(404, b"not found", "text/plain")


_ARGS, _PORT = [], 8791


def main():
    global _ARGS, _PORT
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8791)
    ap.add_argument("--verbose", action="store_true")
    _ARGS = [a for a in __import__("sys").argv[1:]]
    args = ap.parse_args()
    _ARGS = ["--verbose"] if args.verbose else []
    _PORT = args.port

    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    srv.daemon_threads = True
    print(f"Playboy relay on http://127.0.0.1:{args.port}/live.m3u8", flush=True)
    print("  VLC:  vlc http://127.0.0.1:%d/live.m3u8" % args.port, flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("stopped")


if __name__ == "__main__":
    main()
