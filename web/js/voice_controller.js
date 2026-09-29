import { fetchJson } from "./api.js";

function fillSelect(select, items, defaultId, labelBuilder) {
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

export class VoiceController {
  constructor({
    voiceSelect,
    modelSelect,
    referenceSelect,
    serviceStrip,
    serviceStatus,
    engineStatus,
    retryButton,
    cacheKey,
    legacyCacheKey,
    readMigratedStorage,
    onStatus = () => {},
    onVoicesInstalled = () => {},
    onChanged = () => {},
  }) {
    this.ui = {
      voice: voiceSelect,
      model: modelSelect,
      reference: referenceSelect,
      serviceStrip,
      serviceStatus,
      engineStatus,
      retryButton,
    };
    this.cacheKey = cacheKey;
    this.legacyCacheKey = legacyCacheKey;
    this.readMigratedStorage = readMigratedStorage;
    this.onStatus = onStatus;
    this.onVoicesInstalled = onVoicesInstalled;
    this.onChanged = onChanged;
    this.catalog = new Map();
    this.serviceState = { status: "checking", engines: [] };

    this.ui.voice.addEventListener("change", () => {
      this.syncCharacterAssets();
      this.onChanged();
    });
  }

  currentVoice() {
    return this.catalog.get(this.ui.voice.value) || null;
  }

  engineState(engineId) {
    if (!engineId) return "unknown";
    const item = this.serviceState.engines.find(engine =>
      (engine.engine || engine.id) === engineId);
    return item?.status || item?.health?.status || "unknown";
  }

  currentModel() {
    const voice = this.currentVoice();
    if (!voice) return null;
    return (voice.models || []).find(item => item.id === this.ui.model.value) || null;
  }

  playbackOptions(speedValue) {
    const speed = Number(speedValue);
    if (!this.ui.voice.value) throw new Error("请选择角色。");
    if (!Number.isFinite(speed) || speed <= 0) throw new Error("速度必须大于 0。");
    const model = this.currentModel();
    if (model?.engine && this.engineState(model.engine) === "offline") {
      throw new Error(`所选模型的语音引擎当前不可用：${model.engine}`);
    }
    return {
      voice: this.ui.voice.value,
      modelId: this.ui.model.value || null,
      referenceId: this.ui.reference.value || null,
      speed,
    };
  }

  syncCharacterAssets() {
    const voice = this.currentVoice();
    if (!voice) {
      this.ui.model.replaceChildren();
      this.ui.reference.replaceChildren();
      return;
    }

    fillSelect(
      this.ui.model,
      voice.models,
      voice.default_model,
      item => [item.name || item.id, item.engine, item.version].filter(Boolean).join(" · ")
    );

    for (const option of this.ui.model.options) {
      const model = (voice.models || []).find(item => item.id === option.value);
      if (this.engineState(model?.engine) === "offline") {
        option.disabled = true;
        option.textContent += " · 引擎离线";
      }
    }
    if (this.ui.model.selectedOptions[0]?.disabled) {
      const replacement = [...this.ui.model.options].find(option => !option.disabled);
      if (replacement) this.ui.model.value = replacement.value;
    }

    fillSelect(
      this.ui.reference,
      voice.references,
      voice.default_reference,
      item => {
        const details = [
          item.emotion,
          item.intensity === null || item.intensity === undefined ? "" : item.intensity,
          item.quality,
        ].filter(value => value !== "");
        return details.length
          ? `${item.name || item.id} · ${details.join(" · ")}`
          : (item.name || item.id);
      }
    );
    const automatic = document.createElement("option");
    automatic.value = "auto";
    automatic.textContent = "自动按情绪选参考（试用）";
    this.ui.reference.appendChild(automatic);
  }

  installVoices(data) {
    this.ui.voice.replaceChildren();
    this.catalog = new Map();

    for (const voice of data.voices || []) {
      if (voice.error) continue;
      this.catalog.set(voice.id, voice);
      const option = document.createElement("option");
      option.value = voice.id;
      option.textContent = voice.name || voice.id;
      this.ui.voice.appendChild(option);
    }

    this.syncCharacterAssets();
    if (!this.ui.voice.options.length) {
      this.onStatus("没有可用角色，请先在 CVS 中添加角色配置。");
    }
    this.onVoicesInstalled(this.catalog);
    this.onChanged();
  }

  async loadVoices() {
    try {
      const data = await fetchJson("/v1/voices");
      try { localStorage.setItem(this.cacheKey, JSON.stringify(data)); }
      catch (_) {}
      this.installVoices(data);
      return { online: true };
    } catch (error) {
      try {
        const cached = JSON.parse(
          this.readMigratedStorage(this.cacheKey, this.legacyCacheKey) || "null"
        );
        if (cached?.voices?.length) {
          this.installVoices(cached);
          this.onStatus(`当前离线；使用已保存的角色列表。 ${error.message}`);
          return { online: false, cached: true, error };
        }
      } catch (_) {}
      this.onStatus(`无法读取角色列表：${error.message}`);
      this.onChanged();
      return { online: false, cached: false, error };
    }
  }

  renderServiceState() {
    const status = this.serviceState.status || "offline";
    this.ui.serviceStrip.dataset.state = status;
    if (status === "ready") {
      this.ui.serviceStatus.textContent = "Character Voice Service：在线";
    } else if (status === "partial") {
      this.ui.serviceStatus.textContent = "Character Voice Service：部分可用";
    } else if (status === "checking") {
      this.ui.serviceStatus.textContent = "Character Voice Service：检查中…";
    } else {
      this.ui.serviceStatus.textContent = "Character Voice Service：不可用";
    }

    if (!this.serviceState.engines.length) {
      this.ui.engineStatus.textContent = status === "offline"
        ? (this.serviceState.error || "无法读取引擎状态")
        : "未发现语音引擎";
      return;
    }

    this.ui.engineStatus.textContent = this.serviceState.engines.map(item => {
      const id = item.engine || item.id || "unknown";
      const state = item.status || item.health?.status || "unknown";
      return `${id}: ${state}`;
    }).join(" · ");
  }

  async refreshServiceState() {
    this.serviceState = { status: "checking", engines: [] };
    this.renderServiceState();
    this.ui.retryButton.disabled = true;
    try {
      const [health, discovery] = await Promise.all([
        fetchJson("/health"),
        fetchJson("/v1/engines"),
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
      const ready = engines.filter(item =>
        (item.status || item.health?.status) === "ready").length;
      this.serviceState = {
        status: health?.cvs?.status === "offline"
          ? "offline"
          : (engines.length && ready < engines.length ? "partial" : "ready"),
        engines,
        error: health?.cvs?.error || null,
      };
    } catch (error) {
      this.serviceState = { status: "offline", engines: [], error: error.message };
    } finally {
      this.ui.retryButton.disabled = false;
      this.renderServiceState();
      if (this.ui.voice.value) this.syncCharacterAssets();
      this.onChanged();
    }
    return this.serviceState;
  }

  async retry() {
    this.onStatus("正在重新连接语音服务……");
    const [service] = await Promise.all([
      this.refreshServiceState(),
      this.loadVoices(),
    ]);
    if (service.status === "ready" || service.status === "partial") {
      this.onStatus("语音服务连接已刷新。");
    }
    this.onChanged();
    return service;
  }
}
