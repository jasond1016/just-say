#!/usr/bin/env python3
"""
JustSay - Local ASR HTTP Server

支持双引擎：
- Faster-Whisper
- SenseVoiceSmall (FunAudioLLM/SenseVoiceSmall)
"""

import argparse
import array
import base64
import glob
import io
import json
import logging
import math
import os
import re
import struct
import sys
import tempfile
import threading
import time
import traceback
import unicodedata
import wave
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


def parse_text_corrections(raw_value) -> list[dict]:
    if not raw_value:
        return []

    try:
        parsed = json.loads(raw_value)
    except Exception:
        return []

    if isinstance(parsed, dict):
        entries = parsed.get("entries")
    elif isinstance(parsed, list):
        entries = parsed
    else:
        return []

    if not isinstance(entries, list):
        return []

    normalized_entries = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue

        target = entry.get("target")
        aliases = entry.get("aliases")
        if not isinstance(target, str):
            continue
        normalized_target = target.strip()
        if not normalized_target:
            continue

        normalized_aliases = []
        if isinstance(aliases, list):
            for alias in aliases:
                if not isinstance(alias, str):
                    continue
                normalized_alias = alias.strip()
                if not normalized_alias or normalized_alias == normalized_target:
                    continue
                if normalized_alias not in normalized_aliases:
                    normalized_aliases.append(normalized_alias)

        if not normalized_aliases:
            continue

        normalized_entries.append(
            {
                "target": normalized_target,
                "aliases": normalized_aliases,
            }
        )

    return normalized_entries


def apply_text_corrections(text: str, corrections: list[dict]) -> tuple[str, bool]:
    normalized = (text or "").strip()
    if not normalized or not corrections:
        return normalized, False

    replacements: list[tuple[str, str]] = []
    seen_pairs = set()
    for entry in corrections:
        if not isinstance(entry, dict):
            continue
        target = entry.get("target")
        aliases = entry.get("aliases")
        if not isinstance(target, str) or not isinstance(aliases, list):
            continue
        for alias in aliases:
            if not isinstance(alias, str):
                continue
            pair = (alias, target)
            if not alias or alias == target or pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            replacements.append(pair)

    if not replacements:
        return normalized, False

    corrected = normalized
    for alias, target in sorted(replacements, key=lambda item: len(item[0]), reverse=True):
        corrected = corrected.replace(alias, target)

    return corrected, corrected != normalized


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


def build_word_timings(words, timestamps):
    if not isinstance(words, list) or not isinstance(timestamps, list):
        return None

    count = min(len(words), len(timestamps))
    if count <= 0:
        return None

    word_timings = []
    for index in range(count):
        word = words[index]
        timing = timestamps[index]
        if not isinstance(word, str) or not isinstance(timing, (list, tuple)) or len(timing) < 2:
            continue
        start_ms = timing[0]
        end_ms = timing[1]
        if not isinstance(start_ms, (int, float)) or not isinstance(end_ms, (int, float)):
            continue
        word_timings.append(
            {
                "text": word,
                "startMs": int(start_ms),
                "endMs": int(end_ms),
            }
        )

    return word_timings or None


def decode_wav_to_mono_pcm16(audio_data: bytes) -> dict | None:
    try:
        with wave.open(io.BytesIO(audio_data), "rb") as wav_file:
            channel_count = wav_file.getnchannels()
            sample_width = wav_file.getsampwidth()
            sample_rate = wav_file.getframerate()
            frame_count = wav_file.getnframes()
            if channel_count <= 0 or sample_width != 2 or sample_rate <= 0 or frame_count <= 0:
                return None
            raw_frames = wav_file.readframes(frame_count)
    except wave.Error:
        return None

    if not raw_frames:
        return None

    samples = array.array("h")
    samples.frombytes(raw_frames)
    if sys.byteorder != "little":
        samples.byteswap()

    if channel_count > 1:
        mono_samples = array.array("h")
        for index in range(0, len(samples), channel_count):
            frame = samples[index : index + channel_count]
            if len(frame) < channel_count:
                break
            mono_value = int(sum(frame) / len(frame))
            mono_samples.append(max(-32768, min(32767, mono_value)))
        samples = mono_samples

    if not samples:
        return None

    pcm_mono = array.array("h", samples)
    if sys.byteorder != "little":
        pcm_mono.byteswap()

    return {
        "sample_rate": sample_rate,
        "pcm_mono": pcm_mono.tobytes(),
    }


def encode_wav_pcm16_mono(pcm_mono: bytes, sample_rate: int) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm_mono)
    return buffer.getvalue()


def detect_offline_segments(
    pcm_mono: bytes,
    sample_rate: int,
    *,
    silence_ms: int = 1200,
    min_speech_rms: int = 360,
    analysis_window_ms: int = 30,
    padding_ms: int = 480,
    max_segment_ms: int = 30000,
    overlap_ms: int = 640,
) -> list[tuple[int, int]]:
    if not pcm_mono or sample_rate <= 0:
        return []

    samples = array.array("h")
    samples.frombytes(pcm_mono)
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        return []

    window_samples = max(1, int(sample_rate * max(10, analysis_window_ms) / 1000))
    silence_windows = max(1, int(math.ceil(max(60, silence_ms) / max(10, analysis_window_ms))))
    padding_windows = max(0, int(math.ceil(max(0, padding_ms) / max(10, analysis_window_ms))))
    overlap_windows = max(0, int(math.ceil(max(0, overlap_ms) / max(10, analysis_window_ms))))
    max_segment_windows = max(
        silence_windows + 1,
        int(math.ceil(max(1000, max_segment_ms) / max(10, analysis_window_ms))),
    )

    rms_values: list[float] = []
    for offset in range(0, len(samples), window_samples):
        chunk = samples[offset : offset + window_samples]
        if not chunk:
            continue
        mean_square = sum(sample * sample for sample in chunk) / len(chunk)
        rms_values.append(math.sqrt(mean_square))

    if not rms_values:
        return []

    raw_segments: list[tuple[int, int]] = []
    segment_start = None
    last_speech = None
    for index, rms in enumerate(rms_values):
        is_speech = rms >= min_speech_rms
        if is_speech:
            if segment_start is None:
                segment_start = index
            last_speech = index
            continue

        if segment_start is None or last_speech is None:
            continue

        if index - last_speech >= silence_windows:
            raw_segments.append((segment_start, last_speech + 1))
            segment_start = None
            last_speech = None

    if segment_start is not None and last_speech is not None:
        raw_segments.append((segment_start, last_speech + 1))

    if not raw_segments:
        return [(0, len(samples))]

    total_windows = len(rms_values)
    expanded_segments: list[tuple[int, int]] = []
    for start_window, end_window in raw_segments:
        expanded_start = max(0, start_window - padding_windows)
        expanded_end = min(total_windows, end_window + padding_windows)
        expanded_segments.append((expanded_start, expanded_end))

    sample_segments: list[tuple[int, int]] = []
    for start_window, end_window in expanded_segments:
        chunk_start = start_window
        while chunk_start < end_window:
            chunk_end = min(end_window, chunk_start + max_segment_windows)
            start_sample = min(len(samples), chunk_start * window_samples)
            end_sample = min(len(samples), chunk_end * window_samples)
            if end_sample > start_sample:
                sample_segments.append((start_sample, end_sample))
            if chunk_end >= end_window:
                break
            chunk_start = max(start_window, chunk_end - overlap_windows)

    return sample_segments or [(0, len(samples))]


def offset_word_timings(word_timings: list[dict] | None, offset_ms: int) -> list[dict] | None:
    if not isinstance(word_timings, list) or not word_timings:
        return None

    shifted = []
    for item in word_timings:
        text = item.get("text")
        start_ms = item.get("startMs")
        end_ms = item.get("endMs")
        if not isinstance(text, str) or not isinstance(start_ms, (int, float)) or not isinstance(
            end_ms, (int, float)
        ):
            continue
        shifted.append(
            {
                "text": text,
                "startMs": int(start_ms + offset_ms),
                "endMs": int(end_ms + offset_ms),
            }
        )
    return shifted or None


def transcribe_with_sensevoice(
    model,
    temp_path: str,
    language: str | None,
    sensevoice_use_itn: bool,
    output_word_timestamps: bool,
):
    from funasr.utils.postprocess_utils import rich_transcription_postprocess

    final_language = language if language and language != "auto" else "auto"
    result = model.generate(
        input=temp_path,
        cache={},
        language=final_language,
        use_itn=sensevoice_use_itn,
        batch_size_s=60,
        output_timestamp=output_word_timestamps,
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
    word_timings = None
    if isinstance(item, dict):
        detected_language = item.get("language") or item.get("lang")
        word_timings = build_word_timings(item.get("words"), item.get("timestamp"))

    return {
        "text": text,
        "language": detected_language or final_language,
        "language_probability": None,
        "duration": None,
        "word_timings": word_timings,
    }


def transcribe_temp_path(
    model,
    *,
    engine: str,
    temp_path: str,
    language: str | None,
    sensevoice_use_itn: bool,
    output_word_timestamps: bool,
) -> dict:
    if engine == "sensevoice":
        return transcribe_with_sensevoice(
            model,
            temp_path,
            language,
            sensevoice_use_itn,
            output_word_timestamps,
        )
    return transcribe_with_faster_whisper(model, temp_path, language)


def transcribe_audio_bytes(
    model,
    *,
    engine: str,
    audio_data: bytes,
    language: str | None,
    sensevoice_use_itn: bool,
    output_word_timestamps: bool,
) -> dict:
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp_file:
        tmp_file.write(audio_data)
        temp_path = tmp_file.name

    try:
        return transcribe_temp_path(
            model,
            engine=engine,
            temp_path=temp_path,
            language=language,
            sensevoice_use_itn=sensevoice_use_itn,
            output_word_timestamps=output_word_timestamps,
        )
    finally:
        try:
            os.unlink(temp_path)
        except FileNotFoundError:
            pass


def transcribe_audio_offline_segmented(
    model,
    *,
    engine: str,
    audio_data: bytes,
    language: str | None,
    sensevoice_use_itn: bool,
    output_word_timestamps: bool,
    silence_ms: int,
    min_speech_rms: int,
    analysis_window_ms: int,
    padding_ms: int,
    max_segment_ms: int,
    overlap_ms: int,
) -> dict:
    decoded = decode_wav_to_mono_pcm16(audio_data)
    if not decoded:
        return {
            "success": False,
            "error": "offline_segmented_requires_pcm16_wav",
            "text": "",
        }

    sample_rate = decoded["sample_rate"]
    pcm_mono = decoded["pcm_mono"]
    segments = detect_offline_segments(
        pcm_mono,
        sample_rate,
        silence_ms=silence_ms,
        min_speech_rms=min_speech_rms,
        analysis_window_ms=analysis_window_ms,
        padding_ms=padding_ms,
        max_segment_ms=max_segment_ms,
        overlap_ms=overlap_ms,
    )

    if not segments:
        return {
            "success": False,
            "error": "offline_segmented_detected_no_segments",
            "text": "",
        }

    merged_text = ""
    merged_language = language
    merged_word_timings = []
    segment_reports = []
    bytes_per_sample = 2

    for start_sample, end_sample in segments:
        segment_pcm = pcm_mono[start_sample * bytes_per_sample : end_sample * bytes_per_sample]
        if not segment_pcm:
            continue

        segment_payload = transcribe_audio_bytes(
            model,
            engine=engine,
            audio_data=encode_wav_pcm16_mono(segment_pcm, sample_rate),
            language=language,
            sensevoice_use_itn=sensevoice_use_itn,
            output_word_timestamps=output_word_timestamps,
        )
        segment_text = str(segment_payload.get("text") or "").strip()
        segment_word_timings = offset_word_timings(
            segment_payload.get("word_timings"),
            int(round((start_sample / sample_rate) * 1000)),
        )
        if merged_text and segment_text:
            overlap = find_text_overlap(merged_text, segment_text, 240)
            if overlap > 0:
                segment_word_timings = drop_word_timing_prefix(segment_word_timings, segment_text[:overlap])
                segment_text = segment_text[overlap:].lstrip()

        if segment_text:
            merged_text = merge_text(merged_text, segment_text)
        if isinstance(segment_word_timings, list) and segment_word_timings:
            merged_word_timings.extend(segment_word_timings)
        if segment_payload.get("language"):
            merged_language = segment_payload.get("language")

        segment_reports.append(
            {
                "startMs": int(round((start_sample / sample_rate) * 1000)),
                "endMs": int(round((end_sample / sample_rate) * 1000)),
                "text": segment_text,
            }
        )

    return {
        "success": True,
        "text": merged_text.strip(),
        "language": merged_language,
        "language_probability": None,
        "duration": round(len(pcm_mono) / 2 / sample_rate, 3),
        "word_timings": merged_word_timings or None,
        "transcription_profile": "offline_segmented",
        "offline_segments": segment_reports,
    }


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
    output_word_timestamps = parse_bool(params.get("return_word_timestamps", ["false"])[0], False)
    offline_segmented = parse_bool(params.get("offline_segmented", ["false"])[0], False)
    offline_segment_silence_ms = int(params.get("offline_segment_silence_ms", ["1200"])[0] or 1200)
    offline_segment_min_speech_rms = int(
        params.get("offline_segment_min_speech_rms", ["360"])[0] or 360
    )
    offline_segment_window_ms = int(params.get("offline_segment_window_ms", ["30"])[0] or 30)
    offline_segment_padding_ms = int(params.get("offline_segment_padding_ms", ["480"])[0] or 480)
    offline_segment_max_segment_ms = int(
        params.get("offline_segment_max_segment_ms", ["30000"])[0] or 30000
    )
    offline_segment_overlap_ms = int(params.get("offline_segment_overlap_ms", ["640"])[0] or 640)
    text_corrections = parse_text_corrections(params.get("text_corrections", [None])[0])

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

    try:
        model, model_reused, reload_reason = get_model(
            engine=engine,
            model_type=model_type,
            sensevoice_model_id=sensevoice_model_id,
            device=device,
            compute_type=compute_type,
            download_root=download_root,
        )

        if offline_segmented:
            payload = transcribe_audio_offline_segmented(
                model,
                engine=engine,
                audio_data=audio_data,
                language=language,
                sensevoice_use_itn=sensevoice_use_itn,
                output_word_timestamps=output_word_timestamps,
                silence_ms=max(60, offline_segment_silence_ms),
                min_speech_rms=max(50, offline_segment_min_speech_rms),
                analysis_window_ms=max(10, offline_segment_window_ms),
                padding_ms=max(0, offline_segment_padding_ms),
                max_segment_ms=max(1000, offline_segment_max_segment_ms),
                overlap_ms=max(0, offline_segment_overlap_ms),
            )
        else:
            payload = transcribe_audio_bytes(
                model,
                engine=engine,
                audio_data=audio_data,
                language=language,
                sensevoice_use_itn=sensevoice_use_itn,
                output_word_timestamps=output_word_timestamps,
            )

        if payload.get("success") is False:
            raise RuntimeError(payload.get("error") or "transcription_failed")

        corrected_text, corrected = apply_text_corrections(payload["text"], text_corrections)
        return {
            "success": True,
            "text": corrected_text,
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
            "transcription_profile": payload.get("transcription_profile", "single_shot"),
            "offline_segments": payload.get("offline_segments"),
            "word_timings": None if corrected else payload.get("word_timings"),
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
    if should_insert_space(left[-1], right[0]):
        return f"{left} {right}"
    return left + right


def is_cjk_char(ch: str) -> bool:
    return (
        "\u3040" <= ch <= "\u30ff"
        or "\u31f0" <= ch <= "\u31ff"
        or "\u3400" <= ch <= "\u4dbf"
        or "\u4e00" <= ch <= "\u9fff"
        or "\uf900" <= ch <= "\ufaff"
    )


def should_insert_space(left_char: str, right_char: str) -> bool:
    if not left_char or not right_char:
        return False
    if left_char.isspace() or right_char.isspace():
        return False
    if left_char in {"'", "’", "(", "[", "{"} or right_char in {"'", "’", ".", ",", "!", "?", ";", ":", ")", "]", "}"}:
        return False
    if is_cjk_char(left_char) or is_cjk_char(right_char):
        return False

    left_is_word = is_loose_word_char(left_char)
    right_is_word = is_loose_word_char(right_char)
    if left_is_word and right_is_word:
        return True
    if left_char in {".", ",", "!", "?", ";", ":"} and right_is_word:
        return True
    return False


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


def get_common_prefix(left: str, right: str) -> str:
    if not left or not right:
        return ""

    index = 0
    limit = min(len(left), len(right))
    while index < limit and left[index] == right[index]:
        index += 1
    return left[:index]


def collect_loose_chars(text: str) -> list[tuple[str, int]]:
    chars: list[tuple[str, int]] = []
    for index, ch in enumerate(text):
        if is_loose_word_char(ch):
            chars.append((ch.lower(), index))
    return chars


def replace_near_tail_with_incoming(previous: str, incoming: str) -> str | None:
    previous_chars = collect_loose_chars(previous)
    incoming_chars = collect_loose_chars(incoming)
    if len(previous_chars) < 6 or len(incoming_chars) < 6:
        return None

    max_size = min(24, len(previous_chars), len(incoming_chars))
    for size in range(max_size, 5, -1):
        incoming_prefix = "".join(ch for ch, _ in incoming_chars[:size])

        search_start = max(0, len(previous_chars) - size - 20)
        search_end = len(previous_chars) - size
        for start in range(search_end, search_start - 1, -1):
            candidate = "".join(ch for ch, _ in previous_chars[start : start + size])
            if candidate != incoming_prefix:
                continue

            replace_from = previous_chars[start][1]
            return merge_text(previous[:replace_from].rstrip(), incoming)

    return None


def merge_with_anchor_alignment(
    previous: str,
    incoming: str,
    *,
    min_match_chars: int = 6,
    max_previous_window_chars: int = 72,
    max_incoming_skip_chars: int = 8,
) -> str | None:
    previous_chars = collect_loose_chars(previous)
    incoming_chars = collect_loose_chars(incoming)
    if len(previous_chars) < min_match_chars or len(incoming_chars) < min_match_chars:
        return None

    previous_start_min = max(0, len(previous_chars) - max_previous_window_chars)
    incoming_skip_max = min(max_incoming_skip_chars, len(incoming_chars) - min_match_chars)
    best_match: tuple[int, int, int] | None = None

    for incoming_start in range(incoming_skip_max + 1):
        previous_start_max = len(previous_chars) - min_match_chars
        for previous_start in range(previous_start_max, previous_start_min - 1, -1):
            run = 0
            while (
                previous_start + run < len(previous_chars)
                and incoming_start + run < len(incoming_chars)
                and previous_chars[previous_start + run][0] == incoming_chars[incoming_start + run][0]
            ):
                run += 1

            if run < min_match_chars:
                continue

            if best_match is None or run > best_match[2]:
                best_match = (previous_start, incoming_start, run)
                continue

            if run == best_match[2]:
                _, best_incoming_start, _ = best_match
                if incoming_start < best_incoming_start:
                    best_match = (previous_start, incoming_start, run)

    if best_match is None:
        return None

    previous_start, incoming_start, run = best_match

    # When the new preview starts from the middle of an already visible sentence,
    # keep the matched prefix from the previous preview and only append the
    # truly new tail. This avoids artifacts like "HelloAnd welcome".
    previous_prefix = previous[: previous_chars[previous_start][1]]
    incoming_suffix = incoming[incoming_chars[incoming_start][1] :]

    if incoming_start == 0 and previous_start > 0 and incoming_suffix:
        matched_previous_char = previous[previous_chars[previous_start][1]]
        matched_incoming_char = incoming_suffix[0]
        if (
            matched_previous_char.isalpha()
            and matched_incoming_char.isalpha()
            and matched_previous_char.lower() == matched_incoming_char.lower()
        ):
            incoming_suffix = matched_previous_char + incoming_suffix[1:]

    if not incoming_suffix.strip():
        return None

    return merge_text(previous_prefix.rstrip(), incoming_suffix)


def accumulate_preview_text(previous: str, incoming: str) -> str:
    normalized_previous = (previous or "").strip()
    normalized_incoming = (incoming or "").strip()

    if not normalized_incoming:
        return normalized_previous
    if not normalized_previous:
        return normalized_incoming
    if normalized_incoming == normalized_previous:
        return normalized_incoming
    if normalized_incoming.startswith(normalized_previous):
        return normalized_incoming
    if normalized_previous.startswith(normalized_incoming):
        return normalized_previous

    common_prefix = get_common_prefix(normalized_previous, normalized_incoming)
    common_meaningful_chars = count_meaningful_chars(common_prefix)
    previous_meaningful_chars = count_meaningful_chars(normalized_previous)
    incoming_meaningful_chars = count_meaningful_chars(normalized_incoming)
    meaningful_floor = max(1, min(previous_meaningful_chars, incoming_meaningful_chars))

    if (
        common_meaningful_chars >= 12
        or common_meaningful_chars / meaningful_floor >= 0.7
    ):
        return normalized_incoming

    overlap = find_text_overlap(normalized_previous, normalized_incoming, 200)
    if overlap > 0:
        return merge_text(normalized_previous, normalized_incoming[overlap:])

    anchored = merge_with_anchor_alignment(normalized_previous, normalized_incoming)
    if anchored:
        return anchored

    replacement = replace_near_tail_with_incoming(normalized_previous, normalized_incoming)
    if replacement:
        return replacement

    previous_is_sentence_like = (
        normalized_previous[-1] in {"。", "！", "？", "!", "?"}
        and previous_meaningful_chars >= 12
    )
    if previous_is_sentence_like and incoming_meaningful_chars >= 8:
        return merge_text(normalized_previous, normalized_incoming)

    return normalized_incoming


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
WEAK_ENGLISH_SUFFIX_RE = re.compile(
    r"\b(?:and|or|to|of|for|with|the|a|an|but|so|if|that|this|these|those|my|your|our|their|his|her|its|you|we|they|he|she|it|is|are|was|were|be|been|being|do|did|does|have|has|had)$",
    re.IGNORECASE,
)
LATIN_CHAR_RE = re.compile(r"[A-Za-z]")
CJK_CHAR_RE = re.compile(r"[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")

ENGLISH_SENTENCE_MIN_FLUSH_CHARS = 14
ENGLISH_SENTENCE_SOFT_FLUSH_CHARS = 28
ENGLISH_SENTENCE_FORCE_FLUSH_CHARS = 48
ENGLISH_STRONG_PUNCTUATION_MIN_TAIL_CHARS = 3
ENGLISH_PREVIEW_STABILITY_WINDOW = 4
ENGLISH_PREVIEW_STABLE_TAIL_CHARS = 6
ENGLISH_PREVIEW_MAX_STABLE_ROLLBACK_CHARS = 4
ENGLISH_SILENCE_THRESHOLD_MULTIPLIER = 1.5
ENGLISH_SILENCE_THRESHOLD_MIN_MS = 900


def count_meaningful_chars(text: str) -> int:
    count = 0
    for ch in text:
        if ch.isalnum() or "\u3040" <= ch <= "\u30ff" or "\u31f0" <= ch <= "\u31ff" or "\u3400" <= ch <= "\u9fff":
            count += 1
    return count


def is_latin_dominant_text(text: str) -> bool:
    latin_count = 0
    cjk_count = 0
    for ch in text:
        if LATIN_CHAR_RE.search(ch):
            latin_count += 1
            continue
        if CJK_CHAR_RE.search(ch):
            cjk_count += 1
    return latin_count >= 6 and latin_count >= cjk_count * 2


def trim_loose_prefix(text: str, prefix: str) -> str | None:
    normalized_text = (text or "").strip()
    normalized_prefix = (prefix or "").strip()
    if not normalized_text or not normalized_prefix:
        return None

    text_chars = collect_loose_chars(normalized_text)
    prefix_chars = collect_loose_chars(normalized_prefix)
    if not text_chars or not prefix_chars or len(prefix_chars) > len(text_chars):
        return None

    if "".join(ch for ch, _ in text_chars[: len(prefix_chars)]) != "".join(
        ch for ch, _ in prefix_chars
    ):
        return None

    cut_index = text_chars[len(prefix_chars) - 1][1] + 1
    return normalized_text[cut_index:].lstrip()


def drop_word_timing_prefix(
    word_timings: list[dict] | None, prefix_text: str, max_items: int = 12
) -> list[dict] | None:
    if not isinstance(word_timings, list) or not word_timings:
        return None

    normalized_prefix = normalize_loose_text(prefix_text)
    if not normalized_prefix:
        return word_timings

    merged_prefix = ""
    for index, item in enumerate(word_timings[:max_items]):
        text = item.get("text")
        if not isinstance(text, str) or not text.strip():
            continue

        merged_prefix = merge_text(merged_prefix, text.strip()) if merged_prefix else text.strip()
        merged_normalized = normalize_loose_text(merged_prefix)
        if not merged_normalized:
            continue
        if merged_normalized == normalized_prefix:
            remaining = word_timings[index + 1 :]
            return remaining or None
        if len(merged_normalized) > len(normalized_prefix):
            break

    return word_timings


def split_word_timings_by_prefix(
    word_timings: list[dict] | None,
    prefix_text: str,
    max_items: int = 96,
) -> tuple[list[dict] | None, list[dict] | None]:
    if not isinstance(word_timings, list) or not word_timings:
        return None, None

    normalized_prefix = normalize_loose_text(prefix_text)
    if not normalized_prefix:
        return None, word_timings
    stripped_prefix_text = prefix_text.strip()
    trailing_punctuation_chars: list[str] = []
    for ch in reversed(stripped_prefix_text):
        if ch.isspace():
            continue
        if is_loose_word_char(ch):
            break
        trailing_punctuation_chars.append(ch)
    trailing_punctuation = "".join(reversed(trailing_punctuation_chars))

    merged_prefix = ""
    for index, item in enumerate(word_timings[:max_items]):
        text = item.get("text")
        if not isinstance(text, str) or not text.strip():
            continue

        merged_prefix = merge_text(merged_prefix, text.strip()) if merged_prefix else text.strip()
        merged_normalized = normalize_loose_text(merged_prefix)
        if not merged_normalized:
            continue
        if merged_normalized == normalized_prefix:
            split_index = index + 1
            if trailing_punctuation:
                matched_punctuation = ""
                while split_index < len(word_timings):
                    next_text = word_timings[split_index].get("text")
                    if not isinstance(next_text, str) or not next_text.strip():
                        split_index += 1
                        continue
                    stripped_next_text = next_text.strip()
                    if is_loose_word_char(stripped_next_text[0]):
                        break
                    matched_punctuation += stripped_next_text
                    split_index += 1
                    if matched_punctuation == trailing_punctuation:
                        break
                    if not trailing_punctuation.startswith(matched_punctuation):
                        split_index = index + 1
                        break

            committed = word_timings[:split_index]
            remaining = word_timings[split_index:]
            return committed or None, remaining or None
        if len(merged_normalized) > len(normalized_prefix):
            break

    return None, word_timings


def deduplicate_timed_prefix_from_base(
    base_text: str,
    incoming_text: str,
    word_timings: list[dict] | None,
    *,
    max_items: int = 8,
    max_end_ms: int = 900,
) -> tuple[str, list[dict] | None]:
    if not base_text or not incoming_text or not isinstance(word_timings, list) or not word_timings:
        return incoming_text, word_timings

    normalized_base = normalize_loose_text(base_text)
    if not normalized_base:
        return incoming_text, word_timings

    merged_prefix = ""
    best_trimmed_text = incoming_text
    best_drop_count = 0
    best_prefix_chars = 0
    for index, item in enumerate(word_timings[:max_items]):
        text = item.get("text")
        end_ms = item.get("endMs")
        if not isinstance(text, str) or not text.strip():
            continue
        if index > 0 and isinstance(end_ms, (int, float)) and end_ms > max_end_ms:
            break

        merged_prefix = merge_text(merged_prefix, text.strip()) if merged_prefix else text.strip()
        normalized_prefix = normalize_loose_text(merged_prefix)
        if len(normalized_prefix) < 3 or not normalized_base.endswith(normalized_prefix):
            continue

        trimmed_text = trim_loose_prefix(incoming_text, merged_prefix)
        if trimmed_text is None or not trimmed_text.strip():
            continue

        if len(normalized_prefix) > best_prefix_chars:
            best_prefix_chars = len(normalized_prefix)
            best_trimmed_text = trimmed_text.strip()
            best_drop_count = index + 1

    if best_drop_count <= 0:
        return incoming_text, word_timings

    remaining = word_timings[best_drop_count:]
    return best_trimmed_text, remaining or None


def has_unstable_timing_tail(
    word_timings: list[dict] | None,
    audio_duration_ms: float,
    unstable_text: str,
    *,
    near_end_ms: int = 240,
    max_tail_span_ms: int = 650,
    max_tail_items: int = 4,
    min_unstable_chars: int = 2,
) -> bool:
    if not isinstance(word_timings, list) or not word_timings or audio_duration_ms <= 0:
        return False

    unstable_chars = count_meaningful_chars((unstable_text or "").strip())
    if unstable_chars < min_unstable_chars:
        return False

    valid_items = []
    for item in word_timings:
        start_ms = item.get("startMs")
        end_ms = item.get("endMs")
        if not isinstance(start_ms, (int, float)) or not isinstance(end_ms, (int, float)):
            continue
        if end_ms < start_ms:
            continue
        valid_items.append(item)

    if not valid_items:
        return False

    last_end_ms = float(valid_items[-1]["endMs"])
    if max(0.0, audio_duration_ms - last_end_ms) > near_end_ms:
        return False

    tail_items: list[dict] = []
    collected_chars = 0
    for item in reversed(valid_items):
        tail_items.insert(0, item)
        collected_chars += count_meaningful_chars(str(item.get("text") or ""))
        if len(tail_items) >= max_tail_items or collected_chars >= unstable_chars:
            break

    if not tail_items:
        return False

    tail_span_ms = float(tail_items[-1]["endMs"]) - float(tail_items[0]["startMs"])
    return tail_span_ms <= max_tail_span_ms


def has_min_stable_preview_coverage(
    candidate: str,
    stable_preview: str,
    unstable_preview: str,
    *,
    min_stable_tail_chars: int = 6,
    max_unstable_chars: int = 4,
) -> bool:
    normalized_candidate = (candidate or "").strip()
    normalized_stable = (stable_preview or "").strip()
    normalized_unstable = (unstable_preview or "").strip()
    if not normalized_candidate or not normalized_stable:
        return False

    stable_prefix = get_common_prefix(normalized_candidate, normalized_stable)
    stable_prefix_chars = count_meaningful_chars(stable_prefix)
    if stable_prefix_chars < min_stable_tail_chars:
        return False

    remaining_chars = count_meaningful_chars(normalized_candidate[len(stable_prefix) :])
    if remaining_chars > max_unstable_chars:
        return False

    unstable_chars = count_meaningful_chars(normalized_unstable)
    if unstable_chars > max_unstable_chars:
        return False

    stable_tail = get_tail_after_last_boundary(stable_prefix.rstrip("。！？!?，、,;；:： \t\r\n"))
    return count_meaningful_chars(stable_tail) >= min_stable_tail_chars


def is_abnormal_short_final_chunk(
    text: str,
    word_timings: list[dict] | None,
    *,
    max_meaningful_chars: int = 2,
    max_timing_items: int = 2,
) -> bool:
    normalized = (text or "").strip()
    if not normalized:
        return False

    meaningful_chars = count_meaningful_chars(normalized)
    if meaningful_chars <= 0:
        return True
    if meaningful_chars > max_meaningful_chars:
        return False
    if not any(ch.isalnum() or is_loose_word_char(ch) for ch in normalized):
        return True
    if normalized[-1] in {"。", "！", "？", "!", "?"} and not has_stable_final_boundary(
        normalized, min_tail_chars=max_meaningful_chars + 1
    ):
        return True
    if isinstance(word_timings, list) and len(word_timings) <= max_timing_items:
        return True
    return is_weak_boundary_suffix(normalized)


def trim_stable_prefix(text: str, keep_tail_meaningful_chars: int) -> str:
    normalized = (text or "").strip()
    if not normalized:
        return ""

    if keep_tail_meaningful_chars <= 0:
        return normalized

    remaining = keep_tail_meaningful_chars
    index = len(normalized)
    while index > 0 and remaining > 0:
        index -= 1
        if is_loose_word_char(normalized[index]):
            remaining -= 1

    if remaining > 0:
        return ""
    return normalized[:index].rstrip()


def trim_latin_stable_prefix(prefix: str, full_text: str) -> str:
    normalized_prefix = (prefix or "").rstrip()
    normalized_full = (full_text or "").strip()
    if not normalized_prefix or not normalized_full or not is_latin_dominant_text(normalized_full):
        return normalized_prefix

    candidate = normalized_prefix
    while candidate:
        next_char = normalized_full[len(candidate)] if len(candidate) < len(normalized_full) else ""
        if candidate[-1].isalnum() and next_char and next_char.isalnum():
            boundary_index = max(
                candidate.rfind(" "),
                candidate.rfind("\t"),
                candidate.rfind("\r"),
                candidate.rfind("\n"),
                candidate.rfind(","),
                candidate.rfind(";"),
                candidate.rfind(":"),
                candidate.rfind("-"),
                candidate.rfind("("),
            )
            if boundary_index < 0:
                return ""
            candidate = candidate[:boundary_index].rstrip()
            continue
        if is_weak_boundary_suffix(candidate):
            boundary_index = max(
                candidate.rfind(" "),
                candidate.rfind("\t"),
                candidate.rfind("\r"),
                candidate.rfind("\n"),
                candidate.rfind(","),
                candidate.rfind(";"),
                candidate.rfind(":"),
                candidate.rfind("-"),
                candidate.rfind("("),
            )
            if boundary_index < 0:
                return ""
            candidate = candidate[:boundary_index].rstrip()
            continue
        break

    return candidate


def get_common_prefix_for_many(texts: list[str]) -> str:
    if not texts:
        return ""

    prefix = texts[0]
    for text in texts[1:]:
        prefix = get_common_prefix(prefix, text)
        if not prefix:
            break
    return prefix


def shrink_stable_prefix(previous_stable: str, next_stable: str, max_rollback_chars: int) -> str:
    if not previous_stable:
        return next_stable
    if next_stable.startswith(previous_stable):
        return next_stable

    common = get_common_prefix(previous_stable, next_stable)
    rollback_chars = count_meaningful_chars(previous_stable[len(common) :])
    if rollback_chars <= max_rollback_chars:
        return common.rstrip()
    return previous_stable


def should_guard_preview_reset(
    previous_preview: str,
    incoming_preview: str,
    accumulated_preview: str,
    stable_prefix: str,
) -> bool:
    normalized_previous = (previous_preview or "").strip()
    normalized_incoming = (incoming_preview or "").strip()
    normalized_accumulated = (accumulated_preview or "").strip()
    normalized_stable = (stable_prefix or "").strip()
    if not normalized_previous or not normalized_incoming or not normalized_stable:
        return False
    if normalized_accumulated != normalized_incoming:
        return False
    if not normalized_previous.startswith(normalized_stable):
        return False
    if not is_latin_dominant_text(normalized_previous) and not is_latin_dominant_text(normalized_incoming):
        return False

    previous_chars = count_meaningful_chars(normalized_previous)
    incoming_chars = count_meaningful_chars(normalized_incoming)
    stable_chars = count_meaningful_chars(normalized_stable)
    if previous_chars < 18 or incoming_chars < 4 or stable_chars < 8:
        return False
    if incoming_chars > max(12, int(previous_chars * 0.72)):
        return False

    common_prefix_chars = count_meaningful_chars(get_common_prefix(normalized_previous, normalized_incoming))
    if common_prefix_chars >= min(8, stable_chars):
        return False
    if normalized_incoming.startswith(normalized_stable):
        return False
    return True


def guard_preview_reset_with_stable_prefix(stable_prefix: str, incoming_preview: str) -> str:
    normalized_stable = (stable_prefix or "").strip()
    normalized_incoming = (incoming_preview or "").strip()
    if not normalized_stable:
        return normalized_incoming
    if not normalized_incoming:
        return normalized_stable
    if normalized_incoming.startswith(normalized_stable):
        return normalized_incoming
    return merge_streaming_chunk_text(normalized_stable, normalized_incoming)


def is_weak_boundary_suffix(text: str) -> bool:
    normalized = (text or "").strip()
    if not normalized:
        return False

    trimmed = normalized.rstrip("。！？!?.，、,;；:： \t\r\n")
    if not trimmed:
        return True

    if WEAK_ENGLISH_SUFFIX_RE.search(trimmed.lower()):
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

    without_trailing_boundary = normalized.rstrip("。！？!?.")
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
        candidate_tail.rstrip("。！？!?.，、,;；:： \t\r\n")
    )
    normalized_preview_tail = normalize_loose_text(
        preview_tail.rstrip("。！？!?.，、,;；:： \t\r\n")
    )
    if len(normalized_candidate_tail) < 4 or len(normalized_preview_tail) <= len(normalized_candidate_tail):
        return None
    if not normalized_preview_tail.startswith(normalized_candidate_tail):
        return None

    return replace_trailing_tail(candidate, preview_tail.rstrip("。！？!?. \t\r\n"))


def has_stable_final_boundary(text: str, min_tail_chars: int = 3) -> bool:
    normalized = (text or "").strip()
    if not normalized or normalized[-1] not in {"。", "！", "？", "!", "?", "."}:
        return False

    without_punctuation = normalized.rstrip("。！？!?.")
    if not without_punctuation:
        return False

    tail = get_tail_after_last_boundary(without_punctuation)
    return count_meaningful_chars(tail) >= min_tail_chars and not is_weak_boundary_suffix(normalized)


def should_flush_sentence_by_boundary(
    sentence: str,
    endpoint_triggered: bool,
    *,
    sentence_min_flush_chars: int = 14,
    sentence_soft_flush_chars: int = 28,
    sentence_force_flush_chars: int = 48,
    strong_punctuation_min_tail_chars: int = 3,
) -> bool:
    normalized = (sentence or "").strip()
    if not normalized:
        return False

    if is_latin_dominant_text(normalized):
        sentence_min_flush_chars = ENGLISH_SENTENCE_MIN_FLUSH_CHARS
        sentence_soft_flush_chars = ENGLISH_SENTENCE_SOFT_FLUSH_CHARS
        sentence_force_flush_chars = ENGLISH_SENTENCE_FORCE_FLUSH_CHARS
        strong_punctuation_min_tail_chars = ENGLISH_STRONG_PUNCTUATION_MIN_TAIL_CHARS

    meaningful_chars = count_meaningful_chars(normalized)
    if meaningful_chars >= sentence_force_flush_chars:
        return True

    if normalized.endswith(("。", "！", "？", "!", "?", ".")):
        without_punctuation = normalized.rstrip("。！？!?.")
        if without_punctuation:
            tail = get_tail_after_last_boundary(without_punctuation)
            if (
                meaningful_chars >= sentence_min_flush_chars
                and count_meaningful_chars(tail) >= strong_punctuation_min_tail_chars
            ):
                return True

    if normalized.endswith(("，", "、", ",", ";", "；", ":", "：")):
        if meaningful_chars >= sentence_soft_flush_chars:
            return True

    if endpoint_triggered and meaningful_chars >= sentence_min_flush_chars and not is_weak_boundary_suffix(normalized):
        return True

    return False


def find_committable_sentence_prefix(
    text: str,
    *,
    min_prefix_chars: int = 8,
    min_suffix_chars: int = 3,
) -> tuple[str, str] | None:
    normalized = (text or "").strip()
    if not normalized or has_stable_final_boundary(normalized):
        return None

    best_split: tuple[str, str] | None = None
    for index, ch in enumerate(normalized[:-1]):
        if ch not in {"。", "！", "？", "!", "?", "."}:
            continue

        prefix = normalized[: index + 1].strip()
        suffix = normalized[index + 1 :].strip()
        if not prefix or not suffix:
            continue
        if count_meaningful_chars(prefix) < min_prefix_chars:
            continue
        if count_meaningful_chars(suffix) < min_suffix_chars:
            continue
        best_split = (prefix, suffix)

    return best_split


class TranscriptAssembler:
    """Owns transcript semantics for one streaming session."""

    PREVIEW_STABILITY_WINDOW = 3
    PREVIEW_STABLE_TAIL_CHARS = 6
    PREVIEW_MAX_STABLE_ROLLBACK_CHARS = 6

    def __init__(self, normalize_event_text, text_corrections: list[dict]):
        self.normalize_event_text = normalize_event_text
        self.text_corrections = text_corrections
        self.final_text_raw = ""
        self.final_text = ""
        self.pending_sentence_text = ""
        self.pending_final_chunk = ""
        self.pending_final_word_timings = None
        self.current_preview_text = ""
        self.current_preview_stable_text = ""
        self.current_preview_unstable_text = ""
        self.preview_history: list[str] = []
        self.last_preview_text = ""

    def get_visible_text_base(self) -> str:
        return merge_text(self.final_text_raw, self.pending_final_chunk).strip()

    def reset_preview_state(self):
        self.current_preview_text = ""
        self.current_preview_stable_text = ""
        self.current_preview_unstable_text = ""
        self.preview_history = []
        self.last_preview_text = ""

    def build_preview_snapshot(self, text: str) -> tuple[str, str]:
        normalized = self.normalize_event_text(text).strip()
        if not normalized:
            self.preview_history = []
            self.current_preview_stable_text = ""
            self.current_preview_unstable_text = ""
            return "", ""

        self.preview_history.append(normalized)
        stability_window = self.PREVIEW_STABILITY_WINDOW
        stable_tail_chars = self.PREVIEW_STABLE_TAIL_CHARS
        max_stable_rollback_chars = self.PREVIEW_MAX_STABLE_ROLLBACK_CHARS
        if is_latin_dominant_text(normalized):
            stability_window = ENGLISH_PREVIEW_STABILITY_WINDOW
            stable_tail_chars = ENGLISH_PREVIEW_STABLE_TAIL_CHARS
            max_stable_rollback_chars = ENGLISH_PREVIEW_MAX_STABLE_ROLLBACK_CHARS

        if len(self.preview_history) > stability_window:
            self.preview_history = self.preview_history[-stability_window:]

        stable_candidate = trim_stable_prefix(
            get_common_prefix_for_many(self.preview_history),
            stable_tail_chars,
        )
        stable_candidate = trim_latin_stable_prefix(stable_candidate, normalized)
        next_stable = shrink_stable_prefix(
            self.current_preview_stable_text,
            stable_candidate,
            max_stable_rollback_chars,
        )
        if stable_candidate.startswith(next_stable):
            next_stable = stable_candidate

        if normalized.startswith(next_stable):
            unstable = normalized[len(next_stable) :].lstrip()
        else:
            next_stable = ""
            unstable = normalized

        self.current_preview_stable_text = next_stable
        self.current_preview_unstable_text = unstable
        return next_stable, unstable

    def build_interim_event(
        self,
        deduped_preview_text: str,
        *,
        word_timings: list[dict] | None,
    ) -> dict | None:
        accumulated = accumulate_preview_text(self.current_preview_text, deduped_preview_text)
        normalized_accumulated = self.normalize_event_text(accumulated)
        if should_guard_preview_reset(
            self.current_preview_text,
            deduped_preview_text,
            normalized_accumulated,
            self.current_preview_stable_text,
        ):
            normalized_accumulated = self.normalize_event_text(
                guard_preview_reset_with_stable_prefix(
                    self.current_preview_stable_text,
                    deduped_preview_text,
                )
            )
        self.current_preview_text = normalized_accumulated
        self.last_preview_text = deduped_preview_text
        if not normalized_accumulated.strip():
            return None

        stable_text, unstable_text = self.build_preview_snapshot(normalized_accumulated)
        return {
            "type": "interim",
            "text": normalized_accumulated,
            "stableText": stable_text,
            "unstableText": unstable_text,
            "wordTimings": word_timings,
            "ts": int(time.time() * 1000),
        }

    def queue_final_chunk(self, text: str, word_timings: list[dict] | None):
        self.pending_final_chunk = merge_streaming_chunk_text(self.pending_final_chunk, text)
        self.pending_final_word_timings = word_timings

    def consume_sentence_delta(self, sentence_text: str) -> str:
        normalized_sentence = self.normalize_event_text(sentence_text).strip()
        if not normalized_sentence:
            return ""
        pending = self.pending_sentence_text.strip()
        if not pending:
            return ""
        if pending.startswith(normalized_sentence):
            remainder = pending[len(normalized_sentence) :].lstrip()
            self.pending_sentence_text = remainder
            return normalized_sentence
        self.pending_sentence_text = ""
        return normalized_sentence

    def maybe_emit_sentence_event(self, reason: str, *, force: bool = False) -> list[dict]:
        normalized = self.pending_sentence_text.strip()
        if not normalized:
            self.pending_sentence_text = ""
            return []
        endpoint_triggered = reason in {"silence", "max_chunk", "flush", "close"}
        if not force and not should_flush_sentence_by_boundary(normalized, endpoint_triggered):
            return []
        self.pending_sentence_text = ""
        return [{"type": "sentence", "text": normalized, "ts": int(time.time() * 1000)}]

    def commit_pending_final_chunk(self, reason: str) -> list[dict]:
        normalized_raw = self.pending_final_chunk.strip()
        if not normalized_raw:
            self.pending_final_chunk = ""
            self.pending_final_word_timings = None
            self.reset_preview_state()
            return []

        self.pending_final_chunk = ""
        word_timings = self.pending_final_word_timings
        self.pending_final_word_timings = None
        corrected_text, corrected = apply_text_corrections(normalized_raw, self.text_corrections)
        if corrected:
            word_timings = None
        self.reset_preview_state()
        self.final_text_raw = merge_text(self.final_text_raw, normalized_raw)
        self.final_text = merge_text(self.final_text, corrected_text)
        self.pending_sentence_text = merge_text(self.pending_sentence_text, corrected_text).strip()
        events = [
            {
                "type": "final_chunk",
                "text": corrected_text,
                "wordTimings": word_timings,
                "ts": int(time.time() * 1000),
            },
        ]
        events.extend(self.maybe_emit_sentence_event(reason))
        events.append({"type": "endpoint", "reason": reason, "ts": int(time.time() * 1000)})
        return events

    def commit_sentence_prefix_if_possible(self, reason: str) -> tuple[bool, list[dict]]:
        split = find_committable_sentence_prefix(self.pending_final_chunk)
        if not split:
            return False, []

        commit_text, remaining_text = split
        commit_timings, remaining_timings = split_word_timings_by_prefix(
            self.pending_final_word_timings,
            commit_text,
        )
        if commit_timings is None:
            return False, []

        self.pending_final_chunk = commit_text
        self.pending_final_word_timings = commit_timings
        events = self.commit_pending_final_chunk(reason)
        self.pending_final_chunk = remaining_text
        self.pending_final_word_timings = remaining_timings
        return True, events


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
        self.text_corrections = parse_text_corrections(params.get("text_corrections", [None])[0])
        self.assembler = TranscriptAssembler(self.normalize_event_text, self.text_corrections)
        self.last_preview_at = 0.0
        self.last_preview_audio_bytes = 0
        self.buffer_start_at = 0.0
        self.last_audio_at = time.time()
        self.closed = False

    @property
    def final_text_raw(self):
        return self.assembler.final_text_raw

    @final_text_raw.setter
    def final_text_raw(self, value):
        self.assembler.final_text_raw = value

    @property
    def final_text(self):
        return self.assembler.final_text

    @final_text.setter
    def final_text(self, value):
        self.assembler.final_text = value

    @property
    def pending_final_chunk(self):
        return self.assembler.pending_final_chunk

    @pending_final_chunk.setter
    def pending_final_chunk(self, value):
        self.assembler.pending_final_chunk = value

    @property
    def pending_final_word_timings(self):
        return self.assembler.pending_final_word_timings

    @pending_final_word_timings.setter
    def pending_final_word_timings(self, value):
        self.assembler.pending_final_word_timings = value

    @property
    def current_preview_text(self):
        return self.assembler.current_preview_text

    @current_preview_text.setter
    def current_preview_text(self, value):
        self.assembler.current_preview_text = value

    @property
    def current_preview_stable_text(self):
        return self.assembler.current_preview_stable_text

    @current_preview_stable_text.setter
    def current_preview_stable_text(self, value):
        self.assembler.current_preview_stable_text = value

    @property
    def current_preview_unstable_text(self):
        return self.assembler.current_preview_unstable_text

    @current_preview_unstable_text.setter
    def current_preview_unstable_text(self, value):
        self.assembler.current_preview_unstable_text = value

    @property
    def preview_history(self):
        return self.assembler.preview_history

    @preview_history.setter
    def preview_history(self, value):
        self.assembler.preview_history = value

    @property
    def last_preview_text(self):
        return self.assembler.last_preview_text

    @last_preview_text.setter
    def last_preview_text(self, value):
        self.assembler.last_preview_text = value

    def normalize_event_text(self, text: str) -> str:
        normalized = text or ""
        language = (self.params.get("language", [""])[0] or "").lower()
        if language.startswith("ja") or re.search(r"[\u3040-\u30ff\u3400-\u9fff]", normalized):
            normalized = cleanup_japanese_asr_text(normalized)
        return normalized

    def is_english_session(self) -> bool:
        language = (self.params.get("language", [""])[0] or "").lower()
        return language.startswith("en")

    def get_effective_silence_threshold_ms(self) -> int:
        if not self.is_english_session():
            return self.silence_threshold_ms
        return max(
            ENGLISH_SILENCE_THRESHOLD_MIN_MS,
            int(self.silence_threshold_ms * ENGLISH_SILENCE_THRESHOLD_MULTIPLIER),
        )

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
        return self.assembler.get_visible_text_base()

    def reset_preview_state(self):
        self.assembler.reset_preview_state()

    def emit_json(self, payload: dict):
        text = payload.get("text")
        if isinstance(text, str) and payload.get("type") in {"interim", "final_chunk", "sentence", "final"}:
            payload = {**payload, "text": self.normalize_event_text(text)}
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
        preview_word_timings = result.get("word_timings")
        overlap = find_text_overlap(self.get_visible_text_base(), preview_text)
        if overlap > 0:
            deduped = preview_text[overlap:]
            preview_word_timings = drop_word_timing_prefix(preview_word_timings, preview_text[:overlap])
        else:
            deduped, preview_word_timings = deduplicate_timed_prefix_from_base(
                self.get_visible_text_base(),
                preview_text,
                preview_word_timings,
            )
        payload = self.assembler.build_interim_event(
            deduped,
            word_timings=preview_word_timings,
        )
        if not payload:
            return
        self.emit_json(payload)

    def commit_pending_final_chunk(self, reason: str):
        for event in self.assembler.commit_pending_final_chunk(reason):
            self.emit_json(event)

    def commit_sentence_prefix_if_possible(self, reason: str) -> bool:
        committed, events = self.assembler.commit_sentence_prefix_if_possible(reason)
        for event in events:
            self.emit_json(event)
        return committed

    def should_defer_final_chunk(
        self, candidate: str, reason: str, word_timings: list[dict] | None = None
    ) -> bool:
        normalized = candidate.strip()
        if not normalized:
            return False
        if reason == "silence" and is_latin_dominant_text(normalized) and is_weak_boundary_suffix(normalized):
            return True
        if reason not in {"flush", "close"} and is_abnormal_short_final_chunk(normalized, word_timings):
            return True
        if reason != "max_chunk":
            return False
        preview_extension = try_extend_candidate_with_preview(normalized, self.last_preview_text)
        if preview_extension:
            self.pending_final_chunk = preview_extension
            return True
        pending_audio_ms = self.duration_ms_from_bytes(len(self.pending_pcm))
        if has_unstable_timing_tail(
            word_timings,
            pending_audio_ms,
            self.current_preview_unstable_text,
        ):
            return True
        if not has_min_stable_preview_coverage(
            normalized,
            self.current_preview_stable_text,
            self.current_preview_unstable_text,
        ):
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
            self.reset_preview_state()
            self.retain_overlap()
            return

        final_word_timings = result.get("word_timings")
        overlap = find_text_overlap(self.get_visible_text_base(), final_chunk)
        if overlap > 0:
            deduped = final_chunk[overlap:]
            final_word_timings = drop_word_timing_prefix(final_word_timings, final_chunk[:overlap])
        else:
            deduped, final_word_timings = deduplicate_timed_prefix_from_base(
                self.get_visible_text_base(),
                final_chunk,
                final_word_timings,
            )
        if deduped.strip():
            self.assembler.queue_final_chunk(deduped, final_word_timings)
            if reason in {"max_chunk", "silence"} and self.commit_sentence_prefix_if_possible(reason):
                if self.pending_final_chunk and not self.should_defer_final_chunk(
                    self.pending_final_chunk,
                    reason,
                    self.pending_final_word_timings,
                ):
                    self.commit_pending_final_chunk(reason)
            elif not self.should_defer_final_chunk(
                self.pending_final_chunk,
                reason,
                self.pending_final_word_timings,
            ):
                self.commit_pending_final_chunk(reason)

        self.pending_new_bytes = 0
        self.reset_preview_state()
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
        if pending_ms >= self.min_chunk_ms and silence_ms >= self.get_effective_silence_threshold_ms():
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
                        for event in self.assembler.maybe_emit_sentence_event("flush", force=True):
                            self.emit_json(event)
                        self.emit_json(
                            {
                                "type": "final",
                                "text": self.final_text,
                                "wordTimings": None,
                                "ts": int(time.time() * 1000),
                            }
                        )
                    elif msg_type == "close":
                        self.emit_final("close")
                        self.commit_pending_final_chunk("close")
                        for event in self.assembler.maybe_emit_sentence_event("close", force=True):
                            self.emit_json(event)
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
                    "events": ["interim", "final_chunk", "sentence", "endpoint", "final", "error"],
                    "audio_format": "pcm_s16le",
                    "sample_rate": 16000,
                    "ws_path": "/stream",
                    "ws_port": _runtime_policy["ws_port"],
                    "interim_schema": {
                        "text": "Current uncommitted preview snapshot",
                        "stableText": "Stable prefix within the current uncommitted preview",
                        "unstableText": "Unstable tail still allowed to change",
                        "wordTimings": "Optional per-word timings when return_word_timestamps=true and engine supports it",
                    },
                    "final_chunk_schema": {
                        "text": "Newly committed text delta emitted once",
                        "wordTimings": "Optional per-word timings for the committed delta",
                    },
                    "sentence_schema": {
                        "text": "Newly finalized sentence text for downstream translation or pairing",
                    },
                    "query_options": {
                        "return_word_timestamps": "Set to true to request optional per-word timings when supported",
                        "text_corrections": "Optional JSON object with user-configurable text correction entries",
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


