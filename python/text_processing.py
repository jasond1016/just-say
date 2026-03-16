import json
import re
import unicodedata


def parse_bool(value, default=False):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def parse_text_corrections(raw_value) -> list[dict]:
    if not raw_value:
        return []

    try:
        parsed = json.loads(raw_value)
    except Exception:
        return []

    if isinstance(parsed, dict):
        entries = parsed.get("entries")
    elif isinstance(parsed, list):
        entries = parsed
    else:
        return []

    if not isinstance(entries, list):
        return []

    normalized_entries = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue

        target = entry.get("target")
        aliases = entry.get("aliases")
        if not isinstance(target, str):
            continue
        normalized_target = target.strip()
        if not normalized_target:
            continue

        normalized_aliases = []
        if isinstance(aliases, list):
            for alias in aliases:
                if not isinstance(alias, str):
                    continue
                normalized_alias = alias.strip()
                if not normalized_alias or normalized_alias == normalized_target:
                    continue
                if normalized_alias not in normalized_aliases:
                    normalized_aliases.append(normalized_alias)

        if not normalized_aliases:
            continue

        normalized_entries.append(
            {
                "target": normalized_target,
                "aliases": normalized_aliases,
            }
        )

    return normalized_entries


def apply_text_corrections(text: str, corrections: list[dict]) -> tuple[str, bool]:
    normalized = (text or "").strip()
    if not normalized or not corrections:
        return normalized, False

    replacements: list[tuple[str, str]] = []
    seen_pairs = set()
    for entry in corrections:
        if not isinstance(entry, dict):
            continue
        target = entry.get("target")
        aliases = entry.get("aliases")
        if not isinstance(target, str) or not isinstance(aliases, list):
            continue
        for alias in aliases:
            if not isinstance(alias, str):
                continue
            pair = (alias, target)
            if not alias or alias == target or pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            replacements.append(pair)

    if not replacements:
        return normalized, False

    corrected = normalized
    for alias, target in sorted(replacements, key=lambda item: len(item[0]), reverse=True):
        corrected = corrected.replace(alias, target)

    return corrected, corrected != normalized


def parse_positive_int(raw_value, fallback: int, minimum: int = 1) -> int:
    try:
        value = int(raw_value)
        if value < minimum:
            return fallback
        return value
    except Exception:
        return fallback


def find_text_overlap(left: str, right: str, max_overlap: int = 200) -> int:
    if not left or not right:
        return 0
    limit = min(max_overlap, len(left), len(right))
    for size in range(limit, 0, -1):
        if left[-size:] == right[:size]:
            return size
    return 0


def merge_text(left: str, right: str) -> str:
    if not left:
        return right
    if not right:
        return left
    if left[-1].isspace() or right[0].isspace():
        return left + right
    if should_insert_space(left[-1], right[0]):
        return f"{left} {right}"
    return left + right


def is_cjk_char(ch: str) -> bool:
    return (
        "\u3040" <= ch <= "\u30ff"
        or "\u31f0" <= ch <= "\u31ff"
        or "\u3400" <= ch <= "\u4dbf"
        or "\u4e00" <= ch <= "\u9fff"
        or "\uf900" <= ch <= "\ufaff"
    )


def should_insert_space(left_char: str, right_char: str) -> bool:
    if not left_char or not right_char:
        return False
    if left_char.isspace() or right_char.isspace():
        return False
    if left_char in {"'", "\u2019", "(", "[", "{"} or right_char in {"'", "\u2019", ".", ",", "!", "?", ";", ":", ")", "]", "}"}:
        return False
    if is_cjk_char(left_char) or is_cjk_char(right_char):
        return False

    left_is_word = is_loose_word_char(left_char)
    right_is_word = is_loose_word_char(right_char)
    if left_is_word and right_is_word:
        return True
    if left_char in {".", ",", "!", "?", ";", ":"} and right_is_word:
        return True
    return False


def normalize_loose_text(text: str) -> str:
    chars = []
    for ch in text:
        if ch.isalnum() or "\u3040" <= ch <= "\u30ff" or "\u31f0" <= ch <= "\u31ff" or "\u3400" <= ch <= "\u9fff":
            chars.append(ch.lower())
    return "".join(chars)


def is_loose_word_char(ch: str) -> bool:
    return ch.isalnum() or "\u3040" <= ch <= "\u30ff" or "\u31f0" <= ch <= "\u31ff" or "\u3400" <= ch <= "\u9fff"


def replace_weak_tail_with_continuation(left: str, right: str) -> str | None:
    trimmed_left = left.rstrip(" \t\r\n,\uff0c\u3001\u3002\uff01\uff1f!?;\uff1b:\uff1a")
    if not trimmed_left:
        return None

    normalized_right = normalize_loose_text(right)
    max_size = min(8, len(trimmed_left))
    for size in range(max_size, 1, -1):
        tail = trimmed_left[-size:]
        if not all(is_loose_word_char(ch) for ch in tail):
            continue

        normalized_tail = normalize_loose_text(tail)
        if len(normalized_tail) < 2:
            continue
        if not normalized_right.startswith(normalized_tail) or len(normalized_right) <= len(normalized_tail):
            continue

        return merge_text(trimmed_left[:-size], right)

    return None


def merge_streaming_chunk_text(left: str, right: str) -> str:
    if not left:
        return right
    if not right:
        return left

    overlap = find_text_overlap(left, right, 200)
    if overlap > 0:
        return merge_text(left, right[overlap:])

    replacement = replace_weak_tail_with_continuation(left, right)
    if replacement:
        return replacement

    return merge_text(left, right)


def get_common_prefix(left: str, right: str) -> str:
    if not left or not right:
        return ""

    index = 0
    limit = min(len(left), len(right))
    while index < limit and left[index] == right[index]:
        index += 1
    return left[:index]


def collect_loose_chars(text: str) -> list[tuple[str, int]]:
    chars: list[tuple[str, int]] = []
    for index, ch in enumerate(text):
        if is_loose_word_char(ch):
            chars.append((ch.lower(), index))
    return chars


def replace_near_tail_with_incoming(previous: str, incoming: str) -> str | None:
    previous_chars = collect_loose_chars(previous)
    incoming_chars = collect_loose_chars(incoming)
    if len(previous_chars) < 6 or len(incoming_chars) < 6:
        return None

    max_size = min(24, len(previous_chars), len(incoming_chars))
    for size in range(max_size, 5, -1):
        incoming_prefix = "".join(ch for ch, _ in incoming_chars[:size])

        search_start = max(0, len(previous_chars) - size - 20)
        search_end = len(previous_chars) - size
        for start in range(search_end, search_start - 1, -1):
            candidate = "".join(ch for ch, _ in previous_chars[start : start + size])
            if candidate != incoming_prefix:
                continue

            replace_from = previous_chars[start][1]
            return merge_text(previous[:replace_from].rstrip(), incoming)

    return None


def merge_with_anchor_alignment(
    previous: str,
    incoming: str,
    *,
    min_match_chars: int = 6,
    max_previous_window_chars: int = 72,
    max_incoming_skip_chars: int = 8,
) -> str | None:
    previous_chars = collect_loose_chars(previous)
    incoming_chars = collect_loose_chars(incoming)
    if len(previous_chars) < min_match_chars or len(incoming_chars) < min_match_chars:
        return None

    previous_start_min = max(0, len(previous_chars) - max_previous_window_chars)
    incoming_skip_max = min(max_incoming_skip_chars, len(incoming_chars) - min_match_chars)
    best_match: tuple[int, int, int] | None = None

    for incoming_start in range(incoming_skip_max + 1):
        previous_start_max = len(previous_chars) - min_match_chars
        for previous_start in range(previous_start_max, previous_start_min - 1, -1):
            run = 0
            while (
                previous_start + run < len(previous_chars)
                and incoming_start + run < len(incoming_chars)
                and previous_chars[previous_start + run][0] == incoming_chars[incoming_start + run][0]
            ):
                run += 1

            if run < min_match_chars:
                continue

            if best_match is None or run > best_match[2]:
                best_match = (previous_start, incoming_start, run)
                continue

            if run == best_match[2]:
                _, best_incoming_start, _ = best_match
                if incoming_start < best_incoming_start:
                    best_match = (previous_start, incoming_start, run)

    if best_match is None:
        return None

    previous_start, incoming_start, run = best_match

    # When the new preview starts from the middle of an already visible sentence,
    # keep the matched prefix from the previous preview and only append the
    # truly new tail. This avoids artifacts like "HelloAnd welcome".
    previous_prefix = previous[: previous_chars[previous_start][1]]
    incoming_suffix = incoming[incoming_chars[incoming_start][1] :]

    if incoming_start == 0 and previous_start > 0 and incoming_suffix:
        matched_previous_char = previous[previous_chars[previous_start][1]]
        matched_incoming_char = incoming_suffix[0]
        if (
            matched_previous_char.isalpha()
            and matched_incoming_char.isalpha()
            and matched_previous_char.lower() == matched_incoming_char.lower()
        ):
            incoming_suffix = matched_previous_char + incoming_suffix[1:]

    if not incoming_suffix.strip():
        return None

    return merge_text(previous_prefix.rstrip(), incoming_suffix)


def accumulate_preview_text(previous: str, incoming: str) -> str:
    normalized_previous = (previous or "").strip()
    normalized_incoming = (incoming or "").strip()

    if not normalized_incoming:
        return normalized_previous
    if not normalized_previous:
        return normalized_incoming
    if normalized_incoming == normalized_previous:
        return normalized_incoming
    if normalized_incoming.startswith(normalized_previous):
        return normalized_incoming
    if normalized_previous.startswith(normalized_incoming):
        return normalized_previous

    common_prefix = get_common_prefix(normalized_previous, normalized_incoming)
    common_meaningful_chars = count_meaningful_chars(common_prefix)
    previous_meaningful_chars = count_meaningful_chars(normalized_previous)
    incoming_meaningful_chars = count_meaningful_chars(normalized_incoming)
    meaningful_floor = max(1, min(previous_meaningful_chars, incoming_meaningful_chars))

    if (
        common_meaningful_chars >= 12
        or common_meaningful_chars / meaningful_floor >= 0.7
    ):
        return normalized_incoming

    overlap = find_text_overlap(normalized_previous, normalized_incoming, 200)
    if overlap > 0:
        return merge_text(normalized_previous, normalized_incoming[overlap:])

    anchored = merge_with_anchor_alignment(normalized_previous, normalized_incoming)
    if anchored:
        return anchored

    replacement = replace_near_tail_with_incoming(normalized_previous, normalized_incoming)
    if replacement:
        return replacement

    previous_is_sentence_like = (
        normalized_previous[-1] in {"\u3002", "\uff01", "\uff1f", "!", "?"}
        and previous_meaningful_chars >= 12
    )
    if previous_is_sentence_like and incoming_meaningful_chars >= 8:
        return merge_text(normalized_previous, normalized_incoming)

    return normalized_incoming


def try_preserve_previous_preview(previous_preview: str, incoming_preview: str) -> str | None:
    normalized_previous = (previous_preview or "").strip()
    normalized_incoming = (incoming_preview or "").strip()
    if not normalized_previous or not normalized_incoming:
        return None
    if not is_latin_dominant_text(normalized_previous) and not is_latin_dominant_text(normalized_incoming):
        return None

    previous_chars = count_meaningful_chars(normalized_previous)
    incoming_chars = count_meaningful_chars(normalized_incoming)
    if previous_chars < 18 or incoming_chars < 2:
        return None
    if incoming_chars > ENGLISH_PREVIEW_RESET_MAX_INCOMING_CHARS:
        return None

    trimmed_previous = normalized_previous.rstrip("\u3002\uff01\uff1f!?.\uff0c\u3001,;\uff1b:\uff1a \t\r\n")
    if not trimmed_previous:
        return None

    overlap = find_text_overlap(trimmed_previous, normalized_incoming, 200)
    if overlap > 0:
        return merge_text(trimmed_previous, normalized_incoming[overlap:])

    return merge_text(trimmed_previous, normalized_incoming)


def normalize_japanese_spacing(text: str) -> str:
    if not text:
        return text

    normalized = text
    while True:
        next_text = re.sub(
            r"([\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])[ \t\u3000]+([\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])",
            r"\1\2",
            normalized,
        )
        next_text = re.sub(
            r"([\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])[ \t\u3000]+([。、「」『』（）！？、])",
            r"\1\2",
            next_text,
        )
        next_text = re.sub(
            r"([。、「」『』（）！？、])[ \t\u3000]+([\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])",
            r"\1\2",
            next_text,
        )
        if next_text == normalized:
            return next_text
        normalized = next_text


JAPANESE_ORDINAL_DIGIT_MAP = {
    "1": "一",
    "2": "二",
    "3": "三",
    "4": "四",
    "5": "五",
    "6": "六",
    "7": "七",
    "8": "八",
    "9": "九",
    "10": "十",
}


def normalize_japanese_ordinals(text: str) -> str:
    if not text:
        return text

    def _replace(match: re.Match[str]) -> str:
        digit = unicodedata.normalize("NFKC", match.group(1))
        mapped = JAPANESE_ORDINAL_DIGIT_MAP.get(digit)
        if not mapped:
            return match.group(0)
        return f"{mapped}つ目"

    return re.sub(r"([0-9０-９]{1,2})\s*つ目", _replace, text)


def strip_japanese_asr_symbols(text: str) -> str:
    if not text:
        return text

    cleaned = re.sub(r"[\U0001F300-\U0001FAFF\u2600-\u27BF]+", "", text)
    cleaned = re.sub(r"[🎼♪♫♬♩♭♯]+", "", cleaned)
    return cleaned


def cleanup_japanese_asr_text(text: str) -> str:
    if not text:
        return text

    cleaned = normalize_japanese_spacing(text)
    cleaned = normalize_japanese_ordinals(cleaned)
    cleaned = strip_japanese_asr_symbols(cleaned)
    cleaned = re.sub(r"^[\s\u3000]+", "", cleaned)
    cleaned = re.sub(r"(.{1,16}[。！？!?])(?:\1)+$", r"\1", cleaned)
    return cleaned


WEAK_BOUNDARY_SUFFIX_CHARS = {
    "的",
    "了",
    "和",
    "与",
    "及",
    "并",
    "而",
    "但",
    "就",
    "还",
    "呢",
    "吗",
    "吧",
    "啊",
    "は",
    "が",
    "を",
    "に",
    "で",
    "と",
    "へ",
    "も",
    "の",
}
WEAK_ENGLISH_SUFFIX_RE = re.compile(
    r"\b(?:and|or|to|of|for|with|the|a|an|but|so|if|that|this|these|those|my|your|our|their|his|her|its|you|we|they|he|she|it|is|are|was|were|be|been|being|do|did|does|have|has|had)$",
    re.IGNORECASE,
)
LATIN_CHAR_RE = re.compile(r"[A-Za-z]")
CJK_CHAR_RE = re.compile(r"[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")

ENGLISH_SENTENCE_MIN_FLUSH_CHARS = 14
ENGLISH_SENTENCE_SOFT_FLUSH_CHARS = 28
ENGLISH_SENTENCE_FORCE_FLUSH_CHARS = 48
ENGLISH_STRONG_PUNCTUATION_MIN_TAIL_CHARS = 3
ENGLISH_PREVIEW_STABILITY_WINDOW = 4
ENGLISH_PREVIEW_STABLE_TAIL_CHARS = 6
ENGLISH_PREVIEW_MAX_STABLE_ROLLBACK_CHARS = 4
ENGLISH_PREVIEW_RESET_MIN_STABLE_CHARS = 6
ENGLISH_PREVIEW_RESET_MAX_INCOMING_CHARS = 12
ENGLISH_COMMIT_STABLE_PREFIX_MIN_CHARS = 18
ENGLISH_COMMIT_STABLE_PREFIX_MIN_REMAINING_CHARS = 2
ENGLISH_SILENCE_THRESHOLD_MULTIPLIER = 1.5
ENGLISH_SILENCE_THRESHOLD_MIN_MS = 900


def count_meaningful_chars(text: str) -> int:
    count = 0
    for ch in text:
        if ch.isalnum() or "\u3040" <= ch <= "\u30ff" or "\u31f0" <= ch <= "\u31ff" or "\u3400" <= ch <= "\u9fff":
            count += 1
    return count


def is_latin_dominant_text(text: str) -> bool:
    latin_count = 0
    cjk_count = 0
    for ch in text:
        if LATIN_CHAR_RE.search(ch):
            latin_count += 1
            continue
        if CJK_CHAR_RE.search(ch):
            cjk_count += 1
    return latin_count >= 6 and latin_count >= cjk_count * 2


def trim_loose_prefix(text: str, prefix: str) -> str | None:
    normalized_text = (text or "").strip()
    normalized_prefix = (prefix or "").strip()
    if not normalized_text or not normalized_prefix:
        return None

    text_chars = collect_loose_chars(normalized_text)
    prefix_chars = collect_loose_chars(normalized_prefix)
    if not text_chars or not prefix_chars or len(prefix_chars) > len(text_chars):
        return None

    if "".join(ch for ch, _ in text_chars[: len(prefix_chars)]) != "".join(
        ch for ch, _ in prefix_chars
    ):
        return None

    cut_index = text_chars[len(prefix_chars) - 1][1] + 1
    return normalized_text[cut_index:].lstrip()


def drop_word_timing_prefix(
    word_timings: list[dict] | None, prefix_text: str, max_items: int = 12
) -> list[dict] | None:
    if not isinstance(word_timings, list) or not word_timings:
        return None

    normalized_prefix = normalize_loose_text(prefix_text)
    if not normalized_prefix:
        return word_timings

    merged_prefix = ""
    for index, item in enumerate(word_timings[:max_items]):
        text = item.get("text")
        if not isinstance(text, str) or not text.strip():
            continue

        merged_prefix = merge_text(merged_prefix, text.strip()) if merged_prefix else text.strip()
        merged_normalized = normalize_loose_text(merged_prefix)
        if not merged_normalized:
            continue
        if merged_normalized == normalized_prefix:
            remaining = word_timings[index + 1 :]
            return remaining or None
        if len(merged_normalized) > len(normalized_prefix):
            break

    return word_timings


def split_word_timings_by_prefix(
    word_timings: list[dict] | None,
    prefix_text: str,
    max_items: int = 96,
) -> tuple[list[dict] | None, list[dict] | None]:
    if not isinstance(word_timings, list) or not word_timings:
        return None, None

    normalized_prefix = normalize_loose_text(prefix_text)
    if not normalized_prefix:
        return None, word_timings
    stripped_prefix_text = prefix_text.strip()
    trailing_punctuation_chars: list[str] = []
    for ch in reversed(stripped_prefix_text):
        if ch.isspace():
            continue
        if is_loose_word_char(ch):
            break
        trailing_punctuation_chars.append(ch)
    trailing_punctuation = "".join(reversed(trailing_punctuation_chars))

    merged_prefix = ""
    for index, item in enumerate(word_timings[:max_items]):
        text = item.get("text")
        if not isinstance(text, str) or not text.strip():
            continue

        merged_prefix = merge_text(merged_prefix, text.strip()) if merged_prefix else text.strip()
        merged_normalized = normalize_loose_text(merged_prefix)
        if not merged_normalized:
            continue
        if merged_normalized == normalized_prefix:
            split_index = index + 1
            if trailing_punctuation:
                matched_punctuation = ""
                while split_index < len(word_timings):
                    next_text = word_timings[split_index].get("text")
                    if not isinstance(next_text, str) or not next_text.strip():
                        split_index += 1
                        continue
                    stripped_next_text = next_text.strip()
                    if is_loose_word_char(stripped_next_text[0]):
                        break
                    matched_punctuation += stripped_next_text
                    split_index += 1
                    if matched_punctuation == trailing_punctuation:
                        break
                    if not trailing_punctuation.startswith(matched_punctuation):
                        split_index = index + 1
                        break

            committed = word_timings[:split_index]
            remaining = word_timings[split_index:]
            return committed or None, remaining or None
        if len(merged_normalized) > len(normalized_prefix):
            break

    return None, word_timings


def deduplicate_timed_prefix_from_base(
    base_text: str,
    incoming_text: str,
    word_timings: list[dict] | None,
    *,
    max_items: int = 8,
    max_end_ms: int = 900,
) -> tuple[str, list[dict] | None]:
    if not base_text or not incoming_text or not isinstance(word_timings, list) or not word_timings:
        return incoming_text, word_timings

    normalized_base = normalize_loose_text(base_text)
    if not normalized_base:
        return incoming_text, word_timings

    merged_prefix = ""
    best_trimmed_text = incoming_text
    best_drop_count = 0
    best_prefix_chars = 0
    for index, item in enumerate(word_timings[:max_items]):
        text = item.get("text")
        end_ms = item.get("endMs")
        if not isinstance(text, str) or not text.strip():
            continue
        if index > 0 and isinstance(end_ms, (int, float)) and end_ms > max_end_ms:
            break

        merged_prefix = merge_text(merged_prefix, text.strip()) if merged_prefix else text.strip()
        normalized_prefix = normalize_loose_text(merged_prefix)
        if len(normalized_prefix) < 3 or not normalized_base.endswith(normalized_prefix):
            continue

        trimmed_text = trim_loose_prefix(incoming_text, merged_prefix)
        if trimmed_text is None or not trimmed_text.strip():
            continue

        if len(normalized_prefix) > best_prefix_chars:
            best_prefix_chars = len(normalized_prefix)
            best_trimmed_text = trimmed_text.strip()
            best_drop_count = index + 1

    if best_drop_count <= 0:
        return incoming_text, word_timings

    remaining = word_timings[best_drop_count:]
    return best_trimmed_text, remaining or None


def has_unstable_timing_tail(
    word_timings: list[dict] | None,
    audio_duration_ms: float,
    unstable_text: str,
    *,
    near_end_ms: int = 240,
    max_tail_span_ms: int = 650,
    max_tail_items: int = 4,
    min_unstable_chars: int = 2,
) -> bool:
    if not isinstance(word_timings, list) or not word_timings or audio_duration_ms <= 0:
        return False

    unstable_chars = count_meaningful_chars((unstable_text or "").strip())
    if unstable_chars < min_unstable_chars:
        return False

    valid_items = []
    for item in word_timings:
        start_ms = item.get("startMs")
        end_ms = item.get("endMs")
        if not isinstance(start_ms, (int, float)) or not isinstance(end_ms, (int, float)):
            continue
        if end_ms < start_ms:
            continue
        valid_items.append(item)

    if not valid_items:
        return False

    last_end_ms = float(valid_items[-1]["endMs"])
    if max(0.0, audio_duration_ms - last_end_ms) > near_end_ms:
        return False

    tail_items: list[dict] = []
    collected_chars = 0
    for item in reversed(valid_items):
        tail_items.insert(0, item)
        collected_chars += count_meaningful_chars(str(item.get("text") or ""))
        if len(tail_items) >= max_tail_items or collected_chars >= unstable_chars:
            break

    if not tail_items:
        return False

    tail_span_ms = float(tail_items[-1]["endMs"]) - float(tail_items[0]["startMs"])
    return tail_span_ms <= max_tail_span_ms


def has_min_stable_preview_coverage(
    candidate: str,
    stable_preview: str,
    unstable_preview: str,
    *,
    min_stable_tail_chars: int = 6,
    max_unstable_chars: int = 4,
) -> bool:
    normalized_candidate = (candidate or "").strip()
    normalized_stable = (stable_preview or "").strip()
    normalized_unstable = (unstable_preview or "").strip()
    if not normalized_candidate or not normalized_stable:
        return False

    stable_prefix = get_common_prefix(normalized_candidate, normalized_stable)
    stable_prefix_chars = count_meaningful_chars(stable_prefix)
    if stable_prefix_chars < min_stable_tail_chars:
        return False

    remaining_chars = count_meaningful_chars(normalized_candidate[len(stable_prefix) :])
    if remaining_chars > max_unstable_chars:
        return False

    unstable_chars = count_meaningful_chars(normalized_unstable)
    if unstable_chars > max_unstable_chars:
        return False

    stable_tail = get_tail_after_last_boundary(stable_prefix.rstrip("\u3002\uff01\uff1f!?\uff0c\u3001,;\uff1b:\uff1a \t\r\n"))
    return count_meaningful_chars(stable_tail) >= min_stable_tail_chars


def is_abnormal_short_final_chunk(
    text: str,
    word_timings: list[dict] | None,
    *,
    max_meaningful_chars: int = 2,
    max_timing_items: int = 2,
) -> bool:
    normalized = (text or "").strip()
    if not normalized:
        return False

    meaningful_chars = count_meaningful_chars(normalized)
    if meaningful_chars <= 0:
        return True
    if meaningful_chars > max_meaningful_chars:
        return False
    if not any(ch.isalnum() or is_loose_word_char(ch) for ch in normalized):
        return True
    if normalized[-1] in {"\u3002", "\uff01", "\uff1f", "!", "?"} and not has_stable_final_boundary(
        normalized, min_tail_chars=max_meaningful_chars + 1
    ):
        return True
    if isinstance(word_timings, list) and len(word_timings) <= max_timing_items:
        return True
    return is_weak_boundary_suffix(normalized)


def trim_stable_prefix(text: str, keep_tail_meaningful_chars: int) -> str:
    normalized = (text or "").strip()
    if not normalized:
        return ""

    if keep_tail_meaningful_chars <= 0:
        return normalized

    remaining = keep_tail_meaningful_chars
    index = len(normalized)
    while index > 0 and remaining > 0:
        index -= 1
        if is_loose_word_char(normalized[index]):
            remaining -= 1

    if remaining > 0:
        return ""
    return normalized[:index].rstrip()


def trim_latin_stable_prefix(prefix: str, full_text: str) -> str:
    normalized_prefix = (prefix or "").rstrip()
    normalized_full = (full_text or "").strip()
    if not normalized_prefix or not normalized_full or not is_latin_dominant_text(normalized_full):
        return normalized_prefix

    candidate = normalized_prefix
    while candidate:
        next_char = normalized_full[len(candidate)] if len(candidate) < len(normalized_full) else ""
        if candidate[-1].isalnum() and next_char and next_char.isalnum():
            boundary_index = max(
                candidate.rfind(" "),
                candidate.rfind("\t"),
                candidate.rfind("\r"),
                candidate.rfind("\n"),
                candidate.rfind(","),
                candidate.rfind(";"),
                candidate.rfind(":"),
                candidate.rfind("-"),
                candidate.rfind("("),
            )
            if boundary_index < 0:
                return ""
            candidate = candidate[:boundary_index].rstrip()
            continue
        if is_weak_boundary_suffix(candidate):
            boundary_index = max(
                candidate.rfind(" "),
                candidate.rfind("\t"),
                candidate.rfind("\r"),
                candidate.rfind("\n"),
                candidate.rfind(","),
                candidate.rfind(";"),
                candidate.rfind(":"),
                candidate.rfind("-"),
                candidate.rfind("("),
            )
            if boundary_index < 0:
                return ""
            candidate = candidate[:boundary_index].rstrip()
            continue
        break

    return candidate


def get_common_prefix_for_many(texts: list[str]) -> str:
    if not texts:
        return ""

    prefix = texts[0]
    for text in texts[1:]:
        prefix = get_common_prefix(prefix, text)
        if not prefix:
            break
    return prefix


def shrink_stable_prefix(previous_stable: str, next_stable: str, max_rollback_chars: int) -> str:
    if not previous_stable:
        return next_stable
    if next_stable.startswith(previous_stable):
        return next_stable

    common = get_common_prefix(previous_stable, next_stable)
    rollback_chars = count_meaningful_chars(previous_stable[len(common) :])
    if rollback_chars <= max_rollback_chars:
        return common.rstrip()
    return previous_stable


def should_guard_preview_reset(
    previous_preview: str,
    incoming_preview: str,
    accumulated_preview: str,
    stable_prefix: str,
) -> bool:
    normalized_previous = (previous_preview or "").strip()
    normalized_incoming = (incoming_preview or "").strip()
    normalized_accumulated = (accumulated_preview or "").strip()
    normalized_stable = (stable_prefix or "").strip()
    if not normalized_previous or not normalized_incoming or not normalized_stable:
        return False
    if normalized_accumulated != normalized_incoming:
        return False
    if not normalized_previous.startswith(normalized_stable):
        return False
    if not is_latin_dominant_text(normalized_previous) and not is_latin_dominant_text(normalized_incoming):
        return False

    previous_chars = count_meaningful_chars(normalized_previous)
    incoming_chars = count_meaningful_chars(normalized_incoming)
    stable_chars = count_meaningful_chars(normalized_stable)
    min_stable_chars = 8
    if is_latin_dominant_text(normalized_previous) or is_latin_dominant_text(normalized_incoming):
        min_stable_chars = ENGLISH_PREVIEW_RESET_MIN_STABLE_CHARS
    if previous_chars < 18 or incoming_chars < 4 or stable_chars < min_stable_chars:
        return False
    if incoming_chars > max(12, int(previous_chars * 0.72)):
        return False

    common_prefix_chars = count_meaningful_chars(get_common_prefix(normalized_previous, normalized_incoming))
    if common_prefix_chars >= min(8, stable_chars):
        return False
    if normalized_incoming.startswith(normalized_stable):
        return False
    return True


def guard_preview_reset_with_stable_prefix(
    stable_prefix: str,
    incoming_preview: str,
    previous_preview: str = "",
) -> str:
    normalized_stable = (stable_prefix or "").strip()
    normalized_incoming = (incoming_preview or "").strip()
    preserved_preview = try_preserve_previous_preview(previous_preview, normalized_incoming)
    if preserved_preview:
        return preserved_preview
    if not normalized_stable:
        return normalized_incoming
    if not normalized_incoming:
        return normalized_stable
    if normalized_incoming.startswith(normalized_stable):
        return normalized_incoming
    return merge_streaming_chunk_text(normalized_stable, normalized_incoming)


def is_weak_boundary_suffix(text: str) -> bool:
    normalized = (text or "").strip()
    if not normalized:
        return False

    trimmed = normalized.rstrip("\u3002\uff01\uff1f!?.\uff0c\u3001,;\uff1b:\uff1a \t\r\n")
    if not trimmed:
        return True

    if WEAK_ENGLISH_SUFFIX_RE.search(trimmed.lower()):
        return True
    return trimmed[-1] in WEAK_BOUNDARY_SUFFIX_CHARS


def get_tail_after_last_boundary(text: str) -> str:
    for idx in range(len(text) - 1, -1, -1):
        if text[idx] in {" ", "\t", "\r", "\n", ",", "\uff0c", "\u3001", "\u3002", "\uff01", "\uff1f", "!", "?", ";", "\uff1b", ":", "\uff1a"}:
            return text[idx + 1 :]
    return text


def split_prefix_and_tail(text: str) -> tuple[str, str]:
    normalized = (text or "").strip()
    if not normalized:
        return "", ""

    without_trailing_boundary = normalized.rstrip("\u3002\uff01\uff1f!?.")
    if not without_trailing_boundary:
        return "", ""

    tail = get_tail_after_last_boundary(without_trailing_boundary)
    if not tail:
        return without_trailing_boundary, ""

    prefix = without_trailing_boundary[: len(without_trailing_boundary) - len(tail)]
    return prefix, tail


def replace_trailing_tail(candidate: str, replacement_tail: str) -> str:
    prefix, _ = split_prefix_and_tail(candidate)
    return merge_text(prefix, replacement_tail)


def try_extend_candidate_with_preview(candidate: str, preview: str) -> str | None:
    normalized_candidate = (candidate or "").strip()
    normalized_preview = (preview or "").strip()
    if not normalized_candidate or not normalized_preview:
        return None

    _, candidate_tail = split_prefix_and_tail(normalized_candidate)
    preview_tail = normalized_preview

    candidate_tail = candidate_tail.strip()
    preview_tail = preview_tail.strip()
    if not candidate_tail or not preview_tail:
        return None

    normalized_candidate_tail = normalize_loose_text(
        candidate_tail.rstrip("\u3002\uff01\uff1f!?.\uff0c\u3001,;\uff1b:\uff1a \t\r\n")
    )
    normalized_preview_tail = normalize_loose_text(
        preview_tail.rstrip("\u3002\uff01\uff1f!?.\uff0c\u3001,;\uff1b:\uff1a \t\r\n")
    )
    if len(normalized_candidate_tail) < 4 or len(normalized_preview_tail) <= len(normalized_candidate_tail):
        return None
    if not normalized_preview_tail.startswith(normalized_candidate_tail):
        return None

    return replace_trailing_tail(candidate, preview_tail.rstrip("\u3002\uff01\uff1f!?. \t\r\n"))


def has_stable_final_boundary(text: str, min_tail_chars: int = 3) -> bool:
    normalized = (text or "").strip()
    if not normalized or normalized[-1] not in {"\u3002", "\uff01", "\uff1f", "!", "?", "."}:
        return False

    without_punctuation = normalized.rstrip("\u3002\uff01\uff1f!?.")
    if not without_punctuation:
        return False

    tail = get_tail_after_last_boundary(without_punctuation)
    return count_meaningful_chars(tail) >= min_tail_chars and not is_weak_boundary_suffix(normalized)


def should_flush_sentence_by_boundary(
    sentence: str,
    endpoint_triggered: bool,
    *,
    sentence_min_flush_chars: int = 14,
    sentence_soft_flush_chars: int = 28,
    sentence_force_flush_chars: int = 48,
    strong_punctuation_min_tail_chars: int = 3,
) -> bool:
    normalized = (sentence or "").strip()
    if not normalized:
        return False

    if is_latin_dominant_text(normalized):
        sentence_min_flush_chars = ENGLISH_SENTENCE_MIN_FLUSH_CHARS
        sentence_soft_flush_chars = ENGLISH_SENTENCE_SOFT_FLUSH_CHARS
        sentence_force_flush_chars = ENGLISH_SENTENCE_FORCE_FLUSH_CHARS
        strong_punctuation_min_tail_chars = ENGLISH_STRONG_PUNCTUATION_MIN_TAIL_CHARS

    meaningful_chars = count_meaningful_chars(normalized)
    if meaningful_chars >= sentence_force_flush_chars:
        return True

    if normalized.endswith(("\u3002", "\uff01", "\uff1f", "!", "?", ".")):
        without_punctuation = normalized.rstrip("\u3002\uff01\uff1f!?.")
        if without_punctuation:
            tail = get_tail_after_last_boundary(without_punctuation)
            if (
                meaningful_chars >= sentence_min_flush_chars
                and count_meaningful_chars(tail) >= strong_punctuation_min_tail_chars
            ):
                return True

    if normalized.endswith(("\uff0c", "\u3001", ",", ";", "\uff1b", ":", "\uff1a")):
        if meaningful_chars >= sentence_soft_flush_chars:
            return True

    if endpoint_triggered and meaningful_chars >= sentence_min_flush_chars and not is_weak_boundary_suffix(normalized):
        return True

    return False


def find_committable_sentence_prefix(
    text: str,
    *,
    min_prefix_chars: int = 8,
    min_suffix_chars: int = 3,
) -> tuple[str, str] | None:
    normalized = (text or "").strip()
    if not normalized or has_stable_final_boundary(normalized):
        return None

    best_split: tuple[str, str] | None = None
    for index, ch in enumerate(normalized[:-1]):
        if ch not in {"\u3002", "\uff01", "\uff1f", "!", "?", "."}:
            continue

        prefix = normalized[: index + 1].strip()
        suffix = normalized[index + 1 :].strip()
        if not prefix or not suffix:
            continue
        if count_meaningful_chars(prefix) < min_prefix_chars:
            continue
        if count_meaningful_chars(suffix) < min_suffix_chars:
            continue
        best_split = (prefix, suffix)

    return best_split


def find_committable_stable_preview_prefix(
    text: str,
    stable_preview: str,
    *,
    min_prefix_chars: int = ENGLISH_COMMIT_STABLE_PREFIX_MIN_CHARS,
    min_remaining_chars: int = ENGLISH_COMMIT_STABLE_PREFIX_MIN_REMAINING_CHARS,
) -> tuple[str, str] | None:
    normalized = (text or "").strip()
    normalized_stable = (stable_preview or "").strip()
    if not normalized or not normalized_stable:
        return None
    if not normalized.startswith(normalized_stable):
        return None

    prefix = normalized_stable.rstrip(" \t\r\n,;:\uff1a\uff0c\u3001-")
    if not prefix or prefix == normalized:
        return None
    if count_meaningful_chars(prefix) < min_prefix_chars:
        return None

    remaining = normalized[len(prefix) :].lstrip()
    if count_meaningful_chars(remaining) < min_remaining_chars:
        return None
    return prefix, remaining
