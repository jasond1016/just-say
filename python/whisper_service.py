#!/usr/bin/env python3
"""
JustSay - Local ASR Service (Faster-Whisper + SenseVoice)

Usage:
    python whisper_service.py --audio <path> --engine <name> [options]
"""

import argparse
import json
import os
import sys
import threading
import time

DEFAULT_SENSEVOICE_MODEL_ID = "FunAudioLLM/SenseVoiceSmall"
FASTER_WHISPER_MODELS = {"tiny", "base", "small", "medium", "large-v3"}


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


def parse_bool(value, default=False):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def output_progress(percent: float, status: str = "downloading"):
    """Output progress update as JSON to stderr (stdout reserved for final result)."""
    print(
        json.dumps({"type": "progress", "percent": round(percent, 1), "status": status}, ensure_ascii=False),
        file=sys.stderr,
        flush=True,
    )


def create_progress_hook(download_root: str):
    """Create a progress monitoring thread for huggingface downloads."""
    stop_event = threading.Event()

    def monitor_download():
        if not download_root:
            return

        blobs_dir = os.path.join(download_root, "blobs")
        incomplete_suffix = ".incomplete"
        last_size = 0

        while not stop_event.is_set():
            try:
                if os.path.exists(blobs_dir):
                    total_size = 0
                    incomplete_count = 0
                    for filename in os.listdir(blobs_dir):
                        file_path = os.path.join(blobs_dir, filename)
                        if os.path.isfile(file_path):
                            size = os.path.getsize(file_path)
                            total_size += size
                            if filename.endswith(incomplete_suffix):
                                incomplete_count += 1

                    if total_size != last_size:
                        mb = total_size / (1024 * 1024)
                        output_progress(mb, f"downloading ({mb:.1f} MB)")
                        last_size = total_size

                    if incomplete_count == 0 and total_size > 0:
                        break
            except Exception:
                pass

            stop_event.wait(0.5)

    thread = threading.Thread(target=monitor_download, daemon=True)
    return thread, stop_event


def detect_gpu():
    """Detect CUDA availability and return GPU info."""
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


def output_error(msg):
    print(json.dumps({"success": False, "error": msg, "text": ""}, ensure_ascii=False))


def ensure_download_env(download_root: str | None):
    if not download_root:
        return
    os.makedirs(download_root, exist_ok=True)
    os.environ["HF_HOME"] = download_root
    os.environ["MODELSCOPE_CACHE"] = download_root


def load_faster_whisper_model(args):
    from faster_whisper import WhisperModel

    model_id = args.model_path if args.model_path and os.path.exists(args.model_path) else args.model
    return WhisperModel(
        model_id,
        device=args.device,
        compute_type=args.compute_type,
        download_root=args.download_root,
    )


def load_sensevoice_model(args):
    from funasr import AutoModel

    resolved_device = resolve_sensevoice_device(args.device)
    return AutoModel(
        model=args.sensevoice_model_id,
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
            "[Service] CUDA requested for SenseVoice but torch CUDA is unavailable, falling back to CPU",
            file=sys.stderr,
            flush=True,
        )
        return "cpu"
    except Exception as exc:
        print(
            f"[Service] Failed to validate torch CUDA for SenseVoice ({exc}), falling back to CPU",
            file=sys.stderr,
            flush=True,
        )
        return "cpu"


def transcribe_with_faster_whisper(model, args):
    options = {"beam_size": 5, "vad_filter": True, "vad_parameters": {"min_silence_duration_ms": 500}}
    if args.language and args.language != "auto":
        options["language"] = args.language

    segments, info = model.transcribe(args.audio, **options)
    text = " ".join(seg.text.strip() for seg in segments).strip()

    return {
        "success": True,
        "text": text,
        "language": info.language,
        "language_probability": info.language_probability,
        "duration": info.duration,
    }


def transcribe_with_sensevoice(model, args):
    from funasr.utils.postprocess_utils import rich_transcription_postprocess

    language = args.language if args.language and args.language != "auto" else "auto"
    result = model.generate(
        input=args.audio,
        cache={},
        language=language,
        use_itn=parse_bool(args.sensevoice_use_itn, True),
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

    return {"success": True, "text": text, "language": detected_language or language}


def validate_model_args(args):
    has_local_model_path = args.model_path and os.path.exists(args.model_path)
    if args.engine == "faster-whisper" and not has_local_model_path and args.model not in FASTER_WHISPER_MODELS:
        raise ValueError(
            f"Unsupported faster-whisper model: {args.model}. "
            f"Allowed: {', '.join(sorted(FASTER_WHISPER_MODELS))}"
        )


def main():
    parser = argparse.ArgumentParser(description="Local ASR Recognition")
    parser.add_argument("--audio", help="Audio file path")
    parser.add_argument("--engine", default="faster-whisper", choices=["faster-whisper", "sensevoice"])
    parser.add_argument("--model", default="tiny", help="Faster-Whisper model type")
    parser.add_argument("--model-path", help="Local model directory")
    parser.add_argument("--sensevoice-model-id", default=DEFAULT_SENSEVOICE_MODEL_ID)
    parser.add_argument("--sensevoice-use-itn", default="true")
    parser.add_argument("--device", default="cpu", choices=["cpu", "cuda"])
    parser.add_argument("--compute-type", default="default")
    parser.add_argument("--language", help="Language code")
    parser.add_argument("--download-only", action="store_true", help="Download model and exit")
    parser.add_argument("--download-root", help="Cache directory for models")
    parser.add_argument("--detect-gpu", action="store_true", help="Detect GPU and exit")

    args = parser.parse_args()
    ensure_download_env(args.download_root)

    if args.detect_gpu:
        print(json.dumps(detect_gpu(), ensure_ascii=False))
        return 0

    if not args.download_only:
        if not args.audio:
            output_error("Audio file path required unless --download-only")
            return 1
        if not os.path.exists(args.audio):
            output_error(f"Audio not found: {args.audio}")
            return 1

    try:
        validate_model_args(args)
        start_time = time.time()

        progress_thread = None
        stop_event = None
        if args.download_only:
            output_progress(0, "starting download")
            if args.engine == "faster-whisper" and args.download_root:
                model_cache = os.path.join(args.download_root, f"models--Systran--faster-whisper-{args.model}")
                progress_thread, stop_event = create_progress_hook(model_cache)
                progress_thread.start()
            elif args.engine == "sensevoice":
                output_progress(5, "preparing SenseVoiceSmall model")

        if args.engine == "faster-whisper":
            model = load_faster_whisper_model(args)
        else:
            model = load_sensevoice_model(args)

        if stop_event:
            stop_event.set()
        if progress_thread:
            progress_thread.join(timeout=1)

        if args.download_only:
            output_progress(100, "complete")
            print(json.dumps({"success": True, "text": "Model downloaded", "duration": 0}, ensure_ascii=False))
            return 0

        if args.engine == "faster-whisper":
            payload = transcribe_with_faster_whisper(model, args)
        else:
            payload = transcribe_with_sensevoice(model, args)

        payload["processing_time"] = time.time() - start_time
        print(json.dumps(payload, ensure_ascii=False))
        return 0

    except ImportError as exc:
        if args.engine == "sensevoice":
            output_error(f"SenseVoice dependencies not installed: {exc}")
        else:
            output_error("faster-whisper not installed. Run: uv sync")
        return 1
    except Exception as exc:
        output_error(str(exc))
        return 1


if __name__ == "__main__":
    sys.exit(main())
