"use strict";
/* SYLWA notifier — runs on GitHub Actions every 15 minutes.
   Reads users/{uid}/(plan, progress, settings, push tokens) with the Admin SDK and sends
   due reminders through FCM. Never logs tokens, names or message texts (Actions logs are public). */

const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

const TZ = "America/New_York";
const APP_URL = "https://aribarsamyan.github.io/sylwa/";
const STALE_MS = 45 * 60e3;          // skip reminders that are this late (GitHub delays)
const SUMMARY_MAX_MS = 6 * 3600e3;   // the evening summary may be late, but not past this
const KEEP_DAYS = 3;                 // how long "already sent" marks are kept
const WATER_N = 6, JOKERS = 2, BEAT_GOAL = 3, SEND_GOAL = 5, FOLLOW_DAYS = 10, DAY_GOAL = 0.8;
const WATER_TIMES = {
  weekday: ["08:00", "10:30", "13:00", "15:30", "18:00", "20:30"],   // Pzt–Per
  weekend: ["10:00", "12:00", "14:00", "16:00", "18:00", "20:30"]    // Cum–Paz
};
const BLOCK_CATS = ["muzik", "spor", "ingilizce"];
const DEFAULTS = { water: true, supplement: true, blocks: true, summary: true, summaryTime: "20:12", quietStart: "23:30", quietEnd: "08:00" };
const BAD_TOKEN = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token"]);

/* ---------- time (America/New_York) ---------- */
const fmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
function parts(ms) { const o = {}; for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value; return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second }; }
const pad = n => String(n).padStart(2, "0");
const iso = (y, m, d) => y + "-" + pad(m) + "-" + pad(d);
function localDate(ms) { const p = parts(ms); return iso(p.y, p.m, p.d); }
const toMin = hm => { const [h, m] = String(hm).split(":").map(Number); return h * 60 + m; };
const validHM = v => typeof v === "string" && /^\d{2}:\d{2}$/.test(v);
function addDays(date, n) { const [y, m, d] = date.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); }
function dayIndex(date) { const [y, m, d] = date.split("-").map(Number); return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; } // 0 = Pazartesi
function daysBetween(a, b) { const u = s => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); }; return Math.round((u(b) - u(a)) / 864e5); }
/* New York wall-clock (date + "HH:MM") -> UTC milliseconds, DST-safe */
function zoned(date, hm) {
  const [y, m, d] = date.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, toMin(hm));
  const off = t => { const p = parts(t); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - t; };
  const t1 = guess - off(guess);
  return guess - off(t1);
}
function inQuiet(min, start, end) {
  const s = toMin(start), e = toMin(end);
  if (s === e) return false;
  return s < e ? (min >= s && min < e) : (min >= s || min < e);
}
const liters = w => String((w || 0) / 2);

/* ---------- what is scheduled on a given day ---------- */
function itemsFor(items, di) { return items.filter(it => it && (it.d === di || it.d === -1) && validHM(it.s)).sort((a, b) => a.s.localeCompare(b.s)); }

function eventsFor(date, items, cfg) {
  const di = dayIndex(date), its = itemsFor(items, di), ev = [];
  if (cfg.water) (di <= 3 ? WATER_TIMES.weekday : WATER_TIMES.weekend).forEach((time, k) => {
    const n = k + 1;
    ev.push({ key: "water-" + n, time, tag: "water", build: p => (p.water || 0) >= n ? null :
      { title: "SYLWA", body: `💧 ${n}. bardak zamanı · şu an ${liters(p.water)}/3 L` } });
  });
  if (cfg.supplement) its.filter(it => it.c === "takviye").forEach(it => {
    ev.push({ key: "supp-" + it.id, time: it.s, tag: "supp", build: p => p.done && p.done[it.id] ? null :
      { title: "SYLWA", body: `💊 ${it.t}` + (/yağlı/i.test(it.n || "") ? " · yanında biraz yağlı bir şey" : "") } });
  });
  if (cfg.blocks) its.filter(it => BLOCK_CATS.includes(it.c)).forEach(it => {
    ev.push({ key: "blk-" + it.id, time: it.s, tag: "blk", build: p => p.done && p.done[it.id] ? null :
      { title: "SYLWA", body: `▶ ${it.s} · ${it.t}` } });
  });
  if (cfg.summary && validHM(cfg.summaryTime)) ev.push({ key: "summary", time: cfg.summaryTime, tag: "summary", summary: true });
  return ev;
}

async function buildSummary(base, date, items, p) {
  const di = dayIndex(date), its = itemsFor(items, di), done = id => !!(p.done && p.done[id]);
  const [statsSnap, beatsSnap, sendsSnap] = await Promise.all([
    base.collection("stats").doc("me").get(), base.collection("beats").get(), base.collection("sends").get()
  ]);
  const stats = statsSnap.data() || {}, w = p.water || 0;
  const pct = p.joker ? 1 : (its.filter(it => done(it.id)).length + w / WATER_N) / (its.length + 1);
  const supp = its.filter(it => it.c === "takviye");
  const suppTxt = supp.length ? (supp.every(it => done(it.id)) ? "takviye ✓" : "takviye bekliyor") : "";

  const l1 = [p.joker ? "Bugün ★ joker günü" : `Bugün %${Math.round(Math.min(1, pct) * 100)}`, `su ${liters(w)}/3 L`, suppTxt].filter(Boolean).join(" · ");

  const l2 = [];
  if (!p.joker) {
    const todo = its.filter(it => BLOCK_CATS.includes(it.c) && !done(it.id)).slice(0, 2).map(it => it.t);
    if (todo.length) l2.push("Kalan: " + todo.join(", "));
    if (pct < DAY_GOAL) {
      const j = stats.joker || {}, left = j.month === date.slice(0, 7) ? Math.max(0, JOKERS - (j.used || 0)) : JOKERS;
      l2.push(left > 0 ? `seri için %80 lazım · ${left} joker hakkın var` : "seri için %80 lazım");
    }
  }

  const monday = addDays(date, -di), week = [...Array(7)].map((_, k) => addDays(monday, k));
  const beats = beatsSnap.docs.map(d => d.data()), sends = sendsSnap.docs.map(d => d.data());
  const follow = sends.filter(s => s.status === "bekliyor" && (s.last || s.date) && daysBetween(s.last || s.date, date) >= FOLLOW_DAYS).slice(0, 2).map(s => s.to).filter(Boolean);
  const l3 = [follow.length ? "Tekrar yaz: " + follow.join(", ") : "",
    `beat ${beats.filter(b => week.includes(b.date)).length}/${BEAT_GOAL}`,
    `gönderim ${sends.filter(s => week.includes(s.date)).length}/${SEND_GOAL}`].filter(Boolean).join(" · ");

  return { title: "SYLWA · gün özeti", body: [l1, l2.join(" · "), l3].filter(Boolean).join("\n") };
}

/* ---------- one user ---------- */
async function runUser(db, fcm, uid, tokens, now, force) {
  const out = { sent: 0, skipped: 0, removed: 0 };
  const base = db.collection("users").doc(uid);
  const stateRef = base.collection("notify").doc("state");
  const [setSnap, stateSnap, planSnap] = await db.getAll(base.collection("settings").doc("notify"), stateRef, base.collection("plan").doc("tasks"));
  const cfg = { ...DEFAULTS, ...(setSnap.data() || {}) };
  if (!validHM(cfg.quietStart) || !validHM(cfg.quietEnd)) { cfg.quietStart = DEFAULTS.quietStart; cfg.quietEnd = DEFAULTS.quietEnd; }
  const state = stateSnap.data() || {};
  const items = Array.isArray((planSnap.data() || {}).items) ? planSnap.data().items : [];
  const lastRun = typeof state.lastRun === "number" ? Math.max(state.lastRun, now - 24 * 3600e3) : now - 20 * 60e3;
  const sent = { ...(state.sent || {}) };
  const today = localDate(now), np = parts(now);
  const quiet = inQuiet(np.h * 60 + np.mi, cfg.quietStart, cfg.quietEnd);

  const progCache = {};
  const prog = async date => {
    if (!(date in progCache)) { const s = await base.collection("progress").doc(date).get(); progCache[date] = s.data() || { done: {}, water: 0 }; }
    return progCache[date];
  };

  const queue = []; // { key, tag, title, body }
  const testReq = Number(state.testRequest) || 0, testDone = Number(state.testDone) || 0;
  let newTestDone = testDone;
  if (force || testReq > testDone) {   // test requests ignore quiet hours: you asked for it
    queue.push({ key: null, tag: "test", title: "SYLWA · test", body: "🔔 Bildirimler çalışıyor. Saatinde görüşürüz!" });
    newTestDone = Math.max(testReq, testDone);
  }

  for (const date of [addDays(today, -1), today]) {
    for (const ev of eventsFor(date, items, cfg)) {
      const at = zoned(date, ev.time), key = date + "|" + ev.key;
      if (at <= lastRun || at > now || sent[key]) continue;
      const late = now - at;
      if (late > (ev.summary ? SUMMARY_MAX_MS : STALE_MS)) { sent[key] = "late"; out.skipped++; continue; }
      if (quiet) { sent[key] = "quiet"; out.skipped++; continue; }
      const p = await prog(date);
      const msg = ev.summary ? await buildSummary(base, date, items, p) : ev.build(p);
      if (!msg) { sent[key] = "done"; continue; }
      queue.push({ key, tag: ev.tag, ...msg });
    }
  }

  if (queue.length) {
    const messages = [], index = [];
    queue.forEach((q, qi) => tokens.forEach((t, ti) => {
      messages.push({ token: t.token, data: { title: q.title, body: q.body, tag: q.tag, url: APP_URL },
        webpush: { headers: { Urgency: "high", TTL: "3600" } } });
      index.push([qi, ti]);
    }));
    const ok = new Set(), dead = new Set();
    for (let i = 0; i < messages.length; i += 500) {
      const res = await fcm.sendEach(messages.slice(i, i + 500));
      res.responses.forEach((r, k) => {
        const [qi, ti] = index[i + k];
        if (r.success) ok.add(qi);
        else if (r.error && BAD_TOKEN.has(r.error.code)) dead.add(ti);
        else console.warn("send failed:", r.error && r.error.code);
      });
    }
    for (const ti of dead) { await tokens[ti].ref.delete(); out.removed++; }
    queue.forEach((q, qi) => { if (ok.has(qi)) { out.sent++; if (q.key) sent[q.key] = now; } });
    if (!ok.has(0) && queue[0].key === null) newTestDone = testDone; // test failed: try again next run
  }

  const cutoff = addDays(today, -KEEP_DAYS);
  const kept = {};
  for (const [k, v] of Object.entries(sent)) if (k.slice(0, 10) >= cutoff) kept[k] = v;
  await stateRef.set({ lastRun: now, sent: kept, testDone: newTestDone }, { mergeFields: ["lastRun", "sent", "testDone"] });
  return out;
}

/* ---------- main ---------- */
async function main() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT secret is missing");
  initializeApp({ credential: cert(JSON.parse(raw)) });
  const db = getFirestore(), fcm = getMessaging();
  const force = process.env.FORCE_TEST === "true";
  const now = Date.now();

  const byUser = new Map();
  const snap = await db.collectionGroup("push").get();
  for (const d of snap.docs) {
    const userRef = d.ref.parent.parent;
    if (!userRef || userRef.parent.id !== "users") continue;
    const token = d.get("token");
    if (typeof token !== "string" || !token) continue;
    if (!byUser.has(userRef.id)) byUser.set(userRef.id, []);
    byUser.get(userRef.id).push({ ref: d.ref, token });
  }

  const total = { users: byUser.size, sent: 0, skipped: 0, removed: 0, failed: 0 };
  for (const [uid, tokens] of byUser) {
    try { const r = await runUser(db, fcm, uid, tokens, now, force); total.sent += r.sent; total.skipped += r.skipped; total.removed += r.removed; }
    catch (e) { total.failed++; console.error("user failed:", e && (e.code || e.message)); }
  }
  console.log("SYLWA notifier", localDate(now), JSON.stringify(total));
  if (total.failed) process.exitCode = 1;
}

if (require.main === module) main().catch(e => { console.error("fatal:", e && (e.code || e.message)); process.exit(1); });
module.exports = { zoned, inQuiet, eventsFor, dayIndex, addDays, localDate, buildSummary };
