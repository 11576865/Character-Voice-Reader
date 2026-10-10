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
        assert not page.locator("#start").is_disabled(), \
            "cached offline playback must not require an online voice catalog"
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
                check_offline_shelf_ui_without_service(browser, origin)
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("PASS: real Chromium IndexedDB offline lifecycle regressions")


if __name__ == "__main__":
    main()
