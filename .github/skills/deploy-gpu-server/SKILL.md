---
name: deploy-gpu-server
description: >
  Deploy and manage the whisper/ASR server — locally or on a remote GPU machine.
  Use when asked to deploy, restart, check status, or run benchmarks on the whisper server.
---

# Deploy & Manage Whisper Server

This skill handles deploying Python changes to the whisper/ASR server and managing it. Supports both **local** and **remote** modes depending on the environment.

**Important**: All commands below use PowerShell syntax. On Windows, the Copilot CLI shell tool executes PowerShell, so always use `$env:VAR_NAME` to read environment variables. Do NOT use bash-style `${VAR}` — it causes MSYS path expansion issues on Windows.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `JUSTSAY_GPU_HOST` | No | SSH alias or IP of the remote GPU server. If **not set**, assume the server runs locally. |
| `JUSTSAY_GPU_REMOTE_DIR` | No | Remote code directory. Default: `python` |
| `JUSTSAY_GPU_TMUX_SESSION` | No | tmux session name. Default: `justsay` |

## Determine Mode

```powershell
$gpuHost = $env:JUSTSAY_GPU_HOST
$remoteDir = if ($env:JUSTSAY_GPU_REMOTE_DIR) { $env:JUSTSAY_GPU_REMOTE_DIR } else { "python" }
$tmux = if ($env:JUSTSAY_GPU_TMUX_SESSION) { $env:JUSTSAY_GPU_TMUX_SESSION } else { "justsay" }
```

- **`$gpuHost` is set** → Remote mode: deploy via SCP, manage via SSH + tmux
- **`$gpuHost` is empty** → Local mode: files are already in place, manage server directly

## Remote Mode

### Deploy Python Files

The remote server may use a **flat directory structure** — Python files live directly under the project root, not in a `python/` subdirectory. Check `JUSTSAY_GPU_REMOTE_DIR` for the actual layout.

```powershell
scp python/ws_streaming.py "${gpuHost}:${remoteDir}/ws_streaming.py"
scp python/transcript_assembler.py "${gpuHost}:${remoteDir}/transcript_assembler.py"
scp python/text_processing.py "${gpuHost}:${remoteDir}/text_processing.py"
```

### Restart Server (Remote)

```powershell
ssh $gpuHost "tmux send-keys -t $tmux C-c"
Start-Sleep 2
ssh $gpuHost "tmux send-keys -t $tmux 'uv run whisper_server.py --host 0.0.0.0 --port 8765 --engine sensevoice --sensevoice-model-id FunAudioLLM/SenseVoiceSmall --device cuda --compute-type float16' Enter"
```

### Verify (Remote)

```powershell
Start-Sleep 8
ssh $gpuHost "tmux capture-pane -t $tmux -p | tail -3"
# Expected: [Server] WebSocket streaming server running on ws://0.0.0.0:8766/stream
```

### Check Logs (Remote)

```powershell
ssh $gpuHost "tmux capture-pane -t $tmux -p"
```

## Local Mode

When `JUSTSAY_GPU_HOST` is not set, the server runs on the same machine. No SCP needed — Python files under `python/` are used directly.

### Start Server (Local)

```powershell
cd python
uv run whisper_server.py --host 0.0.0.0 --port 8765 --engine sensevoice --sensevoice-model-id FunAudioLLM/SenseVoiceSmall --device cuda --compute-type float16
```

### Verify (Local)

```powershell
curl -s http://localhost:8765/health
```

## Run Benchmark

Determine the server URL based on mode:

- **Remote**: `ws://$gpuHost:8766/stream`, `http://$gpuHost:8765`
- **Local**: `ws://localhost:8766/stream`, `http://localhost:8765`

```powershell
$serverUrl = if ($gpuHost) { $gpuHost } else { "localhost" }
node tools/meeting-bench.mjs `
  --audio fixtures/nhk_news_20260408.wav `
  --ref fixtures/nhk_news_20260408.ref.json `
  --ws-url "ws://${serverUrl}:8766/stream?sample_rate=16000&language=ja" `
  --http-url "http://${serverUrl}:8765" `
  --runs 3 --speed 2
```

## Typical Deploy + Benchmark Workflow

1. Make changes to Python files locally under `python/`
2. Run local tests: `pnpm test -- --run`
3. **Remote only**: Deploy changed files via `scp`
4. Restart server (tmux for remote, direct for local)
5. Verify server is running
6. Run benchmark and compare with previous results
