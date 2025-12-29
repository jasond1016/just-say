# JustSay 语音转录工具 - 开发任务

## Phase 1: MVP 基础功能

### 1.1 项目初始化

- [x] 创建 Electron + React + TypeScript 项目
- [x] 配置项目结构和依赖
- [x] 设置 electron-builder 打包配置 (Basic)

### 1.2 核心功能实现

- [x] 全局快捷键监听（右 Alt 按住说话）
- [x] 音频录制模块
- [x] 系统托盘基础功能
- [x] 录音状态悬浮指示器

### 1.3 识别后端 - 本地模型

- [x] Faster-Whisper Python 服务
- [x] 识别后端接口抽象

### 1.4 文本输入

- [x] Windows 文本模拟输入
- [x] Linux 文本输入（剪贴板 + 自动粘贴）

---

## Phase 2: 本地模型 & 云端集成

### 2.1 Faster-Whisper 集成

- [x] Python 服务封装
- [x] Electron 与 Python 通信
- [x] 模型下载与管理 UI

### 2.2 Soniox Realtime API 集成

- [x] WebSocket 流式识别
- [x] 流式音频录制（边录边发）
- [x] 低延迟优化（松开后 ~500ms 出结果）

---

## Phase 3: 完善 UI

### 3.1 设置界面

- [ ] 常规设置页面
- [ ] 快捷键设置
- [ ] 识别后端配置
- [ ] 模型管理页面

### 3.2 历史记录

- [ ] 转录历史存储
- [ ] 历史记录查看/搜索

---

## Phase 4: 跨平台

### 4.1 macOS 适配

- [ ] 快捷键适配
- [ ] 文本插入适配
- [ ] 权限请求处理

### 4.2 Linux 适配

- [x] X11 快捷键支持（uiohook-napi）
- [x] PulseAudio 音频录制
- [x] xdotool 文本粘贴
- [ ] Wayland 兼容

---

## 当前进度

**状态**: Phase 2 完成，Linux 基础适配完成
**最新更新**: 2024-12-28

- 集成 Soniox Realtime API（流式 WebSocket）
- 实现流式音频录制和识别
- 松开键后延迟从 ~2.5s 降至 ~500ms
