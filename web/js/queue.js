export class ReaderQueue {
  constructor({ player, requestAudio, onChange = () => {} }) {
    this.player = player;
    this.requestAudio = requestAudio;
    this.onChange = onChange;
    this.session = 0;
    this.requests = new Set();
    this.segments = [];
    this.index = 0;
    this.nextAudio = null;
    this.prefetchPromise = null;
    this.voice = null;
    this.modelId = null;
    this.referenceId = null;
    this.speed = 1;
    this.state = "idle";
    this.error = null;
  }

  get snapshot() {
    return {
      state: this.state,
      index: this.index,
      total: this.segments.length,
      currentSegment: this.segments[this.index] || null,
      nextSegment: this.segments[this.index + 1] || null,
      prefetchReady: Boolean(this.nextAudio),
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

  #reset() {
    this.session += 1;
    // Suppress timeupdate/ended callbacks from the audio being discarded.
    this.state = "idle";
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
    this.player.stop();
    this.nextAudio = null;
    this.prefetchPromise = null;
    this.segments = [];
    this.index = 0;
    this.error = null;
  }

  async #fetch(index, session) {
    const controller = new AbortController();
    this.requests.add(controller);
    try {
      const blob = await this.requestAudio({
        segment: this.segments[index],
        voice: this.voice,
        modelId: this.modelId,
        referenceId: this.referenceId,
        speed: this.speed,
        signal: controller.signal
      });
      return session === this.session ? blob : null;
    } finally {
      this.requests.delete(controller);
    }
  }

  #prefetch(session) {
    const nextIndex = this.index + 1;
    if (nextIndex >= this.segments.length) return;
    this.prefetchPromise = this.#fetch(nextIndex, session)
      .then(blob => {
        if (session !== this.session || !blob) return null;
        this.nextAudio = { index: nextIndex, blob };
        this.#notify();
        return this.nextAudio;
      })
      .catch(error => ({ index: nextIndex, error }));
  }

  async #play(blob, session, audioTime = 0) {
    if (session !== this.session) return;
    this.#setState("playing");
    try {
      await this.player.play(blob, audioTime);
    } catch (error) {
      if (session === this.session) this.#fail(error);
      return;
    }
    if (session === this.session && (this.state === "playing" || this.state === "paused")) {
      this.#prefetch(session);
    }
  }

  #fail(error) {
    this.#reset();
    this.#setState("stopped", error);
  }

  async start(segments, { voice, modelId = null, referenceId = null, speed = 1, startIndex = 0, audioTime = 0 }) {
    if (!Array.isArray(segments) || segments.length === 0) throw new Error("没有可朗读的片段。");
    if (!voice) throw new Error("请选择角色。");
    if (!Number.isFinite(speed) || speed <= 0) throw new Error("速度必须大于 0。");
    if (!Number.isInteger(startIndex) || startIndex < 0 || startIndex >= segments.length) {
      throw new Error("起始片段越界。");
    }
    this.#reset();
    this.segments = segments;
    this.index = startIndex;
    this.voice = voice;
    this.modelId = modelId || null;
    this.referenceId = referenceId || null;
    this.speed = speed;
    const session = this.session;
    this.#setState("generating");
    try {
      const blob = await this.#fetch(startIndex, session);
      if (session === this.session && blob) await this.#play(blob, session, audioTime);
    } catch (error) {
      if (session === this.session) this.#fail(error);
    }
  }

  async handleEnded() {
    if (this.state !== "playing") return;
    const session = this.session;
    this.index += 1;
    if (this.index >= this.segments.length) {
      this.player.stop();
      this.nextAudio = null;
      this.prefetchPromise = null;
      this.#setState("finished");
      return;
    }
    let next = this.nextAudio;
    if (!next) {
      this.#setState("generating");
      next = this.prefetchPromise ? await this.prefetchPromise : null;
    }
    if (session !== this.session) return;
    if (!next || next.error || next.index !== this.index) {
      this.#fail(next?.error || new Error("下一段预取失败。"));
      return;
    }
    this.nextAudio = null;
    this.prefetchPromise = null;
    await this.#play(next.blob, session);
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
      this.#setState("paused", error);
    }
  }

  stop() {
    this.#reset();
    this.#setState("stopped");
  }

  handlePlayerError(error) {
    if (this.state === "playing" || this.state === "paused") this.#fail(error);
  }
}
