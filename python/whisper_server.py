#!/usr/bin/env python3
"""
JustSay - Faster-Whisper HTTP Server

模型常驻内存，通过 HTTP API 提供语音识别服务。
启动后模型只加载一次，后续请求延迟降至 200-500ms。
"""

import os
import sys
import json
import glob
import tempfile
import time
import argparse
import traceback
from pathlib import Path

# Add NVIDIA paths before importing anything else
def add_nvidia_paths():
    """Add NVIDIA library paths to DLL search path for Windows."""
    if os.name != 'nt':
        return
    
    import site
    
    possible_paths = site.getsitepackages() if hasattr(site, 'getsitepackages') else []
    for p in sys.path:
        if 'site-packages' in p and os.path.isdir(p) and p not in possible_paths:
            possible_paths.append(p)
    
    for site_packages in possible_paths:
        nvidia_path = os.path.join(site_packages, 'nvidia')
        if not os.path.isdir(nvidia_path):
            continue
        
        for item in os.listdir(nvidia_path):
            bin_path = os.path.join(nvidia_path, item, 'bin')
            if os.path.isdir(bin_path):
                try:
                    os.add_dll_directory(bin_path)
                except Exception:
                    pass
                os.environ['PATH'] = bin_path + os.pathsep + os.environ.get('PATH', '')
        return

add_nvidia_paths()

from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import threading

# Global model instance
_model = None
_model_lock = threading.Lock()
_model_info = {
    'model_type': None,
    'device': None,
    'compute_type': None,
    'download_root': None
}
_runtime_policy = {
    'lock_model': False,
    'lock_device_compute': False,
    'lock_language': False,
    'default_model_type': 'tiny',
    'default_language': None,
    'device': 'cpu',
    'compute_type': 'int8'
}


def get_model(model_type: str, device: str, compute_type: str, download_root: str):
    """Get or create the whisper model (singleton pattern)."""
    global _model, _model_info
    
    with _model_lock:
        # Check if we need to reload
        need_reload = (
            _model is None or
            _model_info['model_type'] != model_type or
            _model_info['device'] != device or
            _model_info['compute_type'] != compute_type
        )
        
        if need_reload:
            print(f"[Server] Loading model: {model_type} on {device} ({compute_type})", flush=True)
            from faster_whisper import WhisperModel
            
            _model = WhisperModel(
                model_type,
                device=device,
                compute_type=compute_type,
                download_root=download_root
            )
            _model_info.update({
                'model_type': model_type,
                'device': device,
                'compute_type': compute_type,
                'download_root': download_root
            })
            print(f"[Server] Model loaded successfully", flush=True)
        
        return _model


def detect_gpu():
    """Detect CUDA availability."""
    result = {
        'cuda_available': False,
        'device_name': None,
        'recommended_device': 'cpu',
        'recommended_compute_type': 'int8'
    }
    
    try:
        import ctranslate2
        cuda_device_count = ctranslate2.get_cuda_device_count()
        if cuda_device_count > 0:
            result['cuda_available'] = True
            result['device_name'] = f'CUDA device (count: {cuda_device_count})'
            result['recommended_device'] = 'cuda'
            result['recommended_compute_type'] = 'float16'
    except Exception:
        pass
    
    return result


def collect_candidate_library_dirs():
    """Collect candidate library directories for NVIDIA runtime libs."""
    dirs = []

    def add_dir(path):
        if path and os.path.isdir(path) and path not in dirs:
            dirs.append(path)

    ld_library_path = os.environ.get('LD_LIBRARY_PATH', '')
    if ld_library_path:
        for entry in ld_library_path.split(os.pathsep):
            add_dir(entry)

    possible_site_packages = []
    try:
        import site
        if hasattr(site, 'getsitepackages'):
            possible_site_packages.extend(site.getsitepackages())
        if hasattr(site, 'getusersitepackages'):
            user_site = site.getusersitepackages()
            if user_site:
                possible_site_packages.append(user_site)
    except Exception:
        pass

    for p in sys.path:
        if 'site-packages' in p:
            possible_site_packages.append(p)

    unique_site_packages = []
    for p in possible_site_packages:
        if p and p not in unique_site_packages:
            unique_site_packages.append(p)

    for site_packages in unique_site_packages:
        nvidia_root = os.path.join(site_packages, 'nvidia')
        if not os.path.isdir(nvidia_root):
            continue
        for pkg in ('cublas', 'cudnn'):
            for subdir in ('lib', 'lib64', 'bin'):
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
    ld_library_path = os.environ.get('LD_LIBRARY_PATH', '')
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
            print(
                f"[Server] LibDir: ... ({len(candidate_dirs) - max_preview} more)",
                flush=True
            )

    cublas_path = find_first_library(
        candidate_dirs,
        ['libcublas.so*', 'libcublasLt.so*', 'cublas64_*.dll']
    )
    cudnn_path = find_first_library(
        candidate_dirs,
        ['libcudnn.so*', 'cudnn64_*.dll']
    )

    print(f"[Server] Resolved cuBLAS: {cublas_path or 'NOT FOUND'}", flush=True)
    print(f"[Server] Resolved cuDNN: {cudnn_path or 'NOT FOUND'}", flush=True)


class WhisperHandler(BaseHTTPRequestHandler):
    """HTTP request handler for whisper service."""
    
    def log_message(self, format, *args):
        """Override to use custom logging."""
        print(f"[HTTP] {args[0]}", flush=True)
    
    def send_json(self, data: dict, status: int = 200):
        """Send JSON response."""
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', len(body))
        self.end_headers()
        self.wfile.write(body)
    
    def do_GET(self):
        """Handle GET requests."""
        parsed = urlparse(self.path)

        if parsed.path == '/health':
            self.send_json({
                'status': 'ok',
                'model_loaded': _model is not None,
                'runtime_policy': {
                    'lock_model': _runtime_policy['lock_model'],
                    'lock_device_compute': _runtime_policy['lock_device_compute'],
                    'lock_language': _runtime_policy['lock_language'],
                    'default_model_type': _runtime_policy['default_model_type'],
                    'default_language': _runtime_policy['default_language'],
                    'device': _runtime_policy['device'],
                    'compute_type': _runtime_policy['compute_type']
                }
            })
        
        elif parsed.path == '/gpu':
            self.send_json(detect_gpu())
        
        elif parsed.path == '/model/info':
            self.send_json({
                'loaded': _model is not None,
                **_model_info
            })
        
        else:
            self.send_json({'error': 'Not found'}, 404)
    
    def do_POST(self):
        """Handle POST requests."""
        parsed = urlparse(self.path)
        
        if parsed.path == '/transcribe':
            self.handle_transcribe()
        
        elif parsed.path == '/model/load':
            self.handle_load_model()
        
        elif parsed.path == '/model/unload':
            self.handle_unload_model()
        
        else:
            self.send_json({'error': 'Not found'}, 404)
    
    def handle_transcribe(self):
        """Handle transcription request."""
        try:
            # Read request body
            content_length = int(self.headers.get('Content-Length', 0))
            
            # Check content type
            content_type = self.headers.get('Content-Type', '')
            
            if 'multipart/form-data' in content_type:
                # Handle multipart form data
                result = self.handle_multipart_transcribe(content_length)
            elif 'application/json' in content_type:
                # Handle JSON with base64 audio
                body = self.rfile.read(content_length)
                data = json.loads(body.decode('utf-8'))
                result = self.transcribe_from_json(data)
            elif 'audio/' in content_type or 'application/octet-stream' in content_type:
                # Handle raw audio bytes
                audio_data = self.rfile.read(content_length)
                # Parse query params for options
                parsed = urlparse(self.path)
                params = parse_qs(parsed.query)
                result = self.transcribe_audio(audio_data, params)
            else:
                self.send_json({'error': f'Unsupported content type: {content_type}'}, 400)
                return
            
            self.send_json(result)
            
        except Exception as e:
            self.send_json({'success': False, 'error': str(e), 'text': ''}, 500)
    
    def transcribe_audio(self, audio_data: bytes, params: dict) -> dict:
        """Transcribe audio bytes."""
        start_time = time.time()

        # Get parameters
        default_model_type = _model_info['model_type'] or _runtime_policy['default_model_type'] or 'tiny'
        default_device = _model_info['device'] or _runtime_policy['device'] or 'cpu'
        default_compute_type = _model_info['compute_type'] or _runtime_policy['compute_type'] or 'int8'

        requested_model_type = params.get('model', [default_model_type])[0]
        if _runtime_policy['lock_model']:
            model_type = default_model_type
        else:
            model_type = requested_model_type

        requested_device = params.get('device', [default_device])[0]
        requested_compute_type = params.get('compute_type', [default_compute_type])[0]
        default_language = _runtime_policy['default_language']
        requested_language = params.get('language', [default_language])[0]
        if _runtime_policy['lock_language']:
            language = default_language
        else:
            language = requested_language
        download_root = params.get('download_root', [None])[0]

        if _runtime_policy['lock_device_compute']:
            device = _runtime_policy['device']
            compute_type = _runtime_policy['compute_type']
        else:
            device = requested_device
            compute_type = requested_compute_type
        
        # Write to temp file
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
            f.write(audio_data)
            temp_path = f.name
        
        try:
            # Get model
            model = get_model(model_type, device, compute_type, download_root)
            
            # Transcribe options
            options = {
                'beam_size': 5,
                'vad_filter': True,
                'vad_parameters': {'min_silence_duration_ms': 500}
            }
            
            if language and language != 'auto':
                options['language'] = language
            
            segments, info = model.transcribe(temp_path, **options)
            text = ' '.join(seg.text.strip() for seg in segments).strip()
            
            return {
                'success': True,
                'text': text,
                'language': info.language,
                'language_probability': info.language_probability,
                'duration': info.duration,
                'processing_time': time.time() - start_time,
                'device': device,
                'compute_type': compute_type
            }
        except Exception as e:
            print(
                f"[Server] Transcribe failed: model={model_type}, device={device}, "
                f"compute_type={compute_type}, error={e}",
                flush=True
            )
            traceback.print_exc()
            return {
                'success': False,
                'text': '',
                'error': str(e),
                'processing_time': time.time() - start_time,
                'model': model_type,
                'device': device,
                'compute_type': compute_type,
                'language': language
            }
        finally:
            # Cleanup
            try:
                os.unlink(temp_path)
            except:
                pass
    
    def transcribe_from_json(self, data: dict) -> dict:
        """Transcribe from JSON request with base64 audio."""
        import base64
        
        audio_b64 = data.get('audio')
        if not audio_b64:
            return {'success': False, 'error': 'Missing audio field', 'text': ''}
        
        audio_data = base64.b64decode(audio_b64)
        
        params = {
            'model': [data.get('model', 'tiny')],
            'device': [data.get('device', 'cpu')],
            'compute_type': [data.get('compute_type', 'int8')],
            'language': [data.get('language')],
            'download_root': [data.get('download_root')]
        }
        
        return self.transcribe_audio(audio_data, params)
    
    def handle_multipart_transcribe(self, content_length: int) -> dict:
        """Handle multipart form data upload."""
        # Simple multipart parser - just extract the audio file
        import re
        
        body = self.rfile.read(content_length)
        content_type = self.headers.get('Content-Type', '')
        boundary = content_type.split('boundary=')[-1].encode()
        
        parts = body.split(b'--' + boundary)
        audio_data = None
        params = {}
        
        for part in parts:
            if b'Content-Disposition' not in part:
                continue
            
            # Find the blank line separating headers from content
            header_end = part.find(b'\r\n\r\n')
            if header_end == -1:
                continue
            
            headers = part[:header_end].decode('utf-8', errors='ignore')
            content = part[header_end + 4:].rstrip(b'\r\n--')
            
            # Extract field name
            name_match = re.search(r'name="([^"]+)"', headers)
            if not name_match:
                continue
            
            name = name_match.group(1)
            
            if name == 'audio' or 'filename=' in headers:
                audio_data = content
            else:
                params[name] = [content.decode('utf-8')]
        
        if not audio_data:
            return {'success': False, 'error': 'No audio file in request', 'text': ''}
        
        return self.transcribe_audio(audio_data, params)
    
    def handle_load_model(self):
        """Pre-load a model."""
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)
            data = json.loads(body.decode('utf-8')) if body else {}
            
            model_type = data.get('model', 'tiny')
            device = data.get('device', 'cpu')
            compute_type = data.get('compute_type', 'int8')
            download_root = data.get('download_root')
            
            get_model(model_type, device, compute_type, download_root)
            
            self.send_json({'success': True, 'model': model_type})
            
        except Exception as e:
            self.send_json({'success': False, 'error': str(e)}, 500)
    
    def handle_unload_model(self):
        """Unload current model to free memory."""
        global _model, _model_info
        
        with _model_lock:
            _model = None
            _model_info = {
                'model_type': None,
                'device': None,
                'compute_type': None,
                'download_root': None
            }
        
        self.send_json({'success': True})


class ThreadedHTTPServer(HTTPServer):
    """HTTP server that handles each request in a new thread."""
    
    def process_request(self, request, client_address):
        """Start a new thread to process the request."""
        thread = threading.Thread(target=self.process_request_thread, args=(request, client_address))
        thread.daemon = True
        thread.start()
    
    def process_request_thread(self, request, client_address):
        """Process request in thread."""
        try:
            self.finish_request(request, client_address)
        except Exception:
            self.handle_error(request, client_address)
        finally:
            self.shutdown_request(request)


def main():
    global _runtime_policy

    parser = argparse.ArgumentParser(description='Whisper HTTP Server')
    parser.add_argument('--host', default='127.0.0.1', help='Host to bind to')
    parser.add_argument('--port', type=int, default=8765, help='Port to listen on')
    parser.add_argument('--preload-model', help='Pre-load a model on startup')
    parser.add_argument(
        '--default-model',
        default='tiny',
        choices=['tiny', 'base', 'small', 'medium', 'large-v3'],
        help='Default model used when request does not provide model'
    )
    parser.add_argument(
        '--default-language',
        help='Default language (e.g. zh, en). If unset, auto language detection is used'
    )
    parser.add_argument(
        '--lock-model',
        action='store_true',
        help='Ignore request model and always use server default/current model'
    )
    parser.add_argument(
        '--lock-language',
        action='store_true',
        help='Ignore request language and always use server default language'
    )
    parser.add_argument('--device', default='cpu', choices=['cpu', 'cuda'])
    parser.add_argument('--compute-type', default='int8')
    parser.add_argument(
        '--lock-device-compute',
        action='store_true',
        help='Ignore request device/compute_type and always use startup values'
    )
    parser.add_argument('--download-root', help='Model cache directory')

    args = parser.parse_args()

    _runtime_policy['lock_model'] = args.lock_model
    _runtime_policy['lock_device_compute'] = args.lock_device_compute
    _runtime_policy['lock_language'] = args.lock_language
    _runtime_policy['default_model_type'] = args.preload_model or args.default_model
    _runtime_policy['default_language'] = args.default_language
    _runtime_policy['device'] = args.device
    _runtime_policy['compute_type'] = args.compute_type

    print(f"[Server] Python executable: {sys.executable}", flush=True)
    print(f"[Server] Python version: {sys.version.split()[0]}", flush=True)
    log_runtime_library_diagnostics()

    # Pre-load model if specified
    if args.preload_model:
        print(f"[Server] Pre-loading model: {args.preload_model}", flush=True)
        try:
            get_model(args.preload_model, args.device, args.compute_type, args.download_root)
        except Exception as e:
            print(f"[Server] Failed to pre-load model: {e}", flush=True)
    
    # Start server
    server = ThreadedHTTPServer((args.host, args.port), WhisperHandler)
    print(f"[Server] Whisper HTTP server running on http://{args.host}:{args.port}", flush=True)
    print(f"[Server] Endpoints:", flush=True)
    print(f"  GET  /health       - Health check", flush=True)
    print(f"  GET  /gpu          - Detect GPU", flush=True)
    print(f"  GET  /model/info   - Current model info", flush=True)
    print(f"  POST /transcribe   - Transcribe audio", flush=True)
    print(f"  POST /model/load   - Pre-load model", flush=True)
    print(f"  POST /model/unload - Unload model", flush=True)
    if args.lock_model or args.lock_device_compute or args.lock_language:
        print(
            f"[Server] Runtime locked: lock_model={args.lock_model}, "
            f"lock_language={args.lock_language}, "
            f"default_language={args.default_language}, "
            f"device={args.device}, compute_type={args.compute_type}",
            flush=True
        )

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Server] Shutting down...", flush=True)
        server.shutdown()


if __name__ == '__main__':
    main()
