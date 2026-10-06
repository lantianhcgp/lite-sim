#!/usr/bin/env python3
# lite-sim 服务端：静态网页 + 文件管理 + 日志落盘 + MCP(JSON-RPC 2.0 over HTTP)
# 零第三方依赖（只用标准库）。启动：python3 server/server.py [端口]
import json, os, re, sys, time, hmac, hashlib, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # 仓库根
WEB = os.path.join(ROOT, "web")
LOGDIR = os.path.join(ROOT, "logs")
TOKEN_FILE = os.path.join(ROOT, ".token")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
MAX_BODY = 8 * 1024 * 1024

# ---------------------------------------------------------------- token
def load_token():
    if os.path.exists(TOKEN_FILE):
        t = open(TOKEN_FILE, encoding="utf-8").read().strip()
        if re.fullmatch(r"[0-9a-f]{32}", t):
            return t
    t = hashlib.sha256(str(time.time()).encode()).hexdigest()[:32]
    with open(TOKEN_FILE, "w", encoding="utf-8") as f:
        f.write(t)
    return t

TOKEN = load_token()
os.makedirs(LOGDIR, exist_ok=True)

# ---------------------------------------------------------------- 安全路径
def safe_path(rel):
    """把相对路径限制在仓库内；abs / ~ 允许指向被调试项目（如 memo-todo 源码）。"""
    rel = (rel or "").strip()
    if not rel:
        return None
    if rel.startswith("~"):
        rel = os.path.expanduser(rel)
    if rel.startswith("/"):
        p = os.path.normpath(rel)
    else:
        p = os.path.normpath(os.path.join(ROOT, rel))
    # 白名单：仓库自身 + hw_watch 下的被调试项目
    allowed = [ROOT, os.path.join(os.path.expanduser("~"), "hw_watch")]
    for a in allowed:
        if p == a or p.startswith(a + os.sep):
            return p
    return None

# ---------------------------------------------------------------- 日志
LOG_LOCK = threading.Lock()

def append_log(rec):
    """追加一条结构化日志（JSON Lines），按天分文件。"""
    rec.setdefault("ts", time.strftime("%Y-%m-%dT%H:%M:%S"))
    day = time.strftime("%Y-%m-%d")
    path = os.path.join(LOGDIR, "%s.jsonl" % day)
    line = json.dumps(rec, ensure_ascii=False)
    with LOG_LOCK:
        with open(path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    return path

def read_logs(lines=200, filt=""):
    """读取日志尾部，可按 kind/level/message 过滤。"""
    files = sorted(f for f in os.listdir(LOGDIR) if f.endswith(".jsonl")) if os.path.isdir(LOGDIR) else []
    if not files:
        return []
    rows = []
    for fn in files:
        path = os.path.join(LOGDIR, fn)
        with open(path, encoding="utf-8", errors="replace") as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except Exception:
                    rec = {"kind": "raw", "message": raw}
                rec.setdefault("file", fn)
                rows.append(rec)
    if filt:
        fl = filt.lower()
        rows = [r for r in rows if fl in json.dumps(r, ensure_ascii=False).lower()]
    return rows[-int(lines):]

# ---------------------------------------------------------------- 文件
def fs_read(path):
    p = safe_path(path)
    if not p: return {"ok": False, "error": "路径越界"}
    if not os.path.isfile(p): return {"ok": False, "error": "文件不存在"}
    try:
        return {"ok": True, "path": p, "content": open(p, encoding="utf-8", errors="replace").read(),
                "size": os.path.getsize(p), "mtime": os.path.getmtime(p)}
    except Exception as e:
        return {"ok": False, "error": str(e)}

def fs_write(path, content):
    p = safe_path(path)
    if not p: return {"ok": False, "error": "路径越界"}
    try:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(content or "")
        return {"ok": True, "path": p, "size": os.path.getsize(p)}
    except Exception as e:
        return {"ok": False, "error": str(e)}

def fs_tree(path=""):
    p = safe_path(path) if path else ROOT
    if not p: return {"ok": False, "error": "路径越界"}
    if not os.path.isdir(p): return {"ok": False, "error": "目录不存在"}
    out = []
    for base, dirs, files in os.walk(p):
        dirs[:] = [d for d in dirs if not d.startswith(".") and d not in ("node_modules", "build", ".git")]
        rel = os.path.relpath(base, p)
        depth = 0 if rel == "." else rel.count(os.sep) + 1
        out.append("  " * depth + os.path.basename(base) + "/")
        for fn in sorted(files):
            if fn.startswith("."):
                continue
            out.append("  " * (depth + 1) + fn)
        if len(out) > 400:
            out.append("  ...(截断)")
            break
    return {"ok": True, "path": p, "tree": "\n".join(out)}

def fs_delete(path):
    p = safe_path(path)
    if not p: return {"ok": False, "error": "路径越界"}
    if p == ROOT or p.startswith(ROOT + os.sep) and p.count(os.sep) <= ROOT.count(os.sep) + 1:
        return {"ok": False, "error": "拒绝删除仓库根层级"}
    try:
        if os.path.isfile(p):
            os.remove(p); return {"ok": True, "deleted": p}
        return {"ok": False, "error": "只支持删文件"}
    except Exception as e:
        return {"ok": False, "error": str(e)}

# ---------------------------------------------------------------- MCP 工具
def mcp_tool(name, args):
    args = args or {}
    if name == "fs_read":     return fs_read(args.get("path", ""))
    if name == "fs_write":    return fs_write(args.get("path", ""), args.get("content", ""))
    if name == "fs_tree":     return fs_tree(args.get("path", ""))
    if name == "fs_delete":   return fs_delete(args.get("path", ""))
    if name == "log_tail":
        return {"ok": True, "count": 0, "logs": read_logs(args.get("lines", 200), args.get("filter", ""))}
    if name == "log_clear":
        for fn in os.listdir(LOGDIR):
            if fn.endswith(".jsonl"):
                os.remove(os.path.join(LOGDIR, fn))
        return {"ok": True, "cleared": True}
    if name == "sim_status":
        files = [f for f in os.listdir(LOGDIR) if f.endswith(".jsonl")] if os.path.isdir(LOGDIR) else []
        total = 0
        for fn in files:
            with open(os.path.join(LOGDIR, fn), encoding="utf-8", errors="replace") as f:
                total += sum(1 for _ in f)
        return {"ok": True, "root": ROOT, "web": WEB, "log_files": files, "log_total": total,
                "recent": read_logs(5)}
    if name == "sim_report":
        # 允许 AI/脚本直接写入一条日志（调试用）
        return {"ok": True, "written": append_log(args)}
    return {"ok": False, "error": "未知工具: %s" % name}

TOOLS = [
    {"name": "fs_read",    "description": "读取文件原文", "arguments": {"path": "string"}},
    {"name": "fs_write",   "description": "整体覆盖写入文件", "arguments": {"path": "string", "content": "string"}},
    {"name": "fs_tree",    "description": "目录树", "arguments": {"path": "string"}},
    {"name": "fs_delete",  "description": "删除文件", "arguments": {"path": "string"}},
    {"name": "log_tail",   "description": "读取模拟器日志尾部（报错/事件/API/数据变更）", "arguments": {"lines": "int", "filter": "string"}},
    {"name": "log_clear",  "description": "清空日志", "arguments": {}},
    {"name": "sim_status", "description": "服务与日志状态", "arguments": {}},
    {"name": "sim_report", "description": "写入一条日志记录", "arguments": {"kind": "string", "level": "string", "message": "string"}},
]

def mcp_dispatch(body):
    """JSON-RPC 2.0 over HTTP —— 与 lite-widget MCP 同协议。"""
    method = body.get("method")
    if method == "ping":
        return {"jsonrpc": "2.0", "id": body.get("id"), "result": {"ok": True}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": body.get("id"), "result": {"tools": TOOLS}}
    if method == "tools/call":
        p = body.get("params") or {}
        res = mcp_tool(p.get("name", ""), p.get("arguments", {}))
        txt = json.dumps(res, ensure_ascii=False)
        return {"jsonrpc": "2.0", "id": body.get("id"),
                "result": {"content": [{"type": "text", "text": txt}], "isError": not res.get("ok", False)}}
    return {"jsonrpc": "2.0", "id": body.get("id"),
            "error": {"code": -32601, "message": "method not found: %s" % method}}

# ---------------------------------------------------------------- HTTP
class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def log_message(self, format, *args):  # 静默访问日志
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        h = self.headers.get("Authorization", "")
        return h.startswith("Bearer ") and hmac.compare_digest(h[7:].strip(), TOKEN)

    def do_OPTIONS(self):
        self._send(204, b"")

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/health":
            return self._send(200, {"ok": True, "name": "lite-sim", "version": "0.1.0", "token": TOKEN})
        if u.path == "/mcp":
            return self._send(405, {"error": "用 POST"})
        # 静态网页
        if u.path in ("/", "/index.html"):
            fp = os.path.join(WEB, "index.html")
            if os.path.isfile(fp):
                return self._send(200, open(fp, encoding="utf-8").read(), "text/html; charset=utf-8")
            return self._send(404, {"error": "web/index.html 不存在"})
        if u.path.startswith("/web/"):
            fp = safe_path(u.path[1:])
            if fp and os.path.isfile(fp):
                ctype = "application/javascript; charset=utf-8"
                if fp.endswith(".css"): ctype = "text/css; charset=utf-8"
                if fp.endswith(".html"): ctype = "text/html; charset=utf-8"
                if fp.endswith(".json"): ctype = "application/json; charset=utf-8"
                return self._send(200, open(fp, encoding="utf-8", errors="replace").read(), ctype)
            return self._send(404, {"error": "not found"})
        # API：读文件 / 读日志（网页同源可读，AI 走 /mcp）
        if u.path == "/api/files":
            path = (q.get("path") or [""])[0]
            return self._send(200, fs_read(unquote(path)))
        if u.path == "/api/projects":
            # 列出 ~/hw_watch 下的被调试项目（含 entry/src/main/js/MainAbility 才算）
            base = os.path.join(os.path.expanduser("~"), "hw_watch")
            out = []
            if os.path.isdir(base):
                for n in sorted(os.listdir(base)):
                    d = os.path.join(base, n, "entry/src/main/js/MainAbility")
                    if os.path.isdir(d):
                        out.append({"name": n, "base": d,
                                    "files": sum(len(f) for _, _, f in os.walk(d))})
            return self._send(200, {"ok": True, "projects": out})
        if u.path == "/api/tree":
            return self._send(200, fs_tree((q.get("path") or [""])[0]))
        if u.path == "/api/logs":
            r = read_logs(int((q.get("lines") or ["200"])[0]), (q.get("filter") or [""])[0])
            return self._send(200, {"ok": True, "logs": r})
        if u.path == "/api/res":
            # 应用内静态资源（/common/image/…）：浏览器直连会 404，
            # 由服务端读文件返回，模拟器里的 <image> 才能显示
            proj = (q.get("project") or [""])[0]
            rel = unquote((q.get("path") or [""])[0])
            base = os.path.join(os.path.expanduser("~"), "hw_watch", proj,
                                "entry/src/main/js/MainAbility")
            fp = safe_path(os.path.join(base, rel)) if rel else None
            if not fp or not os.path.isfile(fp) or not fp.startswith(os.path.realpath(base)):
                return self._send(404, {"ok": False, "error": "资源不存在: " + rel})
            ctype = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                     ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml",
                     ".json": "application/json", ".txt": "text/plain; charset=utf-8",
                     ".css": "text/css", ".js": "application/javascript"}.get(
                         os.path.splitext(fp)[1].lower(), "application/octet-stream")
            data = open(fp, "rb").read()
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "max-age=60")
            self.end_headers()
            self.wfile.write(data)
            return
        if u.path == "/api/source":
            # 给网页一次性拉取被调试项目的页面源码
            return self._send(200, self._source_bundle(q))
        return self._send(404, {"error": "not found: " + u.path})

    def _source_bundle(self, q):
        proj = (q.get("project") or ["memo-todo"])[0]
        base = os.path.join(os.path.expanduser("~"), "hw_watch", proj, "entry/src/main/js/MainAbility")
        if not os.path.isdir(base):
            return {"ok": False, "error": "项目不存在: %s" % base, "base": base}
        files = {}
        for dirpath, dirs, fns in os.walk(base):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for fn in fns:
                if fn.endswith((".hml", ".css", ".js")):
                    fp = os.path.join(dirpath, fn)
                    rel = os.path.relpath(fp, base)
                    try:
                        files[rel] = open(fp, encoding="utf-8", errors="replace").read()
                    except Exception as e:
                        files[rel] = "/* 读取失败: %s */" % e
        return {"ok": True, "project": proj, "base": base, "files": files,
                "count": len(files), "ts": time.strftime("%H:%M:%S")}

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            return self._send(413, {"error": "body too large"})
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return self._send(400, {"error": "invalid json"})
        if u.path == "/mcp":
            if not self._auth():
                return self._send(401, {"error": "unauthorized"})
            return self._send(200, mcp_dispatch(body))
        if u.path == "/api/log":        # 网页上报
            rec = body if isinstance(body, dict) else {"message": str(body)}
            path = append_log(rec)
            return self._send(200, {"ok": True, "file": path})
        if u.path == "/api/logs":       # 批量上报
            items = body if isinstance(body, list) else [body]
            for it in items: append_log(it)
            return self._send(200, {"ok": True, "count": len(items)})
        if u.path == "/api/files":      # 网页写文件
            return self._send(200, fs_write(body.get("path", ""), body.get("content", "")))
        return self._send(404, {"error": "not found: " + u.path})

    def do_PUT(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return self._send(400, {"error": "invalid json"})
        if urlparse(self.path).path == "/api/files":
            return self._send(200, fs_write(body.get("path", ""), body.get("content", "")))
        return self._send(404, {"error": "not found"})

    def do_DELETE(self):
        q = parse_qs(urlparse(self.path).query)
        if urlparse(self.path).path == "/api/files":
            return self._send(200, fs_delete((q.get("path") or [""])[0]))
        return self._send(404, {"error": "not found"})

if __name__ == "__main__":
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), H)
    print("lite-sim server")
    print("  网页   http://127.0.0.1:%d/" % PORT)
    print("  MCP    POST http://127.0.0.1:%d/mcp  (Bearer %s)" % (PORT, TOKEN))
    print("  日志   %s" % LOGDIR)
    print("  源码   ~/hw_watch/<project>/entry/src/main/js/MainAbility")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
