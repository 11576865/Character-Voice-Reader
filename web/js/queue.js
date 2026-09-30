export class ReaderQueue {
  constructor({
    player,
    requestAudio,
    onChange = () => {},
    prefetchDepth = 2,
    retryLimit = 1
  }) {
    if (!Number.isInteger(prefetchDepth) || prefetchDepth < 0) {
      throw new Error("prefetchDepth must be a non-negative integer.");
    }
    if (!Number.isInteger(retryLimit) || retryLimit < 0) {
      throw new Error("retryLimit must be a non-negative integer.");
    }

    this.player = player;
    this.requestAudio = requestAudio;
    this.onChange = onChange;
    this.prefetchDepth = prefetchDepth;
    this.retryLimit = retryLimit;

    this.generationRevision = 0;
    this.playbackRevision = 0;
    this.requests = new Set();
    this.prefetches = new Map();

    this.segments = [];
    this.index = 0;
    this.voice = null;
    this.modelId = null;
    this.referenceId = null;
    this.speed = 1;

    this.state = "idle";
    this.error = null;
  }

  get snapshot() {
    const next = this.prefetches.get(this.index + 1);
    let prefetchReadyCount = 0;
    let prefetchPendingCount = 0;
    for (const [index, entry] of this.prefetches.entries()) {
      if (index <= this.index) continue;
      if (entry.status === "ready") prefetchReadyCount += 1;
      if (entry.status === "pending") prefetchPendingCount += 1;
    }
    return {
      state: this.state,
      index: this.index,
      total: this.segments.length,
      currentSegment: this.segments[this.index] || null,
      nextSegment: this.segments[this.index + 1] || null,
      prefetchReady: next?.status === "ready",
      prefetchReadyCount,
      prefetchPendingCount,
      prefetchDepth: this.prefetchDepth,
      generationRevision: this.generationRevision,
      playbackRevision: this.playbackRevision,
      error: this.error
    };
  }

  #notify() {
    this.onChange(this.snapshot);
  }

  #setState(state, error = null) {
    this.state = state;
    this.error = error;
    this.#notify();
  }

  #abortRequests() {
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
  }

  #clearPrefetches() {
    this.prefetches.clear();
  }

  #invalidate({ clearSegments, state }) {
    this.generationRevision += 1;
    this.playbackRevision += 1;

    // Suppress timeupdate/ended callbacks from the audio being discarded.
    this.state = state;
    this.error = null;
    this.#abortRequests();
    this.#clearPrefetches();
    this.player.stop();

    if (clearSegments) {
      this.segments = [];
      this.index = 0;
      this.voice = null;
      this.modelId = null;
      this.referenceId = null;
      this.speed = 1;
    }
  }

  #isAbort(error) {
    return error?.name === "AbortError";
  }

  async #fetchOnce(index, generationRevision) {
    if (generationRevision !== this.generationRevision) return null;

    const controller = new AbortController();
    this.requests.add(controller);
    try {
      const blob = await this.requestAudio({
        segment: this.segments[index],
        voice: this.voice,
        modelId: this.modelId,
        referenceId: this.referenceId,
        speed: this.speed,
        signal: controller.signal,
        generationRevision,
        playbackRevision: this.playbackRevision
      });
      return generationRevision === this.generationRevision ? blob : null;
    } finally {
      this.requests.delete(controller);
    }
  }

  async #fetchWithRetry(index, generationRevision) {
    let lastError = null;
    for (let attempt = 0; attempt <= this.retryLimit; attempt += 1) {
      try {
        return await this.#fetchOnce(index, generationRevision);
      } catch (error) {
        if (generationRevision !== this.generationRevision || this.#isAbort(error)) throw error;
        lastError = error;
      }
    }
    throw lastError || new Error("音频生成失败。");
  }

  #ensurePrefetch(index, generationRevision, after = null) {
    if (index < 0 || index >= this.segments.length) return null;
    const existing = this.prefetches.get(index);
    if (existing) return existing.promise;

    const entry = {
      index,
      status: "pending",
      blob: null,
      error: null,
      promise: null
    };

    // GPU engines are intentionally treated as single-concurrency resources.
    // Keep a two-segment look-ahead window, but generate the look-ahead clips
    // sequentially instead of issuing two synthesis requests at once.
    entry.promise = Promise.resolve(after)
      .then(previousEntry => {
        if (generationRevision !== this.generationRevision) return null;
        if (previousEntry?.status === "error") {
          throw previousEntry.error || new Error("前序预取失败。");
        }
        return this.#fetchWithRetry(index, generationRevision);
      })
      .then(blob => {
        if (generationRevision !== this.generationRevision || !blob) return null;
        entry.status = "ready";
        entry.blob = blob;
        this.#notify();
        return entry;
      })
      .catch(error => {
        if (generationRevision !== this.generationRevision || this.#isAbort(error)) return null;
        entry.status = "error";
        entry.error = error;
        this.#notify();
        return entry;
      });

    this.prefetches.set(index, entry);
    return entry.promise;
  }

  #fillPrefetches(generationRevision) {
    if (generationRevision !== this.generationRevision) return;

    for (const index of [...this.prefetches.keys()]) {
      if (index <= this.index) this.prefetches.delete(index);
    }

    let previous = null;
    for (let offset = 1; offset <= this.prefetchDepth; offset += 1) {
      const index = this.index + offset;
      if (index >= this.segments.length) break;
      const existing = this.prefetches.get(index);
      previous = existing?.promise || this.#ensurePrefetch(index, generationRevision, previous);
    }
  }

  async #play(blob, generationRevision, audioTime = 0) {
    if (generationRevision !== this.generationRevision || !blob) return;

    this.#setState("playing");
    try {
      await this.player.play(blob, audioTime);
    } catch (error) {
      if (generationRevision === this.generationRevision) this.#enterError(error);
      return;
    }

    if (generationRevision === this.generationRevision &&
        (this.state === "playing" || this.state === "paused")) {
      this.#fillPrefetches(generationRevision);
    }
  }

  #enterError(error) {
    // Invalidate every in-flight response but preserve the current playback target
    // so the user can retry or skip without reconstructing the whole document.
    this.generationRevision += 1;
    this.#abortRequests();
    this.#clearPrefetches();
    this.player.stop();
    this.#setState("error", error instanceof Error ? error : new Error(String(error)));
  }

  async start(segments, {
    voice,
    modelId = null,
    referenceId = null,
    speed = 1,
    startIndex = 0,
    audioTime = 0
  }) {
    if (!Array.isArray(segments) || segments.length === 0) throw new Error("没有可朗读的片段。");
    if (!voice) throw new Error("请选择角色。");
    if (!Number.isFinite(speed) || speed <= 0) throw new Error("速度必须大于 0。");
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= segments.length) {
      throw new Error("起始片段越界。");
    }

    this.#invalidate({ clearSegments: true, state: "idle" });
    this.segments = segments;
    this.index = startIndex;
    this.voice = voice;
    this.modelId = modelId || null;
    this.referenceId = referenceId || null;
    this.speed = speed;
    this.playbackRevision += 1;

    const generationRevision = this.generationRevision;
    this.#setState("loading");

    try {
      const blob = await this.#fetchWithRetry(startIndex, generationRevision);
      if (generationRevision === this.generationRevision && blob) {
        await this.#play(blob, generationRevision, audioTime);
      }
    } catch (error) {
      if (generationRevision === this.generationRevision && !this.#isAbort(error)) {
        this.#enterError(error);
      }
    }
  }

  async handleEnded() {
    if (this.state !== "playing") return;

    const nextIndex = this.index + 1;
    if (nextIndex >= this.segments.length) {
      this.player.stop();
      this.#abortRequests();
      this.#clearPrefetches();
      this.#setState("finished");
      return;
    }

    const generationRevision = this.generationRevision;
    this.index = nextIndex;
    this.playbackRevision += 1;
    this.#setState("advancing");

    let entry = this.prefetches.get(nextIndex);
    if (!entry) {
      this.#ensurePrefetch(nextIndex, generationRevision);
      entry = this.prefetches.get(nextIndex);
    }

    const resolved = entry?.status === "pending" ? await entry.promise : entry;
    if (generationRevision !== this.generationRevision) return;

    if (!resolved || resolved.status === "error" || !resolved.blob) {
      this.#enterError(resolved?.error || new Error("下一段生成失败。"));
      return;
    }

    this.prefetches.delete(nextIndex);
    await this.#play(resolved.blob, generationRevision);
  }

  pause() {
    if (this.state !== "playing") return;
    this.player.pause();
    this.#setState("paused");
  }

  async resume() {
    if (this.state !== "paused") return;
    try {
      await this.player.resume();
      if (this.state === "paused") this.#setState("playing");
    } catch (error) {
      this.#setState("paused", error instanceof Error ? error : new Error(String(error)));
    }
  }

  async retry() {
    if (this.state !== "error" || !this.segments[this.index]) return false;

    this.generationRevision += 1;
    this.playbackRevision += 1;
    this.#abortRequests();
    this.#clearPrefetches();
    this.error = null;

    const generationRevision = this.generationRevision;
    this.#setState("loading");

    try {
      const blob = await this.#fetchWithRetry(this.index, generationRevision);
      if (generationRevision === this.generationRevision && blob) {
        await this.#play(blob, generationRevision);
        return true;
      }
    } catch (error) {
      if (generationRevision === this.generationRevision && !this.#isAbort(error)) {
        this.#enterError(error);
      }
    }
    return false;
  }

  stop() {
    this.#invalidate({ clearSegments: true, state: "cancelled" });
    this.#notify();
  }

  handlePlayerError(error) {
    if (this.state === "playing" || this.state === "paused") this.#enterError(error);
  }
}
