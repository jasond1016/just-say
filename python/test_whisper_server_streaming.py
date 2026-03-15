import json
import unittest
from array import array
from unittest.mock import patch

from whisper_server import (
    TranscriptAssembler,
    WebSocketStreamingSession,
    apply_text_corrections,
    accumulate_preview_text,
    build_wav_from_pcm,
    deduplicate_timed_prefix_from_base,
    detect_offline_segments,
    guard_preview_reset_with_stable_prefix,
    has_unstable_timing_tail,
    has_min_stable_preview_coverage,
    is_abnormal_short_final_chunk,
    is_weak_boundary_suffix,
    should_guard_preview_reset,
    should_flush_sentence_by_boundary,
    trim_latin_stable_prefix,
    transcribe_audio_offline_segmented,
)


class DummyWebSocket:
    def __init__(self):
        self.messages = []

    def send(self, payload: str):
        self.messages.append(json.loads(payload))


class AccumulatePreviewTextTests(unittest.TestCase):
    def test_keeps_cumulative_preview_when_window_moves_forward(self):
        first = accumulate_preview_text("", "今日は日本の夏によく食べるもの。")
        second = accumulate_preview_text(first, "日本の夏によく食べるものをご紹。")
        third = accumulate_preview_text(second, "食べるものをご紹介します。")

        self.assertEqual(first, "今日は日本の夏によく食べるもの。")
        self.assertEqual(second, "今日は日本の夏によく食べるものをご紹。")
        self.assertEqual(third, "今日は日本の夏によく食べるものをご紹介します。")

    def test_replaces_unrelated_short_preview(self):
        result = accumulate_preview_text("元気ですか？", "今日は日本の夏。")

        self.assertEqual(result, "今日は日本の夏。")

    def test_realigns_when_incoming_preview_contains_noisy_prefix(self):
        result = accumulate_preview_text(
            "今日は日本の夏によく食べるものをご紹。",
            "ほんの夏によく食べるものをご紹介しま。",
        )

        self.assertEqual(result, "今日は日本の夏によく食べるものをご紹介しま。")

    def test_keeps_spacing_when_incoming_preview_restarts_mid_sentence(self):
        result = accumulate_preview_text(
            "Hello and welcome to Co Recursive.",
            "And welcome to Co recursive, I'm Adam Gordon.",
        )

        self.assertEqual(result, "Hello and welcome to Co recursive, I'm Adam Gordon.")


class WordTimingHeuristicsTests(unittest.TestCase):
    def test_apply_text_corrections_rewrites_aliases_to_targets(self):
        corrected, changed = apply_text_corrections(
            "私はう事キん時が食べたいです。",
            [{"target": "宇治金時", "aliases": ["う事キん時", "無事キン時"]}],
        )

        self.assertTrue(changed)
        self.assertEqual(corrected, "私は宇治金時が食べたいです。")

    def test_deduplicate_timed_prefix_from_base_trims_repeated_overlap(self):
        text, timings = deduplicate_timed_prefix_from_base(
            "シロップも売っています",
            "います赤福氷も人気です。",
            [
                {"text": "います", "startMs": 20, "endMs": 180},
                {"text": "赤福", "startMs": 180, "endMs": 420},
                {"text": "氷も", "startMs": 420, "endMs": 620},
                {"text": "人気です。", "startMs": 620, "endMs": 980},
            ],
        )

        self.assertEqual(text, "赤福氷も人気です。")
        self.assertEqual([item["text"] for item in timings], ["赤福", "氷も", "人気です。"])

    def test_has_unstable_timing_tail_detects_short_tail_near_audio_end(self):
        self.assertTrue(
            has_unstable_timing_tail(
                [
                    {"text": "売っ", "startMs": 4300, "endMs": 4490},
                    {"text": "ています", "startMs": 4490, "endMs": 4860},
                ],
                5000,
                "売っています",
            )
        )

    def test_has_unstable_timing_tail_ignores_stable_gap_before_end(self):
        self.assertFalse(
            has_unstable_timing_tail(
                [
                    {"text": "赤福", "startMs": 3600, "endMs": 3900},
                    {"text": "氷です。", "startMs": 3900, "endMs": 4200},
                ],
                5000,
                "氷です",
            )
        )

    def test_has_min_stable_preview_coverage_requires_short_unstable_tail(self):
        self.assertFalse(
            has_min_stable_preview_coverage(
                "プはイチゴやメロンが定番です。",
                "部はイチゴやメロ",
                "ンが定番です。",
            )
        )
        self.assertTrue(
            has_min_stable_preview_coverage(
                "かき氷を売っています。",
                "かき氷を売ってい",
                "ます。",
            )
        )

    def test_is_abnormal_short_final_chunk_flags_short_sentence_fragment(self):
        self.assertTrue(is_abnormal_short_final_chunk("う。", [{"text": "う", "startMs": 0, "endMs": 750}]))
        self.assertFalse(
            is_abnormal_short_final_chunk(
                "人気です。",
                [
                    {"text": "人気", "startMs": 0, "endMs": 320},
                    {"text": "です。", "startMs": 320, "endMs": 760},
                ],
            )
        )

    def test_should_flush_sentence_by_boundary_handles_english_weak_suffixes(self):
        self.assertFalse(should_flush_sentence_by_boundary("It was sort of", True))
        self.assertTrue(should_flush_sentence_by_boundary("It was absolutely great.", True))

    def test_trim_latin_stable_prefix_removes_partial_word_suffix(self):
        trimmed = trim_latin_stable_prefix(
            "Recursive, I'm Adam Go",
            "Recursive, I'm Adam Gordonord Bell.",
        )

        self.assertEqual(trimmed, "Recursive, I'm Adam")

    def test_is_weak_boundary_suffix_handles_english_pronoun_tail(self):
        self.assertTrue(is_weak_boundary_suffix("It's such a crazy story you."))

    def test_should_guard_preview_reset_for_short_unrelated_english_tail(self):
        self.assertTrue(
            should_guard_preview_reset(
                "5ive minutes of noodling around with it, it was obvious to me that this was light.",
                "years ahead.",
                "years ahead.",
                "5ive minutes of noodling around with it, it was obvious to me that this was",
            )
        )

    def test_guard_preview_reset_with_stable_prefix_keeps_stable_context(self):
        guarded = guard_preview_reset_with_stable_prefix(
            "5ive minutes of noodling around with it, it was obvious to me that this was",
            "years ahead.",
        )

        self.assertEqual(
            guarded,
            "5ive minutes of noodling around with it, it was obvious to me that this was years ahead.",
        )


class OfflineSegmentedTranscribeTests(unittest.TestCase):
    def test_detect_offline_segments_splits_two_speech_regions(self):
        samples = array("h", [0] * 400)
        samples.extend([1400] * 700)
        samples.extend([0] * 500)
        samples.extend([1800] * 800)
        pcm = samples.tobytes()

        segments = detect_offline_segments(
            pcm,
            1000,
            silence_ms=240,
            min_speech_rms=200,
            analysis_window_ms=40,
            padding_ms=0,
            max_segment_ms=4000,
            overlap_ms=0,
        )

        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[0], (400, 1120))
        self.assertEqual(segments[1], (1600, 2400))

    def test_transcribe_audio_offline_segmented_merges_overlap(self):
        samples = array("h", [0] * 400)
        samples.extend([1600] * 700)
        samples.extend([0] * 500)
        samples.extend([1800] * 800)
        wav_audio = build_wav_from_pcm(samples.tobytes(), 1000)

        with patch(
            "whisper_server.transcribe_audio_bytes",
            side_effect=[
                {"text": "Hello and welcome to", "language": "en", "word_timings": None},
                {"text": "welcome to Co recursive", "language": "en", "word_timings": None},
            ],
        ):
            result = transcribe_audio_offline_segmented(
                None,
                engine="sensevoice",
                audio_data=wav_audio,
                language="en",
                sensevoice_use_itn=True,
                output_word_timestamps=False,
                silence_ms=240,
                min_speech_rms=200,
                analysis_window_ms=40,
                padding_ms=0,
                max_segment_ms=4000,
                overlap_ms=0,
            )

        self.assertTrue(result["success"])
        self.assertEqual(result["transcription_profile"], "offline_segmented")
        self.assertEqual(result["text"], "Hello and welcome to Co recursive")
        self.assertEqual(len(result["offline_segments"]), 2)


class StreamingSessionPreviewTests(unittest.TestCase):
    def test_emit_preview_sends_accumulated_current_chunk_text(self):
        websocket = DummyWebSocket()
        session = WebSocketStreamingSession(websocket, {})
        preview_pcm = b"\x00\x00" * 32000
        session.pending_pcm = bytearray(preview_pcm)
        session.buffer_start_at = 1.0

        responses = iter(
            [
                {"success": True, "text": "今日は日本の夏によく食べるもの。"},
                {"success": True, "text": "日本の夏によく食べるものをご紹。"},
            ]
        )
        session.transcribe_pcm = lambda _pcm: next(responses)

        session.emit_preview()
        session.pending_pcm.extend(b"\x00\x00" * 8000)
        session.last_preview_at = 0.0
        session.emit_preview()

        interim_messages = [message for message in websocket.messages if message["type"] == "interim"]
        self.assertEqual(len(interim_messages), 2)
        self.assertEqual(interim_messages[0]["text"], "今日は日本の夏によく食べるもの。")
        self.assertEqual(interim_messages[1]["text"], "今日は日本の夏によく食べるものをご紹。")

    def test_emit_preview_includes_stable_and_unstable_text(self):
        websocket = DummyWebSocket()
        session = WebSocketStreamingSession(websocket, {})
        preview_pcm = b"\x00\x00" * 32000
        session.pending_pcm = bytearray(preview_pcm)
        session.buffer_start_at = 1.0

        responses = iter(
            [
                {"success": True, "text": "今日は日本の夏によく食べるもの。"},
                {"success": True, "text": "今日は日本の夏によく食べるものをご紹。"},
                {"success": True, "text": "今日は日本の夏によく食べるものをご紹介しま。"},
            ]
        )
        session.transcribe_pcm = lambda _pcm: next(responses)

        session.emit_preview()
        session.pending_pcm.extend(b"\x00\x00" * 4000)
        session.last_preview_at = 0.0
        session.emit_preview()
        session.pending_pcm.extend(b"\x00\x00" * 4000)
        session.last_preview_at = 0.0
        session.emit_preview()

        interim_messages = [message for message in websocket.messages if message["type"] == "interim"]
        self.assertTrue(interim_messages[-1]["stableText"])
        self.assertEqual(
            interim_messages[-1]["stableText"] + interim_messages[-1]["unstableText"],
            interim_messages[-1]["text"],
        )
        self.assertTrue(interim_messages[-1]["unstableText"])

    def test_emit_preview_fields_cover_current_uncommitted_region_only(self):
        websocket = DummyWebSocket()
        session = WebSocketStreamingSession(websocket, {})
        preview_pcm = b"\x00\x00" * 32000
        session.pending_pcm = bytearray(preview_pcm)
        session.buffer_start_at = 1.0
        session.final_text_raw = "Hello and welcome."
        session.final_text = "Hello and welcome."
        session.transcribe_pcm = lambda _pcm: {
            "success": True,
            "text": "I'm Adam Gordon.",
        }

        session.emit_preview()

        interim_messages = [message for message in websocket.messages if message["type"] == "interim"]
        self.assertEqual(len(interim_messages), 1)
        self.assertEqual(interim_messages[0]["text"], "I'm Adam Gordon.")
        self.assertEqual(interim_messages[0]["stableText"], "I'm Adam")
        self.assertTrue(interim_messages[0]["unstableText"])
        self.assertNotIn("visibleText", interim_messages[0])

    def test_emit_preview_trims_english_stable_text_to_word_boundary(self):
        websocket = DummyWebSocket()
        session = WebSocketStreamingSession(websocket, {"language": ["en"]})
        preview_pcm = b"\x00\x00" * 32000
        session.pending_pcm = bytearray(preview_pcm)
        session.buffer_start_at = 1.0

        responses = iter(
            [
                {"success": True, "text": "Recursive, I'm Adam Gordonord Bell."},
                {"success": True, "text": "Recursive, I'm Adam Gordonor Bell."},
                {"success": True, "text": "Recursive, I'm Adam Gordonord Bell years ago."},
                {"success": True, "text": "Recursive, I'm Adam Gordonord Bell years ago."},
            ]
        )
        session.transcribe_pcm = lambda _pcm: next(responses)

        for _ in range(4):
            session.emit_preview()
            session.pending_pcm.extend(b"\x00\x00" * 4000)
            session.last_preview_at = 0.0

        interim_messages = [message for message in websocket.messages if message["type"] == "interim"]
        self.assertEqual(interim_messages[-1]["stableText"], "Recursive, I'm Adam")
        self.assertFalse(interim_messages[-1]["stableText"].endswith("Go"))

    def test_emit_preview_guards_abrupt_english_reset_with_stable_prefix(self):
        assembler = TranscriptAssembler(lambda text: text, [])
        assembler.current_preview_text = (
            "5ive minutes of noodling around with it, it was obvious to me that this was light."
        )
        assembler.current_preview_stable_text = (
            "5ive minutes of noodling around with it, it was obvious to me that this was"
        )
        assembler.current_preview_unstable_text = "light."

        event = assembler.build_interim_event("years ahead.", word_timings=None)

        self.assertIsNotNone(event)
        self.assertEqual(
            event["text"],
            "5ive minutes of noodling around with it, it was obvious to me that this was years ahead.",
        )

    def test_emit_final_defers_max_chunk_without_preview_stability_evidence(self):
        websocket = DummyWebSocket()
        session = WebSocketStreamingSession(websocket, {})
        max_chunk_pcm = b"\x00\x00" * (session.bytes_for_ms(5000) // 2)
        session.pending_pcm = bytearray(max_chunk_pcm)
        session.pending_new_bytes = len(max_chunk_pcm)
        session.buffer_start_at = 1.0
        session.transcribe_pcm = lambda _pcm: {
            "success": True,
            "text": "Hello world.",
            "word_timings": [
                {"text": "Hello", "startMs": 0, "endMs": 300},
                {"text": "world", "startMs": 300, "endMs": 600},
                {"text": ".", "startMs": 600, "endMs": 720},
            ],
        }

        session.emit_final("max_chunk")

        final_chunks = [message for message in websocket.messages if message["type"] == "final_chunk"]
        self.assertEqual(final_chunks, [])
        self.assertEqual(session.pending_final_chunk, "Hello world.")

    def test_emit_final_commits_on_silence_without_stable_boundary(self):
        websocket = DummyWebSocket()
        session = WebSocketStreamingSession(websocket, {})
        pcm = b"\x00\x00" * (session.bytes_for_ms(2200) // 2)
        session.pending_pcm = bytearray(pcm)
        session.pending_new_bytes = len(pcm)
        session.buffer_start_at = 1.0
        session.current_preview_stable_text = "Hello and welcome to"
        session.current_preview_unstable_text = " Co recursive"
        session.last_preview_text = "Hello and welcome to Co recursive"
        session.transcribe_pcm = lambda _pcm: {
            "success": True,
            "text": "Hello and welcome to Co recursive",
            "word_timings": [
                {"text": "Hello", "startMs": 0, "endMs": 220},
                {"text": "and", "startMs": 220, "endMs": 390},
                {"text": "welcome", "startMs": 390, "endMs": 720},
                {"text": "to", "startMs": 720, "endMs": 900},
                {"text": "Co", "startMs": 900, "endMs": 1140},
                {"text": "recursive", "startMs": 1140, "endMs": 1500},
            ],
        }

        session.emit_final("silence")

        final_chunks = [message for message in websocket.messages if message["type"] == "final_chunk"]
        self.assertEqual(len(final_chunks), 1)
        self.assertEqual(final_chunks[0]["text"], "Hello and welcome to Co recursive")

    def test_emit_final_defers_english_silence_chunk_with_weak_suffix(self):
        websocket = DummyWebSocket()
        session = WebSocketStreamingSession(websocket, {"language": ["en"]})
        pcm = b"\x00\x00" * (session.bytes_for_ms(2400) // 2)
        session.pending_pcm = bytearray(pcm)
        session.pending_new_bytes = len(pcm)
        session.buffer_start_at = 1.0
        session.transcribe_pcm = lambda _pcm: {
            "success": True,
            "text": "It's such a crazy story you.",
            "word_timings": None,
        }

        session.emit_final("silence")

        final_chunks = [message for message in websocket.messages if message["type"] == "final_chunk"]
        self.assertEqual(final_chunks, [])
        self.assertEqual(session.pending_final_chunk, "It's such a crazy story you.")

    def test_emit_preview_skips_empty_text_after_cleanup(self):
        websocket = DummyWebSocket()
        session = WebSocketStreamingSession(websocket, {"language": ["ja"]})
        preview_pcm = b"\x00\x00" * 32000
        session.pending_pcm = bytearray(preview_pcm)
        session.buffer_start_at = 1.0
        session.transcribe_pcm = lambda _pcm: {"success": True, "text": "🎼"}

        session.emit_preview()

        interim_messages = [message for message in websocket.messages if message["type"] == "interim"]
        self.assertEqual(interim_messages, [])

    def test_emit_final_trims_timed_prefix_duplicate_from_visible_base(self):
        websocket = DummyWebSocket()
        session = WebSocketStreamingSession(
            websocket,
            {
                "text_corrections": [
                    '{"entries":[{"target":"赤福氷","aliases":["赤福氷"]}]}'
                ]
            },
        )
        session.final_text = "シロップも売っています"
        session.final_text_raw = "シロップも売っています"
        final_pcm = b"\x00\x00" * (session.bytes_for_ms(2200) // 2)
        session.pending_pcm = bytearray(final_pcm)
        session.pending_new_bytes = len(final_pcm)
        session.buffer_start_at = 1.0
        session.transcribe_pcm = lambda _pcm: {
            "success": True,
            "text": "います赤福氷も人気です。",
            "word_timings": [
                {"text": "います", "startMs": 20, "endMs": 180},
                {"text": "赤福", "startMs": 180, "endMs": 420},
                {"text": "氷も", "startMs": 420, "endMs": 620},
                {"text": "人気です。", "startMs": 620, "endMs": 980},
            ],
        }

        session.emit_final("silence")

        final_chunks = [message for message in websocket.messages if message["type"] == "final_chunk"]
        self.assertEqual(len(final_chunks), 1)
        self.assertEqual(final_chunks[0]["text"], "赤福氷も人気です。")
        self.assertEqual(
            [item["text"] for item in final_chunks[0]["wordTimings"]],
            ["赤福", "氷も", "人気です。"],
        )
        self.assertEqual(session.final_text_raw, "シロップも売っています赤福氷も人気です。")

    def test_emit_final_defers_max_chunk_when_timing_tail_is_unstable(self):
        websocket = DummyWebSocket()
        session = WebSocketStreamingSession(websocket, {})
        max_chunk_pcm = b"\x00\x00" * (session.bytes_for_ms(5000) // 2)
        session.pending_pcm = bytearray(max_chunk_pcm)
        session.pending_new_bytes = len(max_chunk_pcm)
        session.buffer_start_at = 1.0
        session.current_preview_unstable_text = "売っています"
        session.transcribe_pcm = lambda _pcm: {
            "success": True,
            "text": "かき氷を売っています。",
            "word_timings": [
                {"text": "かき氷を", "startMs": 3600, "endMs": 4150},
                {"text": "売っ", "startMs": 4300, "endMs": 4490},
                {"text": "ています", "startMs": 4490, "endMs": 4860},
            ],
        }

        session.emit_final("max_chunk")

        final_chunks = [message for message in websocket.messages if message["type"] == "final_chunk"]
        self.assertEqual(final_chunks, [])
        self.assertEqual(session.pending_final_chunk, "かき氷を売っています。")

    def test_emit_final_commits_sentence_prefix_and_keeps_unfinished_tail(self):
        websocket = DummyWebSocket()
        session = WebSocketStreamingSession(websocket, {})
        max_chunk_pcm = b"\x00\x00" * (session.bytes_for_ms(5000) // 2)
        session.pending_pcm = bytearray(max_chunk_pcm)
        session.pending_new_bytes = len(max_chunk_pcm)
        session.buffer_start_at = 1.0
        session.transcribe_pcm = lambda _pcm: {
            "success": True,
            "text": "Hello world. This is still going",
            "word_timings": [
                {"text": "Hello", "startMs": 0, "endMs": 300},
                {"text": "world", "startMs": 300, "endMs": 600},
                {"text": ".", "startMs": 600, "endMs": 720},
                {"text": "This", "startMs": 720, "endMs": 960},
                {"text": "is", "startMs": 960, "endMs": 1110},
                {"text": "still", "startMs": 1110, "endMs": 1380},
                {"text": "going", "startMs": 1380, "endMs": 1620},
            ],
        }

        session.emit_final("max_chunk")

        final_chunks = [message for message in websocket.messages if message["type"] == "final_chunk"]
        self.assertEqual(len(final_chunks), 1)
        self.assertEqual(final_chunks[0]["text"], "Hello world.")
        self.assertEqual(
            [item["text"] for item in final_chunks[0]["wordTimings"]],
            ["Hello", "world", "."],
        )
        self.assertEqual(session.final_text_raw, "Hello world.")
        self.assertEqual(session.pending_final_chunk, "This is still going")
        self.assertEqual(
            [item["text"] for item in session.pending_final_word_timings],
            ["This", "is", "still", "going"],
        )

    def test_emit_final_defers_max_chunk_when_stable_preview_coverage_is_too_short(self):
        websocket = DummyWebSocket()
        session = WebSocketStreamingSession(websocket, {})
        max_chunk_pcm = b"\x00\x00" * (session.bytes_for_ms(5000) // 2)
        session.pending_pcm = bytearray(max_chunk_pcm)
        session.pending_new_bytes = len(max_chunk_pcm)
        session.buffer_start_at = 1.0
        session.current_preview_stable_text = "部はイチゴやメロ"
        session.current_preview_unstable_text = "ンが定番です。"
        session.transcribe_pcm = lambda _pcm: {
            "success": True,
            "text": "プはイチゴやメロンが定番です。",
            "word_timings": [
                {"text": "プ", "startMs": 0, "endMs": 270},
                {"text": "は", "startMs": 270, "endMs": 510},
                {"text": "イ", "startMs": 510, "endMs": 690},
                {"text": "チ", "startMs": 690, "endMs": 810},
                {"text": "ゴ", "startMs": 810, "endMs": 930},
                {"text": "や", "startMs": 930, "endMs": 1050},
                {"text": "メ", "startMs": 1110, "endMs": 1230},
                {"text": "ロ", "startMs": 1230, "endMs": 1290},
                {"text": "ン", "startMs": 1290, "endMs": 1410},
                {"text": "が", "startMs": 1470, "endMs": 1530},
                {"text": "定", "startMs": 1650, "endMs": 1770},
                {"text": "番", "startMs": 1770, "endMs": 2009},
                {"text": "で", "startMs": 2009, "endMs": 2250},
                {"text": "す", "startMs": 2250, "endMs": 2490},
                {"text": "。", "startMs": 2490, "endMs": 4290},
            ],
        }

        session.emit_final("max_chunk")

        final_chunks = [message for message in websocket.messages if message["type"] == "final_chunk"]
        self.assertEqual(final_chunks, [])
        self.assertEqual(session.pending_final_chunk, "プはイチゴやメロンが定番です。")

    def test_emit_final_defers_short_silence_chunk_until_more_context_arrives(self):
        websocket = DummyWebSocket()
        session = WebSocketStreamingSession(websocket, {})
        short_pcm = b"\x00\x00" * (session.bytes_for_ms(1200) // 2)
        session.pending_pcm = bytearray(short_pcm)
        session.pending_new_bytes = len(short_pcm)
        session.buffer_start_at = 1.0
        session.transcribe_pcm = lambda _pcm: {
            "success": True,
            "text": "う。",
            "word_timings": [
                {"text": "う", "startMs": 0, "endMs": 750},
                {"text": "。", "startMs": 750, "endMs": 870},
            ],
        }

        session.emit_final("silence")

        final_chunks = [message for message in websocket.messages if message["type"] == "final_chunk"]
        self.assertEqual(final_chunks, [])
        self.assertEqual(session.pending_final_chunk, "う。")

    def test_commit_pending_final_chunk_emits_corrected_visible_text_but_keeps_raw_base(self):
        websocket = DummyWebSocket()
        session = WebSocketStreamingSession(
            websocket,
            {
                "text_corrections": [
                    '{"entries":[{"target":"宇治金時","aliases":["う事キん時"]}]}'
                ]
            },
        )
        session.pending_final_chunk = "私はう事キん時が好きです。"
        session.pending_final_word_timings = [
            {"text": "私", "startMs": 0, "endMs": 120},
            {"text": "は", "startMs": 120, "endMs": 240},
        ]

        session.commit_pending_final_chunk("silence")

        final_chunks = [message for message in websocket.messages if message["type"] == "final_chunk"]
        self.assertEqual(len(final_chunks), 1)
        self.assertEqual(final_chunks[0]["text"], "私は宇治金時が好きです。")
        self.assertIsNone(final_chunks[0]["wordTimings"])
        self.assertEqual(session.final_text, "私は宇治金時が好きです。")
        self.assertEqual(session.final_text_raw, "私はう事キん時が好きです。")

    def test_commit_pending_final_chunk_emits_sentence_event_for_complete_sentence(self):
        websocket = DummyWebSocket()
        session = WebSocketStreamingSession(websocket, {})
        session.pending_final_chunk = "Hello wonderful world."
        session.pending_final_word_timings = [
            {"text": "Hello", "startMs": 0, "endMs": 300},
            {"text": "wonderful", "startMs": 300, "endMs": 600},
            {"text": "world", "startMs": 600, "endMs": 900},
            {"text": ".", "startMs": 900, "endMs": 1020},
        ]

        session.commit_pending_final_chunk("silence")

        sentence_events = [message for message in websocket.messages if message["type"] == "sentence"]
        self.assertEqual(len(sentence_events), 1)
        self.assertEqual(sentence_events[0]["text"], "Hello wonderful world.")

    def test_sentence_event_text_is_normalized_before_emit(self):
        websocket = DummyWebSocket()
        session = WebSocketStreamingSession(websocket, {"language": ["ja"]})
        session.pending_final_chunk = "🎼皆さん、お元気ですか？今日は日本の夏によく食べるものをご紹介します。"

        session.commit_pending_final_chunk("silence")

        sentence_events = [message for message in websocket.messages if message["type"] == "sentence"]
        self.assertEqual(len(sentence_events), 1)
        self.assertEqual(
            sentence_events[0]["text"],
            "皆さん、お元気ですか？今日は日本の夏によく食べるものをご紹介します。",
        )

    def test_commit_pending_final_chunk_keeps_weak_suffix_in_pending_sentence(self):
        websocket = DummyWebSocket()
        session = WebSocketStreamingSession(websocket, {})
        session.pending_final_chunk = "It was sort of"

        session.commit_pending_final_chunk("silence")

        sentence_events = [message for message in websocket.messages if message["type"] == "sentence"]
        self.assertEqual(sentence_events, [])
        self.assertEqual(session.assembler.pending_sentence_text, "It was sort of")

    def test_english_session_uses_more_conservative_silence_threshold(self):
        session = WebSocketStreamingSession(websocket=DummyWebSocket(), params={"language": ["en"]})

        self.assertGreater(session.get_effective_silence_threshold_ms(), session.silence_threshold_ms)


if __name__ == "__main__":
    unittest.main()

