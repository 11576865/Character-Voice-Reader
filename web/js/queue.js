export class ReaderQueue {
  constructor({ player, requestAudio, onChange = () => {} }) {
    this.player = player;
    this.requestAudio = requestAudio;
    this.onChange = onChange;
    this.session = 0;
    this.requests = new Set();
    this.segments = [];
    this.index = 0;
    this.prefetchedAudio = new Map();
    this.prefetchPromises = new Map();
    this.prefetchTail = Promise.resolve();
    // Compatibility/debug handle: promise for the immediate next segment.
    this.prefetchPromise = null;
    this.nextAudio = null;
    this.voice = null;
    this.modelId = null;
    this.referenceId = null;
    this.speed = 1;
    this.prefetchAhead = 1;
    this.state = "idle";
    this.error = null;
  }

  get snapshot() {
    const next = this.prefetchedAudio.get(this.index + 1);
    return {
      state: this.state,
      index: this.index,
      total: this.segments.length,
      currentSegment: this.segments[this.index] || null,
      nextSegment: this.segments[this.index + 1] || null,
      prefetchReady: Boolean(next?.blob),
      prefetchCount: [...this.prefetchedAudio.values()].filter(item => item?.blob).length,
      prefetchAhead: this.prefetchAhead,
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
    this.prefetchedAudio.clear();
    this.prefetchPromises.clear();
    this.prefetchTail = Promise.resolve();
    this.prefetchPromise = null;
    this.nextAudio = null;
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

  #queuePrefetch(index, session) {
    if (index >= this.segments.length) return null;
    if (this.prefetchedAudio.has(index)) {
      return Promise.resolve(this.prefetchedAudio.get(index));
    }
    if (this.prefetchPromises.has(index)) return this.prefetchPromises.get(index);

    const promise = this.prefetchTail.then(async () => {
      if (session !== this.session) return null;
      try {
        const blob = await this.#fetch(index, session);
        if (session !== this.session || !blob) return null;
        const item = { index, blob };
        this.prefetchedAudio.set(index, item);
        if (index === this.index + 1) this.nextAudio = item;
        this.#notify();
        return item;
      } catch (error) {
        if (session !== this.session) return null;
        const item = { index, error };
        this.prefetchedAudio.set(index, item);
        this.#notify();
        return item;
      } finally {
        this.prefetchPromises.delete(index);
      }
    });

    this.prefetchPromises.set(index, promise);
    // Serialize TTS work so a larger lookahead does not fan out concurrent
    // model requests or trigger competing runtime switches.
    this.prefetchTail = promise.then(() => undefined, () => undefined);
    return promise;
  }

  #prefetch(session) {
    const end = Math.min(
      this.segments.length - 1,
      this.index + this.prefetchAhead
    );
    for (let index = this.index + 1; index <= end; index += 1) {
      this.#queuePrefetch(index, session);
    }
    this.prefetchPromise = this.prefetchPromises.get(this.index + 1) || null;
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

  async start(
    segments,
    {
      voice,
      modelId = null,
      referenceId = null,
      speed = 1,
      prefetchAhead = 1,
      startIndex = 0,
      audioTime = 0
    }
  ) {
    if (!Array.isArray(segments) || segments.length === 0) throw new Error("没有可朗读的片段。");
    if (!voice) throw new Error("请选择角色。");
    if (!Number.isFinite(speed) || speed <= 0) throw new Error("速度必须大于 0。");
    if (!Number.isInteger(prefetchAhead) || prefetchAhead < 0 || prefetchAhead > 4) {
      throw new Error("预生成段数必须是 0 到 4 的整数。");
    }
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
    this.prefetchAhead = prefetchAhead;
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
      this.prefetchedAudio.clear();
      this.prefetchPromises.clear();
      this.prefetchPromise = null;
      this.nextAudio = null;
      this.#setState("finished");
      return;
    }

    let next = this.prefetchedAudio.get(this.index);
    if (!next) {
      this.#setState("generating");
      const pending = this.prefetchPromises.get(this.index) ||
        this.#queuePrefetch(this.index, session);
      next = pending ? await pending : null;
    }
    if (session !== this.session) return;
    if (!next || next.error || next.index !== this.index) {
      this.#fail(next?.error || new Error("下一段预取失败。"));
      return;
    }

    this.prefetchedAudio.delete(this.index);
    this.prefetchPromises.delete(this.index);
    this.nextAudio = this.prefetchedAudio.get(this.index + 1) || null;
    this.prefetchPromise = this.prefetchPromises.get(this.index + 1) || null;
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
