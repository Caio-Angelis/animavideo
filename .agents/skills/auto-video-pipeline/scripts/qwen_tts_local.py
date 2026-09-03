#!/usr/bin/env python3
"""Local Qwen3-TTS runner used by the animavideo pipeline."""

from __future__ import annotations

import argparse
import getpass
import os
import re
import sys
from pathlib import Path


def user_home() -> Path:
    try:
        import pwd

        return Path(pwd.getpwuid(os.getuid()).pw_dir)
    except Exception:
        return Path.home()


def find_cached_model(requested: str) -> str:
    requested_path = Path(requested).expanduser()
    if requested_path.exists():
        return str(requested_path.resolve())

    if requested.startswith("Qwen/"):
        model_name = requested.split("/", 1)[1]
    else:
        model_name = requested

    cache_root = Path(os.environ.get("HF_HOME", user_home() / ".cache" / "huggingface"))
    model_root = cache_root / "hub" / ("models--" + requested.replace("/", "--"))
    snapshots = sorted(
        (p for p in (model_root / "snapshots").glob("*") if p.is_dir()),
        key=lambda p: p.stat().st_mtime,
    )
    if snapshots:
        return str(snapshots[-1])

    fallback_root = cache_root / "hub" / ("models--Qwen--" + model_name)
    snapshots = sorted(
        (p for p in (fallback_root / "snapshots").glob("*") if p.is_dir()),
        key=lambda p: p.stat().st_mtime,
    )
    if snapshots:
        return str(snapshots[-1])

    return requested


def language_name(value: str) -> str:
    names = {
        "pt": "Portuguese",
        "pt-br": "Portuguese",
        "portuguese": "Portuguese",
        "português": "Portuguese",
        "en": "English",
        "en-us": "English",
        "english": "English",
        "es": "Spanish",
        "spanish": "Spanish",
        "auto": "Auto",
    }
    return names.get(value.strip().lower(), value)


def sentence_chunks(text: str, max_chars: int = 520) -> list[str]:
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s.strip()]
    if not sentences:
        sentences = [text.strip()]

    chunks: list[str] = []
    current = ""
    for sentence in sentences:
        if len(sentence) <= max_chars and len(current) + len(sentence) + 1 <= max_chars:
            current = (current + " " + sentence).strip()
            continue
        if current:
            chunks.append(current)
        if len(sentence) <= max_chars:
            current = sentence
            continue
        words = sentence.split()
        current = ""
        for word in words:
            if len(current) + len(word) + 1 > max_chars and current:
                chunks.append(current)
                current = word
            else:
                current = (current + " " + word).strip()
    if current:
        chunks.append(current)
    return chunks


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Synthesize narration with local Qwen3-TTS.")
    parser.add_argument("--text-file", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="Qwen/Qwen3-TTS-12Hz-1.7B-Base")
    parser.add_argument("--reference", required=True)
    parser.add_argument("--ref-text", default="")
    parser.add_argument("--language", default="Portuguese")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--x-vector-only", action="store_true")
    parser.add_argument("--force", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    text = Path(args.text_file).read_text(encoding="utf-8").strip()
    if not text:
        raise SystemExit("O roteiro está vazio; não há narração para sintetizar.")

    output = Path(args.output).expanduser().resolve()
    reference = Path(args.reference).expanduser().resolve()
    if not reference.is_file():
        raise SystemExit(f"Referência de voz não encontrada: {reference}")
    if output.is_file() and output.stat().st_size > 0 and not args.force:
        print(f"Qwen TTS reutilizado: {output}")
        return 0

    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    try:
        import numpy as np
        import soundfile as sf
        import torch
        from qwen_tts import Qwen3TTSModel
    except Exception as exc:
        raise SystemExit(
            "Não foi possível importar o Qwen3-TTS no ambiente local. "
            "Use QWEN_TTS_PYTHON apontando para qwen3-tts-env."
        ) from exc

    if args.device == "auto":
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
    else:
        device = args.device
    dtype = torch.bfloat16 if device.startswith("cuda") else torch.float32
    model_path = find_cached_model(args.model)
    print(f"Carregando Qwen3-TTS: {model_path} ({device})", flush=True)

    load_kwargs = {"device_map": device, "dtype": dtype}
    try:
        model = Qwen3TTSModel.from_pretrained(
            model_path, attn_implementation="sdpa", **load_kwargs
        )
    except (TypeError, ValueError):
        model = Qwen3TTSModel.from_pretrained(model_path, **load_kwargs)

    x_vector_only = bool(args.x_vector_only)
    if not x_vector_only and not args.ref_text.strip():
        raise SystemExit("--ref-text é obrigatório quando --x-vector-only não é usado.")

    prompt_kwargs = {
        "ref_audio": str(reference),
        "x_vector_only_mode": x_vector_only,
    }
    if not x_vector_only:
        prompt_kwargs["ref_text"] = args.ref_text.strip()
    clone_prompt = model.create_voice_clone_prompt(**prompt_kwargs)

    common = {
        "language": language_name(args.language),
        "voice_clone_prompt": clone_prompt,
        "max_new_tokens": 2048,
        "do_sample": True,
        "top_k": 50,
        "top_p": 0.9,
        "temperature": 0.75,
        "repetition_penalty": 1.05,
    }

    try:
        wavs, sample_rate = model.generate_voice_clone(text=text, **common)
        audio = np.asarray(wavs[0], dtype=np.float32)
    except Exception as first_error:
        print(
            "A síntese integral falhou; tentando segmentos menores: "
            + type(first_error).__name__,
            file=sys.stderr,
            flush=True,
        )
        pieces = []
        sample_rate = 24000
        for chunk in sentence_chunks(text):
            wavs, sample_rate = model.generate_voice_clone(text=chunk, **common)
            pieces.append(np.asarray(wavs[0], dtype=np.float32))
        silence = np.zeros(max(1, int(sample_rate * 0.08)), dtype=np.float32)
        audio = np.concatenate(
            [piece if i == 0 else np.concatenate([silence, piece]) for i, piece in enumerate(pieces)]
        )

    audio = np.nan_to_num(audio, nan=0.0, posinf=0.0, neginf=0.0)
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak > 0.98:
        audio = audio * (0.98 / peak)
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_name(output.stem + ".part" + output.suffix)
    sf.write(str(partial), audio, int(sample_rate), subtype="PCM_16")
    partial.replace(output)
    print(f"Qwen TTS pronto: {output} ({sample_rate} Hz)", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit("Síntese interrompida.") from None
