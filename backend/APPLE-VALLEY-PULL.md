# Apple Valley daily pull — how it works

Apple Valley Animal Services has no live feed and the shelter never sends
us anything. Instead, LApets reads the shelter's **public Adopt-a-Pet
listings** every day. No API key, no login, no credential, and nobody at
the shelter has to do anything.

## Source

- Shelter page: https://www.adoptapet.com/shelter/82156-apple-valley-animal-services-apple-valley-california
- Shelter ID on Adopt-a-Pet: **82156**
- Fetched with a normal browser user-agent, paginated (`?page=1…`, 12 pets
  per page, ~9–12 pages, ~103 pets as of Nov 15, 2026).
- Each pet's detail page (`https://www.adoptapet.com/pet/<id>-…`) is
  fetched once, only for pets we have never seen before. It gives:
  species, breed, sex, age group, color, size, weight, Pet ID, and the
  main photo (`og:image`, a `pet-uploads.adoptapet.com` URL).
- Every animal in the app links back to its official Adopt-a-Pet listing
  (`u` field), and the feed credits Apple Valley Animal Services.

## What is never guessed

- **Intake date:** kept from the Nov 11, 2026 pull where known (30 of 103
  animals on Nov 15). A genuinely new animal gets `"in": null` and shows
  "Intake date not listed" in the app. The "Posted … ago" date on an
  Adopt-a-Pet page is a *listing* date, not an intake date, and is never
  used as one. `firstSeen` (the date we first saw the animal) is recorded
  separately on new animals.
- **Age / size / weight / breed / sex:** only what the shelter publishes
  on the detail page. A new animal's age is its age *group* only
  ("Adult", "Puppy", "Kitten", "Senior") — no months or years are invented.
  If the shelter does not list a size, weight, color, or photo, the field
  stays `null` (one animal, Fizz, genuinely has no photo on Adopt-a-Pet).
- **Organisation:** Adopt-a-Pet's shelter page also surfaces pets from
  other Apple Valley rescues. A pet is kept only if its detail page says
  it is listed by **Apple Valley Animal Services** — e.g. three Beagles
  and Buddies dogs (Sammy, Angelito, Lightsaber) that appear on the page
  are skipped, every run.

## How to run it

```sh
cd <LApets-feed repo>
node backend/pull-apple-valley.mjs        # writes backend/apple-valley.json
node backend/pull.mjs --out=animals.json  # merges it into the live feed
```

It takes about 80 seconds (12 list pages + one detail fetch per new pet,
~0.7s apart, so Adopt-a-Pet is not hammered).

## Fail-safe

- The script writes to a temp file and renames it into place. Any fetch
  failure, an empty first page, or fewer than 50 animals parsed exits
  non-zero and **leaves the last good `apple-valley.json` untouched**.
- The daily GitHub workflow (`daily-pull.yml`) runs this first with
  `|| echo …` — if it fails, the feed pull still runs with the last good
  Apple Valley file, and the previous `animals.json` stays live.
- A pet whose detail page fails to fetch is skipped for that run only and
  picked up the next day; nothing about it is invented.

## Files

- `backend/pull-apple-valley.mjs` — the puller (Node 22, no dependencies).
- `backend/apple-valley.json` — the output: `{ asOf, note, animals[] }`.
  Animal records use the exact feed format (`i, n, t, b, s, al, ag, sg,
  sl, c, sh="Apple Valley", st, sk, in, d, wl, k, p, u, sn, bk`, plus
  `firstSeen` on animals first seen after Nov 11, 2026).
- `backend/pull.mjs` — merges this file into `animals.json` and recomputes
  waiting days from the stored intake dates. It never sets an intake date.
