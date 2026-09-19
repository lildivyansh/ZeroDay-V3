const CACHE_NAME = "zeroday-v4";

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./manifest.json"
];

// Cached individually so a missing optional file can't break installation
const OPTIONAL_ASSETS = ["./icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(CORE_ASSETS);
      await Promise.all(OPTIONAL_ASSETS.map((url) => cache.add(url).catch(() => {})));
    })
  );
  self.skipWaiting();
});

// Remove caches from older versions
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate: open instantly from cache, refresh in the background
// so updates pushed to GitHub Pages reach the phone on the next launch.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req, { ignoreSearch: true });

      const network = fetch(req, { cache: "no-cache" })
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);

      if (cached) {
        event.waitUntil(network);
        return cached;
      }

      const res = await network;
      if (res) return res;

      if (req.mode === "navigate") {
        const fallback = await cache.match("./index.html");
        if (fallback) return fallback;
      }
      return Response.error();
    })()
  );
});

// Tapping a reminder brings ZeroDay to the front (or opens it)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow("./");
    })()
  );
});
