# WS 实时转录实现问题分析

基于对完整数据链路的代码审查，以下按严重程度排列实现中存在的问题。

---

## 🔴 关键问题

### 1. Preview 文本处理的双层重复加工

Python 后端和 Electron 前端**同时**在做 preview 文本累积/去重，导致逻辑重叠且难以调试。

| 处理步骤 | Python (`TranscriptAssembler`) | Electron (`StreamingLocalWsRecognizer`) |
|----------|------|---------|
| 文本累积 | `accumulate_preview_text()` | `deduplicatePreviewFromCommitted()` |
| Stable/Unstable 分离 | `build_preview_snapshot()` | `applyPreviewStateFromServer()` |
| 重叠去重 | `find_text_overlap()` + `deduplicate_timed_prefix_from_base()` | `findTextOverlap()` |
| 防回退 | `should_guard_preview_reset()` | — |

**问题**: Python 已经做了完整的 preview 累积和 stable/unstable 分离，但 Electron 收到 `interim` 后又做了一轮去重。两层逻辑可能互相干扰——Python 精心累积的 preview 文本，被 Electron 的 `deduplicatePreviewFromCommitted()` 再次裁剪。

**建议**: 选定一侧作为 single source of truth。由于 Python 端已有完整的 `TranscriptAssembler`，Electron 侧应该**信任**后端的 `interim` 事件内容，仅做最简单的赋值。

---

### 2. `SpeakerSegment` 类型定义散布三处，互不引用

| 位置 | 定义方式 |
|------|---------|
| `streaming-soniox.ts` L52 | `export interface SpeakerSegment` (Main 进程 canonical) |
| `MeetingTranscription.tsx` L24 | `export interface SpeakerSegment` (Renderer 独立重新定义) |
| `preload/index.ts` L88-131 | 内联对象字面量 type (第三份独立定义) |

三个定义的字段并不完全一致。例如 `preload/index.ts` 的 `onMeetingTranscript` callback 里手动列出了所有字段，如果 Main 进程 `SpeakerSegment` 增加字段，preload 和 renderer 不会自动同步。

**建议**: 将 `SpeakerSegment`、`SentencePair`、`WordTiming`、`PartialResult` 等共享类型提取到 `src/shared/transcription-types.ts`，三层都引用。

---

### 3. `combined` 字段: 标记为 Legacy 但仍是主要数据通道

```typescript
// meeting-transcription.ts L446
text: result.combined, // Legacy: combined text for backward compatibility
```

`TranscriptSegment.text` 直接使用 `PartialResult.combined`，但 `combined` 本身被注释为 "Legacy"。同时 Renderer 使用 `segments` + `currentSegment` 来渲染 UI（不依赖 `text` 字段）。

**问题**: 这意味着 `TranscriptSegment.text` (= `combined`) 实际上是死数据——UI 不使用它来渲染，但它仍然通过 IPC 传输，且 profiler 基于它来跟踪延迟变化。

**建议**: 明确 `combined` 的生命周期。如果确认 Renderer 不再需要它，就彻底移除；如果还需要（如 profiling），则取消 "Legacy" 标注，明确其用途。

---

## 🟡 过分复杂 / 职责不清

### 4. `whisper_server.py` 3275 行单文件

一个文件包含了：
- HTTP Server + 路由 (~200行)
- WS Streaming Session + 事件循环 (~400行)
- `TranscriptAssembler` – preview/final/sentence 状态机 (~250行)
- 文本处理工具函数 (~1000行): `accumulate_preview_text`, `merge_with_anchor_alignment`, `should_guard_preview_reset`, 句子边界检测, CJK 规范化等
- ASR 模型管理 (~400行)
- 音频处理 (PCM/WAV 编解码, offline segmentation) (~300行)
- GPU 检测, 命令行解析, 等 (~300行)

**建议**: 按职责拆分:
```
python/
 ├── whisper_server.py     # HTTP server + 入口
 ├── ws_streaming.py       # WebSocketStreamingSession
 ├── transcript_assembler.py  # TranscriptAssembler
 ├── text_processing.py    # 所有文本处理/merge/CJK工具
 ├── asr_engine.py         # 模型加载/推理
 └── audio_utils.py        # PCM/WAV/VAD
```

---

### 5. Final Chunk 延迟提交的条件过于复杂

`should_defer_final_chunk()` 的条件链:

```python
1. silence + 英文 + 弱边界后缀 → defer
2. 非 flush/close + 文本过短/异常 → defer
3. max_chunk + preview 可扩展 → defer (修改 pending_final_chunk!)
4. max_chunk + 词时间戳尾部不稳定 → defer
5. max_chunk + stable preview 覆盖不足 → defer
6. max_chunk + 无稳定句末标点 → defer
```

这六个条件涉及 preview 文本、stable 文本、词时间戳、英文/CJK 判断等多个维度，**有副作用**（条件 3 会修改 `pending_final_chunk`），交互非常复杂。

**建议**: 
- 将 defer 逻辑从单个方法拆分为清晰的策略
- 消除条件内的副作用
- 考虑用配置参数替代硬编码阈值

---

### 6. Renderer 中 `live-transcript.ts` 的 `accumulateInterimText` 完全未使用

`accumulateInterimText()` 实现了与 Python `accumulate_preview_text()` 几乎相同的逻辑，但在会议转录流程中**没有被任何组件调用**（仅被测试文件引用）。

**建议**: 确认是否有其他入口使用它。如果没有，删除以避免未来维护混乱。

---

### 7. `streaming-local.ts` (HTTP chunk 模式) 与 `streaming-local-ws.ts` 大量重复

两个 recognizer 共享相同的 `SpeakerSegment` / `PartialResult` 接口，但各自独立实现了:
- 文本累积 / preview 处理
- Segment 管理
- 翻译流程
- `emitPartialResult()`

**建议**: 提取公共基类或 mixin，或考虑是否还需要保留 HTTP chunk 模式（WS 模式能力更强，且已有回退逻辑）。

---

## 🟠 设计偏差 / 可改进

### 8. `previewText` vs `unstableText` vs `previewUnstableText` 命名混乱

同一概念在不同层级使用了 3 个不同名称:

| 层级 | 字段名 | 含义 |
|------|--------|------|
| Python WS 事件 | `unstableText` | 不稳定尾巴 |
| Electron 内部状态 | `previewUnstableText` | 同上 |
| `SpeakerSegment` 接口 | `previewText` / `unstableText` | 同上 (两个都有!) |

`SpeakerSegment` 同时有 `previewText` 和 `unstableText`，renderer 的 `getInlinePreviewText()` 做了 `segment.previewText || segment.unstableText` 的 fallback。

**建议**: 统一命名。一个字段、一个名字。

---

### 9. App.tsx `mergeSpeakerSegments` 的 index-based merge 脆弱

```typescript
function mergeSpeakerSegments(prevSegments, incoming) {
  for (let i = 0; i < incoming.length; i++) {
    const existing = prevSegments[i]  // 🔴 按 index 匹配
    nextSegments.push({ ...existing, ...incoming[i], ... })
  }
}
```

按数组 index 匹配前后 segments 的前提是：每次 incoming 的 segments 顺序和数量只增不减。如果后端在某些边界条件下重排、合并或删除 segment，整个对齐就会错位。

**建议**: 使用唯一 ID 或 `(speaker, timestamp)` 来匹配 segment，而非位置 index。

---

### 10. Preconnect 机制的超时回退逻辑有 race condition 风险

```typescript
// meeting-transcription.ts
await Promise.race([
  preConnectPromise,
  new Promise(resolve => {
    timeout = setTimeout(() => { timedOut = true; resolve() }, 2500)
  })
])
// 超时后 preConnectPromise 仍在后台运行
void preConnectPromise.catch(err => { ... })
```

如果超时后走了冷启动 path，但旧的 `preConnectPromise` 最终成功，`this.recognizer` 会指向一个过期的 recognizer。虽然有 `if (this.recognizer === recognizer)` 守卫，但 `startTranscription` 中又会重新赋值 `this.recognizer`，这个竞争窗口仍然存在。

---

### 11. IPC 频率无节流

每个 WS 事件 (interim/final_chunk/sentence/endpoint) 都立即触发:
1. `emit('partial', ...)` → `emit('transcript', segment)`
2. `webContents.send('meeting-transcript', segment)`
3. React `setMeetingState()` → re-render

在高频 preview 场景（450ms 间隔），每秒 ~2 次完整的 IPC + state update + re-render 看似可控，但如果 Python 端连续发出 `final_chunk` + `sentence` + `endpoint` = 3 个事件，Electron 会触发 3 次 IPC + 3 次 React re-render。

**建议**: 在 `MeetingTranscriptionManager` 对 `partial` 事件做 debounce/batch，合并同一 tick 内的多个事件为一次 IPC。

---

## 📋 汇总优先级

| # | 问题 | 类型 | 影响 | 推荐优先级 |
|---|------|------|------|-----------|
| 1 | Preview 双层重复加工 | 架构 | 调试困难，文本闪烁根因 | **P0** |
| 2 | `SpeakerSegment` 类型散布 | 维护 | 字段不同步风险 | **P1** |
| 3 | `combined` 字段定位不清 | 设计债务 | 混淆，dead code | P2 |
| 4 | Python 单文件过大 | 维护 | 修改困难 | P2 |
| 5 | final_chunk defer 过度复杂 | 可读性 | 难以理解/调试 | P2 |
| 6 | `accumulateInterimText` 未使用 | 死代码 | 维护混淆 | P1 (直接删) |
| 7 | streaming-local 两套实现 | 重复 | 维护成本翻倍 | P2 |
| 8 | preview/unstable 命名混乱 | 命名 | 认知负担 | P2 |
| 9 | `mergeSpeakerSegments` index-based | 健壮性 | 潜在错位 | P2 |
| 10 | Preconnect race condition | 可靠性 | 理论上可能冲突 | P3 |
| 11 | IPC 无节流 | 性能 | 高频场景多余 re-render | P2 |
