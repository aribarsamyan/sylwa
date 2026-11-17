/* SYLWA service worker
   - App shell: network-first for HTML (updates arrive right away), cache fallback offline.
   - Other own files (icons, manifest, config): same network-first rule.
   - Firebase SDK files (fixed version on gstatic): cached so the app opens offline.
   - Firestore / Auth / Google Fonts requests: never touched.
   Bump VERSION when the shell list changes. Push notifications (part 2) get their own section below. */

const VERSION = "sylwa-v1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./firebase-config.js",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];
const SDK_PREFIX = "https://www.gstatic.com/firebasejs/10.12.2/";
const SDK = ["firebase-app.js", "firebase-auth.js", "firebase-firestore.js"].map(f => SDK_PREFIX + f);

/* ---------- lifecycle ---------- */
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    await Promise.all(SDK.map(u => cache.add(new Request(u, { mode: "cors" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* ---------- fetch ---------- */
self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (url.href.startsWith(SDK_PREFIX)) { event.respondWith(cacheFirst(req)); return; }
  if (url.origin !== self.location.origin) return;           // Firebase, Fonts, everything else: hands off
  if (!url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;

  const isPage = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
  event.respondWith(networkFirst(req, isPage));
});

/* Own files: try the network first so updates land immediately; fall back to cache offline. */
async function networkFirst(req, isPage) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req, { cache: "no-cache" });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (isPage) return (await cache.match("./index.html")) || (await cache.match("./")) || Response.error();
    return Response.error();
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

/* ---------- push notifications (part 2) ---------- */
// self.addEventListener("push", ...);
// self.addEventListener("notificationclick", ...);
