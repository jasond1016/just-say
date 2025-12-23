#!/usr/bin/env python3
"""
JustSay - Faster-Whisper Speech Recognition Service

Usage:
    python whisper_service.py --audio <path> --model <type> [options]
"""

import argparse
import json
import sys
import os
import time

def add_nvidia_paths():
    """Add NVIDIA library paths to DLL search path for Windows."""
    if os.name == 'nt':
        for p in sys.path:
            nvidia_path = os.path.join(p, 'nvidia')
            if os.path.isdir(nvidia_path):
                for comp in ['cudnn', 'cublas']:
                    bin_path = os.path.join(nvidia_path, comp, 'bin')
                    if os.path.isdir(bin_path):
                        try:
                            os.add_dll_directory(bin_path)
                            os.environ['PATH'] = bin_path + os.pathsep + os.environ['PATH']
                        except Exception:
                            pass

add_nvidia_paths()


def main():
    parser = argparse.ArgumentParser(description='Faster-Whisper Recognition')
    parser.add_argument('--audio', help='Audio file path')
    parser.add_argument('--model', default='tiny',
                        choices=['tiny', 'base', 'small', 'medium', 'large-v3'])
    parser.add_argument('--model-path', help='Local model directory')
    parser.add_argument('--device', default='cpu', choices=['cpu', 'cuda'])
    parser.add_argument('--compute-type', default='default')
    parser.add_argument('--language', help='Language code')
    parser.add_argument('--download-only', action='store_true', help='Download model and exit')
    parser.add_argument('--download-root', help='Cache directory for models')

    args = parser.parse_args()

    # Audio is required unless download-only
    if not args.download_only:
        if not args.audio:
            output_error("Audio file path required unless --download-only")
            return 1
        if not os.path.exists(args.audio):
            output_error(f"Audio not found: {args.audio}")
            return 1
        output_error(f"Audio not found: {args.audio}")
        return 1

    try:
        from faster_whisper import WhisperModel

        start_time = time.time()

        # Model path or name
        model_id = args.model_path if args.model_path and os.path.exists(args.model_path) else args.model

        model = WhisperModel(
            model_id, 
            device=args.device, 
            compute_type=args.compute_type,
            download_root=args.download_root
        )

        if args.download_only:
            print(json.dumps({'success': True, 'text': 'Model downloaded', 'duration': 0}, ensure_ascii=False))
            return 0

        options = {
            'beam_size': 5,
            'vad_filter': True,
            'vad_parameters': {'min_silence_duration_ms': 500}
        }

        if args.language and args.language != 'auto':
            options['language'] = args.language

        segments, info = model.transcribe(args.audio, **options)

        text = ' '.join(seg.text.strip() for seg in segments).strip()

        print(json.dumps({
            'success': True,
            'text': text,
            'language': info.language,
            'language_probability': info.language_probability,
            'duration': info.duration,
            'processing_time': time.time() - start_time
        }, ensure_ascii=False))

        return 0

    except ImportError:
        output_error("faster-whisper not installed. Run: pip install faster-whisper")
        return 1
    except Exception as e:
        output_error(str(e))
        return 1


def output_error(msg):
    print(json.dumps({'success': False, 'error': msg, 'text': ''}, ensure_ascii=False))


if __name__ == '__main__':
    sys.exit(main())
