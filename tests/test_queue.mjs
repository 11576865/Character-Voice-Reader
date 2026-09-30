import assert from "node:assert/strict";
import { ReaderQueue } from "../web/js/queue.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fakePlayer() {
  return {
    plays: [],
    pauses: 0,
    stops: 0,
    async play(blob, time = 0) { this.plays.push({ blob, time }); },
    pause() { this.pauses += 1; },
    async resume() {},
    stop() { this.stops += 1; }
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

async function testTwoAheadPrefetch() {
  const requests = [];
  const player = fakePlayer();
  const queue = new ReaderQueue({
    player,
    prefetchDepth: 2,
    requestAudio({ segment, signal, generationRevision, playbackRevision }) {
      const task = deferred();
      requests.push({ segment, signal, generationRevision, playbackRevision, task });
      return task.promise;
    }
  });
  const segments = ["A", "B", "C", "D"].map((text, index) => ({ index, text }));
  const started = queue.start(segments, { voice: "march-7th" });
  assert.equal(queue.state, "loading");
  assert.equal(requests.length, 1);

  requests[0].task.resolve(new Blob(["A"]));
  await started;
  assert.equal(queue.state, "playing");
  assert.equal(requests.length, 3, "current segment should prefetch the next two segments");
  assert.equal(queue.snapshot.prefetchDepth, 2);
  assert.equal(queue.snapshot.prefetchPendingCount, 2);

  requests[1].task.resolve(new Blob(["B"]));
  requests[2].task.resolve(new Blob(["C"]));
  await flush();
  assert.equal(queue.snapshot.prefetchReadyCount, 2);

  await queue.handleEnded();
  assert.equal(queue.index, 1);
  assert.equal(queue.state, "playing");
  assert.equal(player.plays.length, 2);
  assert.equal(requests.length, 4, "advancing should refill two-ahead window");
}

async function testStaleResponsesCannotWin() {
  const requests = [];
  const player = fakePlayer();
  const queue = new ReaderQueue({
    player,
    requestAudio({ segment, signal, generationRevision }) {
      const task = deferred();
      requests.push({ segment, signal, generationRevision, task });
      return task.promise;
    }
  });
  const segments = ["A", "B"].map((text, index) => ({ index, text }));

  const first = queue.start(segments, { voice: "march-7th", startIndex: 0 });
  const firstRequest = requests[0];
  const second = queue.start(segments, { voice: "march-7th", startIndex: 1 });
  assert.equal(firstRequest.signal.aborted, true);
  const secondRequest = requests.at(-1);

  firstRequest.task.resolve(new Blob(["stale"]));
  await first;
  assert.equal(player.plays.length, 0, "late response from old revision must be discarded");

  secondRequest.task.resolve(new Blob(["fresh"]));
  await second;
  assert.equal(queue.index, 1);
  assert.equal(player.plays.length, 1);
}

async function testRetryOnceThenError() {
  let attempts = 0;
  const player = fakePlayer();
  const queue = new ReaderQueue({
    player,
    retryLimit: 1,
    async requestAudio() {
      attempts += 1;
      throw new Error(`boom-${attempts}`);
    }
  });
  await queue.start([{ index: 0, text: "A" }], { voice: "march-7th" });
  assert.equal(attempts, 2, "one automatic retry should make two total attempts");
  assert.equal(queue.state, "error");
  assert.match(queue.snapshot.error.message, /boom-2/);
  assert.equal(queue.snapshot.total, 1, "error state must retain current playback target");
}

async function testManualRetryAfterError() {
  let attempts = 0;
  const player = fakePlayer();
  const queue = new ReaderQueue({
    player,
    retryLimit: 1,
    async requestAudio() {
      attempts += 1;
      if (attempts <= 2) throw new Error("temporary");
      return new Blob(["ok"]);
    }
  });
  await queue.start([{ index: 0, text: "A" }], { voice: "march-7th" });
  assert.equal(queue.state, "error");
  const previousGeneration = queue.snapshot.generationRevision;

  const recovered = await queue.retry();
  assert.equal(recovered, true);
  assert.equal(queue.state, "playing");
  assert.ok(queue.snapshot.generationRevision > previousGeneration);
  assert.equal(player.plays.length, 1);
}

async function testPauseStopSemantics() {
  const player = fakePlayer();
  const queue = new ReaderQueue({
    player,
    async requestAudio() { return new Blob(["audio"]); }
  });
  await queue.start([{ index: 0, text: "A" }], { voice: "march-7th" });
  queue.pause();
  assert.equal(queue.state, "paused");
  assert.equal(player.pauses, 1);

  const beforeStop = queue.snapshot.generationRevision;
  queue.stop();
  assert.equal(queue.state, "cancelled");
  assert.equal(queue.snapshot.total, 0);
  assert.ok(queue.snapshot.generationRevision > beforeStop);
}

await testTwoAheadPrefetch();
await testStaleResponsesCannotWin();
await testRetryOnceThenError();
await testManualRetryAfterError();
await testPauseStopSemantics();

console.log("PASS: ReaderQueue resilient playback tests");
