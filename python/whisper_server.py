#!/usr/bin/env python3
"""
JustSay - Local ASR HTTP Server

支持双引擎：
- Faster-Whisper
- SenseVoiceSmall (FunAudioLLM/SenseVoiceSmall)
"""

import argparse
import glob
import json
import os
import sys
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

DEFAULT_SENSEVOICE_MODEL_ID = "FunAudioLLM/SenseVoiceSmall"


def add_nvidia_paths():
    """Add NVIDIA library paths to DLL search path for Windows."""
    if os.name != "nt":
        return

    import site

    possible_paths = site.getsitepackages() if hasattr(site, "getsitepackages") else []
    for path in sys.path:
        if "site-packages" in path and os.path.isdir(path) and path not in possible_paths:
            possible_paths.append(path)

    for site_packages in possible_paths:
        nvidia_path = os.path.join(site_packages, "nvidia")
        if not os.path.isdir(nvidia_path):
            continue

        for item in os.listdir(nvidia_path):
            bin_path = os.path.join(nvidia_path, item, "bin")
            if os.path.isdir(bin_path):
                try:
                    os.add_dll_directory(bin_path)
                except Exception:
                    pass
                os.environ["PATH"] = bin_path + os.pathsep + os.environ.get("PATH", "")
        return


add_nvidia_paths()

# Global model instance
_model = None
_model_lock = threading.Lock()
_model_info = {
    "engine": None,
    "model_type": None,
    "sensevoice_model_id": None,
    "device": None,
    "compute_type": None,
    "download_root": None,
}
_runtime_policy = {
    "engine": "faster-whisper",
    "lock_model": False,
    "lock_device_compute": False,
    "lock_language": False,
    "default_model_type": "tiny",
    "default_language": None,
    "sensevoice_model_id": DEFAULT_SENSEVOICE_MODEL_ID,
    "sensevoice_use_itn": True,
    "device": "cpu",
    "compute_type": "int8",
}


def parse_bool(value, default=False):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def ensure_download_env(download_root: str | None):
    if not download_root:
        return
    os.makedirs(download_root, exist_ok=True)
    os.environ["HF_HOME"] = download_root
    os.environ["MODELSCOPE_CACHE"] = download_root


def load_faster_whisper_model(model_type: str, device: str, compute_type: str, download_root: str | None):
    from faster_whisper import WhisperModel

    return WhisperModel(
        model_type,
        device=device,
        compute_type=compute_type,
        download_root=download_root,
    )


def load_sensevoice_model(sensevoice_model_id: str, device: str, download_root: str | None):
    from funasr import AutoModel

    ensure_download_env(download_root)
    resolved_device = resolve_sensevoice_device(device)
    return AutoModel(
        model=sensevoice_model_id,
        device=resolved_device,
        hub="hf",
        disable_update=True,
    )


def resolve_sensevoice_device(device: str) -> str:
    if device != "cuda":
        return "cpu"
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda:0"
        print(
            "[Server] CUDA requested for SenseVoice but torch CUDA is unavailable, falling back to CPU",
            flush=True,
        )
        return "cpu"
    except Exception as exc:
        print(
            f"[Server] Failed to validate torch CUDA for SenseVoice ({exc}), falling back to CPU",
            flush=True,
        )
        return "cpu"


def get_model(
    engine: str,
    model_type: str,
    sensevoice_model_id: str,
    device: str,
    compute_type: str,
    download_root: str | None,
):
    """Get or create the model singleton."""
    global _model, _model_info

    with _model_lock:
        need_reload = (
            _model is None
            or _model_info["engine"] != engine
            or _model_info["model_type"] != model_type
            or _model_info["sensevoice_model_id"] != sensevoice_model_id
            or _model_info["device"] != device
            or _model_info["compute_type"] != compute_type
            or _model_info["download_root"] != download_root
        )

        if need_reload:
            if engine == "sensevoice":
                print(
                    f"[Server] Loading model: engine={engine}, model={sensevoice_model_id}, "
                    f"device={device}, compute={compute_type}",
                    flush=True,
                )
                _model = load_sensevoice_model(sensevoice_model_id, device, download_root)
            else:
                print(
                    f"[Server] Loading model: engine={engine}, model={model_type}, "
                    f"device={device}, compute={compute_type}",
                    flush=True,
                )
                _model = load_faster_whisper_model(model_type, device, compute_type, download_root)

            _model_info.update(
                {
                    "engine": engine,
                    "model_type": model_type,
                    "sensevoice_model_id": sensevoice_model_id,
                    "device": device,
                    "compute_type": compute_type,
                    "download_root": download_root,
                }
            )
            print("[Server] Model loaded successfully", flush=True)

        return _model


def detect_gpu():
    """Detect CUDA availability."""
    result = {
        "cuda_available": False,
        "device_name": None,
        "recommended_device": "cpu",
        "recommended_compute_type": "int8",
    }

    try:
        import ctranslate2

        cuda_device_count = ctranslate2.get_cuda_device_count()
        if cuda_device_count > 0:
            result["cuda_available"] = True
            result["device_name"] = f"CUDA device (count: {cuda_device_count})"
            result["recommended_device"] = "cuda"
            result["recommended_compute_type"] = "float16"
    except Exception:
        pass

    return result


def collect_candidate_library_dirs():
    """Collect candidate library directories for NVIDIA runtime libs."""
    dirs = []

    def add_dir(path):
        if path and os.path.isdir(path) and path not in dirs:
            dirs.append(path)

    ld_library_path = os.environ.get("LD_LIBRARY_PATH", "")
    if ld_library_path:
        for entry in ld_library_path.split(os.pathsep):
            add_dir(entry)

    possible_site_packages = []
    try:
        import site

        if hasattr(site, "getsitepackages"):
            possible_site_packages.extend(site.getsitepackages())
        if hasattr(site, "getusersitepackages"):
            user_site = site.getusersitepackages()
            if user_site:
                possible_site_packages.append(user_site)
    except Exception:
        pass

    for path in sys.path:
        if "site-packages" in path:
            possible_site_packages.append(path)

    unique_site_packages = []
    for path in possible_site_packages:
        if path and path not in unique_site_packages:
            unique_site_packages.append(path)

    for site_packages in unique_site_packages:
        nvidia_root = os.path.join(site_packages, "nvidia")
        if not os.path.isdir(nvidia_root):
            continue
        for pkg in ("cublas", "cudnn"):
            for subdir in ("lib", "lib64", "bin"):
                add_dir(os.path.join(nvidia_root, pkg, subdir))

    return dirs


def find_first_library(candidate_dirs, patterns):
    """Find first library file matching any glob pattern under candidate dirs."""
    for directory in candidate_dirs:
        for pattern in patterns:
            matches = sorted(glob.glob(os.path.join(directory, pattern)))
            if matches:
                return matches[0]
    return None


def log_runtime_library_diagnostics():
    """Log runtime library env and detected NVIDIA runtime libraries."""
    ld_library_path = os.environ.get("LD_LIBRARY_PATH", "")
    print(f"[Server] LD_LIBRARY_PATH: {ld_library_path or '(empty)'}", flush=True)

    candidate_dirs = collect_candidate_library_dirs()
    if not candidate_dirs:
        print("[Server] No candidate NVIDIA library directories found", flush=True)
    else:
        max_preview = 8
        preview_dirs = candidate_dirs[:max_preview]
        for directory in preview_dirs:
            print(f"[Server] LibDir: {directory}", flush=True)
        if len(candidate_dirs) > max_preview:
            print(f"[Server] LibDir: ... ({len(candidate_dirs) - max_preview} more)", flush=True)

    cublas_path = find_first_library(candidate_dirs, ["libcublas.so*", "libcublasLt.so*", "cublas64_*.dll"])
    cudnn_path = find_first_library(candidate_dirs, ["libcudnn.so*", "cudnn64_*.dll"])

    print(f"[Server] Resolved cuBLAS: {cublas_path or 'NOT FOUND'}", flush=True)
    print(f"[Server] Resolved cuDNN: {cudnn_path or 'NOT FOUND'}", flush=True)


def transcribe_with_faster_whisper(model, temp_path: str, language: str | None):
    options = {"beam_size": 5, "vad_filter": True, "vad_parameters": {"min_silence_duration_ms": 500}}
    if language and language != "auto":
        options["language"] = language

    segments, info = model.transcribe(temp_path, **options)
    text = " ".join(seg.text.strip() for seg in segments).strip()
    return {
        "text": text,
        "language": info.language,
        "language_probability": info.language_probability,
        "duration": info.duration,
    }


def transcribe_with_sensevoice(model, temp_path: str, language: str | None, sensevoice_use_itn: bool):
    from funasr.utils.postprocess_utils import rich_transcription_postprocess

    final_language = language if language and language != "auto" else "auto"
    result = model.generate(
        input=temp_path,
        cache={},
        language=final_language,
        use_itn=sensevoice_use_itn,
        batch_size_s=60,
    )

    item = None
    if isinstance(result, list) and result:
        item = result[0]
        if isinstance(item, list) and item:
            item = item[0]

    text_raw = ""
    if isinstance(item, dict):
        text_raw = item.get("text", "") or ""
    elif item is not None:
        text_raw = str(item)

    text = rich_transcription_postprocess(text_raw) if text_raw else ""
    detected_language = None
    if isinstance(item, dict):
        detected_language = item.get("language") or item.get("lang")

    return {"text": text, "language": detected_language or final_language, "language_probability": None, "duration": None}


class WhisperHandler(BaseHTTPRequestHandler):
    """HTTP request handler."""

    def log_message(self, fmt, *args):
        print(f"[HTTP] {args[0]}", flush=True)

    def send_json(self, data: dict, status: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)

        if parsed.path == "/health":
            self.send_json(
                {
                    "status": "ok",
                    "model_loaded": _model is not None,
                    "runtime_policy": {
                        "engine": _runtime_policy["engine"],
                        "lock_model": _runtime_policy["lock_model"],
                        "lock_device_compute": _runtime_policy["lock_device_compute"],
                        "lock_language": _runtime_policy["lock_language"],
                        "default_model_type": _runtime_policy["default_model_type"],
                        "default_language": _runtime_policy["default_language"],
                        "sensevoice_model_id": _runtime_policy["sensevoice_model_id"],
                        "sensevoice_use_itn": _runtime_policy["sensevoice_use_itn"],
                        "device": _runtime_policy["device"],
                        "compute_type": _runtime_policy["compute_type"],
                    },
                }
            )
        elif parsed.path == "/gpu":
            self.send_json(detect_gpu())
        elif parsed.path == "/model/info":
            self.send_json({"loaded": _model is not None, **_model_info})
        else:
            self.send_json({"error": "Not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/transcribe":
            self.handle_transcribe()
        elif parsed.path == "/model/load":
            self.handle_load_model()
        elif parsed.path == "/model/unload":
            self.handle_unload_model()
        else:
            self.send_json({"error": "Not found"}, 404)

    def handle_transcribe(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            content_type = self.headers.get("Content-Type", "")

            if "multipart/form-data" in content_type:
                result = self.handle_multipart_transcribe(content_length)
            elif "application/json" in content_type:
                body = self.rfile.read(content_length)
                data = json.loads(body.decode("utf-8"))
                result = self.transcribe_from_json(data)
            elif "audio/" in content_type or "application/octet-stream" in content_type:
                audio_data = self.rfile.read(content_length)
                params = parse_qs(urlparse(self.path).query)
                result = self.transcribe_audio(audio_data, params)
            else:
                self.send_json({"error": f"Unsupported content type: {content_type}"}, 400)
                return

            self.send_json(result)
        except Exception as exc:
            self.send_json({"success": False, "error": str(exc), "text": ""}, 500)

    def transcribe_audio(self, audio_data: bytes, params: dict) -> dict:
        start_time = time.time()

        default_engine = _model_info["engine"] or _runtime_policy["engine"] or "faster-whisper"
        default_model_type = _model_info["model_type"] or _runtime_policy["default_model_type"] or "tiny"
        default_sensevoice_model_id = _model_info["sensevoice_model_id"] or _runtime_policy["sensevoice_model_id"]
        default_device = _model_info["device"] or _runtime_policy["device"] or "cpu"
        default_compute_type = _model_info["compute_type"] or _runtime_policy["compute_type"] or "int8"
        default_language = _runtime_policy["default_language"]
        default_sensevoice_use_itn = _runtime_policy["sensevoice_use_itn"]

        requested_engine = params.get("engine", [default_engine])[0]
        requested_model_type = params.get("model", [default_model_type])[0]
        requested_sensevoice_model_id = params.get("sensevoice_model_id", [default_sensevoice_model_id])[0]
        requested_sensevoice_use_itn = parse_bool(
            params.get("sensevoice_use_itn", [default_sensevoice_use_itn])[0],
            default_sensevoice_use_itn,
        )
        requested_device = params.get("device", [default_device])[0]
        requested_compute_type = params.get("compute_type", [default_compute_type])[0]
        requested_language = params.get("language", [default_language])[0]
        download_root = params.get("download_root", [None])[0]

        if _runtime_policy["lock_model"]:
            engine = default_engine
            model_type = default_model_type
            sensevoice_model_id = default_sensevoice_model_id
            sensevoice_use_itn = default_sensevoice_use_itn
        else:
            engine = requested_engine
            model_type = requested_model_type
            sensevoice_model_id = requested_sensevoice_model_id
            sensevoice_use_itn = requested_sensevoice_use_itn

        if _runtime_policy["lock_language"]:
            language = default_language
        else:
            language = requested_language

        if _runtime_policy["lock_device_compute"]:
            requested_device = _runtime_policy["device"]
            compute_type = _runtime_policy["compute_type"]
        else:
            compute_type = requested_compute_type

        if engine == "sensevoice":
            resolved_sensevoice_device = resolve_sensevoice_device(requested_device)
            device = "cuda" if resolved_sensevoice_device.startswith("cuda") else "cpu"
        else:
            device = requested_device

        ensure_download_env(download_root)

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_file:
            tmp_file.write(audio_data)
            temp_path = tmp_file.name

        try:
            model = get_model(
                engine=engine,
                model_type=model_type,
                sensevoice_model_id=sensevoice_model_id,
                device=device,
                compute_type=compute_type,
                download_root=download_root,
            )

            if engine == "sensevoice":
                payload = transcribe_with_sensevoice(model, temp_path, language, sensevoice_use_itn)
            else:
                payload = transcribe_with_faster_whisper(model, temp_path, language)

            return {
                "success": True,
                "text": payload["text"],
                "language": payload.get("language"),
                "language_probability": payload.get("language_probability"),
                "duration": payload.get("duration"),
                "processing_time": time.time() - start_time,
                "engine": engine,
                "model": model_type if engine == "faster-whisper" else sensevoice_model_id,
                "device": device,
                "compute_type": compute_type,
            }
        except Exception as exc:
            model_name = model_type if engine == "faster-whisper" else sensevoice_model_id
            print(
                f"[Server] Transcribe failed: engine={engine}, model={model_name}, device={device}, "
                f"compute_type={compute_type}, error={exc}",
                flush=True,
            )
            traceback.print_exc()
            return {
                "success": False,
                "text": "",
                "error": str(exc),
                "processing_time": time.time() - start_time,
                "engine": engine,
                "model": model_name,
                "device": device,
                "compute_type": compute_type,
                "language": language,
            }
        finally:
            try:
                os.unlink(temp_path)
            except Exception:
                pass

    def transcribe_from_json(self, data: dict) -> dict:
        import base64

        audio_b64 = data.get("audio")
        if not audio_b64:
            return {"success": False, "error": "Missing audio field", "text": ""}

        audio_data = base64.b64decode(audio_b64)
        params = {
            "engine": [data.get("engine", _runtime_policy["engine"])],
            "model": [data.get("model", _runtime_policy["default_model_type"])],
            "sensevoice_model_id": [data.get("sensevoice_model_id", _runtime_policy["sensevoice_model_id"])],
            "sensevoice_use_itn": [data.get("sensevoice_use_itn", _runtime_policy["sensevoice_use_itn"])],
            "device": [data.get("device", _runtime_policy["device"])],
            "compute_type": [data.get("compute_type", _runtime_policy["compute_type"])],
            "language": [data.get("language")],
            "download_root": [data.get("download_root")],
        }
        return self.transcribe_audio(audio_data, params)

    def handle_multipart_transcribe(self, content_length: int) -> dict:
        import re

        body = self.rfile.read(content_length)
        content_type = self.headers.get("Content-Type", "")
        boundary = content_type.split("boundary=")[-1].encode()

        parts = body.split(b"--" + boundary)
        audio_data = None
        params = {}

        for part in parts:
            if b"Content-Disposition" not in part:
                continue

            header_end = part.find(b"\r\n\r\n")
            if header_end == -1:
                continue

            headers = part[:header_end].decode("utf-8", errors="ignore")
            content = part[header_end + 4 :].rstrip(b"\r\n--")

            name_match = re.search(r'name="([^"]+)"', headers)
            if not name_match:
                continue

            name = name_match.group(1)
            if name == "audio" or "filename=" in headers:
                audio_data = content
            else:
                params[name] = [content.decode("utf-8")]

        if not audio_data:
            return {"success": False, "error": "No audio file in request", "text": ""}

        return self.transcribe_audio(audio_data, params)

    def handle_load_model(self):
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_length)
            data = json.loads(body.decode("utf-8")) if body else {}

            engine = data.get("engine", _runtime_policy["engine"])
            model_type = data.get("model", _runtime_policy["default_model_type"])
            sensevoice_model_id = data.get("sensevoice_model_id", _runtime_policy["sensevoice_model_id"])
            sensevoice_use_itn = parse_bool(
                data.get("sensevoice_use_itn", _runtime_policy["sensevoice_use_itn"]),
                _runtime_policy["sensevoice_use_itn"],
            )
            device = data.get("device", _runtime_policy["device"])
            compute_type = data.get("compute_type", _runtime_policy["compute_type"])
            download_root = data.get("download_root")

            if engine == "sensevoice":
                resolved_sensevoice_device = resolve_sensevoice_device(device)
                device = "cuda" if resolved_sensevoice_device.startswith("cuda") else "cpu"

            get_model(
                engine=engine,
                model_type=model_type,
                sensevoice_model_id=sensevoice_model_id,
                device=device,
                compute_type=compute_type,
                download_root=download_root,
            )

            self.send_json(
                {
                    "success": True,
                    "engine": engine,
                    "model": model_type if engine == "faster-whisper" else sensevoice_model_id,
                    "sensevoice_use_itn": sensevoice_use_itn,
                }
            )
        except Exception as exc:
            self.send_json({"success": False, "error": str(exc)}, 500)

    def handle_unload_model(self):
        global _model, _model_info

        with _model_lock:
            _model = None
            _model_info = {
                "engine": None,
                "model_type": None,
                "sensevoice_model_id": None,
                "device": None,
                "compute_type": None,
                "download_root": None,
            }

        self.send_json({"success": True})


class ThreadedHTTPServer(HTTPServer):
    """HTTP server that handles each request in a new thread."""

    def process_request(self, request, client_address):
        thread = threading.Thread(target=self.process_request_thread, args=(request, client_address))
        thread.daemon = True
        thread.start()

    def process_request_thread(self, request, client_address):
        try:
            self.finish_request(request, client_address)
        except Exception:
            self.handle_error(request, client_address)
        finally:
            self.shutdown_request(request)


def main():
    global _runtime_policy

    parser = argparse.ArgumentParser(description="Local ASR HTTP Server")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8765, help="Port to listen on")
    parser.add_argument("--engine", default="faster-whisper", choices=["faster-whisper", "sensevoice"])
    parser.add_argument("--preload-model", help="Pre-load faster-whisper model on startup")
    parser.add_argument(
        "--default-model",
        default="tiny",
        choices=["tiny", "base", "small", "medium", "large-v3"],
        help="Default faster-whisper model used when request does not provide model",
    )
    parser.add_argument("--default-language", help="Default language (e.g. zh, en)")
    parser.add_argument(
        "--sensevoice-model-id",
        default=DEFAULT_SENSEVOICE_MODEL_ID,
        help="SenseVoice model id",
    )
    parser.add_argument(
        "--sensevoice-use-itn",
        default="true",
        help="SenseVoice inverse text normalization (true/false)",
    )
    parser.add_argument(
        "--lock-model",
        action="store_true",
        help="Ignore request engine/model and always use startup values",
    )
    parser.add_argument(
        "--lock-language",
        action="store_true",
        help="Ignore request language and always use server default language",
    )
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument(
        "--lock-device-compute",
        action="store_true",
        help="Ignore request device/compute_type and always use startup values",
    )
    parser.add_argument("--download-root", help="Model cache directory")

    args = parser.parse_args()

    _runtime_policy["engine"] = args.engine
    _runtime_policy["lock_model"] = args.lock_model
    _runtime_policy["lock_device_compute"] = args.lock_device_compute
    _runtime_policy["lock_language"] = args.lock_language
    _runtime_policy["default_model_type"] = args.preload_model or args.default_model
    _runtime_policy["default_language"] = args.default_language
    _runtime_policy["sensevoice_model_id"] = args.sensevoice_model_id
    _runtime_policy["sensevoice_use_itn"] = parse_bool(args.sensevoice_use_itn, True)
    _runtime_policy["device"] = args.device
    _runtime_policy["compute_type"] = args.compute_type

    ensure_download_env(args.download_root)
    print(f"[Server] Python executable: {sys.executable}", flush=True)
    print(f"[Server] Python version: {sys.version.split()[0]}", flush=True)
    log_runtime_library_diagnostics()

    should_preload = args.engine == "sensevoice" or bool(args.preload_model)
    if should_preload:
        model_name = args.preload_model if args.engine == "faster-whisper" else args.sensevoice_model_id
        print(f"[Server] Pre-loading model: engine={args.engine}, model={model_name}", flush=True)
        try:
            preload_device = args.device
            if args.engine == "sensevoice":
                resolved_sensevoice_device = resolve_sensevoice_device(args.device)
                preload_device = "cuda" if resolved_sensevoice_device.startswith("cuda") else "cpu"
            get_model(
                engine=args.engine,
                model_type=args.preload_model or args.default_model,
                sensevoice_model_id=args.sensevoice_model_id,
                device=preload_device,
                compute_type=args.compute_type,
                download_root=args.download_root,
            )
        except Exception as exc:
            print(f"[Server] Failed to pre-load model: {exc}", flush=True)

    server = ThreadedHTTPServer((args.host, args.port), WhisperHandler)
    print(f"[Server] Local ASR HTTP server running on http://{args.host}:{args.port}", flush=True)
    print("[Server] Endpoints:", flush=True)
    print("  GET  /health       - Health check", flush=True)
    print("  GET  /gpu          - Detect GPU", flush=True)
    print("  GET  /model/info   - Current model info", flush=True)
    print("  POST /transcribe   - Transcribe audio", flush=True)
    print("  POST /model/load   - Pre-load model", flush=True)
    print("  POST /model/unload - Unload model", flush=True)

    if args.lock_model or args.lock_device_compute or args.lock_language:
        print(
            f"[Server] Runtime locked: lock_model={args.lock_model}, "
            f"lock_language={args.lock_language}, engine={args.engine}, "
            f"device={args.device}, compute_type={args.compute_type}",
            flush=True,
        )

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Server] Shutting down...", flush=True)
        server.shutdown()


if __name__ == "__main__":
    main()
