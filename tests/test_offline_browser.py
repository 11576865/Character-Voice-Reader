"""Chromium-backed offline storage lifecycle regressions.

This is intentionally separate from pytest's in-memory IndexedDB substitute.
Run: python tests/test_offline_browser.py
"""

from __future__ import annotations

import functools
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

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


def test_late_result_after_cross_tab_delete(browser, origin):
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


def test_cross_tab_new_download_supersedes_stale_writer(browser, origin):
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


def test_cancel_keeps_verified_partial_audio_for_resume(browser, origin):
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


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    origin = "http://127.0.0.1:" + str(server.server_port)
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                test_late_result_after_cross_tab_delete(browser, origin)
                test_cross_tab_new_download_supersedes_stale_writer(browser, origin)
                test_cancel_keeps_verified_partial_audio_for_resume(browser, origin)
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("PASS: real Chromium IndexedDB offline lifecycle regressions")


if __name__ == "__main__":
    main()
