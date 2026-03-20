import array
import io
import math
import struct
import sys
import wave


def build_word_timings(words, timestamps):
    if not isinstance(words, list) or not isinstance(timestamps, list):
        return None

    count = min(len(words), len(timestamps))
    if count <= 0:
        return None

    word_timings = []
    for index in range(count):
        word = words[index]
        timing = timestamps[index]
        if not isinstance(word, str) or not isinstance(timing, (list, tuple)) or len(timing) < 2:
            continue
        start_ms = timing[0]
        end_ms = timing[1]
        if not isinstance(start_ms, (int, float)) or not isinstance(end_ms, (int, float)):
            continue
        word_timings.append(
            {
                "text": word,
                "startMs": int(start_ms),
                "endMs": int(end_ms),
            }
        )

    return word_timings or None


def decode_wav_to_mono_pcm16(audio_data: bytes) -> dict | None:
    try:
        with wave.open(io.BytesIO(audio_data), "rb") as wav_file:
            channel_count = wav_file.getnchannels()
            sample_width = wav_file.getsampwidth()
            sample_rate = wav_file.getframerate()
            frame_count = wav_file.getnframes()
            if channel_count <= 0 or sample_width != 2 or sample_rate <= 0 or frame_count <= 0:
                return None
            raw_frames = wav_file.readframes(frame_count)
    except wave.Error:
        return None

    if not raw_frames:
        return None

    samples = array.array("h")
    samples.frombytes(raw_frames)
    if sys.byteorder != "little":
        samples.byteswap()

    if channel_count > 1:
        mono_samples = array.array("h")
        for index in range(0, len(samples), channel_count):
            frame = samples[index : index + channel_count]
            if len(frame) < channel_count:
                break
            mono_value = int(sum(frame) / len(frame))
            mono_samples.append(max(-32768, min(32767, mono_value)))
        samples = mono_samples

    if not samples:
        return None

    pcm_mono = array.array("h", samples)
    if sys.byteorder != "little":
        pcm_mono.byteswap()

    return {
        "sample_rate": sample_rate,
        "pcm_mono": pcm_mono.tobytes(),
    }


def encode_wav_pcm16_mono(pcm_mono: bytes, sample_rate: int) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm_mono)
    return buffer.getvalue()


def detect_offline_segments(
    pcm_mono: bytes,
    sample_rate: int,
    *,
    silence_ms: int = 1200,
    min_speech_rms: int = 360,
    analysis_window_ms: int = 30,
    padding_ms: int = 480,
    max_segment_ms: int = 30000,
    overlap_ms: int = 640,
) -> list[tuple[int, int]]:
    if not pcm_mono or sample_rate <= 0:
        return []

    samples = array.array("h")
    samples.frombytes(pcm_mono)
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        return []

    window_samples = max(1, int(sample_rate * max(10, analysis_window_ms) / 1000))
    silence_windows = max(1, int(math.ceil(max(60, silence_ms) / max(10, analysis_window_ms))))
    padding_windows = max(0, int(math.ceil(max(0, padding_ms) / max(10, analysis_window_ms))))
    overlap_windows = max(0, int(math.ceil(max(0, overlap_ms) / max(10, analysis_window_ms))))
    max_segment_windows = max(
        silence_windows + 1,
        int(math.ceil(max(1000, max_segment_ms) / max(10, analysis_window_ms))),
    )

    rms_values: list[float] = []
    for offset in range(0, len(samples), window_samples):
        chunk = samples[offset : offset + window_samples]
        if not chunk:
            continue
        mean_square = sum(sample * sample for sample in chunk) / len(chunk)
        rms_values.append(math.sqrt(mean_square))

    if not rms_values:
        return []

    raw_segments: list[tuple[int, int]] = []
    segment_start = None
    last_speech = None
    for index, rms in enumerate(rms_values):
        is_speech = rms >= min_speech_rms
        if is_speech:
            if segment_start is None:
                segment_start = index
            last_speech = index
            continue

        if segment_start is None or last_speech is None:
            continue

        if index - last_speech >= silence_windows:
            raw_segments.append((segment_start, last_speech + 1))
            segment_start = None
            last_speech = None

    if segment_start is not None and last_speech is not None:
        raw_segments.append((segment_start, last_speech + 1))

    if not raw_segments:
        return [(0, len(samples))]

    total_windows = len(rms_values)
    expanded_segments: list[tuple[int, int]] = []
    for start_window, end_window in raw_segments:
        expanded_start = max(0, start_window - padding_windows)
        expanded_end = min(total_windows, end_window + padding_windows)
        expanded_segments.append((expanded_start, expanded_end))

    sample_segments: list[tuple[int, int]] = []
    for start_window, end_window in expanded_segments:
        chunk_start = start_window
        while chunk_start < end_window:
            chunk_end = min(end_window, chunk_start + max_segment_windows)
            start_sample = min(len(samples), chunk_start * window_samples)
            end_sample = min(len(samples), chunk_end * window_samples)
            if end_sample > start_sample:
                sample_segments.append((start_sample, end_sample))
            if chunk_end >= end_window:
                break
            chunk_start = max(start_window, chunk_end - overlap_windows)

    return sample_segments or [(0, len(samples))]


def offset_word_timings(word_timings: list[dict] | None, offset_ms: int) -> list[dict] | None:
    if not isinstance(word_timings, list) or not word_timings:
        return None

    shifted = []
    for item in word_timings:
        text = item.get("text")
        start_ms = item.get("startMs")
        end_ms = item.get("endMs")
        if not isinstance(text, str) or not isinstance(start_ms, (int, float)) or not isinstance(
            end_ms, (int, float)
        ):
            continue
        shifted.append(
            {
                "text": text,
                "startMs": int(start_ms + offset_ms),
                "endMs": int(end_ms + offset_ms),
            }
        )
    return shifted or None


def build_wav_from_pcm(pcm_data: bytes, sample_rate: int) -> bytes:
    num_channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    data_size = len(pcm_data)
    header_size = 44
    file_size = header_size + data_size - 8

    header = bytearray(header_size)
    header[0:4] = b"RIFF"
    struct.pack_into("<I", header, 4, file_size)
    header[8:12] = b"WAVE"
    header[12:16] = b"fmt "
    struct.pack_into("<I", header, 16, 16)
    struct.pack_into("<H", header, 20, 1)
    struct.pack_into("<H", header, 22, num_channels)
    struct.pack_into("<I", header, 24, sample_rate)
    struct.pack_into("<I", header, 28, byte_rate)
    struct.pack_into("<H", header, 32, block_align)
    struct.pack_into("<H", header, 34, bits_per_sample)
    header[36:40] = b"data"
    struct.pack_into("<I", header, 40, data_size)
    return bytes(header) + pcm_data
