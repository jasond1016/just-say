import json
import unittest

from whisper_server import WebSocketStreamingSession, accumulate_preview_text


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


if __name__ == "__main__":
    unittest.main()
