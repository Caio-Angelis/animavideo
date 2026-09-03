const $ = (selector) => document.querySelector(selector);

const state = {
  models: [],
  ttsVoices: [],
  selectedFile: null,
  imageObjectUrl: null,
  cycleSelectedFile: null,
  cycleImageObjectUrl: null,
  matrixSelectedFile: null,
  matrixImageObjectUrl: null,
  activeJobId: null,
  activeJobKind: "single",
  pollTimer: null,
  tokenPlanReady: false,
};

const form = $("#generatorForm");
const promptInput = $("#prompt");
const promptCount = $("#promptCount");
const modelSelect = $("#model");
const modelDescription = $("#modelDescription");
const imageInput = $("#image");
const dropZone = $("#dropZone");
const dropEmpty = $("#dropEmpty");
const dropSelected = $("#dropSelected");
const imagePreview = $("#imagePreview");
const imageName = $("#imageName");
const imageSize = $("#imageSize");
const removeFileButton = $("#removeFile");
const optionalLabel = document.querySelector(".optional");
const generateButton = $("#generateButton");
const buttonText = $("#buttonText");
const formStatus = $("#formStatus");
const cycleForm = $("#cycleForm");
const cycleModelSelect = $("#cycleModel");
const cycleModelDescription = $("#cycleModelDescription");
const cycleImageInput = $("#cycleImage");
const cycleDropZone = $("#cycleDropZone");
const cycleDropEmpty = $("#cycleDropEmpty");
const cycleDropSelected = $("#cycleDropSelected");
const cycleImagePreview = $("#cycleImagePreview");
const cycleImageName = $("#cycleImageName");
const cycleImageSize = $("#cycleImageSize");
const cycleRemoveFileButton = $("#cycleRemoveFile");
const cycleGenerateButton = $("#cycleGenerateButton");
const cycleButtonText = $("#cycleButtonText");
const cycleStatus = $("#cycleStatus");
const cycleTtsText = $("#cycleTtsText");
const ttsVoiceSelect = $("#ttsVoice");
const ttsPreviewButton = $("#ttsPreviewButton");
const cyclePromptInputs = [$("#cyclePrompt1"), $("#cyclePrompt2"), $("#cyclePrompt3")];
const matrixForm = $("#matrixForm");
const matrixModelSelect = $("#matrixModel");
const matrixModelDescription = $("#matrixModelDescription");
const matrixImageInput = $("#matrixImage");
const matrixDropZone = $("#matrixDropZone");
const matrixDropEmpty = $("#matrixDropEmpty");
const matrixDropSelected = $("#matrixDropSelected");
const matrixImagePreview = $("#matrixImagePreview");
const matrixImageName = $("#matrixImageName");
const matrixImageSize = $("#matrixImageSize");
const matrixRemoveFileButton = $("#matrixRemoveFile");
const matrixGenerateButton = $("#matrixGenerateButton");
const matrixButtonText = $("#matrixButtonText");
const matrixStatus = $("#matrixStatus");
const matrixTtsPreviewButton = $("#matrixTtsPreviewButton");
const matrixTab = $("#matrixTab");
const matrixPromptInputs = [
  $("#hookPrompt1"), $("#hookPrompt2"), $("#hookPrompt3"),
  $("#bodyPrompt1"), $("#bodyPrompt2"), $("#bodyPrompt3"),
  $("#endingPrompt1"), $("#endingPrompt2"), $("#endingPrompt3"),
];
const matrixTtsInputs = [
  $("#hookTts1"), $("#hookTts2"), $("#hookTts3"),
  $("#bodyTts1"), $("#bodyTts2"), $("#bodyTts3"),
  $("#endingTts1"), $("#endingTts2"), $("#endingTts3"),
];
const singleTab = $("#singleTab");
const cycleTab = $("#cycleTab");
const connectionPill = $("#connectionPill");
const connectionText = $("#connectionText");
const emptyState = $("#emptyState");
const loadingState = $("#loadingState");
const videoState = $("#videoState");
const loadingLabel = $("#loadingLabel");
const loadingPercent = $("#loadingPercent");
const loadingModel = $("#loadingModel");
const progressBar = $("#progressBar");
const loadingMessage = $("#loadingMessage");
const videoPlayer = $("#videoPlayer");
const videoTitle = $("#videoTitle");
const downloadLink = $("#downloadLink");
const videoMeta = $("#videoMeta");
const matrixOutputList = $("#matrixOutputList");
const matrixOutputButtons = $("#matrixOutputButtons");
const jobStatus = $("#jobStatus");
const jobIdLabel = $("#jobIdLabel");
const jobStatusMessage = $("#jobStatusMessage");
const historyList = $("#historyList");

let voicePreviewState = { button: null, audio: null, url: null, controller: null };
let voicePreviewToken = 0;

const STATUS_LABELS = {
  QUEUED: "NA FILA",
  SUBMITTING: "ENVIANDO TAREFA",
  PENDING: "AGUARDANDO MODELO",
  RUNNING: "GERANDO VÍDEO",
  DOWNLOADING: "BAIXANDO MP4",
  CONCATENATING: "UNINDO 3 TAKES",
  SYNTHESIZING_TTS: "GERANDO NARRAÇÃO",
  TRANSCRIBING: "TRANSCRIBINDO NARRAÇÃO",
  BURNING_CAPTIONS: "QUEIMANDO LEGENDAS",
  SUCCEEDED: "CONCLUÍDO",
  FAILED: "FALHOU",
};

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
  } catch {
    return "agora";
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Erro ${response.status}`);
  return payload;
}

function setFormMessage(message = "", kind = "") {
  formStatus.textContent = message;
  formStatus.className = `form-status${kind ? ` ${kind}` : ""}`;
}

function setCycleMessage(message = "", kind = "") {
  cycleStatus.textContent = message;
  cycleStatus.className = `form-status${kind ? ` ${kind}` : ""}`;
}

function setMatrixMessage(message = "", kind = "") {
  matrixStatus.textContent = message;
  matrixStatus.className = `form-status${kind ? ` ${kind}` : ""}`;
}

function setPreview(view) {
  emptyState.hidden = view !== "empty";
  loadingState.hidden = view !== "loading";
  videoState.hidden = view !== "video";
}

function selectedModel() {
  return state.models.find((model) => model.id === modelSelect.value) || null;
}

function selectedCycleModel() {
  return state.models.find((model) => model.id === cycleModelSelect.value) || null;
}

function setMode(mode) {
  if (state.activeJobId) return;
  const cycle = mode === "cycle";
  const matrix = mode === "matrix";
  singleTab.classList.toggle("active", !cycle && !matrix);
  cycleTab.classList.toggle("active", cycle);
  matrixTab.classList.toggle("active", matrix);
  singleTab.setAttribute("aria-selected", String(!cycle && !matrix));
  cycleTab.setAttribute("aria-selected", String(cycle));
  matrixTab.setAttribute("aria-selected", String(matrix));
  form.hidden = cycle || matrix;
  cycleForm.hidden = !cycle;
  matrixForm.hidden = !matrix;
}

function updateModelUI() {
  const model = selectedModel();
  if (!model) return;

  modelDescription.textContent = model.description;
  optionalLabel.textContent = model.requiresImage ? "obrigatória" : "opcional";
  dropZone.classList.toggle("disabled", !model.requiresImage);
  imageInput.disabled = !model.requiresImage;

  if (model.requiresImage) {
    $("#dropSubtitle").textContent = "Obrigatória para este modelo · a cena nasce desta referência.";
  } else {
    $("#dropSubtitle").textContent = "Este modelo trabalha apenas com o prompt de texto.";
    if (state.selectedFile) clearReference();
  }
}

function updateCycleModelUI() {
  const model = selectedCycleModel();
  if (!model) return;
  cycleModelDescription.textContent = `${model.description} Cada prompt gera um take de 15 segundos.`;
}

function selectedMatrixModel() {
  return state.models.find((model) => model.id === matrixModelSelect.value) || null;
}

function updateMatrixModelUI() {
  const model = selectedMatrixModel();
  if (!model) return;
  matrixModelDescription.textContent = `${model.description} Cada uma das 9 opções usa a mesma imagem de referência.`;
}

function updatePromptCount() {
  promptCount.textContent = `${promptInput.value.length.toLocaleString("pt-BR")} caracteres`;
}

function clearReference() {
  state.selectedFile = null;
  imageInput.value = "";
  dropEmpty.hidden = false;
  dropSelected.hidden = true;
  imagePreview.removeAttribute("src");
  imageName.textContent = "referencia.png";
  imageSize.textContent = "0 KB";
  if (state.imageObjectUrl) {
    URL.revokeObjectURL(state.imageObjectUrl);
    state.imageObjectUrl = null;
  }
}

function clearCycleReference() {
  state.cycleSelectedFile = null;
  cycleImageInput.value = "";
  cycleDropEmpty.hidden = false;
  cycleDropSelected.hidden = true;
  cycleImagePreview.removeAttribute("src");
  cycleImageName.textContent = "referencia.png";
  cycleImageSize.textContent = "0 KB";
  if (state.cycleImageObjectUrl) {
    URL.revokeObjectURL(state.cycleImageObjectUrl);
    state.cycleImageObjectUrl = null;
  }
}

function clearMatrixReference() {
  state.matrixSelectedFile = null;
  matrixImageInput.value = "";
  matrixDropEmpty.hidden = false;
  matrixDropSelected.hidden = true;
  matrixImagePreview.removeAttribute("src");
  matrixImageName.textContent = "referencia.png";
  matrixImageSize.textContent = "0 KB";
  if (state.matrixImageObjectUrl) {
    URL.revokeObjectURL(state.matrixImageObjectUrl);
    state.matrixImageObjectUrl = null;
  }
}

function setReference(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    setFormMessage("Escolha uma imagem JPG, PNG, WEBP ou GIF.");
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    setFormMessage("A imagem precisa ter no máximo 25 MB.");
    return;
  }

  if (state.imageObjectUrl) URL.revokeObjectURL(state.imageObjectUrl);
  state.selectedFile = file;
  state.imageObjectUrl = URL.createObjectURL(file);
  imagePreview.src = state.imageObjectUrl;
  imageName.textContent = file.name;
  imageSize.textContent = formatBytes(file.size);
  dropEmpty.hidden = true;
  dropSelected.hidden = false;
  setFormMessage("");
}

function setCycleReference(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    setCycleMessage("Escolha uma imagem JPG, PNG, WEBP ou GIF.");
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    setCycleMessage("A imagem precisa ter no máximo 25 MB.");
    return;
  }

  if (state.cycleImageObjectUrl) URL.revokeObjectURL(state.cycleImageObjectUrl);
  state.cycleSelectedFile = file;
  state.cycleImageObjectUrl = URL.createObjectURL(file);
  cycleImagePreview.src = state.cycleImageObjectUrl;
  cycleImageName.textContent = file.name;
  cycleImageSize.textContent = formatBytes(file.size);
  cycleDropEmpty.hidden = true;
  cycleDropSelected.hidden = false;
  setCycleMessage("");
}

function setMatrixReference(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    setMatrixMessage("Escolha uma imagem JPG, PNG, WEBP ou GIF.");
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    setMatrixMessage("A imagem precisa ter no máximo 25 MB.");
    return;
  }

  if (state.matrixImageObjectUrl) URL.revokeObjectURL(state.matrixImageObjectUrl);
  state.matrixSelectedFile = file;
  state.matrixImageObjectUrl = URL.createObjectURL(file);
  matrixImagePreview.src = state.matrixImageObjectUrl;
  matrixImageName.textContent = file.name;
  matrixImageSize.textContent = formatBytes(file.size);
  matrixDropEmpty.hidden = true;
  matrixDropSelected.hidden = false;
  setMatrixMessage("");
}

function setBusy(isBusy) {
  generateButton.disabled = isBusy || !state.tokenPlanReady;
  cycleGenerateButton.disabled = isBusy || !state.tokenPlanReady;
  modelSelect.disabled = isBusy;
  cycleModelSelect.disabled = isBusy;
  promptInput.disabled = isBusy;
  imageInput.disabled = isBusy || !selectedModel()?.requiresImage;
  cycleImageInput.disabled = isBusy;
  $("#resolution").disabled = isBusy;
  $("#ratio").disabled = isBusy;
  $("#duration").disabled = isBusy;
  $("#cycleResolution").disabled = isBusy;
  $("#cycleRatio").disabled = isBusy;
  cycleTtsText.disabled = isBusy;
  ttsVoiceSelect.disabled = isBusy;
  ttsPreviewButton.disabled = isBusy || voicePreviewState.button === ttsPreviewButton;
  for (const input of cyclePromptInputs) input.disabled = isBusy;
  matrixModelSelect.disabled = isBusy;
  matrixImageInput.disabled = isBusy;
  $("#matrixResolution").disabled = isBusy;
  $("#matrixRatio").disabled = isBusy;
  $("#matrixTtsVoice").disabled = isBusy;
  matrixTtsPreviewButton.disabled = isBusy || voicePreviewState.button === matrixTtsPreviewButton;
  for (const input of matrixPromptInputs) input.disabled = isBusy;
  for (const input of matrixTtsInputs) input.disabled = isBusy;
  singleTab.disabled = isBusy;
  cycleTab.disabled = isBusy;
  matrixTab.disabled = isBusy;
  buttonText.textContent = isBusy ? "Gerando…" : "Gerar vídeo";
  cycleButtonText.textContent = isBusy ? "Gerando ciclo…" : "Gerar ciclo · 45s";
  matrixButtonText.textContent = isBusy ? "Gerando matriz…" : "Gerar 27 vídeos";
}

function renderJob(job) {
  const label = STATUS_LABELS[job.status] || job.status || "PROCESSANDO";
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  loadingLabel.textContent = job.kind === "matrix" && job.currentOutput
    ? `MATRIZ ${job.currentOutput}/${job.totalOutputs || 27} · ${label}`
    : (job.kind === "cycle" && job.currentSegment
      ? `TAKE ${job.currentSegment}/3 · ${label}`
      : label);
  loadingPercent.textContent = `${progress}%`;
  progressBar.style.width = `${progress}%`;
  loadingMessage.textContent = job.message || "Processando…";
  loadingModel.textContent = job.kind === "matrix"
    ? `${job.model || "Token Plan"} · 9 takes → 27 finais`
    : (job.kind === "cycle"
      ? `${job.model || "Token Plan"} · 3 × 15s`
      : (job.model || "Token Plan"));
  jobStatus.hidden = false;
  jobIdLabel.textContent = job.taskId || job.id || "—";
  jobStatusMessage.textContent = job.error || job.message || "—";
}

function ttsVoiceLabel(voice) {
  return state.ttsVoices.find((candidate) => candidate.id === voice)?.label || (voice === "piper_faber" ? "Piper Faber" : `Kokoro ${voice || "pm_alex"}`);
}

function populateTtsVoiceSelect(select, voices) {
  const previousValue = select.value || "piper_faber";
  select.replaceChildren();
  const groups = new Map();
  for (const voice of voices) {
    const groupName = voice.group || "Vozes locais";
    let group = groups.get(groupName);
    if (!group) {
      group = document.createElement("optgroup");
      group.label = groupName;
      groups.set(groupName, group);
      select.append(group);
    }
    const option = document.createElement("option");
    option.value = voice.id;
    option.textContent = voice.label;
    group.append(option);
  }
  const hasPrevious = voices.some((voice) => voice.id === previousValue);
  select.value = hasPrevious ? previousValue : (voices[0]?.id || "piper_faber");
}

function setPreviewButton(button, label, mode = "idle") {
  if (!button) return;
  const labelElement = button.querySelector("[data-preview-label]");
  if (labelElement) labelElement.textContent = label;
  button.classList.toggle("is-playing", mode === "playing");
  button.classList.toggle("is-loading", mode === "loading");
}

function stopVoicePreview() {
  voicePreviewToken += 1;
  const current = voicePreviewState;
  current.controller?.abort();
  current.audio?.pause();
  if (current.audio) current.audio.src = "";
  if (current.url) URL.revokeObjectURL(current.url);
  setPreviewButton(current.button, "Ouvir teste");
  if (current.button) current.button.disabled = false;
  voicePreviewState = { button: null, audio: null, url: null, controller: null };
}

async function previewVoice(select, button, getText, setMessage) {
  if (voicePreviewState.button === button) {
    stopVoicePreview();
    return;
  }
  stopVoicePreview();
  const token = voicePreviewToken;
  const controller = new AbortController();
  voicePreviewState = { button, audio: null, url: null, controller };
  button.disabled = true;
  setPreviewButton(button, "Gerando…", "loading");
  try {
    const response = await fetch("/api/tts-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice: select.value, text: getText() }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || `Erro ${response.status}`);
    }
    const audioBlob = await response.blob();
    if (token !== voicePreviewToken) return;
    const url = URL.createObjectURL(audioBlob);
    const audio = new Audio(url);
    audio.preload = "auto";
    voicePreviewState = { button, audio, url, controller };
    button.disabled = false;
    setPreviewButton(button, "Parar teste", "playing");
    audio.addEventListener("ended", () => {
      if (token === voicePreviewToken) stopVoicePreview();
    }, { once: true });
    await audio.play();
  } catch (error) {
    if (error.name === "AbortError" || token !== voicePreviewToken) return;
    stopVoicePreview();
    setMessage(error.message || "Não foi possível gerar a prévia.");
  }
}

function renderMatrixOutputs(outputs, selectedFilename, ttsVoice) {
  matrixOutputButtons.replaceChildren();
  if (!outputs?.length) {
    matrixOutputList.hidden = true;
    return;
  }
  matrixOutputList.hidden = false;
  for (const output of outputs) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `matrix-output-button${output.filename === selectedFilename ? " active" : ""}`;
    button.textContent = output.label || output.filename;
    button.title = output.filename;
    button.addEventListener("click", () => {
      for (const item of matrixOutputButtons.querySelectorAll(".matrix-output-button")) item.classList.remove("active");
      button.classList.add("active");
      videoPlayer.src = `${output.videoUrl}?v=${Date.now()}`;
      videoPlayer.load();
      videoTitle.textContent = `Matriz · ${output.label || output.filename}`;
      downloadLink.href = output.videoUrl;
      downloadLink.setAttribute("download", output.filename);
      videoMeta.textContent = `${output.label || "combinação"}  ·  45s  ·  ${ttsVoiceLabel(ttsVoice)} + legenda queimada  ·  ${formatBytes(output.size)}  ·  salvo em outputs/`;
    });
    matrixOutputButtons.append(button);
  }
}

function showVideo(job) {
  if (!job?.videoUrl) return;
  setPreview("video");
  const cacheBuster = `?v=${Date.now()}`;
  videoPlayer.src = `${job.videoUrl}${cacheBuster}`;
  videoPlayer.load();
  videoTitle.textContent = job.kind === "cycle"
    ? "Ciclo completo · 45 segundos"
    : (job.kind === "matrix"
      ? `Matriz · ${job.outputFiles?.[0]?.label || "27 combinações"}`
      : (job.filename || "Vídeo gerado"));
  downloadLink.href = job.videoUrl;
  downloadLink.setAttribute("download", job.filename || "video.mp4");
  const duration = job.kind === "cycle" ? "45s" : (job.totalDuration ? `${job.totalDuration}s` : "take único");
  const audio = ["cycle", "matrix"].includes(job.kind) ? ttsVoiceLabel(job.ttsVoice) : "áudio do take";
  const tempo = job.kind === "cycle" && job.ttsTempo ? `ritmo ${job.ttsTempo.toFixed(2)}×` : "";
  const captions = ["cycle", "matrix"].includes(job.kind) && job.captionsReady ? "legenda queimada" : "";
  videoMeta.textContent = `${job.model || "Token Plan"}  ·  ${duration}  ·  ${audio}${tempo ? ` · ${tempo}` : ""}${captions ? ` · ${captions}` : ""}  ·  ${formatBytes(job.size)}  ·  salvo em outputs/`;
  renderMatrixOutputs(job.kind === "matrix" ? job.outputFiles : [], job.filename, job.ttsVoice);
  renderJob(job);
}

function showHistoryVideo(video) {
  setPreview("video");
  videoPlayer.src = `${video.videoUrl}?v=${Date.now()}`;
  videoPlayer.load();
  videoTitle.textContent = video.filename;
  downloadLink.href = video.videoUrl;
  downloadLink.setAttribute("download", video.filename);
  videoMeta.textContent = `${formatBytes(video.size)}  ·  ${formatDate(video.updatedAt)}  ·  salvo em outputs/`;
  matrixOutputList.hidden = true;
  matrixOutputButtons.replaceChildren();
  jobStatus.hidden = true;
}

function showFailure(message, kind = "single") {
  setPreview("empty");
  jobStatus.hidden = false;
  jobStatusMessage.textContent = message;
  if (kind === "cycle") setCycleMessage(message);
  else if (kind === "matrix") setMatrixMessage(message);
  else setFormMessage(message);
}

async function pollJob(jobId) {
  try {
    const response = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    const job = response.job;
    if (state.activeJobId !== jobId) return;
    renderJob(job);

    if (job.status === "SUCCEEDED") {
      state.activeJobId = null;
      setBusy(false);
      if (job.kind === "cycle") setCycleMessage("Ciclo completo pronto — confira o preview ao lado.", "success");
      else if (job.kind === "matrix") setMatrixMessage("As 27 combinações estão prontas — confira o preview e escolha um take.", "success");
      else setFormMessage("Vídeo pronto — confira o preview ao lado.", "success");
      showVideo(job);
      await refreshHistory();
      return;
    }
    if (job.status === "FAILED") {
      state.activeJobId = null;
      setBusy(false);
      showFailure(job.error || "A geração falhou.", job.kind);
      return;
    }

    state.pollTimer = window.setTimeout(() => pollJob(jobId), 2500);
  } catch (error) {
    if (state.activeJobId !== jobId) return;
    if (error.message === "Job não encontrado.") {
      state.activeJobId = null;
      setBusy(false);
      if (state.activeJobKind === "cycle") setCycleMessage("A tarefa já terminou. O vídeo está no histórico local.", "success");
      else if (state.activeJobKind === "matrix") setMatrixMessage("A tarefa já terminou. As combinações estão no histórico local.", "success");
      else setFormMessage("A tarefa já terminou. O vídeo está no histórico local.", "success");
      setPreview("empty");
      await refreshHistory();
      return;
    }
    state.pollTimer = window.setTimeout(() => pollJob(jobId), 4000);
    jobStatusMessage.textContent = "Reconectando ao status da tarefa…";
  }
}

async function submitGeneration(event) {
  event.preventDefault();
  const model = selectedModel();
  const prompt = promptInput.value.trim();

  if (!state.tokenPlanReady) {
    setFormMessage("Token Plan não está disponível no servidor local.");
    return;
  }
  if (!prompt) {
    setFormMessage("Digite um prompt antes de gerar.");
    promptInput.focus();
    return;
  }
  if (model?.requiresImage && !state.selectedFile) {
    setFormMessage("Adicione uma imagem de referência para este modelo.");
    dropZone.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  if (state.pollTimer) window.clearTimeout(state.pollTimer);
  const formData = new FormData();
  formData.set("prompt", prompt);
  formData.set("model", model.id);
  formData.set("resolution", $("#resolution").value);
  formData.set("ratio", $("#ratio").value);
  formData.set("duration", $("#duration").value);
  if (state.selectedFile) formData.set("image", state.selectedFile, state.selectedFile.name);

  setBusy(true);
  setPreview("loading");
  jobStatus.hidden = false;
  setFormMessage("");
  renderJob({ status: "SUBMITTING", progress: 8, model: model.id, message: "Enviando a tarefa…", id: "preparando" });

  try {
    const response = await api("/api/generate", { method: "POST", body: formData });
    state.activeJobKind = "single";
    state.activeJobId = response.job.id;
    renderJob(response.job);
    pollJob(state.activeJobId);
  } catch (error) {
    setBusy(false);
    showFailure(error.message);
  }
}

async function submitCycleGeneration(event) {
  event.preventDefault();
  const model = selectedCycleModel();
  const prompts = cyclePromptInputs.map((input) => input.value.trim());
  const ttsText = cycleTtsText.value.trim();

  if (!state.tokenPlanReady) {
    setCycleMessage("Token Plan não está disponível no servidor local.");
    return;
  }
  if (!model?.requiresImage) {
    setCycleMessage("Escolha um modelo que aceite imagem de referência.");
    return;
  }
  if (!state.cycleSelectedFile) {
    setCycleMessage("Adicione uma imagem de referência para o ciclo completo.");
    cycleDropZone.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (prompts.some((prompt) => !prompt)) {
    setCycleMessage("Preencha os três prompts antes de gerar.");
    cyclePromptInputs.find((input) => !input.value.trim())?.focus();
    return;
  }
  if (!ttsText) {
    setCycleMessage("Preencha o texto que será falado pelo TTS.");
    cycleTtsText.focus();
    return;
  }

  if (state.pollTimer) window.clearTimeout(state.pollTimer);
  const formData = new FormData();
  formData.set("model", model.id);
  formData.set("prompt1", prompts[0]);
  formData.set("prompt2", prompts[1]);
  formData.set("prompt3", prompts[2]);
  formData.set("ttsText", ttsText);
  formData.set("ttsVoice", ttsVoiceSelect.value);
  formData.set("resolution", $("#cycleResolution").value);
  formData.set("ratio", $("#cycleRatio").value);
  formData.set("image", state.cycleSelectedFile, state.cycleSelectedFile.name);

  state.activeJobKind = "cycle";
  setBusy(true);
  setPreview("loading");
  jobStatus.hidden = false;
  setFormMessage("");
  setCycleMessage("");
  renderJob({ kind: "cycle", currentSegment: 1, status: "SUBMITTING", progress: 8, model: model.id, message: "Enviando os três vídeos…", id: "preparando" });

  try {
    const response = await api("/api/generate-cycle", { method: "POST", body: formData });
    state.activeJobId = response.job.id;
    renderJob(response.job);
    pollJob(state.activeJobId);
  } catch (error) {
    setBusy(false);
    showFailure(error.message, "cycle");
  }
}

async function submitMatrixGeneration(event) {
  event.preventDefault();
  const model = selectedMatrixModel();
  const prompts = matrixPromptInputs.map((input) => input.value.trim());
  const ttsTexts = matrixTtsInputs.map((input) => input.value.trim());

  if (!state.tokenPlanReady) {
    setMatrixMessage("Token Plan não está disponível no servidor local.");
    return;
  }
  if (!model?.requiresImage) {
    setMatrixMessage("Escolha um modelo que aceite imagem de referência.");
    return;
  }
  if (!state.matrixSelectedFile) {
    setMatrixMessage("Adicione uma imagem de referência para a matriz.");
    matrixDropZone.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const emptyPromptIndex = prompts.findIndex((prompt) => !prompt);
  if (emptyPromptIndex >= 0) {
    setMatrixMessage(`Preencha o prompt ${emptyPromptIndex % 3 + 1} do grupo ${emptyPromptIndex < 3 ? "gancho" : emptyPromptIndex < 6 ? "corpo" : "finalização"}.`);
    matrixPromptInputs[emptyPromptIndex].focus();
    return;
  }
  const emptyTtsIndex = ttsTexts.findIndex((text) => !text);
  if (emptyTtsIndex >= 0) {
    setMatrixMessage(`Preencha o TTS ${emptyTtsIndex % 3 + 1} do grupo ${emptyTtsIndex < 3 ? "gancho" : emptyTtsIndex < 6 ? "corpo" : "finalização"}.`);
    matrixTtsInputs[emptyTtsIndex].focus();
    return;
  }

  if (state.pollTimer) window.clearTimeout(state.pollTimer);
  const formData = new FormData();
  formData.set("model", model.id);
  formData.set("resolution", $("#matrixResolution").value);
  formData.set("ratio", $("#matrixRatio").value);
  formData.set("ttsVoice", $("#matrixTtsVoice").value);
  for (const [groupIndex, group] of ["hook", "body", "ending"].entries()) {
    for (let optionIndex = 0; optionIndex < 3; optionIndex += 1) {
      const index = groupIndex * 3 + optionIndex;
      formData.set(`${group}Prompt${optionIndex + 1}`, prompts[index]);
      formData.set(`${group}Tts${optionIndex + 1}`, ttsTexts[index]);
    }
  }
  formData.set("image", state.matrixSelectedFile, state.matrixSelectedFile.name);

  state.activeJobKind = "matrix";
  setBusy(true);
  setPreview("loading");
  jobStatus.hidden = false;
  setFormMessage("");
  setCycleMessage("");
  setMatrixMessage("");
  renderJob({ kind: "matrix", currentSegment: 1, currentOutput: 0, totalSegments: 9, totalOutputs: 27, status: "SUBMITTING", progress: 3, model: model.id, message: "Enviando as 9 gerações…", id: "preparando" });

  try {
    const response = await api("/api/generate-matrix", { method: "POST", body: formData });
    state.activeJobId = response.job.id;
    renderJob(response.job);
    pollJob(state.activeJobId);
  } catch (error) {
    setBusy(false);
    showFailure(error.message, "matrix");
  }
}

function renderHistory(videos) {
  historyList.replaceChildren();
  if (!videos.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.innerHTML = "Nenhum vídeo salvo em <code>outputs/</code>.";
    historyList.append(empty);
    return;
  }

  for (const video of videos) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item";
    button.addEventListener("click", () => showHistoryVideo(video));

    const thumb = document.createElement("span");
    thumb.className = "history-thumb";
    thumb.innerHTML = "<svg viewBox=\"0 0 24 24\" fill=\"none\"><rect x=\"5\" y=\"4\" width=\"14\" height=\"16\" rx=\"4\" stroke=\"currentColor\" stroke-width=\"1.4\"/><path d=\"m10 9 5 3-5 3V9Z\" fill=\"currentColor\"/></svg>";

    const meta = document.createElement("span");
    meta.className = "history-item-meta";
    const name = document.createElement("strong");
    name.textContent = video.filename;
    const details = document.createElement("span");
    details.textContent = `${formatBytes(video.size)}  ·  ${formatDate(video.updatedAt)}`;
    meta.append(name, details);

    const arrow = document.createElement("span");
    arrow.className = "history-arrow";
    arrow.textContent = "↗";
    button.append(thumb, meta, arrow);
    historyList.append(button);
  }
}

async function refreshHistory() {
  try {
    const response = await api("/api/videos");
    renderHistory(response.videos || []);
  } catch (error) {
    historyList.innerHTML = `<div class="history-empty">Não foi possível carregar o arquivo local.</div>`;
  }
}

async function loadModels() {
  try {
    const response = await api("/api/models");
    state.models = response.models || [];
    state.ttsVoices = response.ttsVoices || [];
    state.tokenPlanReady = Boolean(response.ready);
    if (state.ttsVoices.length) {
      populateTtsVoiceSelect(ttsVoiceSelect, state.ttsVoices);
      populateTtsVoiceSelect($("#matrixTtsVoice"), state.ttsVoices);
    }
    modelSelect.replaceChildren();
    cycleModelSelect.replaceChildren();
    matrixModelSelect.replaceChildren();
    for (const model of state.models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label;
      modelSelect.append(option);
      if (model.requiresImage) {
        const cycleOption = option.cloneNode(true);
        cycleModelSelect.append(cycleOption);
        const matrixOption = option.cloneNode(true);
        matrixModelSelect.append(matrixOption);
      }
    }
    const imageModel = state.models.find((model) => model.mode === "image");
    const referenceModel = state.models.find((model) => model.mode === "reference") || imageModel;
    modelSelect.value = imageModel?.id || state.models[0]?.id || "";
    cycleModelSelect.value = referenceModel?.id || "";
    matrixModelSelect.value = referenceModel?.id || "";
    modelSelect.disabled = false;
    cycleModelSelect.disabled = false;
    matrixModelSelect.disabled = false;
    generateButton.disabled = !state.tokenPlanReady;
    cycleGenerateButton.disabled = !state.tokenPlanReady;
    matrixGenerateButton.disabled = !state.tokenPlanReady;
    if (state.tokenPlanReady) {
      connectionPill.classList.remove("offline");
      connectionText.textContent = "Token Plan conectado";
    } else {
      connectionPill.classList.add("offline");
      connectionText.textContent = "Token Plan indisponível";
      setFormMessage("A chave Token Plan não foi encontrada no servidor.");
    }
    updateModelUI();
    updateCycleModelUI();
    updateMatrixModelUI();
  } catch (error) {
    connectionPill.classList.add("offline");
    connectionText.textContent = "servidor offline";
    setFormMessage("Não foi possível conectar ao servidor local.");
  }
}

promptInput.addEventListener("input", updatePromptCount);
modelSelect.addEventListener("change", updateModelUI);
imageInput.addEventListener("change", () => setReference(imageInput.files?.[0]));
removeFileButton.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  clearReference();
});

for (const chip of document.querySelectorAll(".suggestion-chip")) {
  chip.addEventListener("click", () => {
    promptInput.value = chip.dataset.prompt || "";
    updatePromptCount();
    promptInput.focus();
  });
}

for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    if (!dropZone.classList.contains("disabled")) dropZone.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  });
}
dropZone.addEventListener("drop", (event) => {
  if (!dropZone.classList.contains("disabled")) setReference(event.dataTransfer.files?.[0]);
});

cycleModelSelect.addEventListener("change", updateCycleModelUI);
cycleImageInput.addEventListener("change", () => setCycleReference(cycleImageInput.files?.[0]));
cycleRemoveFileButton.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  clearCycleReference();
});
for (const eventName of ["dragenter", "dragover"]) {
  cycleDropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    cycleDropZone.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  cycleDropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    cycleDropZone.classList.remove("dragging");
  });
}
cycleDropZone.addEventListener("drop", (event) => setCycleReference(event.dataTransfer.files?.[0]));

matrixModelSelect.addEventListener("change", updateMatrixModelUI);
matrixImageInput.addEventListener("change", () => setMatrixReference(matrixImageInput.files?.[0]));
matrixRemoveFileButton.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  clearMatrixReference();
});
for (const eventName of ["dragenter", "dragover"]) {
  matrixDropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    matrixDropZone.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  matrixDropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    matrixDropZone.classList.remove("dragging");
  });
}
matrixDropZone.addEventListener("drop", (event) => setMatrixReference(event.dataTransfer.files?.[0]));

ttsPreviewButton.addEventListener("click", () => previewVoice(
  ttsVoiceSelect,
  ttsPreviewButton,
  () => cycleTtsText.value.trim(),
  (message) => setCycleMessage(message),
));
matrixTtsPreviewButton.addEventListener("click", () => previewVoice(
  $("#matrixTtsVoice"),
  matrixTtsPreviewButton,
  () => matrixTtsInputs.map((input) => input.value.trim()).find(Boolean) || "",
  (message) => setMatrixMessage(message),
));
ttsVoiceSelect.addEventListener("change", stopVoicePreview);
$("#matrixTtsVoice").addEventListener("change", stopVoicePreview);
form.addEventListener("submit", submitGeneration);
cycleForm.addEventListener("submit", submitCycleGeneration);
matrixForm.addEventListener("submit", submitMatrixGeneration);
singleTab.addEventListener("click", () => setMode("single"));
cycleTab.addEventListener("click", () => setMode("cycle"));
matrixTab.addEventListener("click", () => setMode("matrix"));
$("#refreshHistory").addEventListener("click", refreshHistory);

updatePromptCount();
setPreview("empty");
setMode("single");
loadModels();
refreshHistory();
