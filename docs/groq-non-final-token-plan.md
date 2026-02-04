# Groq 后端 Non-final/Final Token 机制实现计划

## 目标

为 Groq 后端实现类似 Soniox 的 Non-final/Final token 机制，在保持 REST API 限制下实现：
- **即时反馈**：~400ms 显示预览文本（non-final）
- **稳定输出**：静音后确认文本（final），永不改变
- **降低感知延迟**：从 ~1.6s 降至 ~400-500ms

## Soniox 机制回顾

```
Non-final token (is_final: false) → 即时显示，可能改变
Final token (is_final: true)     → 确认后永不改变

渲染公式: display = finalTokens + nonFinalTokens
```

Soniox 实现参考 ([streaming-soniox.ts:81-84](src/main/recognition/streaming-soniox.ts#L81-L84))：
```typescript
private currentSegmentText: string[] = []      // final tokens
private interimText: string[] = []             // non-final tokens (每次响应重置)
```

## 核心方案：双缓冲投机处理 + 预览窗口

由于 Groq 是 REST API（非 WebSocket），采用**投机处理**策略：

```
音频流 ════════════════════════════════════►

[====预览窗口====] ← 400ms 触发, Non-final (可被覆盖, 仅最近几秒)
[=========确认块=========] ← 静音检测后, Final (永久)
```

## 修改文件

### 主文件: [streaming-groq.ts](src/main/recognition/streaming-groq.ts)

#### 1. 新增参数 (约第 46-50 行后)

```typescript
// === 预览处理 (Non-final) ===
private readonly PREVIEW_INTERVAL_MS = 400      // 预览触发间隔
private readonly PREVIEW_MIN_AUDIO_MS = 300     // 预览最小音频长度
private readonly PREVIEW_WINDOW_MS = 2500       // 预览窗口 (仅最近几秒)
private readonly PREVIEW_MIN_NEW_AUDIO_MS = 200 // 新增音频阈值，避免频繁重试

// === 确认处理 (Final) - 优化现有参数 ===
private readonly SILENCE_THRESHOLD_MS = 400     // 从 600ms 降低
private readonly MIN_CHUNK_DURATION_MS = 800    // 从 1000ms 降低
private readonly MAX_CHUNK_DURATION_MS = 10000  // 从 15000ms 降低

// === 块边界处理 ===
private readonly OVERLAP_AUDIO_MS = 200         // 音频重叠防止词被切断
```

#### 2. 新增状态字段 (约第 58-62 行后)

```typescript
// Non-final 状态
private nonFinalText = ''                       // 当前预览文本
private lastPreviewTime = 0                     // 上次预览时间
private isPreviewProcessing = false             // 预览处理中
private lastPreviewAudioBytes = 0               // 上次预览的音频量 (去抖)

// Final 状态
private finalText: string[] = []                // 已确认文本 (替代 accumulatedText)
private finalTranslation: string[] = []         // 已确认翻译

// 双缓冲
private previewAudioBuffer: Buffer[] = []       // 预览用缓冲 (窗口裁剪)
private pendingAudioBuffer: Buffer[] = []       // 待确认缓冲
private previewAudioBytes = 0
private pendingAudioBytes = 0
private pendingNewAudioBytes = 0
```

#### 3. 修改 `sendAudioChunk()` (第 140-158 行)

```typescript
sendAudioChunk(chunk: Buffer): void {
  if (!this.isActive) return

  // 添加到两个缓冲
  this.pendingAudioBuffer.push(chunk)
  this.previewAudioBuffer.push(chunk)

  // VAD 检测
  const isSpeech = this.vadState.processChunk(chunk)
  if (isSpeech) {
    this.lastSpeechTime = Date.now()
  }

  if (this.pendingAudioBuffer.length === 1) {
    this.bufferStartTime = Date.now()
  }

  // 检查预览触发 (Non-final)
  this.maybeProcessPreview()

  // 检查确认触发 (Final)
  this.maybeProcessFinal()
}
```

#### 4. 新增 `maybeProcessPreview()` 方法

```typescript
private async maybeProcessPreview(): Promise<void> {
  const now = Date.now()
  const timeSinceLastPreview = now - this.lastPreviewTime
  const audioLength = this.getDurationMsFromBytes(this.previewAudioBytes)
  const newAudio = this.getDurationMsFromBytes(
    this.previewAudioBytes - this.lastPreviewAudioBytes
  )

  const shouldPreview =
    !this.isPreviewProcessing &&
    !this.processingChunk &&
    timeSinceLastPreview >= this.PREVIEW_INTERVAL_MS &&
    audioLength >= this.PREVIEW_MIN_AUDIO_MS &&
    newAudio >= this.PREVIEW_MIN_NEW_AUDIO_MS

  if (!shouldPreview) return

  this.isPreviewProcessing = true
  this.lastPreviewTime = now

  try {
    const audioToPreview = this.getPreviewWindowBuffer() // 只取最近 N 秒
    const wavBuffer = this.createWavBuffer(audioToPreview)
    const result = await this.transcribeAudio(wavBuffer)

    if (result.text.trim()) {
      // 去重：移除与 finalText 重叠的部分
      this.nonFinalText = this.deduplicateFromFinal(result.text)
      this.emitPartialResult()
    }
  } catch (error) {
    console.warn('[GroqPreview] Preview failed:', error)
  } finally {
    this.isPreviewProcessing = false
  }
}
```

#### 5. 重命名 `checkAndProcessBuffer()` → `maybeProcessFinal()`

```typescript
private async maybeProcessFinal(): Promise<void> {
  if (this.processingChunk || this.pendingAudioBuffer.length === 0) return

  const bufferDuration = Date.now() - this.bufferStartTime
  const silenceDuration = Date.now() - this.lastSpeechTime

  const shouldFinalize =
    (bufferDuration >= this.MIN_CHUNK_DURATION_MS &&
      silenceDuration >= this.SILENCE_THRESHOLD_MS) ||
    bufferDuration >= this.MAX_CHUNK_DURATION_MS

  if (shouldFinalize) {
    await this.processFinalAudio()
  }
}
```

#### 6. 新增 `processFinalAudio()` 方法 (重构 `processBufferedAudio`)

```typescript
private async processFinalAudio(): Promise<void> {
  this.processingChunk = true

  // 获取待确认音频 (含重叠)
  const audioToProcess = this.getAudioWithOverlap()

  // 清空 pending，保留重叠给下一块
  this.retainPendingOverlap(audioToProcess)

  try {
    const wavBuffer = this.createWavBuffer(audioToProcess)
    const result = await this.transcribeAudio(wavBuffer)

    if (result.text.trim()) {
      // 块边界去重
      const deduped = this.deduplicateChunkBoundary(
        this.finalText.join(' '),
        result.text
      )

      // 追加到 final
      this.finalText.push(deduped)

      // 清空 non-final (已被 final 覆盖)
      this.nonFinalText = ''

      // 重置预览缓冲 (重叠保留)
      this.previewAudioBuffer = [...this.pendingAudioBuffer]

      this.emitPartialResult()

      // 异步翻译 (只翻译 final)
      this.translateFinalAsync(deduped)
    }
  } catch (error) {
    console.error('[GroqFinal] Error:', error)
    this.emit('error', error)
  } finally {
    this.processingChunk = false
  }
}
```

#### 7. 新增块边界去重方法 (字符级 overlap)

```typescript
private deduplicateChunkBoundary(prevFinal: string, newText: string): string {
  const overlap = this.findTextOverlap(prevFinal, newText)
  return overlap > 0 ? newText.slice(overlap) : newText
}

private deduplicateFromFinal(previewText: string): string {
  const overlap = this.findTextOverlap(this.getFinalText(), previewText)
  return overlap > 0 ? previewText.slice(overlap) : previewText
}
```

#### 8. 修改 `emitPartialResult()` (第 389-416 行)

```typescript
private emitPartialResult(): void {
  const finalJoined = this.getFinalText()
  const translationJoined = this.getFinalTranslationText()

  const currentSegment: SpeakerSegment = {
    speaker: 0,
    text: mergeText(finalJoined, this.nonFinalText), // 兼容无空格语言
    translatedText: translationJoined || undefined,
    isFinal: false,
    sentencePairs: this.buildSentencePairs(),
    // 说明：不新增 _meta，前端按需 diff/样式化
  }

  const result: PartialResult = {
    segments: [...this.completedSegments],
    currentSegment,
    combined: currentSegment.text,
    currentSpeaker: 0,
    translationEnabled: this.config.translation?.enabled
  }

  this.emit('partial', result)
}
```

#### 9. 辅助方法

```typescript
private getDurationMsFromBytes(bytes: number): number
private getBytesForMs(ms: number): number
private getPreviewWindowBuffer(): Buffer // 只取最近 PREVIEW_WINDOW_MS
private getTailBuffer(buffers: Buffer[], maxBytes: number): Buffer
private getAudioWithOverlap(): Buffer // 包含上一块最后 200ms 作为重叠
private retainPendingOverlap(processed: Buffer): void
private findTextOverlap(left: string, right: string): number
private mergeText(left: string, right: string): string // 语言感知拼接
```

## UI 更新 (可选增强)

在渲染端可以区分显示 final 和 non-final 文本（通过 diff 或本地缓存判断）：

```tsx
// 预览文本用不同样式 (如灰色/斜体)
<span className="final-text">{finalText}</span>
<span className="preview-text opacity-60">{nonFinalText}</span>
```

## 预期效果

| 指标 | 当前 | 优化后 |
|------|------|--------|
| 首次显示延迟 | ~1600ms | ~400-500ms |
| 翻译延迟 | ~2100ms | ~1000-1500ms |
| 文本稳定性 | 100% | final 100%，preview 可变 |
| API 成本 | 基准 | 约 3-5 倍 |

## 可选：成本优化配置

```typescript
interface GroqStreamingConfig {
  // ... 现有配置 ...

  /** 预览模式: 'aggressive' (400ms), 'balanced' (600ms), 'off' (无预览) */
  previewMode?: 'aggressive' | 'balanced' | 'off'
}
```

## 验证步骤

1. **单元测试**：测试 `deduplicateChunkBoundary()` 的各种边界情况
2. **集成测试**：
   - 启动会议转录，观察 non-final 文本是否快速出现
   - 观察静音后 final 文本是否正确替换 non-final
   - 验证翻译只在 final 后触发
3. **延迟测量**：对比优化前后的首次显示延迟
4. **成本监控**：检查 API 调用次数是否在预期范围内
