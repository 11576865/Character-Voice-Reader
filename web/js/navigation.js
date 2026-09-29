export function chapterStart(segments, chapterIndex) {
  return segments.findIndex(segment => segment.chapterIndex === chapterIndex);
}

export function chapterPosition(segments, index) {
  const segment = segments[index];
  if (!segment) return { index: 0, total: 0 };
  const sameChapter = segments.filter(item => item.chapterIndex === segment.chapterIndex);
  return {
    index: sameChapter.findIndex(item => item.index === segment.index) + 1,
    total: sameChapter.length
  };
}

export class ReaderNavigation {
  constructor({ document, segments, queue, getPlaybackOptions, onJump = () => {} }) {
    this.document = document;
    this.segments = segments;
    this.queue = queue;
    this.getPlaybackOptions = getPlaybackOptions;
    this.onJump = onJump;
    this.lastIndex = 0;
  }

  sync(snapshot) {
    if (snapshot.currentSegment) this.lastIndex = snapshot.index;
  }

  get currentSegment() {
    return this.segments[this.lastIndex] || null;
  }

  async jumpToSegment(index, audioTime = 0) {
    if (!Number.isInteger(index) || index < 0 || index >= this.segments.length) return false;
    const options = this.getPlaybackOptions();
    this.lastIndex = index;
    this.onJump({ index, audioTime });
    await this.queue.start(this.segments, {
      ...options, startIndex: index, audioTime
    });
    return true;
  }

  jumpToChapter(chapterIndex) {
    const index = chapterStart(this.segments, chapterIndex);
    return index < 0 ? Promise.resolve(false) : this.jumpToSegment(index);
  }

  previousSegment() { return this.jumpToSegment(this.lastIndex - 1); }
  nextSegment() { return this.jumpToSegment(this.lastIndex + 1); }

  previousChapter() {
    const chapterIndex = this.currentSegment?.chapterIndex ?? 0;
    for (let index = chapterIndex - 1; index >= 0; index -= 1) {
      if (chapterStart(this.segments, index) >= 0) return this.jumpToChapter(index);
    }
    return Promise.resolve(false);
  }

  nextChapter() {
    const chapterIndex = this.currentSegment?.chapterIndex ?? -1;
    for (let index = chapterIndex + 1; index < this.document.chapters.length; index += 1) {
      if (chapterStart(this.segments, index) >= 0) return this.jumpToChapter(index);
    }
    return Promise.resolve(false);
  }
}
