# Groq 会议转录实现文档

## 功能概述

为会议转录功能添加了 Groq 后端支持，实现了：
- 会议转录跟随全局识别后端设置（Settings → 识别 → 后端）
- Groq 后端使用两步处理：**Whisper API 转录** + **Chat API 翻译**
- **渐进式显示**：转录完成立即显示原文，翻译异步更新（不阻塞 UI）

## 架构对比

| 特性 | Soniox | Groq |
|------|--------|------|
| 协议 | WebSocket 流式 | REST API + 音频缓冲 |
| 转录+翻译 | 一个连接同时完成 | 两步：Whisper → Chat |
| 说话人分离 | ✅ 支持 | ❌ 不支持（固定 speaker 0） |
| 原文延迟 | ~0.7-1s | ~1.6s（缓冲0.6s + API 1s） |
| 译文延迟 | 同时 | ~2.1s（原文后 0.5s） |

## 文件清单

### 新建文件
- **`src/main/recognition/streaming-groq.ts`** (~500 行)
  - `StreamingGroqRecognizer` 类，实现与 `StreamingSonioxRecognizer` 相同的接口
  - 音频缓冲与智能端点检测
  - Groq Whisper API 转录
  - Groq Chat API 翻译（异步）
  - 渐进式结果发送

- **`src/main/recognition/vad-utils.ts`** (~80 行)
  - `calculateRMS()` - 计算 16-bit PCM 音频的 RMS 能量值
  - `VADState` 类 - 带防抖的语音活动检测状态机

### 修改文件
- **`src/main/meeting-transcription.ts`**
  - 新增 `MeetingBackend` 类型 (`'soniox' | 'groq'`)
  - 构造函数改为接受 `(backend, sonioxConfig?, groqConfig?)`
  - 根据后端类型创建对应 recognizer

- **`src/main/index.ts`**
  - 新增 `createMeetingTranscriptionManager()` 辅助函数
  - 根据 `config.recognition.backend` 选择后端和配置

- **`src/main/config.ts`**
  - `recognition.groq.chatModel` - 翻译模型配置

- **`src/renderer/src/pages/Settings.tsx`**
  - Groq 配置区域添加"翻译模型"下拉框

## 核心实现

### 1. VAD 端点检测（基于 RMS 能量）

使用轻量级 VAD（Voice Activity Detection）检测真正的语音活动，而非简单的音频流中断检测。

**VAD 工具模块** (`src/main/recognition/vad-utils.ts`):
- `calculateRMS()` - 计算 16-bit PCM 音频的 RMS 能量值
- `VADState` 类 - 带防抖的状态机（连续 3 个静音块才确认静音）

**端点检测参数**（已优化）:
```typescript
MAX_CHUNK_DURATION_MS = 15000  // 15秒强制处理（原30秒）
SILENCE_THRESHOLD_MS = 600     // 0.6秒静音触发（原1.5秒）
MIN_CHUNK_DURATION_MS = 1000   // 1秒最小缓冲（原2秒）
VAD_SILENCE_THRESHOLD = 0.01   // RMS 静音阈值
```

**工作原理**:
```typescript
sendAudioChunk(chunk: Buffer): void {
  // 使用 VAD 检测语音活动
  const isSpeech = this.vadState.processChunk(chunk)
  if (isSpeech) {
    this.lastSpeechTime = Date.now()  // 只在检测到语音时更新
  }
}
```

### 2. 处理流程
```
音频块 → 缓冲 → 端点检测 →
  Whisper API 转录 → 立即发送原文 →
  Chat API 翻译（异步）→ 更新译文
```

### 3. 翻译模型选项
| 模型 ID | 显示名称 |
|---------|----------|
| `moonshotai/kimi-k2-instruct-0905` | Kimi K2 (推荐) - **默认** |
| `llama-3.3-70b-versatile` | Llama 3.3 70B |
| `llama-3.1-70b-versatile` | Llama 3.1 70B |
| `mixtral-8x7b-32768` | Mixtral 8x7B (更快) |

### 4. 翻译 Prompt
```
System: "You are a professional translator. Translate the given text accurately
while preserving tone and meaning. Only output the translation, no explanations."

User: "Translate this meeting transcript to {language}. Preserve the tone,
technical terms, and speaker intent. Only output the translation:\n\n{text}"
```

## 配置结构

```typescript
// config.recognition.groq
{
  apiKey?: string                                        // 存储在 secureStore
  model?: 'whisper-large-v3-turbo' | 'whisper-large-v3'  // Whisper 模型
  chatModel?: string                                     // 翻译模型，默认 kimi-k2
}
```

## StreamingGroqConfig 接口

```typescript
export interface StreamingGroqConfig {
  apiKey?: string
  whisperModel?: 'whisper-large-v3-turbo' | 'whisper-large-v3'
  chatModel?: string // Default: 'moonshotai/kimi-k2-instruct-0905'
  language?: string
  sampleRate?: number
  translation?: {
    enabled: boolean
    targetLanguage: string // e.g., 'en', 'zh', 'ja', 'fr'
  }
}
```

## 渐进式显示策略

```typescript
private async processBufferedAudio(): Promise<void> {
  // 步骤1: 转录完成，立即显示原文
  const transcription = await this.transcribeAudio(wavBuffer)
  this.emitPartialResult(transcription.text, undefined) // 先发原文，不等翻译

  // 步骤2: 异步翻译（不阻塞UI）
  if (this.config.translation?.enabled) {
    this.translateText(transcription.text, targetLang)
      .then(translatedText => {
        // 翻译完成，再次发送事件更新UI
        this.emitPartialResult(transcription.text, translatedText)
      })
      .catch(err => {
        console.warn('Translation failed:', err)
        // 翻译失败不影响原文显示
      })
  }
}
```

**用户体验对比**：
- 原方案（串行）：说话暂停 → 0.6s → 转录(1s) → 翻译(0.5s) → 显示 = **2.1秒**
- 优化方案（并行）：
  - 看到原文：0.6s + 1s = **1.6秒**
  - 看到译文：0.6s + 1s + 0.5s = **2.1秒**（译文在原文之后出现）

## API 端点

- **Whisper API**: `https://api.groq.com/openai/v1/audio/transcriptions`
- **Chat API**: `https://api.groq.com/openai/v1/chat/completions`

## 成本估算

- 30 分钟会议约 20 个音频块
- Whisper API: ~$1.50-3.00
- Chat API 翻译: ~$0.10-0.50
- **总计: ~$1.60-3.50 / 30分钟会议**

## 后续改进方向

1. **进一步降低延迟**
   - 调整 VAD 静音阈值（`VAD_SILENCE_THRESHOLD`）适应不同音频环境
   - 使用 Silero VAD 等 ML 模型获得更高精度（CPU 开销较高）

2. **增强功能**
   - 添加 API 重试逻辑（429 速率限制处理）
   - 翻译缓存避免重复翻译

3. **用户体验**
   - 会议页面显示当前使用的后端
   - 翻译失败时的 UI 提示

4. **成本优化**
   - 增大缓冲减少 API 调用次数
   - 可选的翻译开关
