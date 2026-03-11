# JustSay

JustSay 是一个桌面语音转录工具，提供：

1. `PTT (Push-to-talk)`：按住快捷键说话，松开后自动识别并输出文本。
2. `Meeting Transcription`：持续转录会议音频并保存历史记录。

## Features

1. 多识别后端：Local / Groq / Soniox / Network / API
2. 历史记录：搜索、分页、来源筛选（All/PTT/Meeting）
3. 主页统计：今日 PTT 次数、字符数、近 7 天趋势
4. 跨平台：Windows / macOS / Linux（持续完善）

## Quick Start

1. 安装 Node 依赖：

```bash
pnpm install
```

2. 安装 Python 依赖（本地识别/LAN 模式）：

```bash
cd python
uv sync --frozen --python 3.12
```

3. 启动开发环境：

```bash
pnpm dev
```

## Windows 本地 SenseVoice（GPU）

如果你想在 Windows 手动启动 Python 后台，并在应用里以远程模式连接本机服务，可直接使用 PowerShell 包装脚本：

```powershell
cd .\python
.\run_whisper_server.ps1
```

默认行为：

1. 使用 `SenseVoiceSmall`：`FunAudioLLM/SenseVoiceSmall`
2. 使用 `CUDA` + `float16`
3. HTTP 端口 `8765`，WS 端口 `8766`
4. 模型缓存目录：`python\.cache\models`
5. 固定模型与算力参数，避免客户端请求覆盖

常见自定义：

```powershell
.\run_whisper_server.ps1 -Port 9000 -WsPort 9001
.\run_whisper_server.ps1 -DownloadRoot D:\AI\models\justsay
.\run_whisper_server.ps1 -SenseVoiceModelId FunAudioLLM/SenseVoiceSmall
```

启动后可验证：

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
Invoke-RestMethod http://127.0.0.1:8765/gpu
Invoke-RestMethod http://127.0.0.1:8765/model/info
```

在 JustSay 里连接这个服务：

1. 识别引擎选 `SenseVoice（本地）`
2. `Local Server Mode` 选 `Remote`
3. `Host` 填 `127.0.0.1`
4. `Port` 填 `8765`

## Usage

1. 启动后程序在系统托盘运行。
2. 默认按住 `Right Ctrl` 开始 PTT 录音（可在设置中修改）。
3. 松开后自动识别并按配置输出到当前焦点窗口/剪贴板/弹窗。
4. Meeting 模式可持续转录并自动存入历史。

## Build

```bash
pnpm build:win
pnpm build:mac
pnpm build:linux
```

## Meeting Benchmark

可用固定音频反复测试会议流式转录质量与延迟：

```bash
pnpm meeting:bench -- --audio ./fixtures/case01.wav --ref ./fixtures/case01.ref.json --runs 5
```

详细说明见 `docs/meeting-benchmark.md`，参考模板见 `tools/meeting-bench.ref.example.json`。

## Security Notes

1. API Key 在运行时通过 `electron-store + safeStorage` 存储，不应提交到仓库。
2. 提交前建议运行：

```bash
gitleaks git
```

## License

MIT
