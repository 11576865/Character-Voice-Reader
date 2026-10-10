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
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function testConfigurableSequentialPrefetch() {
  const requests = [];
  const player = fakePlayer();
  const queue = new ReaderQueue({
    player,
    requestAudio({ segment, signal, generationRevision, playbackRevision }) {
      const task = deferred();
      requests.push({ segment, signal, generationRevision, playbackRevision, task });
      return task.promise;
    }
  });
  const segments = ["A", "B", "C", "D"].map((text, index) => ({ index, text }));
  const started = queue.start(segments, { voice: "march-7th", prefetchAhead: 2 });
  assert.equal(queue.state, "loading");
  assert.equal(requests.length, 1);

  requests[0].task.resolve(new Blob(["A"]));
  await started;
  assert.equal(queue.state, "playing");
  assert.equal(queue.snapshot.prefetchAhead, 2);
  assert.equal(requests.length, 2,
    "look-ahead should issue only one synthesis request at a time");
  assert.equal(queue.snapshot.prefetchPendingCount, 2);

  requests[1].task.resolve(new Blob(["B"]));
  await flush();
  assert.equal(requests.length, 3,
    "second look-ahead starts only after the first prefetch resolves");
  requests[2].task.resolve(new Blob(["C"]));
  await flush();
  assert.equal(queue.snapshot.prefetchReadyCount, 2);

  await queue.handleEnded();
  assert.equal(queue.index, 1);
  assert.equal(queue.state, "playing");
  assert.equal(player.plays.length, 2);
  assert.equal(requests.length, 4, "advancing refills the configured window");
}

async function testPrefetchCanBeDisabled() {
  const requests = [];
  const queue = new ReaderQueue({
    player: fakePlayer(),
    async requestAudio({ segment }) {
      requests.push(segment.index);
      return new Blob([segment.text]);
    }
  });
  const segments = ["A", "B"].map((text, index) => ({ index, text }));
  await queue.start(segments, { voice: "march-7th", prefetchAhead: 0 });
  assert.deepEqual(requests, [0]);
  assert.equal(queue.snapshot.prefetchReadyCount, 0);
  await queue.handleEnded();
  assert.deepEqual(requests, [0, 1], "next segment is fetched only when advancing");
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
  assert.equal(queue.snapshot.total, 1, "error state retains the current playback target");
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

async function testPrefetchFailureDoesNotFanOut() {
  const requests = [];
  const player = fakePlayer();
  const queue = new ReaderQueue({
    player,
    retryLimit: 0,
    requestAudio({ segment }) {
      const task = deferred();
      requests.push({ segment, task });
      return task.promise;
    }
  });
  const segments = ["A", "B", "C"].map((text, index) => ({ index, text }));
  const started = queue.start(segments, { voice: "march-7th", prefetchAhead: 2 });
  requests[0].task.resolve(new Blob(["A"]));
  await started;
  assert.equal(requests.length, 2);

  requests[1].task.reject(new Error("prefetch failed"));
  await flush();
  assert.equal(requests.length, 2, "failure of N+1 must not start synthesis for N+2");
  await queue.handleEnded();
  assert.equal(queue.state, "error");
  assert.equal(queue.index, 1);
}

async function testResumeRejectionCanRecover() {
  const player = fakePlayer();
  let blockedOnce = true;
  player.resume = async () => {
    if (blockedOnce) {
      blockedOnce = false;
      const error = new Error("The play() request was blocked by browser policy");
      error.name = "NotAllowedError";
      throw error;
    }
  };
  const queue = new ReaderQueue({
    player,
    async requestAudio() { return new Blob(["audio"]); }
  });
  await queue.start([{ index: 0, text: "A" }], { voice: "offline-local" });
  queue.pause();
  const index = queue.snapshot.index;
  await queue.resume();
  assert.equal(queue.state, "paused", "browser rejection must leave playback resumable");
  assert.equal(queue.snapshot.error?.name, "NotAllowedError",
    "resume rejection must be preserved for user-visible status");
  assert.equal(queue.snapshot.index, index, "resume failure must preserve reading location");
  await queue.resume();
  assert.equal(queue.state, "playing", "a later explicit user retry should succeed");
  assert.equal(queue.snapshot.error, null, "successful resume must clear the old failure");
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

await testConfigurableSequentialPrefetch();
await testPrefetchCanBeDisabled();
await testStaleResponsesCannotWin();
await testRetryOnceThenError();
await testManualRetryAfterError();
await testPrefetchFailureDoesNotFanOut();
await testPauseStopSemantics();
await testResumeRejectionCanRecover();

console.log("PASS: ReaderQueue resilient playback tests");
