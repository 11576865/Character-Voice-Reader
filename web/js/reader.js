import { documentFromManual, readTxtFile } from "./sources.js";
import { readEpubFile } from "./epub_source.js";
import { segmentDocument } from "./segmenter.js";
import { AudioPlayer } from "./player.js";
import { ReaderQueue } from "./queue.js";
import { ProgressStore, documentIdForFile } from "./progress.js";
import { ReaderNavigation, chapterStart, chapterPosition } from "./navigation.js";
import { VariantStore } from "./variants.js";
import { OfflineLibrary } from "./offline.js";
import { fetchJson, fetchSpeech } from "./api.js";

const element = id => document.getElementById(id);
const ui = {
  voice: element("voice"), modelId: element("modelId"), referenceId: element("referenceId"),
  previewReference: element("previewReference"),
  speed: element("speed"), prefetchAhead: element("prefetchAhead"), text: element("text"),
  txtFile: element("txtFile"), epubFile: element("epubFile"), documentFile: element("documentFile"),
  manualPanel: element("manualPanel"),
  useManual: element("useManual"), start: element("start"), pause: element("pause"), stop: element("stop"),
  previousSegment: element("previousSegment"), nextSegment: element("nextSegment"),
  regenerateParagraph: element("regenerateParagraph"), previewSelection: element("previewSelection"),
  previousChapter: element("previousChapter"), nextChapter: element("nextChapter"),
  resumePrompt: element("resumePrompt"), resumeText: element("resumeText"),
  resumeLast: element("resumeLast"), restartBook: element("restartBook"),
  source: element("source"), bookTitle: element("bookTitle"), bookAuthor: element("bookAuthor"),
  chapterCount: element("chapterCount"), chapterList: element("chapterList"),
  chaptersPanel: element("chaptersPanel"), readingPane: element("readingPane"),
  documentBody: element("documentBody"), currentChapter: element("currentChapter"),
  position: element("position"), status: element("status"), storageNotice: element("storageNotice"),
  generationState: element("generationState"),
  generationVoice: element("generationVoice"), generationModel: element("generationModel"),
  generationEngine: element("generationEngine"), generationRuntime: element("generationRuntime"),
  generationRuntimeRevision: element("generationRuntimeRevision"),
  generationRevision: element("generationRevision"),
  paragraphVersions: element("paragraphVersions"), selectVersion: element("selectVersion"),
  deleteVersion: element("deleteVersion"), versionProvenance: element("versionProvenance"),
  libraryToken: element("libraryToken"), loginLibrary: element("loginLibrary"),
  loadLibrary: element("loadLibrary"),
  saveBook: element("saveBook"), generateBook: element("generateBook"),
  generateMissing: element("generateMissing"), generateChapter: element("generateChapter"),
  pauseGeneration: element("pauseGeneration"), resumeGeneration: element("resumeGeneration"),
  retryGeneration: element("retryGeneration"),
  continuousEmotion: element("continuousEmotion"),
  cancelGeneration: element("cancelGeneration"), libraryBooks: element("libraryBooks"),
  jobStatus: element("jobStatus"), downloadBook: element("downloadBook"),
  cancelOfflineDownload: element("cancelOfflineDownload"),
  offlineBooks: element("offlineBooks"), exportEpub: element("exportEpub"),
  exportWav: element("exportWav"), selectedParagraphLabel: element("selectedParagraphLabel"),
  suggestSpeakers: element("suggestSpeakers"), speakerSuggestions: element("speakerSuggestions"),
  paragraphVoice: element("paragraphVoice"), paragraphReference: element("paragraphReference"),
  applyParagraphVoice: element("applyParagraphVoice"),
  startSelectedParagraph: element("startSelectedParagraph"),
  generateSelectedParagraph: element("generateSelectedParagraph"),
  pronunciationFrom: element("pronunciationFrom"), pronunciationTo: element("pronunciationTo"),
  addPronunciation: element("addPronunciation"), pronunciationList: element("pronunciationList"),
  addBookmark: element("addBookmark"), bookmarkList: element("bookmarkList"),
  goBookmark: element("goBookmark"), searchText: element("searchText"),
  searchNext: element("searchNext"), fontSize: element("fontSize"),
  lineHeight: element("lineHeight"), readingWidth: element("readingWidth"),
  paragraphGap: element("paragraphGap"), readingProgress: element("readingProgress"),
  theme: element("theme"), sleepMinutes: element("sleepMinutes"),
  refreshGenerationHistory: element("refreshGenerationHistory"),
  generationHistory: element("generationHistory"),
  serviceStrip: element("serviceStrip"), serviceStatus: element("serviceStatus"),
  engineStatus: element("engineStatus"), retryService: element("retryService")
};

const progressStore = new ProgressStore();
const variantStore = new VariantStore();
const offlineLibrary = new OfflineLibrary();
let currentDocument = null;
let documentId = null;
let bookAuthor = "";
let sourceLabel = "未加载";
let segments = [];
let navigation = null;
let pendingProgress = null;
let stoppedPosition = null;
let loading = false;
let importSerial = 0;
let statusOverride = null;
let lastSaveAt = 0;
let highlightedIndex = -1;
let forceScrollIndex = -1;
let userScrollUntil = 0;
let jumpSavedIndex = -1;
let voiceCatalog = new Map();
const segmentNodes = new Map();
const chapterButtons = [];
const selectedReferences = new Map();
const generationProvenance = new Map();

function shortRevision(value) {
  return value ? String(value).slice(0, 12) : "—";
}

function normalizedProvenance(source = {}) {
  return {
    voice: source.voice || null,
    model: source.model || source.model_id || source.modelId || null,
    engine: source.engine || null,
    runtime: source.runtime || source.runtime_id || null,
    runtimeRevision: source.runtimeRevision || source.runtime_revision || null,
    generationRevision: source.generationRevision || source.generation_revision || null,
    binding: source.binding || null,
    bindingRevision: source.bindingRevision || source.binding_revision || null,
    phase: source.phase || "ready"
  };
}

function setSegmentProvenance(index, source) {
  if (!Number.isInteger(index)) return;
  generationProvenance.set(index, normalizedProvenance(source));
}

function renderGenerationProvenance(index) {
  const provenance = generationProvenance.get(index);
  ui.generationVoice.textContent = provenance?.voice || "—";
  ui.generationModel.textContent = provenance?.model || "—";
  ui.generationEngine.textContent = provenance?.engine || "—";
  ui.generationRuntime.textContent = provenance?.runtime || "—";
  ui.generationRuntimeRevision.textContent = shortRevision(provenance?.runtimeRevision);
  ui.generationRevision.textContent = shortRevision(provenance?.generationRevision);
  const states = {
    resolving: "正在解析生成链",
    preparing: "正在准备 Runtime",
    generating: "正在生成音频",
    ready: "生成链已确认",
    cached: "使用已保存音频"
  };
  ui.generationState.textContent = provenance ? (states[provenance.phase] || "生成链已确认") : "尚无生成记录";
}

function renderVersionProvenance(version) {
  if (!version) {
    ui.versionProvenance.textContent = "当前段落还没有保存的生成版本。";
    return;
  }
  const metadata = version.metadata || {};
  const engine = metadata.engine || "未记录";
  const runtime = metadata.runtime || metadata.runtime_id || "未记录";
  const generationRevision = shortRevision(
    metadata.generation_revision || metadata.generationRevision
  );
  const runtimeRevision = shortRevision(
    metadata.runtime_revision || metadata.runtimeRevision
  );
  ui.versionProvenance.replaceChildren();
  const first = document.createElement("div");
  const strong = document.createElement("strong");
  strong.textContent = engine;
  first.append(strong, ` · Runtime ${runtime}`);
  const second = document.createElement("div");
  second.textContent =
    `Runtime revision ${runtimeRevision} · Generation revision ${generationRevision}`;
  const third = document.createElement("div");
  third.textContent = `生成于 ${new Date(version.createdAt).toLocaleString()}`;
  ui.versionProvenance.append(first, second, third);
}
let regenerationController = null;
let versionRenderSerial = 0;
let currentBookId = null;
let bookSegmentIds = [];
let sourceBuffer = null;
let sourceKind = null;
let jobPoll = null;
let offlineMode = false;
let offlineDownload = null;
let previewAudio = null;
let annotations = {};
let selectedParagraph = null;
let selectedParagraphNode = null;
let pronunciations = {};
let pronunciationsUpdatedAt = null;
let bookVersions = {};
let offlineAudioVersion = null;
let offlineAnnotationsSignature = "";
let sleepTimer = null;
let serviceState = { status: "checking", engines: [] };

const STORAGE_KEYS = {
  voiceCache: "cvr.voices.cache",
  fontSize: "cvr.reader.fontSize",
  lineHeight: "cvr.reader.lineHeight",
  readingWidth: "cvr.reader.readingWidth",
  paragraphGap: "cvr.reader.paragraphGap",
  theme: "cvr.reader.theme",
  prefetchAhead: "cvr.reader.prefetchAhead"
};
const LEGACY_STORAGE_KEYS = {
  voiceCache: "cvs.voices.cache",
  fontSize: "cvs.reader.fontSize",
  lineHeight: "cvs.reader.lineHeight",
  readingWidth: "cvs.reader.readingWidth",
  paragraphGap: "cvs.reader.paragraphGap",
  theme: "cvs.reader.theme",
  prefetchAhead: "cvs.reader.prefetchAhead"
};

function readMigratedStorage(key, legacyKey) {
  try {
    const current = localStorage.getItem(key);
    if (current !== null) return current;
    const legacy = localStorage.getItem(legacyKey);
    if (legacy !== null) {
      localStorage.setItem(key, legacy);
      return legacy;
    }
  } catch (_) {}
  return null;
}

function bookmarkKey() { return `cvr.bookmarks.v1:${documentId || "manual"}`; }
function legacyBookmarkKey() { return `cvs.bookmarks.v1:${documentId || "manual"}`; }

function bookmarks() {
  try {
    const raw = readMigratedStorage(bookmarkKey(), legacyBookmarkKey());
    return JSON.parse(raw || "[]");
  } catch (_) { return []; }
}

function renderBookmarks() {
  ui.bookmarkList.replaceChildren();
  for (const mark of bookmarks()) {
    const option = document.createElement("option");
    option.value = String(mark.index);
    option.textContent = `${mark.chapter} · ${mark.text}`;
    ui.bookmarkList.appendChild(option);
  }
}

function addBookmark() {
  const position = activePosition();
  if (!position) return;
  const items = bookmarks().filter(item => item.index !== position.index);
  items.push({ index: position.index, chapter: position.segment.chapterTitle,
    text: position.segment.text.slice(0, 35) });
  try { localStorage.setItem(bookmarkKey(), JSON.stringify(items)); }
  catch (_) { statusOverride = "此浏览器无法保存书签。"; }
  renderBookmarks();
  render();
}

function searchNext() {
  const query = ui.searchText.value.trim().toLocaleLowerCase();
  if (!query || !segments.length) return;
  const start = (activePosition()?.index ?? -1) + 1;
  const found = segments.find((item, index) => index >= start && item.text.toLocaleLowerCase().includes(query)) ||
    segments.find(item => item.text.toLocaleLowerCase().includes(query));
  if (found) jump(() => navigation.jumpToSegment(found.index));
  else { statusOverride = "没有找到匹配文字。"; render(); }
}

function libraryHeaders(extra = {}) {
  return { ...extra };
}

async function libraryFetch(url, options = {}) {
  const response = await fetch(url, { ...options, credentials: "same-origin",
    headers: libraryHeaders(options.headers) });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${response.status}`);
  }
  return response;
}

function renderGenerationHistory(items) {
  ui.generationHistory.replaceChildren();
  if (!items.length) {
    ui.generationHistory.textContent = "还没有生成记录。";
    return;
  }
  for (const item of items) {
    const card = document.createElement("div");
    card.className = "generation-history-item";

    const title = document.createElement("strong");
    const scope = item.source === "book" ? "整书生成" : "即时生成";
    title.textContent = `${scope} · ${item.voice || "未知角色"} · ${item.engine || "未知引擎"}`;

    const meta = document.createElement("div");
    meta.className = "generation-history-meta";
    const created = item.createdAt ? new Date(item.createdAt).toLocaleString() : "未知时间";
    const model = item.model || "未记录";
    const runtime = item.runtime || "未记录";
    meta.textContent = `${created} · Model ${model} · Runtime ${runtime} · ${item.output_bytes || 0} bytes`;

    const revisions = document.createElement("div");
    revisions.className = "generation-history-meta";
    revisions.textContent =
      `Runtime rev ${shortRevision(item.runtime_revision)} · Generation rev ${shortRevision(item.generation_revision)}`;

    const hashes = document.createElement("div");
    hashes.className = "generation-history-hash";
    hashes.textContent =
      `Input ${shortRevision(item.input_sha256)} · Output ${shortRevision(item.output_sha256)}`;

    card.append(title, meta, revisions, hashes);
    ui.generationHistory.appendChild(card);
  }
}

async function loadGenerationHistory() {
  try {
    const endpoint = currentBookId
      ? `/v1/books/${currentBookId}/generation-history?limit=30`
      : "/v1/generation-history?limit=30";
    const response = await libraryFetch(endpoint);
    const payload = await response.json();
    renderGenerationHistory(payload.items || []);
  } catch (error) {
    ui.generationHistory.textContent = `生成历史不可用：${error.message}`;
  }
}

async function loginLibrary() {
  try {
    const response = await fetch("/v1/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "same-origin", body: JSON.stringify({ token: ui.libraryToken.value })
    });
    if (!response.ok) throw new Error("令牌无效");
    ui.libraryToken.value = "";
    ui.jobStatus.textContent = "书库已登录。";
    await loadLibrary();
    await loadGenerationHistory();
    await syncOfflineChanges();
  } catch (error) { ui.jobStatus.textContent = `登录失败：${error.message}`; }
}

function paragraphSegments(segment) {
  return segments.filter(item => item.chapterIndex === segment.chapterIndex &&
    item.paragraphIndex === segment.paragraphIndex);
}

function paragraphKey(segment) {
  return variantStore.key(documentId, segment.chapterIndex, segment.paragraphIndex);
}

function annotationKey(chapterIndex, paragraphIndex) {
  return `${chapterIndex}:${paragraphIndex}`;
}

function annotatedOptions(segment, options) {
  const marked = annotations[annotationKey(segment.chapterIndex, segment.paragraphIndex)];
  return marked ? { ...options, voice: marked.voice,
    modelId: marked.voice === options.voice ? options.modelId : null,
    referenceId: marked.reference_id || null } : options;
}

function spokenText(text) {
  for (const source of Object.keys(pronunciations).sort((a, b) => b.length - a.length)) {
    text = text.replaceAll(source, pronunciations[source]);
  }
  return text;
}

function renderPronunciations() {
  ui.pronunciationList.replaceChildren();
  for (const [source, replacement] of Object.entries(pronunciations)) {
    const row = document.createElement("div");
    row.textContent = `${source} → ${replacement} `;
    const remove = document.createElement("button");
    remove.textContent = "删除";
    remove.addEventListener("click", () => updatePronunciation(source, null));
    row.appendChild(remove);
    ui.pronunciationList.appendChild(row);
  }
}

async function updatePronunciation(source, replacement) {
  source = source.trim();
  replacement = replacement?.trim() || null;
  if (!source || source.length > 100 || (replacement && replacement.length > 100)) return;
  const next = { ...pronunciations };
  if (replacement) next[source] = replacement;
  else delete next[source];
  if (Object.keys(next).length > 100) return;
  if (currentBookId && !offlineMode) {
    try {
      await libraryFetch(`/v1/books/${currentBookId}/pronunciations`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next)
      });
      const refreshed = await (await libraryFetch(`/v1/books/${currentBookId}`)).json();
      pronunciationsUpdatedAt = refreshed.pronunciationsUpdatedAt;
    } catch (error) {
      statusOverride = `发音纠正保存失败：${error.message}`;
      render();
      return;
    }
  } else if (offlineMode) {
    statusOverride = "离线时不能重新生成发音；请连接电脑后修改。";
    render();
    return;
  }
  pronunciations = next;
  for (const key of new Set(segments.map(segment => paragraphKey(segment)))) {
    await variantStore.clearSelection(key);
  }
  renderPronunciations();
  statusOverride = "发音规则已更新；重新生成后生效。";
  render();
}

async function fetchFreshAudio({ segment, voice, modelId, referenceId, speed, signal }) {
  const payload = {
    voice,
    model_id: modelId || null,
    reference_id: referenceId || null,
    input: spokenText(segment.text),
    response_format: "wav",
    speed
  };
  setSegmentProvenance(segment.index, {
    voice, model: modelId, phase: "resolving"
  });
  render();

  const plan = await fetchJson("/v1/audio/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify(payload)
  });
  setSegmentProvenance(segment.index, { ...plan, phase: "preparing" });
  render();

  const response = await fetchSpeech(payload, { signal });
  const blob = await response.blob();
  selectedReferences.set(segment.index, {
    id: response.headers.get("X-Selected-Reference"),
    reason: response.headers.get("X-Reference-Reason")
  });
  setSegmentProvenance(segment.index, {
    voice: response.headers.get("X-CVS-Voice") || voice,
    engine: response.headers.get("X-CVS-Engine"),
    runtime: response.headers.get("X-CVS-Runtime"),
    runtimeRevision: response.headers.get("X-CVS-Runtime-Revision"),
    model: response.headers.get("X-CVS-Model") || modelId,
    generationRevision: response.headers.get("X-CVS-Generation-Revision"),
    binding: response.headers.get("X-CVS-Binding"),
    bindingRevision: response.headers.get("X-CVS-Binding-Revision"),
    phase: "ready"
  });
  return blob;
}

async function requestAudio(options) {
  options = annotatedOptions(options.segment, options);
  const pieces = paragraphSegments(options.segment);
  const offset = pieces.findIndex(item => item.index === options.segment.index);
  const variantState = await variantStore.read(paragraphKey(options.segment));
  const selectedVariant = variantState.versions.find(item => item.id === variantState.selected);
  const saved = selectedVariant?.clips.length === pieces.length
    ? selectedVariant.clips[offset] || null
    : null;
  if (saved) {
    setSegmentProvenance(options.segment.index, {
      ...(selectedVariant.metadata || {}),
      phase: "cached"
    });
    return saved;
  }
  const segmentId = bookSegmentIds[options.segment.index];
  if (currentBookId && segmentId) {
    const offline = await offlineLibrary.getClip(currentBookId, segmentId).catch(() => null);
    if (offline && (offlineMode || (offlineAudioVersion === pronunciationsUpdatedAt &&
        offlineAnnotationsSignature === JSON.stringify(annotations)))) return offline;
  }
  if (offlineMode) throw new Error("此段音频未下载，离线时无法重新生成。 ");
  const selectedVersion = bookVersions[segmentId];
  const metadata = selectedVersion?.metadata;
  const voiceSummary = voiceCatalog.get(options.voice);
  const expectedModelAlias = options.modelId || voiceSummary?.default_model || null;
  const expectedModel = voiceSummary?.models?.find(item => item.id === expectedModelAlias) || null;
  const expectedResolvedModel = expectedModel?.model_id || expectedModelAlias;
  const expectedModelRevision = expectedModel?.revision || null;
  const expectedReference = options.referenceId || voiceSummary?.default_reference;
  const modelMatches = !expectedModelAlias ||
    metadata?.model_alias === expectedModelAlias ||
    metadata?.model_id === expectedResolvedModel;
  const revisionMatches = !expectedModelRevision ||
    metadata?.model_revision === expectedModelRevision;
  const speedMatches = Number(metadata?.speed ?? 1) === Number(options.speed);
  const versionMatches = metadata?.pronunciationsUpdatedAt === pronunciationsUpdatedAt &&
    metadata?.voice === options.voice &&
    modelMatches &&
    revisionMatches &&
    speedMatches &&
    (expectedReference === "auto" || !expectedReference || metadata.reference_id === expectedReference);
  if (currentBookId && segmentId && versionMatches) {
    const response = await fetch(`/v1/books/${currentBookId}/audio/${segmentId}`, {
      credentials: "same-origin", signal: options.signal
    });
    if (response.ok) {
      setSegmentProvenance(options.segment.index, {
        ...(metadata || {}),
        voice: metadata?.voice || options.voice,
        model: metadata?.model_id || options.modelId,
        phase: "cached"
      });
      return response.blob();
    }
    if (response.status !== 404) throw new Error(`书库音频请求失败：HTTP ${response.status}`);
  }
  return fetchFreshAudio(options);
}

let queue;
const player = new AudioPlayer(element("audio"), {
  onEnded: () => queue.handleEnded(),
  onError: error => queue.handlePlayerError(error),
  onTimeUpdate: time => {
    if (queue?.state === "playing") saveProgress(false, time);
  }
});
queue = new ReaderQueue({ player, requestAudio, onChange: onQueueChange });

function playbackOptions() {
  const speed = Number(ui.speed.value);
  const prefetchAhead = Number(ui.prefetchAhead.value);
  if (!ui.voice.value) throw new Error("请选择角色。");
  if (!Number.isFinite(speed) || speed <= 0) throw new Error("速度必须大于 0。");
  if (!Number.isInteger(prefetchAhead) || prefetchAhead < 0 || prefetchAhead > 4) {
    throw new Error("提前生成段数必须在 0 到 4 之间。");
  }
  const voice = voiceCatalog.get(ui.voice.value);
  const model = voice?.models?.find(item => item.id === ui.modelId.value);
  if (model?.engine && engineState(model.engine) === "offline") {
    throw new Error(`所选模型的语音引擎当前不可用：${model.engine}`);
  }
  return {
    voice: ui.voice.value,
    modelId: ui.modelId.value || null,
    referenceId: ui.referenceId.value || null,
    speed,
    prefetchAhead
  };
}

function activePosition() {
  if (!navigation) return null;
  const snapshot = queue.snapshot;
  const index = snapshot.currentSegment ? snapshot.index : navigation.lastIndex;
  return segments[index] ? { index, segment: segments[index] } : null;
}

function applyReadingPreferences() {
  ui.readingPane.style.fontSize = `${ui.fontSize.value}px`;
  ui.readingPane.style.setProperty("--reader-line-height", ui.lineHeight.value);
  ui.readingPane.style.setProperty("--reader-width", `${ui.readingWidth.value}px`);
  ui.readingPane.style.setProperty("--reader-paragraph-gap", `${ui.paragraphGap.value}em`);
}

function saveProgress(force = false, audioTime = player.currentTime) {
  if (!documentId || !currentDocument || !navigation) return;
  if (!force && Date.now() - lastSaveAt < 2000) return;
  const position = activePosition();
  if (!position) return;
  const time = queue.state === "playing" || queue.state === "paused" ? audioTime : 0;
  progressStore.save({
    documentId,
    title: currentDocument.title,
    chapterIndex: position.segment.chapterIndex,
    segmentIndex: position.index,
    audioTime: time
  });
  lastSaveAt = Date.now();
  ui.storageNotice.hidden = progressStore.available;
}

function onQueueChange(snapshot) {
  navigation?.sync(snapshot);
  if (snapshot.currentSegment &&
      ["loading", "advancing", "playing", "paused", "error"].includes(snapshot.state)) {
    const changed = highlightedIndex !== snapshot.index;
    if (snapshot.index === jumpSavedIndex) {
      // onJump already wrote the target position and seek time.
      if (snapshot.state === "playing") jumpSavedIndex = -1;
    } else if (changed) {
      saveProgress(true, 0);
    } else if (snapshot.state === "paused") {
      saveProgress(true, player.currentTime);
    }
  }
  statusOverride = null;
  render(snapshot);
  renderVersions();
}

async function renderVersions() {
  const serial = ++versionRenderSerial;
  const position = activePosition();
  const select = ui.paragraphVersions;
  if (!position) {
    select.replaceChildren();
    select.disabled = true;
    ui.selectVersion.disabled = true;
    ui.deleteVersion.disabled = true;
    renderVersionProvenance(null);
    return;
  }
  const state = await variantStore.read(paragraphKey(position.segment));
  if (serial !== versionRenderSerial) return;
  const keep = select.value;
  select.replaceChildren();
  for (const version of state.versions) {
    const option = document.createElement("option");
    option.value = version.id;
    option.textContent = `${new Date(version.createdAt).toLocaleString()} · ${version.metadata?.voice || "角色"} · ${version.metadata?.referenceId || "默认参考"}`;
    select.appendChild(option);
  }
  select.value = state.versions.some(version => version.id === keep) ? keep : state.selected;
  select.disabled = !state.versions.length;
  ui.selectVersion.disabled = !state.versions.length;
  ui.deleteVersion.disabled = !state.versions.length;
  renderVersionProvenance(
    state.versions.find(version => version.id === select.value) || null
  );
}

function scrollToSegment(node, force = false) {
  if (!force && Date.now() < userScrollUntil) return;
  const pane = ui.readingPane;
  const paneRect = pane.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  const margin = 64;
  if (rect.top >= paneRect.top + margin && rect.bottom <= paneRect.bottom - margin) return;
  const offset = rect.top - paneRect.top;
  const target = pane.scrollTop + offset - Math.max(60, pane.clientHeight * 0.25);
  pane.scrollTo({ top: Math.max(0, target), behavior: force ? "auto" : "smooth" });
}

function highlightSegment(index) {
  if (index === highlightedIndex && forceScrollIndex !== index) return;
  segmentNodes.get(highlightedIndex)?.classList.remove("active");
  const node = segmentNodes.get(index);
  highlightedIndex = index;
  if (!node) return;
  node.classList.add("active");
  scrollToSegment(node, forceScrollIndex === index);
  forceScrollIndex = -1;
}

function renderBody() {
  ui.documentBody.replaceChildren();
  ui.chapterList.replaceChildren();
  segmentNodes.clear();
  chapterButtons.length = 0;
  highlightedIndex = -1;
  if (!currentDocument) {
    ui.documentBody.textContent = "请选择 TXT / EPUB，或使用粘贴文本。";
    return;
  }
  const paragraphSegments = new Map();
  for (const segment of segments) {
    const key = `${segment.chapterIndex}:${segment.paragraphIndex}`;
    if (!paragraphSegments.has(key)) paragraphSegments.set(key, []);
    paragraphSegments.get(key).push(segment);
  }
  currentDocument.chapters.forEach((chapter, chapterIndex) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${chapterIndex + 1}. ${chapter.title}`;
    button.disabled = chapterStart(segments, chapterIndex) < 0;
    button.addEventListener("click", () => {
      jump(() => navigation.jumpToChapter(chapterIndex));
      if (window.matchMedia("(max-width: 700px)").matches) ui.chaptersPanel.open = false;
    });
    ui.chapterList.appendChild(button);
    chapterButtons.push(button);

    const section = document.createElement("section");
    const heading = document.createElement("h2");
    heading.textContent = chapter.title;
    section.appendChild(heading);
    chapter.paragraphs.forEach((paragraph, paragraphIndex) => {
      const p = document.createElement("p");
      const key = annotationKey(chapterIndex, paragraphIndex);
      p.classList.toggle("annotated", Boolean(annotations[key]));
      p.addEventListener("click", () => selectParagraph(chapterIndex, paragraphIndex, p));
      const pieces = paragraphSegments.get(`${chapterIndex}:${paragraphIndex}`) || [];
      if (!pieces.length) p.textContent = paragraph;
      for (const segment of pieces) {
        const span = document.createElement("span");
        span.className = "segment";
        span.textContent = segment.text;
        p.appendChild(span);
        segmentNodes.set(segment.index, span);
      }
      section.appendChild(p);
    });
    ui.documentBody.appendChild(section);
  });
}

function fillParagraphReferences() {
  const voice = voiceCatalog.get(ui.paragraphVoice.value);
  ui.paragraphReference.replaceChildren();
  const fallback = document.createElement("option");
  fallback.value = "";
  fallback.textContent = "角色默认参考";
  ui.paragraphReference.appendChild(fallback);
  if (!voice) return;
  for (const ref of voice.references) {
    const option = document.createElement("option");
    option.value = ref.id;
    option.textContent = `${ref.name || ref.id} · ${ref.emotion || "未标注"}`;
    ui.paragraphReference.appendChild(option);
  }
  const auto = document.createElement("option");
  auto.value = "auto";
  auto.textContent = "自动按情绪选参考（试用）";
  ui.paragraphReference.appendChild(auto);
}

function fillParagraphVoices() {
  ui.paragraphVoice.replaceChildren();
  const narrator = document.createElement("option");
  narrator.value = "";
  narrator.textContent = "使用旁白声音";
  ui.paragraphVoice.appendChild(narrator);
  for (const voice of voiceCatalog.values()) {
    const option = document.createElement("option");
    option.value = voice.id;
    option.textContent = voice.name;
    ui.paragraphVoice.appendChild(option);
  }
  fillParagraphReferences();
}

function selectParagraph(chapterIndex, paragraphIndex, node) {
  selectedParagraphNode?.classList.remove("selected-paragraph");
  selectedParagraph = { chapterIndex, paragraphIndex };
  selectedParagraphNode = node;
  node.classList.add("selected-paragraph");
  ui.selectedParagraphLabel.textContent = `第 ${chapterIndex + 1} 章，第 ${paragraphIndex + 1} 段`;
  const marked = annotations[annotationKey(chapterIndex, paragraphIndex)];
  ui.paragraphVoice.value = marked?.voice || "";
  fillParagraphReferences();
  ui.paragraphReference.value = marked?.reference_id || "";
  ui.applyParagraphVoice.disabled = false;
  ui.startSelectedParagraph.disabled = false;
  ui.generateSelectedParagraph.disabled = !currentBookId || offlineMode;
}

async function startFromSelectedParagraph() {
  if (!selectedParagraph || !navigation) return;
  const first = segments.find(item =>
    item.chapterIndex === selectedParagraph.chapterIndex &&
    item.paragraphIndex === selectedParagraph.paragraphIndex
  );
  if (!first) return;
  await jump(() => navigation.jumpToSegment(first.index));
}

async function generateSelectedParagraphAudio() {
  if (!selectedParagraph || !currentBookId) {
    ui.jobStatus.textContent = "请先打开书库中的书籍并选择段落。";
    return;
  }
  try {
    const options = playbackOptions();
    const marked = annotations[
      annotationKey(selectedParagraph.chapterIndex, selectedParagraph.paragraphIndex)
    ];
    const payload = {
      voice: marked?.voice || options.voice,
      model_id: marked?.voice && marked.voice !== options.voice ? null : options.modelId,
      reference_id: marked?.reference_id || options.referenceId,
      speed: options.speed,
      continuous_emotion: ui.continuousEmotion.checked,
      scope: "paragraph",
      chapter_index: selectedParagraph.chapterIndex,
      paragraph_index: selectedParagraph.paragraphIndex
    };
    await libraryFetch(`/v1/books/${currentBookId}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    ui.jobStatus.textContent =
      `已开始生成第 ${selectedParagraph.chapterIndex + 1} 章，第 ${selectedParagraph.paragraphIndex + 1} 段。`;
    await pollJob();
  } catch (error) {
    ui.jobStatus.textContent = `段落生成失败：${error.message}`;
  }
}

async function applyParagraphVoice() {
  if (!selectedParagraph) return;
  const key = annotationKey(selectedParagraph.chapterIndex, selectedParagraph.paragraphIndex);
  if (ui.paragraphVoice.value) {
    annotations[key] = { voice: ui.paragraphVoice.value,
      reference_id: ui.paragraphReference.value || null };
  } else {
    delete annotations[key];
  }
  await variantStore.clearSelection(variantStore.key(documentId,
    selectedParagraph.chapterIndex, selectedParagraph.paragraphIndex));
  selectedParagraphNode?.classList.toggle("annotated", Boolean(annotations[key]));
  if (currentBookId && !offlineMode) {
    try {
      await libraryFetch(`/v1/books/${currentBookId}/annotations`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(annotations)
      });
      statusOverride = "段落角色标注已保存。";
    } catch (error) { statusOverride = `标注保存失败：${error.message}`; }
  } else {
    if (offlineMode && currentBookId) {
      await offlineLibrary.updateBook(currentBookId, {
        annotations: { ...annotations }, pendingAnnotationsAt: new Date().toISOString()
      });
      statusOverride = "离线标注已保存；联网后同步。";
    } else {
      statusOverride = "段落标注已记录；保存到书库后可跨设备使用。";
    }
  }
  render();
}

function render(snapshot = queue.snapshot) {
  const busy = ["loading", "advancing", "playing", "paused"].includes(snapshot.state);
  const active = busy || snapshot.state === "error";
  const hasDocument = Boolean(currentDocument && segments.length);
  const position = activePosition();
  const index = position?.index ?? 0;
  const chapterIndex = position?.segment.chapterIndex ?? 0;
  const localPosition = chapterPosition(segments, index);
  const awaitingChoice = Boolean(pendingProgress);

  ui.start.disabled = !hasDocument || !ui.voice.value || loading ||
    (busy && snapshot.state !== "paused") || awaitingChoice;
  ui.start.textContent = snapshot.state === "error"
    ? "重试"
    : snapshot.state === "paused" || stoppedPosition ? "继续" : "开始";
  ui.pause.disabled = snapshot.state !== "playing";
  ui.stop.disabled = !active;
  ui.voice.disabled = active || loading || !ui.voice.value;
  ui.modelId.disabled = active || loading || !ui.modelId.options.length;
  ui.referenceId.disabled = active || loading || !ui.referenceId.options.length;
  ui.speed.disabled = active || loading;
  ui.prefetchAhead.disabled = active || loading;
  ui.useManual.disabled = loading;
  ui.previousSegment.disabled = !hasDocument || loading || awaitingChoice || index <= 0;
  ui.nextSegment.disabled = !hasDocument || loading || awaitingChoice || index >= segments.length - 1;
  ui.regenerateParagraph.disabled = !hasDocument || loading || awaitingChoice || !ui.voice.value || offlineMode;
  ui.previewSelection.disabled = !hasDocument || loading || !ui.voice.value || offlineMode;
  ui.startSelectedParagraph.disabled = !selectedParagraph || !hasDocument || loading;
  ui.generateSelectedParagraph.disabled =
    !selectedParagraph || !currentBookId || offlineMode || loading;
  ui.previousChapter.disabled = !hasDocument || loading || awaitingChoice ||
    !segments.some(segment => segment.chapterIndex < chapterIndex);
  ui.nextChapter.disabled = !hasDocument || loading || awaitingChoice ||
    !segments.some(segment => segment.chapterIndex > chapterIndex);
  ui.resumePrompt.hidden = !awaitingChoice;
  ui.source.textContent = `文本来源：${sourceLabel}`;
  ui.bookTitle.textContent = `书名：${currentDocument?.title || "—"}`;
  ui.bookAuthor.textContent = `作者：${bookAuthor || "未提供"}`;
  ui.chapterCount.textContent = `章节：${currentDocument?.chapters.length ?? "—"}`;
  ui.storageNotice.hidden = progressStore.available;

  if (hasDocument) {
    ui.currentChapter.textContent = `当前章节：${currentDocument.chapters[chapterIndex]?.title || "—"}`;
    ui.readingProgress.max = Math.max(1, segments.length);
    ui.readingProgress.value = Math.min(segments.length, index + 1);
    ui.position.textContent = `第 ${chapterIndex + 1}/${currentDocument.chapters.length} 章 · 本章片段 ${localPosition.index}/${localPosition.total} · 全书片段 ${index + 1}/${segments.length}`;
    chapterButtons.forEach((button, i) => button.classList.toggle("active", i === chapterIndex));
    highlightSegment(index);
  } else {
    ui.readingProgress.max = 1;
    ui.readingProgress.value = 0;
    ui.currentChapter.textContent = "当前章节：—";
    ui.position.textContent = "尚未开始阅读";
  }

  const number = snapshot.currentSegment ? `${snapshot.index + 1}/${snapshot.total}` : "";
  const prefetchLabel = snapshot.prefetchReadyCount
    ? `；已预取 ${snapshot.prefetchReadyCount}/${snapshot.prefetchAhead} 段`
    : snapshot.prefetchPendingCount ? "；正在预取" : "";
  const messages = {
    idle: hasDocument ? "已就绪。" : "请选择或粘贴文本。",
    loading: `正在生成第 ${number} 个片段……`,
    advancing: `正在衔接第 ${number} 个片段……`,
    playing: `正在播放第 ${number} 个片段${prefetchLabel}。`,
    paused: `已暂停在第 ${number} 个片段。`,
    error: `朗读失败：${snapshot.error?.message || "未知错误"}。可重试或跳过此段。`,
    cancelled: "已停止，当前位置已保留。",
    finished: `朗读完成，共 ${snapshot.total} 个片段。`
  };
  const choice = selectedReferences.get(index);
  const choiceLabel = choice?.id && ui.referenceId.value === "auto"
    ? ` · 参考：${choice.id}（${choice.reason || "自动"}）` : "";
  const provenance = generationProvenance.get(index);
  const provenanceLabel = provenance?.engine
    ? ` · 引擎：${provenance.engine}${provenance.runtime ? ` · Runtime：${provenance.runtime}` : ""}`
    : "";
  ui.status.textContent = statusOverride ||
    (loading
      ? "正在读取文件……"
      : (messages[snapshot.state] || "状态未知。") + choiceLabel + provenanceLabel);
  renderGenerationProvenance(index);
}

function showDocument(model, metadata, id, label) {
  currentBookId = null;
  bookSegmentIds = [];
  offlineMode = false;
  annotations = {};
  pronunciations = {};
  pronunciationsUpdatedAt = null;
  bookVersions = {};
  offlineAudioVersion = null;
  offlineAnnotationsSignature = "";
  renderPronunciations();
  selectedParagraph = null;
  selectedParagraphNode = null;
  ui.selectedParagraphLabel.textContent = "点击正文段落以指定角色";
  ui.applyParagraphVoice.disabled = true;
  currentDocument = model;
  documentId = id;
  bookAuthor = metadata.author || "";
  sourceLabel = label;
  segments = segmentDocument(model);
  selectedReferences.clear();
  generationProvenance.clear();
  pendingProgress = id ? progressStore.load(id, model, segments) : null;
  stoppedPosition = null;
  jumpSavedIndex = -1;
  navigation = new ReaderNavigation({
    document: model,
    segments,
    queue,
    getPlaybackOptions: playbackOptions,
    onJump: ({ index, audioTime }) => {
      stoppedPosition = null;
      forceScrollIndex = index;
      jumpSavedIndex = index;
      if (id) progressStore.save({
        documentId: id, title: model.title,
        chapterIndex: segments[index].chapterIndex, segmentIndex: index, audioTime
      });
    }
  });
  if (pendingProgress) {
    navigation.lastIndex = pendingProgress.segmentIndex;
    forceScrollIndex = pendingProgress.segmentIndex;
    ui.resumeText.textContent = `检测到上次阅读位置：第 ${pendingProgress.chapterIndex + 1} 章，全书第 ${pendingProgress.segmentIndex + 1} 个片段。`;
  }
  renderBody();
  renderBookmarks();
  renderVersions();
  statusOverride = segments.length ? "文档已加载。" : "文档没有可朗读的正文。";
  render();
}

function stopForSourceChange() {
  offlineDownload?.controller.abort();
  regenerationController?.abort();
  regenerationController = null;
  saveProgress(true);
  queue.stop();
  pendingProgress = null;
  stoppedPosition = null;
}

async function importFile(file, kind) {
  if (!file) return;
  const serial = ++importSerial;
  stopForSourceChange();
  loading = true;
  statusOverride = null;
  render();
  try {
    const buffer = await file.arrayBuffer();
    const id = documentIdForFile(buffer, kind);
    const parsed = kind === "txt"
      ? { document: await readTxtFile(file, buffer), metadata: { author: "" } }
      : await readEpubFile(file, buffer);
    if (serial !== importSerial) return;
    sourceBuffer = buffer;
    sourceKind = kind;
    showDocument(parsed.document, parsed.metadata, id, `${kind.toUpperCase()}：${file.name}`);
  } catch (error) {
    if (serial === importSerial) statusOverride = `文件导入失败：${error.message}`;
  } finally {
    if (serial === importSerial) {
      loading = false;
      ui.txtFile.value = "";
      ui.epubFile.value = "";
      render();
    }
  }
}

function useManualText() {
  ++importSerial;
  stopForSourceChange();
  sourceBuffer = null;
  sourceKind = "manual";
  showDocument(documentFromManual(ui.text.value), { author: "" }, null, "手动输入");
  ui.manualPanel?.removeAttribute("open");
}

async function jump(action) {
  if (!navigation || pendingProgress) return;
  try {
    statusOverride = null;
    const moved = await action();
    if (!moved) render();
  } catch (error) {
    statusOverride = error.message;
    render();
  }
}

async function startOrResume() {
  if (!navigation || pendingProgress) return;
  if (queue.state === "paused") {
    await queue.resume();
    return;
  }
  if (queue.state === "error") {
    await queue.retry();
    return;
  }
  const position = stoppedPosition;
  stoppedPosition = null;
  await jump(() => navigation.jumpToSegment(position?.index ?? 0, position?.audioTime ?? 0));
}

function stopReading() {
  if (!navigation) return;
  const position = activePosition();
  if (position) {
    stoppedPosition = { index: position.index, audioTime: player.currentTime };
    saveProgress(true, stoppedPosition.audioTime);
  }
  queue.stop();
}

async function importDocument(file) {
  if (!file) return;
  const kind = file.name.split(".").at(-1).toLowerCase();
  if (!["txt", "md", "docx"].includes(kind)) return;
  const serial = ++importSerial;
  stopForSourceChange();
  loading = true;
  render();
  try {
    const buffer = await file.arrayBuffer();
    const response = await libraryFetch(
      `/v1/documents/parse?kind=${kind}&name=${encodeURIComponent(file.name)}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: buffer
      });
    const parsed = await response.json();
    if (serial !== importSerial) return;
    sourceBuffer = buffer;
    sourceKind = kind;
    const id = documentIdForFile(buffer, kind);
    showDocument(parsed.document, { author: "" }, id, `文档：${file.name}`);
  } catch (error) {
    if (serial === importSerial) statusOverride = `文档导入失败：${error.message}`;
  } finally {
    if (serial === importSerial) {
      loading = false;
      ui.documentFile.value = "";
      render();
    }
  }
}

async function previewSelection() {
  const text = window.getSelection()?.toString().trim() || activePosition()?.segment.text;
  if (!text) return;
  previewAudio?.pause();
  queue.stop();
  try {
    const options = playbackOptions();
    const response = await fetchSpeech({
      voice: options.voice, model_id: options.modelId,
      reference_id: options.referenceId, input: spokenText(text), speed: options.speed
    });
    const url = URL.createObjectURL(await response.blob());
    previewAudio = new Audio(url);
    previewAudio.onended = () => URL.revokeObjectURL(url);
    await previewAudio.play();
    statusOverride = `正在试听：${text.slice(0, 50)}`;
  } catch (error) {
    statusOverride = `试听失败：${error.message}`;
  }
  render();
}

async function previewReference() {
  const voice = ui.voice.value;
  const reference = ui.referenceId.value;
  if (!voice || !reference || reference === "auto") {
    statusOverride = "请先选择一条具体的参考语音。";
    render();
    return;
  }
  previewAudio?.pause();
  try {
    const urlPath = `/v1/voices/${encodeURIComponent(voice)}/references/${encodeURIComponent(reference)}/audio`;
    const response = await libraryFetch(urlPath);
    const url = URL.createObjectURL(await response.blob());
    previewAudio = new Audio(url);
    previewAudio.onended = () => URL.revokeObjectURL(url);
    await previewAudio.play();
    statusOverride = `正在试听参考语音：${reference}`;
  } catch (error) { statusOverride = `参考语音试听失败：${error.message}`; }
  render();
}

async function regenerateParagraph() {
  if (!navigation || pendingProgress) return;
  const position = activePosition();
  if (!position) return;
  const pieces = paragraphSegments(position.segment);
  const first = pieces[0]?.index;
  if (first === undefined) return;
  regenerationController?.abort();
  regenerationController = new AbortController();
  const controller = regenerationController;
  const options = playbackOptions();
  queue.stop();
  statusOverride = `正在重新生成当前段落（共 ${pieces.length} 个片段）……`;
  render();
  const clips = [];
  try {
    for (const segment of pieces) {
      clips.push(await fetchFreshAudio({ segment, ...annotatedOptions(segment, options),
        signal: controller.signal }));
    }
    if (controller !== regenerationController) return;
    const provenance = generationProvenance.get(first) || {};
    await variantStore.add(paragraphKey(position.segment), clips, {
      voice: provenance.voice || options.voice,
      modelId: options.modelId,
      model: provenance.model || options.modelId,
      engine: provenance.engine || null,
      runtime: provenance.runtime || null,
      runtimeRevision: provenance.runtimeRevision || null,
      generationRevision: provenance.generationRevision || null,
      binding: provenance.binding || null,
      bindingRevision: provenance.bindingRevision || null,
      referenceId: options.referenceId,
      speed: options.speed
    });
  } catch (error) {
    if (error.name !== "AbortError") statusOverride = `段落生成失败：${error.message}`;
    render();
    return;
  } finally {
    if (controller === regenerationController) regenerationController = null;
  }
  for (const segment of pieces) selectedReferences.delete(segment.index);
  stoppedPosition = null;
  await renderVersions();
  await jump(() => navigation.jumpToSegment(first, 0));
}

async function selectParagraphVersion() {
  const position = activePosition();
  if (!position || !ui.paragraphVersions.value) return;
  await variantStore.select(paragraphKey(position.segment), ui.paragraphVersions.value);
  await jump(() => navigation.jumpToSegment(paragraphSegments(position.segment)[0].index, 0));
}

async function deleteParagraphVersion() {
  const position = activePosition();
  if (!position || !ui.paragraphVersions.value) return;
  await variantStore.remove(paragraphKey(position.segment), ui.paragraphVersions.value);
  await renderVersions();
}

function chooseProgress(continueReading) {
  if (!pendingProgress || !navigation) return;
  const position = continueReading
    ? { index: pendingProgress.segmentIndex, audioTime: pendingProgress.audioTime }
    : { index: 0, audioTime: 0 };
  pendingProgress = null;
  render();
  jump(() => navigation.jumpToSegment(position.index, position.audioTime));
}

function fillAssetSelect(select, items, defaultId, labelBuilder) {
  select.replaceChildren();
  for (const item of items || []) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = labelBuilder(item);
    select.appendChild(option);
  }
  if (defaultId && [...select.options].some(option => option.value === defaultId)) {
    select.value = defaultId;
  }
}

function engineState(engineId) {
  if (!engineId) return "unknown";
  const item = serviceState.engines.find(engine =>
    (engine.engine || engine.id) === engineId);
  return item?.status || item?.health?.status || "unknown";
}

function renderServiceState() {
  const status = serviceState.status || "offline";
  ui.serviceStrip.dataset.state = status;
  const labels = {
    ready: "Character Voice Service：在线",
    partial: "Character Voice Service：部分可用",
    checking: "Character Voice Service：检查中…",
    offline: "Character Voice Service：不可用"
  };
  ui.serviceStatus.textContent = labels[status] || labels.offline;
  if (!serviceState.engines.length) {
    ui.engineStatus.textContent = status === "offline"
      ? (serviceState.error || "无法读取引擎状态")
      : "未发现语音引擎";
    return;
  }
  ui.engineStatus.textContent = serviceState.engines.map(item => {
    const id = item.engine || item.id || "unknown";
    const state = item.status || item.health?.status || "unknown";
    return `${id}: ${state}`;
  }).join(" · ");
}

async function refreshServiceState() {
  serviceState = { status: "checking", engines: [] };
  renderServiceState();
  ui.retryService.disabled = true;
  try {
    const [health, discovery] = await Promise.all([
      fetchJson("/health"),
      fetchJson("/v1/engines")
    ]);
    const healthEngines = Array.isArray(health?.cvs?.engines) ? health.cvs.engines : [];
    const discovered = Array.isArray(discovery?.engines) ? discovery.engines : [];
    const byId = new Map();
    for (const item of discovered) {
      const id = item.engine || item.id;
      if (id) byId.set(id, { ...item });
    }
    for (const item of healthEngines) {
      const id = item.engine || item.id;
      if (!id) continue;
      byId.set(id, { ...(byId.get(id) || {}), ...item });
    }
    const engines = [...byId.values()];
    const ready = engines.filter(item => ["ready", "ok", "online", "healthy"].includes(
      item.status || item.health?.status
    )).length;
    const unavailable = engines.filter(item => ["offline", "error", "unavailable"].includes(
      item.status || item.health?.status
    )).length;
    serviceState = {
      status: health?.cvs?.status === "offline"
        ? "offline"
        : (ready > 0 && unavailable > 0 ? "partial" : "ready"),
      engines,
      error: health?.cvs?.error || null
    };
  } catch (error) {
    serviceState = { status: "offline", engines: [], error: error.message };
  } finally {
    ui.retryService.disabled = false;
    renderServiceState();
    if (ui.voice.value) syncCharacterAssets();
    render();
  }
}

function syncCharacterAssets() {
  const voice = voiceCatalog.get(ui.voice.value);
  if (!voice) {
    ui.modelId.replaceChildren();
    ui.referenceId.replaceChildren();
    return;
  }
  fillAssetSelect(
    ui.modelId,
    voice.models,
    voice.default_model,
    item => [item.name || item.id, item.engine, item.version].filter(Boolean).join(" · ")
  );
  for (const option of ui.modelId.options) {
    const model = voice.models.find(item => item.id === option.value);
    if (engineState(model?.engine) === "offline") {
      option.disabled = true;
      option.textContent += " · 引擎离线";
    }
  }
  if (ui.modelId.selectedOptions[0]?.disabled) {
    const replacement = [...ui.modelId.options].find(option => !option.disabled);
    if (replacement) ui.modelId.value = replacement.value;
  }
  fillAssetSelect(
    ui.referenceId,
    voice.references,
    voice.default_reference,
    item => {
      const details = [
        item.emotion,
        item.intensity === null || item.intensity === undefined ? "" : item.intensity,
        item.quality
      ].filter(value => value !== "");
      return details.length
        ? `${item.name || item.id} · ${details.join(" · ")}`
        : (item.name || item.id);
    }
  );
  const automatic = document.createElement("option");
  automatic.value = "auto";
  automatic.textContent = "自动按情绪选参考（试用）";
  ui.referenceId.appendChild(automatic);
}

function installVoices(data) {
    ui.voice.replaceChildren();
    voiceCatalog = new Map();
    for (const voice of data.voices || []) {
      if (voice.error) continue;
      voiceCatalog.set(voice.id, voice);
      const option = document.createElement("option");
      option.value = voice.id;
      option.textContent = voice.name || voice.id;
      ui.voice.appendChild(option);
    }
    if (!ui.voice.options.length) {
      syncCharacterAssets();
      statusOverride = "没有可用角色，请先在 voices/ 中添加配置。";
    } else {
      syncCharacterAssets();
    }
    fillParagraphVoices();
    render();
}

async function loadVoices() {
  try {
    const data = await fetchJson("/v1/voices");
    try { localStorage.setItem(STORAGE_KEYS.voiceCache, JSON.stringify(data)); }
    catch (_) { /* online voice list remains usable */ }
    installVoices(data);
  } catch (error) {
    try {
      const cached = JSON.parse(
        readMigratedStorage(STORAGE_KEYS.voiceCache, LEGACY_STORAGE_KEYS.voiceCache) || "null"
      );
      if (cached?.voices?.length) {
        installVoices(cached);
        statusOverride = `当前离线；使用已保存的角色列表。 ${error.message}`;
        render();
        return;
      }
    } catch (_) { /* no cached voice list */ }
    statusOverride = `无法读取角色列表：${error.message}`;
    render();
  }
}

async function loadLibrary() {
  try {
    const response = await libraryFetch("/v1/books");
    const payload = await response.json();
    ui.libraryBooks.replaceChildren();
    for (const book of payload.books || []) {
      const button = document.createElement("button");
      button.textContent = `${book.title} · ${book.kind.toUpperCase()}`;
      button.addEventListener("click", () => openBook(book.id));
      ui.libraryBooks.appendChild(button);
    }
    ui.jobStatus.textContent = `${payload.books.length} 本书。`;
  } catch (error) {
    ui.jobStatus.textContent = `书库读取失败：${error.message}`;
  }
  await renderOfflineBooks();
}

async function renderOfflineBooks() {
  ui.offlineBooks.replaceChildren();
  try {
    for (const book of await offlineLibrary.listBooks()) {
      const open = document.createElement("button");
      open.textContent = `${book.title} · ${book.ready ? "整书可离线" : `${book.downloaded}/${book.manifest.clips.length} 段已下载`}`;
      open.addEventListener("click", () => openOfflineBook(book.id));
      ui.offlineBooks.appendChild(open);
      const remove = document.createElement("button");
      remove.textContent = `删除 ${book.title} 的本机副本`;
      remove.addEventListener("click", async () => {
        if (offlineDownload?.bookId === book.id) offlineDownload.controller.abort();
        await offlineLibrary.removeBook(book.id);
        await renderOfflineBooks();
      });
      ui.offlineBooks.appendChild(remove);
    }
  } catch (error) {
    ui.jobStatus.textContent = `离线书库不可用：${error.message}`;
  }
}

async function openOfflineBook(bookId) {
  const book = await offlineLibrary.getBook(bookId);
  if (!book) return;
  if (!ui.voice.options.length && book.manifest?.voices?.length) {
    installVoices({ voices: book.manifest.voices });
  }
  stopForSourceChange();
  sourceBuffer = null;
  sourceKind = book.kind;
  showDocument(book.document, { author: book.author },
    book.clientDocumentId || `book:${bookId}`, `本设备离线：${book.title}`);
  currentBookId = bookId;
  bookSegmentIds = book.segments.map(item => item.id);
  annotations = book.annotations || {};
  pronunciations = book.pronunciations || {};
  pronunciationsUpdatedAt = book.pronunciationsUpdatedAt || null;
  offlineAudioVersion = pronunciationsUpdatedAt;
  offlineAnnotationsSignature = JSON.stringify(annotations);
  renderPronunciations();
  renderBody();
  offlineMode = true;
  ui.jobStatus.textContent = book.ready ? "整本书已可离线听读。" : "部分章节已下载；缺失段落离线不可播放。";
}

async function downloadWholeBook() {
  if (!currentBookId || offlineMode) {
    ui.jobStatus.textContent = "请先打开电脑书库中的已生成书籍。";
    return;
  }
  if (offlineDownload) {
    ui.jobStatus.textContent = "已有离线下载正在进行。可先取消，或等待完成。";
    return;
  }

  const run = { bookId: currentBookId, controller: new AbortController() };
  const signal = run.controller.signal;
  offlineDownload = run;
  ui.downloadBook.disabled = true;
  ui.cancelOfflineDownload.disabled = false;
  try {
    ui.jobStatus.textContent = "正在准备整本书离线清单与压缩音频……";
    const response = await libraryFetch(
      `/v1/books/${run.bookId}/offline-manifest`, { signal });
    const manifest = await response.json();
    if (signal.aborted) throw new DOMException("下载已取消", "AbortError");
    const estimate = await navigator.storage?.estimate?.();
    if (estimate && estimate.quota - estimate.usage < manifest.totalBytes) {
      throw new Error("本设备剩余浏览器存储空间不足。");
    }
    await navigator.storage?.persist?.();
    if (signal.aborted) throw new DOMException("下载已取消", "AbortError");

    await offlineLibrary.download(manifest, async (segmentId, { signal: requestSignal }) => {
      const audioResponse = await libraryFetch(
        `/v1/books/${run.bookId}/offline-audio/${segmentId}`,
        { signal: requestSignal });
      return audioResponse.blob();
    }, (done, total) => {
      if (offlineDownload === run && !signal.aborted) {
        ui.jobStatus.textContent = `正在下载并校验：${done}/${total}`;
      }
    }, { signal });

    if (offlineDownload === run && !signal.aborted) {
      ui.jobStatus.textContent = "整本书已下载并校验，可关闭电脑后离线听读。";
    }
  } catch (error) {
    if (offlineDownload === run) {
      ui.jobStatus.textContent = error?.name === "AbortError"
        ? "离线下载已取消；已校验片段可在下一次下载时复用。"
        : `离线下载未完成：${error.message}。再次点击可续传。`;
    }
  } finally {
    if (offlineDownload === run) {
      offlineDownload = null;
      ui.downloadBook.disabled = false;
      ui.cancelOfflineDownload.disabled = true;
      await renderOfflineBooks();
    }
  }
}

async function exportEpub() {
  if (!currentBookId || offlineMode) {
    ui.jobStatus.textContent = "请先打开电脑书库中已生成完整音频的书籍。";
    return;
  }
  try {
    ui.jobStatus.textContent = "正在制作同步 EPUB……";
    const response = await libraryFetch(`/v1/books/${currentBookId}/read-aloud.epub`);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `${currentBookId}-read-aloud.epub`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    ui.jobStatus.textContent = "同步 EPUB 已准备下载。";
  } catch (error) {
    ui.jobStatus.textContent = `EPUB 导出失败：${error.message}`;
  }
}

async function exportWav() {
  if (!currentBookId || offlineMode) {
    ui.jobStatus.textContent = "请先打开电脑书库中已生成完整音频的文档。";
    return;
  }
  try {
    const response = await libraryFetch(`/v1/books/${currentBookId}/complete.wav`);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `${currentBookId}-complete.wav`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    ui.jobStatus.textContent = "整篇 WAV 已准备下载。";
  } catch (error) { ui.jobStatus.textContent = `WAV 导出失败：${error.message}`; }
}

async function saveCurrentBook() {
  if (!currentDocument || !segments.length) return;
  try {
    const response = await libraryFetch("/v1/books", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document: currentDocument, segments,
        kind: sourceKind || "manual", author: bookAuthor, client_document_id: documentId })
    });
    const book = await response.json();
    if (sourceBuffer && sourceKind !== "manual") {
      await libraryFetch(`/v1/books/${book.id}/source?kind=${sourceKind}`, {
        method: "PUT", headers: { "Content-Type": "application/octet-stream" },
        body: sourceBuffer
      });
    }
    currentBookId = book.id;
    const details = await (await libraryFetch(`/v1/books/${book.id}`)).json();
    bookSegmentIds = details.segments.map(item => item.id);
    if (Object.keys(annotations).length) {
      await libraryFetch(`/v1/books/${book.id}/annotations`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(annotations)
      });
    }
    if (Object.keys(pronunciations).length) {
      await libraryFetch(`/v1/books/${book.id}/pronunciations`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pronunciations)
      });
      const updated = await (await libraryFetch(`/v1/books/${book.id}`)).json();
      pronunciationsUpdatedAt = updated.pronunciationsUpdatedAt || null;
    }
    ui.jobStatus.textContent = `已保存：${book.title}。`;
    await loadLibrary();
  } catch (error) {
    ui.jobStatus.textContent = `保存失败：${error.message}`;
  }
}

async function openBook(bookId) {
  stopForSourceChange();
  try {
    const book = await (await libraryFetch(`/v1/books/${bookId}`)).json();
    sourceBuffer = null;
    sourceKind = book.kind;
    showDocument(book.document, { author: book.author },
      book.clientDocumentId || `book:${bookId}`, `书库：${book.title}`);
    currentBookId = bookId;
    bookSegmentIds = book.segments.map(item => item.id);
    annotations = book.annotations || {};
    pronunciations = book.pronunciations || {};
    pronunciationsUpdatedAt = book.pronunciationsUpdatedAt || null;
    const cachedOffline = await offlineLibrary.getBook(bookId).catch(() => null);
    offlineAudioVersion = cachedOffline?.pronunciationsUpdatedAt || null;
    offlineAnnotationsSignature = JSON.stringify(cachedOffline?.annotations || {});
    renderPronunciations();
    await refreshBookVersions();
    renderBody();
    const serverProgress = await (await libraryFetch(`/v1/books/${bookId}/progress`)).json();
    const localProgress = progressStore.load(documentId, currentDocument, segments);
    if (serverProgress.segmentIndex !== undefined &&
        (!localProgress || serverProgress.updatedAt > localProgress.updatedAt) &&
        window.confirm("书库中有较新的阅读位置，是否从那里继续？")) {
      navigation.lastIndex = serverProgress.segmentIndex;
      stoppedPosition = { index: serverProgress.segmentIndex,
        audioTime: serverProgress.audioTime || 0 };
      progressStore.save({ documentId, title: currentDocument.title,
        chapterIndex: segments[serverProgress.segmentIndex].chapterIndex,
        segmentIndex: serverProgress.segmentIndex, audioTime: serverProgress.audioTime || 0 });
      render();
    }
    await pollJob();
    await loadGenerationHistory();
  } catch (error) {
    ui.jobStatus.textContent = `打开失败：${error.message}`;
  }
}

async function syncOfflineChanges() {
  if (!navigator.onLine) return;
  for (const cached of await offlineLibrary.listBooks().catch(() => [])) {
    try {
      const server = await (await libraryFetch(`/v1/books/${cached.id}`)).json();
      if (cached.pendingAnnotationsAt) {
        const conflict = server.annotationsUpdatedAt &&
          server.annotationsUpdatedAt > (cached.annotationsUpdatedAt || "");
        const usePhone = !conflict || window.confirm(`《${cached.title}》的段落标注在电脑和手机都已修改。是否采用手机标注？`);
        if (usePhone) {
          await libraryFetch(`/v1/books/${cached.id}/annotations`, {
            method: "PUT", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(cached.annotations || {})
          });
        }
        await offlineLibrary.updateBook(cached.id, {
          pendingAnnotationsAt: null,
          annotations: usePhone ? cached.annotations : (server.annotations || {}),
          annotationsUpdatedAt: usePhone ? new Date().toISOString() : server.annotationsUpdatedAt
        });
      }
      const docId = cached.clientDocumentId || `book:${cached.id}`;
      const bookSegments = segmentDocument(cached.document);
      const local = progressStore.load(docId, cached.document, bookSegments);
      const remote = await (await libraryFetch(`/v1/books/${cached.id}/progress`)).json();
      if (local && local.updatedAt > (remote.updatedAt || "")) {
        await libraryFetch(`/v1/books/${cached.id}/progress`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ segmentIndex: local.segmentIndex, audioTime: local.audioTime })
        });
      }
    } catch (_) { /* keep local edits for the next connection */ }
  }
}

async function pollJob() {
  if (!currentBookId) return;
  try {
    const job = await (await libraryFetch(`/v1/books/${currentBookId}/job`)).json();
    const failed = job.failed_segment;
    const failedLabel = failed
      ? ` · 失败位置：第 ${Number(failed.chapterIndex) + 1} 章，第 ${Number(failed.paragraphIndex) + 1} 段`
      : "";
    ui.jobStatus.textContent =
      `生成：${job.status} · ${job.completed}/${job.total}${failedLabel}${job.error ? ` · ${job.error}` : ""}`;
    ui.retryGeneration.disabled = !["failed", "interrupted", "cancelled"].includes(job.status);
    ui.pauseGeneration.disabled = !["queued", "running"].includes(job.status);
    ui.resumeGeneration.disabled = !["paused", "pausing"].includes(job.status);
    ui.cancelGeneration.disabled = !["queued", "running", "paused", "pausing"].includes(job.status);
    if (["queued", "running"].includes(job.status)) {
      clearTimeout(jobPoll);
      jobPoll = setTimeout(pollJob, 2500);
    } else if (job.status === "completed") {
      await refreshBookVersions();
      await loadGenerationHistory();
    }
  } catch (error) {
    ui.jobStatus.textContent = `任务查询失败：${error.message}`;
  }
}

async function refreshBookVersions() {
  if (!currentBookId || offlineMode) return;
  const states = await (await libraryFetch(`/v1/books/${currentBookId}/versions`)).json();
  bookVersions = {};
  for (const [segmentId, state] of Object.entries(states)) {
    bookVersions[segmentId] = state.versions.find(item => item.id === state.selected);
  }
}

async function startBookGeneration(scope = "all") {
  if (!currentBookId) {
    ui.jobStatus.textContent = "请先把当前书籍保存到书库。";
    return;
  }
  try {
    const options = playbackOptions();
    const position = activePosition();
    const payload = {
      voice: options.voice,
      model_id: options.modelId,
      reference_id: options.referenceId,
      speed: options.speed,
      continuous_emotion: ui.continuousEmotion.checked,
      scope
    };
    if (scope === "chapter") {
      if (!position) {
        ui.jobStatus.textContent = "当前没有可生成的章节。";
        return;
      }
      payload.chapter_index = position.segment.chapterIndex;
    }
    await libraryFetch(`/v1/books/${currentBookId}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (scope === "missing") {
      ui.jobStatus.textContent = "已开始检查并生成缺失段落。";
    } else if (scope === "chapter") {
      ui.jobStatus.textContent = `已开始生成第 ${position.segment.chapterIndex + 1} 章。`;
    }
    await pollJob();
  } catch (error) {
    ui.jobStatus.textContent = `启动失败：${error.message}`;
  }
}

async function generateWholeBook() {
  return startBookGeneration("all");
}

async function generateMissingAudio() {
  return startBookGeneration("missing");
}

async function generateCurrentChapter() {
  return startBookGeneration("chapter");
}

async function pauseWholeBook() {
  if (!currentBookId) {
    ui.jobStatus.textContent = "请先打开书库中的书籍。";
    return;
  }
  try {
    await libraryFetch(`/v1/books/${currentBookId}/pause`, { method: "POST" });
    ui.jobStatus.textContent = "将在当前片段完成后暂停生成。";
    await pollJob();
  } catch (error) {
    ui.jobStatus.textContent = `暂停失败：${error.message}`;
  }
}

async function resumeWholeBook() {
  if (!currentBookId) {
    ui.jobStatus.textContent = "请先打开书库中的书籍。";
    return;
  }
  try {
    await libraryFetch(`/v1/books/${currentBookId}/resume`, { method: "POST" });
    ui.jobStatus.textContent = "已继续生成。";
    await pollJob();
  } catch (error) {
    ui.jobStatus.textContent = `继续失败：${error.message}`;
  }
}

async function retryWholeBook() {
  if (!currentBookId) {
    ui.jobStatus.textContent = "请先打开书库中的书籍。";
    return;
  }
  try {
    await libraryFetch(`/v1/books/${currentBookId}/retry`, { method: "POST" });
    ui.jobStatus.textContent = "已重新排队；已有可复用音频会跳过。";
    await pollJob();
  } catch (error) {
    ui.jobStatus.textContent = `重试失败：${error.message}`;
  }
}

async function loadSpeakerSuggestions() {
  if (!currentBookId || offlineMode) return;
  try {
    const payload = await (await libraryFetch(
      `/v1/books/${currentBookId}/speaker-suggestions`)).json();
    ui.speakerSuggestions.replaceChildren();
    if (!payload.suggestions.length) {
      ui.speakerSuggestions.textContent = "没有找到尚未标注的明确角色名。";
      return;
    }
    for (const suggestion of payload.suggestions) {
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.dataset.paragraph = suggestion.paragraph;
      checkbox.dataset.voice = suggestion.voice;
      label.append(checkbox, `${suggestion.voice} · ${suggestion.text}`);
      ui.speakerSuggestions.appendChild(label);
    }
    const apply = document.createElement("button");
    apply.textContent = "确认所选角色标注";
    apply.addEventListener("click", async () => {
      for (const checkbox of ui.speakerSuggestions.querySelectorAll("input:checked")) {
        if (!annotations[checkbox.dataset.paragraph]) {
          annotations[checkbox.dataset.paragraph] = { voice: checkbox.dataset.voice,
            reference_id: null };
          const [chapterIndex, paragraphIndex] = checkbox.dataset.paragraph.split(":").map(Number);
          await variantStore.clearSelection(variantStore.key(documentId, chapterIndex, paragraphIndex));
        }
      }
      await libraryFetch(`/v1/books/${currentBookId}/annotations`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(annotations)
      });
      renderBody();
      ui.speakerSuggestions.textContent = "所选角色标注已保存。";
    });
    ui.speakerSuggestions.appendChild(apply);
  } catch (error) { ui.speakerSuggestions.textContent = `角色建议失败：${error.message}`; }
}

ui.voice.addEventListener("change", () => {
  syncCharacterAssets();
  render();
});
ui.paragraphVoice.addEventListener("change", fillParagraphReferences);
ui.applyParagraphVoice.addEventListener("click", applyParagraphVoice);
ui.startSelectedParagraph.addEventListener("click", startFromSelectedParagraph);
ui.generateSelectedParagraph.addEventListener("click", generateSelectedParagraphAudio);
ui.addPronunciation.addEventListener("click", () => {
  updatePronunciation(ui.pronunciationFrom.value, ui.pronunciationTo.value);
  ui.pronunciationFrom.value = "";
  ui.pronunciationTo.value = "";
});
ui.addBookmark.addEventListener("click", addBookmark);
ui.goBookmark.addEventListener("click", () => {
  if (!ui.bookmarkList.value) return;
  const index = Number(ui.bookmarkList.value);
  if (Number.isInteger(index)) jump(() => navigation.jumpToSegment(index));
});
ui.searchNext.addEventListener("click", searchNext);
ui.fontSize.addEventListener("input", () => {
  applyReadingPreferences();
  localStorage.setItem(STORAGE_KEYS.fontSize, ui.fontSize.value);
});
ui.lineHeight.addEventListener("change", () => {
  applyReadingPreferences();
  localStorage.setItem(STORAGE_KEYS.lineHeight, ui.lineHeight.value);
});
ui.readingWidth.addEventListener("change", () => {
  applyReadingPreferences();
  localStorage.setItem(STORAGE_KEYS.readingWidth, ui.readingWidth.value);
});
ui.paragraphGap.addEventListener("change", () => {
  applyReadingPreferences();
  localStorage.setItem(STORAGE_KEYS.paragraphGap, ui.paragraphGap.value);
});
ui.theme.addEventListener("change", () => {
  document.body.dataset.theme = ui.theme.value;
  localStorage.setItem(STORAGE_KEYS.theme, ui.theme.value);
});
ui.prefetchAhead.addEventListener("change", () => {
  localStorage.setItem(STORAGE_KEYS.prefetchAhead, ui.prefetchAhead.value);
});
ui.sleepMinutes.addEventListener("change", () => {
  clearTimeout(sleepTimer);
  const minutes = Number(ui.sleepMinutes.value);
  if (minutes > 0) sleepTimer = setTimeout(() => {
    queue.pause();
    ui.sleepMinutes.value = "0";
    statusOverride = "睡眠定时结束，已暂停朗读。";
    render();
  }, minutes * 60000);
});
ui.retryService.addEventListener("click", async () => {
  statusOverride = "正在重新连接语音服务……";
  render();
  await Promise.all([refreshServiceState(), loadVoices()]);
  if (serviceState.status === "ready" || serviceState.status === "partial") {
    statusOverride = "语音服务连接已刷新。";
    render();
  }
});
ui.loginLibrary.addEventListener("click", loginLibrary);
ui.refreshGenerationHistory.addEventListener("click", loadGenerationHistory);
ui.loadLibrary.addEventListener("click", loadLibrary);
ui.saveBook.addEventListener("click", saveCurrentBook);
ui.generateBook.addEventListener("click", generateWholeBook);
ui.generateMissing.addEventListener("click", generateMissingAudio);
ui.generateChapter.addEventListener("click", generateCurrentChapter);
ui.pauseGeneration.addEventListener("click", pauseWholeBook);
ui.resumeGeneration.addEventListener("click", resumeWholeBook);
ui.retryGeneration.addEventListener("click", retryWholeBook);
ui.suggestSpeakers.addEventListener("click", loadSpeakerSuggestions);
ui.downloadBook.addEventListener("click", downloadWholeBook);
ui.cancelOfflineDownload.addEventListener("click", () => offlineDownload?.controller.abort());
ui.exportEpub.addEventListener("click", exportEpub);
ui.exportWav.addEventListener("click", exportWav);
ui.cancelGeneration.addEventListener("click", async () => {
  if (!currentBookId) return;
  try {
    await libraryFetch(`/v1/books/${currentBookId}/cancel`, { method: "POST" });
    await pollJob();
  } catch (error) { ui.jobStatus.textContent = error.message; }
});
ui.readingPane.addEventListener("wheel", () => { userScrollUntil = Date.now() + 8000; }, { passive: true });
ui.readingPane.addEventListener("touchstart", () => { userScrollUntil = Date.now() + 8000; }, { passive: true });
ui.readingPane.addEventListener("pointerdown", () => { userScrollUntil = Date.now() + 8000; });
ui.txtFile.addEventListener("change", () => importFile(ui.txtFile.files?.[0], "txt"));
ui.epubFile.addEventListener("change", () => importFile(ui.epubFile.files?.[0], "epub"));
ui.documentFile.addEventListener("change", () => importDocument(ui.documentFile.files?.[0]));
ui.useManual.addEventListener("click", useManualText);
ui.start.addEventListener("click", startOrResume);
ui.pause.addEventListener("click", () => queue.pause());
ui.stop.addEventListener("click", stopReading);
ui.regenerateParagraph.addEventListener("click", regenerateParagraph);
ui.previewSelection.addEventListener("click", previewSelection);
ui.previewReference.addEventListener("click", previewReference);
ui.paragraphVersions.addEventListener("change", async () => {
  const position = activePosition();
  if (!position) return renderVersionProvenance(null);
  const state = await variantStore.read(paragraphKey(position.segment));
  renderVersionProvenance(
    state.versions.find(version => version.id === ui.paragraphVersions.value) || null
  );
});
ui.selectVersion.addEventListener("click", selectParagraphVersion);
ui.deleteVersion.addEventListener("click", deleteParagraphVersion);
ui.previousSegment.addEventListener("click", () => jump(() => navigation.previousSegment()));
ui.nextSegment.addEventListener("click", () => jump(() => navigation.nextSegment()));
ui.previousChapter.addEventListener("click", () => jump(() => navigation.previousChapter()));
ui.nextChapter.addEventListener("click", () => jump(() => navigation.nextChapter()));
ui.resumeLast.addEventListener("click", () => chooseProgress(true));
ui.restartBook.addEventListener("click", () => chooseProgress(false));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveProgress(true);
});
window.addEventListener("pagehide", () => saveProgress(true));
window.addEventListener("online", syncOfflineChanges);
render();
try {
  ui.fontSize.value = readMigratedStorage(
    STORAGE_KEYS.fontSize, LEGACY_STORAGE_KEYS.fontSize
  ) || "18";
  ui.lineHeight.value = readMigratedStorage(
    STORAGE_KEYS.lineHeight, LEGACY_STORAGE_KEYS.lineHeight
  ) || "1.86";
  ui.readingWidth.value = readMigratedStorage(
    STORAGE_KEYS.readingWidth, LEGACY_STORAGE_KEYS.readingWidth
  ) || "860";
  ui.paragraphGap.value = readMigratedStorage(
    STORAGE_KEYS.paragraphGap, LEGACY_STORAGE_KEYS.paragraphGap
  ) || "1.15";
  applyReadingPreferences();
  ui.theme.value = readMigratedStorage(
    STORAGE_KEYS.theme, LEGACY_STORAGE_KEYS.theme
  ) || "auto";
  document.body.dataset.theme = ui.theme.value;
  ui.prefetchAhead.value = readMigratedStorage(
    STORAGE_KEYS.prefetchAhead, LEGACY_STORAGE_KEYS.prefetchAhead
  ) || "1";
} catch (_) { /* reader preferences stay in memory */ }
refreshServiceState();
loadVoices();
renderOfflineBooks();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/service-worker.js").catch(() => {});
}
