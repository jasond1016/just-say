#!/usr/bin/env python3
"""
JustSay - Faster-Whisper HTTP Server

模型常驻内存，通过 HTTP API 提供语音识别服务。
启动后模型只加载一次，后续请求延迟降至 200-500ms。
"""

import os
import sys
import json
import tempfile
import time
import argparse
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
            self.send_json({'status': 'ok', 'model_loaded': _model is not None})
        
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
        model_type = params.get('model', ['tiny'])[0]
        device = params.get('device', ['cpu'])[0]
        compute_type = params.get('compute_type', ['int8'])[0]
        language = params.get('language', [None])[0]
        download_root = params.get('download_root', [None])[0]
        
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
                'processing_time': time.time() - start_time
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
    parser = argparse.ArgumentParser(description='Whisper HTTP Server')
    parser.add_argument('--host', default='127.0.0.1', help='Host to bind to')
    parser.add_argument('--port', type=int, default=8765, help='Port to listen on')
    parser.add_argument('--preload-model', help='Pre-load a model on startup')
    parser.add_argument('--device', default='cpu', choices=['cpu', 'cuda'])
    parser.add_argument('--compute-type', default='int8')
    parser.add_argument('--download-root', help='Model cache directory')
    
    args = parser.parse_args()
    
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
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Server] Shutting down...", flush=True)
        server.shutdown()


if __name__ == '__main__':
    main()
