# Meeting Benchmark（固定音频回归）

## 目标

用同一段已知文本的音频反复压测会议转录，稳定观察：

- 中间流式输出是否自然（不把一句话切得过碎）
- 最终识别结果与参考文本的偏差（CER）
- 首次可见文本延迟和整体稳定性

## 1. 准备输入

1. 准备 16-bit PCM WAV 音频（建议单声道，16kHz）。
2. 准备参考文本 JSON，可从示例复制：
   - `tools/meeting-bench.ref.example.json`
3. 关键字段：
   - `expectedText`: 最终对比基准
   - `cerThreshold`: 通过阈值（例如 0.15）
   - `wsParams`: 本次实验固定的 WS 参数（模型、分段参数等）

## 2. 启动服务端

示例：

```powershell
./run_whisper_server.sh --host 0.0.0.0 --port 8765 --engine sensevoice --sensevoice-model-id FunAudioLLM/SenseVoiceSmall --sensevoice-use-itn true --device cuda --compute-type float16 --lock-model --lock-device-compute
```

说明：

- HTTP 是 `8765`，WS 是 `8766`（`/stream`）。
- bench 脚本默认连 `ws://127.0.0.1:8766/stream`。

## 3. 运行 benchmark

```powershell
pnpm meeting:bench -- --audio .\fixtures\case01.wav --ref .\fixtures\case01.ref.json --runs 5 --speed 1
```

可用参数：

- `--runs`: 重复次数（默认 5）
- `--chunk-ms`: 每片音频长度（默认 256）
- `--speed`: 回放倍速（默认 1）
- `--flush-wait-ms`: 发送 flush 后等待时间（默认 900）
- `--ws-url`: 自定义 WS 地址
- 也可覆盖 WS query：`--language`、`--sample-rate`、`--min-chunk-ms` 等（详见 `tools/meeting-bench.mjs` 的 usage）

## 4. 输出结果

输出目录默认：

- `out/meeting-bench/<case>-<timestamp>/`

主要文件：

- `run-XX.events.jsonl`: 每条中间事件（`interim` / `final_chunk` / `endpoint` / `final`）
- `run-XX.final.txt`: 本次最终文本
- `run-XX.summary.json`: 本次完整统计（含 CER、首次可见延迟、事件计数）
- `report.json`: 多次 run 聚合统计
- `report.md`: 可读版报告

## 5. 如何判定效果

建议关注三组指标：

1. 最终准确性

- `CER avg/p50/p95`
- `CER pass rate`（若设置了 `cerThreshold`）
- `Exact match rate (normalized)`

2. 流式可读性

- `run-XX.events.jsonl` 中 `interim` 和 `final_chunk` 的节奏
- 是否出现明显“半句被截断后长期不修复”

3. 延迟与稳定性

- `firstVisibleMs`（首字出现）
- `durationMs` 和多 run 波动

## 6. 推荐实验流程

1. 固定音频、固定参考文本、固定模型。
2. 每次只改 1 组参数（例如 `min_chunk_ms/silence_ms/holdMs`）。
3. 每组至少跑 5 次，看 `p50/p95` 而不是单次。
4. 记录最佳参数集并沉淀成 profile（中/日/英可分开）。
