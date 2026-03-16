import glob
import os
import sys
import tempfile
import threading
import time
import traceback

from audio_utils import (
    build_word_timings,
    decode_wav_to_mono_pcm16,
    detect_offline_segments,
    encode_wav_pcm16_mono,
    offset_word_timings,
)
from text_processing import (
    apply_text_corrections,
    drop_word_timing_prefix,
    find_text_overlap,
    merge_text,
    parse_bool,
    parse_positive_int,
    parse_text_corrections,
)

DEFAULT_SENSEVOICE_MODEL_ID = "FunAudioLLM/SenseVoiceSmall"
DEFAULT_SENSEVOICE_VAD_MODEL = "fsmn-vad"


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
    "sensevoice_vad_model": None,
    "sensevoice_vad_max_single_segment_time_ms": None,
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
    "sensevoice_vad_model": None,
    "sensevoice_vad_merge": True,
    "sensevoice_vad_merge_length_s": 15.0,
    "sensevoice_vad_max_single_segment_time_ms": 30000,
    "device": "cpu",
    "compute_type": "int8",
    "download_root": None,
    "ws_port": 8766,
}


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


def load_sensevoice_model(
    sensevoice_model_id: str,
    device: str,
    download_root: str | None,
    *,
    sensevoice_vad_model: str | None = None,
    sensevoice_vad_max_single_segment_time_ms: int | None = None,
):
    from funasr import AutoModel

    ensure_download_env(download_root)
    resolved_device = resolve_sensevoice_device(device)
    options = {
        "model": sensevoice_model_id,
        "device": resolved_device,
        "hub": "hf",
        "disable_update": True,
    }
    if sensevoice_vad_model:
        options["vad_model"] = sensevoice_vad_model
        if (
            isinstance(sensevoice_vad_max_single_segment_time_ms, int)
            and sensevoice_vad_max_single_segment_time_ms > 0
        ):
            options["vad_kwargs"] = {
                "max_single_segment_time": sensevoice_vad_max_single_segment_time_ms
            }
    return AutoModel(
        **options,
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
    sensevoice_vad_model: str | None,
    sensevoice_vad_max_single_segment_time_ms: int | None,
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
        if _model_info["sensevoice_vad_model"] != sensevoice_vad_model:
            reload_reasons.append("sensevoice_vad_model_changed")
        if (
            _model_info["sensevoice_vad_max_single_segment_time_ms"]
            != sensevoice_vad_max_single_segment_time_ms
        ):
            reload_reasons.append("sensevoice_vad_max_single_segment_time_ms_changed")
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
                    f"vad_model={sensevoice_vad_model or 'off'}, "
                    f"vad_max_single_segment_time_ms={sensevoice_vad_max_single_segment_time_ms or '-'}, "
                    f"device={device}, compute={compute_type}",
                    flush=True,
                )
                _model = load_sensevoice_model(
                    sensevoice_model_id,
                    device,
                    download_root,
                    sensevoice_vad_model=sensevoice_vad_model,
                    sensevoice_vad_max_single_segment_time_ms=sensevoice_vad_max_single_segment_time_ms,
                )
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
                    "sensevoice_vad_model": sensevoice_vad_model,
                    "sensevoice_vad_max_single_segment_time_ms": (
                        sensevoice_vad_max_single_segment_time_ms
                    ),
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


def transcribe_with_sensevoice(
    model,
    temp_path: str,
    language: str | None,
    sensevoice_use_itn: bool,
    sensevoice_vad_merge: bool,
    sensevoice_vad_merge_length_s: float,
    output_word_timestamps: bool,
):
    from funasr.utils.postprocess_utils import rich_transcription_postprocess

    final_language = language if language and language != "auto" else "auto"
    options = {
        "input": temp_path,
        "cache": {},
        "language": final_language,
        "use_itn": sensevoice_use_itn,
        "batch_size_s": 60,
        "output_timestamp": output_word_timestamps,
    }
    if sensevoice_vad_merge:
        options["merge_vad"] = True
        if isinstance(sensevoice_vad_merge_length_s, (int, float)) and sensevoice_vad_merge_length_s > 0:
            options["merge_length_s"] = float(sensevoice_vad_merge_length_s)
    result = model.generate(
        **options,
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
    sensevoice_vad_merge: bool,
    sensevoice_vad_merge_length_s: float,
    output_word_timestamps: bool,
) -> dict:
    if engine == "sensevoice":
        return transcribe_with_sensevoice(
            model,
            temp_path,
            language,
            sensevoice_use_itn,
            sensevoice_vad_merge,
            sensevoice_vad_merge_length_s,
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
    sensevoice_vad_merge: bool,
    sensevoice_vad_merge_length_s: float,
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
            sensevoice_vad_merge=sensevoice_vad_merge,
            sensevoice_vad_merge_length_s=sensevoice_vad_merge_length_s,
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
    sensevoice_vad_merge: bool,
    sensevoice_vad_merge_length_s: float,
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
            sensevoice_vad_merge=sensevoice_vad_merge,
            sensevoice_vad_merge_length_s=sensevoice_vad_merge_length_s,
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
    default_sensevoice_vad_model = (
        _model_info["sensevoice_vad_model"] or _runtime_policy["sensevoice_vad_model"]
    )
    default_sensevoice_vad_max_single_segment_time_ms = (
        _model_info["sensevoice_vad_max_single_segment_time_ms"]
        or _runtime_policy["sensevoice_vad_max_single_segment_time_ms"]
    )
    default_device = _model_info["device"] or _runtime_policy["device"] or "cpu"
    default_compute_type = _model_info["compute_type"] or _runtime_policy["compute_type"] or "int8"
    default_language = _runtime_policy["default_language"]
    default_sensevoice_use_itn = _runtime_policy["sensevoice_use_itn"]
    default_sensevoice_vad_merge = _runtime_policy["sensevoice_vad_merge"]
    default_sensevoice_vad_merge_length_s = _runtime_policy["sensevoice_vad_merge_length_s"]
    default_download_root = _model_info["download_root"] or _runtime_policy["download_root"]

    requested_engine = params.get("engine", [default_engine])[0]
    requested_model_type = params.get("model", [default_model_type])[0]
    requested_sensevoice_model_id = params.get("sensevoice_model_id", [default_sensevoice_model_id])[0]
    requested_sensevoice_use_itn = parse_bool(
        params.get("sensevoice_use_itn", [default_sensevoice_use_itn])[0],
        default_sensevoice_use_itn,
    )
    requested_sensevoice_vad_model = (
        params.get("sensevoice_vad_model", [default_sensevoice_vad_model])[0] or None
    )
    requested_sensevoice_vad_merge = parse_bool(
        params.get("sensevoice_vad_merge", [default_sensevoice_vad_merge])[0],
        default_sensevoice_vad_merge,
    )
    requested_sensevoice_vad_merge_length_s = float(
        params.get("sensevoice_vad_merge_length_s", [default_sensevoice_vad_merge_length_s])[0]
        or default_sensevoice_vad_merge_length_s
    )
    requested_sensevoice_vad_max_single_segment_time_ms = parse_positive_int(
        params.get(
            "sensevoice_vad_max_single_segment_time_ms",
            [default_sensevoice_vad_max_single_segment_time_ms],
        )[0],
        default_sensevoice_vad_max_single_segment_time_ms,
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
        sensevoice_vad_model = default_sensevoice_vad_model
        sensevoice_vad_merge = default_sensevoice_vad_merge
        sensevoice_vad_merge_length_s = default_sensevoice_vad_merge_length_s
        sensevoice_vad_max_single_segment_time_ms = default_sensevoice_vad_max_single_segment_time_ms
    else:
        engine = requested_engine
        model_type = requested_model_type if engine == "faster-whisper" else None
        sensevoice_model_id = requested_sensevoice_model_id
        sensevoice_use_itn = requested_sensevoice_use_itn
        sensevoice_vad_model = requested_sensevoice_vad_model
        sensevoice_vad_merge = requested_sensevoice_vad_merge
        sensevoice_vad_merge_length_s = requested_sensevoice_vad_merge_length_s
        sensevoice_vad_max_single_segment_time_ms = requested_sensevoice_vad_max_single_segment_time_ms

    if _runtime_policy["lock_language"]:
        language = default_language
    else:
        language = requested_language

    if not sensevoice_vad_model:
        sensevoice_vad_merge = False

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
            sensevoice_vad_model=sensevoice_vad_model,
            sensevoice_vad_max_single_segment_time_ms=sensevoice_vad_max_single_segment_time_ms,
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
                sensevoice_vad_merge=sensevoice_vad_merge,
                sensevoice_vad_merge_length_s=sensevoice_vad_merge_length_s,
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
                sensevoice_vad_merge=sensevoice_vad_merge,
                sensevoice_vad_merge_length_s=sensevoice_vad_merge_length_s,
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
            "sensevoice_vad_model": sensevoice_vad_model,
            "sensevoice_vad_merge": sensevoice_vad_merge,
            "sensevoice_vad_merge_length_s": sensevoice_vad_merge_length_s,
            "sensevoice_vad_max_single_segment_time_ms": sensevoice_vad_max_single_segment_time_ms,
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
