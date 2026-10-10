"""Chromium-backed offline storage lifecycle regressions.

This is intentionally separate from pytest's in-memory IndexedDB substitute.
Run: python tests/test_offline_browser.py
"""

from __future__ import annotations

import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        # Serve the real app entry and asset contract without a CVS backend.
        # Existing storage-only tests continue using /web/js/offline.js.
        path = self.path.split("?", 1)[0]
        if path == "/reader-ui":
            self.path = "/web/index.html"
        elif path.startswith("/reader-assets/"):
            self.path = "/web/" + self.path[len("/reader-assets/"):]
        elif path == "/service-worker.js":
            self.path = "/web/sw.js"
        return super().do_GET()

    def log_message(self, format, *args):
        pass


def prepare(page, origin):
    page.goto(origin + "/", wait_until="domcontentloaded")
    page.evaluate("""async () => {
      const { OfflineLibrary } = await import("/web/js/offline.js");
      window.newLibrary = () => new OfflineLibrary();
      window.audioBlob = text => new Blob([text], { type: "audio/mpeg" });
      window.clip = async (id, text) => {
        const blob = window.audioBlob(text);
        const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
        return {
          segmentId: id,
          bytes: blob.size,
          sha256: [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("")
        };
      };
      window.manifest = (id, clips) => ({
        book: { id, kind: "epub", title: id, segments: [] },
        clips
      });
    }""")


def check_late_result_after_cross_tab_delete(browser, origin):
    context = browser.new_context()
    first, second = context.new_page(), context.new_page()
    try:
        prepare(first, origin)
        prepare(second, origin)
        first.evaluate("""async () => {
          const clips = [await clip("part-1", "first"), await clip("part-2", "second")];
          window.secondRequested = false;
          const delayed = new Promise(resolve => { window.releaseSecond = resolve; });
          window.downloadOutcome = newLibrary().download(
            manifest("browser-delete", clips),
            async id => {
              if (id === "part-1") return audioBlob("first");
              window.secondRequested = true;
              return delayed;  // Simulates a network request ignoring cancellation.
            }
          ).then(() => "completed", error => "error:" + error.name);
        }""")
        first.wait_for_function("window.secondRequested === true")
        assert second.evaluate("""async () => {
          await newLibrary().removeBook("browser-delete");
          return await newLibrary().getBook("browser-delete") === undefined;
        }""")
        outcome = first.evaluate("""async () => {
          window.releaseSecond(audioBlob("second"));
          return await window.downloadOutcome;
        }""")
        assert outcome == "error:AbortError", outcome
        assert second.evaluate("""async () => {
          const library = newLibrary();
          return (await library.getBook("browser-delete")) === undefined
            && (await library.getClip("browser-delete", "part-1")) === undefined
            && (await library.getClip("browser-delete", "part-2")) === undefined
            && !(await library.listBooks()).some(book => book.id === "browser-delete");
        }""")
    finally:
        context.close()


def check_cross_tab_new_download_supersedes_stale_writer(browser, origin):
    context = browser.new_context()
    old, newer = context.new_page(), context.new_page()
    try:
        prepare(old, origin)
        prepare(newer, origin)
        old.evaluate("""async () => {
          window.oldRequested = false;
          const delayed = new Promise(resolve => { window.releaseOld = resolve; });
          const part = await clip("older", "stale-audio");
          window.oldOutcome = newLibrary().download(
            manifest("browser-overlap", [part]),
            async () => {
              window.oldRequested = true;
              return delayed;
            }
          ).then(() => "completed", error => "error:" + error.name);
        }""")
        old.wait_for_function("window.oldRequested === true")
        assert newer.evaluate("""async () => {
          const part = await clip("newer", "fresh-audio");
          const result = await newLibrary().download(
            manifest("browser-overlap", [part]),
            async () => audioBlob("fresh-audio")
          );
          return result.ready === true && result.downloaded === 1;
        }""")
        outcome = old.evaluate("""async () => {
          window.releaseOld(audioBlob("stale-audio"));
          return await window.oldOutcome;
        }""")
        assert outcome == "error:AbortError", outcome
        assert newer.evaluate("""async () => {
          const library = newLibrary();
          const book = await library.getBook("browser-overlap");
          return book.ready === true && book.downloaded === 1
            && (await library.getClip("browser-overlap", "newer"))?.size === 11
            && (await library.getClip("browser-overlap", "older")) === undefined;
        }""")
    finally:
        context.close()


def check_cancel_keeps_verified_partial_audio_for_resume(browser, origin):
    context = browser.new_context()
    page = context.new_page()
    try:
        prepare(page, origin)
        page.evaluate("""async () => {
          const parts = [
            await clip("first", "one"),
            await clip("second", "two")
          ];
          window.partialManifest = manifest("browser-resume", parts);
          window.abortDownload = new AbortController();
          window.waitingOnSecond = false;
          const delayed = new Promise(resolve => { window.releaseCancelled = resolve; });
          window.cancelOutcome = newLibrary().download(
            window.partialManifest,
            async id => {
              if (id === "first") return audioBlob("one");
              window.waitingOnSecond = true;
              return delayed;
            },
            () => {},
            { signal: window.abortDownload.signal }
          ).then(() => "completed", error => "error:" + error.name);
        }""")
        page.wait_for_function("window.waitingOnSecond === true")
        assert page.evaluate("""async () => {
          window.abortDownload.abort();
          window.releaseCancelled(audioBlob("two"));
          const outcome = await window.cancelOutcome;
          const book = await newLibrary().getBook("browser-resume");
          return outcome === "error:AbortError"
            && book.ready === false && book.downloaded === 1;
        }""")
        assert page.evaluate("""async () => {
          const requested = [];
          const result = await newLibrary().download(
            window.partialManifest,
            async id => {
              requested.push(id);
              return audioBlob("two");
            }
          );
          return result.ready && result.downloaded === 2
            && requested.length === 1 && requested[0] === "second";
        }""")
    finally:
        context.close()


def check_delete_reclaims_orphaned_manifest_clips(browser, origin):
    context = browser.new_context()
    page = context.new_page()
    try:
        prepare(page, origin)
        assert page.evaluate("""async () => {
          const book = "b-" + "a".repeat(24);
          const other = "b-" + "a".repeat(23) + "b";
          const library = newLibrary();
          await library.putBook({ id: book, title: "Old",
            manifest: { clips: [{ segmentId: "old" }] } });
          await library.putClip(book, "old", audioBlob("stale"));
          await library.putBook({ id: book, title: "New",
            manifest: { clips: [{ segmentId: "current" }] } });
          await library.putClip(book, "current", audioBlob("latest"));
          await library.putBook({ id: other, title: "Other",
            manifest: { clips: [{ segmentId: "keep" }] } });
          await library.putClip(other, "keep", audioBlob("untouched"));

          async function rawClipKeys() {
            return new Promise((resolve, reject) => {
              const open = indexedDB.open("character-voice-reader-offline", 1);
              open.onerror = () => reject(open.error);
              open.onsuccess = () => {
                const db = open.result;
                const tx = db.transaction("clips", "readonly");
                const request = tx.objectStore("clips").getAllKeys();
                tx.oncomplete = () => { db.close(); resolve(request.result); };
                tx.onerror = () => { db.close(); reject(tx.error); };
              };
            });
          }
          const before = await rawClipKeys();
          await library.removeBook(book);
          const after = await rawClipKeys();
          return before.includes(book + ":old")
            && before.includes(book + ":current")
            && !after.some(key => key.startsWith(book + ":"))
            && after.includes(other + ":keep")
            && (await library.getBook(book)) === undefined
            && (await library.getClip(other, "keep"))?.size === 9;
        }""")
    finally:
        context.close()



def check_offline_shelf_ui_without_service(browser, origin):
    context = browser.new_context(viewport={"width": 390, "height": 780})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        page.goto(origin + "/reader-ui", wait_until="domcontentloaded")
        shelf = page.locator("#offlineLibraryPanel")
        assert shelf.is_visible(), "offline shelf should not depend on the CVS login panel"
        page.get_by_text("暂无本机离线书籍", exact=False).wait_for()
        assert not page.locator("#libraryPanel").evaluate("(el) => el.open")
        assert page.locator(".playback-more").count() == 1
        assert not page.locator(".playback-more").evaluate("(el) => el.open")

        # Insert a realistic offline document with generated segment IDs, but
        # intentionally provide no voice catalog and no CVS HTTP server.
        page.evaluate("""async () => {
          const { OfflineLibrary } = await import("/reader-assets/js/offline.js");
          const { segmentDocument } = await import("/reader-assets/js/segmenter.js");
          const library = new OfflineLibrary();
          const documentModel = {
            title: "离线阅读示例", chapters: [{
              title: "第一章", paragraphs: ["这是一段无需在线语音服务的朗读内容。"]
            }]
          };
          const segments = segmentDocument(documentModel).map((segment, index) => ({
            ...segment, id: "offline-part-" + index
          }));
          const clips = segments.map(segment => ({ segmentId: segment.id }));
          await library.putBook({
            id: "b-" + "c".repeat(24), kind: "epub", title: "离线阅读示例",
            document: documentModel, segments, author: "测试",
            manifest: { clips }, ready: true, downloaded: clips.length
          });
          for (const segment of segments) {
            await library.putClip("b-" + "c".repeat(24),
              segment.id, new Blob(["not-an-audio-file"], { type: "audio/mpeg" }));
          }
        }""")
        page.locator("#refreshOfflineBooks").click()
        row = page.locator(".offline-book-row")
        row.get_by_text("离线阅读示例").wait_for()
        assert page.locator("#voice").evaluate("(el) => !el.value"), "no server voice catalog expected"
        row.get_by_role("button", name="打开阅读").click()
        # IndexedDB book opening is asynchronous: wait for a conclusive UI state.
        page.wait_for_function("""() => !document.querySelector("#start").disabled ||
          document.querySelector("#offlineLibraryStatus").textContent.includes("打开失败")""")
        assert not page.locator("#start").is_disabled(), (
            "offline playback must not require voice catalog; "
            + "shelf=" + page.locator("#offlineLibraryStatus").inner_text()
            + " | playback=" + page.locator("#status").inner_text()
            + " | source=" + page.locator("#source").inner_text()
            + " | errors=" + repr(errors)
        )
        assert "整本书已可离线听读" in page.locator("#status").inner_text()

        # Deletion requires explicit confirmation and allows cancellation.
        row.get_by_role("button", name="删除本机副本").click()
        assert row.get_by_role("button", name="确认删除").is_visible()
        assert row.get_by_role("button", name="保留书籍").is_visible()
        row.get_by_role("button", name="保留书籍").click()
        assert row.get_by_role("button", name="删除本机副本").is_visible()
        assert page.locator(".offline-book-row").count() == 1

        row.get_by_role("button", name="删除本机副本").click()
        row.get_by_role("button", name="确认删除").click()
        page.get_by_text("暂无本机离线书籍", exact=False).wait_for()
        assert not page.locator("#start").is_enabled(), \
            "deleting an open offline book must close the playback source"
        assert not errors, "Reader UI raised browser errors: " + repr(errors)
    finally:
        context.close()



def check_late_book_open_cannot_replace_newer_source(browser, origin):
    context = browser.new_context(viewport={"width": 390, "height": 780})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        page.goto(origin + "/reader-ui", wait_until="domcontentloaded")
        page.get_by_text("暂无本机离线书籍", exact=False).wait_for()

        # First remote book is pending; manual text supersedes the request.
        page.evaluate("""() => {
          const nativeFetch = window.fetch.bind(window);
          const id = "b-" + "d".repeat(24);
          window.remoteStarted = false;
          window.fetch = (input, options) => {
            const url = new URL(String(input), location.href);
            if (url.pathname === "/v1/books") return Promise.resolve(Response.json({
              books: [{ id, title: "远端慢书", kind: "epub" }]
            }));
            if (url.pathname === "/v1/books/" + id) {
              window.remoteStarted = true;
              return new Promise(resolve => {
                window.releaseRemote = () => resolve(Response.json({
                  id, title: "远端慢书", kind: "epub", author: "",
                  document: { title: "远端慢书", chapters: [
                    { title: "第一章", paragraphs: ["不应出现的远端内容。"] }
                  ] },
                  segments: [{ id: "remote-segment" }]
                }));
              });
            }
            return nativeFetch(input, options);
          };
        }""")
        page.locator("#libraryPanel").evaluate("(element) => { element.open = true; }")
        page.locator("#loadLibrary").click()
        page.get_by_role("button", name="远端慢书 · EPUB").wait_for()
        page.get_by_role("button", name="远端慢书 · EPUB").click()
        page.wait_for_function("window.remoteStarted")
        page.locator("#manualPanel").evaluate("(element) => { element.open = true; }")
        page.locator("#text").fill("手动文档最终应被保留。")
        page.locator("#useManual").click()
        page.evaluate("""async () => {
          window.releaseRemote();
          await new Promise(resolve => setTimeout(resolve, 0));
        }""")
        assert "手动输入" in page.locator("#source").inner_text()
        assert "手动文档最终应被保留" in page.locator("#documentBody").inner_text()
        assert "正在读取文件" not in page.locator("#status").inner_text()

        # A slow IndexedDB book A must not replace faster book B.
        page.evaluate("""async () => {
          const { OfflineLibrary } = await import("/reader-assets/js/offline.js");
          const original = OfflineLibrary.prototype.getBook;
          const slow = "b-" + "e".repeat(24);
          const fast = "b-" + "f".repeat(24);
          window.localSlowStarted = false;
          for (const [id, title] of [[slow, "本机慢书A"], [fast, "本机快书B"]]) {
            const document = { title, chapters: [
              { title: "正文", paragraphs: [title + "的正文。"] }
            ] };
            await new OfflineLibrary().putBook({
              id, title, kind: "epub", document,
              segments: [{ id: id + "-clip", index: 0 }],
              ready: false, downloaded: 0, manifest: {
                clips: [{ segmentId: id + "-clip" }]
              }
            });
          }
          OfflineLibrary.prototype.getBook = function(id) {
            if (id !== slow) return original.call(this, id);
            window.localSlowStarted = true;
            return new Promise(resolve => {
              window.releaseLocalSlow = () => original.call(this, id).then(resolve);
            });
          };
        }""")
        page.locator("#refreshOfflineBooks").click()
        page.get_by_text("本机快书B", exact=True).wait_for()
        page.locator(".offline-book-row").filter(has_text="本机慢书A") \
            .get_by_role("button", name="打开阅读").click()
        page.wait_for_function("window.localSlowStarted")
        page.locator(".offline-book-row").filter(has_text="本机快书B") \
            .get_by_role("button", name="打开阅读").click()
        page.wait_for_function("""() => document.querySelector("#source")
          .textContent.includes("本机快书B")""")
        page.evaluate("""async () => {
          window.releaseLocalSlow();
          await new Promise(resolve => setTimeout(resolve, 0));
        }""")
        assert "本机快书B" in page.locator("#source").inner_text()
        assert "本机快书B" in page.locator("#documentBody").inner_text()
        assert not page.locator("#start").is_disabled()

        # An in-progress file read is superseded by manual text. The old
        # finally handler cannot leave a stale loading flag behind.
        page.evaluate("""() => {
          const native = File.prototype.arrayBuffer;
          window.slowFileStarted = false;
          File.prototype.arrayBuffer = function(...args) {
            if (this.name !== "slow-import.txt") return native.apply(this, args);
            window.slowFileStarted = true;
            return new Promise(resolve => {
              window.releaseSlowFile = () => resolve(
                new TextEncoder().encode("旧文件内容").buffer
              );
            });
          };
        }""")
        page.locator("#txtFile").set_input_files({
            "name": "slow-import.txt", "mimeType": "text/plain",
            "buffer": "旧文件内容".encode("utf-8")
        })
        page.wait_for_function("window.slowFileStarted")
        page.locator("#manualPanel").evaluate("(element) => { element.open = true; }")
        page.locator("#text").fill("最后选择的手动文本。")
        page.locator("#useManual").click()
        page.evaluate("""async () => {
          window.releaseSlowFile();
          await new Promise(resolve => setTimeout(resolve, 0));
        }""")
        assert "手动输入" in page.locator("#source").inner_text()
        assert "最后选择的手动文本" in page.locator("#documentBody").inner_text()
        assert not page.locator("#useManual").is_disabled()
        assert "正在读取文件" not in page.locator("#status").inner_text()
        assert not errors, "Unexpected Reader browser exceptions: " + repr(errors)
    finally:
        context.close()



def check_real_offline_audio_playback(browser, origin):
    """Exercise actual HTMLAudioElement decoding, not just the enabled Start button."""
    context = browser.new_context(viewport={"width": 390, "height": 780})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        page.goto(origin + "/reader-ui", wait_until="domcontentloaded")
        page.get_by_text("暂无本机离线书籍", exact=False).wait_for()
        page.evaluate("""async () => {
          const { OfflineLibrary } = await import("/reader-assets/js/offline.js");
          const { segmentDocument } = await import("/reader-assets/js/segmenter.js");
          const library = new OfflineLibrary();
          const bookId = "b-" + "9".repeat(24);
          const model = { title: "浏览器播放实测", chapters: [{
            title: "第一章", paragraphs: ["第一段独立语音。", "第二段独立语音。"]
          }] };
          const segments = segmentDocument(model).map((segment, index) => ({
            ...segment, id: "real-wav-" + index
          }));
          function pcmWave(seconds, frequency) {
            const rate = 16000, frames = Math.floor(seconds * rate);
            const buffer = new ArrayBuffer(44 + frames * 2);
            const view = new DataView(buffer);
            const fourCC = (offset, text) => {
              for (let i = 0; i < text.length; i++) {
                view.setUint8(offset + i, text.charCodeAt(i));
              }
            };
            fourCC(0, "RIFF");
            view.setUint32(4, 36 + frames * 2, true);
            fourCC(8, "WAVE");
            fourCC(12, "fmt ");
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true); // PCM
            view.setUint16(22, 1, true); // mono
            view.setUint32(24, rate, true);
            view.setUint32(28, rate * 2, true);
            view.setUint16(32, 2, true);
            view.setUint16(34, 16, true);
            fourCC(36, "data");
            view.setUint32(40, frames * 2, true);
            for (let i = 0; i < frames; i++) {
              view.setInt16(44 + i * 2,
                Math.floor(3500 * Math.sin(i * 2 * Math.PI * frequency / rate)), true);
            }
            return new Blob([buffer], { type: "audio/wav" });
          }
          await library.putBook({
            id: bookId, title: model.title, kind: "epub",
            document: model, segments, ready: true, downloaded: segments.length,
            manifest: { clips: segments.map(segment => ({ segmentId: segment.id })) }
          });
          for (const [index, segment] of segments.entries()) {
            const wrote = await library.putClip(bookId, segment.id,
              pcmWave(1.2, 330 + 110 * index));
            if (!wrote) throw new Error("Could not write audio fixture");
          }
        }""")
        page.locator("#refreshOfflineBooks").click()
        page.get_by_text("浏览器播放实测", exact=True).wait_for()
        page.locator(".offline-book-row").get_by_role("button", name="打开阅读").click()
        page.wait_for_function("""() => !document.querySelector("#start").disabled
          && document.querySelector("#source").textContent.includes("浏览器播放实测")""")
        assert page.locator("#voice").evaluate("(node) => !node.value"), \
            "real cached audio must work without an online voice catalog"
        page.locator("#start").click()
        page.wait_for_function("""() => {
          const audio = document.querySelector("#audio");
          return audio.currentTime > 0.12 && !audio.paused && audio.duration >= 1.0;
        }""", timeout=7000)
        assert page.locator("#status").inner_text().startswith("正在播放"), \
            "Reader should report actual playback"
        page.locator("#pause").click()
        page.wait_for_function("document.querySelector('#audio').paused")
        paused_time = page.locator("#audio").evaluate("(audio) => audio.currentTime")
        page.wait_for_timeout(150)
        held_time = page.locator("#audio").evaluate("(audio) => audio.currentTime")
        assert abs(held_time - paused_time) < 0.12, \
            "Pause must preserve real media position"
        page.evaluate("""() => {
          const original = HTMLMediaElement.prototype.play;
          let rejectOnce = true;
          HTMLMediaElement.prototype.play = function(...args) {
            if (rejectOnce) {
              rejectOnce = false;
              return Promise.reject(new DOMException(
                "Playback requires a user gesture", "NotAllowedError"));
            }
            return original.apply(this, args);
          };
        }""")
        page.locator("#start").click()  # Browser rejects the first resume
        page.wait_for_function("""() => document.querySelector("#status")
          .textContent.includes("继续播放失败")""")
        assert "NotAllowedError" not in page.locator("#status").inner_text(), (
            "The UI should present the media error message, not a raw exception name"
        )
        assert page.locator("#audio").evaluate("(el) => el.paused"), (
            "Denied resume must not advance playback or discard its position"
        )
        assert not page.locator("#start").is_disabled(), (
            "Resume must remain available after a transient autoplay rejection"
        )
        page.locator("#start").click()  # Explicit second try succeeds
        page.wait_for_function("""() => {
          const audio = document.querySelector("#audio");
          return !audio.paused && audio.currentTime > 0;
        }""")
        page.wait_for_function("""() => {
          const status = document.querySelector("#status").textContent;
          return status.startsWith("正在播放") && !status.includes("继续播放失败");
        }""", timeout=5000)
        assert "继续播放失败" not in page.locator("#status").inner_text()
        page.wait_for_function("""() =>
          document.querySelector("#status").textContent.includes("朗读完成")""",
          timeout=9000)
        assert page.locator("#readingProgress").evaluate(
            "(el) => Number(el.value) === 2 && Number(el.max) === 2"
        ), "Both real audio clips should advance the reading progress"
        assert page.locator("#audio").evaluate(
            "(el) => !el.getAttribute('src')"
        ), "Completion must release the media element source"

        # A new playback followed by Stop must revoke the active object URL.
        page.locator("#start").click()
        page.wait_for_function("""() => document.querySelector("#audio").currentTime > 0.08
          && !document.querySelector("#audio").paused""", timeout=7000)
        page.locator("#stop").click()
        assert page.locator("#audio").evaluate(
            "(el) => el.paused && !el.getAttribute('src')"
        ), "Stop must pause and remove the object URL source"
        assert page.evaluate("""async () => {
          const { AudioPlayer } = await import("/reader-assets/js/player.js");
          const testAudio = document.createElement("audio");
          let errorMessage = "";
          const player = new AudioPlayer(testAudio, {
            onError: error => { errorMessage = error.message; }
          });
          player.objectUrl = "blob:simulated-decode-error";
          testAudio.dispatchEvent(new Event("error"));
          return errorMessage.includes("音频格式")
            && !errorMessage.includes("WAV 音频");
        }"""), "Decode diagnostics must not mislabel all formats as WAV"
        assert not errors, "Real audio playback raised JS errors: " + repr(errors)
    finally:
        context.close()



def check_mobile_touch_reader_controls(browser, origin):
    """Small touch viewport preserves readable layout and secondary-action disclosure."""
    context = browser.new_context(
        viewport={"width": 360, "height": 780},
        device_scale_factor=2,
        is_mobile=True,
        has_touch=True
    )
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        page.goto(origin + "/reader-ui", wait_until="domcontentloaded")
        page.locator("#manualPanel > summary").tap()
        page.locator("#text").fill("这是移动端触屏阅读测试的正文。")
        page.locator("#useManual").tap()
        page.wait_for_function("""() => document.querySelector("#source")
          .textContent.includes("手动输入")""")
        assert "移动端触屏阅读测试" in page.locator("#documentBody").inner_text()
        metrics = page.evaluate("""() => ({
          viewport: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth,
          bar: document.querySelector(".playback-bar").getBoundingClientRect().width
        })""")
        assert metrics["scroll"] <= metrics["viewport"] + 1, \
            "Reader must not create horizontal page scroll on mobile: " + repr(metrics)
        assert page.locator(".playback-more > summary").is_visible()
        page.locator(".playback-more > summary").tap()
        assert page.locator("#previousChapter").is_visible()
        assert page.locator("#previewSelection").is_visible()
        page.locator(".playback-more > summary").tap()
        assert not page.locator(".playback-more").evaluate("(node) => node.open")
        assert not errors, "Touch UI raised JS errors: " + repr(errors)
    finally:
        context.close()



def check_offline_shelf_search_filter_sort_and_refresh(browser, origin):
    """Search is client-side, partial downloads are discoverable, and refresh does not flash."""
    context = browser.new_context(viewport={"width": 360, "height": 780})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        page.goto(origin + "/reader-ui", wait_until="domcontentloaded")
        page.get_by_text("暂无本机离线书籍", exact=False).wait_for()
        page.evaluate("""async () => {
          const { OfflineLibrary } = await import("/reader-assets/js/offline.js");
          const library = new OfflineLibrary();
          const rows = [
            ["a", "Alpha", "Ada", false, 1, 2],
            ["b", "Beta", "张乙", true, 1, 1],
            ["c", "Gamma", "林甲", true, 2, 2]
          ];
          for (const [suffix, title, author, ready, downloaded, count] of rows) {
            const id = "b-" + suffix.repeat(24);
            const document = { title, chapters: [
              { title: "正文", paragraphs: ["这是 " + title + " 的段落。"] }
            ] };
            await library.putBook({
              id, title, author, kind: "epub", document,
              segments: [{ id: suffix + "-segment", index: 0 }],
              manifest: { clips: Array.from({ length: count }, (_, i) =>
                ({ segmentId: suffix + "-" + i })) },
              ready, downloaded
            });
          }
        }""")
        page.locator("#refreshOfflineBooks").click()
        page.wait_for_function("""() =>
          document.querySelectorAll(".offline-book-row").length === 3""")
        rows = page.locator(".offline-book-row")
        assert rows.count() == 3
        assert [rows.nth(i).locator("strong").inner_text() for i in range(3)] == [
            "Alpha", "Beta", "Gamma"
        ], "Title sort must be deterministic"
        assert "3/3" in page.locator("#offlineLibraryStatus").inner_text()

        # Search matches author, not only title. Status filter intersects query.
        page.locator("#offlineSearch").fill("Ada")
        assert rows.count() == 1
        assert rows.first.locator("strong").inner_text() == "Alpha"
        assert "1/3" in page.locator("#offlineLibraryStatus").inner_text()
        page.locator("#offlineFilter").select_option("ready")
        page.get_by_text("没有符合搜索或筛选条件", exact=False).wait_for()
        assert rows.count() == 0
        assert "0/3" in page.locator("#offlineLibraryStatus").inner_text()
        assert not page.locator("#offlineClearFilters").is_disabled()
        page.locator("#offlineClearFilters").click()
        assert page.locator("#offlineSearch").input_value() == ""
        assert page.locator("#offlineFilter").input_value() == "all"
        assert rows.count() == 3
        assert page.locator("#offlineClearFilters").is_disabled()
        page.locator("#offlineSearch").fill("Ada")
        page.locator("#offlineFilter").select_option("partial")
        assert rows.count() == 1
        assert rows.first.locator("strong").inner_text() == "Alpha"
        page.locator("#offlineSearch").fill("林甲")
        assert rows.count() == 0
        page.locator("#offlineFilter").select_option("all")
        assert rows.count() == 1
        assert rows.first.locator("strong").inner_text() == "Gamma"

        page.locator("#offlineSearch").fill("")
        page.locator("#offlineSort").select_option("progress")
        assert [rows.nth(i).locator("strong").inner_text() for i in range(3)] == [
            "Beta", "Gamma", "Alpha"
        ], "Completed books first; tie-break by title"

        # Delaying IndexedDB listing must not remove cards or reset user input.
        page.evaluate("""async () => {
          const { OfflineLibrary } = await import("/reader-assets/js/offline.js");
          const original = OfflineLibrary.prototype.listBooks;
          window.shelfRefreshPending = false;
          window.restoreShelfListing = () => {
            OfflineLibrary.prototype.listBooks = original;
          };
          OfflineLibrary.prototype.listBooks = function(...args) {
            window.shelfRefreshPending = true;
            return new Promise(resolve => {
              window.releaseShelfRefresh = () => original.apply(this, args).then(resolve);
            });
          };
        }""")
        page.locator("#refreshOfflineBooks").click()
        page.wait_for_function("window.shelfRefreshPending")
        assert rows.count() == 3, "Refreshing must not blank the previous shelf"
        page.locator("#offlineSearch").fill("张乙")
        assert rows.count() == 1
        assert rows.first.locator("strong").inner_text() == "Beta"
        page.evaluate("""async () => {
          window.restoreShelfListing();
          await window.releaseShelfRefresh();
        }""")
        page.wait_for_function("""() =>
          !document.querySelector("#refreshOfflineBooks").disabled""")
        assert page.locator("#offlineSearch").input_value() == "张乙"
        assert rows.count() == 1

        # Filtering and deletion should continue to respect the selected scope.
        page.locator("#offlineSearch").fill("Ada")
        page.locator("#offlineFilter").select_option("partial")
        assert rows.count() == 1
        rows.first.get_by_role("button", name="删除本机副本").click()
        rows.first.get_by_role("button", name="确认删除").press("Escape")
        assert rows.count() == 1, "Escape must cancel deletion without deleting the book"
        assert rows.first.get_by_role("button", name="删除本机副本").is_visible()
        rows.first.get_by_role("button", name="删除本机副本").click()
        rows.first.get_by_role("button", name="确认删除").click()
        page.get_by_text("没有符合搜索或筛选条件", exact=False).wait_for()
        page.locator("#offlineSearch").fill("")
        page.locator("#offlineFilter").select_option("all")
        assert rows.count() == 2
        assert "2/2" in page.locator("#offlineLibraryStatus").inner_text()
        assert not errors, "Offline shelf interaction raised errors: " + repr(errors)
    finally:
        context.close()



def check_quota_estimate_is_advisory_and_recovery_is_actionable(browser, origin):
    """Estimated free bytes are not newly required bytes in a resumable download."""
    context = browser.new_context(viewport={"width": 390, "height": 780})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        page.goto(origin + "/reader-ui", wait_until="domcontentloaded")
        page.get_by_text("暂无本机离线书籍", exact=False).wait_for()
        page.evaluate("""async () => {
          const { OfflineLibrary } = await import("/reader-assets/js/offline.js");
          const { segmentDocument } = await import("/reader-assets/js/segmenter.js");
          const bookId = "b-" + "8".repeat(24);
          const model = { title: "空间恢复测试", chapters: [{
            title: "章节", paragraphs: ["已缓存的声音。", "等待下载的声音。"]
          }] };
          const segments = segmentDocument(model).map((part, index) => ({
            ...part, id: "quota-part-" + index
          }));
          const blobs = segments.map((_, i) =>
            new Blob(["clip-" + i], { type: "audio/mpeg" }));
          const clips = await Promise.all(blobs.map(async (blob, i) => {
            const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
            return {
              segmentId: segments[i].id, bytes: blob.size,
              sha256: [...new Uint8Array(hash)].map(n =>
                n.toString(16).padStart(2, "0")).join("")
            };
          }));
          const book = {
            id: bookId, title: model.title, kind: "epub", author: "测试",
            document: model, segments
          };
          window.quotaFixture = {
            book, manifest: { book, clips, totalBytes: 20 * 1024 * 1024 },
            blobs, fetched: [], persistAttempts: 0
          };
          const library = new OfflineLibrary();
          await library.putBook({
            ...book, manifest: window.quotaFixture.manifest,
            ready: false, downloaded: 1
          });
          await library.putClip(bookId, segments[0].id, blobs[0]);

          Object.defineProperty(navigator, "storage", {
            configurable: true,
            value: {
              estimate: async () => ({ quota: 100, usage: 95 }),
              persist: async () => {
                window.quotaFixture.persistAttempts++;
                throw new DOMException("Not permitted", "NotAllowedError");
              }
            }
          });

          const nativeFetch = window.fetch.bind(window);
          window.fetch = (input, options) => {
            const path = new URL(String(input), location.href).pathname;
            if (path === "/v1/books") {
              return Promise.resolve(Response.json({
                books: [{ id: bookId, title: book.title, kind: "epub" }]
              }));
            }
            if (path === "/v1/books/" + bookId) {
              return Promise.resolve(Response.json(book));
            }
            if (path === "/v1/books/" + bookId + "/versions") {
              return Promise.resolve(Response.json({}));
            }
            if (path === "/v1/books/" + bookId + "/progress") {
              return Promise.resolve(Response.json({}));
            }
            if (path === "/v1/books/" + bookId + "/job") {
              return Promise.resolve(Response.json({ status: "idle", completed: 0, total: 2 }));
            }
            if (path === "/v1/books/" + bookId + "/generation-history") {
              return Promise.resolve(Response.json({ items: [] }));
            }
            if (path === "/v1/books/" + bookId + "/offline-manifest") {
              return Promise.resolve(Response.json(window.quotaFixture.manifest));
            }
            if (path.startsWith("/v1/books/" + bookId + "/offline-audio/")) {
              const segment = decodeURIComponent(path.split("/").at(-1));
              const index = segments.findIndex(part => part.id === segment);
              if (index < 0) return Promise.resolve(new Response("", { status: 404 }));
              window.quotaFixture.fetched.push(segment);
              return Promise.resolve(new Response(blobs[index], {
                headers: { "Content-Type": "audio/mpeg" }
              }));
            }
            return nativeFetch(input, options);
          };
        }""")
        page.locator("#offlineStorageDetails > summary").click()
        page.locator("#refreshOfflineStorage").click()
        page.get_by_text("估算可用 0.0 MiB", exact=False).wait_for()
        assert "浏览器估算" in page.locator("#offlineStorageUsage").inner_text()
        assert page.locator("#offlineStorageRecovery").is_hidden()

        page.locator("#libraryPanel").evaluate("(node) => { node.open = true; }")
        page.locator("#loadLibrary").click()
        page.get_by_role("button", name="空间恢复测试 · EPUB").wait_for()
        page.get_by_role("button", name="空间恢复测试 · EPUB").click()
        page.wait_for_function("""() => document.querySelector("#source")
          .textContent.includes("空间恢复测试")""")
        page.locator("#downloadBook").click()
        page.wait_for_function("""() => document.querySelector("#jobStatus")
          .textContent.includes("整本书已下载并校验")""", timeout=12000)
        assert page.evaluate("""async () => {
          const { OfflineLibrary } = await import("/reader-assets/js/offline.js");
          const library = new OfflineLibrary();
          const book = await library.getBook(window.quotaFixture.book.id);
          const second = await library.getClip(book.id, "quota-part-1");
          return book?.ready === true && book.downloaded === 2 && second?.size === 6
            && window.quotaFixture.fetched.join(",") === "quota-part-1"
            && window.quotaFixture.persistAttempts > 0;
        }"""), "Valid cached clip must be reusable even when the quota estimate is lower than manifest.totalBytes"

        # Storage persistence/estimate APIs are best effort; their exceptions
        # must not abort verified cached re-downloads.
        page.evaluate("""() => {
          navigator.storage.estimate = async () => {
            throw new DOMException("Storage estimate denied", "NotAllowedError");
          };
        }""")
        page.locator("#refreshOfflineStorage").click()
        page.get_by_text("此浏览器暂不提供可用的存储估算", exact=False).wait_for()

        # A genuine QuotaExceededError coming from the offline adapter must
        # yield an actionable recovery UI. Do not silently delete any book.
        page.evaluate("""async () => {
          const { OfflineLibrary } = await import("/reader-assets/js/offline.js");
          const original = OfflineLibrary.prototype.download;
          window.quotaFixture.rejectNext = true;
          OfflineLibrary.prototype.download = function(...args) {
            if (window.quotaFixture.rejectNext) {
              window.quotaFixture.rejectNext = false;
              return Promise.reject(new DOMException(
                "Failed to store a new clip", "QuotaExceededError"
              ));
            }
            return original.apply(this, args);
          };
        }""")
        page.locator("#downloadBook").click()
        page.wait_for_function("""() => document.querySelector("#jobStatus")
          .textContent.includes("浏览器存储配额不足")""", timeout=9000)
        assert page.locator("#offlineStorageRecovery").is_visible()
        assert page.locator("#offlineStorageDetails").evaluate("(node) => node.open")
        assert page.locator("#offlineStorageRecovery a").get_attribute("href") == \
            "#offlineLibraryPanel"
        assert not page.locator("#downloadBook").is_disabled(), \
            "Quota failures should leave explicit manual retry available"
        assert page.evaluate("""async () => {
          const { OfflineLibrary } = await import("/reader-assets/js/offline.js");
          return (await new OfflineLibrary().getBook(window.quotaFixture.book.id))?.ready;
        }"""), "A quota diagnostic must not delete saved data"

        page.locator("#downloadBook").click()
        page.wait_for_function("""() => document.querySelector("#jobStatus")
          .textContent.includes("整本书已下载并校验")""", timeout=10000)
        assert page.locator("#offlineStorageRecovery").is_hidden(), \
            "Successful retry should dismiss stale storage warning"
        assert not errors, "Unexpected quota UI browser exceptions: " + repr(errors)
    finally:
        context.close()



def check_clip_first_legacy_migration_is_tombstone_safe(browser, origin):
    """A legacy clip is readable even if the legacy book has never been listed."""
    context = browser.new_context()
    first, second = context.new_page(), context.new_page()
    try:
        prepare(first, origin)
        prepare(second, origin)
        first.evaluate("""async () => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open("cvs-offline-library", 1);
            request.onupgradeneeded = () => {
              request.result.createObjectStore("books");
              request.result.createObjectStore("clips");
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const book = "b-" + "e".repeat(24);
          const other = "b-" + "f".repeat(24);
          await new Promise((resolve, reject) => {
            const tx = db.transaction(["books", "clips"], "readwrite");
            tx.objectStore("books").put({
              id: book, title: "Legacy clip first",
              manifest: { clips: [{ segmentId: "part-1" }] }
            }, book);
            tx.objectStore("books").put({
              id: other, title: "Delete before clip read",
              manifest: { clips: [{ segmentId: "part-1" }] }
            }, other);
            tx.objectStore("clips").put(audioBlob("historic"), book + ":part-1");
            tx.objectStore("clips").put(audioBlob("deleted"), other + ":part-1");
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
          });
          db.close();
        }""")
        assert second.evaluate("""async () => {
          const id = "b-" + "e".repeat(24);
          const library = newLibrary();
          const blob = await library.getClip(id, "part-1");
          const owner = await library.getBook(id);
          const database = await new Promise((resolve, reject) => {
            const request = indexedDB.open("character-voice-reader-offline", 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const current = await new Promise((resolve, reject) => {
            const tx = database.transaction(["books", "clips"], "readonly");
            const book = tx.objectStore("books").get(id);
            const clip = tx.objectStore("clips").get(id + ":part-1");
            let found = false;
            clip.onsuccess = () => { found = clip.result?.size === 8; };
            tx.oncomplete = () => resolve(found && book.result?.id === id);
            tx.onerror = () => reject(tx.error);
          });
          database.close();
          return blob?.size === 8 && owner?.title === "Legacy clip first" && current;
        }"""), "clip-first access must lazily restore both the book and clip"

        # Deleting a still-unlisted legacy owner in another tab must block
        # all future lazy reads; neither the clip nor its owner can reappear.
        first.evaluate("""async () => {
          await newLibrary().removeBook("b-" + "f".repeat(24));
        }""")
        assert second.evaluate("""async () => {
          const id = "b-" + "f".repeat(24);
          const library = newLibrary();
          return (await library.getClip(id, "part-1")) === undefined
            && (await library.getBook(id)) === undefined
            && !(await library.listBooks()).some(book => book.id === id);
        }"""), "clip-first migration must not bypass cross-tab deletion tombstones"

        # The legacy rollback database was not modified by the migration.
        assert first.evaluate("""async () => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open("cvs-offline-library", 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const count = await new Promise((resolve, reject) => {
            const tx = db.transaction("clips", "readonly");
            const request = tx.objectStore("clips").count();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          db.close();
          return count === 2;
        }""")
    finally:
        context.close()


def main():
    # Keep the optional Playwright dependency out of the default pytest collection.
    from playwright.sync_api import sync_playwright

    server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    origin = "http://127.0.0.1:" + str(server.server_port)
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                check_late_result_after_cross_tab_delete(browser, origin)
                check_cross_tab_new_download_supersedes_stale_writer(browser, origin)
                check_cancel_keeps_verified_partial_audio_for_resume(browser, origin)
                check_delete_reclaims_orphaned_manifest_clips(browser, origin)
                check_clip_first_legacy_migration_is_tombstone_safe(browser, origin)
                check_offline_shelf_ui_without_service(browser, origin)
                check_late_book_open_cannot_replace_newer_source(browser, origin)
                check_real_offline_audio_playback(browser, origin)
                check_mobile_touch_reader_controls(browser, origin)
                check_offline_shelf_search_filter_sort_and_refresh(browser, origin)
                check_quota_estimate_is_advisory_and_recovery_is_actionable(browser, origin)
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("PASS: real Chromium IndexedDB offline lifecycle regressions")


if __name__ == "__main__":
    main()
