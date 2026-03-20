# JustSay — UI/UX Redesign Brief

> 本文档为 AI 设计助手准备，包含应用的完整上下文、现有 UI 结构、技术约束和设计期望。

---

## 1. 产品概述

**JustSay** 是一个跨平台（Windows / macOS / Linux）桌面语音转录工具，提供两大核心功能：

1. **PTT（Push-to-Talk）**：按住快捷键说话，松开后自动识别语音并输出文字到当前光标位置 / 剪贴板。
2. **Meeting Transcription**：持续捕获系统音频（+可选麦克风），实时流式转录会议内容，支持双语翻译、词级时间轴，结束后自动保存。

目标用户：需要高效语音输入的知识工作者、远程会议参与者、多语言工作者。

---

## 2. 技术栈与约束

| 项 | 技术 |
|---|---|
| 框架 | Electron + electron-vite |
| 前端 | React 19 + TypeScript |
| 样式 | TailwindCSS 4（`@import 'tailwindcss'` 语法）|
| UI 组件 | 自建组件库（基于 Radix UI 基础原语 + CVA） |
| 图标 | Lucide React |
| 字体 | DM Sans（正文）、Instrument Serif（display）、JetBrains Mono（等宽） |
| 主题 | 支持 Light / Dark / System 三种模式 |
| 国际化 | 中文（zh-CN）/ 英文（en-US） |
| 窗口 | 无原生标题栏（自定义标题栏 + `-webkit-app-region: drag`） |

**设计约束：**
- 必须保持 Electron 无边框窗口方式，顶部需要拖拽区域
- 侧边栏宽度目前为 `w-16`（64px 图标导航），可以调整
- 所有颜色通过 CSS 变量定义，支持 Light/Dark 切换
- 需要兼顾中英文排版（中文通常需要更大行高）

---

## 3. 现有页面与组件结构

### 3.1 应用布局

```
┌──────────────────────────────────────────┐
│  (无原生标题栏，顶部可拖拽)                │
├────┬─────────────────────────────────────┤
│    │                                     │
│ S  │          Main Content               │
│ I  │                                     │
│ D  │                                     │
│ E  │                                     │
│ B  │                                     │
│ A  │                                     │
│ R  │                                     │
│    │                                     │
├────┴─────────────────────────────────────┤
```

- **Sidebar**（`DashboardSidebar`）：左侧图标导航，包含 Home / Meeting / History 三个 tab + 底部 Settings 按钮
- **Main Content**：根据当前视图切换不同页面

### 3.2 页面清单

| 页面 | 组件 | 功能说明 |
|---|---|---|
| **Home** | `DashboardHome` | PTT 实时状态 + 最后一次结果、开始会议 CTA、今日统计（次数/字符数/7天趋势条形图）、最近转录列表 |
| **Meeting** | `MeetingTranscription` | 会议转录主界面：状态控制（idle/starting/transcribing/stopping）、实时滚动转录文本、说话人标签+颜色、双语逐句显示、计时器 |
| **History** | `TranscriptHistory` | 转录历史列表：搜索框、来源筛选（All/PTT/Meeting）、分页、时间戳 + 时长 + 预览 |
| **Detail** | `TranscriptDetail` | 单条转录详情：说话人分段、双语显示、复制/导出/删除、AI 摘要生成、Action Items 提取 |
| **Settings** | `DashboardSettingsModal`（模态框） | 识别引擎配置、API Key、热键、外观（主题/语言）、麦克风设备选择、翻译设置、模型管理 |

### 3.3 关键子组件

| 组件 | 功能 |
|---|---|
| `DashboardHeader` | 页面标题 + 副标题 |
| `PttLiveIndicator` | PTT 实时状态指示（监听中/转录中/结果展示） |
| `PttCard` | PTT 统计卡片（今日次数、字符数、7天趋势） |
| `MeetingStatusBar` | 会议进行中时在其他页面显示的状态条（计时 + 返回/停止按钮） |
| `RecentTranscripts` | 最近转录列表（首页用） |
| `BilingualSegment` | 双语分段显示组件（原文 + 译文） |
| `WordTimingTrail` | 词级时间轴可视化 |
| `ModelManager` | 本地模型管理（下载/删除） |
| `ConfirmDialog` | 确认弹窗 |
| `Badge`, `Button`, `Card`, `Separator` | 基础 UI 原语 |

### 3.4 附加窗口

- `indicator-pill.html` — PTT 录音时的浮动指示器（小窗口）
- `output.html` — PTT 结果弹窗
- `audio-capture.html` — 系统音频捕获辅助窗口（不可见）

---

## 4. 现有设计语言

### 4.1 配色方案

**Light 模式 — "Warm Cream / Acoustic"：**
- 背景：`#FAF8F3`（暖米色）
- 前景：`#2D2A26`（深棕灰）
- 主色：`#B8632F`（赤陶橙）
- 卡片：`#FFFFFF`
- 边框：`#E5E0D8`
- 柔和文字：`#8A857C`
- 侧边栏背景：`#2D2A26`（深色）

**Dark 模式：**
- 背景：`#1A1816`
- 前景：`#E8E4DD`
- 主色：`#D4885A`
- 卡片：`#242220`
- 侧边栏背景：`#131210`

**语义色：**
- 成功：`#5D7A4F`（绿）
- 警告：`#B8862F`（金）
- 危险/录制：`#C53030`（红）
- 信息：`#3B6B96`（蓝）

### 4.2 说话人颜色

会议转录中每个说话人有固定颜色：
```
Speaker 1: #B8632F (橙)
Speaker 2: #3B6B96 (蓝)
Speaker 3: #5D7A4F (绿)
Speaker 4: #B8862F (金)
Speaker 5: #8B4F6F (紫红)
Speaker 6: #4F6B8B (钢蓝)
```

### 4.3 动画

已定义的关键帧：`fadeIn`, `slideInRight`, `slideInUp`, `slideOverIn`, `pulseRecord`, `breathe`, `staggerIn`。
自定义缓动：`--ease-out-expo`, `--ease-out-quart`。

### 4.4 排版

- 正文：DM Sans, 14px 基准
- 标题/装饰：Instrument Serif
- 等宽：JetBrains Mono
- 圆角：`--radius: 0.5rem`
- 滚动条：6px 宽，最小化样式

---

## 5. 用户交互流程

### 5.1 PTT 流程
```
用户按住热键 → 录音指示器浮窗出现 → 松开热键 → 转录中... → 文字输出到光标/剪贴板 → 首页显示最后结果
```

### 5.2 会议流程
```
首页点击"开始会议转录" → 切换到 Meeting 页面 → 点击 Start Recording
→ 实时显示滚动转录（分说话人、可双语）
→ 点击 Stop → 保存到历史 → 可查看详情 / AI 摘要 / Action Items
```

### 5.3 导航
```
Sidebar: Home ←→ Meeting ←→ History
History → 点击某条 → Detail（滑入动画）
任意页面 → 点击齿轮 → Settings 模态框
会议进行中 → 其他页面顶部显示 MeetingStatusBar → 可返回会议或停止
```

---

## 6. 设置项全览

| 分类 | 设置项 |
|---|---|
| **识别引擎** | Faster Whisper (Local) / SenseVoice (Local) / Soniox / OpenAI API / Groq |
| **语言** | 自动检测 / 中文 / 英文 / 日文 / 韩文 |
| **本地服务** | 服务模式（自动启动/远程LAN）、Host、Port、连接测试 |
| **本地高级** | 识别策略（Auto/Streaming/HTTP）、转录配置、弱边界延迟 |
| **API Key** | 识别 API Key、翻译 API Key（安全存储） |
| **热键** | Right Ctrl / Right Alt |
| **会议** | 是否包含麦克风、麦克风设备选择 |
| **翻译** | PTT 翻译开关、会议翻译开关、目标语言、Provider、Model、Endpoint |
| **外观** | 主题（System/Light/Dark）、界面语言（中文/英文） |
| **系统** | 开机自启、录音指示器开关、声音反馈开关 |
| **模型管理** | 本地模型列表、删除模型 |

---

## 7. 文件位置参考

供 AI 直接查看源码时使用：

```
src/renderer/src/
├── App.tsx                              # 主路由 + 全局状态
├── main.tsx                             # 入口
├── styles/globals.css                   # 全局样式 + CSS 变量 + 动画
├── pages/
│   ├── DashboardHome.tsx                # 首页
│   ├── MeetingTranscription.tsx         # 会议转录
│   ├── TranscriptHistory.tsx            # 历史列表
│   └── TranscriptDetail.tsx             # 转录详情
├── components/
│   ├── dashboard/
│   │   ├── DashboardHeader.tsx
│   │   ├── DashboardSidebar.tsx
│   │   ├── DashboardSettingsModal.tsx
│   │   ├── MeetingStatusBar.tsx
│   │   ├── PttCard.tsx
│   │   ├── PttLiveIndicator.tsx
│   │   └── RecentTranscripts.tsx
│   ├── transcript/
│   │   ├── BilingualSegment.tsx
│   │   └── WordTimingTrail.tsx
│   ├── Settings/
│   │   └── ModelManager.tsx
│   └── ui/                              # 基础 UI 原语
│       ├── badge.tsx
│       ├── button.tsx
│       ├── card.tsx
│       ├── confirm-dialog.tsx
│       └── separator.tsx
├── hooks/
│   ├── useHomeStats.ts
│   └── useTranscripts.ts
├── i18n/                                # 国际化
│   ├── locales/en-US.ts
│   └── locales/zh-CN.ts
└── lib/
    ├── transcript-segmentation.ts
    ├── transcript-source.ts
    └── utils.ts
```

---

## 8. 设计改进方向（供参考）

以下是一些可以探索的方向，不限于此：

- **首页布局**：当前首页信息较散（PTT 状态、会议入口、统计、最近列表），可以重新组织信息层次
- **会议转录体验**：实时转录的可读性、说话人区分的视觉效果、长文本滚动体验
- **Settings 复杂度**：设置项非常多，当前是模态框 + tab，可能需要更好的信息架构
- **空状态**：各页面的空状态引导可以更友好
- **微交互**：按键录音的视觉反馈、转录完成的过渡、页面切换动画
- **一致性**：确保 Light/Dark 模式下视觉体验一致且高质量
- **信息密度**：桌面应用可以利用更多空间，但也不应过于稀疏
- **可访问性**：键盘导航、焦点管理、对比度

---

*此文档生成于 2026-03-20，基于 JustSay v1.0.0 源码分析。*
