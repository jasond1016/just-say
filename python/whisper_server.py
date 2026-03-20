#!/usr/bin/env python3
"""
JustSay - Local ASR HTTP Server

支持双引擎：
- Faster-Whisper
- SenseVoiceSmall (FunAudioLLM/SenseVoiceSmall)
"""

import argparse
import base64
import json
import logging
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

from websockets.exceptions import InvalidUpgrade
from websockets.sync.server import serve

import asr_engine
from asr_engine import (
    DEFAULT_SENSEVOICE_MODEL_ID,
    detect_gpu,
    ensure_download_env,
    get_model,
    log_runtime_library_diagnostics,
    resolve_sensevoice_device,
    transcribe_audio_payload,
)
from text_processing import parse_bool, parse_positive_int
from ws_streaming import handle_websocket_connection

_ws_server = None


class _SuppressWsInvalidUpgradeFilter(logging.Filter):
    """Suppress noisy traceback logs when plain HTTP hits WS port."""

    def filter(self, record: logging.LogRecord) -> bool:
        if record.exc_info and len(record.exc_info) >= 2:
            exc = record.exc_info[1]
            if isinstance(exc, InvalidUpgrade):
                return False
        return True


def configure_ws_logger() -> logging.Logger:
    logger = logging.getLogger("websockets.server")
    has_filter = any(isinstance(f, _SuppressWsInvalidUpgradeFilter) for f in logger.filters)
    if not has_filter:
        logger.addFilter(_SuppressWsInvalidUpgradeFilter())
    return logger


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
                    "model_loaded": asr_engine._model is not None,
                    "runtime_policy": {
                        "engine": asr_engine._runtime_policy["engine"],
                        "lock_model": asr_engine._runtime_policy["lock_model"],
                        "lock_device_compute": asr_engine._runtime_policy["lock_device_compute"],
                        "lock_language": asr_engine._runtime_policy["lock_language"],
                        "default_model_type": asr_engine._runtime_policy["default_model_type"],
                        "default_language": asr_engine._runtime_policy["default_language"],
                        "sensevoice_model_id": asr_engine._runtime_policy["sensevoice_model_id"],
                        "sensevoice_use_itn": asr_engine._runtime_policy["sensevoice_use_itn"],
                        "sensevoice_vad_model": asr_engine._runtime_policy["sensevoice_vad_model"],
                        "sensevoice_vad_merge": asr_engine._runtime_policy["sensevoice_vad_merge"],
                        "sensevoice_vad_merge_length_s": asr_engine._runtime_policy["sensevoice_vad_merge_length_s"],
                        "sensevoice_vad_max_single_segment_time_ms": asr_engine._runtime_policy[
                            "sensevoice_vad_max_single_segment_time_ms"
                        ],
                        "device": asr_engine._runtime_policy["device"],
                        "compute_type": asr_engine._runtime_policy["compute_type"],
                    },
                }
            )
        elif parsed.path == "/capabilities":
            self.send_json(
                {
                    "streaming_asr": True,
                    "transport": ["http", "websocket"],
                    "events": ["interim", "final_chunk", "sentence", "endpoint", "final", "error"],
                    "audio_format": "pcm_s16le",
                    "sample_rate": 16000,
                    "ws_path": "/stream",
                    "ws_port": asr_engine._runtime_policy["ws_port"],
                    "interim_schema": {
                        "previewText": "Current sliding-window preview guess; may be rewritten between revisions",
                        "pendingText": "Current uncommitted buffer snapshot after preview accumulation",
                        "commitReadyText": "Conservative prefix within pendingText that is safe to commit",
                        "unstableTailText": "Tail of pendingText that remains unstable",
                        "revision": "Monotonic revision number within the current live buffer",
                        "wordTimings": "Optional per-word timings for the current preview window when return_word_timestamps=true and engine supports it",
                    },
                    "final_chunk_schema": {
                        "text": "Newly committed text delta emitted once",
                        "reason": "Commit trigger such as silence, max_chunk, stable_prefix, flush, or close",
                        "wordTimings": "Optional per-word timings for the committed delta",
                    },
                    "sentence_schema": {
                        "text": "Newly finalized sentence text for downstream translation or pairing",
                    },
                    "query_options": {
                        "return_word_timestamps": "Set to true to request optional per-word timings when supported",
                        "text_corrections": "Optional JSON object with user-configurable text correction entries",
                        "sensevoice_vad_model": "Optional FunASR VAD model id for SenseVoice, for example fsmn-vad",
                        "sensevoice_vad_merge": "Set to true to merge VAD segments in SenseVoice output",
                        "sensevoice_vad_merge_length_s": "Optional SenseVoice VAD merge length in seconds",
                        "sensevoice_vad_max_single_segment_time_ms": "Optional SenseVoice VAD max single segment time in milliseconds",
                    },
                }
            )
        elif parsed.path == "/gpu":
            self.send_json(detect_gpu())
        elif parsed.path == "/model/info":
            self.send_json({"loaded": asr_engine._model is not None, **asr_engine._model_info})
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
        return transcribe_audio_payload(audio_data, params)

    def transcribe_from_json(self, data: dict) -> dict:
        audio_b64 = data.get("audio")
        if not audio_b64:
            return {"success": False, "error": "Missing audio field", "text": ""}

        audio_data = base64.b64decode(audio_b64)
        params = {
            "engine": [data.get("engine", asr_engine._runtime_policy["engine"])],
            "model": [data.get("model", asr_engine._runtime_policy["default_model_type"])],
            "sensevoice_model_id": [data.get("sensevoice_model_id", asr_engine._runtime_policy["sensevoice_model_id"])],
            "sensevoice_use_itn": [data.get("sensevoice_use_itn", asr_engine._runtime_policy["sensevoice_use_itn"])],
            "sensevoice_vad_model": [data.get("sensevoice_vad_model", asr_engine._runtime_policy["sensevoice_vad_model"])],
            "sensevoice_vad_merge": [data.get("sensevoice_vad_merge", asr_engine._runtime_policy["sensevoice_vad_merge"])],
            "sensevoice_vad_merge_length_s": [
                data.get("sensevoice_vad_merge_length_s", asr_engine._runtime_policy["sensevoice_vad_merge_length_s"])
            ],
            "sensevoice_vad_max_single_segment_time_ms": [
                data.get(
                    "sensevoice_vad_max_single_segment_time_ms",
                    asr_engine._runtime_policy["sensevoice_vad_max_single_segment_time_ms"],
                )
            ],
            "device": [data.get("device", asr_engine._runtime_policy["device"])],
            "compute_type": [data.get("compute_type", asr_engine._runtime_policy["compute_type"])],
            "language": [data.get("language")],
            "download_root": [data.get("download_root")],
            "offline_segmented": [data.get("offline_segmented", False)],
            "offline_segment_silence_ms": [data.get("offline_segment_silence_ms", 1200)],
            "offline_segment_min_speech_rms": [data.get("offline_segment_min_speech_rms", 360)],
            "offline_segment_window_ms": [data.get("offline_segment_window_ms", 30)],
            "offline_segment_padding_ms": [data.get("offline_segment_padding_ms", 480)],
            "offline_segment_max_segment_ms": [data.get("offline_segment_max_segment_ms", 30000)],
            "offline_segment_overlap_ms": [data.get("offline_segment_overlap_ms", 640)],
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

            engine = data.get("engine", asr_engine._runtime_policy["engine"])
            model_type = data.get("model", asr_engine._runtime_policy["default_model_type"])
            sensevoice_model_id = data.get("sensevoice_model_id", asr_engine._runtime_policy["sensevoice_model_id"])
            sensevoice_use_itn = parse_bool(
                data.get("sensevoice_use_itn", asr_engine._runtime_policy["sensevoice_use_itn"]),
                asr_engine._runtime_policy["sensevoice_use_itn"],
            )
            sensevoice_vad_model = data.get("sensevoice_vad_model", asr_engine._runtime_policy["sensevoice_vad_model"])
            sensevoice_vad_merge = parse_bool(
                data.get("sensevoice_vad_merge", asr_engine._runtime_policy["sensevoice_vad_merge"]),
                asr_engine._runtime_policy["sensevoice_vad_merge"],
            )
            sensevoice_vad_merge_length_s = float(
                data.get(
                    "sensevoice_vad_merge_length_s",
                    asr_engine._runtime_policy["sensevoice_vad_merge_length_s"],
                )
            )
            sensevoice_vad_max_single_segment_time_ms = parse_positive_int(
                data.get(
                    "sensevoice_vad_max_single_segment_time_ms",
                    asr_engine._runtime_policy["sensevoice_vad_max_single_segment_time_ms"],
                ),
                asr_engine._runtime_policy["sensevoice_vad_max_single_segment_time_ms"],
            )
            device = data.get("device", asr_engine._runtime_policy["device"])
            compute_type = data.get("compute_type", asr_engine._runtime_policy["compute_type"])
            download_root = data.get("download_root")

            if engine == "sensevoice":
                resolved_sensevoice_device = resolve_sensevoice_device(device)
                device = "cuda" if resolved_sensevoice_device.startswith("cuda") else "cpu"
                model_type = None

            _, model_reused, reload_reason = get_model(
                engine=engine,
                model_type=model_type,
                sensevoice_model_id=sensevoice_model_id,
                sensevoice_vad_model=sensevoice_vad_model,
                sensevoice_vad_max_single_segment_time_ms=sensevoice_vad_max_single_segment_time_ms,
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
                    "sensevoice_vad_model": sensevoice_vad_model,
                    "sensevoice_vad_merge": sensevoice_vad_merge,
                    "sensevoice_vad_merge_length_s": sensevoice_vad_merge_length_s,
                    "sensevoice_vad_max_single_segment_time_ms": (
                        sensevoice_vad_max_single_segment_time_ms
                    ),
                    "model_reused": model_reused,
                    "reload_reason": reload_reason,
                }
            )
        except Exception as exc:
            self.send_json({"success": False, "error": str(exc)}, 500)

    def handle_unload_model(self):
        with asr_engine._model_lock:
            asr_engine._model = None
            asr_engine._model_info.update(
                {
                    "engine": None,
                    "model_type": None,
                    "sensevoice_model_id": None,
                    "sensevoice_vad_model": None,
                    "sensevoice_vad_max_single_segment_time_ms": None,
                    "device": None,
                    "compute_type": None,
                    "download_root": None,
                }
            )

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


def start_ws_server(host: str, ws_port: int):
    global _ws_server
    if ws_port <= 0:
        raise ValueError("ws_port must be positive")

    if _ws_server is not None:
        return

    def _run():
        global _ws_server
        with serve(
            handle_websocket_connection,
            host,
            ws_port,
            max_size=None,
            logger=configure_ws_logger(),
        ) as ws_server:
            _ws_server = ws_server
            print(f"[Server] WebSocket streaming server running on ws://{host}:{ws_port}/stream", flush=True)
            ws_server.serve_forever()

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()


def stop_ws_server():
    global _ws_server
    if _ws_server is None:
        return
    try:
        _ws_server.shutdown()
    except Exception:
        pass
    _ws_server = None


def main():
    parser = argparse.ArgumentParser(description="Local ASR HTTP Server")
    parser.add_argument("--host", default="127.0.0.1", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8765, help="Port to listen on")
    parser.add_argument("--ws-port", type=int, default=8766, help="WebSocket streaming port")
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
        "--sensevoice-vad-model",
        default=None,
        help="Optional SenseVoice/FunASR VAD model id, for example fsmn-vad",
    )
    parser.add_argument(
        "--sensevoice-vad-merge",
        default="true",
        help="Whether SenseVoice should merge VAD segments (true/false)",
    )
    parser.add_argument(
        "--sensevoice-vad-merge-length-s",
        type=float,
        default=15.0,
        help="SenseVoice VAD merge length in seconds",
    )
    parser.add_argument(
        "--sensevoice-vad-max-single-segment-time-ms",
        type=int,
        default=30000,
        help="SenseVoice VAD max single segment time in milliseconds",
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

    asr_engine._runtime_policy["engine"] = args.engine
    asr_engine._runtime_policy["lock_model"] = args.lock_model
    asr_engine._runtime_policy["lock_device_compute"] = args.lock_device_compute
    asr_engine._runtime_policy["lock_language"] = args.lock_language
    asr_engine._runtime_policy["default_model_type"] = args.preload_model or args.default_model
    asr_engine._runtime_policy["default_language"] = args.default_language
    asr_engine._runtime_policy["sensevoice_model_id"] = args.sensevoice_model_id
    asr_engine._runtime_policy["sensevoice_use_itn"] = parse_bool(args.sensevoice_use_itn, True)
    asr_engine._runtime_policy["sensevoice_vad_model"] = args.sensevoice_vad_model or None
    asr_engine._runtime_policy["sensevoice_vad_merge"] = parse_bool(args.sensevoice_vad_merge, True)
    asr_engine._runtime_policy["sensevoice_vad_merge_length_s"] = args.sensevoice_vad_merge_length_s
    asr_engine._runtime_policy["sensevoice_vad_max_single_segment_time_ms"] = (
        args.sensevoice_vad_max_single_segment_time_ms
    )
    asr_engine._runtime_policy["device"] = args.device
    asr_engine._runtime_policy["compute_type"] = args.compute_type
    asr_engine._runtime_policy["download_root"] = args.download_root
    asr_engine._runtime_policy["ws_port"] = args.ws_port

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
            preload_model_type = args.preload_model or args.default_model
            if args.engine == "sensevoice":
                resolved_sensevoice_device = resolve_sensevoice_device(args.device)
                preload_device = "cuda" if resolved_sensevoice_device.startswith("cuda") else "cpu"
                preload_model_type = None
            get_model(
                engine=args.engine,
                model_type=preload_model_type,
                sensevoice_model_id=args.sensevoice_model_id,
                sensevoice_vad_model=args.sensevoice_vad_model or None,
                sensevoice_vad_max_single_segment_time_ms=(
                    args.sensevoice_vad_max_single_segment_time_ms
                ),
                device=preload_device,
                compute_type=args.compute_type,
                download_root=args.download_root,
            )
        except Exception as exc:
            print(f"[Server] Failed to pre-load model: {exc}", flush=True)

    if args.ws_port == args.port:
        raise ValueError("--ws-port must be different from --port")

    server = ThreadedHTTPServer((args.host, args.port), WhisperHandler)
    start_ws_server(args.host, args.ws_port)
    print(f"[Server] Local ASR HTTP server running on http://{args.host}:{args.port}", flush=True)
    print("[Server] Endpoints:", flush=True)
    print("  GET  /health       - Health check", flush=True)
    print("  GET  /capabilities - Server capabilities", flush=True)
    print("  GET  /gpu          - Detect GPU", flush=True)
    print("  GET  /model/info   - Current model info", flush=True)
    print(f"  WS   /stream       - WebSocket streaming ASR (port: {args.ws_port})", flush=True)
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
        stop_ws_server()


if __name__ == "__main__":
    main()
