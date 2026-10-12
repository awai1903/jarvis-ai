#!/usr/bin/env python3
"""Jarvis phone bridge.

A tiny, dependency-free HTTP server that turns the tools in tools.json into
real actions on an Android phone through the Termux:API add-on. It also serves
the Jarvis web app, so on the phone everything is same-origin and the app can be
installed as an app straight from http://127.0.0.1:8787/.

Personal use only: it binds to the loopback address by default, requires a
token for every /api call, restricts file access to the home folder and shared
storage, and never runs a command through a shell unless the tool explicitly
says so (kind "shell").

    python3 jarvis_bridge.py                 # serve on 127.0.0.1:8787
    python3 jarvis_bridge.py --dry-run       # show what would run, run nothing
    python3 jarvis_bridge.py --list-tools    # print the tool table
"""

import argparse
import json
import mimetypes
import os
import re
import secrets
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

VERSION = 1
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_ROOT = os.path.dirname(HERE)          # the app folder (index.html lives here)
JARVIS_HOME = os.path.expanduser(os.environ.get("JARVIS_HOME", "~/.jarvis"))
NOTES_FILE = os.path.join(JARVIS_HOME, "notes.json")
MAX_BODY = 64 * 1024                          # request body cap
MAX_OUTPUT = 8000                             # characters returned per tool
RUN_TIMEOUT = 25                               # seconds per tool call

# Files may only be read or listed inside these folders.
def _path_roots():
    home = os.path.expanduser("~")
    candidates = [
        home,
        os.path.join(home, "storage", "shared"),
        JARVIS_HOME,                       # the app's own folder (notes, logs)
        "/sdcard",
        "/storage/emulated/0",
    ]
    roots = []
    for path in candidates:
        real = os.path.realpath(path)
        if len(real) > 4 and real != "/":  # never hand out the whole filesystem
            roots.append(real)
    return roots


def load_tools():
    with open(os.path.join(HERE, "tools.json"), "r", encoding="utf-8") as fh:
        return json.load(fh)["tools"]


TOOLS = load_tools()
BY_NAME = {t["name"]: t for t in TOOLS}


# --------------------------------------------------------------- validation
def _check_type(spec, value):
    kind = spec.get("type", "string")
    if kind == "integer":
        if isinstance(value, bool):
            raise ValueError("expected a number")
        try:
            return int(value)
        except (TypeError, ValueError):
            raise ValueError("expected a number")
    if kind == "boolean":
        if isinstance(value, bool):
            return value
        raise ValueError("expected true or false")
    if value is None:
        raise ValueError("expected text")
    if not isinstance(value, str):
        value = str(value)
    return value


def clean_args(tool, raw):
    """Validate and normalise the model's arguments. Raises ValueError."""
    raw = raw or {}
    if not isinstance(raw, dict):
        raise ValueError("arguments must be an object")
    specs = {a["name"]: a for a in tool.get("args", [])}
    for key in raw:
        if key not in specs:
            raise ValueError("unknown argument '%s'" % key)
    out = {}
    for name, spec in specs.items():
        if name in raw and raw[name] is not None:
            value = _check_type(spec, raw[name])
        elif "default" in spec:
            value = _check_type(spec, spec["default"])
        elif spec.get("required"):
            raise ValueError("missing required argument '%s'" % name)
        else:
            continue
        if isinstance(value, str) and "max" in spec and len(value) > spec["max"]:
            raise ValueError("'%s' is longer than %d characters" % (name, spec["max"]))
        if isinstance(value, int) and not isinstance(value, bool):
            if "min" in spec and value < spec["min"]:
                raise ValueError("'%s' must be at least %d" % (name, spec["min"]))
            if "max" in spec and spec["type"] == "integer" and value > spec["max"]:
                raise ValueError("'%s' must be at most %d" % (name, spec["max"]))
        if spec.get("enum") and str(value) not in [str(x) for x in spec["enum"]]:
            raise ValueError("'%s' must be one of: %s" % (name, ", ".join(map(str, spec["enum"]))))
        if isinstance(value, str) and spec.get("pattern") and not re.match(spec["pattern"], value):
            raise ValueError("'%s' has an unsupported format" % name)
        if spec.get("guard") == "path":
            value = safe_path(value)
        out[name] = value
    return out


def safe_path(value):
    """Expand and confine a user path to the allowed roots."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("empty path")
    expanded = os.path.expanduser(os.path.expandvars(value.strip()))
    real = os.path.realpath(expanded)
    for root in _path_roots():
        if real == root or real.startswith(root.rstrip("/") + "/"):
            return expanded
    raise ValueError("path is outside the folders Jarvis is allowed to touch")


def build_argv(tool, args):
    """Substitute arguments into the command template. No shell, ever."""
    argv = []
    for part in tool.get("argv", []):
        def sub(match):
            name = match.group(1)
            if name == "__ts__":
                return time.strftime("%Y%m%d-%H%M%S")
            return str(args.get(name, ""))
        argv.append(re.sub(r"\{([a-z_]+)\}", sub, part))
    return argv


def argv_for(tool, args):
    if tool["name"] == "camera_photo" and not args.get("path"):
        args = dict(args, path=os.path.join(os.path.expanduser("~"), "storage", "pictures",
                                            "jarvis-%s.jpg" % time.strftime("%Y%m%d-%H%M%S")))
    cmd = tool.get("cmd", "")
    argv = [cmd] + build_argv(tool, args)
    return argv, args


# ---------------------------------------------------------------- execution
def available(tool, assume_installed=False):
    cmd = tool.get("cmd", "")
    if assume_installed:
        return True, ""
    if not cmd:
        return True, ""
    if shutil.which(cmd):
        return True, ""
    return False, "%s is not installed. Run: pkg install termux-api (and install the Termux:API app)" % cmd


def _truncate(text, limit):
    text = text if isinstance(text, str) else json.dumps(text)
    if len(text) <= limit:
        return text
    return text[:limit] + "\n…[output trimmed]"


def shape_output(tool, text):
    limit = min(int(tool.get("maxOutput", MAX_OUTPUT)), MAX_OUTPUT)
    if tool.get("output") == "json":
        try:
            parsed = json.loads(text)
        except ValueError:
            return _truncate(text, limit)
        if isinstance(parsed, list):
            parsed = parsed[:50]
        return _truncate(json.dumps(parsed, ensure_ascii=False, separators=(",", ":")), limit)
    return _truncate(text.strip(), limit)


_notes_lock = threading.Lock()


def _read_notes():
    try:
        with open(NOTES_FILE, "r", encoding="utf-8") as fh:
            data = json.load(fh)
            return data if isinstance(data, list) else []
    except (IOError, OSError, ValueError):
        return []


def _write_notes(notes):
    os.makedirs(JARVIS_HOME, exist_ok=True)
    tmp = NOTES_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(notes, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, NOTES_FILE)


def run_impl(tool, args):
    name = tool.get("impl")
    if name == "note_save":
        with _notes_lock:
            notes = _read_notes()
            notes.append({"ts": int(time.time()), "text": args["text"]})
            _write_notes(notes[-500:])
            return "saved (%d memories kept)" % min(len(notes), 500)
    if name == "note_list":
        with _notes_lock:
            notes = _read_notes()
        if not notes:
            return "nothing remembered yet"
        return "\n".join("- [%s] %s" % (time.strftime("%Y-%m-%d %H:%M", time.localtime(n["ts"])), n["text"])
                         for n in notes[-100:])
    raise ValueError("unknown implementation")


def execute(tool, args, dry_run=False, assume_installed=False):
    """Run one tool. Returns (ok, payload)."""
    ok, why = available(tool, assume_installed)
    if not ok and tool.get("kind") != "impl":
        return False, {"error": why}
    if tool.get("kind") == "impl":
        if dry_run:
            return True, {"dryRun": True, "argv": [], "output": "(dry run)"}
        try:
            return True, {"output": run_impl(tool, args)}
        except Exception as exc:                                  # noqa: BLE001
            return False, {"error": "%s: %s" % (type(exc).__name__, exc)}

    argv, args = argv_for(tool, args)
    if dry_run or (assume_installed and not shutil.which(tool.get("cmd", ""))):
        return True, {"dryRun": True, "argv": argv, "output": "(dry run)"}
    try:
        proc = subprocess.run(                     # no shell=True on purpose
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=RUN_TIMEOUT,
        )
    except FileNotFoundError:
        return False, {"error": "%s not found" % argv[0]}
    except subprocess.TimeoutExpired:
        return False, {"error": "%s did not finish in %ds" % (argv[0], RUN_TIMEOUT)}
    except OSError as exc:
        return False, {"error": str(exc)}
    out = proc.stdout.decode("utf-8", "replace")
    err = proc.stderr.decode("utf-8", "replace").strip()
    if proc.returncode != 0:
        return False, {"error": (err or out or "command failed").strip()[:500], "exit": proc.returncode}
    text = shape_output(tool, out)
    if not text:
        text = "done"
    return True, {"output": text, "argv": argv}


# ------------------------------------------------------------------- token
def load_token(path, create=True):
    env = os.environ.get("JARVIS_TOKEN")
    if env:
        return env.strip()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            token = fh.read().strip()
        if token:
            return token
    except (IOError, OSError):
        pass
    if not create:
        return ""
    token = secrets.token_urlsafe(24)
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(token + "\n")
    return token


# ------------------------------------------------------------------ server
class Handler(BaseHTTPRequestHandler):
    server_version = "JarvisBridge/%d" % VERSION
    protocol_version = "HTTP/1.1"

    # -- helpers
    def log_message(self, fmt, *a):                                # keep logs short
        sys.stderr.write("[bridge] %s - %s\n" % (self.address_string(), fmt % a))

    def _cors(self):
        raw = self.headers.get("Origin", "")
        origin = ""
        if raw:
            if raw in self.server.allow_origins or "*" in self.server.allow_origins:
                origin = raw
            elif raw.startswith("http://localhost") or raw.startswith("http://127.0.0.1"):
                origin = raw                       # the phone's own loopback is always fine
        headers = {
            "Access-Control-Allow-Private-Network": "true",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, X-Jarvis-Token",
            "Access-Control-Max-Age": "600",
            "Vary": "Origin",
        }
        if origin:
            headers["Access-Control-Allow-Origin"] = origin
        return headers

    def _send(self, code, body, ctype="application/json; charset=utf-8", extra=None):
        if code in (204, 304):
            body = b""
        if not isinstance(body, (bytes, bytearray)):
            body = (json.dumps(body, ensure_ascii=False) if ctype.startswith("application/json")
                    else str(body)).encode("utf-8")
        # One request per connection, deliberately. A hand-rolled server that
        # tries to keep connections alive can misalign the stream when a reply
        # is refused before the request body is read, and the cost of a fresh
        # loopback connection is irrelevant here.
        self.close_connection = True
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        if code not in (204, 304):
            self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.send_header("Cache-Control", "no-store")
        for key, value in self._cors().items():
            self.send_header(key, value)
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code, payload):
        self._send(code, payload)

    def _authed(self):
        if not self.server.token:
            return True                     # --no-token: local demo mode
        token = self.headers.get("X-Jarvis-Token") or ""
        if not token:
            auth = self.headers.get("Authorization", "")
            if auth.lower().startswith("bearer "):
                token = auth[7:].strip()
        if self.server.token and secrets.compare_digest(token, self.server.token):
            return True
        self._json(401, {"ok": False, "error": "bad or missing token"})
        return False

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length > MAX_BODY:
            # Refuse without reading the rest. On a keep-alive connection the
            # unread bytes would otherwise be parsed as the next request, which
            # silently corrupts later replies, so ask the client to hang up.
            self._send(413, {"ok": False, "error": "body too large"})
            return None
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            self._json(400, {"ok": False, "error": "body is not valid JSON"})
            return None

    # -- routes
    def do_OPTIONS(self):
        self._send(204, b"")

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path == "/api/health":
            self._json(200, {
                "ok": True,
                "name": "jarvis-bridge",
                "version": VERSION,
                "dryRun": self.server.dry_run,
                "android": os.path.isdir("/system/bin"),
                "tools": len(TOOLS),
                "installed": sum(1 for t in TOOLS if available(t, self.server.assume_installed)[0]),
                "notes": len(_read_notes()),
                "tokenRequired": bool(self.server.token),
                "servedBy": self.server.root,
            })
            return
        if path == "/api/tools":
            if not self._authed():
                return
            out = []
            for tool in TOOLS:
                ok, why = available(tool, self.server.assume_installed)
                out.append({
                    "type": "function",
                    "function": {
                        "name": tool["name"],
                        "description": tool["description"],
                        "parameters": {
                            "type": "object",
                            "properties": {
                                a["name"]: dict(
                                    {k: v for k, v in a.items() if k in ("type", "description", "enum", "default")},
                                    **({"minimum": a["min"]} if "min" in a else {}),
                                    **({"maximum": a["max"]} if "max" in a else {}),
                                )
                                for a in tool.get("args", [])
                            },
                            "required": [a["name"] for a in tool.get("args", []) if a.get("required")] or [],
                        },
                    },
                    "title": tool.get("title", tool["name"]),
                    "group": tool.get("group", "Other"),
                    "danger": bool(tool.get("danger")),
                    "defaultOff": bool(tool.get("defaultOff")),
                    "available": ok,
                    "unavailableReason": why,
                })
            self._json(200, {"ok": True, "tools": out})
            return
        if path.startswith("/api/"):
            self._json(404, {"ok": False, "error": "unknown endpoint"})
            return
        self._static(path)

    def do_POST(self):
        path = unquote(urlparse(self.path).path)
        if path != "/api/exec":
            self._json(404, {"ok": False, "error": "unknown endpoint"})
            return
        if not self._authed():
            return
        payload = self._body()
        if payload is None:
            return
        name = payload.get("name")
        tool = BY_NAME.get(name)
        if not tool:
            self._json(404, {"ok": False, "error": "unknown tool '%s'" % name})
            return
        try:
            args = clean_args(tool, payload.get("arguments") or payload.get("args") or {})
        except ValueError as exc:
            self._json(400, {"ok": False, "error": "%s: %s" % (name, exc)})
            return
        started = time.time()
        ok, result = execute(tool, args, self.server.dry_run, self.server.assume_installed)
        result.update({"ok": ok, "name": name, "ms": int((time.time() - started) * 1000)})
        if not ok:
            self.log_message("tool %s failed: %s", name, result.get("error"))
        self._json(200, result)

    # -- static app
    def _static(self, path):
        root = self.server.root
        if path.endswith("/"):
            path += "index.html"
        target = os.path.realpath(os.path.join(root, path.lstrip("/")))
        if target != root and not target.startswith(root.rstrip("/") + "/"):
            self._send(403, "Forbidden", "text/plain; charset=utf-8")
            return
        if os.path.isdir(target):
            self._send(302, b"", extra={"Location": path + "/"})
            return
        if not os.path.isfile(target):
            self._send(404, "Not found", "text/plain; charset=utf-8")
            return
        ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
        if target.endswith(".webmanifest"):
            ctype = "application/manifest+json"
        if ctype.startswith("text/") or target.endswith((".js", ".mjs", ".json", ".webmanifest", ".svg")):
            ctype += "; charset=utf-8"
        try:
            with open(target, "rb") as fh:
                body = fh.read()
        except OSError as exc:
            self._send(500, str(exc), "text/plain; charset=utf-8")
            return
        if target.endswith("index.html"):
            # Every client is told that these files came from the bridge (so the
            # app can point itself at the right address). Only a loopback client
            # is handed the token: that is this phone, nobody else.
            body = self._inject_scripts(body)
        extra = {"Service-Worker-Allowed": "/"}
        self._send(200, body, ctype, extra)

    def _is_loopback(self):
        return self.client_address[0] in ("127.0.0.1", "::1")

    def _inject_scripts(self, body):
        marker = b"</head>"
        if marker not in body:
            return body
        head = '<meta name="jarvis-bridge" content="1">\n'
        if self._is_loopback() and self.server.token:
            head += '<script>window.JARVIS_BRIDGE_TOKEN=%s;</script>\n' % json.dumps(self.server.token)
        return body.replace(marker, (head + "</head>").encode("utf-8"), 1)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Jarvis phone bridge (Termux:API)")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (default: loopback only)")
    ap.add_argument("--port", type=int, default=8787, help="0 picks a free port (the chosen one is printed)")
    ap.add_argument("--root", default=DEFAULT_ROOT, help="folder with the app files to serve")
    ap.add_argument("--token", default="", help="fixed token (default: read/create a random one)")
    ap.add_argument("--token-file", default=os.path.join(JARVIS_HOME, "token"))
    ap.add_argument("--allow-origin", action="append", default=[],
                    help="extra web origin allowed to call the API (repeatable, can be '*')")
    ap.add_argument("--dry-run", action="store_true", help="validate and show the command, run nothing")
    ap.add_argument("--assume-installed", action="store_true", help="pretend the Termux:API commands exist")
    ap.add_argument("--no-token", action="store_true",
                    help="accept every /api call without a token: local demos ONLY, never on a phone")
    ap.add_argument("--list-tools", action="store_true", help="print the tool table and exit")
    args = ap.parse_args(argv)

    if args.list_tools:
        for tool in TOOLS:
            ok, why = available(tool, args.assume_installed)
            print("%-18s %-16s %-6s %s" % (tool["name"], tool.get("group", ""),
                                           "ready" if ok else "missing", tool.get("title", "")))
            if why:
                print("%-18s %s" % ("", why))
        return 0

    root = os.path.realpath(args.root)
    if not os.path.isfile(os.path.join(root, "index.html")):
        print("warning: %s has no index.html, only the API will be served" % root, file=sys.stderr)

    token = "" if args.no_token else (args.token.strip() or load_token(args.token_file))
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.root = root
    httpd.token = token
    httpd.dry_run = args.dry_run
    httpd.assume_installed = args.assume_installed
    httpd.allow_origins = args.allow_origin
    httpd.daemon_threads = True

    port = httpd.server_address[1]
    ready = sum(1 for t in TOOLS if available(t, args.assume_installed)[0])
    print("Jarvis bridge %d on http://%s:%d" % (VERSION, args.host, port), flush=True)
    print("  app folder : %s" % root, flush=True)
    print("  tools      : %d ready of %d" % (ready, len(TOOLS)), flush=True)
    print("  dry run    : %s" % ("yes" if args.dry_run else "no"), flush=True)
    print("  token      : %s" % token, flush=True)
    print("  open       : http://127.0.0.1:%d/  (paste the token in Settings > Device)" % port, flush=True)
    if args.host not in ("127.0.0.1", "localhost"):
        print("  note       : reachable from the network - the token is the only protection", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
