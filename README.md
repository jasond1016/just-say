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

## Security Notes

1. API Key 在运行时通过 `electron-store + safeStorage` 存储，不应提交到仓库。
2. 提交前建议运行：
```bash
gitleaks git
```

## License

MIT
