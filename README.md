# JustSay - 语音转录工具

按住快捷键说话，松开即可将语音转为文字并输入到当前窗口。

## 功能特性

- 🎤 **按住说话** - 按住右 Alt 键录音，松开自动识别
- 🤖 **本地识别** - 使用 Faster-Whisper 本地模型，无需联网
- 🌐 **多后端** - 支持本地模型、局域网服务、云端 API
- 💻 **跨平台** - 支持 Windows、macOS、Linux

## 快速开始

### 1. 安装 Node.js 依赖

```bash
pnpm install
```

### 2. 安装 Python 依赖（本地识别）

```bash
cd python
uv sync
```

### 3. 运行

```bash
pnpm dev
```

## 使用说明

1. 启动后程序在系统托盘运行
2. 按住 **Right Alt** 键开始录音
3. 对麦克风说话
4. 松开按键，等待识别
5. 识别结果自动输入到当前焦点窗口

## 配置

双击系统托盘图标打开设置界面。

## 打包

```bash
pnpm build:win   # Windows
pnpm build:mac   # macOS
pnpm build:linux # Linux
```

## LAN Whisper Server / 内网服务器模式

1. On Linux server:
   `python whisper_server.py --host 0.0.0.0 --port 8765`
2. Open firewall for port 8765.
3. In Settings -> Recognition backend = Local -> 运行模式 = 内网服务器, fill host/port.

## License

MIT
