const CACHE = "character-voice-reader-shell-v7";
const SHELL = ["/", "/reader-assets/reader.css", "/reader-assets/js/reader.js",
  "/reader-assets/js/sources.js", "/reader-assets/js/epub_source.js",
  "/reader-assets/js/segmenter.js", "/reader-assets/js/player.js",
  "/reader-assets/js/queue.js", "/reader-assets/js/progress.js",
  "/reader-assets/js/navigation.js", "/reader-assets/js/variants.js",
  "/reader-assets/js/offline.js", "/reader-assets/js/api.js"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key !== CACHE).map(key => caches.delete(key)))));
  self.clients.claim();
});
self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  event.respondWith(caches.match(event.request, { ignoreSearch: true })
    .then(cached => cached || fetch(event.request)));
});
