import { fetchJson } from "./api.js";

function createOption(select, value, label) {
  const option = select.ownerDocument.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}

function fillAssetSelect(select, items, defaultId, labelBuilder) {
  select.replaceChildren();
  for (const item of items || []) {
    select.appendChild(createOption(select, item.id, labelBuilder(item)));
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
    readVoiceCache = () => null,
    writeVoiceCache = () => {},
    onCatalogChanged = () => {},
    onMessage = () => {},
    onRender = () => {}
  }) {
    this.ui = {
      voiceSelect, modelSelect, referenceSelect,
      serviceStrip, serviceStatus, engineStatus, retryButton
    };
    this.readVoiceCache = readVoiceCache;
    this.writeVoiceCache = writeVoiceCache;
    this.onCatalogChanged = onCatalogChanged;
    this.onMessage = onMessage;
    this.onRender = onRender;
    this.catalog = new Map();
    this.serviceState = { status: "checking", engines: [] };
  }

  engineState(engineId) {
    if (!engineId) return "unknown";
    const item = this.serviceState.engines.find(engine =>
      (engine.engine || engine.id) === engineId);
    return item?.status || item?.health?.status || "unknown";
  }

  currentVoice() {
    return this.catalog.get(this.ui.voiceSelect.value) || null;
  }

  currentModel() {
    const voice = this.currentVoice();
    return voice?.models?.find(item => item.id === this.ui.modelSelect.value) || null;
  }

  playbackOptions(speedValue) {
    const speed = Number(speedValue);
    if (!this.ui.voiceSelect.value) throw new Error("请选择角色。");
    if (!Number.isFinite(speed) || speed <= 0) throw new Error("速度必须大于 0。");
    const model = this.currentModel();
    if (model?.engine && this.engineState(model.engine) === "offline") {
      throw new Error(`所选模型的语音引擎当前不可用：${model.engine}`);
    }
    return {
      voice: this.ui.voiceSelect.value,
      modelId: this.ui.modelSelect.value || null,
      referenceId: this.ui.referenceSelect.value || null,
      speed
    };
  }

  syncCharacterAssets() {
    const voice = this.currentVoice();
    if (!voice) {
      this.ui.modelSelect.replaceChildren();
      this.ui.referenceSelect.replaceChildren();
      return;
    }

    fillAssetSelect(
      this.ui.modelSelect,
      voice.models,
      voice.default_model,
      item => [item.name || item.id, item.engine, item.version].filter(Boolean).join(" · ")
    );

    for (const option of this.ui.modelSelect.options) {
      const model = voice.models.find(item => item.id === option.value);
      if (this.engineState(model?.engine) === "offline") {
        option.disabled = true;
        option.textContent += " · 引擎离线";
      }
    }
    if (this.ui.modelSelect.selectedOptions[0]?.disabled) {
      const replacement = [...this.ui.modelSelect.options].find(option => !option.disabled);
      if (replacement) this.ui.modelSelect.value = replacement.value;
    }

    fillAssetSelect(
      this.ui.referenceSelect,
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
    this.ui.referenceSelect.appendChild(
      createOption(this.ui.referenceSelect, "auto", "自动按情绪选参考（试用）")
    );
  }

  installVoices(data) {
    this.ui.voiceSelect.replaceChildren();
    this.catalog = new Map();
    for (const voice of data?.voices || []) {
      if (voice.error || !voice.id) continue;
      this.catalog.set(voice.id, voice);
      this.ui.voiceSelect.appendChild(
        createOption(this.ui.voiceSelect, voice.id, voice.name || voice.id)
      );
    }
    this.syncCharacterAssets();
    this.onCatalogChanged(this.catalog);
    if (!this.ui.voiceSelect.options.length) {
      this.onMessage("没有可用角色，请先在 Character Voice Service 中添加角色配置。");
    }
    this.onRender();
  }

  async loadVoices() {
    try {
      const data = await fetchJson("/v1/voices");
      try { this.writeVoiceCache(data); } catch (_) {}
      this.installVoices(data);
      return { source: "live", data };
    } catch (error) {
      try {
        const cached = this.readVoiceCache();
        if (cached?.voices?.length) {
          this.installVoices(cached);
          this.onMessage(`当前离线；使用已保存的角色列表。 ${error.message}`);
          this.onRender();
          return { source: "cache", data: cached, error };
        }
      } catch (_) {}
      this.onMessage(`无法读取角色列表：${error.message}`);
      this.onRender();
      return { source: "none", error };
    }
  }

  renderServiceState() {
    const status = this.serviceState.status || "offline";
    this.ui.serviceStrip.dataset.state = status;
    const labels = {
      ready: "Character Voice Service：在线",
      partial: "Character Voice Service：部分可用",
      checking: "Character Voice Service：检查中…",
      offline: "Character Voice Service：不可用"
    };
    this.ui.serviceStatus.textContent = labels[status] || labels.offline;

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
      const ready = engines.filter(item =>
        (item.status || item.health?.status) === "ready").length;
      this.serviceState = {
        status: health?.cvs?.status === "offline"
          ? "offline"
          : (engines.length && ready < engines.length ? "partial" : "ready"),
        engines,
        error: health?.cvs?.error || null
      };
    } catch (error) {
      this.serviceState = { status: "offline", engines: [], error: error.message };
    } finally {
      this.ui.retryButton.disabled = false;
      this.renderServiceState();
      if (this.ui.voiceSelect.value) this.syncCharacterAssets();
      this.onCatalogChanged(this.catalog);
      this.onRender();
    }
    return this.serviceState;
  }

  async retry() {
    this.onMessage("正在重新连接语音服务……");
    this.onRender();
    await Promise.all([this.refreshServiceState(), this.loadVoices()]);
    if (["ready", "partial"].includes(this.serviceState.status)) {
      this.onMessage("语音服务连接已刷新。");
      this.onRender();
    }
    return this.serviceState;
  }
}
