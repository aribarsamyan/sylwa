/* SYLWA service worker
   - App shell: network-first for HTML (updates arrive right away), cache fallback offline.
   - Other own files (icons, manifest, config): same network-first rule.
   - Firebase SDK files (fixed version on gstatic): cached so the app opens offline.
   - Firestore / Auth / Google Fonts requests: never touched.
   - Push notifications: see the section at the bottom.
   Bump VERSION whenever this file or the shell list changes. */

const VERSION = "sylwa-v2";
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
const SDK = ["firebase-app.js", "firebase-auth.js", "firebase-firestore.js", "firebase-messaging.js"].map(f => SDK_PREFIX + f);

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

/* ---------- push notifications ----------
   Sent by notifier/ (GitHub Actions) through FCM as data-only messages:
   data = { title, body, tag, url }. Every push shows a notification (iOS requires it). */
self.addEventListener("push", event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch (e) { payload = { data: { body: event.data ? event.data.text() : "" } }; }
  const d = payload.data || {}, n = payload.notification || {};
  const title = d.title || n.title || "SYLWA";
  const options = {
    body: d.body || n.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    data: { url: d.url || self.registration.scope }
  };
  if (d.tag) { options.tag = d.tag; options.renotify = true; }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const scope = self.registration.scope;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = wins.find(w => w.url.startsWith(scope));
    if (open) return open.focus();
    return self.clients.openWindow(scope);
  })());
});
