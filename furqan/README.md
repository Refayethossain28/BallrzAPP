# Furqan — ask the Qur’an

**Ask a question and get the Qur’an’s own words.** Furqan finds and quotes the
verified text — the Uthmani (Hafs) mushaf of the King Fahd Glorious Qur’an
Printing Complex with Marmaduke Pickthall’s translation — cited by surah and
ayah, entirely on your device. It never generates scripture.

- **Live:** https://refayethossain28.github.io/BallrzAPP/furqan/

## Why it quotes instead of generating

The obvious idea — “train an AI on the Qur’an so it can answer Islamic
questions” — produces the one thing a Qur’an app must never do. A language
model trained on scripture does not learn to answer questions; it learns to
produce text *in the style of* its corpus, and at any size you can run on a
device that includes verses that do not exist, presented in the same voice as
the real ones. (The repo’s own from-scratch model, ApexAI, is a good
demonstration: it writes convincing nineteenth-century prose and knows nothing.)

So Furqan is built the other way round. The text lives in one checksummed
file, `quran.json`; the engine can only ever return a verse by its address;
the page can only display strings from that file. “Answering” means finding
the right passages — a curated map from the questions people actually ask to
the classic verses on each subject, plus full-text search over all 6,236 ayat
in English and Arabic — and showing them with their reference so you can read
them in context. When a question is really about a *ruling*, it says so and
points you to a scholar; when a subject is not in the Qur’an at all (music,
the beard, the count of five daily prayers), it says that too instead of
dressing up a weak text match as an answer.

The optional **⚡ Explain with Fable 5** step is the only place a model writes
anything, and it is fenced: the frontier model receives the quoted verses and
is instructed to explain from those alone; its reply is then checked by the
engine — every quotation is looked up verbatim in the text, every citation is
checked to be a real address — and anything that fails is struck through with
a warning. The verses are the answer; the explanation is a convenience.

## What it does

- **Ask** — in English or Arabic. “What does the Qur’an say about patience?”
  opens with 2:153, 2:155-157, 3:200, 103:1-3 and the other classic passages;
  “الصبر” searches the Arabic with harakāt stripped and prefixes peeled, so it
  meets “بِٱلصَّبۡرِ”; “is interest forbidden?” shows 2:275-280 and 3:130 with
  the note that rulings are for scholars.
- **References** in every form people type: `2:255`, `2 255`, `Al-Kahf 10`,
  `Baqarah 285-286`, `surah 112 verse 2`, `surah yasin`, `Yusuf`, `the cow 3`,
  `ayat al-kursi`, `ayat an-nur`, `bismillah`, `the last two verses of baqarah`.
- **Topics** — ninety-odd subjects from tawhid to the environment, each with
  its leading passages. Every mapping was audited against the verse text by
  independent review passes: passages that only touched a subject in their
  last clause were dropped or demoted, and subjects whose verses need their
  history (the fighting verses, 4:34, 48:29) carry a context note.
- **Browse** — all 114 surahs in reading view, Arabic with ayah markers above
  the translation; copy a passage, read it in context, share a link.
- **Verse of the day** from a curated list, deterministic per day.
- **Offline PWA** — the whole Qur’an and the index run on the device after the
  first load; the text file is network-first so a corrected build reaches you.

## Honesty rules the page keeps

1. Every verse shown is a string from `quran.json`, by (surah, ayah) address.
2. The file is checked on load: 114 surahs, 6,236 ayat, no empty verse; its
   SHA-256 is shown on the About tab and reproducible with the builder.
3. No rulings. Questions phrased as “is X haram/allowed/a sin” get the verses
   on the subject *and* a note that a ruling needs a qualified scholar.
4. Subjects the Qur’an does not address directly get a note saying so, and
   only general principles, never a weak keyword match.
5. A message that reads like distress gets a support note before any verse.
6. The Live AI explanation is verified word by word; its unverifiable quotes
   and bad citations are struck through, and the page tells you to trust the
   verses, not the summary.

## Architecture

House prototype conventions:

- `engine.js` — **everything that is a rule lives here**: Arabic and English
  normalisation (Uthmani small letters expanded to standard spelling as well as
  dropped; Pickthall’s “ye/thee/hath/believeth” mapped and stemmed), the BM25
  index, surah aliases and reference parsing, the topic lexicon, passage
  assembly, the scope notes, the verse of the day, the Live AI grounding
  prompt and the reply verifier. Pure functions, clock-injected, zero DOM,
  zero I/O; loads as a browser classic script, in the smoke sandbox, and via
  `module.exports`.
- `quran.json` — the verified text, built by
  `node scripts/build-furqan-corpus.mjs` from the
  [fawazahmed0/quran-api](https://github.com/fawazahmed0/quran-api) mirror
  (editions `ara-quranuthmanihaf` and `eng-mohammedmarmadu`, chapter table
  from `info.json`). The builder refuses to write unless the text is complete
  and aligned verse for verse, and records a SHA-256 over every verse.
- `index.html` — the UI: Ask / Browse / Topics / About, the Live AI toggle
  (the project’s existing Fable 5 proxy — `node llm-from-scratch/server.mjs`
  locally, the hosted function by default), the verified-explanation renderer.
- `scripts/test-furqan-logic.mjs` — `npm run test:furqan`: corpus integrity,
  normalisation, every reference form, every topic seed exists, the classic
  passages lead their topics, search relevance in both languages, the honesty
  notes, determinism, the verse of the day, the grounding prompt, and the
  verifier rejecting a fabricated quote and a bad citation.
- `scripts/gen-furqan-icons.mjs` — the icon (an open book under a rub el hizb)
  rasterised to PNG with no image libraries.

## Sources and licences

- Arabic text: King Fahd Glorious Qur’an Printing Complex, Madinah (Uthmani,
  Hafs ʿan ʿĀṣim), as distributed by the quran-api mirror.
- Translation: Marmaduke Pickthall, *The Meaning of the Glorious Koran*
  (1930). Public domain. Pickthall’s English is of its time (“ye”, “thee”);
  the engine understands modern questions against it. The Saheeh
  International translation with recitation audio is in the Qur’an studio of
  [Lingua](../lingua/); to learn the Arabic itself, see [Bayan](../bayan/).
- Arabic typeface: [Amiri Quran](https://github.com/aliftype/amiri) by Khaled
  Hosny, SIL Open Font License (`fonts/OFL.txt`), bundled because system fonts
  on many devices lack the Uthmani pause marks and small letters and would
  show gaps in the text.
- Furqan is a study aid. It is not a mufti and not a tafsir; for anything that
  matters to your life, ask a qualified scholar.
