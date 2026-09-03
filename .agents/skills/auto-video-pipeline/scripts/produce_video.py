#!/usr/bin/env python3
"""Autonomous script -> images -> R2V -> narration -> captions -> MP4 pipeline."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import html
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any, Callable


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = next(
    (parent for parent in [Path.cwd(), *Path.cwd().parents] if (parent / "pipeline.config.json").is_file()),
    Path.cwd(),
)
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}


class PipelineError(RuntimeError):
    pass


def log(message: str) -> None:
    print(message, flush=True)


def redact(value: str) -> str:
    value = re.sub(r"(?i)(sk-(?:sp-)?)[A-Za-z0-9_-]{4,}", r"\1[REDACTED]", value)
    value = re.sub(r"(?i)(api[_-]?key[\"']?\s*[:=]\s*[\"']?)[^,\s\"']+", r"\1[REDACTED]", value)
    return value


def atomic_write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    partial = path.with_name(path.name + ".part")
    partial.write_text(content, encoding="utf-8")
    partial.replace(path)


def atomic_write_json(path: Path, data: Any) -> None:
    atomic_write_text(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def resolve_path(value: str | Path, base: Path = PROJECT_ROOT) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else (base / path).resolve()


def load_config() -> dict[str, Any]:
    defaults: dict[str, Any] = {
        "target_duration_s": 60,
        "ratio": "9:16",
        "resolution": "480P",
        "bl_config": "token-plan",
        "image_model": "wan2.7-image",
        "video_model": "happyhorse-1.1-r2v",
        "preferred_clip_duration_s": 15,
        "watermark": False,
        "remote_workers": 2,
        "poll_interval_s": 15,
        "qwen_model": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
        "qwen_language": "Portuguese",
        "qwen_reference": "assets/voice/ptbr-reference.wav",
        "qwen_x_vector_only": True,
        "caption_words_per_line": 8,
        "try_hyperframes": True,
    }
    config_path = PROJECT_ROOT / "pipeline.config.json"
    if config_path.is_file():
        try:
            defaults.update(json.loads(config_path.read_text(encoding="utf-8")))
        except json.JSONDecodeError as exc:
            raise PipelineError(f"pipeline.config.json inválido: {exc}") from exc

    env_map = {
        "ANIMAVIDEO_RATIO": "ratio",
        "ANIMAVIDEO_RESOLUTION": "resolution",
        "ANIMAVIDEO_BL_CONFIG": "bl_config",
        "ANIMAVIDEO_IMAGE_MODEL": "image_model",
        "ANIMAVIDEO_VIDEO_MODEL": "video_model",
        "QWEN_TTS_MODEL": "qwen_model",
        "QWEN_TTS_REFERENCE": "qwen_reference",
        "QWEN_TTS_LANGUAGE": "qwen_language",
    }
    for env_name, key in env_map.items():
        if os.environ.get(env_name):
            defaults[key] = os.environ[env_name]
    for env_name, key in {
        "ANIMAVIDEO_TARGET_DURATION": "target_duration_s",
        "ANIMAVIDEO_REMOTE_WORKERS": "remote_workers",
        "ANIMAVIDEO_POLL_INTERVAL": "poll_interval_s",
        "ANIMAVIDEO_CAPTION_WORDS": "caption_words_per_line",
    }.items():
        if os.environ.get(env_name):
            defaults[key] = float(os.environ[env_name]) if "DURATION" in env_name else int(os.environ[env_name])
    if os.environ.get("ANIMAVIDEO_NO_HYPERFRAMES") == "1":
        defaults["try_hyperframes"] = False
    return defaults


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Produz um vídeo a partir de um roteiro.")
    parser.add_argument("--script-file", "--script", help="Arquivo de texto do roteiro.")
    parser.add_argument("--plan", help="plan.json opcional criado pelo storyboard_director.")
    parser.add_argument("--force", action="store_true", help="Refaz arquivos de mídia do job.")
    parser.add_argument("--skip-hyperframes", action="store_true")
    parser.add_argument("--dry-run", action="store_true", help="Gera plano/log sem chamar provedores.")
    return parser.parse_args()


def find_script(explicit: str | None) -> Path:
    if explicit:
        path = resolve_path(explicit)
        if not path.is_file():
            raise PipelineError(f"Arquivo de roteiro não encontrado: {path}")
        return path
    for candidate in (
        PROJECT_ROOT / "roteiro.txt",
        PROJECT_ROOT / "script.txt",
        PROJECT_ROOT / "input" / "roteiro.txt",
        PROJECT_ROOT / "production" / "inbox" / "roteiro.txt",
    ):
        if candidate.is_file():
            return candidate
    raise PipelineError(
        "Nenhum roteiro encontrado. O agente deve salvar o texto e chamar "
        "./scripts/produce-video --script-file <arquivo>."
    )


def strip_markdown_line(line: str) -> str:
    line = re.sub(r"^\s*#{1,6}\s*", "", line)
    line = re.sub(r"^\s*(?:[-*•]\s+|\d+[.)]\s+)", "", line)
    return re.sub(r"\s+", " ", line).strip()


def infer_title(raw_text: str) -> str:
    lines = [line.strip() for line in raw_text.splitlines() if line.strip()]
    for line in lines:
        candidate = strip_markdown_line(line)
        if line.startswith("#") or re.match(r"(?i)^(título|titulo|title)\s*:", candidate):
            candidate = re.sub(r"(?i)^(título|titulo|title)\s*:\s*", "", candidate)
            if candidate:
                return candidate[:90]
    first = re.split(r"(?<=[.!?])\s+", " ".join(strip_markdown_line(x) for x in lines))[0]
    words = first.split()
    return " ".join(words[:10]).strip(" .,!?:;") or "Vídeo automático"


def clean_narration(raw_text: str) -> str:
    lines: list[str] = []
    for raw_line in raw_text.splitlines():
        if raw_line.strip().startswith("#"):
            continue
        if re.match(r"(?i)^\s*(título|titulo|title)\s*:", raw_line):
            continue
        line = strip_markdown_line(raw_line)
        line = re.sub(r"(?i)^(roteiro|script)\s*:\s*", "", line).strip()
        if not line:
            continue
        if line.startswith(("~~~", chr(96) * 3)):
            continue
        lines.append(line)
    text = re.sub(r"\s+", " ", " ".join(lines)).strip()
    return text


def infer_language(text: str) -> str:
    lowered = text.lower()
    if re.search(r"[ãõçáéíóúâêôà]", lowered) or re.search(
        r"\b(que|não|uma|para|com|você|isso|como|mais|dos|das)\b", lowered
    ):
        return "pt-BR"
    if re.search(r"\b(el|la|los|las|una|para|con|cómo|más)\b", lowered):
        return "es"
    return "en"


def slugify(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    ascii_value = normalized.encode("ascii", "ignore").decode("ascii").lower()
    value = re.sub(r"[^a-z0-9]+", "-", ascii_value).strip("-")
    return value[:54] or "video-automatico"


def sentence_list(text: str) -> list[str]:
    sentences = [part.strip() for part in re.split(r"(?<=[.!?])\s+", text) if part.strip()]
    return sentences or [text.strip()]


def split_into_scene_texts(
    text: str, target_duration: float, preferred_clip_duration: float = 15
) -> list[str]:
    words = text.split()
    word_count = len(words)
    preferred_clip_duration = max(3.0, float(preferred_clip_duration))
    scene_count = max(1, min(12, math.ceil(target_duration / preferred_clip_duration)))
    scene_count = max(1, min(scene_count, word_count or 1))
    sentences = sentence_list(text)

    if len(sentences) >= scene_count:
        groups: list[str] = []
        cursor = 0
        for index in range(scene_count):
            remaining = len(sentences) - cursor
            groups_left = scene_count - index
            take = max(1, (remaining + groups_left - 1) // groups_left)
            groups.append(" ".join(sentences[cursor : cursor + take]))
            cursor += take
        return groups

    groups = []
    cursor = 0
    for index in range(scene_count):
        remaining = len(words) - cursor
        groups_left = scene_count - index
        take = max(1, (remaining + groups_left - 1) // groups_left)
        groups.append(" ".join(words[cursor : cursor + take]))
        cursor += take
    return groups


def make_image_prompt(style: str, scene_text: str, ratio: str) -> str:
    orientation = "vertical" if ratio == "9:16" else "horizontal" if ratio == "16:9" else "square"
    return (
        f"Storyboard frame for a {orientation} one-minute film. {style}. "
        f"Visualize this beat clearly: {scene_text}. "
        "Strong subject, cinematic composition, intentional lighting, rich depth, "
        "coherent palette across the whole film. No readable words, no subtitles, "
        "no logos, no watermarks, no UI, no random extra characters."
    )


def make_video_prompt(scene_text: str) -> str:
    return (
        "Image 1 is the visual reference. Animate this exact scene without changing "
        "the subject, costume, palette, or location. "
        f"Action and emotional beat: {scene_text}. "
        "Use natural subject motion and a subtle cinematic camera move; preserve "
        "composition and continuity. No dialogue, no readable text, no subtitles, "
        "no logos, no watermarks, no cuts, no new characters."
    )


def derive_plan(script_text: str, config: dict[str, Any]) -> dict[str, Any]:
    narration = clean_narration(script_text)
    if not narration:
        raise PipelineError("O roteiro não contém texto narrável.")
    title = infer_title(script_text)
    language = infer_language(narration)
    ratio = str(config.get("ratio", "9:16"))
    target = float(config.get("target_duration_s", 60))
    style = (
        "cinematic editorial illustration with tactile details, soft volumetric light, "
        "deep shadows, restrained teal-and-amber palette, consistent visual language"
    )
    scene_texts = split_into_scene_texts(
        narration, target, float(config.get("preferred_clip_duration_s", 15))
    )
    duration = target / len(scene_texts)
    scenes = []
    cursor = 0.0
    for index, scene_text in enumerate(scene_texts, start=1):
        scene_duration = int(round(max(3.0, min(15.0, duration))))
        scenes.append(
            {
                "id": f"scene-{index:02d}",
                "start_s": round(cursor, 3),
                "duration_s": scene_duration,
                "narration": scene_text,
                "image_prompt": make_image_prompt(style, scene_text, ratio),
                "video_prompt": make_video_prompt(scene_text),
            }
        )
        cursor += scene_duration
    return {
        "title": title,
        "language": language,
        "target_duration_s": target,
        "ratio": ratio,
        "resolution": str(config.get("resolution", "480P")),
        "style_bible": style,
        "full_narration": narration,
        "scenes": scenes,
        "source": "deterministic-fallback-plan",
    }


def normalize_plan(raw_plan: dict[str, Any] | None, script_text: str, config: dict[str, Any]) -> dict[str, Any]:
    if not raw_plan or not isinstance(raw_plan.get("scenes"), list) or not raw_plan["scenes"]:
        return derive_plan(script_text, config)

    plan = dict(raw_plan)
    plan.setdefault("title", infer_title(script_text))
    plan.setdefault("language", infer_language(script_text))
    plan.setdefault("target_duration_s", float(config.get("target_duration_s", 60)))
    plan.setdefault("ratio", config.get("ratio", "9:16"))
    plan.setdefault("resolution", config.get("resolution", "480P"))
    plan.setdefault(
        "style_bible",
        "cinematic editorial illustration with coherent palette and natural lighting",
    )
    scenes = []
    default_duration = float(plan["target_duration_s"]) / max(1, len(plan["scenes"]))
    used_ids: set[str] = set()
    cursor = 0.0
    for index, source in enumerate(plan["scenes"], start=1):
        source = dict(source)
        scene_id = slugify(str(source.get("id") or f"scene-{index:02d}"))
        if not scene_id.startswith("scene-"):
            scene_id = f"scene-{scene_id}"
        base_id = scene_id
        suffix = 2
        while scene_id in used_ids:
            scene_id = f"{base_id}-{suffix}"
            suffix += 1
        used_ids.add(scene_id)
        narration = str(
            source.get("narration")
            or source.get("voiceover")
            or source.get("text")
            or ""
        ).strip()
        if not narration:
            raise PipelineError(f"Cena {scene_id} não possui narration.")
        image_prompt = str(source.get("image_prompt") or "").strip()
        if not image_prompt:
            image_prompt = make_image_prompt(str(plan["style_bible"]), narration, str(plan["ratio"]))
        video_prompt = str(source.get("video_prompt") or "").strip()
        if not video_prompt:
            video_prompt = make_video_prompt(narration)
        if "image 1" not in video_prompt.lower():
            video_prompt = "Image 1 is the visual reference. " + video_prompt
        duration = float(source.get("duration_s", source.get("duration", default_duration)))
        duration = int(round(max(3.0, min(15.0, duration))))
        scenes.append(
            {
                "id": scene_id,
                "start_s": round(cursor, 3),
                "duration_s": duration,
                "narration": narration,
                "image_prompt": image_prompt,
                "video_prompt": video_prompt,
            }
        )
        cursor += duration
    plan["scenes"] = scenes
    plan["full_narration"] = str(
        plan.get("full_narration") or plan.get("voiceover") or " ".join(scene["narration"] for scene in scenes)
    ).strip()
    plan["source"] = "storyboard-director-plan"
    return plan


def fit_plan_to_audio(plan: dict[str, Any], audio_duration: float) -> None:
    scenes = plan["scenes"]
    current_total = sum(float(scene["duration_s"]) for scene in scenes)
    count = len(scenes)
    if current_total <= 0:
        current_total = float(plan.get("target_duration_s", 60))
    if 3.0 * count <= audio_duration <= 15.0 * count:
        scale = audio_duration / current_total
        ideal = [float(scene["duration_s"]) * scale for scene in scenes]
        durations = [int(round(max(3.0, min(15.0, value)))) for value in ideal]
        target_total = int(round(audio_duration))
        difference = target_total - sum(durations)
        order = sorted(
            range(count),
            key=lambda index: ideal[index] - round(ideal[index]),
            reverse=difference > 0,
        )
        while difference:
            changed = False
            for index in order:
                if difference > 0 and durations[index] < 15:
                    durations[index] += 1
                    difference -= 1
                    changed = True
                elif difference < 0 and durations[index] > 3:
                    durations[index] -= 1
                    difference += 1
                    changed = True
                if difference == 0:
                    break
            if not changed:
                break
    else:
        durations = [
            max(3, min(15, round(float(scene["duration_s"]))))
            for scene in scenes
        ]
    cursor = 0.0
    for scene, duration in zip(scenes, durations):
        scene["start_s"] = round(cursor, 3)
        scene["duration_s"] = duration
        cursor += duration
    plan["audio_duration_s"] = round(audio_duration, 3)
    plan["video_duration_s"] = round(cursor, 3)


def locate_executable(name: str, extra: list[Path] | None = None) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    for candidate in extra or []:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def run_command(
    command: list[str],
    *,
    description: str,
    log_path: Path | None = None,
    retries: int = 0,
    timeout: int = 1800,
    allow_failure: bool = False,
) -> subprocess.CompletedProcess[str]:
    last: subprocess.CompletedProcess[str] | None = None
    for attempt in range(retries + 1):
        try:
            result = subprocess.run(
                command,
                cwd=PROJECT_ROOT,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=os.environ.copy(),
            )
        except subprocess.TimeoutExpired as exc:
            raise PipelineError(f"{description} excedeu o timeout de {timeout}s.") from exc
        last = result
        combined = redact((result.stdout or "") + ("\n" + result.stderr if result.stderr else ""))
        if log_path:
            atomic_write_text(log_path, combined)
        if result.returncode == 0:
            return result
        if attempt < retries:
            log(f"{description} falhou; tentando novamente ({attempt + 2}/{retries + 1})")
            time.sleep(min(10, 5 * (attempt + 1)))
    assert last is not None
    if allow_failure:
        return last
    tail = redact((last.stderr or last.stdout or "").strip())[-1200:]
    raise PipelineError(f"{description} falhou (exit {last.returncode}). {tail}")


def ffprobe_duration(path: Path) -> float:
    ffprobe = locate_executable("ffprobe")
    if not ffprobe:
        raise PipelineError("ffprobe não está instalado.")
    result = run_command(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        description=f"sondagem de {path.name}",
        timeout=120,
    )
    try:
        return float(result.stdout.strip())
    except ValueError as exc:
        raise PipelineError(f"ffprobe não retornou duração válida para {path}") from exc


def fit_audio_to_target(path: Path, target_duration: float, job_dir: Path) -> float:
    """Fit short-form narration to an explicit target without dropping speech."""
    current_duration = ffprobe_duration(path)
    if target_duration <= 0 or abs(current_duration - target_duration) <= 0.01:
        return current_duration

    ffmpeg = locate_executable("ffmpeg")
    if not ffmpeg:
        raise PipelineError("ffmpeg não está instalado para ajustar a duração da narração.")

    if current_duration < target_duration:
        filter_graph = f"apad=pad_dur={target_duration - current_duration:.3f}"
    else:
        # Keep the whole sentence when the local voice model runs slightly long.
        tempo = current_duration / target_duration
        filters: list[str] = []
        while tempo > 2.0:
            filters.append("atempo=2.0")
            tempo /= 2.0
        while tempo < 0.5:
            filters.append("atempo=0.5")
            tempo /= 0.5
        filters.append(f"atempo={tempo:.6f}")
        filter_graph = ",".join(filters)

    adjusted = path.with_name(path.stem + ".fit.part" + path.suffix)
    run_command(
        [
            ffmpeg,
            "-y",
            "-i",
            str(path),
            "-vn",
            "-af",
            filter_graph,
            "-t",
            format_seconds(target_duration),
            "-c:a",
            "pcm_s16le",
            str(adjusted),
        ],
        description="ajuste da duração da narração",
        log_path=job_dir / "logs" / "audio-fit.log",
        timeout=600,
    )
    adjusted.replace(path)
    return ffprobe_duration(path)


def qwen_python() -> str:
    candidates: list[Path] = []
    if os.environ.get("QWEN_TTS_PYTHON"):
        candidates.append(Path(os.environ["QWEN_TTS_PYTHON"]).expanduser())
    candidates.extend(
        [
            Path("/home/caio/Área de trabalho/ProjetosPessoais/TTS/qwen3-tts-env/bin/python"),
            PROJECT_ROOT / ".venv" / "bin" / "python",
        ]
    )
    current = Path(sys.executable)
    candidates.append(current)
    for candidate in candidates:
        if not candidate.is_file():
            continue
        try:
            check = subprocess.run(
                [str(candidate), "-c", "import qwen_tts"],
                capture_output=True,
                text=True,
                timeout=30,
            )
            if check.returncode == 0:
                return str(candidate)
        except (OSError, subprocess.TimeoutExpired):
            continue
    raise PipelineError(
        "Qwen3-TTS não foi encontrado. Defina QWEN_TTS_PYTHON para o python de "
        "qwen3-tts-env."
    )


def bl_executable() -> str:
    path = locate_executable(
        "bl",
        [
            Path("/home/caio/.local/bin/bl"),
            Path("/home/caio/.local/node_modules/.bin/bl"),
        ],
    )
    if not path:
        raise PipelineError(
            "CLI bl não encontrado. Instale com npm install -g bailian-cli "
            "ou coloque-o no PATH."
        )
    return path


def check_bailian_auth(bl: str, config_name: str) -> None:
    result = run_command(
        [bl, "auth", "status", "--config", config_name, "--output", "json"],
        description="verificação de autenticação Token Plan",
        timeout=120,
    )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise PipelineError("bl auth status não retornou JSON.") from exc
    if not payload.get("authenticated"):
        raise PipelineError(
            "Perfil Token Plan não autenticado. Execute: "
            "bl auth login --config token-plan --api-key <sua-chave-sk-sp>"
        )
    log(f"Token Plan autenticado ({config_name}).")


def find_existing_image(directory: Path) -> Path | None:
    candidates = sorted(
        (
            path
            for path in directory.glob("*")
            if path.suffix.lower() in IMAGE_EXTENSIONS and path.is_file() and path.stat().st_size > 1000
        ),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


def image_for_scene(
    scene: dict[str, Any],
    *,
    job_dir: Path,
    config: dict[str, Any],
    bl: str,
    force: bool,
) -> Path:
    image_dir = job_dir / "media" / "images" / scene["id"]
    image_dir.mkdir(parents=True, exist_ok=True)
    existing = None if force else find_existing_image(image_dir)
    if existing:
        return existing
    seed = int(hashlib.sha256((job_dir.name + scene["id"]).encode()).hexdigest()[:8], 16) % 2147483647
    image_size = "3:4" if str(config.get("ratio", "9:16")) == "9:16" else str(config.get("ratio", "16:9"))
    command = [
        bl,
        "image",
        "generate",
        "--config",
        str(config["bl_config"]),
        "--model",
        str(config["image_model"]),
        "--prompt",
        str(scene["image_prompt"]),
        "--size",
        image_size,
        "--n",
        "1",
        "--seed",
        str(seed),
        "--watermark",
        str(bool(config.get("watermark", False))).lower(),
        "--out-dir",
        str(image_dir),
        "--out-prefix",
        scene["id"],
        "--quiet",
    ]
    run_command(
        command,
        description=f"imagem {scene['id']}",
        log_path=job_dir / "logs" / f"{scene['id']}-image.log",
        retries=2,
        timeout=900,
    )
    image = find_existing_image(image_dir)
    if not image:
        raise PipelineError(f"bl terminou sem criar imagem para {scene['id']}.")
    return image


def format_seconds(value: float) -> str:
    return str(int(value)) if abs(value - round(value)) < 0.001 else f"{value:.3f}".rstrip("0").rstrip(".")


def prepare_r2v_image(image: Path, job_dir: Path, scene_id: str) -> Path:
    """Create a compact upload copy so large generated PNGs fit the R2V body limit."""
    if image.suffix.lower() in {".jpg", ".jpeg"} and image.stat().st_size < 5_000_000:
        return image
    ffmpeg = locate_executable("ffmpeg")
    if not ffmpeg:
        raise PipelineError("ffmpeg não está instalado para compactar a referência R2V.")
    output = job_dir / "media" / "images" / scene_id / f"{scene_id}-r2v.jpg"
    if output.is_file() and output.stat().st_size > 10_000:
        return output
    run_command(
        [
            ffmpeg,
            "-y",
            "-i",
            str(image),
            "-vf",
            "scale=1080:-2:flags=lanczos",
            "-frames:v",
            "1",
            "-q:v",
            "4",
            "-pix_fmt",
            "yuvj420p",
            str(output),
        ],
        description=f"compactação da referência R2V {scene_id}",
        log_path=job_dir / "logs" / f"{scene_id}-r2v-image.log",
        timeout=600,
    )
    if not output.is_file() or output.stat().st_size <= 10_000:
        raise PipelineError(f"a compactação não criou uma referência válida para {scene_id}")
    return output


def video_for_scene(
    scene: dict[str, Any],
    image: Path,
    *,
    job_dir: Path,
    config: dict[str, Any],
    bl: str,
    force: bool,
) -> tuple[Path, str, str]:
    clips_dir = job_dir / "media" / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)
    output = clips_dir / f"{scene['id']}.mp4"
    if output.is_file() and output.stat().st_size > 10000 and not force:
        try:
            ffprobe_duration(output)
            return output, "r2v", ""
        except PipelineError:
            pass
    partial = clips_dir / f"{scene['id']}.part.mp4"
    if partial.exists():
        partial.unlink()
    seed = int(hashlib.sha256((job_dir.name + scene["id"] + "video").encode()).hexdigest()[:8], 16) % 2147483647
    r2v_image = prepare_r2v_image(image, job_dir, scene["id"])
    command = [
        bl,
        "video",
        "ref",
        "--config",
        str(config["bl_config"]),
        "--model",
        str(config["video_model"]),
        "--prompt",
        str(scene["video_prompt"]),
        "--image",
        str(r2v_image),
        "--resolution",
        str(config.get("resolution", "480P")),
        "--ratio",
        str(config.get("ratio", "9:16")),
        "--duration",
        format_seconds(float(scene["duration_s"])),
        "--seed",
        str(seed),
        "--watermark",
        str(bool(config.get("watermark", False))).lower(),
        "--download",
        str(partial),
        "--poll-interval",
        str(int(config.get("poll_interval_s", 15))),
        "--quiet",
    ]
    try:
        run_command(
            command,
            description=f"animação R2V {scene['id']}",
            log_path=job_dir / "logs" / f"{scene['id']}-video.log",
            retries=2,
            timeout=3600,
        )
        if not partial.is_file() or partial.stat().st_size < 10000:
            raise PipelineError("o download do clipe não criou um MP4 válido")
        ffprobe_duration(partial)
        partial.replace(output)
        return output, "r2v", ""
    except PipelineError as exc:
        reason = redact(str(exc))
        fallback = make_slideshow_clip(scene, image, job_dir, config)
        return fallback, "static-fallback", reason


def canvas_dimensions(ratio: str) -> tuple[int, int]:
    if ratio == "16:9":
        return 1920, 1080
    if ratio == "1:1":
        return 1080, 1080
    return 1080, 1920


def make_slideshow_clip(
    scene: dict[str, Any], image: Path, job_dir: Path, config: dict[str, Any]
) -> Path:
    ffmpeg = locate_executable("ffmpeg")
    if not ffmpeg:
        raise PipelineError("ffmpeg não está instalado; não é possível criar fallback.")
    output = job_dir / "media" / "clips" / f"{scene['id']}.static.mp4"
    width, height = canvas_dimensions(str(config.get("ratio", "9:16")))
    frames = max(1, round(float(scene["duration_s"]) * 30))
    filter_graph = (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},"
        f"zoompan=z='min(zoom+0.0012,1.08)':"
        f"x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
        f"d={frames}:s={width}x{height}:fps=30,format=yuv420p"
    )
    run_command(
        [
            ffmpeg,
            "-y",
            "-loop",
            "1",
            "-i",
            str(image),
            "-vf",
            filter_graph,
            "-t",
            format_seconds(float(scene["duration_s"])),
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            str(output),
        ],
        description=f"fallback estático {scene['id']}",
        log_path=job_dir / "logs" / f"{scene['id']}-fallback.log",
        retries=0,
        timeout=600,
    )
    return output


def normalize_clip(
    scene: dict[str, Any], clip: Path, job_dir: Path, config: dict[str, Any]
) -> Path:
    ffmpeg = locate_executable("ffmpeg")
    if not ffmpeg:
        raise PipelineError("ffmpeg não está instalado.")
    output = job_dir / "media" / "normalized" / f"{scene['id']}.mp4"
    output.parent.mkdir(parents=True, exist_ok=True)
    width, height = canvas_dimensions(str(config.get("ratio", "9:16")))
    filter_graph = (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},setsar=1,fps=30,format=yuv420p,"
        "tpad=stop_mode=clone:stop_duration=10"
    )
    run_command(
        [
            ffmpeg,
            "-y",
            "-i",
            str(clip),
            "-vf",
            filter_graph,
            "-t",
            format_seconds(float(scene["duration_s"])),
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            str(output),
        ],
        description=f"normalização {scene['id']}",
        log_path=job_dir / "logs" / f"{scene['id']}-normalize.log",
        timeout=900,
    )
    return output


def concat_clips(scenes: list[dict[str, Any]], job_dir: Path, config: dict[str, Any]) -> Path:
    ffmpeg = locate_executable("ffmpeg")
    if not ffmpeg:
        raise PipelineError("ffmpeg não está instalado.")
    normalized = [resolve_path(scene["normalized_path"]) for scene in scenes]
    list_path = job_dir / "media" / "concat.txt"
    lines = []
    for path in normalized:
        escaped = path.as_posix().replace("'", "'\\''")
        lines.append(f"file '{escaped}'")
    atomic_write_text(list_path, "\n".join(lines) + "\n")
    output = job_dir / "media" / "montage.mp4"
    run_command(
        [
            ffmpeg,
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(list_path),
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(output),
        ],
        description="montagem dos clipes",
        log_path=job_dir / "logs" / "concat.log",
        timeout=1800,
    )
    return output


def caption_chunks(text: str, max_words: int) -> list[str]:
    tokens = text.split()
    groups: list[str] = []
    current: list[str] = []
    for token in tokens:
        current.append(token)
        if len(current) >= max_words or re.search(r"[.!?…]$", token):
            groups.append(" ".join(current))
            current = []
    if current:
        groups.append(" ".join(current))
    return groups or [text]


def make_captions(text: str, duration: float, max_words: int) -> list[dict[str, Any]]:
    groups = caption_chunks(text, max(2, max_words))
    weights = [max(1, len(re.sub(r"\s+", "", group))) for group in groups]
    total = sum(weights)
    captions: list[dict[str, Any]] = []
    cursor = 0.0
    for index, (group, weight) in enumerate(zip(groups, weights), start=1):
        start = cursor
        end = duration if index == len(groups) else duration * (sum(weights[:index]) / total)
        if end <= start:
            end = min(duration, start + 0.5)
        captions.append({"id": index, "start_s": round(start, 3), "end_s": round(end, 3), "text": group})
        cursor = end
    return captions


def srt_timestamp(seconds: float) -> str:
    millis = max(0, round(seconds * 1000))
    hours, remainder = divmod(millis, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def write_srt(captions: list[dict[str, Any]], path: Path) -> None:
    blocks = []
    for caption in captions:
        blocks.append(
            f"{caption['id']}\n{srt_timestamp(caption['start_s'])} --> "
            f"{srt_timestamp(caption['end_s'])}\n{caption['text']}\n"
        )
    atomic_write_text(path, "\n".join(blocks))


def relative_uri(path: Path, from_file: Path) -> str:
    return Path(os.path.relpath(path, from_file.parent)).as_posix()


def write_hyperframes_index(
    path: Path,
    *,
    scenes: list[dict[str, Any]],
    audio_path: Path,
    captions: list[dict[str, Any]],
    duration: float,
    ratio: str,
    language: str = "pt-BR",
) -> None:
    width, height = canvas_dimensions(ratio)
    video_markup = []
    for scene in scenes:
        normalized_path = resolve_path(scene["normalized_path"])
        src = html.escape(relative_uri(normalized_path, path), quote=True)
        video_markup.append(
            f'    <video id="video-{html.escape(scene["id"])}" class="clip scene-video" '
            f'src="{src}" data-start="{scene["start_s"]}" data-duration="{scene["duration_s"]}" '
            f'data-track-index="0" muted playsinline preload="auto"></video>'
        )
    caption_markup = []
    timeline_markup = []
    for caption in captions:
        cid = f"{int(caption['id']):02d}"
        text_value = html.escape(str(caption["text"]))
        caption_markup.append(
            f'    <div id="caption-{cid}" class="clip caption-clip" '
            f'data-start="{caption["start_s"]}" data-duration="{round(caption["end_s"] - caption["start_s"], 3)}" '
            f'data-track-index="20" data-layout-allow-caption-zone>'
            f'<span id="caption-text-{cid}" class="caption-text">{text_value}</span></div>'
        )
        timeline_markup.append(
            f'      tl.fromTo("#caption-text-{cid}", {{ y: 30, opacity: 0 }}, '
            f'{{ y: 0, opacity: 1, duration: 0.22, ease: "power3.out" }}, '
            f'{float(caption["start_s"]):.3f});'
        )
    audio_src = html.escape(relative_uri(audio_path, path), quote=True)
    content = f"""<!doctype html>
<html lang="{html.escape(language, quote=True)}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width={width}, height={height}" />
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
    <style>
      * {{ box-sizing: border-box; }}
      html, body {{ margin: 0; width: {width}px; height: {height}px; overflow: hidden; background: #05060a; }}
      body {{ font-family: "DejaVu Sans", sans-serif; }}
      #root {{ position: relative; width: {width}px; height: {height}px; overflow: hidden; }}
      .ground {{ position: absolute; inset: 0; z-index: 0;
        background: radial-gradient(circle at 50% 20%, #263451 0%, #0a0d18 55%, #05060a 100%); }}
      .scene-video {{ position: absolute; inset: 0; width: 100%; height: 100%;
        object-fit: cover; z-index: 1; }}
      .caption-clip {{ position: absolute; left: 6%; bottom: 7%; width: 88%; min-height: 8%;
        display: flex; align-items: center; justify-content: center; padding: 22px 30px;
        border-radius: 22px; background: rgba(3, 5, 10, .74); z-index: 5; }}
      .caption-text {{ display: block; max-width: 100%; color: #fff; text-align: center;
        font-size: {28 if ratio == "9:16" else 34}px; line-height: 1.2; font-weight: 700;
        text-shadow: 0 3px 10px rgba(0,0,0,.75); }}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="{duration:.3f}"
         data-width="{width}" data-height="{height}">
      <div id="ground" class="clip ground" data-start="0" data-duration="{duration:.3f}" data-track-index="1"></div>
{os.linesep.join(video_markup)}
      <audio id="narration" class="clip" src="{audio_src}" data-start="0"
             data-duration="{duration:.3f}" data-track-index="10" data-volume="1"></audio>
{os.linesep.join(caption_markup)}
    </div>
    <script>
      window.__timelines = window.__timelines || {{}};
      const tl = gsap.timeline({{ paused: true }});
{os.linesep.join(timeline_markup)}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
"""
    atomic_write_text(path, content)


def escape_filter_path(path: Path) -> str:
    return str(path).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def ffmpeg_fallback(
    montage: Path,
    audio: Path,
    srt: Path,
    output: Path,
    *,
    duration: float,
    ratio: str,
    job_dir: Path,
) -> None:
    ffmpeg = locate_executable("ffmpeg")
    if not ffmpeg:
        raise PipelineError("ffmpeg não está instalado.")
    montage_duration = ffprobe_duration(montage)
    padded = job_dir / "media" / "montage-padded.mp4"
    pad_duration = max(0.0, duration - montage_duration) + 1.0
    width, height = canvas_dimensions(ratio)
    run_command(
        [
            ffmpeg,
            "-y",
            "-i",
            str(montage),
            "-vf",
            f"tpad=stop_mode=clone:stop_duration={pad_duration:.3f}",
            "-t",
            format_seconds(duration),
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-s",
            f"{width}x{height}",
            str(padded),
        ],
        description="padding do montage FFmpeg",
        log_path=job_dir / "logs" / "ffmpeg-pad.log",
        timeout=1800,
    )
    escaped_srt = escape_filter_path(srt)
    subtitle_filter = (
        f"subtitles='{escaped_srt}':"
        "force_style='FontName=DejaVu Sans,FontSize=26,PrimaryColour=&H00FFFFFF,"
        "OutlineColour=&HCC000000,BorderStyle=1,Outline=3,Shadow=0,Alignment=2,MarginV=90'"
    )
    run_command(
        [
            ffmpeg,
            "-y",
            "-i",
            str(padded),
            "-i",
            str(audio),
            "-vf",
            subtitle_filter,
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-t",
            format_seconds(duration),
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-shortest",
            "-movflags",
            "+faststart",
            str(output),
        ],
        description="render final FFmpeg com legendas",
        log_path=job_dir / "logs" / "ffmpeg-final.log",
        timeout=2400,
    )


def try_hyperframes_render(
    *,
    output: Path,
    job_dir: Path,
    config: dict[str, Any],
    skip: bool,
) -> tuple[bool, str]:
    if skip or not bool(config.get("try_hyperframes", True)):
        return False, "desativado"
    wrapper = PROJECT_ROOT / "scripts" / "hyperframes"
    if not wrapper.is_file():
        return False, "wrapper ausente"
    check = run_command(
        [str(wrapper), "check", "--json"],
        description="checagem HyperFrames",
        log_path=job_dir / "logs" / "hyperframes-check.log",
        timeout=900,
        allow_failure=True,
    )
    if check.returncode != 0:
        return False, "check falhou"
    relative_output = output.relative_to(PROJECT_ROOT)
    render = run_command(
        [
            str(wrapper),
            "render",
            "--skill=faceless-explainer",
            "--quality",
            "high",
            "--output",
            str(relative_output),
        ],
        description="render final HyperFrames",
        log_path=job_dir / "logs" / "hyperframes-render.log",
        timeout=3600,
        allow_failure=True,
    )
    if render.returncode != 0 or not output.is_file() or output.stat().st_size < 10000:
        return False, "render falhou"
    return True, "hyperframes"


def update_output_links(final_video: Path, srt: Path, manifest: dict[str, Any]) -> None:
    output_dir = PROJECT_ROOT / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    for link, target in ((output_dir / "video.mp4", final_video), (output_dir / "video.srt", srt)):
        if link.exists() and not link.is_symlink():
            raise PipelineError(f"Não vou sobrescrever arquivo existente: {link}")
        if link.is_symlink():
            link.unlink()
        link.symlink_to(os.path.relpath(target, link.parent))
    atomic_write_json(output_dir / "latest-job.json", {
        "job_id": manifest["job_id"],
        "video": str(final_video.relative_to(PROJECT_ROOT)),
        "subtitle": str(srt.relative_to(PROJECT_ROOT)),
        "duration_s": manifest.get("duration_s"),
        "renderer": manifest.get("renderer"),
    })


def choose_plan_file(explicit: str | None) -> Path | None:
    if not explicit:
        return None
    path = resolve_path(explicit)
    if not path.is_file():
        raise PipelineError(f"Plano não encontrado: {path}")
    return path


def build_manifest(job_id: str, script_text: str, plan: dict[str, Any], job_dir: Path) -> dict[str, Any]:
    return {
        "job_id": job_id,
        "status": "running",
        "script_sha256": hashlib.sha256(script_text.encode("utf-8")).hexdigest(),
        "plan": plan,
        "job_dir": str(job_dir.relative_to(PROJECT_ROOT)),
        "scenes": [],
    }


def save_manifest(job_dir: Path, manifest: dict[str, Any]) -> None:
    atomic_write_json(job_dir / "manifest.json", manifest)


def parallel_process(
    scenes: list[dict[str, Any]],
    worker: Callable[[dict[str, Any]], Any],
    workers: int,
    label: str,
) -> dict[str, Any]:
    results: dict[str, Any] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        future_map = {executor.submit(worker, scene): scene for scene in scenes}
        for future in concurrent.futures.as_completed(future_map):
            scene = future_map[future]
            try:
                results[scene["id"]] = future.result()
            except Exception as exc:
                for pending in future_map:
                    pending.cancel()
                raise PipelineError(f"{label} {scene['id']} falhou: {exc}") from exc
            log(f"{label} pronto: {scene['id']} ({len(results)}/{len(scenes)})")
    return results


def main() -> int:
    args = parse_args()
    config = load_config()
    script_path = find_script(args.script_file)
    script_text = script_path.read_text(encoding="utf-8")
    plan_path = choose_plan_file(args.plan)
    raw_plan = json.loads(plan_path.read_text(encoding="utf-8")) if plan_path else None
    plan = normalize_plan(raw_plan, script_text, config)
    config["ratio"] = plan.get("ratio", config.get("ratio", "9:16"))
    config["resolution"] = plan.get("resolution", config.get("resolution", "480P"))

    plan_fingerprint = json.dumps(raw_plan, ensure_ascii=False, sort_keys=True) if raw_plan else ""
    job_hash = hashlib.sha256((script_text + plan_fingerprint).encode("utf-8")).hexdigest()[:10]
    job_id = f"{slugify(str(plan['title']))}-{job_hash}"
    job_dir = PROJECT_ROOT / "production" / "jobs" / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    (job_dir / "logs").mkdir(exist_ok=True)
    (job_dir / "media").mkdir(exist_ok=True)
    (job_dir / "renders").mkdir(exist_ok=True)
    atomic_write_text(job_dir / "script.txt", script_text)
    atomic_write_text(job_dir / "narration.txt", str(plan["full_narration"]).strip() + "\n")
    atomic_write_json(job_dir / "plan.json", plan)
    manifest = build_manifest(job_id, script_text, plan, job_dir)
    save_manifest(job_dir, manifest)
    log(f"Job: {job_id}")

    if args.dry_run:
        log(f"Plano criado com {len(plan['scenes'])} cenas; nenhuma chamada foi feita.")
        return 0

    try:
        narration_path = job_dir / "media" / "audio" / "narration.wav"
        narration_path.parent.mkdir(parents=True, exist_ok=True)
        tts_language = str(config.get("qwen_language", "Portuguese"))
        if tts_language.lower() == "portuguese" and str(plan.get("language", "")).lower().startswith("en"):
            tts_language = "English"
        qwen_command = [
            qwen_python(),
            str(SCRIPT_DIR / "qwen_tts_local.py"),
            "--text-file",
            str(job_dir / "narration.txt"),
            "--output",
            str(narration_path),
            "--model",
            str(config["qwen_model"]),
            "--reference",
            str(resolve_path(str(config["qwen_reference"]))),
            "--language",
            tts_language,
        ]
        if bool(config.get("qwen_x_vector_only", True)):
            qwen_command.append("--x-vector-only")
        if args.force:
            qwen_command.append("--force")
        run_command(
            qwen_command,
            description="narração local Qwen3-TTS",
            log_path=job_dir / "logs" / "qwen-tts.log",
            timeout=3600,
        )
        audio_duration = ffprobe_duration(narration_path)
        # This plan is an explicitly timed 15-second short; preserve its
        # three-scene cadence while keeping the complete narration audible.
        if float(plan.get("target_duration_s", 0)) <= 15.0:
            audio_duration = fit_audio_to_target(
                narration_path, float(plan["target_duration_s"]), job_dir
            )
        fit_plan_to_audio(plan, audio_duration)
        atomic_write_json(job_dir / "plan.json", plan)
        manifest["plan"] = plan
        save_manifest(job_dir, manifest)
        log(f"Narração pronta: {audio_duration:.2f}s.")

        bl = bl_executable()
        check_bailian_auth(bl, str(config["bl_config"]))
        scenes = plan["scenes"]
        worker_count = max(1, min(4, int(config.get("remote_workers", 2))))
        image_results = parallel_process(
            scenes,
            lambda scene: image_for_scene(
                scene, job_dir=job_dir, config=config, bl=bl, force=args.force
            ),
            worker_count,
            "Imagem",
        )
        for scene in scenes:
            scene["image_path"] = str(image_results[scene["id"]].relative_to(PROJECT_ROOT))
        manifest["scenes"] = [
            {
                **{key: scene[key] for key in ("id", "start_s", "duration_s", "narration", "image_prompt", "video_prompt")},
                "image_path": scene["image_path"],
            }
            for scene in scenes
        ]
        save_manifest(job_dir, manifest)

        video_results = parallel_process(
            scenes,
            lambda scene: video_for_scene(
                scene,
                image_results[scene["id"]],
                job_dir=job_dir,
                config=config,
                bl=bl,
                force=args.force,
            ),
            worker_count,
            "Vídeo",
        )
        for scene in scenes:
            clip, mode, reason = video_results[scene["id"]]
            scene["clip_path"] = str(clip.relative_to(PROJECT_ROOT))
            scene["video_mode"] = mode
            scene["fallback_reason"] = reason
        for entry, scene in zip(manifest["scenes"], scenes):
            entry.update(
                {
                    "clip_path": scene["clip_path"],
                    "video_mode": scene["video_mode"],
                    "fallback_reason": scene["fallback_reason"],
                }
            )
        save_manifest(job_dir, manifest)

        for scene in scenes:
            normalized = normalize_clip(
                scene,
                resolve_path(scene["clip_path"]),
                job_dir,
                config,
            )
            scene["normalized_path"] = str(normalized.relative_to(PROJECT_ROOT))
        montage = concat_clips(scenes, job_dir, config)
        for entry, scene in zip(manifest["scenes"], scenes):
            entry["normalized_path"] = scene["normalized_path"]

        captions = make_captions(
            str(plan["full_narration"]),
            audio_duration,
            int(config.get("caption_words_per_line", 8)),
        )
        srt_path = job_dir / "renders" / "video.srt"
        write_srt(captions, srt_path)
        atomic_write_json(job_dir / "renders" / "captions.json", {"mode": "estimated", "captions": captions})

        write_hyperframes_index(
            PROJECT_ROOT / "index.html",
            scenes=scenes,
            audio_path=narration_path,
            captions=captions,
            duration=audio_duration,
            ratio=str(config.get("ratio", "9:16")),
            language=str(plan.get("language", "pt-BR")),
        )
        write_hyperframes_index(
            job_dir / "index.html",
            scenes=scenes,
            audio_path=narration_path,
            captions=captions,
            duration=audio_duration,
            ratio=str(config.get("ratio", "9:16")),
            language=str(plan.get("language", "pt-BR")),
        )

        final_video = job_dir / "renders" / "video.mp4"
        rendered, renderer = try_hyperframes_render(
            output=final_video,
            job_dir=job_dir,
            config=config,
            skip=args.skip_hyperframes
            or abs(float(plan.get("video_duration_s", audio_duration)) - audio_duration) > 0.25,
        )
        if not rendered:
            ffmpeg_fallback(
                montage,
                narration_path,
                srt_path,
                final_video,
                duration=audio_duration,
                ratio=str(config.get("ratio", "9:16")),
                job_dir=job_dir,
            )
            renderer = "ffmpeg-fallback"

        final_duration = ffprobe_duration(final_video)
        manifest.update(
            {
                "status": "complete",
                "renderer": renderer,
                "duration_s": round(final_duration, 3),
                "audio_path": str(narration_path.relative_to(PROJECT_ROOT)),
                "srt_path": str(srt_path.relative_to(PROJECT_ROOT)),
                "captions_mode": "estimated",
                "video_path": str(final_video.relative_to(PROJECT_ROOT)),
                "fallback_scenes": [
                    scene["id"] for scene in scenes if scene.get("video_mode") == "static-fallback"
                ],
            }
        )
        save_manifest(job_dir, manifest)
        update_output_links(final_video, srt_path, manifest)
        log(f"PRONTO: output/video.mp4 ({final_duration:.2f}s; renderer={renderer})")
        if manifest["fallback_scenes"]:
            log("Aviso: fallback estático em " + ", ".join(manifest["fallback_scenes"]))
        return 0
    except Exception as exc:
        manifest["status"] = "failed"
        manifest["error"] = redact(str(exc))
        save_manifest(job_dir, manifest)
        print(f"FALHA: {manifest['error']}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
