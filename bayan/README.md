# Bayan — بَيَان

**Learn Classical Arabic — the Arabic of the Qurʾān, classical poetry and a
millennium of prose — from the first letter to real glossed texts.**

Bayan (*bayān*, "clarity, eloquence") is a complete offline classroom in one
PWA: a curriculum you can walk, a deck that remembers what you forget, and a
reader that lets you touch every word of the Fātiḥa.

## What's inside

- **The alphabet, properly** — all 28 letters plus hamza with their four
  contextual forms, articulation points, sun/moon classification and
  connector behaviour; drills whose distractors are the *look-alike* letters
  (ب ت ث ن ي…), the way a real teacher tests.
- **The signs** — every ḥaraka, tanwīn, šadda, madda, tāʾ marbūṭa, alif
  maqṣūra and hamzat al-waṣl, each with a vocalized example word.
- **144 high-frequency words** in ten themed units — the core
  Classical/Quranic lexicon with roots, plurals and fully vocalized heads.
- **Naḥw: twelve grammar lessons** — from roots-and-patterns to iʿrāb,
  iḍāfa, إِنَّ and كَانَ, and the plural system — each with vocalized
  examples and an authored quiz.
- **Ṣarf tables** — the full كَتَبَ paradigm (past and present), the ten
  verb forms with their meanings, pronouns and attached suffixes, and the
  derived-noun patterns.
- **A real reader** — Sūrat al-Fātiḥa, Sūrat al-Ikhlāṣ, eight classical
  proverbs and four celebrated lines (al-Mutanabbī, ash-Shāfiʿī, Zuhayr, a
  ḥadīth), every line glossed word by word. Tap a word, hear it, learn it.
- **Spaced repetition** — an SM-2-style scheduler: clear a vocabulary
  stage and its words join your review deck at the right intervals.
- **A path with ranks** — streaks, XP and stars carry you from مُبْتَدِئ
  (Beginner) to فَصِيح (Master of Eloquence).

Every Arabic string in the curriculum is fully vocalized, in modern
typographic (imlāʾī) orthography, and was adversarially reviewed for
orthography, vocalization, translation and grammatical accuracy.

## Architecture

House prototype conventions:

- `engine.js` — **everything that is a rule lives here**: the curriculum
  data, seeded deterministic quiz builders, the SRS scheduler, streak/XP
  math and the course path. Pure functions, clock-injected, zero DOM,
  zero I/O; loads as a browser classic script, in the smoke sandbox, and
  via `module.exports`.
- `index.html` — the whole UI: the path, teach-then-drill stages, review
  deck, alphabet and ṣarf references, and the glossed reader. State is one
  localStorage profile; pronunciation uses the browser's Arabic speech
  voices when available.
- `sw.js` + `manifest.json` — offline-first PWA; the cached shell is the
  whole classroom.

## Tests

```
npm run test:bayan    # engine unit tests + curriculum integrity
npm run test:smoke    # inline-script sanity across all prototypes
npm run icons:bayan   # regenerate the PNG icons from the motif
```

The unit tests double as curriculum guards: they assert the sun letters are
exactly the fourteen, every gloss aligns with its token, every quiz has one
correct answer, and the Fātiḥa still opens with the basmala.
