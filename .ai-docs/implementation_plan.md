# JustSay 实现计划

## 目标
实现一个跨平台语音转录工具，按住快捷键录音，松开后识别并插入文字到当前输入框。

---

## Phase 1: MVP 实现（首次交付）

### 1.1 项目初始化

#### [NEW] 项目根目录结构
使用 Vite + Electron + React + TypeScript 创建项目：

```
d:\my_projects\JustSay\
├── package.json
├── vite.config.ts
├── electron-builder.yml
├── tsconfig.json
├── src/
│   ├── main/           # Electron 主进程
│   ├── renderer/       # React 渲染进程
│   └── preload/        # 预加载脚本
├── python/             # Faster-Whisper 模块（Phase 2）
├── models/             # 模型目录
└── assets/
```

**核心依赖**:
- `electron` - 桌面框架
- `vite` + `@vitejs/plugin-react` - 构建工具
- `electron-builder` - 打包
- `electron-store` - 配置存储
- `uiohook-napi` - 全局按键监听（支持按住检测）
- `node-global-key-listener` - 备选方案
- `robotjs` 或 `@phanmn/node-uiautomation` - 文本输入模拟

---

### 1.2 核心模块

#### [NEW] src/main/index.ts
主进程入口，负责：
- 应用生命周期管理
- 窗口创建
- IPC 通信注册

#### [NEW] src/main/hotkey.ts
全局快捷键监听模块：
- 使用 `uiohook-napi` 监听右 Alt 键的按下/释放
- 按下时触发录音开始
- 释放时触发录音停止

#### [NEW] src/main/audio/recorder.ts
音频录制模块：
- 使用 `node-audiorecorder` 或系统音频 API
- 录制为 WAV 格式（16kHz, 16bit, mono）
- 支持开始/停止录制

#### [NEW] src/main/tray.ts
系统托盘：
- 显示应用图标
- 右键菜单（设置、退出）
- 状态指示（待机/录音中/处理中）

#### [NEW] src/main/recognition/index.ts
识别控制器：
- 统一识别接口
- 根据配置选择后端
- 处理识别结果

#### [NEW] src/main/recognition/api.ts
OpenAI Whisper API 客户端：
- 调用 `/v1/audio/transcriptions` 接口
- 支持自定义 endpoint（兼容其他 OpenAI 兼容 API）

#### [NEW] src/main/input/simulator.ts
文本输入模拟：
- Windows: 使用 `robotjs` 或 `SendInput` API
- 将识别结果输入到当前焦点窗口

---

### 1.3 渲染进程 UI

#### [NEW] src/renderer/App.tsx
React 应用入口

#### [NEW] src/renderer/components/Indicator.tsx
录音状态悬浮窗：
- 显示录音时长/音量波形
- 悬浮在屏幕固定位置
- 录音时显示，否则隐藏

#### [NEW] src/renderer/pages/Settings.tsx
设置页面：
- 快捷键配置
- 识别后端选择
- API 配置

---

## 验证计划

### 自动化测试
由于这是新项目，暂无现有测试。MVP 阶段以手动验证为主。

### 手动验证步骤

#### 测试 1: 项目启动
1. 在 `d:\my_projects\JustSay` 目录运行 `npm run dev`
2. **预期**: Electron 窗口启动，系统托盘出现图标

#### 测试 2: 快捷键录音
1. 启动应用后，打开记事本
2. 按住右 Alt 键
3. **预期**: 录音指示器出现，显示"录音中"
4. 对着麦克风说几句话
5. 松开右 Alt 键
6. **预期**: 指示器显示"处理中"，然后消失

#### 测试 3: 文本插入（需配置 API）
1. 在设置中配置 OpenAI API Key
2. 打开记事本，光标在输入位置
3. 按住右 Alt 说话，松开
4. **预期**: 识别的文字自动输入到记事本

#### 测试 4: 系统托盘
1. 右键点击系统托盘图标
2. **预期**: 显示菜单（设置、退出）
3. 点击"退出"
4. **预期**: 应用关闭

---

## 风险与注意事项

> [!WARNING]
> **全局快捷键监听**：需要使用 `uiohook-napi` 而不是 Electron 内置的 `globalShortcut`，因为后者不支持检测按键的按住/释放状态。

> [!IMPORTANT]
> **Windows 文本输入**：`robotjs` 在 Electron 中可能需要 rebuild。如遇问题可考虑使用 `nut.js` 或直接调用 Windows API。

> [!NOTE]
> **Python 模块**：Phase 2 才需要，MVP 先用云端 API 验证核心流程。

---

## 用户确认 ✅

| 项目 | 决定 |
|------|------|
| 包管理器 | pnpm |
| 快捷键 | 右 Alt（固定，暂不支持切换） |
| 录音指示器位置 | 屏幕中间正下方 |
| MVP 识别方式 | **本地 Faster-Whisper 模型** |
