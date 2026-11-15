// LApets v1.1 — daily animal feed puller.
// Node 22, no dependencies. Run: node backend/pull.mjs [--out data/animals.json]
//
// What it does, in order:
//  1. Pulls the LA County DACC public animal list (same public endpoints the
//     county's own search site calls: dacc-search page -> signature/timestamp
//     -> wp-json/wppro-acc/v1/get/animals, route=Animals, paginated).
//  2. For every LA County animal ID it has never seen, it fetches the
//     AnimalByID detail record (same endpoint, route=AnimalByID) to get the
//     intake date, and for dogs the behaviour assessment: recommendation2
//     (Dog Social Skills) and recommendation4 (Energy Level). Values are
//     shown verbatim, title-cased, exactly as the shelter publishes them.
//     Nothing is guessed and no "Unknown" row is ever invented.
//  3. Intake dates and assessments are CACHED by animal ID (backend/cache.json).
//     An intake date never changes, so a known animal is never re-fetched for
//     it. Assessments are re-checked only when a dog has not been checked in
//     14 days, at most 40 dogs per run, so the daily run stays fast and the
//     county does not rate-limit us (403s are retried with a fresh signature
//     and backoff, 1.1s between detail calls).
//  4. Merges Apple Valley animals from backend/apple-valley.json (last good
//     pull, labelled with its date — see README: Apple Valley has no live
//     source yet, its Adopt-a-Pet API needs a partner key).
//  5. Writes the feed JSON. If validation fails the previous good feed is
//     left untouched and the run exits non-zero.
//
// The feed uses the EXACT animal record format of the Build 4 static app,
// so the v1.1 app needs no other data changes:
//   i=id, n=name, t=dog|cat|other, b=breed, s=sex, al=age label, ag=age group,
//   sg=size group, sl=size label, c=color, sh=shelter label, st=status label,
//   sk=status key, in=intake YYYY-MM-DD or null, d=days waiting or null,
//   wl=waiting label, k=kennel, p=photo url or null,
//   u=official listing url, sn=shelter number or null, bk=sort boost,
//   en=Energy Level (dogs only, when published), so=Dog Social Skills (dogs only, when published)

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Accept both --out=animals.json and --out animals.json
const _argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < _argv.length; i++) {
  const a = _argv[i];
  if (!a.startsWith("--")) continue;
  const eq = a.indexOf("=");
  if (eq !== -1) {
    args[a.slice(2, eq)] = a.slice(eq + 1);
  } else if (i + 1 < _argv.length && !_argv[i + 1].startsWith("--")) {
    args[a.slice(2)] = _argv[++i];
  } else {
    args[a.slice(2)] = true;
  }
}
const OUT = path.resolve(ROOT, args.out || "data/animals.json");
const CACHE_PATH = path.resolve(ROOT, args.cache || "backend/cache.json");
const AV_PATH = path.resolve(ROOT, args["apple-valley"] || "backend/apple-valley.json");
const TODAY = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
const TODAY_ISO = TODAY.toISOString().slice(0, 10); // UTC date of the LA-local day is close enough for a feed label; days-waiting uses LA midnight below
const LA_MIDNIGHT = new Date(`${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, "0")}-${String(TODAY.getDate()).padStart(2, "0")}T12:00:00`);
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log(new Date().toISOString(), ...m);

function titleCase(v) {
  if (!v) return null;
  return String(v)
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
function daysBetween(iso) {
  if (!iso) return null;
  const d = new Date(iso + "T12:00:00");
  if (isNaN(d.getTime())) return null;
  return Math.max(0, Math.round((LA_MIDNIGHT - d) / 86400000));
}
function ageLabel(months) {
  if (months == null) return "Age not listed";
  if (months < 12) return months + " mo old";
  const y = Math.floor(months / 12), m = months % 12;
  return m ? `${y} yr ${m} mo old` : `${y} yr old`;
}

const SHELTER_NAMES = { Baldwin: "Baldwin Park", Carson: "Carson / Gardena", Castaic: "Castaic (Santa Clarita Valley)" };

function mapListRow(x) {
  if (!x || !x.animalId) return null;
  const months = x.yearsOld == null && x.monthsOld == null ? null : (x.yearsOld || 0) * 12 + (x.monthsOld || 0);
  const ag = months == null ? "unknown" : months < 6 ? "baby" : months < 24 ? "young" : months < 84 ? "adult" : "senior";
  const raw = (x.animalSize || "").toUpperCase();
  let sg = raw === "TOY" || raw === "SMALL" ? "small" : raw === "MED" ? "medium" : raw === "LARGE" || raw === "EXLG" ? "big" : "unknown";
  if (sg === "unknown" && x.weight != null) sg = x.weight <= 25 ? "small" : x.weight <= 50 ? "medium" : "big";
  const sgLabel = sg === "unknown" ? null : sg.charAt(0).toUpperCase() + sg.slice(1) + (x.weight != null ? " · " + Math.round(x.weight) + " lbs" : "");
  const s = (x.kennelStat || "").toUpperCase();
  let st = null, sk = "other";
  if (x.rescueOnly || s.indexOf("RESC") !== -1) { st = "Rescue only"; sk = "rescue"; }
  else if (s === "RTGH") { st = "Ready to go home"; sk = "rtgh"; }
  else if (s.indexOf("AV PEND SN") !== -1) { st = "Available · pending spay/neuter"; sk = "avail"; }
  else if (s.indexOf("AV BET") !== -1) { st = "Available · pending assessment"; sk = "avail"; }
  else if (s.indexOf("HOLD") !== -1) { st = "On hold · ask the shelter"; sk = "hold"; }
  else if (s.indexOf("STRAY") !== -1) { st = "Stray wait"; sk = "other"; }
  else if (s.indexOf("PEND") !== -1) { st = "Adoption pending"; sk = "pend"; }
  else if (x.kennelStat) { st = x.kennelStat; }
  const img = "https://daccanimalimagesprod.blob.core.windows.net/images/" + x.animalId + ((x.imageCount || 1) > 1 ? "-" + x.imageCount : "") + ".jpg";
  return {
    i: x.animalId, n: x.animalName || x.animalId,
    t: (x.animalType || "OTHER").toUpperCase() === "DOG" ? "dog" : (x.animalType || "").toUpperCase() === "CAT" ? "cat" : "other",
    b: x.breed || null, s: x.sex || null, al: ageLabel(months), ag, sg, sl: sgLabel,
    c: x.primaryColor || null, sh: SHELTER_NAMES[x.location] || x.location || "LA County",
    st, sk, in: null, d: null, wl: "Intake date not listed",
    k: null, p: img, u: "https://animalcare.lacounty.gov/dacc-details/?animalId=" + x.animalId, sn: null, bk: 0,
  };
}

async function fetchSignature() {
  // The county site is flaky from a server (intermittent 403s and dropped
  // connections). Retry both HTTP failures and network throws.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const r = await fetch("https://animalcare.lacounty.gov/dacc-search/?PageNumber=1", {
        headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" },
      });
      if (r.ok) {
        const html = await r.text();
        const sig = (html.match(/signature:\s*'([a-f0-9]+)'/) || [])[1];
        const ts = (html.match(/timestamp:\s*'([0-9]+)'/) || [])[1];
        if (sig && ts) return { sig, ts };
      }
      log(`signature fetch attempt ${attempt} failed (status ${r.status}), retrying…`);
    } catch (e) {
      log(`signature fetch attempt ${attempt} threw (${e.message}), retrying…`);
    }
    await sleep(2000 * attempt);
  }
  throw new Error("could not get a DACC search signature after 5 attempts");
}

let auth = null;
async function daccFetch(url) {
  if (!auth) auth = await fetchSignature();
  const headers = {
    "X-AccSearch-Signature": auth.sig, "X-AccSearch-Timestamp": auth.ts,
    "User-Agent": UA, Accept: "application/json",
    Referer: "https://animalcare.lacounty.gov/dacc-search/?PageNumber=1",
  };
  let r = await fetch(url, { headers });
  if (r.status === 403) {
    // Signature expired / rate-limited: get a fresh one and retry once.
    auth = await fetchSignature();
    headers["X-AccSearch-Signature"] = auth.sig;
    headers["X-AccSearch-Timestamp"] = auth.ts;
    await sleep(1500);
    r = await fetch(url, { headers });
  }
  return r;
}

async function fetchDetail(id) {
  // Returns { intake, en, so } or null on failure. Retries 403s with a fresh signature.
  const api = "https://animalcare.lacounty.gov/wp-json/wppro-acc/v1/get/animals";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await daccFetch(`${api}?route=AnimalByID&animalId=${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`detail HTTP ${r.status}`);
      const j = await r.json();
      const row = (j.animals || [])[0];
      if (!row) return { intake: null, en: null, so: null, k: null };
      return {
        intake: row.intakeDate ? String(row.intakeDate).slice(0, 10) : null,
        k: row.kennelNo || null,
        // Dogs only: recommendation4 = Energy Level, recommendation2 = Dog Social Skills.
        // Never relabel, never guess; null when the shelter did not publish one.
        en: titleCase(row.recommendation4),
        so: titleCase(row.recommendation2),
      };
    } catch (e) {
      log(`detail ${id} attempt ${attempt} failed: ${e.message}`);
      await sleep(1500 * attempt);
    }
  }
  return null;
}

async function main() {
  const started = Date.now();
  const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, "utf8")) : { animals: {} };
  cache.animals = cache.animals || {};
  // Previous feed for new/dropped comparison: the last written feed, or on
  // the very first run the Nov 11 Build 4 snapshot (backend/seed-static.json).
  const prevFeed = existsSync(OUT)
    ? JSON.parse(readFileSync(OUT, "utf8"))
    : existsSync(path.resolve(ROOT, "backend/seed-static.json"))
      ? JSON.parse(readFileSync(path.resolve(ROOT, "backend/seed-static.json"), "utf8"))
      : null;
  const prevIds = new Set((prevFeed?.animals || []).map((a) => a.i));

  // 1. List pull (paginated).
  const api = "https://animalcare.lacounty.gov/wp-json/wppro-acc/v1/get/animals";
  let all = [], total = Infinity, page = 1, retries403 = 0;
  while (all.length < total && page <= 30) {
    const r = await daccFetch(`${api}?route=Animals&PageNumber=${page}&PageSize=100&SortType=1`);
    if (r.status === 403) retries403++;
    if (!r.ok) throw new Error(`list page ${page} HTTP ${r.status}`);
    const j = await r.json();
    total = j.totalRecords || 0;
    (j.animals || []).forEach((x) => { const a = mapListRow(x); if (a) all.push(a); });
    log(`list page ${page}: ${all.length}/${total}`);
    page++;
    await sleep(400);
  }
  log(`list done: ${all.length} LA County animals (county says ${total})`);

  // 2. Detail enrichment: new animals first, then a bounded re-check of stale dog assessments.
  // New animals, animals missing an intake date, and animals missing a
  // kennel number (the first v1.1 run did not store kennels — one-time backfill).
  const needDetail = all.filter((a) => !cache.animals[a.i] || !cache.animals[a.i].in || !cache.animals[a.i].k);
  const staleDogs = all
    .filter((a) => a.t === "dog" && cache.animals[a.i]?.in && cache.animals[a.i]?.assessedAt)
    .filter((a) => (Date.now() - new Date(cache.animals[a.i].assessedAt).getTime()) / 86400000 > 14)
    .sort((a, b) => new Date(cache.animals[a.i].assessedAt) - new Date(cache.animals[b.i].assessedAt))
    .slice(0, 40);
  const queue = [...needDetail, ...staleDogs.filter((a) => !needDetail.includes(a))];
  log(`detail queue: ${needDetail.length} new/missing-intake + ${queue.length - needDetail.length} stale dog assessments`);
  let detailOk = 0, detailFail = 0;
  for (const a of queue) {
    const d = await fetchDetail(a.i);
    await sleep(1100);
    if (!d) { detailFail++; continue; }
    detailOk++;
    const prev = cache.animals[a.i] || {};
    cache.animals[a.i] = {
      in: d.intake || prev.in || null,
      k: d.k || prev.k || null,
      bk: prev.bk ?? 0,
      en: a.t === "dog" ? (d.en ?? prev.en ?? null) : null,
      so: a.t === "dog" ? (d.so ?? prev.so ?? null) : null,
      assessedAt: a.t === "dog" ? new Date().toISOString() : prev.assessedAt || null,
      seenAt: new Date().toISOString(),
    };
  }
  log(`details done: ${detailOk} ok, ${detailFail} failed (those keep their cached values, or stay without an intake date)`);

  // 3. Apply cache to the list, compute waiting time, sort longest-waiting first.
  const animals = all.map((a) => {
    const c = cache.animals[a.i] || {};
    const intake = c.in || null;
    const d = daysBetween(intake);
    const out = { ...a, in: intake, d, wl: d != null ? `${d} days waiting` : "Intake date not listed", k: c.k || null, bk: c.bk ?? 0 };
    if (a.t === "dog") {
      if (c.en) out.en = c.en;
      if (c.so) out.so = c.so;
    }
    return out;
  });
  animals.sort((x, y) => {
    const xi = x.in ? Date.parse(x.in) : NaN, yi = y.in ? Date.parse(y.in) : NaN;
    if (!isNaN(xi) && !isNaN(yi) && xi !== yi) return xi - yi;
    if (!isNaN(xi) && isNaN(yi)) return -1;
    if (!isNaN(xi) && !isNaN(yi)) return 1;
    if ((y.bk || 0) !== (x.bk || 0)) return (y.bk || 0) - (x.bk || 0);
    return x.i < y.i ? -1 : 1;
  });

  // 4. Apple Valley: last good pull (see README — no live source yet).
  let av = [], avAsOf = null, avNote = "";
  if (existsSync(AV_PATH)) {
    const avDoc = JSON.parse(readFileSync(AV_PATH, "utf8"));
    av = avDoc.animals || [];
    avAsOf = avDoc.asOf || null;
    avNote = avDoc.note || "";
    // Recompute Apple Valley waiting days from their stored intake dates.
    av = av.map((a) => {
      const d = daysBetween(a.in);
      return { ...a, d, wl: d != null ? `${d} days waiting` : "Intake date not listed" };
    });
  }
  const allAnimals = [...animals, ...av].sort((x, y) => {
    const xi = x.in ? Date.parse(x.in) : NaN, yi = y.in ? Date.parse(y.in) : NaN;
    if (!isNaN(xi) && !isNaN(yi) && xi !== yi) return xi - yi;
    if (!isNaN(xi) && isNaN(yi)) return -1;
    if (isNaN(xi) && !isNaN(yi)) return 1;
    return x.i < y.i ? -1 : 1;
  });

  const newIds = allAnimals.filter((a) => !prevIds.has(a.i)).map((a) => a.i);
  const droppedIds = [...prevIds].filter((id) => !allAnimals.some((a) => a.i === id));
  const feed = {
    version: 1,
    generatedAt: new Date().toISOString(),
    generatedDate: TODAY.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    source: "LA County DACC public API (live) + Apple Valley last good pull",
    counts: {
      total: allAnimals.length,
      laCounty: animals.length,
      appleValley: av.length,
      withIntakeDate: allAnimals.filter((a) => a.in).length,
      withEnergy: allAnimals.filter((a) => a.en).length,
      withDogSocial: allAnimals.filter((a) => a.so).length,
      newSinceLastFeed: newIds.length,
      droppedSinceLastFeed: droppedIds.length,
    },
    appleValleyAsOf: avAsOf,
    appleValleyNote: avNote,
    newIds, droppedIds,
    animals: allAnimals,
  };

  // 5. Validate before overwriting the previous good feed.
  const ids = new Set();
  for (const a of allAnimals) {
    if (!a.i || !a.n || !a.t || !a.sh || !a.u) throw new Error(`invalid animal record: ${JSON.stringify(a).slice(0, 200)}`);
    if (ids.has(a.i)) throw new Error(`duplicate animal id ${a.i}`);
    ids.add(a.i);
    if ((a.en || a.so) && a.t !== "dog") throw new Error(`assessment on non-dog ${a.i}`);
    if (a.en === "Unknown" || a.so === "Unknown") throw new Error(`Unknown assessment on ${a.i}`);
  }
  if (allAnimals.length < 500) throw new Error(`feed too small (${allAnimals.length}), refusing to overwrite the last good feed`);
  if (animals.length < 500) throw new Error(`LA County list too small (${animals.length})`);

  writeFileSync(OUT + ".new", JSON.stringify(feed, null, 1));
  renameSync(OUT + ".new", OUT);
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 1));
  log(`FEED WRITTEN ${OUT}: ${feed.counts.total} animals (${feed.counts.laCounty} LA County + ${feed.counts.appleValley} Apple Valley), ${feed.counts.newSinceLastFeed} new, ${feed.counts.droppedSinceLastFeed} dropped, ${feed.counts.withIntakeDate} with intake dates, ${feed.counts.withEnergy} with Energy, ${feed.counts.withDogSocial} with Dog Social. ${((Date.now() - started) / 1000).toFixed(0)}s, ${retries403} list 403s.`);
}

main().catch((e) => { console.error("PULL FAILED:", e.message); process.exit(1); });
