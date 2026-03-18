# WS 实时转录数据流文档

本文档记录了使用 WebSocket 端点进行会议实时转录时，从 Python 后端到 Electron 前端 UI 的**完整数据流**，包括数据结构、字段说明、状态管理和优化注意事项。

---

## 1. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│  Python 后端  (whisper_server.py)                            │
│  ┌──────────────────────┐  ┌─────────────────────────────┐  │
│  │   HTTP Server :8765  │  │  WS Server :8766            │  │
│  │  /health             │  │  /stream?params...          │  │
│  │  /capabilities       │  │  WebSocketStreamingSession  │  │
│  │  /transcribe         │  │    ├ TranscriptAssembler    │  │
│  │  /gpu                │  │    └ emit_json()            │  │
│  └──────────────────────┘  └─────────────┬───────────────┘  │
└──────────────────────────────────────────┼──────────────────┘
                         JSON events (WS)  │
                                           ▼
┌──────────────────────────────────────────────────────────────┐
│  Electron 主进程  (src/main/)                                 │
│  ┌──────────────────────────────────────────────────┐        │
│  │  StreamingLocalWsRecognizer (streaming-local-ws.ts)       │
│  │    ├ startSession()  → 连接 ws://host:wsPort/stream      │
│  │    ├ sendAudioChunk() → 二进制 PCM                        │
│  │    ├ handleMessage()  → 解析 JSON 事件                    │
│  │    └ emitPartialResult() → emit('partial', PartialResult) │
│  └──────────────────────────────┬───────────────────┘        │
│                                 │                            │
│  ┌──────────────────────────────▼───────────────────┐        │
│  │  MeetingTranscriptionManager (meeting-transcription.ts)   │
│  │    ├ on('partial') → 构造 TranscriptSegment               │
│  │    └ emit('transcript', segment) → IPC 发送给 renderer    │
│  └──────────────────────────────┬───────────────────┘        │
└─────────────────────────────────┼────────────────────────────┘
                      IPC: 'meeting-transcript'
                                  │
┌─────────────────────────────────▼────────────────────────────┐
│  Preload  (src/preload/index.ts)                              │
│  window.api.onMeetingTranscript(callback)                     │
│    ipcRenderer.on('meeting-transcript', ...)                  │
└─────────────────────────────────┬────────────────────────────┘
                                  │
┌─────────────────────────────────▼────────────────────────────┐
│  Renderer  (src/renderer/)                                    │
│  ┌──────────────────────────────────────────────────┐        │
│  │  Dashboard / MeetingTranscription Page            │        │
│  │  ├ MeetingSessionState { segments, currentSegment }       │
│  │  ├ toSentencePairsFromLive() / toSentencePairsFromCurrentLive() │
│  │  ├ BilingualSegment  (逐句原文+译文显示)                   │
│  │  └ WordTimingTrail   (实时词级别时间轴)                    │
│  └──────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. 数据流详解

### 2.1 音频采集 → Python 后端

| 步骤            | 位置                                | 说明                                                  |
| --------------- | ----------------------------------- | ----------------------------------------------------- |
| 采集系统音频    | Renderer (`desktopCapturer`)        | 利用 Electron 的 `desktopCapturer` 获取系统音频流     |
| 下采样/PCM 编码 | Renderer (`audio-capture-entry.ts`) | 转为 PCM16LE mono, 16kHz                              |
| IPC 发送        | Preload → Main                      | `ipcRenderer.send('system-audio-chunk', ArrayBuffer)` |
| 接收            | Main (`handleRendererAudioChunk`)   | 直接或经混音后调用 `recognizer.sendAudioChunk(chunk)` |
| WS 发送         | `StreamingLocalWsRecognizer`        | 二进制帧发送到 Python WS Server                       |
| 服务端接收      | `WebSocketStreamingSession.run()`   | `isinstance(message, bytes)` → 追加到 `pending_pcm`   |

> **音频格式**: PCM 16-bit Little-Endian, 单声道, 16000 Hz (可配 `sample_rate`)

### 2.2 WS 连接建立

```
Electron (StreamingLocalWsRecognizer)                   Python (whisper_server.py)
       │                                                      │
       │  1. GET /capabilities                                 │
       │ ◄────────────────────────────────────────────────────► │
       │     { streaming_asr: true, ws_port: 8766, events: [...] }
       │                                                      │
       │  2. WS connect ws://host:8766/stream?engine=...       │
       │ ────────────────────────────────────────────────────► │
       │                                                      │
       │  3. { type: "ready", streaming: true }                │
       │ ◄──────────────────────────────────────────────────── │
       │                                                      │
       │  4. Binary PCM audio chunks ────────────────────────► │
       │                                                      │
       │  5. JSON events ◄──────────────────────────────────── │
```

**WS 连接 URL 参数** (由 `whisperServer.ts` `getStreamWsUrl()` 拼接):

| 参数                       | 默认                          | 说明                                       |
| -------------------------- | ----------------------------- | ------------------------------------------ |
| `engine`                   | `sensevoice`                  | ASR 引擎 (`faster-whisper` / `sensevoice`) |
| `model`                    | `tiny`                        | Faster-Whisper 模型                        |
| `sensevoice_model_id`      | `FunAudioLLM/SenseVoiceSmall` | SenseVoice 模型 ID                         |
| `sample_rate`              | `16000`                       | 音频采样率                                 |
| `language`                 | `auto`                        | 语言                                       |
| `return_word_timestamps`   | `false`                       | 是否返回词级时间戳                         |
| `text_corrections`         | —                             | JSON 文本纠错规则                          |
| `preview_interval_ms`      | `450`                         | Preview 最小间隔                           |
| `preview_min_audio_ms`     | `350`                         | Preview 最小音频长度                       |
| `preview_min_new_audio_ms` | `220`                         | 有新数据才触发 preview                     |
| `preview_window_ms`        | `2600`                        | Preview 音频窗口大小                       |
| `min_chunk_ms`             | `1000`                        | 最小 chunk 音频长度                        |
| `silence_ms`               | `700`                         | 静音阈值                                   |
| `max_chunk_ms`             | `5000`                        | 最大 chunk 音频长度                        |
| `overlap_ms`               | `520`                         | Chunk 间重叠                               |

### 2.3 Python 后端事件生成

`WebSocketStreamingSession` 核心循环 (`run()`):

```
while not closed:
  ├─ recv(timeout=0.2)
  │    ├─ 二进制帧 → 追加到 pending_pcm, 更新 pending_new_bytes
  │    └─ JSON 帧 → flush / close / ping 命令
  │
  ├─ emit_preview()    # 定时用 preview 窗口音频做 ASR → interim 事件
  └─ maybe_emit_final_by_timing()   # 静音/超长 → final 转录 → final_chunk 事件
```

#### 事件类型一览

| 事件类型          | 触发条件                                           | 意义                                                |
| ----------------- | -------------------------------------------------- | --------------------------------------------------- |
| `ready`           | WS 连接建立后                                      | 通知客户端流式已就绪                                |
| **`interim`**     | 定期 preview（`emit_preview()`）                   | 未定稿的实时预览文本                                |
| **`final_chunk`** | 静音/超长/稳定前缀/flush/close 触发 `emit_final()` | 已定稿的新增文本 delta                              |
| **`sentence`**    | final_chunk 后句子边界检测                         | 完整句子文本（用于翻译对齐）                        |
| **`endpoint`**    | 仅在声学/控制边界时伴随 final_chunk                | 触发原因 (`silence`, `max_chunk`, `flush`, `close`) |
| `final`           | flush/close 命令                                   | 整个会话的最终完整文本                              |
| `error`           | 错误                                               | 错误消息                                            |
| `pong`            | 收到 ping                                          | 心跳响应                                            |

---

## 3. 核心数据结构

### 3.1 Python 后端 → Electron (WS JSON Events)

#### `interim` 事件

当前实现:

- `previewText` 允许整体改写，因为它只是当前窗口最佳猜测。
- `pendingText` 必须表示“尚未通过 `final_chunk` 提交的缓冲内容”，应尽量单调演进。
- `commitReadyText` 表示当前可以安全提交的前缀；`unstableTailText` 表示保留继续观察的尾巴。
- `interim.wordTimings` 不再建议作为正式协议字段；如果保留，建议仅用于 debug。

```json
{
  "type": "interim",
  "previewText": "今天的会议主要讨论", // 当前滑窗最佳猜测，可整体改写
  "pendingText": "今天的会议主要讨论", // 未提交缓冲，应尽量单调演进
  "commitReadyText": "今天的会议主要", // 可安全提交的前缀
  "unstableTailText": "讨论", // 暂不提交的尾巴
  "revision": 12,
  "ts": 1710574800000
}
```

#### `final_chunk` 事件

```json
{
  "type": "final_chunk",
  "text": "今天的会议主要讨论三个议题。",  // 已定稿的新增 delta
  "reason": "silence",                      // 可选：本次提交的触发原因
  "wordTimings": [...],                    // 可选；仅当能提供会话级绝对时间时才有长期价值
  "ts": 1710574801000
}
```

#### `sentence` 事件

```json
{
  "type": "sentence",
  "text": "今天的会议主要讨论三个议题。", // 完整句子
  "ts": 1710574801000
}
```

#### `endpoint` 事件

```json
{
  "type": "endpoint",
  "reason": "silence", // "silence" | "max_chunk" | "flush" | "close"
  "ts": 1710574801000
}
```

说明:

- 当 `final_chunk.reason = "stable_prefix"` 时，通常不会伴随 `endpoint`，因为这不是声学断句，而是长句中的保守前缀提交。

### 3.2 Electron 主进程内部 (`streaming-local-ws.ts`)

#### 状态字段

| 字段                  | 类型               | 说明                               |
| --------------------- | ------------------ | ---------------------------------- |
| `confirmedText`       | `string`           | 所有已 commit 文本的拼接           |
| `previewText`         | `string`           | 当前未确认的 preview 文本          |
| `previewStableText`   | `string`           | preview 中稳定的前缀               |
| `previewUnstableText` | `string`           | preview 中不稳定的尾巴             |
| `currentWordTimings`  | `WordTiming[]`     | 当前词级时间戳                     |
| `completedSegments`   | `SpeakerSegment[]` | 所有已完成的说话人段               |
| `sentencePairs`       | `SentencePair[]`   | 句对列表（用于双语对齐）           |
| `liveSentenceTail`    | `string`           | 还未被 sentence 事件消费的文本尾巴 |
| `endpointReason`      | `string`           | 最近一次 endpoint 原因             |

#### `PartialResult` (emit 给 `MeetingTranscriptionManager`)

```typescript
interface PartialResult {
  segments: SpeakerSegment[] // 所有已完成段
  currentSegment: SpeakerSegment | null // 当前活跃段（preview）
  currentWordTimings?: WordTiming[] // 当前词级时间戳
  combined: string // confirmedText + previewText
  currentSpeaker: number // 当前说话人编号
  translationEnabled: boolean
}
```

#### `SpeakerSegment`

```typescript
interface SpeakerSegment {
  speaker: number
  text: string // 完整文本
  previewText?: string // 预览文本
  commitReadyText?: string // 可安全提交的前缀
  unstableTailText?: string // 不稳定尾巴
  wordTimings?: WordTiming[]
  endpointReason?: string
  translatedText?: string // 译文
  sentencePairs?: SentencePair[]
  timestamp?: number
  isFinal: boolean // 是否已定稿
}
```

### 3.3 Main → Renderer IPC (`TranscriptSegment`)

通过 `ipcMain` → `meeting-transcript` → Preload → Renderer：

```typescript
interface TranscriptSegment {
  text: string // combined (confirmedText + previewText)
  translatedText?: string
  timestamp: number
  isFinal: boolean
  source?: 'system' | 'microphone' | 'mixed'
  speaker?: number
  speakerSegments?: SpeakerSegment[] // 所有已完成段
  currentSpeakerSegment?: SpeakerSegment // 当前活跃段
  currentWordTimings?: WordTiming[]
  translationEnabled?: boolean
}
```

### 3.4 Renderer 前端状态 (`MeetingSessionState`)

```typescript
interface MeetingSessionState {
  status: 'idle' | 'starting' | 'transcribing' | 'stopping' | 'error'
  isPreconnecting: boolean
  preconnectFailed: boolean
  seconds: number // 已录制时间（秒）
  startedAt: number | null
  segments: SpeakerSegment[] // 来自 speakerSegments
  currentSegment: SpeakerSegment | null // 来自 currentSpeakerSegment
  lastError: string | null
}
```

---

## 4. 事件处理链路

### 4.1 `interim` 事件处理

```
Python emit_preview()
   ├─ transcribe_pcm(preview 窗口音频)
   ├─ 去重 (find_text_overlap + deduplicate_timed_prefix_from_base)
   └─ TranscriptAssembler.build_interim_event()
        ├─ accumulate_preview_text()  — 累积 preview, 防止文本回退
        ├─ should_guard_preview_reset() — 防止 preview 异常重置
        └─ build_preview_snapshot()  — 计算 stableText / unstableText
```

当前实现语义要点:

- 这里构造的是“更稳定的 preview”，不是“严格意义上的未提交缓冲”。
- 因为 preview 基于滑动窗口重识别，`text` 在某些时刻会整体改写，而不是只在尾部追加。
- `stableText` 目前只是显示层面的启发式稳定前缀，不应直接视为 commit 游标。

```
Electron handleMessage('interim')
   ├─ normalizePreviewText(data.pendingText)
   ├─ deduplicatePreviewFromCommitted(preview)
   ├─ applyPreviewStateFromServer(commitReadyText, unstableTailText)
   └─ emitPartialResult() → emit('partial', PartialResult)
```

### 4.2 `final_chunk` 事件处理

```
Python emit_final()
   ├─ transcribe_pcm(所有 pending PCM)
   ├─ 文本去重 + apply_text_corrections()
   ├─ TranscriptAssembler.queue_final_chunk() → pending_final_chunk
   ├─ commit_sentence_prefix_if_possible() (拆分句子边界)
   └─ commit_pending_final_chunk()
       ├─ emit final_chunk event
       ├─ maybe_emit_sentence_event() → sentence event(s)
       └─ emit endpoint event
```

```
Electron handleMessage('final_chunk')
   ├─ appendCommittedChunk(text) → 追加到 confirmedText + completedSegments
   ├─ 清除 preview 状态
   └─ emitPartialResult()
```

### 4.3 `sentence` 事件处理

```
Electron handleMessage('sentence')
   ├─ applyFinalizedSentenceFromServer(text)
   │   ├─ 更新 liveSentenceTail (消费已确认部分)
   │   ├─ 添加到 sentencePairs
   │   └─ finalizePendingSentenceSegments() → 将 sentencePairs 关联到 completedSegments
   └─ translatePairAsync(pairIndex) → 异步翻译
       ├─ 单条翻译 (translator)
       └─ 批量翻译 (batchTranslator, 窗口合并)
```

---

## 5. 文本处理核心算法

### 5.1 Preview 累积 (`accumulate_preview_text`)

Preview 文本不可直接替换——需要**累积**策略来保持视觉稳定性：

1. **相同前缀**: 共同有意义字符 ≥12 或占比 ≥70% → 直接使用新文本
2. **尾部重叠**: `find_text_overlap()` → 拼接
3. **锚点对齐**: `merge_with_anchor_alignment()` → 在 previous 中找到 incoming 的开头，截取拼接
4. **近尾替换**: `replace_near_tail_with_incoming()` → 类似逻辑
5. **句子衔接**: 前文以句号结尾且前文 ≥12 字、新文 ≥8 字 → 拼接
6. **完全替换**: 以上都不匹配 → 直接用新文本

### 5.2 Stable / Unstable 分离 (`build_preview_snapshot`)

维护最近 N 个 preview 结果 (`preview_history`, 窗口大小 3-4):

- **stableText**: 所有历史记录的公共前缀，并裁掉尾部若干有意义字符
- **unstableText**: 完整 preview 减去 stableText
- 特殊处理：
  - 英语文本使用不同参数 (`ENGLISH_PREVIEW_*`)
  - 防止 stableText 回退超过阈值 (`shrink_stable_prefix`)
  - Latin 文本边界修正 (`trim_latin_stable_prefix`)

注意:

- 这一层解决的是“显示稳定性”，不是“提交语义”。
- 只要底层 ASR 还是滑动窗口重识别，`stableText` 就可能回退、清空或在局部突然变化。
- 如果后续要做稳定前缀提交，建议单独维护 `commitReadyText`/提交游标，而不是直接复用这里的 `stableText`。

### 5.3 文本去重 (`deduplicatePreviewFromCommitted`)

每次 preview/final 结果都可能与已确认文本有重叠：

- `find_text_overlap(base, text, 200)` → 去除重叠前缀
- `deduplicate_timed_prefix_from_base()` → 基于 wordTimings 做更精确去重

### 5.4 Final Chunk 延迟提交 (`should_defer_final_chunk`)

以下情况会**延迟**提交 final_chunk：

- 静音触发但文本以弱边界后缀结尾 (如介词、助词)
- 文本过短或只有标点
- `max_chunk` 触发但当前 preview 暗示文本还在增长
- 词级时间戳显示尾部不稳定

建议的提交策略（待实施）:

- `flush` / `close`: 直接提交全部 `pendingText`
- `silence + min_chunk_ms`: 做声学断句后的提交
- 长时间无停顿: 允许提交 `commitReadyText`，但应满足“最近若干次 preview 前缀一致 + 落在安全边界 + 剩余尾巴很短”
- 不建议使用“段落结束”作为在线提交条件，语义过强、误判成本高
- `stableText` 可以参与启发式判断，但不应单独决定提交

### 5.5 CJK 文本规范化

- `normalize_japanese_spacing()`: 删除日文/CJK 字符间多余空格
- `normalize_japanese_ordinals()`: 数字序数词规范化 (如 `1つ目` → `一つ目`)
- `strip_japanese_asr_symbols()`: 清除 ASR 引入的 emoji/音符
- `should_insert_space()`: CJK 字符间不插入空格，Latin 字符间自动插入

---

## 6. 翻译子流程

### 6.1 流程

```
sentence 事件到达
   └─ translatePairAsync(pairIndex)
       ├─ 单条模式: translator(text, targetLanguage)
       └─ 批量模式: batchTranslator(texts[], targetLanguage)
           ├─ pendingTranslationPairIndices 缓冲
           ├─ batchWindowMs (默认 450ms) 定时器
           └─ maxBatchItems (默认 6) 立即 flush
```

### 6.2 翻译结果更新

翻译完成后：

1. 更新 `sentencePairs[index].translated`
2. 更新对应 `completedSegments[segmentIndex].translatedText`
3. 重新 `emitPartialResult()` → UI 更新

---

## 7. Renderer 侧 UI 渲染

### 7.1 数据转换

| 函数                               | 输入             | 输出                     | 用途                                      |
| ---------------------------------- | ---------------- | ------------------------ | ----------------------------------------- |
| `toSentencePairsFromLive()`        | `SpeakerSegment` | `RendererSentencePair[]` | 已完成段的句对提取                        |
| `toSentencePairsFromCurrentLive()` | 当前段           | `RendererSentencePair[]` | 当前活跃段的句对（剥离 unstableTailText） |

### 7.2 UI 组件

| 组件               | 职责                                               |
| ------------------ | -------------------------------------------------- |
| `BilingualSegment` | 渲染原文/译文句对                                  |
| `WordTimingTrail`  | 渲染词级时间戳 (当前段)                            |
| 自动滚动           | `isNearBottom()` 检测 → `scrollTop = scrollHeight` |

### 7.3 Preview 显示策略

```
currentSegment:
  ├─ commitReadyText → BilingualSegment 正常渲染
  ├─ previewText / unstableTailText → BilingualSegment 灰色 preview
  └─ wordTimings → WordTimingTrail 实时可视化
```

如果 `segment.text` 以 `previewText` 结尾，则提取为 inline preview（不同样式）。

---

## 8. 优化时需关注的项目

### 8.1 延迟优化

| 优化点               | 当前方案                       | 可改进方向                             |
| -------------------- | ------------------------------ | -------------------------------------- |
| **Pre-connect**      | 打开会议窗口即预连接 WS        | OK，但预连接超时 (2500ms) 后回退冷启动 |
| **Preview 频率**     | 450ms 间隔 + 最少 220ms 新音频 | 可调小但会增加 ASR 负载                |
| **混音延迟**         | 50ms 定时器合并系统+麦克风音频 | 可改为立即发送（如不需要混音）         |
| **Final chunk 延迟** | 静音 700ms 后才提交            | 减小值可提高响应但增加误切断           |
| **翻译批量窗口**     | 450ms / 6 条                   | 减小窗口降低翻译延迟                   |

### 8.2 文本稳定性

| 问题              | 原因                       | 建议                                                                 |
| ----------------- | -------------------------- | -------------------------------------------------------------------- |
| Preview 文本闪烁  | ASR 模型每次推理不一致     | `accumulate_preview_text()` 已做降噪，stable/unstable 分离进一步提升 |
| Final 文本截断    | 句子边界检测不准           | 调整 `min_chunk_ms` / 句子 flush 阈值                                |
| CJK 空格问题      | ASR 模型输出不规范         | `normalize_japanese_spacing()` 已处理                                |
| 英语 preview 重置 | 长句中间突然收到短 preview | `should_guard_preview_reset()` 保护                                  |

### 8.3 资源与性能

| 要素                               | 说明                                                           |
| ---------------------------------- | -------------------------------------------------------------- |
| **PCM 缓冲区增长**                 | `pending_pcm` 在 final 后只保留 `overlap_ms` 部分              |
| **Preview 转录开销**               | 每次 preview 都做完整 ASR 推理，preview_window_ms 控制音频范围 |
| **IPC 频率**                       | 每个 WS 事件都触发 IPC + React re-render，高频场景需注意       |
| **翻译 API 调用**                  | 批量合并已优化，但网络不稳定时可能阻塞队列                     |
| **`interim.wordTimings` 价值有限** | 其时间戳相对 preview 窗口而非整场音频，公开暴露后消费价值较低  |

### 8.4 前端渲染优化

| 要素            | 当前状态                        | 建议                                    |
| --------------- | ------------------------------- | --------------------------------------- |
| 自动滚动        | 仅在 near-bottom 时触发         | OK                                      |
| Segment 列表    | key=`${speaker}-${index}`       | 如果段落频繁重排可能导致不必要 re-mount |
| WordTimingTrail | 每帧重渲染                      | 可用 `React.memo` 优化                  |
| 样式计算        | 每次 render 都计算 speakerColor | 可缓存                                  |
| 大量 segments   | 无虚拟化                        | 长会议可考虑 virtualization             |

### 8.5 可靠性

| 要素         | 当前方案                                         | 建议             |
| ------------ | ------------------------------------------------ | ---------------- |
| WS 断连      | close 事件清理 `this.ws = null`                  | 未实现自动重连   |
| ASR 引擎切换 | 支持 SenseVoice / Faster-Whisper / Soniox / Groq | 切换时需重建连接 |
| 错误恢复     | `error` 事件传播给 UI                            | 可增加重试逻辑   |

---

## 9. 关键文件索引

| 文件                                                          | 职责                                                                                                     |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `python/whisper_server.py`                                    | 整个 Python 后端：HTTP/WS 服务器、ASR 推理、`WebSocketStreamingSession`、`TranscriptAssembler`、文本处理 |
| `src/main/recognition/streaming-local-ws.ts`                  | WS 客户端，解析后端事件，管理 confirmed/preview/sentence 状态                                            |
| `src/main/recognition/whisperServer.ts`                       | WhisperServerClient：管理 Python 进程、构建 WS URL、health check                                         |
| `src/main/recognition/streaming-soniox.ts`                    | Soniox 后端的 WS 识别器（相同 PartialResult 接口）                                                       |
| `src/main/meeting-transcription.ts`                           | 会议转录管理器：编排识别器、音频路由、翻译、profiling                                                    |
| `src/preload/index.ts`                                        | IPC 桥接：将 Main 的 `meeting-transcript` 事件暴露给 Renderer                                            |
| `src/renderer/src/pages/MeetingTranscription.tsx`             | 会议 UI 组件：渲染 segments、currentSegment、自动滚动                                                    |
| `src/renderer/src/lib/transcript-segmentation.ts`             | 前端句对提取：`toSentencePairsFromLive()` / `toSentencePairsFromCurrentLive()`                           |
| `src/renderer/src/lib/live-transcript.ts`                     | 前端文本累积/去重工具                                                                                    |
| `src/renderer/src/components/transcript/BilingualSegment.tsx` | 双语段落渲染组件                                                                                         |
| `src/renderer/src/components/transcript/WordTimingTrail.tsx`  | 词级时间戳可视化组件                                                                                     |
