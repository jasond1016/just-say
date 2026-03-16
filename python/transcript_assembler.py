import time

from text_processing import (
    accumulate_preview_text,
    apply_text_corrections,
    find_committable_sentence_prefix,
    find_committable_stable_preview_prefix,
    get_common_prefix_for_many,
    guard_preview_reset_with_stable_prefix,
    is_latin_dominant_text,
    merge_streaming_chunk_text,
    merge_text,
    should_flush_sentence_by_boundary,
    should_guard_preview_reset,
    shrink_stable_prefix,
    split_word_timings_by_prefix,
    trim_latin_stable_prefix,
    trim_stable_prefix,
    ENGLISH_PREVIEW_MAX_STABLE_ROLLBACK_CHARS,
    ENGLISH_PREVIEW_STABILITY_WINDOW,
    ENGLISH_PREVIEW_STABLE_TAIL_CHARS,
)


class TranscriptAssembler:
    """Owns transcript semantics for one streaming session."""

    PREVIEW_STABILITY_WINDOW = 3
    PREVIEW_STABLE_TAIL_CHARS = 6
    PREVIEW_MAX_STABLE_ROLLBACK_CHARS = 6

    def __init__(self, normalize_event_text, text_corrections: list[dict]):
        self.normalize_event_text = normalize_event_text
        self.text_corrections = text_corrections
        self.final_text_raw = ""
        self.final_text = ""
        self.pending_sentence_text = ""
        self.pending_final_chunk = ""
        self.pending_final_word_timings = None
        self.current_preview_text = ""
        self.current_preview_stable_text = ""
        self.current_preview_unstable_text = ""
        self.preview_history: list[str] = []
        self.last_preview_text = ""

    def get_visible_text_base(self) -> str:
        return merge_text(self.final_text_raw, self.pending_final_chunk).strip()

    def reset_preview_state(self):
        self.current_preview_text = ""
        self.current_preview_stable_text = ""
        self.current_preview_unstable_text = ""
        self.preview_history = []
        self.last_preview_text = ""

    def build_preview_snapshot(self, text: str) -> tuple[str, str]:
        normalized = self.normalize_event_text(text).strip()
        if not normalized:
            self.preview_history = []
            self.current_preview_stable_text = ""
            self.current_preview_unstable_text = ""
            return "", ""

        self.preview_history.append(normalized)
        stability_window = self.PREVIEW_STABILITY_WINDOW
        stable_tail_chars = self.PREVIEW_STABLE_TAIL_CHARS
        max_stable_rollback_chars = self.PREVIEW_MAX_STABLE_ROLLBACK_CHARS
        if is_latin_dominant_text(normalized):
            stability_window = ENGLISH_PREVIEW_STABILITY_WINDOW
            stable_tail_chars = ENGLISH_PREVIEW_STABLE_TAIL_CHARS
            max_stable_rollback_chars = ENGLISH_PREVIEW_MAX_STABLE_ROLLBACK_CHARS

        if len(self.preview_history) > stability_window:
            self.preview_history = self.preview_history[-stability_window:]

        stable_candidate = trim_stable_prefix(
            get_common_prefix_for_many(self.preview_history),
            stable_tail_chars,
        )
        stable_candidate = trim_latin_stable_prefix(stable_candidate, normalized)
        next_stable = shrink_stable_prefix(
            self.current_preview_stable_text,
            stable_candidate,
            max_stable_rollback_chars,
        )
        if stable_candidate.startswith(next_stable):
            next_stable = stable_candidate

        if normalized.startswith(next_stable):
            unstable = normalized[len(next_stable) :].lstrip()
        else:
            next_stable = ""
            unstable = normalized

        self.current_preview_stable_text = next_stable
        self.current_preview_unstable_text = unstable
        return next_stable, unstable

    def build_interim_event(
        self,
        deduped_preview_text: str,
        *,
        word_timings: list[dict] | None,
    ) -> dict | None:
        accumulated = accumulate_preview_text(self.current_preview_text, deduped_preview_text)
        normalized_accumulated = self.normalize_event_text(accumulated)
        if should_guard_preview_reset(
            self.current_preview_text,
            deduped_preview_text,
            normalized_accumulated,
            self.current_preview_stable_text,
        ):
            normalized_accumulated = self.normalize_event_text(
                guard_preview_reset_with_stable_prefix(
                    self.current_preview_stable_text,
                    deduped_preview_text,
                    self.current_preview_text,
                )
            )
        self.current_preview_text = normalized_accumulated
        self.last_preview_text = deduped_preview_text
        if not normalized_accumulated.strip():
            return None

        stable_text, unstable_text = self.build_preview_snapshot(normalized_accumulated)
        return {
            "type": "interim",
            "text": normalized_accumulated,
            "stableText": stable_text,
            "unstableText": unstable_text,
            "wordTimings": word_timings,
            "ts": int(time.time() * 1000),
        }

    def queue_final_chunk(self, text: str, word_timings: list[dict] | None):
        self.pending_final_chunk = merge_streaming_chunk_text(self.pending_final_chunk, text)
        self.pending_final_word_timings = word_timings

    def consume_sentence_delta(self, sentence_text: str) -> str:
        normalized_sentence = self.normalize_event_text(sentence_text).strip()
        if not normalized_sentence:
            return ""
        pending = self.pending_sentence_text.strip()
        if not pending:
            return ""
        if pending.startswith(normalized_sentence):
            remainder = pending[len(normalized_sentence) :].lstrip()
            self.pending_sentence_text = remainder
            return normalized_sentence
        self.pending_sentence_text = ""
        return normalized_sentence

    def maybe_emit_sentence_event(self, reason: str, *, force: bool = False) -> list[dict]:
        normalized = self.pending_sentence_text.strip()
        if not normalized:
            self.pending_sentence_text = ""
            return []
        endpoint_triggered = reason in {"silence", "max_chunk", "flush", "close"}
        if not force and not should_flush_sentence_by_boundary(normalized, endpoint_triggered):
            return []
        self.pending_sentence_text = ""
        return [{"type": "sentence", "text": normalized, "ts": int(time.time() * 1000)}]

    def commit_pending_final_chunk(self, reason: str) -> list[dict]:
        normalized_raw = self.pending_final_chunk.strip()
        if not normalized_raw:
            self.pending_final_chunk = ""
            self.pending_final_word_timings = None
            self.reset_preview_state()
            return []

        self.pending_final_chunk = ""
        word_timings = self.pending_final_word_timings
        self.pending_final_word_timings = None
        corrected_text, corrected = apply_text_corrections(normalized_raw, self.text_corrections)
        if corrected:
            word_timings = None
        self.reset_preview_state()
        self.final_text_raw = merge_text(self.final_text_raw, normalized_raw)
        self.final_text = merge_text(self.final_text, corrected_text)
        self.pending_sentence_text = merge_text(self.pending_sentence_text, corrected_text).strip()
        events = [
            {
                "type": "final_chunk",
                "text": corrected_text,
                "wordTimings": word_timings,
                "ts": int(time.time() * 1000),
            },
        ]
        events.extend(self.maybe_emit_sentence_event(reason))
        events.append({"type": "endpoint", "reason": reason, "ts": int(time.time() * 1000)})
        return events

    def commit_sentence_prefix_if_possible(self, reason: str) -> tuple[bool, list[dict]]:
        split = find_committable_sentence_prefix(self.pending_final_chunk)
        if not split:
            return False, []

        commit_text, remaining_text = split
        commit_timings, remaining_timings = split_word_timings_by_prefix(
            self.pending_final_word_timings,
            commit_text,
        )
        if commit_timings is None:
            return False, []

        self.pending_final_chunk = commit_text
        self.pending_final_word_timings = commit_timings
        events = self.commit_pending_final_chunk(reason)
        self.pending_final_chunk = remaining_text
        self.pending_final_word_timings = remaining_timings
        return True, events

    def commit_stable_preview_prefix_if_possible(
        self,
        stable_preview: str,
        reason: str,
    ) -> tuple[bool, list[dict]]:
        split = find_committable_stable_preview_prefix(self.pending_final_chunk, stable_preview)
        if not split:
            return False, []

        commit_text, remaining_text = split
        commit_timings, remaining_timings = split_word_timings_by_prefix(
            self.pending_final_word_timings,
            commit_text,
        )
        if commit_timings is None:
            if not is_latin_dominant_text(commit_text):
                return False, []
            remaining_timings = None

        self.pending_final_chunk = commit_text
        self.pending_final_word_timings = commit_timings
        events = self.commit_pending_final_chunk(reason)
        self.pending_final_chunk = remaining_text
        self.pending_final_word_timings = remaining_timings
        return True, events
