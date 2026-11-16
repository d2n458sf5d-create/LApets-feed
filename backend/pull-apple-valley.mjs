// LApets — daily Apple Valley pull.
// Node 22, no dependencies. Run: node backend/pull-apple-valley.mjs [--out backend/apple-valley.json]
//
// What it does:
//  1. Fetches the PUBLIC Adopt-a-Pet shelter page for Apple Valley Animal
//     Services (shelter 82156), paginated, 12 pets per page, with a browser
//     user-agent. No API key, no login, no credential of any kind, and the
//     shelter is never asked for anything: the shelter does not send us a
//     list or a feed, we read the same public listings anyone can open.
//  2. For each pet it keeps the record already in apple-valley.json
//     (intake date, exact age, size and weight stay exactly as they were
//     pulled on Nov 11, 2026 — an intake date never changes).
//  3. For a genuinely new pet it fetches that pet's public Adopt-a-Pet
//     detail page once and takes only what the shelter publishes there:
//     species, breed, sex, age group, color, size, weight, Pet ID, and the
//     main photo (og:image). The intake date is set to null — NEVER guessed
//     (the "Posted … ago" date on the page is a listing date, not an
//     intake date) — so a new animal shows "Intake date not listed" in
//     the app, and its firstSeen date is recorded separately.
//  4. Pets no longer listed are dropped from the file (the app itself
//     keeps a saved dropped animal in Saved, flagged gone — that is the
//     app's job, not this file's).
//  5. Writes backend/apple-valley.json atomically (temp file + rename).
//     A failed pull NEVER overwrites the last good file: any fetch failure,
//     an empty first page, or a suspiciously small total (< 50 animals)
//     exits non-zero and leaves the old file untouched.
//
// The daily GitHub workflow runs this BEFORE backend/pull.mjs, which merges
// apple-valley.json into animals.json and recomputes waiting days from the
// stored intake dates. Source of truth for the merge is this file's asOf
// date and note, carried into the feed as appleValleyAsOf / appleValleyNote.

import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const _argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < _argv.length; i++) {
  const a = _argv[i];
  if (!a.startsWith("--")) continue;
  const eq = a.indexOf("=");
  if (eq !== -1) args[a.slice(2, eq)] = a.slice(eq + 1);
  else if (i + 1 < _argv.length && !_argv[i + 1].startsWith("--")) args[a.slice(2)] = _argv[++i];
  else args[a.slice(2)] = true;
}
const OUT = path.resolve(ROOT, args.out || "backend/apple-valley.json");
const MAX_PAGES = Number(args["max-pages"] || 15);
const PAGE_SLEEP_MS = 1000;
const DETAIL_SLEEP_MS = 700;
const MIN_ANIMALS = 50; // refuse to overwrite the last good file with a truncated parse
const SHELTER_URL = "https://www.adoptapet.com/shelter/82156-apple-valley-animal-services-apple-valley-california";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log(new Date().toISOString(), ...m);
const TODAY = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
const TODAY_ISO = `${TODAY.getFullYear()}-${String(TODAY.getMonth() + 1).padStart(2, "0")}-${String(TODAY.getDate()).padStart(2, "0")}`;
const LA_MIDNIGHT = new Date(`${TODAY_ISO}T12:00:00`);

function daysBetween(iso) {
  if (!iso) return null;
  const d = new Date(iso + "T12:00:00");
  if (isNaN(d.getTime())) return null;
  return Math.max(0, Math.round((LA_MIDNIGHT - d) / 86400000));
}
function stripTags(s) {
  return s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}
async function fetchText(url, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "en-US,en;q=0.9" } });
      if (r.ok) return await r.text();
      log(`fetch ${url} attempt ${i}: HTTP ${r.status}`);
    } catch (e) {
      log(`fetch ${url} attempt ${i} threw: ${e.message}`);
    }
    await sleep(2000 * i);
  }
  throw new Error(`could not fetch ${url} after ${attempts} attempts`);
}

// One shelter-list page -> [{ apId, url, name, breed, sex, ageGroup }]
function parseShelterPage(html) {
  const out = [];
  const blocks = html.split("pet-card--component");
  for (const b of blocks.slice(1)) {
    const href = (b.match(/data-testid="pet-card-link"[^>]*href="(https:\/\/www\.adoptapet\.com\/pet\/(\d+)-[^"]+)"/) || [])[1];
    const apId = (b.match(/data-testid="pet-card-link"[^>]*href="https:\/\/www\.adoptapet\.com\/pet\/(\d+)-/) || [])[1];
    if (!href || !apId) continue;
    const name = (b.match(/name">([^<]+)<\/p>/) || [])[1];
    const breed = (b.match(/breed">([^<]+)<\/p>/) || [])[1];
    // "<p class=\"truncate\">Female<span ...>, adult</span></p>"
    const sexAge = b.match(/<p class="truncate">\s*(Male|Female)\s*<span[^>]*>,\s*(adult|kitten|puppy|senior)/i);
    out.push({
      apId,
      url: href.replace(/\\$/, ""),
      name: name ? stripTags(name) : null,
      breed: breed ? stripTags(breed) : null,
      sex: sexAge ? sexAge[1] : null,
      ageGroup: sexAge ? sexAge[2].toLowerCase() : null,
    });
  }
  return out;
}

// One pet detail page -> { species, photo, color, size, weightLbs, petId }
// Only what the shelter publishes on that page. No story-text parsing:
// the "~2 yrs old / 49 pounds" notes in the story are free text and are
// NOT used for age or weight.
function parseDetailPage(html) {
  const species = (html.match(/\\"species\\":\\"(dog|cat|other)\\"/) || [])[1] || null;
  const photo = (html.match(/<meta property="og:image" content="([^"]+)"/) || [])[1] || null;
  const text = stripTags(html);
  const info = (text.match(/My basic info (.*?) My story/) || [])[1] || "";
  const field = (label) => {
    // "Breed X Age Y Sex Z Color C Size S Weight W Pet ID N" (cats have
    // "Hair Length" instead of Size/Weight; some fields are "Not listed").
    // "My details" / "My health" can follow Pet ID on some pages, so they
    // are terminators too — otherwise Pet ID swallows the rest of the block.
    const labels = ["Breed", "Age", "Sex", "Color", "Size", "Weight", "Hair Length", "Pet ID", "My details", "My health"];
    const re = new RegExp(label + "\\s+(.*?)(?=\\s+(?:" + labels.join("|") + ")\\s+|$)");
    const m = info.match(re);
    return m ? m[1].trim() : null;
  };
  const sizeRaw = field("Size");
  const weightRaw = field("Weight");
  const weightLbs = weightRaw && /^\d+/.test(weightRaw) ? Number(weightRaw.match(/^(\d+)/)[1]) : null;
  const petId = field("Pet ID");
  // The organisation actually listing the pet. Adopt-a-Pet's shelter page
  // also surfaces pets from other Apple Valley rescues (e.g. Beagles and
  // Buddies) — only "Apple Valley Animal Services" belongs in this file.
  const org = (html.match(/\\"awoName\\":\\"([^"\\]+)/) || [])[1] || null;
  return {
    org,
    species,
    photo: photo && photo.includes("pet-uploads.adoptapet.com") ? photo.split("&")[0] : photo || null,
    breed: field("Breed"),
    ageWord: field("Age"),
    sex: field("Sex"),
    color: field("Color") && field("Color") !== "Not listed" ? field("Color") : null,
    sizeRaw,
    weightLbs,
    petId: petId && /^\d+$/.test(petId) ? petId : null,
  };
}

function ageGroupToRecord(ageWord) {
  const w = (ageWord || "").toLowerCase();
  if (w === "kitten" || w === "puppy") return { ag: "baby", al: ageWord };
  if (w === "adult") return { ag: "adult", al: "Adult" };
  if (w === "senior") return { ag: "senior", al: "Senior" };
  return { ag: "unknown", al: "Age not listed" };
}
function sizeToRecord(sizeRaw, weightLbs) {
  const s = (sizeRaw || "").toLowerCase();
  let sg = "unknown";
  if (/^small/.test(s)) sg = "small";
  else if (/^med/.test(s)) sg = "medium";
  else if (/large|x-large/.test(s)) sg = "big";
  const word = sg === "unknown" ? null : sg.charAt(0).toUpperCase() + sg.slice(1);
  return { sg, sl: word ? word + (weightLbs != null ? ` · ${weightLbs} lbs` : "") : null };
}

async function main() {
  const started = Date.now();
  const oldDoc = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { animals: [] };
  const oldById = new Map((oldDoc.animals || []).map((a) => [a.i, a]));

  // 1. Shelter list pages, newest first, 12 per page.
  const seen = new Map(); // apId -> card
  let page = 1, lastPageCount = 12; // start at 12 so the first page is fetched; the loop stops after a short (< 12) page
  while (page <= MAX_PAGES && lastPageCount === 12) {
    const html = await fetchText(`${SHELTER_URL}?page=${page}`);
    const cards = parseShelterPage(html);
    if (page === 1 && cards.length === 0) throw new Error("shelter page 1 returned no pet cards — refusing to overwrite the last good file");
    for (const c of cards) if (!seen.has(c.apId)) seen.set(c.apId, c);
    log(`shelter page ${page}: ${cards.length} cards, ${seen.size} unique so far`);
    lastPageCount = cards.length;
    page++;
    if (lastPageCount === 12) await sleep(PAGE_SLEEP_MS);
  }
  const cards = [...seen.values()];
  log(`list done: ${cards.length} Apple Valley pets on the public shelter page`);

  // 2. Keep old records as-is; fetch detail pages only for new pets.
  const fresh = [];
  let kept = 0, added = 0, detailFail = 0, skippedOther = 0;
  for (const c of cards) {
    const id = "AP" + c.apId;
    const old = oldById.get(id);
    if (old) {
      kept++;
      fresh.push(old);
      continue;
    }
    let d = null;
    try {
      d = parseDetailPage(await fetchText(c.url));
    } catch (e) {
      detailFail++;
      log(`detail ${id} failed: ${e.message} — skipping this pet this run (it will be picked up next run, never invented)`);
      await sleep(DETAIL_SLEEP_MS);
      continue;
    }
    await sleep(DETAIL_SLEEP_MS);
    if (d.org && d.org !== "Apple Valley Animal Services") {
      skippedOther++;
      log(`skip ${id} (${c.name || "?"}) — listed by ${d.org}, not Apple Valley Animal Services`);
      continue;
    }
    const { ag, al } = ageGroupToRecord(d.ageWord || (c.ageGroup ? c.ageGroup.charAt(0).toUpperCase() + c.ageGroup.slice(1) : null));
    const { sg, sl } = sizeToRecord(d.sizeRaw, d.weightLbs);
    const t = d.species === "cat" ? "cat" : d.species === "dog" ? "dog" : "other";
    fresh.push({
      i: id,
      n: c.name || d.breed || id,
      t,
      b: d.breed || c.breed || null,
      s: d.sex || c.sex || null,
      al, ag, sg, sl,
      c: d.color,
      sh: "Apple Valley",
      st: null, sk: "other",
      in: null, d: null, wl: "Intake date not listed",
      k: null,
      p: d.photo || null,
      u: c.url,
      sn: d.petId || null,
      bk: 0,
      firstSeen: TODAY_ISO,
    });
    added++;
  }

  // 3. Validate before touching the last good file.
  if (fresh.length < MIN_ANIMALS) throw new Error(`only ${fresh.length} animals parsed (minimum ${MIN_ANIMALS}) — refusing to overwrite the last good file`);
  const ids = new Set();
  for (const a of fresh) {
    if (!a.i || !a.n || !a.t || !a.sh || !a.u) throw new Error(`invalid record: ${JSON.stringify(a).slice(0, 200)}`);
    if (ids.has(a.i)) throw new Error(`duplicate id ${a.i}`);
    ids.add(a.i);
    // New records must never carry an intake date (kept records keep the
    // one from the Nov 11 pull). Construction guarantees this; check it.
    if (a.firstSeen === TODAY_ISO && a.in) throw new Error(`new record ${a.i} has an intake date — intake dates are never set for new animals`);
  }
  const dropped = [...oldById.keys()].filter((id) => !ids.has(id));

  // Sort longest-waiting first (intake ascending), no-intake last, then id —
  // the same order pull.mjs uses when it merges this file into the feed.
  fresh.sort((x, y) => {
    const xi = x.in ? Date.parse(x.in) : NaN, yi = y.in ? Date.parse(y.in) : NaN;
    if (!isNaN(xi) && !isNaN(yi) && xi !== yi) return xi - yi;
    if (!isNaN(xi) && isNaN(yi)) return -1;
    if (isNaN(xi) && !isNaN(yi)) return 1;
    return x.i < y.i ? -1 : 1;
  });
  // Recompute waiting labels from stored intake dates (same math as pull.mjs).
  for (const a of fresh) {
    const d = daysBetween(a.in);
    a.d = d;
    a.wl = d != null ? `${d} days waiting` : "Intake date not listed";
  }

  const doc = {
    asOf: TODAY_ISO,
    note: "Public Adopt-a-Pet listings for Apple Valley Animal Services (shelter 82156), refreshed daily. No shelter feed and no API key: the shelter never sends us anything. Each animal links back to its official Adopt-a-Pet listing. Intake dates are kept from the Nov 11, 2026 pull where known; new animals show no intake date rather than a guessed one.",
    animals: fresh,
  };
  writeFileSync(OUT + ".new", JSON.stringify(doc, null, 1));
  renameSync(OUT + ".new", OUT);
  log(`APPLE VALLEY WRITTEN ${OUT}: ${fresh.length} animals (${kept} kept, ${added} new, ${dropped.length} dropped${skippedOther ? `, ${skippedOther} skipped (other rescue)` : ""}${detailFail ? `, ${detailFail} detail fetch(es) failed and skipped` : ""}). Dropped: ${dropped.join(", ") || "none"}. New: ${fresh.filter((a) => a.firstSeen === TODAY_ISO).map((a) => a.i).join(", ") || "none"}. ${((Date.now() - started) / 1000).toFixed(0)}s.`);
}

main().catch((e) => { console.error("APPLE VALLEY PULL FAILED:", e.message); process.exit(1); });
