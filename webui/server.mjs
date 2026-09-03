import http from "node:http";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CURRENT_FILE = fileURLToPath(import.meta.url);
const WEBUI_DIR = path.dirname(CURRENT_FILE);
const PROJECT_DIR = path.resolve(WEBUI_DIR, "..");
const PUBLIC_DIR = path.join(WEBUI_DIR, "public");
const OUTPUT_DIR = path.join(PROJECT_DIR, "outputs");
const KEY_FILE = path.resolve(process.env.TOKEN_PLAN_KEY_FILE || path.join(PROJECT_DIR, "password.txt"));

const HOST = process.env.WEBUI_HOST || "127.0.0.1";
const PORT = Number(process.env.WEBUI_PORT || 8787);
const TOKEN_PLAN_BASE_URL = (process.env.TOKEN_PLAN_BASE_URL || "https://token-plan.ap-southeast-1.maas.aliyuncs.com").replace(/\/$/, "");
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const POLL_INTERVAL_MS = Number(process.env.WEBUI_POLL_INTERVAL_MS || 5_000);
const MAX_POLLS = Number(process.env.WEBUI_MAX_POLLS || 120);
const MAX_CONCURRENT_JOBS = Number(process.env.WEBUI_CONCURRENCY || 2);
const BL_COMMAND_TIMEOUT_MS = Number(process.env.WEBUI_BL_TIMEOUT_MS || 120_000);
const MATRIX_OUTPUT_LIMIT_RAW = Number(process.env.WEBUI_MATRIX_OUTPUT_LIMIT || 27);
const MATRIX_OUTPUT_LIMIT = Number.isInteger(MATRIX_OUTPUT_LIMIT_RAW)
  ? Math.max(1, Math.min(27, MATRIX_OUTPUT_LIMIT_RAW))
  : 27;
const VIDEO_ENCODER_MODE = String(process.env.WEBUI_VIDEO_ENCODER || "auto").trim().toLowerCase();
const NVENC_VIDEO_ARGS = [
  "-c:v", "h264_nvenc", "-preset", process.env.WEBUI_NVENC_PRESET || "p5",
  "-rc", "vbr", "-cq", process.env.WEBUI_NVENC_CQ || "19", "-b:v", "0",
  "-pix_fmt", "yuv420p",
];
const CPU_VIDEO_ARGS = [
  "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
];
const KOKORO_BIN = path.resolve(process.env.KOKORO_BIN || path.join(PROJECT_DIR, "..", "kokoro", "Kokoro", "venv", "bin", "kokoro"));
const KOKORO_PYTHON = path.resolve(process.env.KOKORO_PYTHON || path.join(PROJECT_DIR, "..", "kokoro", "Kokoro", "venv", "bin", "python"));
const KOKORO_VOICES = ["pm_alex", "pf_dora", "pm_santa"];
const PIPER_VOICE = "piper_faber";
const PIPER_BIN = path.resolve(process.env.PIPER_BIN || path.join(os.homedir(), ".venvs", "animavideo-piper", "bin", "piper"));
const PIPER_MODEL = path.resolve(process.env.PIPER_MODEL || path.join(os.homedir(), ".cache", "animavideo", "voices", "pt_BR-faber-medium.onnx"));
const PIPER_CONFIG = path.resolve(process.env.PIPER_CONFIG || `${PIPER_MODEL}.json`);
const TTS_PREVIEW_DIR = path.resolve(process.env.TTS_PREVIEW_DIR || path.join(os.homedir(), ".cache", "animavideo", "tts-previews"));
const TTS_PREVIEW_MAX_CHARS = 280;
const PIPER_VOICE_DIR = path.dirname(PIPER_MODEL);
const PIPER_PORTUGUESE_VOICES = [
  { id: PIPER_VOICE, label: "Piper Faber · locutor BR", language: "pt-BR", model: PIPER_MODEL, config: PIPER_CONFIG, group: "Piper · português brasileiro" },
  { id: "piper_cadu", label: "Piper Cadu · pt-BR", language: "pt-BR", model: path.join(PIPER_VOICE_DIR, "pt_BR-cadu-medium.onnx"), config: path.join(PIPER_VOICE_DIR, "pt_BR-cadu-medium.onnx.json"), group: "Piper · português brasileiro" },
  { id: "piper_edresson", label: "Piper Edresson · pt-BR", language: "pt-BR", model: path.join(PIPER_VOICE_DIR, "pt_BR-edresson-low.onnx"), config: path.join(PIPER_VOICE_DIR, "pt_BR-edresson-low.onnx.json"), group: "Piper · português brasileiro" },
  { id: "piper_jeff", label: "Piper Jeff · pt-BR", language: "pt-BR", model: path.join(PIPER_VOICE_DIR, "pt_BR-jeff-medium.onnx"), config: path.join(PIPER_VOICE_DIR, "pt_BR-jeff-medium.onnx.json"), group: "Piper · português brasileiro" },
  { id: "piper_tugao", label: "Piper Tugão · pt-PT", language: "pt-PT", model: path.join(PIPER_VOICE_DIR, "pt_PT-tugão-medium.onnx"), config: path.join(PIPER_VOICE_DIR, "pt_PT-tugão-medium.onnx.json"), group: "Piper · português europeu" },
];
const KOKORO_VOICE_LABELS = {
  pm_alex: "Kokoro Alex · pt-BR",
  pf_dora: "Kokoro Dora · pt-BR",
  pm_santa: "Kokoro Santa · pt-BR",
};
const TTS_VOICE_IDS = [...PIPER_PORTUGUESE_VOICES.map((voice) => voice.id), ...KOKORO_VOICES];
const TTS_VOICE_DEFINITIONS = [
  ...PIPER_PORTUGUESE_VOICES.map(({ id, label, language, group }) => ({ id, label, engine: "piper", language, group })),
  ...KOKORO_VOICES.map((voice) => ({ id: voice, label: KOKORO_VOICE_LABELS[voice], engine: "kokoro", language: "pt-BR", group: "Kokoro · português brasileiro" })),
];
const KOKORO_BATCH_SCRIPT = path.join(WEBUI_DIR, "kokoro_batch.py");
const CAPTION_SCRIPT = path.join(WEBUI_DIR, "local_caption_pipeline.py");
const WHISPER_PYTHON = path.resolve(process.env.WHISPER_PYTHON || path.join(PROJECT_DIR, "..", "AmazonPost", "gerar_reviews_video", ".venv", "bin", "python"));
const WHISPER_MODEL = process.env.WHISPER_MODEL || "large-v3";
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || "pt";
const CAPTION_FONT_DIR = path.resolve(process.env.CAPTION_FONT_DIR || path.join(PROJECT_DIR, "..", "meu_saas_cortes", "assets", "fonts"));

const MODEL_DEFINITIONS = [
  {
    id: "happyhorse-1.1-t2v",
    label: "HappyHorse 1.1 · Texto → vídeo",
    mode: "text",
    description: "Cria a cena a partir do prompt, com áudio gerado pelo modelo.",
    requiresImage: false,
  },
  {
    id: "happyhorse-1.1-i2v",
    label: "HappyHorse 1.1 · Imagem → vídeo",
    mode: "image",
    description: "Usa a imagem enviada como primeiro quadro e anima a cena.",
    requiresImage: true,
  },
  {
    id: "happyhorse-1.1-r2v",
    label: "HappyHorse 1.1 · Referência → vídeo",
    mode: "reference",
    description: "Mantém a identidade visual da imagem de referência durante a ação.",
    requiresImage: true,
  },
];

const MODELS = new Map(MODEL_DEFINITIONS.map((model) => [model.id, model]));
const jobs = new Map();
const pendingJobs = [];
let activeJobs = 0;
let tokenPlanKey = null;
let keyLoadError = null;

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function redactSecrets(value) {
  return String(value || "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/sk-(?:sp-)?[A-Za-z0-9._-]+/g, "[redacted]");
}

async function loadTokenPlanKey() {
  try {
    const raw = await fs.readFile(KEY_FILE, "utf8");
    const key = raw.trim();
    if (!/^sk-sp-[A-Za-z0-9._-]+$/.test(key)) {
      throw new Error("password.txt não contém uma chave Token Plan válida.");
    }
    tokenPlanKey = key;
    keyLoadError = null;
  } catch (error) {
    tokenPlanKey = null;
    keyLoadError = redactSecrets(error.message);
  }
}

function makeBlEnvironment() {
  if (!tokenPlanKey) {
    throw new Error(keyLoadError || "A chave Token Plan não está disponível.");
  }

  const env = { ...process.env };
  // The UI always uses the dedicated Token Plan pair, even if the shell has
  // another DashScope key or endpoint exported.
  env.DASHSCOPE_API_KEY = tokenPlanKey;
  env.DASHSCOPE_BASE_URL = TOKEN_PLAN_BASE_URL;
  env.NO_COLOR = "1";
  return env;
}

function runBl(args, timeoutMs = BL_COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn("bl", args, {
      cwd: PROJECT_DIR,
      env: makeBlEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_500).unref();
    }, timeoutMs);

    const append = (target, chunk) => {
      const text = chunk.toString();
      return (target + text).slice(-1_000_000);
    };

    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, timedOut, stdout, stderr });
    });
  });
}

function runCommand(command, args, timeoutMs = 180_000, inputText = null, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: PROJECT_DIR,
      env: { ...process.env, ...extraEnv, NO_COLOR: "1" },
      stdio: [inputText === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_500).unref();
    }, timeoutMs);
    const append = (target, chunk) => (target + chunk.toString()).slice(-1_000_000);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    if (inputText !== null) child.stdin.end(inputText);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, timedOut, stdout, stderr });
    });
  });
}

function isCudaFailure(result) {
  return /cuda|outofmemory|cublas|hip error|rocm/i.test(`${result?.stderr || ""}\n${result?.stdout || ""}`);
}

async function runKokoroCommand(command, args, timeoutMs = 600_000) {
  const result = await runCommand(command, args, timeoutMs);
  if (result.code === 0 || !isCudaFailure(result)) return result;
  console.warn("[webui] Kokoro ficou sem VRAM; repetindo a narração no CPU.");
  return runCommand(command, args, timeoutMs, null, { CUDA_VISIBLE_DEVICES: "" });
}

async function runFfmpegVideo(prefixArgs, suffixArgs, timeoutMs = 180_000) {
  const runWithEncoder = (encoderArgs) => runCommand(
    "ffmpeg",
    [...prefixArgs, ...encoderArgs, ...suffixArgs],
    timeoutMs,
  );

  if (VIDEO_ENCODER_MODE !== "libx264") {
    const gpuResult = await runWithEncoder(NVENC_VIDEO_ARGS);
    if (gpuResult.code === 0) return gpuResult;
    const detail = gpuResult.timedOut
      ? "tempo esgotado"
      : (gpuResult.stderr || "falha do encoder").trim();
    console.warn(`[webui] NVENC falhou; repetindo este render com libx264: ${redactSecrets(detail).slice(-500)}`);
  }
  return runWithEncoder(CPU_VIDEO_ARGS);
}

function parseJsonOutput(text) {
  const clean = String(text || "").trim();
  if (!clean) return null;
  try {
    return JSON.parse(clean);
  } catch {
    const first = clean.indexOf("{");
    const last = clean.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(clean.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function blFailure(result, fallback = "O comando do Token Plan falhou.") {
  if (result?.timedOut) return "O comando do Token Plan excedeu o tempo limite; verifique a conexão e tente novamente.";
  const payload = parseJsonOutput(result?.stdout);
  const message = payload?.message || payload?.error?.message || payload?.code;
  if (message) return redactSecrets(message);
  const stderr = redactSecrets(result?.stderr).trim();
  return stderr || fallback;
}

function getTaskId(payload) {
  return payload?.output?.task_id || payload?.task_id || "";
}

function getTaskStatus(payload) {
  return payload?.output?.task_status || payload?.task_status || "";
}

function parseTaskPayload(result) {
  const payload = parseJsonOutput(result?.stdout);
  if (payload) return payload;
  const text = `${result?.stdout || ""}\n${result?.stderr || ""}`.toUpperCase();
  const match = text.match(/\b(PENDING|RUNNING|SUCCEEDED|FAILED|CANCELED|UNKNOWN)\b/);
  return match ? { output: { task_status: match[1] } } : null;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function probeDuration(filePath) {
  const probe = await runCommand("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", filePath,
  ], 30_000);
  if (probe.code !== 0) return null;
  const duration = Number.parseFloat(probe.stdout.trim());
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function buildAtempoFilter(tempo) {
  let factor = tempo;
  const filters = [];
  while (factor > 2) {
    filters.push("atempo=2.0");
    factor /= 2;
  }
  while (factor < 0.5) {
    filters.push("atempo=0.5");
    factor /= 0.5;
  }
  filters.push(`atempo=${factor.toFixed(8)}`);
  return filters.join(",");
}

function safeOutputName(jobId) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${stamp}-${jobId}.mp4`;
}

function publicJob(job) {
  return {
    id: job.id,
    kind: job.kind || "single",
    taskId: job.taskId || null,
    status: job.status,
    progress: job.progress,
    message: job.message,
    model: job.model,
    prompt: job.prompt,
    prompts: job.prompts || null,
    currentSegment: job.currentSegment || null,
    segmentStatuses: job.segmentStatuses || null,
    totalSegments: job.totalSegments || null,
    completedSegments: job.completedSegments || 0,
    totalOutputs: job.totalOutputs || null,
    completedOutputs: job.completedOutputs || 0,
    currentOutput: job.currentOutput || null,
    outputFiles: (job.outputFiles || []).map((output) => ({
      filename: output.filename,
      label: output.label,
      size: output.size,
      videoUrl: `/outputs/${encodeURIComponent(output.filename)}`,
    })),
    totalDuration: job.totalDuration || job.duration || null,
    finalDuration: job.finalDuration || null,
    ttsVoice: job.ttsVoice || null,
    hasTts: Boolean(job.ttsText || job.ttsEntries || job.matrixTts),
    ttsOriginalDuration: job.ttsOriginalDuration || null,
    ttsTempo: job.ttsTempo || null,
    captionsReady: Boolean(job.subtitleSrt || job.captionsReady),
    hasReference: job.hasReference,
    filename: job.filename || null,
    videoUrl: job.filename ? `/outputs/${encodeURIComponent(job.filename)}` : null,
    size: job.size || null,
    error: job.error || null,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt || null,
  };
}

function updateJob(job, patch) {
  Object.assign(job, patch);
  job.updatedAt = new Date().toISOString();
}

function buildBlArgs(job, imagePath) {
  const model = MODELS.get(job.model);
  const common = [
    "--config", "token-plan",
    "--output", "json",
    "--model", job.model,
    "--prompt", job.apiPrompt,
    "--resolution", job.resolution,
    "--ratio", job.ratio,
    "--duration", String(job.duration),
    "--watermark", "false",
    "--async",
  ];

  if (model.mode === "reference") {
    return ["video", "ref", ...common, "--image", imagePath];
  }

  const args = ["video", "generate", ...common];
  if (model.mode === "image") args.push("--image", imagePath);
  return args;
}

async function generateVideoFile(job, prompt, imagePath, outputPath, segmentIndex = 0, totalSegments = 1) {
  const model = MODELS.get(job.model);
  const requestJob = {
    ...job,
    apiPrompt: model.mode === "reference"
      ? `Image 1 is the visual reference. Animate the subject according to this instruction: ${prompt}`
      : prompt,
  };
  const createResult = await runBl(buildBlArgs(requestJob, imagePath));
  if (createResult.code !== 0) {
    throw new Error(blFailure(createResult, "Não foi possível criar a tarefa de vídeo."));
  }
  const createPayload = parseJsonOutput(createResult.stdout);
  const taskId = getTaskId(createPayload);
  if (!taskId) throw new Error(blFailure(createResult, "A API não retornou um task_id."));

  updateJob(job, {
    taskId,
    status: "PENDING",
    currentSegment: segmentIndex + 1,
    progress: Math.round((segmentIndex / totalSegments) * 82) + 4,
    message: `Vídeo ${segmentIndex + 1}/${totalSegments} enfileirado…`,
  });
  job.segmentStatuses[segmentIndex] = "PENDING";

  let completed = false;
  let pollFailures = 0;
  for (let poll = 1; poll <= MAX_POLLS; poll += 1) {
    await sleep(POLL_INTERVAL_MS);
    const taskResult = await runBl([
      "video", "task", "get",
      "--config", "token-plan",
      "--output", "json",
      "--task-id", taskId,
    ], Math.min(BL_COMMAND_TIMEOUT_MS, 30_000));
    const taskPayload = parseTaskPayload(taskResult);
    if (taskResult.code !== 0 || !taskPayload) {
      pollFailures += 1;
      if (pollFailures >= 6) {
        throw new Error(blFailure(taskResult, "Não foi possível consultar o status da tarefa."));
      }
      updateJob(job, {
        status: "PENDING",
        progress: Math.min(84, job.progress + 1),
        message: `Conexão instável no vídeo ${segmentIndex + 1}/${totalSegments}; tentando novamente (${pollFailures}/6)…`,
      });
      continue;
    }
    pollFailures = 0;

    const taskStatus = getTaskStatus(taskPayload).toUpperCase();
    if (taskStatus === "SUCCEEDED") {
      job.segmentStatuses[segmentIndex] = "DOWNLOADING";
      completed = true;
      break;
    }
    if (["FAILED", "CANCELED", "UNKNOWN"].includes(taskStatus)) {
      const taskMessage = taskPayload?.output?.message || taskPayload?.message || taskStatus;
      throw new Error(`A tarefa ${segmentIndex + 1}/${totalSegments} terminou com status ${taskStatus}: ${redactSecrets(taskMessage)}`);
    }

    const progress = Math.min(
      86,
      Math.round(4 + ((segmentIndex + Math.min(1, poll / Math.max(1, MAX_POLLS))) / totalSegments) * 82),
    );
    updateJob(job, {
      status: taskStatus === "RUNNING" ? "RUNNING" : "PENDING",
      progress,
      message: taskStatus === "RUNNING"
        ? `Gerando vídeo ${segmentIndex + 1}/${totalSegments}…`
        : `Vídeo ${segmentIndex + 1}/${totalSegments} aguardando na fila…`,
    });
    job.segmentStatuses[segmentIndex] = taskStatus === "RUNNING" ? "RUNNING" : "PENDING";
  }

  if (!completed) throw new Error(`O vídeo ${segmentIndex + 1}/${totalSegments} excedeu o tempo máximo de espera.`);

  updateJob(job, {
    status: "DOWNLOADING",
    progress: Math.min(90, 8 + Math.round(((segmentIndex + 1) / totalSegments) * 78)),
    message: `Baixando vídeo ${segmentIndex + 1}/${totalSegments}…`,
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const partPath = `${outputPath}.part.mp4`;
  const downloadResult = await runBl([
    "video", "download",
    "--config", "token-plan",
    "--quiet",
    "--task-id", taskId,
    "--out", partPath,
  ]);
  if (downloadResult.code !== 0) {
    throw new Error(blFailure(downloadResult, `O download do vídeo ${segmentIndex + 1}/${totalSegments} falhou.`));
  }
  const stat = await fs.stat(partPath);
  if (stat.size === 0) throw new Error(`O vídeo ${segmentIndex + 1}/${totalSegments} foi baixado vazio.`);
  await fs.rename(partPath, outputPath);
  job.segmentStatuses[segmentIndex] = "SUCCEEDED";
  return { outputPath, size: stat.size };
}

function getPiperVoice(voice) {
  return PIPER_PORTUGUESE_VOICES.find((candidate) => candidate.id === voice) || null;
}

function isPiperVoice(voice) {
  return Boolean(getPiperVoice(voice));
}

function ttsEngineLabel(voice) {
  const definition = TTS_VOICE_DEFINITIONS.find((candidate) => candidate.id === voice);
  return definition?.label || `Kokoro ${voice}`;
}

async function generatePiperAudio(text, audioPath, voice = PIPER_VOICE) {
  const piperVoice = getPiperVoice(voice);
  if (!piperVoice) throw new Error(`Voz Piper desconhecida: ${voice}`);
  try {
    await Promise.all([fs.access(PIPER_BIN), fs.access(piperVoice.model), fs.access(piperVoice.config)]);
  } catch (error) {
    throw new Error(`${piperVoice.label} não está configurado: ${redactSecrets(error.message || error)}`);
  }
  const args = [
    "--model", piperVoice.model,
    "--config", piperVoice.config,
    "--output-file", audioPath,
  ];
  if (Number.isInteger(piperVoice.speaker)) args.push("--speaker", String(piperVoice.speaker));
  const result = await runCommand(PIPER_BIN, args, 600_000, `${String(text || "").trim()}\n`);
  if (result.code !== 0) {
    const detail = result.timedOut
      ? "O Piper excedeu o tempo limite."
      : (result.stderr || "O Piper não conseguiu gerar o áudio.").trim();
    throw new Error(`TTS ${piperVoice.label} falhou: ${redactSecrets(detail).slice(-800)}`);
  }
  const stat = await fs.stat(audioPath);
  if (stat.size === 0) throw new Error(`O ${piperVoice.label} gerou um áudio vazio.`);
  return audioPath;
}

async function generateKokoroVoiceAudio(text, audioPath, textPath, voice) {
  await fs.writeFile(textPath, `${text}\n`, { mode: 0o600 });
  const result = await runKokoroCommand(KOKORO_BIN, [
    "--language", "p",
    "--voice", voice,
    "--input-file", textPath,
    "--output-file", audioPath,
  ], 600_000);
  if (result.code !== 0) {
    const detail = result.timedOut
      ? "O Kokoro excedeu o tempo limite."
      : (result.stderr || "O Kokoro não conseguiu gerar o áudio.").trim();
    throw new Error(`TTS Kokoro falhou: ${redactSecrets(detail).slice(-800)}`);
  }
  const stat = await fs.stat(audioPath);
  if (stat.size === 0) throw new Error("O Kokoro gerou um áudio vazio.");
  return audioPath;
}

async function generateKokoroAudio(job, cycleDirectory) {
  const textPath = path.join(cycleDirectory, "tts.txt");
  const audioPath = path.join(cycleDirectory, "tts.wav");
  updateJob(job, {
    status: "SYNTHESIZING_TTS",
    progress: 87,
    message: `Gerando narração local com ${ttsEngineLabel(job.ttsVoice)}…`,
  });
  if (isPiperVoice(job.ttsVoice)) {
    return generatePiperAudio(job.ttsText, audioPath, job.ttsVoice);
  }
  return generateKokoroVoiceAudio(job.ttsText, audioPath, textPath, job.ttsVoice);
}

function defaultPreviewText(voice) {
  return "Olá! Esta é uma prévia rápida desta voz. Compare o timbre, a clareza e o ritmo antes de escolher.";
}

const ttsPreviewJobs = new Map();

async function generateTtsPreview(voice, requestedText = "") {
  if (!TTS_VOICE_IDS.includes(voice)) throw new HttpError(400, "Voz TTS inválida.");
  const text = String(requestedText || "").trim().slice(0, TTS_PREVIEW_MAX_CHARS) || defaultPreviewText(voice);
  const cacheKey = crypto.createHash("sha256").update(`${voice}\n${text}`).digest("hex").slice(0, 20);
  const safeVoice = voice.replace(/[^a-zA-Z0-9_-]/g, "_");
  const audioPath = path.join(TTS_PREVIEW_DIR, `${safeVoice}-${cacheKey}.wav`);
  try {
    const stat = await fs.stat(audioPath);
    if (stat.size > 0) return audioPath;
  } catch {
    // Generate the preview below when it is not cached yet.
  }

  if (!ttsPreviewJobs.has(cacheKey)) {
    const job = (async () => {
      await fs.mkdir(TTS_PREVIEW_DIR, { recursive: true });
      if (isPiperVoice(voice)) {
        return generatePiperAudio(text, audioPath, voice);
      }
      return generateKokoroVoiceAudio(text, audioPath, `${audioPath}.txt`, voice);
    })();
    ttsPreviewJobs.set(cacheKey, job);
    job.finally(() => ttsPreviewJobs.delete(cacheKey)).catch(() => {});
  }
  return ttsPreviewJobs.get(cacheKey);
}

async function fitAudioToDuration(inputPath, outputPath, targetDuration) {
  const originalDuration = await probeDuration(inputPath);
  if (!originalDuration) throw new Error(`Não foi possível medir ${path.basename(inputPath)}.`);
  const tempo = originalDuration / targetDuration;
  const result = await runCommand("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath,
    "-filter:a", buildAtempoFilter(tempo),
    "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", outputPath,
  ], 180_000);
  if (result.code !== 0) {
    const detail = result.timedOut
      ? "O FFmpeg excedeu o tempo ao ajustar o áudio."
      : (result.stderr || "O ajuste de tempo do áudio falhou.").trim();
    throw new Error(`Ajuste de tempo TTS falhou: ${redactSecrets(detail).slice(-800)}`);
  }
  const fittedDuration = await probeDuration(outputPath);
  if (!fittedDuration) throw new Error(`O áudio ajustado ${path.basename(outputPath)} ficou inválido.`);
  return { originalDuration, fittedDuration, tempo };
}

async function generateMatrixTts(job, entries, matrixDirectory) {
  const audioDirectory = path.join(matrixDirectory, "audio");
  await fs.mkdir(audioDirectory, { recursive: true });
  if (isPiperVoice(job.ttsVoice)) {
    const fitted = [];
    updateJob(job, {
      status: "SYNTHESIZING_TTS",
      progress: 57,
      message: "Gerando as 9 narrações locais com Piper Faber…",
    });
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const stem = `${entry.group}-${String(entry.index + 1).padStart(2, "0")}`;
      const rawPath = path.join(audioDirectory, `${stem}-raw.wav`);
      const fittedPath = path.join(audioDirectory, `${stem}.wav`);
      await generatePiperAudio(entry.ttsText, rawPath, job.ttsVoice);
      const fit = await fitAudioToDuration(rawPath, fittedPath, 15);
      fitted.push({
        ...entry,
        rawPath,
        audioPath: fittedPath,
        originalDuration: fit.originalDuration,
        duration: fit.fittedDuration,
        tempo: fit.tempo,
      });
      updateJob(job, {
        status: "SYNTHESIZING_TTS",
        progress: Math.min(66, 57 + Math.round(((index + 1) / entries.length) * 9)),
        message: `Ajustando narração ${index + 1}/9 para 15 segundos…`,
      });
    }
    return fitted;
  }
  const manifest = entries.map((entry) => ({
    text: entry.ttsText,
    voice: job.ttsVoice,
    output: path.join(audioDirectory, `${entry.group}-${String(entry.index + 1).padStart(2, "0")}-raw.wav`),
  }));
  const manifestPath = path.join(matrixDirectory, "kokoro-manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  updateJob(job, {
    status: "SYNTHESIZING_TTS",
    progress: 57,
    message: `Gerando as 9 narrações locais com ${ttsEngineLabel(job.ttsVoice)}…`,
  });
  const ttsResult = await runKokoroCommand(KOKORO_PYTHON, [KOKORO_BATCH_SCRIPT, "--manifest", manifestPath], 900_000);
  if (ttsResult.code !== 0) {
    const detail = ttsResult.timedOut
      ? "O Kokoro excedeu o tempo limite."
      : (ttsResult.stderr || "O Kokoro não conseguiu gerar as narrações.").trim();
    throw new Error(`TTS Kokoro falhou: ${redactSecrets(detail).slice(-800)}`);
  }

  const fitted = [];
  for (let index = 0; index < manifest.length; index += 1) {
    const entry = entries[index];
    const rawPath = manifest[index].output;
    const fittedPath = path.join(audioDirectory, `${entry.group}-${String(entry.index + 1).padStart(2, "0")}.wav`);
    const fit = await fitAudioToDuration(rawPath, fittedPath, 15);
    fitted.push({
      ...entry,
      rawPath,
      audioPath: fittedPath,
      originalDuration: fit.originalDuration,
      duration: fit.fittedDuration,
      tempo: fit.tempo,
    });
    updateJob(job, {
      status: "SYNTHESIZING_TTS",
      progress: Math.min(66, 57 + Math.round(((index + 1) / manifest.length) * 9)),
      message: `Ajustando narração ${index + 1}/9 para 15 segundos…`,
    });
  }
  return fitted;
}

function escapeFilterPath(filePath) {
  return filePath.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

function parseSrtTimestamp(timestamp) {
  const [hms, millis] = timestamp.trim().split(",");
  const [hours, minutes, seconds] = hms.split(":").map(Number);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + Number(millis);
}

function formatSrtTimestamp(milliseconds) {
  const total = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function parseSrtEntries(content) {
  const entries = [];
  for (const block of String(content || "").replace(/^\uFEFF/, "").trim().split(/\n\s*\n/)) {
    const lines = block.split(/\r?\n/);
    if (lines.length < 2) continue;
    const timingIndex = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
    if (!lines[timingIndex]?.includes("-->")) continue;
    const [start, end] = lines[timingIndex].split("-->", 2).map((value) => value.trim());
    const text = lines.slice(timingIndex + 1).join("\n").trim();
    if (text) entries.push({ start, end, text });
  }
  return entries;
}

async function combineSrtParts(parts, outputPath) {
  const combined = [];
  for (const part of parts) {
    const content = part.srtPath ? await fs.readFile(part.srtPath, "utf8") : "";
    for (const entry of parseSrtEntries(content)) {
      combined.push({
        start: formatSrtTimestamp(parseSrtTimestamp(entry.start) + part.offsetMs),
        end: formatSrtTimestamp(parseSrtTimestamp(entry.end) + part.offsetMs),
        text: entry.text,
      });
    }
  }
  const body = combined.map((entry, index) => `${index + 1}\n${entry.start} --> ${entry.end}\n${entry.text}`).join("\n\n");
  await fs.writeFile(outputPath, `${body}\n`, { mode: 0o600 });
  return outputPath;
}

function assTimestampFromSrt(timestamp) {
  const [hms, millis] = timestamp.trim().split(",");
  const [hours, minutes, seconds] = hms.split(":").map(Number);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(Math.min(99, Math.floor(Number(millis) / 10))).padStart(2, "0")}`;
}

function escapeAssText(text) {
  return String(text || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("{", "\\{")
    .replaceAll("}", "\\}")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\n", "\\N");
}

async function writeAssFromSrt(srtPath, assPath) {
  const content = await fs.readFile(srtPath, "utf8");
  const style = "Style: Default,Montserrat,40,&H00FFFFFF,&H00FFFFFF,&H00000000,&H3F000000,1,0,0,0,100,100,0,0,1,3,1,2,56,56,273,1";
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "PlayResX: 1080",
    "PlayResY: 1920",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    style,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = parseSrtEntries(content).map((entry) => `Dialogue: 0,${assTimestampFromSrt(entry.start)},${assTimestampFromSrt(entry.end)},Default,,0,0,0,,${escapeAssText(entry.text)}`);
  await fs.writeFile(assPath, `${header.join("\n")}\n${events.join("\n")}\n`, { mode: 0o600 });
  return assPath;
}

async function transcribeAndBurnCaptions(job, videoPath, ttsPath, cycleDirectory) {
  const srtPath = path.join(cycleDirectory, "captions.srt");
  const assPath = path.join(cycleDirectory, "captions.ass");
  const transcriptPath = path.join(cycleDirectory, "transcription.json");

  updateJob(job, {
    status: "TRANSCRIBING",
    progress: 90,
    message: `Transcrevendo a narração local com faster-whisper ${WHISPER_MODEL}…`,
  });
  const transcriptResult = await runCommand(WHISPER_PYTHON, [
    CAPTION_SCRIPT,
    "--audio", ttsPath,
    "--srt", srtPath,
    "--ass", assPath,
    "--json", transcriptPath,
    "--model", WHISPER_MODEL,
    "--language", WHISPER_LANGUAGE,
    "--font-name", "Montserrat",
    "--font-size", "40",
    "--margin-v", "273",
  ], 600_000);
  if (transcriptResult.code !== 0) {
    const detail = transcriptResult.timedOut
      ? "O faster-whisper excedeu o tempo limite."
      : (transcriptResult.stderr || "A transcrição local falhou.").trim();
    throw new Error(`Transcrição local falhou: ${redactSecrets(detail).slice(-800)}`);
  }

  const [srtStat, assStat] = await Promise.all([fs.stat(srtPath), fs.stat(assPath)]);
  if (srtStat.size === 0 || assStat.size === 0) throw new Error("A legenda local foi gerada vazia.");
  job.subtitleSrt = srtPath;
  job.subtitleAss = assPath;

  updateJob(job, {
    status: "BURNING_CAPTIONS",
    progress: 95,
    message: "Queimando as legendas no vídeo vertical 9:16…",
  });
  const captionedPath = `${videoPath}.captions.part.mp4`;
  let fontsClause = "";
  try {
    if ((await fs.stat(CAPTION_FONT_DIR)).isDirectory()) {
      fontsClause = `:fontsdir='${escapeFilterPath(CAPTION_FONT_DIR)}'`;
    }
  } catch {
    // libass can use the system font fallback when the shared font folder is absent.
  }
  const subtitleFilter = [
    "scale=1080:1920:force_original_aspect_ratio=increase",
    "crop=1080:1920",
    "setsar=1",
    `subtitles='${escapeFilterPath(assPath)}'${fontsClause}`,
  ].join(",");
  const burnResult = await runFfmpegVideo([
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", videoPath,
    "-map", "0:v:0", "-map", "0:a?",
    "-vf", subtitleFilter,
  ], [
    "-c:a", "copy", "-movflags", "+faststart", captionedPath,
  ], 600_000);
  if (burnResult.code !== 0) {
    const detail = burnResult.timedOut
      ? "O FFmpeg excedeu o tempo limite ao queimar as legendas."
      : (burnResult.stderr || "O FFmpeg não conseguiu queimar as legendas.").trim();
    throw new Error(`Queima de legendas falhou: ${redactSecrets(detail).slice(-800)}`);
  }
  const stat = await fs.stat(captionedPath);
  if (stat.size === 0) throw new Error("O vídeo com legendas ficou vazio.");
  await fs.rename(captionedPath, videoPath);

  return {
    filename: path.basename(videoPath),
    outputPath: videoPath,
    size: stat.size,
    duration: (await probeDuration(videoPath)) || job.totalDuration || 45,
  };
}

async function transcribeMatrixAudios(job, audioEntries, matrixDirectory) {
  const captionDirectory = path.join(matrixDirectory, "captions");
  await fs.mkdir(captionDirectory, { recursive: true });
  const manifest = audioEntries.map((entry) => ({
    audio: entry.audioPath,
    srt: path.join(captionDirectory, `${entry.group}-${String(entry.index + 1).padStart(2, "0")}.srt`),
    ass: path.join(captionDirectory, `${entry.group}-${String(entry.index + 1).padStart(2, "0")}.ass`),
    json: path.join(captionDirectory, `${entry.group}-${String(entry.index + 1).padStart(2, "0")}.json`),
  }));
  const manifestPath = path.join(matrixDirectory, "whisper-manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  updateJob(job, {
    status: "TRANSCRIBING",
    progress: 69,
    message: `Transcrevendo as 9 narrações com faster-whisper ${WHISPER_MODEL}…`,
  });
  const result = await runCommand(WHISPER_PYTHON, [
    CAPTION_SCRIPT,
    "--batch-manifest", manifestPath,
    "--model", WHISPER_MODEL,
    "--language", WHISPER_LANGUAGE,
    "--font-name", "Montserrat",
    "--font-size", "40",
    "--margin-v", "273",
  ], 900_000);
  if (result.code !== 0) {
    const detail = result.timedOut
      ? "O faster-whisper excedeu o tempo limite."
      : (result.stderr || "A transcrição local das combinações falhou.").trim();
    throw new Error(`Transcrição matricial falhou: ${redactSecrets(detail).slice(-800)}`);
  }
  const completed = [];
  for (let index = 0; index < audioEntries.length; index += 1) {
    const entry = audioEntries[index];
    const paths = manifest[index];
    const [srtStat, assStat] = await Promise.all([fs.stat(paths.srt), fs.stat(paths.ass)]);
    if (srtStat.size === 0 || assStat.size === 0) throw new Error(`Legenda vazia para ${entry.group}-${entry.index + 1}.`);
    completed.push({ ...entry, srtPath: paths.srt, assPath: paths.ass, transcriptPath: paths.json });
  }
  return completed;
}

async function concatCycle(job, ttsPath) {
  const cycleDirectory = path.join(OUTPUT_DIR, "ciclos", job.id);
  const listPath = path.join(cycleDirectory, "concat.txt");
  await fs.mkdir(cycleDirectory, { recursive: true });
  const list = job.segments
    .map((segment) => `file '${segment.outputPath.replaceAll("'", "'\\''")}'`)
    .join("\n");
  await fs.writeFile(listPath, `${list}\n`, { mode: 0o600 });

  const silentPath = path.join(cycleDirectory, "video-only.mp4");
  const silentPartPath = `${silentPath}.part.mp4`;
  const concatArgs = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-map", "0:v:0", "-an", "-c:v", "copy", "-movflags", "+faststart", silentPartPath,
  ];
  let concatResult = await runCommand("ffmpeg", concatArgs);
  let method = "stream-copy-video";

  if (concatResult.code !== 0) {
    await fs.rm(silentPartPath, { force: true }).catch(() => {});
    method = "reencode-video";
    concatResult = await runFfmpegVideo([
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-map", "0:v:0", "-an",
    ], [
      "-movflags", "+faststart", silentPartPath,
    ], 300_000);
  }

  if (concatResult.code !== 0) {
    const detail = concatResult.timedOut
      ? "O FFmpeg excedeu o tempo limite."
      : (concatResult.stderr || "O FFmpeg não conseguiu concatenar os vídeos.").trim();
    throw new Error(`Concatenação FFmpeg falhou: ${redactSecrets(detail).slice(-800)}`);
  }

  const silentStat = await fs.stat(silentPartPath);
  if (silentStat.size === 0) throw new Error("O vídeo concatenado ficou vazio.");
  await fs.rename(silentPartPath, silentPath);

  const videoDuration = (await probeDuration(silentPath)) || job.totalDuration || 45;
  const ttsDuration = await probeDuration(ttsPath);
  if (!ttsDuration) throw new Error("Não foi possível medir a duração do áudio TTS.");
  const ttsTempo = ttsDuration / videoDuration;
  const audioFilter = buildAtempoFilter(ttsTempo);
  job.ttsOriginalDuration = ttsDuration;
  job.ttsTempo = ttsTempo;

  const filename = `ciclo-completo-${safeOutputName(job.id)}`;
  const outputPath = path.join(OUTPUT_DIR, filename);
  const partPath = `${outputPath}.part.mp4`;
  const muxArgs = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", silentPath, "-i", ttsPath,
    "-filter_complex", `[1:a]${audioFilter}[tts]`,
    "-map", "0:v:0", "-map", "[tts]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", partPath,
  ];
  let muxResult = await runCommand("ffmpeg", muxArgs, 300_000);
  if (muxResult.code !== 0) {
    await fs.rm(partPath, { force: true }).catch(() => {});
    method = `${method}+reencode-mux`;
    muxResult = await runFfmpegVideo([
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", silentPath, "-i", ttsPath,
      "-filter_complex", `[1:a]${audioFilter}[tts]`,
      "-map", "0:v:0", "-map", "[tts]",
    ], [
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart", partPath,
    ], 300_000);
  }
  if (muxResult.code !== 0) {
    const detail = muxResult.timedOut
      ? "O FFmpeg excedeu o tempo limite ao adicionar o TTS."
      : (muxResult.stderr || "O FFmpeg não conseguiu adicionar o TTS.").trim();
    throw new Error(`Mixagem do TTS falhou: ${redactSecrets(detail).slice(-800)}`);
  }

  const stat = await fs.stat(partPath);
  if (stat.size === 0) throw new Error("O vídeo final com TTS ficou vazio.");
  await fs.rename(partPath, outputPath);

  const finalDuration = (await probeDuration(outputPath)) || videoDuration;
  return {
    filename,
    outputPath,
    size: stat.size,
    method: `${method}+tempo-fit`,
    duration: finalDuration,
    ttsDuration,
    ttsTempo,
  };
}

async function burnAssCaptions(inputPath, assPath, outputPath) {
  let fontsClause = "";
  try {
    if ((await fs.stat(CAPTION_FONT_DIR)).isDirectory()) {
      fontsClause = `:fontsdir='${escapeFilterPath(CAPTION_FONT_DIR)}'`;
    }
  } catch {
    // libass can use the system font fallback when the shared font folder is absent.
  }
  const subtitleFilter = [
    "scale=1080:1920:force_original_aspect_ratio=increase",
    "crop=1080:1920",
    "setsar=1",
    `subtitles='${escapeFilterPath(assPath)}'${fontsClause}`,
  ].join(",");
  const partPath = `${outputPath}.part.mp4`;
  const result = await runFfmpegVideo([
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath,
    "-map", "0:v:0", "-map", "0:a?",
    "-vf", subtitleFilter,
  ], [
    "-c:a", "copy", "-movflags", "+faststart", partPath,
  ], 600_000);
  if (result.code !== 0) {
    const detail = result.timedOut
      ? "O FFmpeg excedeu o tempo ao queimar as legendas."
      : (result.stderr || "O FFmpeg não conseguiu queimar as legendas.").trim();
    throw new Error(`Queima de legendas falhou: ${redactSecrets(detail).slice(-800)}`);
  }
  const stat = await fs.stat(partPath);
  if (stat.size === 0) throw new Error("O vídeo com legendas ficou vazio.");
  await fs.rename(partPath, outputPath);
  return { outputPath, filename: path.basename(outputPath), size: stat.size, duration: await probeDuration(outputPath) };
}

async function renderMatrixCombination(job, hook, body, ending, audioMap, matrixDirectory, outputIndex) {
  const label = `h${hook.index + 1}-b${body.index + 1}-f${ending.index + 1}`;
  const listDirectory = path.join(matrixDirectory, "lists");
  const renderDirectory = path.join(matrixDirectory, "renders");
  const captionDirectory = path.join(matrixDirectory, "captions");
  await Promise.all([
    fs.mkdir(listDirectory, { recursive: true }),
    fs.mkdir(renderDirectory, { recursive: true }),
    fs.mkdir(captionDirectory, { recursive: true }),
  ]);

  const listPath = path.join(listDirectory, `${label}.txt`);
  const videoList = [hook, body, ending]
    .map((segment) => `file '${segment.outputPath.replaceAll("'", "'\\''")}'`)
    .join("\n");
  await fs.writeFile(listPath, `${videoList}\n`, { mode: 0o600 });

  const rawPath = path.join(renderDirectory, `${label}.base.mp4`);
  const rawPartPath = `${rawPath}.part.mp4`;
  const audioPaths = [hook, body, ending].map((segment) => audioMap.get(`${segment.group}-${segment.index}`)?.audioPath);
  if (audioPaths.some((audioPath) => !audioPath)) throw new Error(`Áudio ausente para a combinação ${label}.`);
  const audioFilter = "[1:a]asetpts=PTS-STARTPTS[a1];[2:a]asetpts=PTS-STARTPTS[a2];[3:a]asetpts=PTS-STARTPTS[a3];[a1][a2][a3]concat=n=3:v=0:a=1[a]";
  let muxResult = await runCommand("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-i", audioPaths[0], "-i", audioPaths[1], "-i", audioPaths[2],
    "-filter_complex", audioFilter,
    "-map", "0:v:0", "-map", "[a]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", rawPartPath,
  ], 300_000);
  let videoMethod = "stream-copy-video";
  if (muxResult.code !== 0) {
    await fs.rm(rawPartPath, { force: true }).catch(() => {});
    videoMethod = "reencode-video";
    muxResult = await runFfmpegVideo([
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "concat", "-safe", "0", "-i", listPath,
      "-i", audioPaths[0], "-i", audioPaths[1], "-i", audioPaths[2],
      "-filter_complex", audioFilter,
      "-map", "0:v:0", "-map", "[a]",
    ], [
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", rawPartPath,
    ], 300_000);
  }
  if (muxResult.code !== 0) {
    const detail = muxResult.timedOut
      ? "O FFmpeg excedeu o tempo ao montar a combinação."
      : (muxResult.stderr || "O FFmpeg não conseguiu montar a combinação.").trim();
    throw new Error(`Montagem ${label} falhou: ${redactSecrets(detail).slice(-800)}`);
  }
  const rawStat = await fs.stat(rawPartPath);
  if (rawStat.size === 0) throw new Error(`A base da combinação ${label} ficou vazia.`);
  await fs.rename(rawPartPath, rawPath);

  const srtPath = path.join(captionDirectory, `${label}.srt`);
  const assPath = path.join(captionDirectory, `${label}.ass`);
  await combineSrtParts([
    { srtPath: audioMap.get(`${hook.group}-${hook.index}`).srtPath, offsetMs: 0 },
    { srtPath: audioMap.get(`${body.group}-${body.index}`).srtPath, offsetMs: 15_000 },
    { srtPath: audioMap.get(`${ending.group}-${ending.index}`).srtPath, offsetMs: 30_000 },
  ], srtPath);
  await writeAssFromSrt(srtPath, assPath);

  const filename = `matriz-${job.id.slice(0, 8)}-${label}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, filename);
  const final = await burnAssCaptions(rawPath, assPath, outputPath);
  return { ...final, label, outputIndex, videoMethod };
}

async function processMatrixJob(job) {
  const tempDirectory = job.tempDirectory;
  try {
    const matrixDirectory = path.join(OUTPUT_DIR, "matrizes", job.id);
    await fs.mkdir(matrixDirectory, { recursive: true });
    for (let index = 0; index < job.matrixSegments.length; index += 1) {
      const segmentPlan = job.matrixSegments[index];
      job.currentSegment = index + 1;
      job.segmentStatuses[index] = "SUBMITTING";
      updateJob(job, {
        status: "SUBMITTING",
        progress: Math.round((index / job.totalSegments) * 54) + 3,
        message: `Gerando take ${index + 1}/${job.totalSegments} (${segmentPlan.group} ${segmentPlan.index + 1}/3)…`,
      });
      const segmentPath = path.join(matrixDirectory, "segments", `${segmentPlan.group}-${String(segmentPlan.index + 1).padStart(2, "0")}.mp4`);
      try {
        const segment = await generateVideoFile(job, segmentPlan.prompt, job.imagePath, segmentPath, index, job.totalSegments);
        job.segmentStatuses[index] = "SUCCEEDED";
        job.segments.push({ ...segment, group: segmentPlan.group, index: segmentPlan.index });
        job.completedSegments = index + 1;
      } catch (error) {
        job.segmentStatuses[index] = "FAILED";
        throw error;
      }
    }

    job.ttsEntries = job.matrixSegments.map((segment) => ({
      group: segment.group,
      index: segment.index,
      ttsText: segment.ttsText,
    }));
    const audioEntries = await generateMatrixTts(job, job.ttsEntries, matrixDirectory);
    const captionEntries = await transcribeMatrixAudios(job, audioEntries, matrixDirectory);
    const audioMap = new Map(captionEntries.map((entry) => [`${entry.group}-${entry.index}`, entry]));
    const segmentMap = new Map(job.segments.map((segment) => [`${segment.group}-${segment.index}`, segment]));
    const combinations = [];
    let outputIndex = 0;
    matrixCombinations:
    for (let hookIndex = 0; hookIndex < 3; hookIndex += 1) {
      for (let bodyIndex = 0; bodyIndex < 3; bodyIndex += 1) {
        for (let endingIndex = 0; endingIndex < 3; endingIndex += 1) {
          outputIndex += 1;
          if (outputIndex > job.totalOutputs) break matrixCombinations;
          const hook = segmentMap.get(`hook-${hookIndex}`);
          const body = segmentMap.get(`body-${bodyIndex}`);
          const ending = segmentMap.get(`ending-${endingIndex}`);
          updateJob(job, {
            status: "MATRIX_MUXING",
            currentOutput: outputIndex,
            progress: Math.min(99, 72 + Math.round((outputIndex / job.totalOutputs) * 27)),
            message: `Montando combinação ${outputIndex}/${job.totalOutputs}: H${hookIndex + 1} × C${bodyIndex + 1} × F${endingIndex + 1}…`,
          });
          const output = await renderMatrixCombination(job, hook, body, ending, audioMap, matrixDirectory, outputIndex);
          job.outputFiles.push(output);
          job.completedOutputs = outputIndex;
        }
      }
    }

    const first = job.outputFiles[0];
    updateJob(job, {
      status: "SUCCEEDED",
      progress: 100,
      message: "27 vídeos prontos: legendados, com TTS e organizados em outputs/.",
      captionsReady: true,
      filename: first.filename,
      size: first.size,
      finalDuration: first.duration || 45,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`[webui] matrix ${job.id}: ${redactSecrets(error.message || error)}`);
    updateJob(job, {
      status: "FAILED",
      progress: 0,
      message: "Não foi possível concluir as 27 combinações.",
      error: redactSecrets(error.message || error),
      finishedAt: new Date().toISOString(),
    });
  } finally {
    if (tempDirectory) await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
    delete job.imagePath;
    delete job.tempDirectory;
  }
}

async function processCycleJob(job) {
  const tempDirectory = job.tempDirectory;
  try {
    const cycleDirectory = path.join(OUTPUT_DIR, "ciclos", job.id);
    await fs.mkdir(cycleDirectory, { recursive: true });
    for (let index = 0; index < job.prompts.length; index += 1) {
      job.currentSegment = index + 1;
      job.segmentStatuses[index] = "SUBMITTING";
      updateJob(job, {
        status: "SUBMITTING",
        progress: Math.round((index / job.prompts.length) * 82) + 4,
        message: `Enfileirando vídeo ${index + 1}/3…`,
      });
      const segmentPath = path.join(cycleDirectory, `segment-${String(index + 1).padStart(2, "0")}.mp4`);
      try {
        const segment = await generateVideoFile(job, job.prompts[index], job.imagePath, segmentPath, index, job.prompts.length);
        job.segmentStatuses[index] = "SUCCEEDED";
        job.segments.push(segment);
      } catch (error) {
        job.segmentStatuses[index] = "FAILED";
        throw error;
      }
    }

    const ttsPath = await generateKokoroAudio(job, cycleDirectory);
    updateJob(job, {
      status: "CONCATENATING",
      progress: 93,
      message: "Removendo o áudio original e unindo os três vídeos com o TTS…",
    });
    const finalVideo = await concatCycle(job, ttsPath);
    const captionedVideo = await transcribeAndBurnCaptions(
      job,
      finalVideo.outputPath,
      ttsPath,
      cycleDirectory,
    );
    const tempoAction = finalVideo.ttsTempo > 1.001
      ? "acelerada"
      : (finalVideo.ttsTempo < 0.999 ? "desacelerada" : "mantida");
    updateJob(job, {
      status: "SUCCEEDED",
      progress: 100,
      message: `Ciclo completo pronto: 3 vídeos unidos sem cortes; narração ${tempoAction} para 45s e legenda queimada (${finalVideo.method}).`,
      filename: captionedVideo.filename,
      size: captionedVideo.size,
      finalDuration: captionedVideo.duration,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`[webui] cycle ${job.id}: ${redactSecrets(error.message || error)}`);
    updateJob(job, {
      status: "FAILED",
      progress: 0,
      message: "Não foi possível concluir o ciclo completo.",
      error: redactSecrets(error.message || error),
      finishedAt: new Date().toISOString(),
    });
  } finally {
    if (tempDirectory) await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
    delete job.imagePath;
    delete job.tempDirectory;
  }
}

async function processJob(job) {
  if (job.kind === "matrix") {
    await processMatrixJob(job);
    return;
  }
  if (job.kind === "cycle") {
    await processCycleJob(job);
    return;
  }
  let tempDirectory = job.tempDirectory;
  try {
    updateJob(job, {
      status: "SUBMITTING",
      progress: 12,
      message: "Enviando a tarefa para o Token Plan…",
    });

    const createResult = await runBl(buildBlArgs(job, job.imagePath));
    if (createResult.code !== 0) {
      throw new Error(blFailure(createResult, "Não foi possível criar a tarefa."));
    }

    const createPayload = parseJsonOutput(createResult.stdout);
    const taskId = getTaskId(createPayload);
    if (!taskId) {
      throw new Error(blFailure(createResult, "A API não retornou um task_id."));
    }

    updateJob(job, {
      taskId,
      status: "PENDING",
      progress: 24,
      message: "Tarefa criada. Aguardando processamento…",
    });

    let completed = false;
    let pollFailures = 0;
    for (let poll = 1; poll <= MAX_POLLS; poll += 1) {
      await sleep(POLL_INTERVAL_MS);
      const taskResult = await runBl([
        "video", "task", "get",
        "--config", "token-plan",
        "--output", "json",
        "--task-id", taskId,
      ], Math.min(BL_COMMAND_TIMEOUT_MS, 30_000));
      const taskPayload = parseTaskPayload(taskResult);
      if (taskResult.code !== 0 || !taskPayload) {
        pollFailures += 1;
        if (pollFailures >= 6) {
          throw new Error(blFailure(taskResult, "Não foi possível consultar o status da tarefa após várias tentativas."));
        }
        updateJob(job, {
          status: "PENDING",
          progress: Math.min(82, job.progress + 1),
          message: `Conexão instável; tentando novamente (${pollFailures}/6)…`,
        });
        continue;
      }
      pollFailures = 0;
      const taskStatus = getTaskStatus(taskPayload).toUpperCase();
      if (taskStatus === "SUCCEEDED") {
        completed = true;
        break;
      }
      if (["FAILED", "CANCELED", "UNKNOWN"].includes(taskStatus)) {
        const taskMessage = taskPayload?.output?.message || taskPayload?.message || taskStatus;
        throw new Error(`A tarefa terminou com status ${taskStatus}: ${redactSecrets(taskMessage)}`);
      }

      const progress = Math.min(86, 28 + Math.round((poll / MAX_POLLS) * 55));
      updateJob(job, {
        status: taskStatus === "RUNNING" ? "RUNNING" : "PENDING",
        progress,
        message: taskStatus === "RUNNING"
          ? "O modelo está gerando o vídeo…"
          : "Tarefa na fila do Token Plan…",
      });
    }

    if (!completed) {
      throw new Error("A tarefa excedeu o tempo máximo de espera configurado.");
    }

    updateJob(job, {
      status: "DOWNLOADING",
      progress: 92,
      message: "Vídeo pronto. Baixando o MP4…",
    });

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const filename = safeOutputName(job.id);
    const outputPath = path.join(OUTPUT_DIR, filename);
    const partPath = `${outputPath}.part`;
    const downloadResult = await runBl([
      "video", "download",
      "--config", "token-plan",
      "--quiet",
      "--task-id", taskId,
      "--out", partPath,
    ]);
    if (downloadResult.code !== 0) {
      throw new Error(blFailure(downloadResult, "A tarefa terminou, mas o download falhou."));
    }

    const stat = await fs.stat(partPath);
    if (stat.size === 0) throw new Error("O arquivo baixado está vazio.");
    await fs.rename(partPath, outputPath);

    updateJob(job, {
      status: "SUCCEEDED",
      progress: 100,
      message: "Vídeo gerado e salvo em outputs/.",
      filename,
      size: stat.size,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(`[webui] job ${job.id}: ${redactSecrets(error.message || error)}`);
    updateJob(job, {
      status: "FAILED",
      progress: 0,
      message: "Não foi possível concluir a geração.",
      error: redactSecrets(error.message || error),
      finishedAt: new Date().toISOString(),
    });
  } finally {
    if (tempDirectory) {
      await fs.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
    }
    delete job.imagePath;
    delete job.tempDirectory;
  }
}

function pumpQueue() {
  while (activeJobs < MAX_CONCURRENT_JOBS && pendingJobs.length > 0) {
    const job = pendingJobs.shift();
    activeJobs += 1;
    processJob(job)
      .catch((error) => updateJob(job, {
        status: "FAILED",
        progress: 0,
        message: "Não foi possível iniciar a geração.",
        error: redactSecrets(error.message || error),
        finishedAt: new Date().toISOString(),
      }))
      .finally(() => {
        activeJobs -= 1;
        pumpQueue();
      });
  }
}

function enqueueJob(job) {
  jobs.set(job.id, job);
  pendingJobs.push(job);
  pumpQueue();
}

async function readRequestBody(request) {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > MAX_UPLOAD_BYTES) {
    request.resume();
    throw new HttpError(413, "O upload excede o limite de 25 MB.");
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_UPLOAD_BYTES) throw new HttpError(413, "O upload excede o limite de 25 MB.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) throw new HttpError(400, "Formulário multipart inválido.");
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const separator = Buffer.from("\r\n\r\n");
  const lineBreak = Buffer.from("\r\n");
  const fields = {};
  const files = {};
  let cursor = 0;

  while (cursor < buffer.length) {
    const boundaryStart = buffer.indexOf(boundary, cursor);
    if (boundaryStart < 0) break;
    let partStart = boundaryStart + boundary.length;
    if (buffer.subarray(partStart, partStart + 2).toString() === "--") break;
    if (buffer.subarray(partStart, partStart + 2).equals(lineBreak)) partStart += 2;

    const headerEnd = buffer.indexOf(separator, partStart);
    if (headerEnd < 0) break;
    const headers = buffer.subarray(partStart, headerEnd).toString("utf8");
    const dataStart = headerEnd + separator.length;
    const nextBoundary = buffer.indexOf(boundary, dataStart);
    if (nextBoundary < 0) break;
    const dataEnd = buffer.subarray(nextBoundary - 2, nextBoundary).equals(lineBreak)
      ? nextBoundary - 2
      : nextBoundary;
    const data = buffer.subarray(dataStart, dataEnd);
    const disposition = headers.split("\r\n").find((line) => /^content-disposition:/i.test(line)) || "";
    const nameMatch = /name="([^"]+)"/i.exec(disposition);
    if (!nameMatch) {
      cursor = nextBoundary;
      continue;
    }
    const name = nameMatch[1];
    const filenameMatch = /filename="([^"]*)"/i.exec(disposition);
    if (filenameMatch) {
      const typeMatch = /(?:^|\r\n)content-type:\s*([^\r\n]+)/i.exec(`\r\n${headers}`);
      files[name] = {
        filename: filenameMatch[1],
        mime: (typeMatch?.[1] || "application/octet-stream").trim().toLowerCase(),
        data,
      };
    } else {
      fields[name] = data.toString("utf8");
    }
    cursor = nextBoundary;
  }

  return { fields, files };
}

function extensionForImage(file) {
  const byMime = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
  };
  return byMime[file.mime] || path.extname(file.filename || "").toLowerCase() || ".bin";
}

async function optimizeReferenceImage(sourcePath, tempDirectory) {
  const optimizedPath = path.join(tempDirectory, "reference.jpg");
  const result = await runCommand("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", sourcePath,
    "-vf", "scale=2048:2048:force_original_aspect_ratio=decrease",
    "-frames:v", "1", "-q:v", "3", optimizedPath,
  ], 60_000);
  if (result.code !== 0) {
    const detail = result.timedOut
      ? "O FFmpeg excedeu o tempo ao preparar a imagem."
      : (result.stderr || "Não foi possível preparar a imagem de referência.").trim();
    throw new Error(`Imagem de referência inválida: ${redactSecrets(detail).slice(-800)}`);
  }
  const stat = await fs.stat(optimizedPath);
  if (stat.size === 0) throw new Error("A imagem de referência otimizada ficou vazia.");
  return optimizedPath;
}

async function parseMultipartRequest(request) {
  const contentType = request.headers["content-type"] || "";
  if (!/^multipart\/form-data/i.test(contentType)) {
    throw new HttpError(415, "Envie o formulário como multipart/form-data.");
  }
  const body = await readRequestBody(request);
  return parseMultipart(body, contentType);
}

async function parseJsonRequest(request) {
  const contentType = request.headers["content-type"] || "";
  if (!/^application\/json/i.test(contentType)) {
    throw new HttpError(415, "Envie a prévia como application/json.");
  }
  const body = await readRequestBody(request);
  try {
    const payload = JSON.parse(body.toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("JSON inválido.");
    return payload;
  } catch {
    throw new HttpError(400, "JSON da prévia inválido.");
  }
}

async function parseGenerateRequest(request) {
  const { fields, files } = await parseMultipartRequest(request);
  const prompt = String(fields.prompt || "").trim();
  const modelId = String(fields.model || "");
  const model = MODELS.get(modelId);
  const resolution = String(fields.resolution || "480P");
  const ratio = String(fields.ratio || "9:16");
  const duration = Number(fields.duration || 5);
  const image = files.image;

  if (!prompt) throw new HttpError(400, "Digite um prompt para gerar o vídeo.");
  if (!model) throw new HttpError(400, "Modelo de vídeo inválido.");
  if (!["480P", "720P", "1080P"].includes(resolution)) throw new HttpError(400, "Resolução inválida.");
  if (!["9:16", "16:9", "1:1", "4:3", "3:4", "adaptive"].includes(ratio)) throw new HttpError(400, "Proporção inválida.");
  if (!Number.isInteger(duration) || duration < 3 || duration > 15) throw new HttpError(400, "A duração deve ser um inteiro entre 3 e 15 segundos.");
  if (model.requiresImage && !image?.data?.length) throw new HttpError(400, "Este modelo precisa de uma imagem de referência.");
  if (!model.requiresImage && image?.data?.length) throw new HttpError(400, "Remova a imagem ou escolha um modelo que aceite referência.");
  if (image && !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(image.mime)) {
    throw new HttpError(400, "Use uma imagem JPG, PNG, WEBP ou GIF.");
  }

  let tempDirectory = null;
  let imagePath = null;
  if (image?.data?.length) {
    tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "animavideo-ref-"));
    const sourceImagePath = path.join(tempDirectory, `source${extensionForImage(image)}`);
    await fs.writeFile(sourceImagePath, image.data, { mode: 0o600 });
    imagePath = await optimizeReferenceImage(sourceImagePath, tempDirectory);
  }

  const jobId = crypto.randomUUID();
  return {
    id: jobId,
    model: model.id,
    prompt,
    apiPrompt: model.mode === "reference"
      ? `Image 1 is the visual reference. Animate the subject according to this instruction: ${prompt}`
      : prompt,
    resolution,
    ratio,
    duration,
    hasReference: Boolean(imagePath),
    imagePath,
    tempDirectory,
    status: "QUEUED",
    progress: 4,
    message: activeJobs >= MAX_CONCURRENT_JOBS ? "Na fila — outra geração está em andamento." : "Preparando a tarefa…",
    createdAt: new Date().toISOString(),
  };
}

async function parseCycleRequest(request) {
  const { fields, files } = await parseMultipartRequest(request);
  const prompts = [fields.prompt1, fields.prompt2, fields.prompt3].map((value) => String(value || "").trim());
  const modelId = String(fields.model || "happyhorse-1.1-r2v");
  const model = MODELS.get(modelId);
  const resolution = String(fields.resolution || "480P");
  const ratio = String(fields.ratio || "9:16");
  const ttsText = String(fields.ttsText || "").trim();
  const ttsVoice = String(fields.ttsVoice || PIPER_VOICE);
  const image = files.image;

  if (prompts.some((prompt) => !prompt)) throw new HttpError(400, "Preencha os três prompts do ciclo completo.");
  if (!ttsText) throw new HttpError(400, "Preencha o texto que será falado pelo TTS.");
  if (!TTS_VOICE_IDS.includes(ttsVoice)) throw new HttpError(400, "Voz TTS inválida.");
  if (!model || !model.requiresImage) throw new HttpError(400, "O ciclo completo precisa de um modelo com referência de imagem.");
  if (!image?.data?.length) throw new HttpError(400, "Adicione uma imagem de referência para o ciclo completo.");
  if (!["480P", "720P", "1080P"].includes(resolution)) throw new HttpError(400, "Resolução inválida.");
  if (!["9:16", "16:9", "1:1", "4:3", "3:4", "adaptive"].includes(ratio)) throw new HttpError(400, "Proporção inválida.");
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(image.mime)) {
    throw new HttpError(400, "Use uma imagem JPG, PNG, WEBP ou GIF.");
  }

  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "animavideo-cycle-ref-"));
  const sourceImagePath = path.join(tempDirectory, `source${extensionForImage(image)}`);
  await fs.writeFile(sourceImagePath, image.data, { mode: 0o600 });
  const imagePath = await optimizeReferenceImage(sourceImagePath, tempDirectory);

  return {
    id: crypto.randomUUID(),
    kind: "cycle",
    model: model.id,
    prompt: prompts[0],
    prompts,
    resolution,
    ratio,
    duration: 15,
    totalDuration: 45,
    ttsText,
    ttsVoice,
    hasReference: true,
    imagePath,
    tempDirectory,
    segmentStatuses: ["QUEUED", "QUEUED", "QUEUED"],
    segments: [],
    currentSegment: 0,
    status: "QUEUED",
    progress: 4,
    message: activeJobs >= MAX_CONCURRENT_JOBS ? "Na fila — outra geração está em andamento." : "Preparando os três vídeos…",
    createdAt: new Date().toISOString(),
  };
}

async function parseMatrixRequest(request) {
  const { fields, files } = await parseMultipartRequest(request);
  const groups = ["hook", "body", "ending"];
  const matrixSegments = [];
  for (const group of groups) {
    for (let index = 0; index < 3; index += 1) {
      const prompt = String(fields[`${group}Prompt${index + 1}`] || "").trim();
      const ttsText = String(fields[`${group}Tts${index + 1}`] || "").trim();
      if (!prompt) throw new HttpError(400, `Preencha o prompt ${index + 1} de ${group}.`);
      if (!ttsText) throw new HttpError(400, `Preencha o TTS ${index + 1} de ${group}.`);
      matrixSegments.push({ group, index, prompt, ttsText });
    }
  }

  const modelId = String(fields.model || "happyhorse-1.1-r2v");
  const model = MODELS.get(modelId);
  const resolution = String(fields.resolution || "480P");
  const ratio = String(fields.ratio || "9:16");
  const ttsVoice = String(fields.ttsVoice || PIPER_VOICE);
  const image = files.image;

  if (!model || !model.requiresImage) throw new HttpError(400, "A matriz precisa de um modelo com referência de imagem.");
  if (!TTS_VOICE_IDS.includes(ttsVoice)) throw new HttpError(400, "Voz TTS inválida.");
  if (!image?.data?.length) throw new HttpError(400, "Adicione uma imagem de referência para a matriz.");
  if (!["480P", "720P", "1080P"].includes(resolution)) throw new HttpError(400, "Resolução inválida.");
  if (!["9:16", "16:9", "1:1", "4:3", "3:4", "adaptive"].includes(ratio)) throw new HttpError(400, "Proporção inválida.");
  if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(image.mime)) {
    throw new HttpError(400, "Use uma imagem JPG, PNG, WEBP ou GIF.");
  }

  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "animavideo-matrix-ref-"));
  const sourceImagePath = path.join(tempDirectory, `source${extensionForImage(image)}`);
  await fs.writeFile(sourceImagePath, image.data, { mode: 0o600 });
  const imagePath = await optimizeReferenceImage(sourceImagePath, tempDirectory);

  return {
    id: crypto.randomUUID(),
    kind: "matrix",
    model: model.id,
    prompt: "Matriz de ganchos, corpos e finalizações",
    matrixSegments,
    resolution,
    ratio,
    duration: 15,
    totalDuration: 45,
    ttsVoice,
    hasReference: true,
    imagePath,
    tempDirectory,
    segmentStatuses: Array.from({ length: 9 }, () => "QUEUED"),
    totalSegments: 9,
    completedSegments: 0,
    totalOutputs: MATRIX_OUTPUT_LIMIT,
    completedOutputs: 0,
    currentSegment: 0,
    currentOutput: 0,
    segments: [],
    outputFiles: [],
    status: "QUEUED",
    progress: 2,
    message: activeJobs >= MAX_CONCURRENT_JOBS ? "Na fila — outra geração está em andamento." : "Preparando as 27 combinações…",
    createdAt: new Date().toISOString(),
  };
}

async function listVideos() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  const entries = await fs.readdir(OUTPUT_DIR, { withFileTypes: true });
  const videos = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".mp4") || entry.name.includes(".part")) continue;
    const filePath = path.join(OUTPUT_DIR, entry.name);
    const stat = await fs.stat(filePath);
    videos.push({
      filename: entry.name,
      videoUrl: `/outputs/${encodeURIComponent(entry.name)}`,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
    });
  }
  return videos.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30);
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function serveAudio(response, filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size === 0) throw new Error("empty-audio");
    response.writeHead(200, {
      "Content-Type": "audio/wav",
      "Cache-Control": "no-store",
      "Content-Length": stat.size,
    });
    createReadStream(filePath).on("error", () => response.destroy()).pipe(response);
  } catch {
    sendJson(response, 404, { error: "Prévia de voz não encontrada." });
  }
}

async function serveStatic(response, pathname) {
  const relativeName = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!/^[a-zA-Z0-9._/-]+$/.test(relativeName) || relativeName.includes("..")) {
    sendJson(response, 404, { error: "Não encontrado." });
    return;
  }
  const filePath = path.join(PUBLIC_DIR, relativeName);
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error("not-file");
    const contentTypes = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
    };
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "Content-Length": stat.size,
    });
    createReadStream(filePath).pipe(response);
  } catch {
    sendJson(response, 404, { error: "Não encontrado." });
  }
}

async function serveVideo(request, response, pathname) {
  let filename;
  try {
    filename = decodeURIComponent(pathname.slice("/outputs/".length));
  } catch {
    sendJson(response, 400, { error: "Nome de arquivo inválido." });
    return;
  }
  if (!filename || path.basename(filename) !== filename || !filename.toLowerCase().endsWith(".mp4")) {
    sendJson(response, 404, { error: "Vídeo não encontrado." });
    return;
  }
  const filePath = path.join(OUTPUT_DIR, filename);
  try {
    const stat = await fs.stat(filePath);
    const range = request.headers.range;
    if (!range) {
      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Accept-Ranges": "bytes",
        "Content-Length": stat.size,
      });
      createReadStream(filePath).pipe(response);
      return;
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      response.end();
      return;
    }
    const start = match[1]
      ? Number(match[1])
      : Math.max(0, stat.size - Number(match[2]));
    const end = match[1] && match[2]
      ? Math.min(Number(match[2]), stat.size - 1)
      : stat.size - 1;
    if (start > end || start >= stat.size) {
      response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Content-Length": end - start + 1,
    });
    createReadStream(filePath, { start, end }).pipe(response);
  } catch {
    sendJson(response, 404, { error: "Vídeo não encontrado." });
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const { pathname } = url;

  if (request.method === "GET" && pathname === "/api/models") {
    sendJson(response, 200, {
      provider: "Alibaba Token Plan",
      ready: Boolean(tokenPlanKey),
      baseUrl: TOKEN_PLAN_BASE_URL,
      models: MODEL_DEFINITIONS,
      videoEncoder: VIDEO_ENCODER_MODE === "libx264"
        ? "libx264"
        : "h264_nvenc (fallback automático para libx264)",
      ttsVoices: TTS_VOICE_DEFINITIONS,
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/videos") {
    sendJson(response, 200, { videos: await listVideos() });
    return;
  }

  if (request.method === "POST" && pathname === "/api/tts-preview") {
    const payload = await parseJsonRequest(request);
    const voice = String(payload.voice || "");
    const text = String(payload.text || "");
    const audioPath = await generateTtsPreview(voice, text);
    await serveAudio(response, audioPath);
    return;
  }

  if (request.method === "GET" && pathname.startsWith("/api/jobs/")) {
    const jobId = pathname.slice("/api/jobs/".length);
    const job = jobs.get(jobId);
    if (!job) {
      sendJson(response, 404, { error: "Job não encontrado." });
      return;
    }
    sendJson(response, 200, { job: publicJob(job) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/generate") {
    if (!tokenPlanKey) throw new HttpError(503, keyLoadError || "Token Plan não configurado.");
    const job = await parseGenerateRequest(request);
    enqueueJob(job);
    sendJson(response, 202, { job: publicJob(job) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/generate-cycle") {
    if (!tokenPlanKey) throw new HttpError(503, keyLoadError || "Token Plan não configurado.");
    const job = await parseCycleRequest(request);
    enqueueJob(job);
    sendJson(response, 202, { job: publicJob(job) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/generate-matrix") {
    if (!tokenPlanKey) throw new HttpError(503, keyLoadError || "Token Plan não configurado.");
    const job = await parseMatrixRequest(request);
    enqueueJob(job);
    sendJson(response, 202, { job: publicJob(job) });
    return;
  }

  if (request.method === "GET" && pathname.startsWith("/outputs/")) {
    await serveVideo(request, response, pathname);
    return;
  }

  if (request.method === "GET") {
    await serveStatic(response, pathname);
    return;
  }

  sendJson(response, 405, { error: "Método não permitido." });
}

async function start() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await loadTokenPlanKey();

  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      if (statusCode >= 500) console.error("[webui]", redactSecrets(error.stack || error.message || error));
      sendJson(response, statusCode, { error: redactSecrets(error.message || "Erro interno.") });
    });
  });

  server.listen(PORT, HOST, () => {
    const state = tokenPlanKey ? "Token Plan configurado" : `Token Plan indisponível: ${keyLoadError}`;
    console.log(`ANIMA/VIDEO WebUI: http://${HOST}:${PORT}`);
    console.log(state);
    console.log(`Modelos: ${MODEL_DEFINITIONS.map((model) => model.id).join(", ")}`);
  });
}

start().catch((error) => {
  console.error("[webui]", redactSecrets(error.stack || error.message || error));
  process.exitCode = 1;
});
