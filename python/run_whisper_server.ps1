param(
  [string]$ListenHost = '127.0.0.1',
  [int]$Port = 8765,
  [int]$WsPort = 8766,
  [string]$SenseVoiceModelId = 'FunAudioLLM/SenseVoiceSmall',
  [string]$DownloadRoot = '.\.cache\models',
  [string]$ComputeType = 'float16',
  [switch]$NoLockModel,
  [switch]$NoLockDeviceCompute
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$venvDir = if ($env:VENV_DIR) { $env:VENV_DIR } else { Join-Path $scriptDir '.venv' }
$pythonBin = if ($env:PYTHON_BIN) { $env:PYTHON_BIN } else { Join-Path $venvDir 'Scripts\python.exe' }
$serverScript = Join-Path $scriptDir 'whisper_server.py'
$resolvedDownloadRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDir $DownloadRoot))

if (-not (Test-Path $serverScript)) {
  throw "[Wrapper] whisper_server.py not found: $serverScript"
}

if (-not (Test-Path $pythonBin)) {
  throw "[Wrapper] python not found in venv: $pythonBin`n[Wrapper] Hint: run 'cd $scriptDir; uv sync --frozen --python 3.12' first, or set PYTHON_BIN"
}

$nvidiaDirs = & $pythonBin -c @"
import os
import site
import sys

dirs = []

def add(path: str) -> None:
    if path and os.path.isdir(path) and path not in dirs:
        dirs.append(path)

paths = []
if hasattr(site, "getsitepackages"):
    paths.extend(site.getsitepackages())
if hasattr(site, "getusersitepackages"):
    user_site = site.getusersitepackages()
    if user_site:
        paths.append(user_site)
for p in sys.path:
    if "site-packages" in p:
        paths.append(p)

for root in paths:
    nvidia_root = os.path.join(root, "nvidia")
    if not os.path.isdir(nvidia_root):
        continue
    for item in os.listdir(nvidia_root):
        add(os.path.join(nvidia_root, item, "bin"))

for path in dirs:
    print(path)
"@

if ($LASTEXITCODE -ne 0) {
  throw "[Wrapper] Failed to inspect NVIDIA runtime paths"
}

foreach ($dir in $nvidiaDirs) {
  if ([string]::IsNullOrWhiteSpace($dir) -or -not (Test-Path $dir)) {
    continue
  }
  $env:PATH = "$dir;$env:PATH"
}

$args = @(
  $serverScript
  '--host', $ListenHost
  '--port', $Port
  '--ws-port', $WsPort
  '--engine', 'sensevoice'
  '--sensevoice-model-id', $SenseVoiceModelId
  '--sensevoice-use-itn', 'true'
  '--device', 'cuda'
  '--compute-type', $ComputeType
  '--download-root', $resolvedDownloadRoot
)

if (-not $NoLockModel) {
  $args += '--lock-model'
}

if (-not $NoLockDeviceCompute) {
  $args += '--lock-device-compute'
}

Write-Host "[Wrapper] Python: $pythonBin"
Write-Host "[Wrapper] Download root: $resolvedDownloadRoot"
Write-Host "[Wrapper] PATH updated with NVIDIA runtime bins when available"
Write-Host "[Wrapper] Starting SenseVoice on CUDA at http://${ListenHost}:$Port (WS: $WsPort)"

& $pythonBin @args
exit $LASTEXITCODE
