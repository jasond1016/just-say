#!/usr/bin/env python3
"""
JustSay - Local ASR HTTP Server

支持双引擎：
- Faster-Whisper
- SenseVoiceSmall (FunAudioLLM/SenseVoiceSmall)
"""

import argparse
import base64
import glob
import json
import logging
import os
import re
import struct
import sys
import tempfile
import threading
import time
import traceback
import unicodedata
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse
from websockets.exceptions import ConnectionClosed, InvalidUpgrade
from websockets.sync.server import serve

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
    "download_root": None,
    "ws_port": 8766,
}
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


def normalize_model_type(engine: str, model_type: str | None) -> str | None:
    if engine == "sensevoice":
        return None
    return model_type or "tiny"


def get_model(
    engine: str,
    model_type: str | None,
    sensevoice_model_id: str,
    device: str,
    compute_type: str,
    download_root: str | None,
):
    """Get or create the model singleton."""
    global _model, _model_info

    normalized_model_type = normalize_model_type(engine, model_type)

    with _model_lock:
        reload_reasons = []
        if _model is None:
            reload_reasons.append("model_uninitialized")
        if _model_info["engine"] != engine:
            reload_reasons.append("engine_changed")
        if normalized_model_type != _model_info["model_type"]:
            reload_reasons.append("model_type_changed")
        if _model_info["sensevoice_model_id"] != sensevoice_model_id:
            reload_reasons.append("sensevoice_model_id_changed")
        if _model_info["device"] != device:
            reload_reasons.append("device_changed")
        if _model_info["compute_type"] != compute_type:
            reload_reasons.append("compute_type_changed")
        if _model_info["download_root"] != download_root:
            reload_reasons.append("download_root_changed")

        need_reload = len(reload_reasons) > 0
        reload_reason = ",".join(reload_reasons) if reload_reasons else "cache_hit"

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
                    "model_type": normalized_model_type,
                    "sensevoice_model_id": sensevoice_model_id,
                    "device": device,
                    "compute_type": compute_type,
                    "download_root": download_root,
                }
            )
            print(f"[Server] Model loaded successfully (reload_reason={reload_reason})", flush=True)
        else:
            model_name = model_type if engine == "faster-whisper" else sensevoice_model_id
            print(
                f"[Server] Reusing loaded model: engine={engine}, model={model_name}, "
                f"device={device}, compute={compute_type}",
                flush=True,
            )

        return _model, (not need_reload), reload_reason


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


def transcribe_audio_payload(audio_data: bytes, params: dict) -> dict:
    start_time = time.time()

    default_engine = _model_info["engine"] or _runtime_policy["engine"] or "faster-whisper"
    default_model_type = _model_info["model_type"] or _runtime_policy["default_model_type"] or "tiny"
    default_sensevoice_model_id = _model_info["sensevoice_model_id"] or _runtime_policy["sensevoice_model_id"]
    default_device = _model_info["device"] or _runtime_policy["device"] or "cpu"
    default_compute_type = _model_info["compute_type"] or _runtime_policy["compute_type"] or "int8"
    default_language = _runtime_policy["default_language"]
    default_sensevoice_use_itn = _runtime_policy["sensevoice_use_itn"]
    default_download_root = _model_info["download_root"] or _runtime_policy["download_root"]

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
    download_root = params.get("download_root", [default_download_root])[0]

    if _runtime_policy["lock_model"]:
        engine = default_engine
        model_type = default_model_type if default_engine == "faster-whisper" else None
        sensevoice_model_id = default_sensevoice_model_id
        sensevoice_use_itn = default_sensevoice_use_itn
    else:
        engine = requested_engine
        model_type = requested_model_type if engine == "faster-whisper" else None
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
        model, model_reused, reload_reason = get_model(
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
            "model_reused": model_reused,
            "reload_reason": reload_reason,
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
            "model_reused": False,
            "reload_reason": "transcribe_failed",
        }
    finally:
        try:
            os.unlink(temp_path)
        except Exception:
            pass


def build_wav_from_pcm(pcm_data: bytes, sample_rate: int) -> bytes:
    num_channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    data_size = len(pcm_data)
    header_size = 44
    file_size = header_size + data_size - 8

    header = bytearray(header_size)
    header[0:4] = b"RIFF"
    struct.pack_into("<I", header, 4, file_size)
    header[8:12] = b"WAVE"
    header[12:16] = b"fmt "
    struct.pack_into("<I", header, 16, 16)
    struct.pack_into("<H", header, 20, 1)
    struct.pack_into("<H", header, 22, num_channels)
    struct.pack_into("<I", header, 24, sample_rate)
    struct.pack_into("<I", header, 28, byte_rate)
    struct.pack_into("<H", header, 32, block_align)
    struct.pack_into("<H", header, 34, bits_per_sample)
    header[36:40] = b"data"
    struct.pack_into("<I", header, 40, data_size)
    return bytes(header) + pcm_data


def parse_positive_int(raw_value, fallback: int, minimum: int = 1) -> int:
    try:
        value = int(raw_value)
        if value < minimum:
            return fallback
        return value
    except Exception:
        return fallback


def find_text_overlap(left: str, right: str, max_overlap: int = 200) -> int:
    if not left or not right:
        return 0
    limit = min(max_overlap, len(left), len(right))
    for size in range(limit, 0, -1):
        if left[-size:] == right[:size]:
            return size
    return 0


def merge_text(left: str, right: str) -> str:
    if not left:
        return right
    if not right:
        return left
    if left[-1].isspace() or right[0].isspace():
        return left + right
    return left + right


def normalize_loose_text(text: str) -> str:
    chars = []
    for ch in text:
        if ch.isalnum() or "\u3040" <= ch <= "\u30ff" or "\u31f0" <= ch <= "\u31ff" or "\u3400" <= ch <= "\u9fff":
            chars.append(ch.lower())
    return "".join(chars)


def is_loose_word_char(ch: str) -> bool:
    return ch.isalnum() or "\u3040" <= ch <= "\u30ff" or "\u31f0" <= ch <= "\u31ff" or "\u3400" <= ch <= "\u9fff"


def replace_weak_tail_with_continuation(left: str, right: str) -> str | None:
    trimmed_left = left.rstrip(" \t\r\n,，、。！？!?;；:：")
    if not trimmed_left:
        return None

    normalized_right = normalize_loose_text(right)
    max_size = min(8, len(trimmed_left))
    for size in range(max_size, 1, -1):
        tail = trimmed_left[-size:]
        if not all(is_loose_word_char(ch) for ch in tail):
            continue

        normalized_tail = normalize_loose_text(tail)
        if len(normalized_tail) < 2:
            continue
        if not normalized_right.startswith(normalized_tail) or len(normalized_right) <= len(normalized_tail):
            continue

        return merge_text(trimmed_left[:-size], right)

    return None


def merge_streaming_chunk_text(left: str, right: str) -> str:
    if not left:
        return right
    if not right:
        return left

    overlap = find_text_overlap(left, right, 200)
    if overlap > 0:
        return merge_text(left, right[overlap:])

    replacement = replace_weak_tail_with_continuation(left, right)
    if replacement:
        return replacement

    return merge_text(left, right)


def normalize_japanese_spacing(text: str) -> str:
    if not text:
        return text

    normalized = text
    while True:
        next_text = re.sub(
            r"([\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])[ \t\u3000]+([\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])",
            r"\1\2",
            normalized,
        )
        next_text = re.sub(
            r"([\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])[ \t\u3000]+([。、「」『』（）！？、])",
            r"\1\2",
            next_text,
        )
        next_text = re.sub(
            r"([。、「」『』（）！？、])[ \t\u3000]+([\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])",
            r"\1\2",
            next_text,
        )
        if next_text == normalized:
            return next_text
        normalized = next_text


JAPANESE_ORDINAL_DIGIT_MAP = {
    "1": "一",
    "2": "二",
    "3": "三",
    "4": "四",
    "5": "五",
    "6": "六",
    "7": "七",
    "8": "八",
    "9": "九",
    "10": "十",
}


def normalize_japanese_ordinals(text: str) -> str:
    if not text:
        return text

    def _replace(match: re.Match[str]) -> str:
        digit = unicodedata.normalize("NFKC", match.group(1))
        mapped = JAPANESE_ORDINAL_DIGIT_MAP.get(digit)
        if not mapped:
            return match.group(0)
        return f"{mapped}つ目"

    return re.sub(r"([0-9０-９]{1,2})\s*つ目", _replace, text)


def strip_japanese_asr_symbols(text: str) -> str:
    if not text:
        return text

    cleaned = re.sub(r"[\U0001F300-\U0001FAFF\u2600-\u27BF]+", "", text)
    cleaned = re.sub(r"[🎼♪♫♬♩♭♯]+", "", cleaned)
    return cleaned


def cleanup_japanese_asr_text(text: str) -> str:
    if not text:
        return text

    cleaned = normalize_japanese_spacing(text)
    cleaned = normalize_japanese_ordinals(cleaned)
    cleaned = strip_japanese_asr_symbols(cleaned)
    cleaned = re.sub(r"^[\s\u3000]+", "", cleaned)
    cleaned = re.sub(r"(.{1,16}[。！？!?])(?:\1)+$", r"\1", cleaned)
    return cleaned


WEAK_BOUNDARY_SUFFIX_CHARS = {
    "的",
    "了",
    "和",
    "与",
    "及",
    "并",
    "而",
    "但",
    "就",
    "还",
    "呢",
    "吗",
    "吧",
    "啊",
    "は",
    "が",
    "を",
    "に",
    "で",
    "と",
    "へ",
    "も",
    "の",
}


def count_meaningful_chars(text: str) -> int:
    count = 0
    for ch in text:
        if ch.isalnum() or "\u3040" <= ch <= "\u30ff" or "\u31f0" <= ch <= "\u31ff" or "\u3400" <= ch <= "\u9fff":
            count += 1
    return count


def is_weak_boundary_suffix(text: str) -> bool:
    normalized = (text or "").strip()
    if not normalized:
        return False

    trimmed = normalized.rstrip("。！？!?，、,;；:： \t\r\n")
    if not trimmed:
        return True

    return trimmed[-1] in WEAK_BOUNDARY_SUFFIX_CHARS


def get_tail_after_last_boundary(text: str) -> str:
    for idx in range(len(text) - 1, -1, -1):
        if text[idx] in {" ", "\t", "\r", "\n", ",", "，", "、", "。", "！", "？", "!", "?", ";", "；", ":", "："}:
            return text[idx + 1 :]
    return text


def split_prefix_and_tail(text: str) -> tuple[str, str]:
    normalized = (text or "").strip()
    if not normalized:
        return "", ""

    without_trailing_boundary = normalized.rstrip("。！？!?")
    if not without_trailing_boundary:
        return "", ""

    tail = get_tail_after_last_boundary(without_trailing_boundary)
    if not tail:
        return without_trailing_boundary, ""

    prefix = without_trailing_boundary[: len(without_trailing_boundary) - len(tail)]
    return prefix, tail


def replace_trailing_tail(candidate: str, replacement_tail: str) -> str:
    prefix, _ = split_prefix_and_tail(candidate)
    return merge_text(prefix, replacement_tail)


def try_extend_candidate_with_preview(candidate: str, preview: str) -> str | None:
    normalized_candidate = (candidate or "").strip()
    normalized_preview = (preview or "").strip()
    if not normalized_candidate or not normalized_preview:
        return None

    _, candidate_tail = split_prefix_and_tail(normalized_candidate)
    preview_tail = normalized_preview

    candidate_tail = candidate_tail.strip()
    preview_tail = preview_tail.strip()
    if not candidate_tail or not preview_tail:
        return None

    normalized_candidate_tail = normalize_loose_text(
        candidate_tail.rstrip("。！？!?，、,;；:： \t\r\n")
    )
    normalized_preview_tail = normalize_loose_text(
        preview_tail.rstrip("。！？!?，、,;；:： \t\r\n")
    )
    if len(normalized_candidate_tail) < 4 or len(normalized_preview_tail) <= len(normalized_candidate_tail):
        return None
    if not normalized_preview_tail.startswith(normalized_candidate_tail):
        return None

    return replace_trailing_tail(candidate, preview_tail.rstrip("。！？!? \t\r\n"))


def has_stable_final_boundary(text: str, min_tail_chars: int = 3) -> bool:
    normalized = (text or "").strip()
    if not normalized or normalized[-1] not in {"。", "！", "？", "!", "?"}:
        return False

    without_punctuation = normalized.rstrip("。！？!?")
    if not without_punctuation:
        return False

    tail = get_tail_after_last_boundary(without_punctuation)
    return count_meaningful_chars(tail) >= min_tail_chars and not is_weak_boundary_suffix(normalized)


class WebSocketStreamingSession:
    """WS streaming session for local ASR (based on websockets library)."""

    def __init__(self, websocket, params: dict):
        self.websocket = websocket
        self.params = params
        self.sample_rate = parse_positive_int(params.get("sample_rate", ["16000"])[0], 16000)
        self.preview_interval_ms = parse_positive_int(params.get("preview_interval_ms", ["450"])[0], 450)
        self.preview_min_audio_ms = parse_positive_int(params.get("preview_min_audio_ms", ["350"])[0], 350)
        self.preview_min_new_audio_ms = parse_positive_int(params.get("preview_min_new_audio_ms", ["220"])[0], 220)
        self.preview_window_ms = parse_positive_int(params.get("preview_window_ms", ["2600"])[0], 2600)
        self.min_chunk_ms = parse_positive_int(params.get("min_chunk_ms", ["1000"])[0], 1000)
        self.silence_threshold_ms = parse_positive_int(params.get("silence_ms", ["700"])[0], 700)
        self.max_chunk_ms = parse_positive_int(params.get("max_chunk_ms", ["5000"])[0], 5000)
        self.overlap_ms = parse_positive_int(params.get("overlap_ms", ["520"])[0], 520)
        self.max_chunk_extension_ms = parse_positive_int(
            params.get("max_chunk_extension_ms", ["1400"])[0], 1400
        )

        self.pending_pcm = bytearray()
        self.pending_new_bytes = 0
        self.final_text = ""
        self.pending_final_chunk = ""
        self.last_preview_text = ""
        self.last_preview_at = 0.0
        self.last_preview_audio_bytes = 0
        self.buffer_start_at = 0.0
        self.last_audio_at = time.time()
        self.closed = False

    def bytes_for_ms(self, ms: int) -> int:
        if ms <= 0:
            return 0
        return int((self.sample_rate * 2 * ms) / 1000)

    def duration_ms_from_bytes(self, size: int) -> float:
        if size <= 0:
            return 0.0
        return (size / 2) / self.sample_rate * 1000.0

    def get_preview_pcm(self) -> bytes:
        if not self.pending_pcm:
            return b""
        max_bytes = self.bytes_for_ms(self.preview_window_ms)
        if max_bytes <= 0 or len(self.pending_pcm) <= max_bytes:
            return bytes(self.pending_pcm)
        return bytes(self.pending_pcm[-max_bytes:])

    def retain_overlap(self):
        if not self.pending_pcm:
            return
        overlap_bytes = self.bytes_for_ms(self.overlap_ms)
        if overlap_bytes <= 0:
            self.pending_pcm = bytearray()
            return
        if len(self.pending_pcm) > overlap_bytes:
            self.pending_pcm = bytearray(self.pending_pcm[-overlap_bytes:])

    def get_visible_text_base(self) -> str:
        return merge_text(self.final_text, self.pending_final_chunk).strip()

    def emit_json(self, payload: dict):
        text = payload.get("text")
        if isinstance(text, str) and payload.get("type") in {"interim", "final_chunk", "final"}:
            language = (self.params.get("language", [""])[0] or "").lower()
            if language.startswith("ja") or re.search(r"[\u3040-\u30ff\u3400-\u9fff]", text):
                payload = {**payload, "text": cleanup_japanese_asr_text(text)}
        self.websocket.send(json.dumps(payload, ensure_ascii=False))

    def transcribe_pcm(self, pcm_data: bytes) -> dict:
        wav_data = build_wav_from_pcm(pcm_data, self.sample_rate)
        return transcribe_audio_payload(wav_data, self.params)

    def emit_preview(self):
        if self.closed:
            return
        now = time.time()
        if (now - self.last_preview_at) * 1000 < self.preview_interval_ms:
            return
        if self.duration_ms_from_bytes(len(self.pending_pcm)) < self.preview_min_audio_ms:
            return
        new_audio_ms = self.duration_ms_from_bytes(len(self.pending_pcm) - self.last_preview_audio_bytes)
        if new_audio_ms < self.preview_min_new_audio_ms:
            return

        result = self.transcribe_pcm(self.get_preview_pcm())
        self.last_preview_at = now
        self.last_preview_audio_bytes = len(self.pending_pcm)
        if not result.get("success"):
            self.emit_json({"type": "error", "message": result.get("error", "stream_preview_failed")})
            return

        preview_text = (result.get("text") or "").strip()
        if not preview_text:
            return
        overlap = find_text_overlap(self.get_visible_text_base(), preview_text)
        deduped = preview_text[overlap:] if overlap > 0 else preview_text
        self.last_preview_text = deduped
        self.emit_json({"type": "interim", "text": deduped, "ts": int(time.time() * 1000)})

    def commit_pending_final_chunk(self, reason: str):
        normalized = self.pending_final_chunk.strip()
        if not normalized:
            self.pending_final_chunk = ""
            return

        self.pending_final_chunk = ""
        self.final_text = merge_text(self.final_text, normalized)
        self.emit_json({"type": "final_chunk", "text": normalized, "ts": int(time.time() * 1000)})
        self.emit_json({"type": "endpoint", "reason": reason, "ts": int(time.time() * 1000)})

    def should_defer_final_chunk(self, candidate: str, reason: str) -> bool:
        if reason != "max_chunk":
            return False
        normalized = candidate.strip()
        if not normalized:
            return False
        preview_extension = try_extend_candidate_with_preview(normalized, self.last_preview_text)
        if preview_extension:
            self.pending_final_chunk = preview_extension
            return True
        return not has_stable_final_boundary(normalized)

    def emit_final(self, reason: str):
        if self.closed or self.pending_new_bytes <= 0:
            return
        result = self.transcribe_pcm(bytes(self.pending_pcm))
        if not result.get("success"):
            self.emit_json({"type": "error", "message": result.get("error", "stream_final_failed")})
            return

        final_chunk = (result.get("text") or "").strip()
        if not final_chunk:
            self.pending_new_bytes = 0
            self.last_preview_text = ""
            self.retain_overlap()
            return

        overlap = find_text_overlap(self.get_visible_text_base(), final_chunk)
        deduped = final_chunk[overlap:] if overlap > 0 else final_chunk
        if deduped.strip():
            self.pending_final_chunk = merge_streaming_chunk_text(self.pending_final_chunk, deduped)
            if not self.should_defer_final_chunk(self.pending_final_chunk, reason):
                self.commit_pending_final_chunk(reason)

        self.pending_new_bytes = 0
        self.last_preview_text = ""
        self.retain_overlap()
        self.buffer_start_at = 0.0
        self.last_preview_audio_bytes = len(self.pending_pcm)

    def maybe_emit_final_by_timing(self):
        if self.pending_new_bytes <= 0 or self.buffer_start_at <= 0:
            return
        now = time.time()
        pending_ms = self.duration_ms_from_bytes(self.pending_new_bytes)
        silence_ms = (now - self.last_audio_at) * 1000
        if pending_ms >= self.max_chunk_ms:
            if pending_ms < self.max_chunk_ms + self.max_chunk_extension_ms:
                preview_text = (self.last_preview_text or "").strip()
                if preview_text and not has_stable_final_boundary(preview_text):
                    return
            self.emit_final("max_chunk")
            return
        if pending_ms >= self.min_chunk_ms and silence_ms >= self.silence_threshold_ms:
            self.emit_final("silence")

    def run(self):
        self.emit_json({"type": "ready", "streaming": True, "ts": int(time.time() * 1000)})
        while not self.closed:
            try:
                message = self.websocket.recv(timeout=0.2)
                if isinstance(message, str):
                    message = message.strip()
                    if not message:
                        continue
                    data = json.loads(message)
                    msg_type = data.get("type")
                    if msg_type == "flush":
                        self.emit_final("flush")
                        self.commit_pending_final_chunk("flush")
                        self.emit_json({"type": "final", "text": self.final_text, "ts": int(time.time() * 1000)})
                    elif msg_type == "close":
                        self.emit_final("close")
                        self.commit_pending_final_chunk("close")
                        self.closed = True
                        break
                    elif msg_type == "ping":
                        self.emit_json({"type": "pong", "ts": int(time.time() * 1000)})
                    continue
                if isinstance(message, bytes):  # binary audio chunk (PCM16LE mono)
                    if message:
                        self.pending_pcm.extend(message)
                        self.pending_new_bytes += len(message)
                        self.last_audio_at = time.time()
                        if self.buffer_start_at <= 0:
                            self.buffer_start_at = self.last_audio_at
            except TimeoutError:
                pass
            except ConnectionClosed:
                self.closed = True
                break
            except json.JSONDecodeError:
                self.emit_json({"type": "error", "message": "invalid_json"})
            except Exception as exc:
                self.emit_json({"type": "error", "message": str(exc)})
                self.closed = True
                break

            try:
                self.emit_preview()
                self.maybe_emit_final_by_timing()
            except Exception as exc:
                self.emit_json({"type": "error", "message": str(exc)})
                self.closed = True
                break


def handle_websocket_connection(websocket):
    try:
        raw_path = websocket.request.path
    except Exception:
        raw_path = "/stream"

    parsed = urlparse(raw_path)
    if parsed.path != "/stream":
        websocket.send(json.dumps({"type": "error", "message": "invalid_stream_path"}))
        websocket.close()
        return

    params = parse_qs(parsed.query)
    session = WebSocketStreamingSession(websocket, params)
    session.run()


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
        elif parsed.path == "/capabilities":
            self.send_json(
                {
                    "streaming_asr": True,
                    "transport": ["http", "websocket"],
                    "events": ["interim", "final_chunk", "endpoint", "final", "error"],
                    "audio_format": "pcm_s16le",
                    "sample_rate": 16000,
                    "ws_path": "/stream",
                    "ws_port": _runtime_policy["ws_port"],
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
        return transcribe_audio_payload(audio_data, params)

    def transcribe_from_json(self, data: dict) -> dict:
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
                model_type = None

            _, model_reused, reload_reason = get_model(
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
                    "model_reused": model_reused,
                    "reload_reason": reload_reason,
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
    global _runtime_policy

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
    _runtime_policy["download_root"] = args.download_root
    _runtime_policy["ws_port"] = args.ws_port

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
