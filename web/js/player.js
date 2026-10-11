export class AudioPlayer {
  constructor(audioElement, { onEnded, onError, onTimeUpdate } = {}) {
    this.audio = audioElement;
    this.objectUrl = null;
    this.pendingSeek = null;
    audioElement.addEventListener("ended", () => onEnded?.());
    audioElement.addEventListener("error", () => {
      // load() / removal of a previous src may dispatch delayed errors. An
      // active Blob URL alone is not proof that this event belongs to it.
      if (!this.objectUrl || !audioElement.error ||
          audioElement.currentSrc !== this.objectUrl) return;
      const sinkUnavailable = /OnMediaSinkAudioError/i.test(audioElement.error.message || "");
      onError?.(new Error(sinkUnavailable
        ? "音频已载入，但浏览器无法连接音频输出设备；请检查扬声器、耳机和系统音频设置"
        : "浏览器无法解码当前音频；请检查音频文件是否完整，以及浏览器是否支持该音频格式"));
    });
    audioElement.addEventListener("timeupdate", () => onTimeUpdate?.(audioElement.currentTime));
  }

  get currentTime() { return this.audio.currentTime || 0; }

  async play(blob, startTime = 0) {
    this.stop();
    this.objectUrl = URL.createObjectURL(blob);
    this.audio.src = this.objectUrl;
    if (startTime > 0) {
      const seek = () => {
        this.pendingSeek = null;
        if (!this.objectUrl) return;
        const duration = this.audio.duration;
        this.audio.currentTime = Number.isFinite(duration)
          ? Math.min(startTime, Math.max(0, duration - 0.1)) : startTime;
      };
      if (this.audio.readyState >= 1) seek();
      else {
        this.pendingSeek = seek;
        this.audio.addEventListener("loadedmetadata", seek, { once: true });
      }
    }
    await this.audio.play();
  }

  pause() {
    this.audio.pause();
  }

  async resume() {
    await this.audio.play();
  }

  stop() {
    if (this.pendingSeek) this.audio.removeEventListener("loadedmetadata", this.pendingSeek);
    this.pendingSeek = null;
    const oldUrl = this.objectUrl;
    const hadSource = Boolean(oldUrl || this.audio.getAttribute("src"));
    this.objectUrl = null;
    this.audio.pause();
    this.audio.removeAttribute("src");
    // A no-op reset on a never-used audio element can produce a later
    // error event on Firefox after the next source has been attached.
    if (hadSource) this.audio.load();
    if (oldUrl) URL.revokeObjectURL(oldUrl);
  }
}
