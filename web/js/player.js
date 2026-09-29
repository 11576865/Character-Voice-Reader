export class AudioPlayer {
  constructor(audioElement, { onEnded, onError, onTimeUpdate } = {}) {
    this.audio = audioElement;
    this.objectUrl = null;
    this.pendingSeek = null;
    audioElement.addEventListener("ended", () => onEnded?.());
    audioElement.addEventListener("error", () => {
      if (this.objectUrl) onError?.(new Error("浏览器无法播放 WAV 音频。"));
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
    this.objectUrl = null;
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
    if (oldUrl) URL.revokeObjectURL(oldUrl);
  }
}
