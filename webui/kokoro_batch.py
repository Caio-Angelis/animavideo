#!/usr/bin/env python3
"""Generate several Portuguese Kokoro WAVs while loading the model once."""

from __future__ import annotations

import argparse
import json
import wave
from pathlib import Path

import numpy as np
from kokoro import KPipeline


def generate_item(pipeline: KPipeline, item: dict) -> None:
    text = str(item.get("text", "")).strip()
    voice = str(item.get("voice", "pm_alex"))
    output = Path(item["output"])
    if not text:
        raise ValueError(f"Texto vazio para {output.name}.")
    output.parent.mkdir(parents=True, exist_ok=True)

    with wave.open(str(output.resolve()), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(24_000)
        for result in pipeline(text, voice=voice, speed=1.0, split_pattern=r"\n+"):
            if result.audio is None:
                continue
            samples = np.clip(result.audio.numpy() * 32767, -32768, 32767).astype(np.int16)
            wav_file.writeframes(samples.tobytes())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    items = json.loads(args.manifest.read_text(encoding="utf-8"))
    if not isinstance(items, list) or not items:
        raise ValueError("Manifesto Kokoro vazio.")

    pipeline = KPipeline(lang_code="p")
    for index, item in enumerate(items, start=1):
        generate_item(pipeline, item)
        print(f"generated={index}/{len(items)}", flush=True)


if __name__ == "__main__":
    main()
