#!/usr/bin/env node
/**
 * Build furqan/quran.json — the verified Qur'an text Furqan quotes from.
 *
 * Sources (fetched from the fawazahmed0/quran-api mirror on GitHub):
 *   • ara-quranuthmanihaf — the Uthmani (Hafs) mushaf text of the King Fahd
 *     Glorious Qur'an Printing Complex, Madinah
 *   • eng-mohammedmarmadu — Marmaduke Pickthall, "The Meaning of the Glorious
 *     Koran" (1930), public domain
 *   • info.json — the chapter table (names, revelation place, verse counts)
 *
 * The build REFUSES to write unless the text is complete and consistent:
 * 114 surahs, 6,236 ayat, every surah's verse count equal to the canonical
 * table, Arabic and English aligned verse for verse, no empty verse. The
 * output carries a SHA-256 of every verse in order, so the page can tell a
 * tampered or truncated file from the real one. Furqan's engine and page
 * never generate scripture — they only ever quote strings from this file.
 *
 *   node scripts/build-furqan-corpus.mjs            # -> furqan/quran.json
 *   node scripts/build-furqan-corpus.mjs --from DIR # use already-downloaded edition files
 *
 * Zero dependencies — Node built-ins only.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'furqan', 'quran.json');
const BASE = 'https://raw.githubusercontent.com/fawazahmed0/quran-api/1/';
const FILES = {
  arabic: 'editions/ara-quranuthmanihaf.json',
  english: 'editions/eng-mohammedmarmadu.json',
  info: 'info.json',
};

const argv = process.argv.slice(2);
let fromDir = null;
for (let i = 0; i < argv.length; i++) if (argv[i] === '--from') fromDir = argv[++i];

async function fetchJSON(rel) {
  const cacheDir = fromDir || join(tmpdir(), 'furqan-raw');
  const local = join(cacheDir, rel.replace(/\//g, '_'));
  if (existsSync(local)) return JSON.parse(readFileSync(local, 'utf8'));
  if (fromDir) throw new Error(`missing ${local}`);
  const res = await fetch(BASE + rel);
  if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
  const text = await res.text();
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(local, text);
  return JSON.parse(text);
}

const [ar, en, info] = await Promise.all([fetchJSON(FILES.arabic), fetchJSON(FILES.english), fetchJSON(FILES.info)]);

// The canonical shape of the mushaf: 114 surahs, 6,236 ayat.
const chapters = info.chapters;
if (!Array.isArray(chapters) || chapters.length !== 114) throw new Error(`expected 114 chapters, got ${chapters && chapters.length}`);
const counts = chapters.map((c) => c.verses.length);
const total = counts.reduce((a, b) => a + b, 0);
if (total !== 6236) throw new Error(`expected 6236 ayat, chapter table has ${total}`);

// Index both editions by "chapter:verse" and check alignment.
function byRef(edition, label) {
  const m = new Map();
  for (const q of edition.quran) {
    if (!q || typeof q.text !== 'string') throw new Error(`${label}: malformed entry`);
    const key = `${q.chapter}:${q.verse}`;
    if (m.has(key)) throw new Error(`${label}: duplicate ${key}`);
    m.set(key, q.text.replace(/\s+/g, ' ').trim());
  }
  if (m.size !== 6236) throw new Error(`${label}: ${m.size} verses, expected 6236`);
  return m;
}
const arMap = byRef(ar, 'arabic'), enMap = byRef(en, 'english');

const hash = createHash('sha256');
const surahs = [];
for (const c of chapters) {
  const n = c.chapter;
  const ayat = [];
  const sajda = [];
  for (const v of c.verses) {
    const key = `${n}:${v.verse}`;
    const a = arMap.get(key), e = enMap.get(key);
    if (!a || !e) throw new Error(`missing verse ${key} (${a ? '' : 'arabic '}${e ? '' : 'english'})`);
    if (v.verse !== ayat.length + 1) throw new Error(`verse numbering gap at ${key}`);
    ayat.push([a, e]);
    if (v.sajda) sajda.push(v.verse);
    hash.update(`${key}\u0001${a}\u0001${e}\n`);
  }
  if (ayat.length !== counts[n - 1]) throw new Error(`surah ${n}: ${ayat.length} ayat, table says ${counts[n - 1]}`);
  surahs.push({
    n, name: c.name, en: c.englishname, ar: c.arabicname, rev: c.revelation,
    juz: c.verses[0].juz, page: c.verses[0].page, ...(sajda.length ? { sajda } : {}), ayat,
  });
}

const out = {
  meta: {
    built: new Date().toISOString().slice(0, 10),
    text: 'Uthmani script, Hafs reading — King Fahd Glorious Qur’an Printing Complex, Madinah',
    translation: 'Marmaduke Pickthall, The Meaning of the Glorious Koran (1930, public domain)',
    source: 'github.com/fawazahmed0/quran-api (editions ara-quranuthmanihaf, eng-mohammedmarmadu; info.json chapter table)',
    surahs: 114, verses: 6236, sha256: hash.digest('hex'),
  },
  surahs,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out));
const size = readFileSync(OUT).length;
console.log(`wrote ${OUT}: 114 surahs, 6236 ayat, ${(size / 1e6).toFixed(2)} MB, sha256 ${out.meta.sha256.slice(0, 16)}…`);
