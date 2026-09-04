# Bayan — بَيَان

**Learn Classical Arabic — the Arabic of the Qurʾān, classical poetry and a
millennium of prose — from the first letter to the classical canon itself.**

Bayan (*bayān*, "clarity, eloquence") is a complete offline classroom in one
PWA: a 90-stage course in three marḥalas (Foundation → Intermediate →
Advanced), a spaced-repetition deck that remembers what you forget, and a
reader that lets you touch every word from the Fātiḥa to the Muʿallaqa.

## What's inside

- **The alphabet, properly** — all 28 letters plus hamza with their four
  contextual forms, articulation points, sun/moon classification and
  connector behaviour; drills whose distractors are the *look-alike* letters
  (ب ت ث ن ي…), the way a real teacher tests.
- **The signs** — every ḥaraka, tanwīn, šadda, madda, tāʾ marbūṭa, alif
  maqṣūra and hamzat al-waṣl, each with a vocalized example word.
- **427 words in thirty themed units** — the core Classical/Quranic lexicon,
  then the intermediate frequency band (travel, trade, war, the heart,
  judgment, fate…), then the literary and scholarly canon (the qaṣīda's
  landscape, rhetoric, law, philosophy) — with roots, plurals and fully
  vocalized heads.
- **Naḥw: twenty-eight grammar lessons** — the foundation (roots to iʿrāb,
  iḍāfa, إِنَّ and كَانَ), the intermediate engine-room (passive, ḥāl,
  tamyīz, exception, conditionals, the numbers, diptotes), the advanced
  syntax (كَادَ, the mafʿūl family, the followers, absolute negation and
  oaths) — and an art track: simile and metaphor, the badīʿ ornaments,
  ʿarūḍ metrics, and reading the unvocalized page.
- **Ṣarf in full** — the sound كَتَبَ paradigm, the ten verb forms, and the
  nine weak-verb classes (hollow, doubled, assimilated, defective,
  hamzated) as complete drilled paradigms; the ten broken-plural moulds,
  the maṣdar patterns I–X, and the quadriliteral.
- **A real reader, thirteen texts** — Sūrat al-Fātiḥa, al-Ikhlāṣ, al-ʿAṣr,
  al-Falaq, an-Nās and Āyat al-Kursī; six rigorously attributed ḥadīths;
  classical proverbs and celebrated single lines; then the canon: the
  opening of Imruʾ al-Qays's Muʿallaqa, al-Mutanabbī, ash-Shāfiʿī's
  دَعِ الْأَيَّامَ, and Kalīla wa-Dimna prose — every line glossed word by
  word. Tap a word, hear it, learn it.
- **Spaced repetition** — an SM-2-style scheduler: clear a vocabulary
  stage and its words join your review deck at the right intervals.
- **A path with ranks** — streaks, XP and stars carry you from مُبْتَدِئ
  (Beginner) through فَصِيح to لِسَان الْعَرَب (the Tongue of the Arabs).

Every Arabic string in the curriculum is fully vocalized, in modern
typographic (imlāʾī) orthography, and was adversarially reviewed for
orthography, vocalization, translation, attribution and grammatical
accuracy by independent verification passes.

## Architecture

House prototype conventions:

- `engine.js` — **everything that is a rule lives here**: the curriculum
  data, seeded deterministic quiz builders (letters, signs, vocabulary,
  sound and weak conjugation, verb forms, broken plurals, grammar,
  reading), the SRS scheduler, streak/XP math and the sectioned course
  path. Pure functions, clock-injected, zero DOM, zero I/O; loads as a
  browser classic script, in the smoke sandbox, and via `module.exports`.
- `index.html` — the whole UI: the three-marḥala path, teach-then-drill
  stages, review deck, alphabet and ṣarf references (including the
  weak-verb tables and plural moulds), and the glossed reader. State is
  one localStorage profile; pronunciation uses the browser's Arabic
  speech voices when available.
- `sw.js` + `manifest.json` — offline-first PWA; the cached shell is the
  whole classroom.

## Tests

```
npm run test:bayan    # engine unit tests + curriculum integrity (46)
npm run test:smoke    # inline-script sanity across all prototypes
npm run icons:bayan   # regenerate the PNG icons from the motif
```

The unit tests double as curriculum guards: they assert the sun letters are
exactly the fourteen, every gloss aligns with its token, every quiz has one
correct answer, the weak paradigms keep their famous forms (قُلْتُ, دَعَتْ,
رَمَتْ, نَسُوا…), and the Fātiḥa still opens with the basmala.
