import json
import re
import time

from urllib.parse import parse_qs, urlparse

from websockets.exceptions import ConnectionClosed

from asr_engine import transcribe_audio_payload
from audio_utils import build_wav_from_pcm
from text_processing import (
    cleanup_japanese_asr_text,
    deduplicate_timed_prefix_from_base,
    drop_word_timing_prefix,
    find_text_overlap,
    has_min_stable_preview_coverage,
    has_stable_final_boundary,
    has_unstable_timing_tail,
    is_abnormal_short_final_chunk,
    is_latin_dominant_text,
    is_weak_boundary_suffix,
    parse_positive_int,
    parse_text_corrections,
    try_extend_candidate_with_preview,
    ENGLISH_SILENCE_THRESHOLD_MIN_MS,
    ENGLISH_SILENCE_THRESHOLD_MULTIPLIER,
)
from transcript_assembler import TranscriptAssembler


class WebSocketStreamingSession:
    """WS streaming session for local ASR (based on websockets library)."""

    def __init__(self, websocket, params: dict):
        self.websocket = websocket
        self.params = params
        self.sample_rate = parse_positive_int(params.get("sample_rate", ["16000"])[0], 16000)
        self.preview_interval_ms = parse_positive_int(params.get("preview_interval_ms", ["450"])[0], 450)
        self.preview_min_audio_ms = parse_positive_int(params.get("preview_min_audio_ms", ["350"])[0], 350)
        self.preview_min_new_audio_ms = parse_positive_int(params.get("preview_min_new_audio_ms", ["220"])[0], 220)
        self.preview_window_ms = parse_positive_int(params.get("preview_window_ms", ["2600"])[0], 2600)
        self.min_chunk_ms = parse_positive_int(params.get("min_chunk_ms", ["1000"])[0], 1000)
        self.silence_threshold_ms = parse_positive_int(params.get("silence_ms", ["700"])[0], 700)
        self.max_chunk_ms = parse_positive_int(params.get("max_chunk_ms", ["5000"])[0], 5000)
        self.overlap_ms = parse_positive_int(params.get("overlap_ms", ["520"])[0], 520)
        self.max_chunk_extension_ms = parse_positive_int(
            params.get("max_chunk_extension_ms", ["1400"])[0], 1400
        )

        self.pending_pcm = bytearray()
        self.pending_new_bytes = 0
        self.text_corrections = parse_text_corrections(params.get("text_corrections", [None])[0])
        self.assembler = TranscriptAssembler(self.normalize_event_text, self.text_corrections)
        self.last_preview_at = 0.0
        self.last_preview_audio_bytes = 0
        self.buffer_start_at = 0.0
        self.last_audio_at = time.time()
        self.closed = False

    @property
    def final_text_raw(self):
        return self.assembler.final_text_raw

    @final_text_raw.setter
    def final_text_raw(self, value):
        self.assembler.final_text_raw = value

    @property
    def final_text(self):
        return self.assembler.final_text

    @final_text.setter
    def final_text(self, value):
        self.assembler.final_text = value

    @property
    def pending_final_chunk(self):
        return self.assembler.pending_final_chunk

    @pending_final_chunk.setter
    def pending_final_chunk(self, value):
        self.assembler.pending_final_chunk = value

    @property
    def pending_final_word_timings(self):
        return self.assembler.pending_final_word_timings

    @pending_final_word_timings.setter
    def pending_final_word_timings(self, value):
        self.assembler.pending_final_word_timings = value

    @property
    def current_preview_text(self):
        return self.assembler.current_preview_text

    @current_preview_text.setter
    def current_preview_text(self, value):
        self.assembler.current_preview_text = value

    @property
    def current_preview_stable_text(self):
        return self.assembler.current_preview_stable_text

    @current_preview_stable_text.setter
    def current_preview_stable_text(self, value):
        self.assembler.current_preview_stable_text = value

    @property
    def current_preview_unstable_text(self):
        return self.assembler.current_preview_unstable_text

    @current_preview_unstable_text.setter
    def current_preview_unstable_text(self, value):
        self.assembler.current_preview_unstable_text = value

    @property
    def preview_history(self):
        return self.assembler.preview_history

    @preview_history.setter
    def preview_history(self, value):
        self.assembler.preview_history = value

    @property
    def last_preview_text(self):
        return self.assembler.last_preview_text

    @last_preview_text.setter
    def last_preview_text(self, value):
        self.assembler.last_preview_text = value

    def normalize_event_text(self, text: str) -> str:
        normalized = text or ""
        language = (self.params.get("language", [""])[0] or "").lower()
        if language.startswith("ja") or re.search(r"[\u3040-\u30ff\u3400-\u9fff]", normalized):
            normalized = cleanup_japanese_asr_text(normalized)
        return normalized

    def is_english_session(self) -> bool:
        language = (self.params.get("language", [""])[0] or "").lower()
        return language.startswith("en")

    def get_effective_silence_threshold_ms(self) -> int:
        if not self.is_english_session():
            return self.silence_threshold_ms
        return max(
            ENGLISH_SILENCE_THRESHOLD_MIN_MS,
            int(self.silence_threshold_ms * ENGLISH_SILENCE_THRESHOLD_MULTIPLIER),
        )

    def bytes_for_ms(self, ms: int) -> int:
        if ms <= 0:
            return 0
        return int((self.sample_rate * 2 * ms) / 1000)

    def duration_ms_from_bytes(self, size: int) -> float:
        if size <= 0:
            return 0.0
        return (size / 2) / self.sample_rate * 1000.0

    def get_preview_pcm(self) -> bytes:
        if not self.pending_pcm:
            return b""
        max_bytes = self.bytes_for_ms(self.preview_window_ms)
        if max_bytes <= 0 or len(self.pending_pcm) <= max_bytes:
            return bytes(self.pending_pcm)
        return bytes(self.pending_pcm[-max_bytes:])

    def retain_overlap(self):
        if not self.pending_pcm:
            return
        overlap_bytes = self.bytes_for_ms(self.overlap_ms)
        if overlap_bytes <= 0:
            self.pending_pcm = bytearray()
            return
        if len(self.pending_pcm) > overlap_bytes:
            self.pending_pcm = bytearray(self.pending_pcm[-overlap_bytes:])

    def get_visible_text_base(self) -> str:
        return self.assembler.get_visible_text_base()

    def reset_preview_state(self):
        self.assembler.reset_preview_state()

    def emit_json(self, payload: dict):
        text = payload.get("text")
        if isinstance(text, str) and payload.get("type") in {"interim", "final_chunk", "sentence", "final"}:
            payload = {**payload, "text": self.normalize_event_text(text)}
        self.websocket.send(json.dumps(payload, ensure_ascii=False))

    def transcribe_pcm(self, pcm_data: bytes) -> dict:
        wav_data = build_wav_from_pcm(pcm_data, self.sample_rate)
        return transcribe_audio_payload(wav_data, self.params)

    def emit_preview(self):
        if self.closed:
            return
        now = time.time()
        if (now - self.last_preview_at) * 1000 < self.preview_interval_ms:
            return
        if self.duration_ms_from_bytes(len(self.pending_pcm)) < self.preview_min_audio_ms:
            return
        new_audio_ms = self.duration_ms_from_bytes(len(self.pending_pcm) - self.last_preview_audio_bytes)
        if new_audio_ms < self.preview_min_new_audio_ms:
            return

        result = self.transcribe_pcm(self.get_preview_pcm())
        self.last_preview_at = now
        self.last_preview_audio_bytes = len(self.pending_pcm)
        if not result.get("success"):
            self.emit_json({"type": "error", "message": result.get("error", "stream_preview_failed")})
            return

        preview_text = (result.get("text") or "").strip()
        if not preview_text:
            return
        preview_word_timings = result.get("word_timings")
        overlap = find_text_overlap(self.get_visible_text_base(), preview_text)
        if overlap > 0:
            deduped = preview_text[overlap:]
            preview_word_timings = drop_word_timing_prefix(preview_word_timings, preview_text[:overlap])
        else:
            deduped, preview_word_timings = deduplicate_timed_prefix_from_base(
                self.get_visible_text_base(),
                preview_text,
                preview_word_timings,
            )
        payload = self.assembler.build_interim_event(
            deduped,
            word_timings=preview_word_timings,
        )
        if not payload:
            return
        self.emit_json(payload)

    def commit_pending_final_chunk(self, reason: str):
        for event in self.assembler.commit_pending_final_chunk(reason):
            self.emit_json(event)

    def commit_sentence_prefix_if_possible(self, reason: str) -> bool:
        committed, events = self.assembler.commit_sentence_prefix_if_possible(reason)
        for event in events:
            self.emit_json(event)
        return committed

    def commit_stable_preview_prefix_if_possible(self, reason: str) -> bool:
        committed, events = self.assembler.commit_stable_preview_prefix_if_possible(
            self.current_preview_stable_text,
            reason,
        )
        for event in events:
            self.emit_json(event)
        return committed

    def should_defer_final_chunk(
        self, candidate: str, reason: str, word_timings: list[dict] | None = None
    ) -> bool:
        return False
        normalized = candidate.strip()
        if not normalized:
            return False
        if reason == "silence" and is_latin_dominant_text(normalized) and is_weak_boundary_suffix(normalized):
            return True
        if reason not in {"flush", "close"} and is_abnormal_short_final_chunk(normalized, word_timings):
            return True
        if reason != "max_chunk":
            return False
        preview_extension = try_extend_candidate_with_preview(normalized, self.last_preview_text)
        if preview_extension:
            self.pending_final_chunk = preview_extension
            return True
        pending_audio_ms = self.duration_ms_from_bytes(len(self.pending_pcm))
        if has_unstable_timing_tail(
            word_timings,
            pending_audio_ms,
            self.current_preview_unstable_text,
        ):
            return True
        if not has_min_stable_preview_coverage(
            normalized,
            self.current_preview_stable_text,
            self.current_preview_unstable_text,
        ):
            return True
        return not has_stable_final_boundary(normalized)

    def emit_final(self, reason: str):
        if self.closed or self.pending_new_bytes <= 0:
            return
        result = self.transcribe_pcm(bytes(self.pending_pcm))
        if not result.get("success"):
            self.emit_json({"type": "error", "message": result.get("error", "stream_final_failed")})
            return

        final_chunk = (result.get("text") or "").strip()
        if not final_chunk:
            self.pending_new_bytes = 0
            self.reset_preview_state()
            self.retain_overlap()
            return

        final_word_timings = result.get("word_timings")
        overlap = find_text_overlap(self.get_visible_text_base(), final_chunk)
        if overlap > 0:
            deduped = final_chunk[overlap:]
            final_word_timings = drop_word_timing_prefix(final_word_timings, final_chunk[:overlap])
        else:
            deduped, final_word_timings = deduplicate_timed_prefix_from_base(
                self.get_visible_text_base(),
                final_chunk,
                final_word_timings,
            )
        if deduped.strip():
            self.assembler.queue_final_chunk(deduped, final_word_timings)
            committed_prefix = False
            if reason in {"max_chunk", "silence"}:
                committed_prefix = self.commit_sentence_prefix_if_possible(reason)
            if not committed_prefix and reason == "max_chunk" and self.is_english_session():
                committed_prefix = self.commit_stable_preview_prefix_if_possible(reason)
            if committed_prefix:
                if self.pending_final_chunk and not self.should_defer_final_chunk(
                    self.pending_final_chunk,
                    reason,
                    self.pending_final_word_timings,
                ):
                    self.commit_pending_final_chunk(reason)
            elif not self.should_defer_final_chunk(
                self.pending_final_chunk,
                reason,
                self.pending_final_word_timings,
            ):
                self.commit_pending_final_chunk(reason)

        self.pending_new_bytes = 0
        self.reset_preview_state()
        self.retain_overlap()
        self.buffer_start_at = 0.0
        self.last_preview_audio_bytes = len(self.pending_pcm)

    def maybe_emit_final_by_timing(self):
        if self.pending_new_bytes <= 0 or self.buffer_start_at <= 0:
            return
        now = time.time()
        pending_ms = self.duration_ms_from_bytes(self.pending_new_bytes)
        silence_ms = (now - self.last_audio_at) * 1000
        if pending_ms >= self.max_chunk_ms:
            if pending_ms < self.max_chunk_ms + self.max_chunk_extension_ms:
                preview_text = (self.last_preview_text or "").strip()
                if preview_text and not has_stable_final_boundary(preview_text):
                    return
            self.emit_final("max_chunk")
            return
        if pending_ms >= self.min_chunk_ms and silence_ms >= self.get_effective_silence_threshold_ms():
            self.emit_final("silence")

    def run(self):
        self.emit_json({"type": "ready", "streaming": True, "ts": int(time.time() * 1000)})
        while not self.closed:
            try:
                message = self.websocket.recv(timeout=0.2)
                if isinstance(message, str):
                    message = message.strip()
                    if not message:
                        continue
                    data = json.loads(message)
                    msg_type = data.get("type")
                    if msg_type == "flush":
                        self.emit_final("flush")
                        self.commit_pending_final_chunk("flush")
                        for event in self.assembler.maybe_emit_sentence_event("flush", force=True):
                            self.emit_json(event)
                        self.emit_json(
                            {
                                "type": "final",
                                "text": self.final_text,
                                "wordTimings": None,
                                "ts": int(time.time() * 1000),
                            }
                        )
                    elif msg_type == "close":
                        self.emit_final("close")
                        self.commit_pending_final_chunk("close")
                        for event in self.assembler.maybe_emit_sentence_event("close", force=True):
                            self.emit_json(event)
                        self.closed = True
                        break
                    elif msg_type == "ping":
                        self.emit_json({"type": "pong", "ts": int(time.time() * 1000)})
                    continue
                if isinstance(message, bytes):  # binary audio chunk (PCM16LE mono)
                    if message:
                        self.pending_pcm.extend(message)
                        self.pending_new_bytes += len(message)
                        self.last_audio_at = time.time()
                        if self.buffer_start_at <= 0:
                            self.buffer_start_at = self.last_audio_at
            except TimeoutError:
                pass
            except ConnectionClosed:
                self.closed = True
                break
            except json.JSONDecodeError:
                self.emit_json({"type": "error", "message": "invalid_json"})
            except Exception as exc:
                self.emit_json({"type": "error", "message": str(exc)})
                self.closed = True
                break

            try:
                self.emit_preview()
                self.maybe_emit_final_by_timing()
            except Exception as exc:
                self.emit_json({"type": "error", "message": str(exc)})
                self.closed = True
                break


def handle_websocket_connection(websocket):
    try:
        raw_path = websocket.request.path
    except Exception:
        raw_path = "/stream"

    parsed = urlparse(raw_path)
    if parsed.path != "/stream":
        websocket.send(json.dumps({"type": "error", "message": "invalid_stream_path"}))
        websocket.close()
        return

    params = parse_qs(parsed.query)
    session = WebSocketStreamingSession(websocket, params)
    session.run()
