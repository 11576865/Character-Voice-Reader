"""Real Firefox Reader offline regressions; shared scenarios with Chromium.

Run after installing Playwright's Firefox engine:
    python tests/test_offline_firefox.py

This intentionally excludes Chromium-specific BFCache launch configuration.
Unlike synthetic IndexedDB tests, the suite uses Firefox's actual storage,
media-element decoding, and cross-tab event delivery.
"""
from __future__ import annotations

import threading

from test_offline_browser import QuietHandler, ThreadingHTTPServer
from test_offline_browser import (
    check_late_result_after_cross_tab_delete,
    check_cross_tab_new_download_supersedes_stale_writer,
    check_cancel_keeps_verified_partial_audio_for_resume,
    check_delete_reclaims_orphaned_manifest_clips,
    check_clip_first_legacy_migration_is_tombstone_safe,
    check_current_clip_owner_atomic_read_cross_tab,
    check_offline_shelf_ui_without_service,
    check_late_book_open_cannot_replace_newer_source,
    check_real_offline_audio_playback,
    check_cross_tab_deletion_stops_active_audio_and_pending_book_open,
    check_cross_tab_deletion_storage_event_fallback,
    check_pending_offline_open_is_revalidated_after_pagehide,
    check_offline_shelf_search_filter_sort_and_refresh,
    check_quota_estimate_is_advisory_and_recovery_is_actionable,
)


def main():
    from playwright.sync_api import sync_playwright

    server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    origin = f"http://127.0.0.1:{server.server_port}"
    try:
        with sync_playwright() as playwright:
            browser = playwright.firefox.launch(headless=True)
            try:
                # Reuse the very same assertions that gate Chromium.
                check_late_result_after_cross_tab_delete(browser, origin)
                check_cross_tab_new_download_supersedes_stale_writer(browser, origin)
                check_cancel_keeps_verified_partial_audio_for_resume(browser, origin)
                check_delete_reclaims_orphaned_manifest_clips(browser, origin)
                check_clip_first_legacy_migration_is_tombstone_safe(browser, origin)
                check_current_clip_owner_atomic_read_cross_tab(browser, origin)
                check_offline_shelf_ui_without_service(browser, origin)
                check_late_book_open_cannot_replace_newer_source(browser, origin)
                check_real_offline_audio_playback(browser, origin)
                check_cross_tab_deletion_stops_active_audio_and_pending_book_open(browser, origin)
                check_cross_tab_deletion_storage_event_fallback(browser, origin)
                check_pending_offline_open_is_revalidated_after_pagehide(browser, origin)
                check_offline_shelf_search_filter_sort_and_refresh(browser, origin)
                check_quota_estimate_is_advisory_and_recovery_is_actionable(browser, origin)
            finally:
                browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("PASS: Firefox real IndexedDB, offline playback and cross-tab Reader regressions")


if __name__ == "__main__":
    main()
