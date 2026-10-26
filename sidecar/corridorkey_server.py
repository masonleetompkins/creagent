#!/usr/bin/env python3
"""CorridorKey 2.0 sidecar: HTTP wrapper around infer.py.

Runs on any machine with CorridorKey2.0 checked out (Mac CPU/MPS or a Linux
box with NVIDIA). Creagent talks to it over CORRIDORKEY_URL.

  CORRIDORKEY_DIR=/path/to/CorridorKey2.0 python3 corridorkey_server.py

API:
  POST /key            multipart(video=..., hint=optional png) -> {"job_id": ...}
  GET  /jobs/<id>      -> {"state": "queued|running|done|failed", "error": ...}
  GET  /jobs/<id>/result -> keyed video file (when done)
  GET  /health         -> {"ok": True}

Only stdlib is used so there is nothing to pip install.
"""

import http.server
import json
import mimetypes
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import uuid

CORRIDORKEY_DIR = os.environ.get("CORRIDORKEY_DIR", "")
PORT = int(os.environ.get("CORRIDORKEY_PORT", "8099"))
WORK_DIR = tempfile.mkdtemp(prefix="ck-sidecar-")

JOBS: dict = {}
LOCK = threading.Lock()


def run_key_job(job_id: str, video_path: str, hint_path: str | None) -> None:
    out_dir = os.path.join(WORK_DIR, job_id, "out")
    os.makedirs(out_dir, exist_ok=True)
    infer = os.path.join(CORRIDORKEY_DIR, "infer.py")
    cmd = [sys.executable, infer, "--input", video_path, "--output_dir", out_dir]
    if hint_path:
        cmd += ["--hint_first_frame", hint_path]
    try:
        with LOCK:
            JOBS[job_id]["state"] = "running"
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=6 * 3600)
        if proc.returncode != 0:
            raise RuntimeError((proc.stderr or proc.stdout or "infer failed")[-2000:])
        outputs = [
            os.path.join(out_dir, f)
            for f in os.listdir(out_dir)
            if f.lower().endswith((".mp4", ".mov", ".webm", ".mkv"))
        ]
        if not outputs:
            raise RuntimeError(f"no video output in {out_dir}: {proc.stdout[-500:]}")
        outputs.sort(key=os.path.getmtime, reverse=True)
        with LOCK:
            JOBS[job_id].update({"state": "done", "result": outputs[0]})
    except Exception as exc:  # noqa: BLE001 - reported to the client
        with LOCK:
            JOBS[job_id].update({"state": "failed", "error": str(exc)})


def parse_multipart(body: bytes, boundary: bytes) -> dict:
    parts: dict = {}
    for chunk in body.split(b"--" + boundary):
        if b"\r\n\r\n" not in chunk:
            continue
        head, payload = chunk.split(b"\r\n\r\n", 1)
        payload = payload[: -len(b"\r\n")] if payload.endswith(b"\r\n") else payload
        name = ""
        filename = ""
        for line in head.decode("utf-8", "replace").split("\r\n"):
            low = line.lower()
            if low.startswith("content-disposition"):
                for seg in line.split(";"):
                    seg = seg.strip()
                    if seg.startswith("name="):
                        name = seg[5:].strip('"')
                    elif seg.startswith("filename="):
                        filename = seg[9:].strip('"')
        if name:
            parts[name] = {"filename": filename, "data": payload}
    return parts


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "CorridorKeySidecar/1.0"

    def log_message(self, *args):  # noqa: ANN - quiet
        pass

    def send_json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):  # noqa: N802
        if self.path == "/health":
            ok = bool(CORRIDORKEY_DIR) and os.path.exists(
                os.path.join(CORRIDORKEY_DIR, "infer.py")
            )
            return self.send_json({"ok": ok})
        if self.path.startswith("/jobs/") and self.path.endswith("/result"):
            job_id = self.path[len("/jobs/") : -len("/result")]
            with LOCK:
                job = JOBS.get(job_id)
            if not job or job["state"] != "done":
                return self.send_json({"error": "not ready"}, 404)
            path = job["result"]
            mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(os.path.getsize(path)))
            self.end_headers()
            with open(path, "rb") as fh:
                shutil.copyfileobj(fh, self.wfile)
            return None
        if self.path.startswith("/jobs/"):
            job_id = self.path[len("/jobs/") :]
            with LOCK:
                job = JOBS.get(job_id)
            if not job:
                return self.send_json({"error": "unknown job"}, 404)
            return self.send_json(
                {"state": job["state"], "error": job.get("error")}
            )
        return self.send_json({"error": "not found"}, 404)

    def do_POST(self):  # noqa: N802
        if self.path != "/key":
            return self.send_json({"error": "not found"}, 404)
        length = int(self.headers.get("Content-Length", 0))
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype or "boundary=" not in ctype:
            return self.send_json({"error": "multipart video required"}, 400)
        boundary = ctype.split("boundary=")[1].strip().encode()
        parts = parse_multipart(self.rfile.read(length), boundary)
        if "video" not in parts:
            return self.send_json({"error": "video part required"}, 400)
        job_id = uuid.uuid4().hex
        job_dir = os.path.join(WORK_DIR, job_id)
        os.makedirs(job_dir, exist_ok=True)
        video_path = os.path.join(job_dir, "input" + os.path.splitext(parts["video"]["filename"] or ".mp4")[1])
        with open(video_path, "wb") as fh:
            fh.write(parts["video"]["data"])
        hint_path = None
        if "hint" in parts and parts["hint"]["data"]:
            hint_path = os.path.join(job_dir, "hint.png")
            with open(hint_path, "wb") as fh:
                fh.write(parts["hint"]["data"])
        with LOCK:
            JOBS[job_id] = {"state": "queued"}
        threading.Thread(
            target=run_key_job, args=(job_id, video_path, hint_path), daemon=True
        ).start()
        return self.send_json({"job_id": job_id})


if __name__ == "__main__":
    if not CORRIDORKEY_DIR or not os.path.exists(os.path.join(CORRIDORKEY_DIR, "infer.py")):
        print("set CORRIDORKEY_DIR to a CorridorKey2.0 checkout containing infer.py", file=sys.stderr)
        sys.exit(1)
    with socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler) as httpd:
        print(f"corridorkey sidecar on 127.0.0.1:{PORT} (dir={CORRIDORKEY_DIR})")
        httpd.serve_forever()
