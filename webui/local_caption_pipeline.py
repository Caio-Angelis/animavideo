#!/usr/bin/env python3
"""Local captions for the cycle output.

The transcription and caption layout follow the local implementation used by
../meu_saas_cortes/app/ai_integrations/local_whisper.py,
../meu_saas_cortes/app/subtitle/srt_generator.py and
../meu_saas_cortes/app/subtitle/ass_builder.py.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import timedelta
from pathlib import Path

from faster_whisper import WhisperModel

MAX_CAPTION_CHARS = 160
MAX_LINE_CHARS = 44
MAX_LINES = 2
REPEAT_CHAR_RE = re.compile(r"(.)\1{6,}")
REPEAT_WORD_RE = re.compile(r"\b(\w+)(?:\s+\1){3,}\b", flags=re.IGNORECASE)
WS_RE = re.compile(r"\s+")


def clean_caption_text(text: str) -> str:
    value = (text or "").strip().replace("\u200b", " ")
    value = re.sub(WS_RE, " ", value).strip()
    value = REPEAT_CHAR_RE.sub(r"\1\1\1", value)
    value = REPEAT_WORD_RE.sub(r"\1", value)
    if len(value) > MAX_CAPTION_CHARS:
        value = value[: MAX_CAPTION_CHARS - 1].rstrip() + "…"
    return value


def wrap_two_lines(text: str) -> str:
    value = clean_caption_text(text)
    if not value:
        return ""
    words = value.split()
    lines: list[str] = []
    current: list[str] = []
    current_len = 0
    for word in words:
        added = (1 if current else 0) + len(word)
        if current and current_len + added > MAX_LINE_CHARS:
            lines.append(" ".join(current))
            current = [word]
            current_len = len(word)
            if len(lines) >= MAX_LINES:
                break
        else:
            current.append(word)
            current_len += added
    if len(lines) < MAX_LINES and current:
        lines.append(" ".join(current))
    output = "\n".join(lines[:MAX_LINES]).strip()
    if len(output.replace("\n", " ")) < len(value) and not output.endswith("…"):
        output = output.rstrip(". ") + "…"
    return output


def srt_timestamp(seconds: float) -> str:
    td = timedelta(seconds=max(0.0, float(seconds)))
    total_seconds = int(td.total_seconds())
    milliseconds = int(td.microseconds / 1000)
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60
    return f"{hours:02}:{minutes:02}:{secs:02},{milliseconds:03}"


def ass_timestamp_from_srt(timestamp: str) -> str:
    hms, milliseconds = timestamp.strip().split(",", 1)
    hours, minutes, seconds = hms.split(":")
    centiseconds = min(99, int(int(milliseconds) / 10))
    return f"{int(hours)}:{int(minutes):02}:{int(seconds):02}.{centiseconds:02}"


def escape_ass_text(text: str) -> str:
    return (
        text.replace("\\", r"\\")
        .replace("{", r"\{")
        .replace("}", r"\}")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\n", r"\N")
    )


def transcribe_with_model(model: WhisperModel, audio_path: Path, language: str) -> list[dict]:
    segments, _info = model.transcribe(
        str(audio_path),
        language=language or None,
        word_timestamps=True,
        vad_filter=True,
    )
    rows: list[dict] = []
    for segment in segments:
        words = [
            {
                "start": float(word.start),
                "end": float(word.end),
                "word": str(word.word),
            }
            for word in (segment.words or [])
        ]
        rows.append(
            {
                "start": float(segment.start),
                "end": float(segment.end),
                "text": str(segment.text).strip(),
                "words": words,
            }
        )
    return rows


def load_whisper_model(model_name: str) -> WhisperModel:
    try:
        return WhisperModel(model_name, device="cuda", compute_type="float16")
    except RuntimeError as error:
        detail = str(error).lower()
        if "cuda" not in detail and "out of memory" not in detail:
            raise
        print(
            "CUDA/float16 sem VRAM suficiente; usando fallback local CPU/int8.",
            file=sys.stderr,
            flush=True,
        )
        return WhisperModel(model_name, device="cpu", compute_type="int8")


def transcribe(audio_path: Path, model_name: str, language: str) -> list[dict]:
    model = load_whisper_model(model_name)
    return transcribe_with_model(model, audio_path, language)


def write_srt(segments: list[dict], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        index = 1
        for segment in segments:
            start = float(segment["start"])
            end = float(segment["end"])
            body = wrap_two_lines(str(segment.get("text", "")))
            if end <= start or not body:
                continue
            handle.write(
                f"{index}\n{srt_timestamp(start)} --> {srt_timestamp(end)}\n{body}\n\n"
            )
            index += 1


def parse_srt_entries(content: str):
    for block in re.split(r"\n\s*\n", content.strip()):
        lines = block.strip().splitlines()
        if len(lines) < 2:
            continue
        line_index = 1 if lines[0].strip().isdigit() else 0
        if line_index >= len(lines) or "-->" not in lines[line_index]:
            continue
        left, right = [part.strip() for part in lines[line_index].split("-->", 1)]
        body = "\n".join(lines[line_index + 1 :]).strip()
        if body:
            yield left, right, body


def write_ass(srt_path: Path, ass_path: Path, font_name: str, font_size: int, margin_v: int) -> None:
    content = srt_path.read_text(encoding="utf-8-sig")
    style = (
        f"Style: Default,{font_name},{font_size},&H00FFFFFF,&H00FFFFFF,&H00000000,"
        f"&H3F000000,1,0,0,0,100,100,0,0,1,3,1,2,56,56,{margin_v},1"
    )
    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        "WrapStyle: 0\n"
        "ScaledBorderAndShadow: yes\n"
        "PlayResX: 1080\n"
        "PlayResY: 1920\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
        "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
        "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"{style}\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )
    events: list[str] = []
    for start, end, body in parse_srt_entries(content):
        events.append(
            f"Dialogue: 0,{ass_timestamp_from_srt(start)},{ass_timestamp_from_srt(end)},"
            f"Default,,0,0,0,,{escape_ass_text(body)}"
        )
    ass_path.write_text(header + "\n".join(events) + "\n", encoding="utf-8-sig")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", type=Path)
    parser.add_argument("--srt", type=Path)
    parser.add_argument("--ass", type=Path)
    parser.add_argument("--json", type=Path)
    parser.add_argument("--batch-manifest", type=Path)
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--language", default="pt")
    parser.add_argument("--font-name", default="Montserrat")
    parser.add_argument("--font-size", type=int, default=40)
    parser.add_argument("--margin-v", type=int, default=273)
    args = parser.parse_args()

    if args.batch_manifest:
        items = json.loads(args.batch_manifest.read_text(encoding="utf-8"))
        if not isinstance(items, list) or not items:
            raise ValueError("Manifesto de transcrição vazio.")
        model = load_whisper_model(args.model)
        for index, item in enumerate(items, start=1):
            segments = transcribe_with_model(model, Path(item["audio"]), args.language)
            if not segments:
                raise RuntimeError(f"faster-whisper não encontrou fala em {item['audio']}.")
            srt_path = Path(item["srt"])
            ass_path = Path(item["ass"])
            json_path = Path(item["json"])
            write_srt(segments, srt_path)
            write_ass(srt_path, ass_path, args.font_name, args.font_size, args.margin_v)
            json_path.parent.mkdir(parents=True, exist_ok=True)
            json_path.write_text(json.dumps(segments, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"transcribed={index}/{len(items)} segments={len(segments)}", flush=True)
        return

    if not all((args.audio, args.srt, args.ass, args.json)):
        parser.error("use --audio/--srt/--ass/--json ou --batch-manifest")
    segments = transcribe(args.audio, args.model, args.language)
    if not segments:
        raise RuntimeError("faster-whisper não encontrou fala no áudio TTS.")
    write_srt(segments, args.srt)
    write_ass(args.srt, args.ass, args.font_name, args.font_size, args.margin_v)
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps(segments, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"segments={len(segments)} words={sum(len(row['words']) for row in segments)}")


if __name__ == "__main__":
    main()
