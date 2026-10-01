import json, os, socket, ssl, urllib.request, urllib.error, http.client
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = 8000
KEY = os.environ.get("ROBOFLOW_API_KEY", "rqZaHINUp5l3lCE8DnGQ")
DEFAULT = "https://serverless.roboflow.com/jhave-larios/workflows/muse-spark-1-1-classification"

def resolve_with_cloudflare(hostname):
    """Resolve an A record through Cloudflare DNS-over-HTTPS if Windows DNS fails."""
    ctx = ssl.create_default_context()
    sock = socket.create_connection(("1.1.1.1", 443), timeout=10)
    tls = ctx.wrap_socket(sock, server_hostname="cloudflare-dns.com")
    try:
        request = (
            f"GET /dns-query?name={hostname}&type=A HTTP/1.1\r\n"
            "Host: cloudflare-dns.com\r\n"
            "Accept: application/dns-json\r\n"
            "Connection: close\r\n\r\n"
        )
        tls.sendall(request.encode("ascii"))
        chunks = []
        while True:
            data = tls.recv(65536)
            if not data:
                break
            chunks.append(data)
    finally:
        tls.close()

    raw = b"".join(chunks)
    _, _, body = raw.partition(b"\r\n\r\n")
    result = json.loads(body.decode("utf-8"))
    addresses = [
        a.get("data") for a in result.get("Answer", [])
        if a.get("type") == 1 and a.get("data")
    ]
    if not addresses:
        raise RuntimeError(f"Cloudflare DNS returned no IPv4 address for {hostname}")
    return addresses[0]

def post_with_resolved_ip(url, payload):
    parsed = urllib.request.urlparse(url)
    if parsed.scheme != "https":
        raise RuntimeError("DNS fallback only supports HTTPS Roboflow URLs")

    hostname = parsed.hostname
    ip = resolve_with_cloudflare(hostname)
    port = parsed.port or 443
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query

    ctx = ssl.create_default_context()
    sock = socket.create_connection((ip, port), timeout=90)
    tls = ctx.wrap_socket(sock, server_hostname=hostname)

    try:
        request_body = json.dumps(payload).encode("utf-8")
        headers = (
            f"POST {path} HTTP/1.1\r\n"
            f"Host: {hostname}\r\n"
            "Content-Type: application/json\r\n"
            "Accept: application/json\r\n"
            "Connection: close\r\n"
            f"Content-Length: {len(request_body)}\r\n\r\n"
        ).encode("ascii") + request_body

        tls.sendall(headers)
        chunks = []
        while True:
            data = tls.recv(65536)
            if not data:
                break
            chunks.append(data)
    finally:
        tls.close()

    raw = b"".join(chunks)
    head, _, body = raw.partition(b"\r\n\r\n")
    lines = head.decode("iso-8859-1").split("\r\n")
    status = int(lines[0].split()[1])
    content_type = "application/json"
    for line in lines[1:]:
        if line.lower().startswith("content-type:"):
            content_type = line.split(":", 1)[1].strip()
            break
    return status, content_type, body

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def send_json(self, status, obj):
        raw = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        if self.path != "/api/roboflow":
            return self.send_json(404, {"error": "Unknown API route"})

        try:
            n = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(n) or b"{}")
            url = body.get("workflowUrl") or DEFAULT
            payload = {
                "api_key": KEY,
                "inputs": body.get("inputs") or {}
            }

            request_body = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                url,
                data=request_body,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                method="POST"
            )

            try:
                with urllib.request.urlopen(req, timeout=90) as r:
                    raw = r.read()
                    status = r.status
                    ct = r.headers.get("Content-Type", "application/json")
            except urllib.error.URLError as e:
                # Windows may fail to resolve serverless.roboflow.com even while
                # the browser itself can reach the Internet. Try a DNS-over-HTTPS
                # resolution before giving up.
                if "getaddrinfo failed" not in str(e):
                    raise
                print("[ScrapScan] Windows DNS lookup failed; trying Cloudflare DNS fallback...")
                try:
                    status, ct, raw = post_with_resolved_ip(url, payload)
                except Exception as fallback_error:
                    print(
                        f"[ScrapScan] DNS fallback failed: "
                        f"{type(fallback_error).__name__}: {fallback_error}"
                    )
                    # The PM2V page can use its direct Roboflow fallback.
                    self.send_json(502, {
                        "error": "Could not reach Roboflow from local proxy",
                        "details": str(fallback_error),
                        "exceptionType": type(fallback_error).__name__,
                        "allowDirectFallback": True
                    })
                    return

            self.send_response(status)
            self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)

        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:5000]
            print(f"[ScrapScan] Roboflow HTTP {e.code}: {detail}")
            self.send_json(e.code, {
                "error": f"Roboflow HTTP {e.code}",
                "details": detail
            })
        except Exception as e:
            import traceback
            print(f"[ScrapScan] ERROR: {type(e).__name__}: {e}")
            traceback.print_exc()
            self.send_json(502, {
                "error": "ScrapScan proxy error",
                "details": str(e),
                "exceptionType": type(e).__name__
            })

if __name__ == "__main__":
    print("ScrapScan: http://localhost:8000/PM2V.html")
    print("Keep this window open while using the app.")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
