/* Bayan — the pure Classical Arabic teaching engine.
 * =====================================================================
 * Bayan (بَيَان — "clarity, eloquence") teaches Classical Arabic — الفصحى,
 * the Arabic of the Qurʾān, classical poetry and a millennium of prose —
 * from the first letter to real glossed texts. Every rule of the course
 * lives HERE as pure, deterministic, clock-injected functions with zero
 * DOM and zero I/O: the curriculum data (alphabet, ḥarakāt, vocabulary,
 * ṣarf tables, naḥw lessons, reader texts), the seeded quiz builders,
 * the SM-2-style spaced-repetition scheduler, streaks, XP and the
 * course path — unit-tested in scripts/test-bayan-logic.mjs, rendered
 * by index.html.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

  var SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

  /* ---------------- deterministic hashing / seeded randomness ---------------- */

  // FNV-1a 32-bit — stable across platforms, good spread for short strings.
  function hashStr(s) {
    var h = 0x811c9dc5;
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  // One deterministic float in [0,1) from any seed string.
  function rand01(seed) {
    var h = hashStr(seed);
    h ^= h << 13; h >>>= 0;
    h ^= h >> 17;
    h ^= h << 5; h >>>= 0;
    return (h >>> 0) / 4294967296;
  }

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Seeded Fisher–Yates — same seed, same order, any realm.
  function seededShuffle(arr, seed) {
    var out = (arr || []).slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(rand01(seed + ':' + i) * (i + 1));
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  function pickN(arr, n, seed) {
    return seededShuffle(arr, seed).slice(0, Math.max(0, n | 0));
  }

  /* ---------------- Arabic text: stripping, folding, matching ---------------- */

  // Tashkīl and friends: tanwīn..sukūn, superscript alif, plus tatweel.
  var TASHKIL_RE = /[\u064B-\u065F\u0670\u0640]/g;

  function stripTashkil(s) {
    return String(s == null ? '' : s).replace(TASHKIL_RE, '');
  }

  // Fold for matching/search: drop vowels, unify alif and yāʾ variants.
  function normalizeAr(s) {
    return stripTashkil(s)
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/ى/g, 'ي');
  }

  function arEq(a, b) { return normalizeAr(a) === normalizeAr(b); }

  // Fold a transliteration for search: ā→a, ḥ→h, ʿ/ʾ dropped, lowercase.
  function translitFold(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/ā/g, 'a').replace(/ī/g, 'i').replace(/ū/g, 'u')
      .replace(/ḥ/g, 'h').replace(/ṣ/g, 's').replace(/ḍ/g, 'd')
      .replace(/ṭ/g, 't').replace(/ẓ/g, 'z')
      .replace(/[ʿʾ''-]/g, '');
  }

  /* =====================================================================
   * CURRICULUM DATA — authored and adversarially verified.
   * Orthography: modern typographic (imlāʾī) Arabic, fully vocalized.
   * ===================================================================== */

  var LETTERS = /*@DATA:LETTERS*/[
   {
    "id": "alif",
    "ar": "ا",
    "name": "أَلِف",
    "nameEn": "Alif",
    "translit": "ā",
    "sound": "long 'aa' as in 'father'",
    "isolated": "ا",
    "initial": "ا",
    "medial": "ـا",
    "final": "ـا",
    "connects": false,
    "sun": false,
    "makhraj": "the open mouth and throat — a pure long vowel with no constriction",
    "example": {
     "ar": "آمَنَ",
     "translit": "āmana",
     "en": "he believed"
    }
   },
   {
    "id": "ba",
    "ar": "ب",
    "name": "بَاء",
    "nameEn": "Bāʾ",
    "translit": "b",
    "sound": "b as in book",
    "isolated": "ب",
    "initial": "بـ",
    "medial": "ـبـ",
    "final": "ـب",
    "connects": true,
    "sun": false,
    "makhraj": "both lips pressed together",
    "example": {
     "ar": "بَاب",
     "translit": "bāb",
     "en": "door"
    }
   },
   {
    "id": "ta",
    "ar": "ت",
    "name": "تَاء",
    "nameEn": "Tāʾ",
    "translit": "t",
    "sound": "t as in tea — light, with no heaviness",
    "isolated": "ت",
    "initial": "تـ",
    "medial": "ـتـ",
    "final": "ـت",
    "connects": true,
    "sun": true,
    "makhraj": "tip of the tongue against the ridge behind the upper front teeth",
    "example": {
     "ar": "تِين",
     "translit": "tīn",
     "en": "fig"
    }
   },
   {
    "id": "tha",
    "ar": "ث",
    "name": "ثَاء",
    "nameEn": "Thāʾ",
    "translit": "th",
    "sound": "th as in think",
    "isolated": "ث",
    "initial": "ثـ",
    "medial": "ـثـ",
    "final": "ـث",
    "connects": true,
    "sun": true,
    "makhraj": "tip of the tongue lightly between the front teeth",
    "example": {
     "ar": "ثَوْب",
     "translit": "thawb",
     "en": "garment"
    }
   },
   {
    "id": "jim",
    "ar": "ج",
    "name": "جِيم",
    "nameEn": "Jīm",
    "translit": "j",
    "sound": "j as in jam",
    "isolated": "ج",
    "initial": "جـ",
    "medial": "ـجـ",
    "final": "ـج",
    "connects": true,
    "sun": false,
    "makhraj": "middle of the tongue against the roof of the mouth",
    "example": {
     "ar": "جَنَّة",
     "translit": "janna",
     "en": "garden; Paradise"
    }
   },
   {
    "id": "hha",
    "ar": "ح",
    "name": "حَاء",
    "nameEn": "Ḥāʾ",
    "translit": "ḥ",
    "sound": "a strong, breathy 'h' whispered from the middle of the throat — no rasp or gargle",
    "isolated": "ح",
    "initial": "حـ",
    "medial": "ـحـ",
    "final": "ـح",
    "connects": true,
    "sun": false,
    "makhraj": "middle of the throat",
    "example": {
     "ar": "حَمْد",
     "translit": "ḥamd",
     "en": "praise"
    }
   },
   {
    "id": "kha",
    "ar": "خ",
    "name": "خَاء",
    "nameEn": "Khāʾ",
    "translit": "kh",
    "sound": "ch as in Scottish 'loch' or German 'Bach'",
    "isolated": "خ",
    "initial": "خـ",
    "medial": "ـخـ",
    "final": "ـخ",
    "connects": true,
    "sun": false,
    "makhraj": "upper part of the throat, near the uvula — with friction",
    "example": {
     "ar": "خَيْر",
     "translit": "khayr",
     "en": "good, goodness"
    }
   },
   {
    "id": "dal",
    "ar": "د",
    "name": "دَال",
    "nameEn": "Dāl",
    "translit": "d",
    "sound": "d as in door",
    "isolated": "د",
    "initial": "د",
    "medial": "ـد",
    "final": "ـد",
    "connects": false,
    "sun": true,
    "makhraj": "tip of the tongue against the ridge behind the upper front teeth",
    "example": {
     "ar": "دِين",
     "translit": "dīn",
     "en": "religion"
    }
   },
   {
    "id": "dhal",
    "ar": "ذ",
    "name": "ذَال",
    "nameEn": "Dhāl",
    "translit": "dh",
    "sound": "th as in this",
    "isolated": "ذ",
    "initial": "ذ",
    "medial": "ـذ",
    "final": "ـذ",
    "connects": false,
    "sun": true,
    "makhraj": "tip of the tongue between the front teeth",
    "example": {
     "ar": "ذَهَب",
     "translit": "dhahab",
     "en": "gold"
    }
   },
   {
    "id": "ra",
    "ar": "ر",
    "name": "رَاء",
    "nameEn": "Rāʾ",
    "translit": "r",
    "sound": "rolled r, as in Spanish 'perro'",
    "isolated": "ر",
    "initial": "ر",
    "medial": "ـر",
    "final": "ـر",
    "connects": false,
    "sun": true,
    "makhraj": "tip of the tongue tapping the ridge behind the upper front teeth",
    "example": {
     "ar": "رَحْمَة",
     "translit": "raḥma",
     "en": "mercy"
    }
   },
   {
    "id": "zay",
    "ar": "ز",
    "name": "زَاي",
    "nameEn": "Zāy",
    "translit": "z",
    "sound": "z as in zoo",
    "isolated": "ز",
    "initial": "ز",
    "medial": "ـز",
    "final": "ـز",
    "connects": false,
    "sun": true,
    "makhraj": "tip of the tongue near the lower front teeth",
    "example": {
     "ar": "زَيْتُون",
     "translit": "zaytūn",
     "en": "olive, olives"
    }
   },
   {
    "id": "sin",
    "ar": "س",
    "name": "سِين",
    "nameEn": "Sīn",
    "translit": "s",
    "sound": "s as in sun",
    "isolated": "س",
    "initial": "سـ",
    "medial": "ـسـ",
    "final": "ـس",
    "connects": true,
    "sun": true,
    "makhraj": "tip of the tongue near the lower front teeth",
    "example": {
     "ar": "سَلَام",
     "translit": "salām",
     "en": "peace"
    }
   },
   {
    "id": "shin",
    "ar": "ش",
    "name": "شِين",
    "nameEn": "Shīn",
    "translit": "sh",
    "sound": "sh as in ship",
    "isolated": "ش",
    "initial": "شـ",
    "medial": "ـشـ",
    "final": "ـش",
    "connects": true,
    "sun": true,
    "makhraj": "middle of the tongue raised toward the roof of the mouth",
    "example": {
     "ar": "شَمْس",
     "translit": "shams",
     "en": "sun"
    }
   },
   {
    "id": "sad",
    "ar": "ص",
    "name": "صَاد",
    "nameEn": "Ṣād",
    "translit": "ṣ",
    "sound": "emphatic s: a heavy 's' made with the back of the tongue raised — it darkens the vowels around it",
    "isolated": "ص",
    "initial": "صـ",
    "medial": "ـصـ",
    "final": "ـص",
    "connects": true,
    "sun": true,
    "makhraj": "tip of the tongue near the lower front teeth, with the back of the tongue raised",
    "example": {
     "ar": "صَبْر",
     "translit": "ṣabr",
     "en": "patience"
    }
   },
   {
    "id": "dad",
    "ar": "ض",
    "name": "ضَاد",
    "nameEn": "Ḍād",
    "translit": "ḍ",
    "sound": "emphatic d: a heavy 'd' with the tongue tensed and raised — it darkens the vowels around it",
    "isolated": "ض",
    "initial": "ضـ",
    "medial": "ـضـ",
    "final": "ـض",
    "connects": true,
    "sun": true,
    "makhraj": "side of the tongue pressed against the upper molars",
    "example": {
     "ar": "ضَرَبَ",
     "translit": "ḍaraba",
     "en": "he struck"
    }
   },
   {
    "id": "tta",
    "ar": "ط",
    "name": "طَاء",
    "nameEn": "Ṭāʾ",
    "translit": "ṭ",
    "sound": "emphatic t: a heavy 't' with no puff of air, back of the tongue raised — it darkens the vowels around it",
    "isolated": "ط",
    "initial": "طـ",
    "medial": "ـطـ",
    "final": "ـط",
    "connects": true,
    "sun": true,
    "makhraj": "tip of the tongue against the ridge behind the upper front teeth, with the back of the tongue raised",
    "example": {
     "ar": "طَرِيق",
     "translit": "ṭarīq",
     "en": "road, way"
    }
   },
   {
    "id": "zzha",
    "ar": "ظ",
    "name": "ظَاء",
    "nameEn": "Ẓāʾ",
    "translit": "ẓ",
    "sound": "emphatic 'th' of 'this': heavy, with the back of the tongue raised — it darkens the vowels around it",
    "isolated": "ظ",
    "initial": "ظـ",
    "medial": "ـظـ",
    "final": "ـظ",
    "connects": true,
    "sun": true,
    "makhraj": "tip of the tongue between the front teeth, with the back of the tongue raised",
    "example": {
     "ar": "ظِلّ",
     "translit": "ẓill",
     "en": "shade"
    }
   },
   {
    "id": "ayn",
    "ar": "ع",
    "name": "عَيْن",
    "nameEn": "ʿAyn",
    "translit": "ʿ",
    "sound": "a voiced squeeze of the throat — start the 'a' of 'father' and tighten the throat around it; no true English equivalent",
    "isolated": "ع",
    "initial": "عـ",
    "medial": "ـعـ",
    "final": "ـع",
    "connects": true,
    "sun": false,
    "makhraj": "middle of the throat, constricted",
    "example": {
     "ar": "عِلْم",
     "translit": "ʿilm",
     "en": "knowledge"
    }
   },
   {
    "id": "ghayn",
    "ar": "غ",
    "name": "غَيْن",
    "nameEn": "Ghayn",
    "translit": "gh",
    "sound": "a soft gargled 'g', like the French 'r' in 'Paris'",
    "isolated": "غ",
    "initial": "غـ",
    "medial": "ـغـ",
    "final": "ـغ",
    "connects": true,
    "sun": false,
    "makhraj": "upper part of the throat, near the uvula",
    "example": {
     "ar": "غَيْب",
     "translit": "ghayb",
     "en": "the unseen"
    }
   },
   {
    "id": "fa",
    "ar": "ف",
    "name": "فَاء",
    "nameEn": "Fāʾ",
    "translit": "f",
    "sound": "f as in fish",
    "isolated": "ف",
    "initial": "فـ",
    "medial": "ـفـ",
    "final": "ـف",
    "connects": true,
    "sun": false,
    "makhraj": "lower lip against the upper front teeth",
    "example": {
     "ar": "فَجْر",
     "translit": "fajr",
     "en": "dawn"
    }
   },
   {
    "id": "qaf",
    "ar": "ق",
    "name": "قَاف",
    "nameEn": "Qāf",
    "translit": "q",
    "sound": "a deep 'k' from the very back of the throat, at the uvula",
    "isolated": "ق",
    "initial": "قـ",
    "medial": "ـقـ",
    "final": "ـق",
    "connects": true,
    "sun": false,
    "makhraj": "back of the tongue against the uvula",
    "example": {
     "ar": "قَلْب",
     "translit": "qalb",
     "en": "heart"
    }
   },
   {
    "id": "kaf",
    "ar": "ك",
    "name": "كَاف",
    "nameEn": "Kāf",
    "translit": "k",
    "sound": "k as in kite",
    "isolated": "ك",
    "initial": "كـ",
    "medial": "ـكـ",
    "final": "ـك",
    "connects": true,
    "sun": false,
    "makhraj": "back of the tongue against the soft palate",
    "example": {
     "ar": "كِتَاب",
     "translit": "kitāb",
     "en": "book"
    }
   },
   {
    "id": "lam",
    "ar": "ل",
    "name": "لَام",
    "nameEn": "Lām",
    "translit": "l",
    "sound": "l as in lamp",
    "isolated": "ل",
    "initial": "لـ",
    "medial": "ـلـ",
    "final": "ـل",
    "connects": true,
    "sun": true,
    "makhraj": "front of the tongue against the ridge behind the upper front teeth",
    "example": {
     "ar": "لَيْل",
     "translit": "layl",
     "en": "night"
    }
   },
   {
    "id": "mim",
    "ar": "م",
    "name": "مِيم",
    "nameEn": "Mīm",
    "translit": "m",
    "sound": "m as in moon",
    "isolated": "م",
    "initial": "مـ",
    "medial": "ـمـ",
    "final": "ـم",
    "connects": true,
    "sun": false,
    "makhraj": "both lips together, with air through the nose",
    "example": {
     "ar": "مَلِك",
     "translit": "malik",
     "en": "king"
    }
   },
   {
    "id": "nun",
    "ar": "ن",
    "name": "نُون",
    "nameEn": "Nūn",
    "translit": "n",
    "sound": "n as in noon",
    "isolated": "ن",
    "initial": "نـ",
    "medial": "ـنـ",
    "final": "ـن",
    "connects": true,
    "sun": true,
    "makhraj": "tip of the tongue against the ridge behind the upper front teeth, with air through the nose",
    "example": {
     "ar": "نُور",
     "translit": "nūr",
     "en": "light"
    }
   },
   {
    "id": "ha",
    "ar": "ه",
    "name": "هَاء",
    "nameEn": "Hāʾ",
    "translit": "h",
    "sound": "h as in house, kept light and clear even between vowels",
    "isolated": "ه",
    "initial": "هـ",
    "medial": "ـهـ",
    "final": "ـه",
    "connects": true,
    "sun": false,
    "makhraj": "deepest part of the throat",
    "example": {
     "ar": "هُدَى",
     "translit": "hudā",
     "en": "guidance"
    }
   },
   {
    "id": "waw",
    "ar": "و",
    "name": "وَاو",
    "nameEn": "Wāw",
    "translit": "w",
    "sound": "w as in water (also the long vowel 'ū' as in 'moon')",
    "isolated": "و",
    "initial": "و",
    "medial": "ـو",
    "final": "ـو",
    "connects": false,
    "sun": false,
    "makhraj": "rounded lips",
    "example": {
     "ar": "وَحْي",
     "translit": "waḥy",
     "en": "revelation"
    }
   },
   {
    "id": "ya",
    "ar": "ي",
    "name": "يَاء",
    "nameEn": "Yāʾ",
    "translit": "y",
    "sound": "y as in yes (also the long vowel 'ī' as in 'machine')",
    "isolated": "ي",
    "initial": "يـ",
    "medial": "ـيـ",
    "final": "ـي",
    "connects": true,
    "sun": false,
    "makhraj": "middle of the tongue raised toward the roof of the mouth",
    "example": {
     "ar": "يَوْم",
     "translit": "yawm",
     "en": "day"
    }
   },
   {
    "id": "hamza",
    "ar": "ء",
    "name": "هَمْزَة",
    "nameEn": "Hamza",
    "translit": "ʾ",
    "sound": "the glottal stop: the catch in the middle of 'uh-oh'",
    "isolated": "ء",
    "initial": "ء",
    "medial": "ء",
    "final": "ء",
    "connects": false,
    "sun": false,
    "makhraj": "deepest part of the throat — the vocal cords close and release",
    "example": {
     "ar": "سَمَاء",
     "translit": "samāʾ",
     "en": "sky, heaven"
    }
   }
  ];

  var MARKS = /*@DATA:MARKS*/[
   {
    "id": "fatha",
    "symbol": "َ",
    "display": "بَ",
    "name": "فَتْحَة",
    "nameEn": "Fatḥa",
    "makes": "short a",
    "desc": "A short diagonal stroke above the letter, giving the short vowel a. Read it in the same beat as its consonant: بَ is one quick syllable, ba.",
    "example": {
     "ar": "كَتَبَ",
     "translit": "kataba",
     "en": "he wrote"
    }
   },
   {
    "id": "damma",
    "symbol": "ُ",
    "display": "بُ",
    "name": "ضَمَّة",
    "nameEn": "Ḍamma",
    "makes": "short u",
    "desc": "A miniature wāw written above the letter, giving the short vowel u. Do not stretch it: بُ is a single quick bu, never bū.",
    "example": {
     "ar": "كُتُب",
     "translit": "kutub",
     "en": "books"
    }
   },
   {
    "id": "kasra",
    "symbol": "ِ",
    "display": "بِ",
    "name": "كَسْرَة",
    "nameEn": "Kasra",
    "makes": "short i",
    "desc": "A short diagonal stroke below the letter, giving the short vowel i — the only one of the three short-vowel marks written underneath. Its low position is your cue: the i sound dips below the line.",
    "example": {
     "ar": "عِلْم",
     "translit": "ʿilm",
     "en": "knowledge"
    }
   },
   {
    "id": "sukun",
    "symbol": "ْ",
    "display": "بْ",
    "name": "سُكُون",
    "nameEn": "Sukūn",
    "makes": "no vowel",
    "desc": "A small circle showing the consonant carries no vowel, closing its syllable. In يَكْتُبُ the kāf with sukūn ends the first syllable: yak-tu-bu.",
    "example": {
     "ar": "يَكْتُبُ",
     "translit": "yaktubu",
     "en": "he writes"
    }
   },
   {
    "id": "shadda",
    "symbol": "ّ",
    "display": "بّ",
    "name": "شَدَّة",
    "nameEn": "Shadda",
    "makes": "doubles the consonant",
    "desc": "A small w-shaped sign showing the consonant is doubled: hold it twice as long, then read the vowel written with the shadda. Practice by splitting the word at the doubled letter: مُعَلِّم is muʿal-lim.",
    "example": {
     "ar": "مُعَلِّم",
     "translit": "muʿallim",
     "en": "teacher"
    }
   },
   {
    "id": "tanwin-fath",
    "symbol": "ً",
    "display": "بًا",
    "name": "تَنْوِينُ الْفَتْحِ",
    "nameEn": "Tanwīn al-Fatḥ",
    "makes": "-an ending",
    "desc": "A double fatḥa on the end of an indefinite noun, pronounced -an; it marks the accusative case. It usually rides on an extra silent alif (كِتَابًا), except after tāʾ marbūṭa (مَدِينَةً) and after a hamza preceded by alif (سَمَاءً) or seated on alif (خَطَأً).",
    "example": {
     "ar": "قَرَأْتُ كِتَابًا",
     "translit": "qaraʾtu kitāban",
     "en": "I read a book"
    }
   },
   {
    "id": "tanwin-damm",
    "symbol": "ٌ",
    "display": "بٌ",
    "name": "تَنْوِينُ الضَّمِّ",
    "nameEn": "Tanwīn aḍ-Ḍamm",
    "makes": "-un ending",
    "desc": "A double ḍamma on the end of an indefinite noun, pronounced -un; it marks the nominative case. Remember that tanwīn and the definite article never combine: الْكِتَابُ takes a single ḍamma.",
    "example": {
     "ar": "هَذَا كِتَابٌ",
     "translit": "hādhā kitābun",
     "en": "this is a book"
    }
   },
   {
    "id": "tanwin-kasr",
    "symbol": "ٍ",
    "display": "بٍ",
    "name": "تَنْوِينُ الْكَسْرِ",
    "nameEn": "Tanwīn al-Kasr",
    "makes": "-in ending",
    "desc": "A double kasra under the last letter of an indefinite noun, pronounced -in; it marks the genitive case, so expect it after prepositions. Train your ear on pairs like fī baytin, min rajulin.",
    "example": {
     "ar": "فِي بَيْتٍ كَبِيرٍ",
     "translit": "fī baytin kabīrin",
     "en": "in a big house"
    }
   },
   {
    "id": "long-alif",
    "symbol": "ا",
    "display": "بَا",
    "name": "أَلِفُ الْمَدِّ",
    "nameEn": "Alif al-Madd",
    "makes": "long ā",
    "desc": "An alif after a consonant carrying fatḥa stretches the sound into long ā, held about twice as long as a fatḥa. The alif itself takes no mark — the fatḥa before it is what tells you the vowel.",
    "example": {
     "ar": "كِتَاب",
     "translit": "kitāb",
     "en": "book"
    }
   },
   {
    "id": "long-waw",
    "symbol": "و",
    "display": "بُو",
    "name": "وَاوُ الْمَدِّ",
    "nameEn": "Wāw al-Madd",
    "makes": "long ū",
    "desc": "An unmarked wāw after a consonant carrying ḍamma gives long ū, as in nūr. If the wāw bears its own vowel sign, read it as the consonant w instead — the preceding ḍamma is what signals lengthening.",
    "example": {
     "ar": "نُور",
     "translit": "nūr",
     "en": "light"
    }
   },
   {
    "id": "long-ya",
    "symbol": "ي",
    "display": "بِي",
    "name": "يَاءُ الْمَدِّ",
    "nameEn": "Yāʾ al-Madd",
    "makes": "long ī",
    "desc": "An unmarked yāʾ after a consonant carrying kasra gives long ī, as in karīm. Kasra plus bare yāʾ = ī; if the yāʾ carries a vowel of its own, read it as the consonant y.",
    "example": {
     "ar": "كَرِيم",
     "translit": "karīm",
     "en": "generous"
    }
   },
   {
    "id": "madda",
    "symbol": "آ",
    "display": "آ",
    "name": "مَدَّة",
    "nameEn": "Madda",
    "makes": "ʾā (hamza + long ā)",
    "desc": "A wavy sign over alif (آ) packing hamza plus long ā into one letter, so آمَنَ reads āmana. Whenever hamza would be followed by ā, Arabic writes آ instead of أَا.",
    "example": {
     "ar": "الْقُرْآن",
     "translit": "al-Qurʾān",
     "en": "the Quran"
    }
   },
   {
    "id": "ta-marbuta",
    "symbol": "ة",
    "display": "ة",
    "name": "تَاء مَرْبُوطَة",
    "nameEn": "Tāʾ Marbūṭa",
    "makes": "-a / -at",
    "desc": "The 'tied' tāʾ ending most feminine nouns and adjectives. In pause read it simply as -a (madīna); when an ending or a following word attaches, it opens into t: madīnatun, madīnatu n-nabiyyi.",
    "example": {
     "ar": "مَدِينَة",
     "translit": "madīna",
     "en": "city"
    }
   },
   {
    "id": "alif-maqsura",
    "symbol": "ى",
    "display": "ى",
    "name": "أَلِف مَقْصُورَة",
    "nameEn": "Alif Maqṣūra",
    "makes": "word-final ā",
    "desc": "An alif written in the shape of a dotless yāʾ (ى), appearing only at the end of a word and pronounced exactly like long ā. Tell it apart from yāʾ by its missing dots: رَمَى ends in ā, not ī.",
    "example": {
     "ar": "رَمَى",
     "translit": "ramā",
     "en": "he threw"
    }
   },
   {
    "id": "hamzat-wasl",
    "symbol": "ا",
    "display": "ال",
    "name": "هَمْزَةُ الْوَصْلِ",
    "nameEn": "Hamzat al-Waṣl",
    "makes": "elidable initial vowel",
    "desc": "The connecting alif that begins the article ال and words like اِسْم and اِبْن: it is voiced only at the start of speech and drops its sound mid-sentence. So الْبَيْت alone begins with al-, but فِي الْبَيْتِ reads fī l-bayti, the alif silent.",
    "example": {
     "ar": "فِي الْبَيْتِ",
     "translit": "fī l-bayti",
     "en": "in the house"
    }
   }
  ];

  var UNITS = /*@DATA:UNITS*/[
   {
    "id": "u1",
    "title": "Faith & the Divine",
    "titleAr": "كَلِمَاتُ الْإِيمَانِ",
    "icon": "🕌",
    "intro": "These words carry the Qur'an's central message — God, revelation, and the hereafter — and together they account for many thousands of occurrences in the text.",
    "words": [
     {
      "ar": "اللَّه",
      "translit": "Allāh",
      "en": "God, Allah",
      "root": "أ ل ه",
      "pos": "noun",
      "note": "the proper name of God; with لِ it fuses: لِلَّهِ li-llāhi 'to God'"
     },
     {
      "ar": "رَبّ",
      "translit": "rabb",
      "en": "lord, master, sustainer",
      "root": "ر ب ب",
      "pos": "noun",
      "note": "pl. أَرْبَاب arbāb; رَبُّ الْعَالَمِينَ rabbu l-ʿālamīna 'Lord of the worlds'"
     },
     {
      "ar": "إِلَه",
      "translit": "ilāh",
      "en": "god, deity",
      "root": "أ ل ه",
      "pos": "noun",
      "note": "pl. آلِهَة āliha; لَا إِلَهَ إِلَّا اللَّهُ lā ilāha illā llāhu"
     },
     {
      "ar": "رَسُول",
      "translit": "rasūl",
      "en": "messenger",
      "root": "ر س ل",
      "pos": "noun",
      "note": "pl. رُسُل rusul; from أَرْسَلَ arsala 'to send'"
     },
     {
      "ar": "نَبِيّ",
      "translit": "nabiyy",
      "en": "prophet",
      "root": "ن ب أ",
      "pos": "noun",
      "note": "pl. أَنْبِيَاء anbiyāʾ; related to نَبَأ nabaʾ 'tidings'"
     },
     {
      "ar": "مَلَك",
      "translit": "malak",
      "en": "angel",
      "root": "أ ل ك",
      "pos": "noun",
      "note": "pl. مَلَائِكَة malāʾika; classically derived from مَلْأَك malʾak"
     },
     {
      "ar": "جَنَّة",
      "translit": "janna",
      "en": "garden; Paradise",
      "root": "ج ن ن",
      "pos": "noun",
      "note": "pl. جَنَّات jannāt; literally a garden that 'covers' with shade"
     },
     {
      "ar": "نَار",
      "translit": "nār",
      "en": "fire; Hellfire",
      "root": "ن و ر",
      "pos": "noun",
      "note": "feminine; pl. نِيرَان nīrān"
     },
     {
      "ar": "صَلَاة",
      "translit": "ṣalāh",
      "en": "ritual prayer",
      "root": "ص ل و",
      "pos": "noun",
      "note": "pl. صَلَوَات ṣalawāt; أَقَامَ الصَّلَاةَ aqāma ṣ-ṣalāta 'he performed the prayer'"
     },
     {
      "ar": "قُرْآن",
      "translit": "qurʾān",
      "en": "Qur'an; recitation",
      "root": "ق ر أ",
      "pos": "noun",
      "note": "verbal noun of قَرَأَ qaraʾa 'to recite'"
     },
     {
      "ar": "آيَة",
      "translit": "āya",
      "en": "sign; verse of the Qur'an",
      "root": "أ ي ي",
      "pos": "noun",
      "note": "pl. آيَات āyāt; every wonder of creation is an āya"
     },
     {
      "ar": "دِين",
      "translit": "dīn",
      "en": "religion; judgment",
      "root": "د ي ن",
      "pos": "noun",
      "note": "pl. أَدْيَان adyān; يَوْمُ الدِّينِ yawmu d-dīni 'the Day of Judgment'"
     },
     {
      "ar": "إِيمَان",
      "translit": "īmān",
      "en": "faith, belief",
      "root": "أ م ن",
      "pos": "noun",
      "note": "verbal noun of آمَنَ āmana 'to believe' (with بِ)"
     },
     {
      "ar": "حَقّ",
      "translit": "ḥaqq",
      "en": "truth; right",
      "root": "ح ق ق",
      "pos": "noun",
      "note": "pl. حُقُوق ḥuqūq; opposite of بَاطِل bāṭil 'falsehood'"
     }
    ]
   },
   {
    "id": "u2",
    "title": "People & Family",
    "titleAr": "النَّاسُ وَالْأَهْلُ",
    "icon": "👪",
    "intro": "Classical narrative, law, and scripture all revolve around people, so mastering these kinship and 'people' words makes the cast of every story transparent.",
    "words": [
     {
      "ar": "إِنْسَان",
      "translit": "insān",
      "en": "human being",
      "root": "أ ن س",
      "pos": "noun",
      "note": "the plural in use is the suppletive النَّاس an-nās"
     },
     {
      "ar": "رَجُل",
      "translit": "rajul",
      "en": "man",
      "root": "ر ج ل",
      "pos": "noun",
      "note": "pl. رِجَال rijāl"
     },
     {
      "ar": "اِمْرَأَة",
      "translit": "imraʾa",
      "en": "woman",
      "root": "م ر أ",
      "pos": "noun",
      "note": "with the article: الْمَرْأَة al-marʾa; plural is the suppletive نِسَاء nisāʾ"
     },
     {
      "ar": "وَلَد",
      "translit": "walad",
      "en": "child, boy",
      "root": "و ل د",
      "pos": "noun",
      "note": "pl. أَوْلَاد awlād; from وَلَدَ walada 'to give birth'"
     },
     {
      "ar": "اِبْن",
      "translit": "ibn",
      "en": "son",
      "root": "ب ن و",
      "pos": "noun",
      "note": "pl. أَبْنَاء abnāʾ, بَنُون banūn; بْن bn between two names in a lineage"
     },
     {
      "ar": "بِنْت",
      "translit": "bint",
      "en": "daughter, girl",
      "root": "ب ن و",
      "pos": "noun",
      "note": "pl. بَنَات banāt"
     },
     {
      "ar": "أَب",
      "translit": "ab",
      "en": "father",
      "root": "أ ب و",
      "pos": "noun",
      "note": "pl. آبَاء ābāʾ; construct أَبُو abū, as in أَبُو بَكْر Abū Bakr"
     },
     {
      "ar": "أُمّ",
      "translit": "umm",
      "en": "mother",
      "root": "أ م م",
      "pos": "noun",
      "note": "pl. أُمَّهَات ummahāt"
     },
     {
      "ar": "أَخ",
      "translit": "akh",
      "en": "brother",
      "root": "أ خ و",
      "pos": "noun",
      "note": "pl. إِخْوَة ikhwa, إِخْوَان ikhwān; construct أَخُو akhū"
     },
     {
      "ar": "أُخْت",
      "translit": "ukht",
      "en": "sister",
      "root": "أ خ و",
      "pos": "noun",
      "note": "pl. أَخَوَات akhawāt"
     },
     {
      "ar": "قَوْم",
      "translit": "qawm",
      "en": "people, folk",
      "root": "ق و م",
      "pos": "noun",
      "note": "pl. أَقْوَام aqwām; in the Qur'an often a prophet's people: قَوْمُ نُوحٍ qawmu Nūḥin"
     },
     {
      "ar": "نَاس",
      "translit": "nās",
      "en": "people, mankind",
      "root": "أ ن س",
      "pos": "noun",
      "note": "almost always with the article: النَّاس an-nās"
     },
     {
      "ar": "نَفْس",
      "translit": "nafs",
      "en": "soul, self",
      "root": "ن ف س",
      "pos": "noun",
      "note": "feminine; pl. أَنْفُس anfus, نُفُوس nufūs"
     },
     {
      "ar": "عَبْد",
      "translit": "ʿabd",
      "en": "slave; servant (of God)",
      "root": "ع ب د",
      "pos": "noun",
      "note": "pl. عِبَاد ʿibād (servants of God), عَبِيد ʿabīd"
     }
    ]
   },
   {
    "id": "u3",
    "title": "The Created World",
    "titleAr": "الْعَالَمُ الْمَخْلُوقُ",
    "icon": "🌄",
    "intro": "The Qur'an constantly points to sky, earth, sea, and light as signs of God, which makes nature vocabulary among the most repeated in all of classical literature.",
    "words": [
     {
      "ar": "سَمَاء",
      "translit": "samāʾ",
      "en": "sky, heaven",
      "root": "س م و",
      "pos": "noun",
      "note": "usually feminine; pl. سَمَاوَات samāwāt"
     },
     {
      "ar": "أَرْض",
      "translit": "arḍ",
      "en": "earth, land",
      "root": "أ ر ض",
      "pos": "noun",
      "note": "feminine; pl. أَرَضُونَ araḍūn"
     },
     {
      "ar": "شَمْس",
      "translit": "shams",
      "en": "sun",
      "root": "ش م س",
      "pos": "noun",
      "note": "feminine; الشَّمْس ash-shams is the model 'sun letter' word"
     },
     {
      "ar": "قَمَر",
      "translit": "qamar",
      "en": "moon",
      "root": "ق م ر",
      "pos": "noun",
      "note": "masculine; الْقَمَر al-qamar is the model 'moon letter' word"
     },
     {
      "ar": "نَجْم",
      "translit": "najm",
      "en": "star",
      "root": "ن ج م",
      "pos": "noun",
      "note": "pl. نُجُوم nujūm"
     },
     {
      "ar": "مَاء",
      "translit": "māʾ",
      "en": "water",
      "root": "م و ه",
      "pos": "noun",
      "note": "pl. مِيَاه miyāh — the ه of the root reappears"
     },
     {
      "ar": "بَحْر",
      "translit": "baḥr",
      "en": "sea",
      "root": "ب ح ر",
      "pos": "noun",
      "note": "pl. بِحَار biḥār, أَبْحُر abḥur"
     },
     {
      "ar": "جَبَل",
      "translit": "jabal",
      "en": "mountain",
      "root": "ج ب ل",
      "pos": "noun",
      "note": "pl. جِبَال jibāl"
     },
     {
      "ar": "شَجَرَة",
      "translit": "shajara",
      "en": "tree",
      "root": "ش ج ر",
      "pos": "noun",
      "note": "collective شَجَر shajar; pl. أَشْجَار ashjār"
     },
     {
      "ar": "رِيح",
      "translit": "rīḥ",
      "en": "wind",
      "root": "ر و ح",
      "pos": "noun",
      "note": "feminine; pl. رِيَاح riyāḥ"
     },
     {
      "ar": "نُور",
      "translit": "nūr",
      "en": "light",
      "root": "ن و ر",
      "pos": "noun",
      "note": "pl. أَنْوَار anwār; مِنَ الظُّلُمَاتِ إِلَى النُّورِ 'from darkness into light'"
     },
     {
      "ar": "ظُلْمَة",
      "translit": "ẓulma",
      "en": "darkness",
      "root": "ظ ل م",
      "pos": "noun",
      "note": "in the Qur'an usually plural: ظُلُمَات ẓulumāt"
     },
     {
      "ar": "مَطَر",
      "translit": "maṭar",
      "en": "rain",
      "root": "م ط ر",
      "pos": "noun",
      "note": "pl. أَمْطَار amṭār"
     },
     {
      "ar": "نَهْر",
      "translit": "nahr",
      "en": "river",
      "root": "ن ه ر",
      "pos": "noun",
      "note": "pl. أَنْهَار anhār, as in the rivers of Paradise"
     }
    ]
   },
   {
    "id": "u4",
    "title": "Essential Verbs I",
    "titleAr": "أُمَّهَاتُ الْأَفْعَالِ",
    "icon": "⚡",
    "intro": "These fourteen verbs — led by قَالَ, the single most frequent verb in the Qur'an — carry the action of nearly every classical sentence, and each one models a pattern that hundreds of other verbs follow.",
    "words": [
     {
      "ar": "قَالَ",
      "translit": "qāla",
      "en": "he said",
      "root": "ق و ل",
      "pos": "verb",
      "note": "pres. يَقُولُ yaqūlu; the most frequent verb in the Qur'an"
     },
     {
      "ar": "كَانَ",
      "translit": "kāna",
      "en": "he was",
      "root": "ك و ن",
      "pos": "verb",
      "note": "pres. يَكُونُ yakūnu; its predicate stands in the accusative"
     },
     {
      "ar": "فَعَلَ",
      "translit": "faʿala",
      "en": "he did",
      "root": "ف ع ل",
      "pos": "verb",
      "note": "pres. يَفْعَلُ yafʿalu; source of the grammarians' pattern word فَعَلَ"
     },
     {
      "ar": "ذَهَبَ",
      "translit": "dhahaba",
      "en": "he went",
      "root": "ذ ه ب",
      "pos": "verb",
      "note": "pres. يَذْهَبُ yadhhabu; ذَهَبَ بِ dhahaba bi- 'he took away'"
     },
     {
      "ar": "جَاءَ",
      "translit": "jāʾa",
      "en": "he came",
      "root": "ج ي أ",
      "pos": "verb",
      "note": "pres. يَجِيءُ yajīʾu; جَاءَ بِ jāʾa bi- 'he brought'"
     },
     {
      "ar": "كَتَبَ",
      "translit": "kataba",
      "en": "he wrote",
      "root": "ك ت ب",
      "pos": "verb",
      "note": "pres. يَكْتُبُ yaktubu; also 'he decreed, prescribed'"
     },
     {
      "ar": "قَرَأَ",
      "translit": "qaraʾa",
      "en": "he read, recited",
      "root": "ق ر أ",
      "pos": "verb",
      "note": "pres. يَقْرَأُ yaqraʾu; the root of قُرْآن qurʾān"
     },
     {
      "ar": "عَلِمَ",
      "translit": "ʿalima",
      "en": "he knew",
      "root": "ع ل م",
      "pos": "verb",
      "note": "pres. يَعْلَمُ yaʿlamu; note the i–a vowel pattern"
     },
     {
      "ar": "سَمِعَ",
      "translit": "samiʿa",
      "en": "he heard",
      "root": "س م ع",
      "pos": "verb",
      "note": "pres. يَسْمَعُ yasmaʿu"
     },
     {
      "ar": "رَأَى",
      "translit": "raʾā",
      "en": "he saw",
      "root": "ر أ ي",
      "pos": "verb",
      "note": "pres. يَرَى yarā, irregular — the hamza drops"
     },
     {
      "ar": "دَخَلَ",
      "translit": "dakhala",
      "en": "he entered",
      "root": "د خ ل",
      "pos": "verb",
      "note": "pres. يَدْخُلُ yadkhulu"
     },
     {
      "ar": "خَرَجَ",
      "translit": "kharaja",
      "en": "he went out",
      "root": "خ ر ج",
      "pos": "verb",
      "note": "pres. يَخْرُجُ yakhruju"
     },
     {
      "ar": "أَكَلَ",
      "translit": "akala",
      "en": "he ate",
      "root": "أ ك ل",
      "pos": "verb",
      "note": "pres. يَأْكُلُ yaʾkulu"
     },
     {
      "ar": "شَرِبَ",
      "translit": "shariba",
      "en": "he drank",
      "root": "ش ر ب",
      "pos": "verb",
      "note": "pres. يَشْرَبُ yashrabu"
     }
    ]
   },
   {
    "id": "u5",
    "title": "Little Words that Rule",
    "titleAr": "حُرُوفُ الْمَعَانِي",
    "icon": "🧩",
    "intro": "Function words make up roughly a third of any Arabic text, so these particles repay their tiny size many times over on every single page.",
    "words": [
     {
      "ar": "فِي",
      "translit": "fī",
      "en": "in, within",
      "root": "—",
      "pos": "particle",
      "note": "preposition; takes the genitive"
     },
     {
      "ar": "مِنْ",
      "translit": "min",
      "en": "from, of",
      "root": "—",
      "pos": "particle",
      "note": "preposition; takes the genitive; مِنَ mina before the definite article (مِنَ الرَّجُلِ mina r-rajuli)"
     },
     {
      "ar": "إِلَى",
      "translit": "ilā",
      "en": "to, toward",
      "root": "—",
      "pos": "particle",
      "note": "with suffixes the alif becomes ي: إِلَيْهِ ilayhi 'to him'"
     },
     {
      "ar": "عَلَى",
      "translit": "ʿalā",
      "en": "on, upon; against",
      "root": "—",
      "pos": "particle",
      "note": "with suffixes: عَلَيْهِ ʿalayhi 'upon him'"
     },
     {
      "ar": "عَنْ",
      "translit": "ʿan",
      "en": "from, away from; about",
      "root": "—",
      "pos": "particle",
      "note": "preposition; takes the genitive"
     },
     {
      "ar": "مَعَ",
      "translit": "maʿa",
      "en": "with, together with",
      "root": "—",
      "pos": "noun",
      "note": "strictly a noun of accompaniment; the following word is genitive: مَعَ الرَّجُلِ maʿa r-rajuli"
     },
     {
      "ar": "عِنْدَ",
      "translit": "ʿinda",
      "en": "at, with, in the possession of",
      "root": "—",
      "pos": "particle",
      "note": "expresses possession: عِنْدِي كِتَابٌ ʿindī kitābun 'I have a book'"
     },
     {
      "ar": "بَعْدَ",
      "translit": "baʿda",
      "en": "after",
      "root": "ب ع د",
      "pos": "particle",
      "note": "adverb of time in the accusative; مِنْ بَعْدِ min baʿdi is frequent in the Qur'an"
     },
     {
      "ar": "قَبْلَ",
      "translit": "qabla",
      "en": "before",
      "root": "ق ب ل",
      "pos": "particle",
      "note": "when its complement is omitted it takes a fixed damma: مِنْ قَبْلُ min qablu 'beforehand'"
     },
     {
      "ar": "وَ",
      "translit": "wa-",
      "en": "and",
      "root": "—",
      "pos": "particle",
      "note": "written joined to the next word; also swears oaths: وَاللَّهِ wa-llāhi 'by God!'"
     },
     {
      "ar": "فَ",
      "translit": "fa-",
      "en": "and then, so",
      "root": "—",
      "pos": "particle",
      "note": "written joined to the next word; implies sequence or consequence"
     },
     {
      "ar": "لَا",
      "translit": "lā",
      "en": "no; not",
      "root": "—",
      "pos": "particle",
      "note": "negates the present; absolute negation takes the accusative: لَا إِلَهَ إِلَّا اللَّهُ lā ilāha illā llāhu"
     },
     {
      "ar": "مَا",
      "translit": "mā",
      "en": "what; not",
      "root": "—",
      "pos": "particle",
      "note": "interrogative/relative 'what', or negates the past: مَا فَعَلَ mā faʿala 'he did not do'"
     },
     {
      "ar": "إِنَّ",
      "translit": "inna",
      "en": "indeed, verily",
      "root": "—",
      "pos": "particle",
      "note": "puts its noun in the accusative: إِنَّ اللَّهَ غَفُورٌ inna llāha ghafūrun"
     },
     {
      "ar": "كُلّ",
      "translit": "kull",
      "en": "every, all (of)",
      "root": "ك ل ل",
      "pos": "noun",
      "note": "followed by a genitive: كُلُّ نَفْسٍ kullu nafsin 'every soul'"
     },
     {
      "ar": "بَعْض",
      "translit": "baʿḍ",
      "en": "some (of), part (of)",
      "root": "ب ع ض",
      "pos": "noun",
      "note": "followed by a genitive: بَعْضُ النَّاسِ baʿḍu n-nāsi 'some of the people'"
     }
    ]
   },
   {
    "id": "u6",
    "title": "Places & Dwellings",
    "titleAr": "الْأَمَاكِنُ وَالْمَسَاكِنُ",
    "icon": "🏠",
    "intro": "Homes, roads, markets, and gathering-places frame nearly every Qurʾanic narrative and classical text; these nouns let you say where anything happens.",
    "words": [
     {
      "ar": "بَيْت",
      "translit": "bayt",
      "en": "house, home",
      "root": "ب ي ت",
      "pos": "noun",
      "note": "pl. بُيُوت buyūt"
     },
     {
      "ar": "دَار",
      "translit": "dār",
      "en": "house, abode",
      "root": "د و ر",
      "pos": "noun",
      "note": "fem.; pl. دِيَار diyār"
     },
     {
      "ar": "مَسْجِد",
      "translit": "masjid",
      "en": "mosque",
      "root": "س ج د",
      "pos": "noun",
      "note": "pl. مَسَاجِد masājid; lit. place of سُجُود sujūd 'prostration'"
     },
     {
      "ar": "مَدِينَة",
      "translit": "madīna",
      "en": "city",
      "root": "م د ن",
      "pos": "noun",
      "note": "pl. مُدُن mudun"
     },
     {
      "ar": "قَرْيَة",
      "translit": "qarya",
      "en": "village, town",
      "root": "ق ر ي",
      "pos": "noun",
      "note": "pl. قُرًى qurā; in the Qurʾan often 'town'"
     },
     {
      "ar": "بَاب",
      "translit": "bāb",
      "en": "door, gate",
      "root": "ب و ب",
      "pos": "noun",
      "note": "pl. أَبْوَاب abwāb"
     },
     {
      "ar": "سُوق",
      "translit": "sūq",
      "en": "market",
      "root": "س و ق",
      "pos": "noun",
      "note": "usually fem.; pl. أَسْوَاق aswāq"
     },
     {
      "ar": "طَرِيق",
      "translit": "ṭarīq",
      "en": "road, way",
      "root": "ط ر ق",
      "pos": "noun",
      "note": "pl. طُرُق ṭuruq"
     },
     {
      "ar": "سَبِيل",
      "translit": "sabīl",
      "en": "way, path",
      "root": "س ب ل",
      "pos": "noun",
      "note": "masc. or fem.; pl. سُبُل subul; فِي سَبِيلِ اللَّهِ fī sabīli llāhi 'in the way of God'"
     },
     {
      "ar": "مَكَان",
      "translit": "makān",
      "en": "place",
      "root": "ك و ن",
      "pos": "noun",
      "note": "pl. أَمْكِنَة amkina"
     },
     {
      "ar": "بَلَد",
      "translit": "balad",
      "en": "land, country, town",
      "root": "ب ل د",
      "pos": "noun",
      "note": "pl. بِلَاد bilād"
     },
     {
      "ar": "مَنْزِل",
      "translit": "manzil",
      "en": "dwelling, lodging, station",
      "root": "ن ز ل",
      "pos": "noun",
      "note": "pl. مَنَازِل manāzil; from نَزَلَ nazala 'to alight, come down'"
     },
     {
      "ar": "قَصْر",
      "translit": "qaṣr",
      "en": "palace, castle",
      "root": "ق ص ر",
      "pos": "noun",
      "note": "pl. قُصُور quṣūr"
     },
     {
      "ar": "بِئْر",
      "translit": "biʾr",
      "en": "well",
      "root": "ب أ ر",
      "pos": "noun",
      "note": "fem.; pl. آبَار ābār"
     }
    ]
   },
   {
    "id": "u7",
    "title": "Description & Qualities",
    "titleAr": "الْوَصْفُ وَالصِّفَاتُ",
    "icon": "✨",
    "intro": "These core adjectives are the workhorses of Classical description, constantly paired as opposites in the Qurʾan and in classical prose and poetry.",
    "words": [
     {
      "ar": "كَبِير",
      "translit": "kabīr",
      "en": "big, great",
      "root": "ك ب ر",
      "pos": "adj",
      "note": "fem. كَبِيرَة kabīra; opp. صَغِير ṣaghīr"
     },
     {
      "ar": "صَغِير",
      "translit": "ṣaghīr",
      "en": "small, young",
      "root": "ص غ ر",
      "pos": "adj",
      "note": "pl. صِغَار ṣighār; opp. كَبِير kabīr"
     },
     {
      "ar": "كَثِير",
      "translit": "kathīr",
      "en": "many, much",
      "root": "ك ث ر",
      "pos": "adj",
      "note": "opp. قَلِيل qalīl"
     },
     {
      "ar": "قَلِيل",
      "translit": "qalīl",
      "en": "few, little",
      "root": "ق ل ل",
      "pos": "adj",
      "note": "opp. كَثِير kathīr"
     },
     {
      "ar": "جَدِيد",
      "translit": "jadīd",
      "en": "new",
      "root": "ج د د",
      "pos": "adj",
      "note": "pl. جُدُد judud; opp. قَدِيم qadīm"
     },
     {
      "ar": "قَدِيم",
      "translit": "qadīm",
      "en": "old, ancient",
      "root": "ق د م",
      "pos": "adj",
      "note": "pl. قُدَمَاء qudamāʾ (of persons); opp. جَدِيد jadīd"
     },
     {
      "ar": "حَسَن",
      "translit": "ḥasan",
      "en": "good, fine, beautiful",
      "root": "ح س ن",
      "pos": "adj",
      "note": "fem. حَسَنَة ḥasana; opp. قَبِيح qabīḥ 'ugly'"
     },
     {
      "ar": "جَمِيل",
      "translit": "jamīl",
      "en": "beautiful, comely",
      "root": "ج م ل",
      "pos": "adj",
      "note": "fem. جَمِيلَة jamīla; صَبْر جَمِيل ṣabr jamīl 'comely patience' (Q 12:18)"
     },
     {
      "ar": "كَرِيم",
      "translit": "karīm",
      "en": "noble, generous",
      "root": "ك ر م",
      "pos": "adj",
      "note": "pl. كِرَام kirām; of God: الْكَرِيم al-Karīm"
     },
     {
      "ar": "عَظِيم",
      "translit": "ʿaẓīm",
      "en": "great, mighty, tremendous",
      "root": "ع ظ م",
      "pos": "adj",
      "note": "pl. عِظَام ʿiẓām; of God: الْعَظِيم al-ʿAẓīm"
     },
     {
      "ar": "شَدِيد",
      "translit": "shadīd",
      "en": "strong, severe, intense",
      "root": "ش د د",
      "pos": "adj",
      "note": "pl. شِدَاد shidād; opp. ضَعِيف ḍaʿīf 'weak'"
     },
     {
      "ar": "طَيِّب",
      "translit": "ṭayyib",
      "en": "good, pure, pleasant",
      "root": "ط ي ب",
      "pos": "adj",
      "note": "fem. طَيِّبَة ṭayyiba; opp. خَبِيث khabīth 'foul'"
     },
     {
      "ar": "قَرِيب",
      "translit": "qarīb",
      "en": "near, close",
      "root": "ق ر ب",
      "pos": "adj",
      "note": "opp. بَعِيد baʿīd"
     },
     {
      "ar": "بَعِيد",
      "translit": "baʿīd",
      "en": "far, distant",
      "root": "ب ع د",
      "pos": "adj",
      "note": "opp. قَرِيب qarīb"
     }
    ]
   },
   {
    "id": "u8",
    "title": "Time & the Heavens' Course",
    "titleAr": "الزَّمَانُ وَالْأَوْقَاتُ",
    "icon": "🌙",
    "intro": "Classical Arabic measures life by days and nights, months and ages; these words of time recur constantly in the Qurʾan, hadith, and poetry.",
    "words": [
     {
      "ar": "يَوْم",
      "translit": "yawm",
      "en": "day",
      "root": "ي و م",
      "pos": "noun",
      "note": "pl. أَيَّام ayyām"
     },
     {
      "ar": "لَيْل",
      "translit": "layl",
      "en": "night, nighttime",
      "root": "ل ي ل",
      "pos": "noun",
      "note": "collective; unit لَيْلَة layla 'a night', pl. لَيَالٍ layālin"
     },
     {
      "ar": "نَهَار",
      "translit": "nahār",
      "en": "daytime",
      "root": "ن ه ر",
      "pos": "noun",
      "note": "opp. لَيْل layl"
     },
     {
      "ar": "صَبَاح",
      "translit": "ṣabāḥ",
      "en": "morning",
      "root": "ص ب ح",
      "pos": "noun",
      "note": "opp. مَسَاء masāʾ"
     },
     {
      "ar": "مَسَاء",
      "translit": "masāʾ",
      "en": "evening",
      "root": "م س و",
      "pos": "noun",
      "note": "opp. صَبَاح ṣabāḥ"
     },
     {
      "ar": "سَاعَة",
      "translit": "sāʿa",
      "en": "hour; the Hour",
      "root": "س و ع",
      "pos": "noun",
      "note": "pl. سَاعَات sāʿāt; السَّاعَة as-sāʿa 'the Hour' = the Resurrection"
     },
     {
      "ar": "شَهْر",
      "translit": "shahr",
      "en": "month",
      "root": "ش ه ر",
      "pos": "noun",
      "note": "pl. شُهُور shuhūr / أَشْهُر ashhur"
     },
     {
      "ar": "سَنَة",
      "translit": "sana",
      "en": "year",
      "root": "س ن و",
      "pos": "noun",
      "note": "pl. سِنُون sinūn / سَنَوَات sanawāt"
     },
     {
      "ar": "عَام",
      "translit": "ʿām",
      "en": "year",
      "root": "ع و م",
      "pos": "noun",
      "note": "pl. أَعْوَام aʿwām; synonym of سَنَة sana"
     },
     {
      "ar": "وَقْت",
      "translit": "waqt",
      "en": "time, appointed time",
      "root": "و ق ت",
      "pos": "noun",
      "note": "pl. أَوْقَات awqāt"
     },
     {
      "ar": "دَهْر",
      "translit": "dahr",
      "en": "time, age, fate",
      "root": "د ه ر",
      "pos": "noun",
      "note": "pl. دُهُور duhūr; time as the long course of ages"
     },
     {
      "ar": "غَد",
      "translit": "ghad",
      "en": "tomorrow",
      "root": "غ د و",
      "pos": "noun",
      "note": "adverbial غَدًا ghadan 'tomorrow'"
     },
     {
      "ar": "أَمْس",
      "translit": "ams",
      "en": "yesterday",
      "root": "—",
      "pos": "noun",
      "note": "as adverb built on kasra: أَمْسِ amsi 'yesterday'"
     },
     {
      "ar": "حِين",
      "translit": "ḥīn",
      "en": "time, while, moment",
      "root": "ح ي ن",
      "pos": "noun",
      "note": "pl. أَحْيَان aḥyān; حِينَئِذٍ ḥīnaʾidhin 'at that time'"
     }
    ]
   },
   {
    "id": "u9",
    "title": "The Body & the Senses",
    "titleAr": "الْجَسَدُ وَالْحَوَاسُّ",
    "icon": "👁️",
    "intro": "The parts of the body — above all the heart, tongue, eye, and ear — carry both literal and moral weight throughout the Qurʾan and classical literature.",
    "words": [
     {
      "ar": "رَأْس",
      "translit": "raʾs",
      "en": "head",
      "root": "ر أ س",
      "pos": "noun",
      "note": "pl. رُؤُوس ruʾūs"
     },
     {
      "ar": "عَيْن",
      "translit": "ʿayn",
      "en": "eye",
      "root": "ع ي ن",
      "pos": "noun",
      "note": "fem.; pl. عُيُون ʿuyūn / أَعْيُن aʿyun; also 'spring of water'"
     },
     {
      "ar": "أُذُن",
      "translit": "udhun",
      "en": "ear",
      "root": "أ ذ ن",
      "pos": "noun",
      "note": "fem.; pl. آذَان ādhān"
     },
     {
      "ar": "يَد",
      "translit": "yad",
      "en": "hand",
      "root": "ي د ي",
      "pos": "noun",
      "note": "fem.; dual يَدَانِ yadāni, pl. أَيْدٍ aydin"
     },
     {
      "ar": "رِجْل",
      "translit": "rijl",
      "en": "foot, leg",
      "root": "ر ج ل",
      "pos": "noun",
      "note": "fem.; pl. أَرْجُل arjul"
     },
     {
      "ar": "قَلْب",
      "translit": "qalb",
      "en": "heart",
      "root": "ق ل ب",
      "pos": "noun",
      "note": "pl. قُلُوب qulūb"
     },
     {
      "ar": "وَجْه",
      "translit": "wajh",
      "en": "face",
      "root": "و ج ه",
      "pos": "noun",
      "note": "pl. وُجُوه wujūh"
     },
     {
      "ar": "لِسَان",
      "translit": "lisān",
      "en": "tongue; language",
      "root": "ل س ن",
      "pos": "noun",
      "note": "pl. أَلْسِنَة alsina"
     },
     {
      "ar": "فَم",
      "translit": "fam",
      "en": "mouth",
      "root": "ف و ه",
      "pos": "noun",
      "note": "pl. أَفْوَاه afwāh; in iḍāfa: فُو fū / فَا fā / فِي fī"
     },
     {
      "ar": "صَدْر",
      "translit": "ṣadr",
      "en": "chest, breast",
      "root": "ص د ر",
      "pos": "noun",
      "note": "pl. صُدُور ṣudūr"
     },
     {
      "ar": "بَطْن",
      "translit": "baṭn",
      "en": "belly, interior",
      "root": "ب ط ن",
      "pos": "noun",
      "note": "pl. بُطُون buṭūn"
     },
     {
      "ar": "دَم",
      "translit": "dam",
      "en": "blood",
      "root": "د م ي",
      "pos": "noun",
      "note": "pl. دِمَاء dimāʾ"
     },
     {
      "ar": "عَظْم",
      "translit": "ʿaẓm",
      "en": "bone",
      "root": "ع ظ م",
      "pos": "noun",
      "note": "pl. عِظَام ʿiẓām"
     },
     {
      "ar": "سَمْع",
      "translit": "samʿ",
      "en": "hearing",
      "root": "س م ع",
      "pos": "noun",
      "note": "verbal noun of سَمِعَ samiʿa 'to hear'"
     },
     {
      "ar": "بَصَر",
      "translit": "baṣar",
      "en": "sight, eyesight",
      "root": "ب ص ر",
      "pos": "noun",
      "note": "pl. أَبْصَار abṣār"
     }
    ]
   },
   {
    "id": "u10",
    "title": "Knowledge & the Word",
    "titleAr": "الْعِلْمُ وَالْكَلِمَةُ",
    "icon": "📖",
    "intro": "Words for knowledge, speech, and writing form the vocabulary of Islamic scholarship itself, from the Qurʾanic pen to the poet's verse.",
    "words": [
     {
      "ar": "عِلْم",
      "translit": "ʿilm",
      "en": "knowledge, science",
      "root": "ع ل م",
      "pos": "noun",
      "note": "pl. عُلُوم ʿulūm; opp. جَهْل jahl 'ignorance'"
     },
     {
      "ar": "كِتَاب",
      "translit": "kitāb",
      "en": "book, scripture",
      "root": "ك ت ب",
      "pos": "noun",
      "note": "pl. كُتُب kutub"
     },
     {
      "ar": "قَلَم",
      "translit": "qalam",
      "en": "pen",
      "root": "ق ل م",
      "pos": "noun",
      "note": "pl. أَقْلَام aqlām"
     },
     {
      "ar": "كَلِمَة",
      "translit": "kalima",
      "en": "word",
      "root": "ك ل م",
      "pos": "noun",
      "note": "pl. كَلِمَات kalimāt"
     },
     {
      "ar": "كَلَام",
      "translit": "kalām",
      "en": "speech, discourse",
      "root": "ك ل م",
      "pos": "noun",
      "note": "كَلَامُ اللَّهِ kalāmu llāhi 'the speech of God'"
     },
     {
      "ar": "حِكْمَة",
      "translit": "ḥikma",
      "en": "wisdom",
      "root": "ح ك م",
      "pos": "noun",
      "note": "pl. حِكَم ḥikam"
     },
     {
      "ar": "خَبَر",
      "translit": "khabar",
      "en": "news, report",
      "root": "خ ب ر",
      "pos": "noun",
      "note": "pl. أَخْبَار akhbār"
     },
     {
      "ar": "قِصَّة",
      "translit": "qiṣṣa",
      "en": "story, narrative",
      "root": "ق ص ص",
      "pos": "noun",
      "note": "pl. قِصَص qiṣaṣ"
     },
     {
      "ar": "شِعْر",
      "translit": "shiʿr",
      "en": "poetry, verse",
      "root": "ش ع ر",
      "pos": "noun",
      "note": "poet: شَاعِر shāʿir, pl. شُعَرَاء shuʿarāʾ"
     },
     {
      "ar": "عَقْل",
      "translit": "ʿaql",
      "en": "intellect, reason",
      "root": "ع ق ل",
      "pos": "noun",
      "note": "pl. عُقُول ʿuqūl"
     },
     {
      "ar": "فَهْم",
      "translit": "fahm",
      "en": "understanding",
      "root": "ف ه م",
      "pos": "noun",
      "note": "verbal noun of فَهِمَ fahima 'to understand'"
     },
     {
      "ar": "دَرْس",
      "translit": "dars",
      "en": "lesson, study",
      "root": "د ر س",
      "pos": "noun",
      "note": "pl. دُرُوس durūs"
     },
     {
      "ar": "مَعْنَى",
      "translit": "maʿnā",
      "en": "meaning, sense",
      "root": "ع ن ي",
      "pos": "noun",
      "note": "pl. مَعَانٍ maʿānin"
     },
     {
      "ar": "سُؤَال",
      "translit": "suʾāl",
      "en": "question",
      "root": "س أ ل",
      "pos": "noun",
      "note": "pl. أَسْئِلَة asʾila"
     },
     {
      "ar": "جَوَاب",
      "translit": "jawāb",
      "en": "answer, reply",
      "root": "ج و ب",
      "pos": "noun",
      "note": "pl. أَجْوِبَة ajwiba"
     }
    ]
   }
  ];

  var MORPH = /*@DATA:MORPH*/{
   "pronouns": [
    {
     "ar": "أَنَا",
     "translit": "anā",
     "en": "I"
    },
    {
     "ar": "نَحْنُ",
     "translit": "naḥnu",
     "en": "we"
    },
    {
     "ar": "أَنْتَ",
     "translit": "anta",
     "en": "you (m sg)"
    },
    {
     "ar": "أَنْتِ",
     "translit": "anti",
     "en": "you (f sg)"
    },
    {
     "ar": "أَنْتُمَا",
     "translit": "antumā",
     "en": "you (dual)"
    },
    {
     "ar": "أَنْتُمْ",
     "translit": "antum",
     "en": "you (m pl)"
    },
    {
     "ar": "أَنْتُنَّ",
     "translit": "antunna",
     "en": "you (f pl)"
    },
    {
     "ar": "هُوَ",
     "translit": "huwa",
     "en": "he"
    },
    {
     "ar": "هِيَ",
     "translit": "hiya",
     "en": "she"
    },
    {
     "ar": "هُمَا",
     "translit": "humā",
     "en": "they (dual)"
    },
    {
     "ar": "هُمْ",
     "translit": "hum",
     "en": "they (m pl)"
    },
    {
     "ar": "هُنَّ",
     "translit": "hunna",
     "en": "they (f pl)"
    }
   ],
   "suffixes": [
    {
     "ar": "ـِي",
     "translit": "-ī",
     "en": "my / me"
    },
    {
     "ar": "ـنَا",
     "translit": "-nā",
     "en": "our / us"
    },
    {
     "ar": "ـكَ",
     "translit": "-ka",
     "en": "your / you (m sg)"
    },
    {
     "ar": "ـكِ",
     "translit": "-ki",
     "en": "your / you (f sg)"
    },
    {
     "ar": "ـكُمَا",
     "translit": "-kumā",
     "en": "your / you (dual)"
    },
    {
     "ar": "ـكُمْ",
     "translit": "-kum",
     "en": "your / you (m pl)"
    },
    {
     "ar": "ـكُنَّ",
     "translit": "-kunna",
     "en": "your / you (f pl)"
    },
    {
     "ar": "ـهُ",
     "translit": "-hu",
     "en": "his / him"
    },
    {
     "ar": "ـهَا",
     "translit": "-hā",
     "en": "her"
    },
    {
     "ar": "ـهُمَا",
     "translit": "-humā",
     "en": "their / them (dual)"
    },
    {
     "ar": "ـهُمْ",
     "translit": "-hum",
     "en": "their / them (m pl)"
    },
    {
     "ar": "ـهُنَّ",
     "translit": "-hunna",
     "en": "their / them (f pl)"
    }
   ],
   "paradigm": [
    {
     "pronoun": "أَنَا",
     "pronounTranslit": "anā",
     "en": "I",
     "past": "كَتَبْتُ",
     "pastTranslit": "katabtu",
     "present": "أَكْتُبُ",
     "presentTranslit": "aktubu"
    },
    {
     "pronoun": "نَحْنُ",
     "pronounTranslit": "naḥnu",
     "en": "we",
     "past": "كَتَبْنَا",
     "pastTranslit": "katabnā",
     "present": "نَكْتُبُ",
     "presentTranslit": "naktubu"
    },
    {
     "pronoun": "أَنْتَ",
     "pronounTranslit": "anta",
     "en": "you (m sg)",
     "past": "كَتَبْتَ",
     "pastTranslit": "katabta",
     "present": "تَكْتُبُ",
     "presentTranslit": "taktubu"
    },
    {
     "pronoun": "أَنْتِ",
     "pronounTranslit": "anti",
     "en": "you (f sg)",
     "past": "كَتَبْتِ",
     "pastTranslit": "katabti",
     "present": "تَكْتُبِينَ",
     "presentTranslit": "taktubīna"
    },
    {
     "pronoun": "أَنْتُمَا",
     "pronounTranslit": "antumā",
     "en": "you (dual)",
     "past": "كَتَبْتُمَا",
     "pastTranslit": "katabtumā",
     "present": "تَكْتُبَانِ",
     "presentTranslit": "taktubāni"
    },
    {
     "pronoun": "أَنْتُمْ",
     "pronounTranslit": "antum",
     "en": "you (m pl)",
     "past": "كَتَبْتُمْ",
     "pastTranslit": "katabtum",
     "present": "تَكْتُبُونَ",
     "presentTranslit": "taktubūna"
    },
    {
     "pronoun": "أَنْتُنَّ",
     "pronounTranslit": "antunna",
     "en": "you (f pl)",
     "past": "كَتَبْتُنَّ",
     "pastTranslit": "katabtunna",
     "present": "تَكْتُبْنَ",
     "presentTranslit": "taktubna"
    },
    {
     "pronoun": "هُوَ",
     "pronounTranslit": "huwa",
     "en": "he",
     "past": "كَتَبَ",
     "pastTranslit": "kataba",
     "present": "يَكْتُبُ",
     "presentTranslit": "yaktubu"
    },
    {
     "pronoun": "هِيَ",
     "pronounTranslit": "hiya",
     "en": "she",
     "past": "كَتَبَتْ",
     "pastTranslit": "katabat",
     "present": "تَكْتُبُ",
     "presentTranslit": "taktubu"
    },
    {
     "pronoun": "هُمَا",
     "pronounTranslit": "humā",
     "en": "they two (m)",
     "past": "كَتَبَا",
     "pastTranslit": "katabā",
     "present": "يَكْتُبَانِ",
     "presentTranslit": "yaktubāni"
    },
    {
     "pronoun": "هُمَا",
     "pronounTranslit": "humā",
     "en": "they two (f)",
     "past": "كَتَبَتَا",
     "pastTranslit": "katabatā",
     "present": "تَكْتُبَانِ",
     "presentTranslit": "taktubāni"
    },
    {
     "pronoun": "هُمْ",
     "pronounTranslit": "hum",
     "en": "they (m pl)",
     "past": "كَتَبُوا",
     "pastTranslit": "katabū",
     "present": "يَكْتُبُونَ",
     "presentTranslit": "yaktubūna"
    },
    {
     "pronoun": "هُنَّ",
     "pronounTranslit": "hunna",
     "en": "they (f pl)",
     "past": "كَتَبْنَ",
     "pastTranslit": "katabna",
     "present": "يَكْتُبْنَ",
     "presentTranslit": "yaktubna"
    }
   ],
   "forms": [
    {
     "form": "I",
     "wazn": "فَعَلَ",
     "waznTranslit": "faʿala",
     "meaning": "base meaning",
     "example": {
      "ar": "كَتَبَ",
      "translit": "kataba",
      "en": "to write"
     },
     "present": "يَكْتُبُ",
     "presentTranslit": "yaktubu"
    },
    {
     "form": "II",
     "wazn": "فَعَّلَ",
     "waznTranslit": "faʿʿala",
     "meaning": "intensive / causative",
     "example": {
      "ar": "عَلَّمَ",
      "translit": "ʿallama",
      "en": "to teach"
     },
     "present": "يُعَلِّمُ",
     "presentTranslit": "yuʿallimu"
    },
    {
     "form": "III",
     "wazn": "فَاعَلَ",
     "waznTranslit": "fāʿala",
     "meaning": "action directed at another / reciprocal",
     "example": {
      "ar": "قَاتَلَ",
      "translit": "qātala",
      "en": "to fight (someone)"
     },
     "present": "يُقَاتِلُ",
     "presentTranslit": "yuqātilu"
    },
    {
     "form": "IV",
     "wazn": "أَفْعَلَ",
     "waznTranslit": "afʿala",
     "meaning": "causative",
     "example": {
      "ar": "أَرْسَلَ",
      "translit": "arsala",
      "en": "to send"
     },
     "present": "يُرْسِلُ",
     "presentTranslit": "yursilu"
    },
    {
     "form": "V",
     "wazn": "تَفَعَّلَ",
     "waznTranslit": "tafaʿʿala",
     "meaning": "reflexive of Form II",
     "example": {
      "ar": "تَعَلَّمَ",
      "translit": "taʿallama",
      "en": "to learn"
     },
     "present": "يَتَعَلَّمُ",
     "presentTranslit": "yataʿallamu"
    },
    {
     "form": "VI",
     "wazn": "تَفَاعَلَ",
     "waznTranslit": "tafāʿala",
     "meaning": "mutual / reciprocal",
     "example": {
      "ar": "تَعَاوَنَ",
      "translit": "taʿāwana",
      "en": "to cooperate"
     },
     "present": "يَتَعَاوَنُ",
     "presentTranslit": "yataʿāwanu"
    },
    {
     "form": "VII",
     "wazn": "اِنْفَعَلَ",
     "waznTranslit": "infaʿala",
     "meaning": "passive / intransitive",
     "example": {
      "ar": "اِنْكَسَرَ",
      "translit": "inkasara",
      "en": "to be broken"
     },
     "present": "يَنْكَسِرُ",
     "presentTranslit": "yankasiru"
    },
    {
     "form": "VIII",
     "wazn": "اِفْتَعَلَ",
     "waznTranslit": "iftaʿala",
     "meaning": "reflexive / middle",
     "example": {
      "ar": "اِجْتَمَعَ",
      "translit": "ijtamaʿa",
      "en": "to gather, assemble"
     },
     "present": "يَجْتَمِعُ",
     "presentTranslit": "yajtamiʿu"
    },
    {
     "form": "IX",
     "wazn": "اِفْعَلَّ",
     "waznTranslit": "ifʿalla",
     "meaning": "colors and defects",
     "example": {
      "ar": "اِحْمَرَّ",
      "translit": "iḥmarra",
      "en": "to turn red"
     },
     "present": "يَحْمَرُّ",
     "presentTranslit": "yaḥmarru"
    },
    {
     "form": "X",
     "wazn": "اِسْتَفْعَلَ",
     "waznTranslit": "istafʿala",
     "meaning": "seeking / considering",
     "example": {
      "ar": "اِسْتَغْفَرَ",
      "translit": "istaghfara",
      "en": "to seek forgiveness"
     },
     "present": "يَسْتَغْفِرُ",
     "presentTranslit": "yastaghfiru"
    }
   ],
   "derived": [
    {
     "id": "active-participle",
     "name": "Active participle",
     "nameAr": "اِسْمُ الْفَاعِل",
     "pattern": "فَاعِل",
     "patternTranslit": "fāʿil",
     "desc": "Names the doer of the action, formed from the Form I verb on the pattern fāʿil.",
     "example": {
      "ar": "كَاتِب",
      "translit": "kātib",
      "en": "writer"
     }
    },
    {
     "id": "passive-participle",
     "name": "Passive participle",
     "nameAr": "اِسْمُ الْمَفْعُول",
     "pattern": "مَفْعُول",
     "patternTranslit": "mafʿūl",
     "desc": "Names what undergoes the action, formed from the Form I verb on the pattern mafʿūl.",
     "example": {
      "ar": "مَكْتُوب",
      "translit": "maktūb",
      "en": "written"
     }
    },
    {
     "id": "masdar",
     "name": "Verbal noun",
     "nameAr": "الْمَصْدَر",
     "pattern": "أَوْزَان مُتَعَدِّدَة",
     "patternTranslit": "awzān mutaʿaddida (the pattern varies)",
     "desc": "Names the action itself as a noun; its pattern varies from verb to verb and must be learned with each verb.",
     "example": {
      "ar": "كِتَابَة",
      "translit": "kitāba",
      "en": "writing"
     }
    },
    {
     "id": "place-noun",
     "name": "Noun of place",
     "nameAr": "اِسْمُ الْمَكَان",
     "pattern": "مَفْعَل / مَفْعِل",
     "patternTranslit": "mafʿal / mafʿil",
     "desc": "Names the place where the action happens, on the pattern mafʿal or mafʿil.",
     "example": {
      "ar": "مَكْتَب",
      "translit": "maktab",
      "en": "writing place, desk"
     }
    }
   ]
  };

  var GRAMMAR = /*@DATA:GRAMMAR*/[
   {
    "id": "g1",
    "title": "Roots & Patterns",
    "titleAr": "الْجِذْرُ وَالْوَزْنُ",
    "tagline": "Three little consonants hide inside almost every Arabic word - learn to see them and the whole language opens up.",
    "body": [
     "Arabic is built on a system of breathtaking elegance: almost every word grows from a root of three consonants that carries a core meaning. The root ك-ت-ب carries the idea of writing. Pour it into different molds and you get كَتَبَ (he wrote), كِتَاب (book), كَاتِب (writer), مَكْتُوب (written), and مَكْتَب (place of writing). One root, one idea, a whole family of words.",
     "These molds are called patterns (أَوْزَان, singular وَزْن). Each pattern has its own job: the pattern of كَاتِب names the doer of an action, the pattern of مَكْتُوب names the thing the action was done to, and the pattern of مَكْتَب names the place where it happens. Once you know a pattern, you can often guess the meaning of a brand-new word on sight.",
     "The grammarians invented a wonderful convention for naming patterns: they use the root ف-ع-ل, from فَعَلَ 'to do', as a stand-in. The فَاء marks the first root consonant, the عَيْن the second, and the لَام the third. So كَاتِب is said to be on the pattern فَاعِل, and مَكْتُوب on the pattern مَفْعُول. Learn to hear roots and patterns separately, and Arabic vocabulary stops being a list to memorize and becomes a system to enjoy."
    ],
    "examples": [
     {
      "ar": "كَتَبَ الْكَاتِبُ كِتَابًا",
      "translit": "kataba al-kātibu kitāban",
      "en": "The writer wrote a book.",
      "note": "Three different words, one root: ك-ت-ب appears in the verb, the doer, and the thing produced."
     },
     {
      "ar": "جَلَسَ الرَّجُلُ فِي الْمَكْتَبِ",
      "translit": "jalasa ar-rajulu fī al-maktabi",
      "en": "The man sat in the writing-place (office).",
      "note": "مَكْتَب is on the pattern مَفْعَل, which names the place where the action happens."
     },
     {
      "ar": "هَذَا مَكْتُوبٌ بِالْقَلَمِ",
      "translit": "hādhā maktūbun bi-l-qalami",
      "en": "This is written with the pen.",
      "note": "مَكْتُوب is on the pattern مَفْعُول: the thing the action was done to."
     },
     {
      "ar": "الْعِلْمُ نُورٌ",
      "translit": "al-ʿilmu nūrun",
      "en": "Knowledge is light.",
      "note": "The same system works for every root: ع-ل-م yields عِلْم، عَالِم، مَعْلُوم just as ك-ت-ب did."
     },
     {
      "ar": "الْعَالِمُ مَعْرُوفٌ فِي الْمَدِينَةِ",
      "translit": "al-ʿālimu maʿrūfun fī al-madīnati",
      "en": "The scholar is well known in the city.",
      "note": "عَالِم is فَاعِل (doer) from ع-ل-م; مَعْرُوف is مَفْعُول (done-to) from ع-ر-ف."
     }
    ],
    "quiz": [
     {
      "q": "What is the root of مَكْتُوب (maktūb)?",
      "options": [
       "ك-ت-ب",
       "م-ك-ت",
       "ت-و-ب",
       "ك-ت-و"
      ],
      "answer": 0,
      "why": "The م and the و belong to the pattern مَفْعُول; only ك-ت-ب are root consonants."
     },
     {
      "q": "The pattern فَاعِل, as in كَاتِب, typically names what?",
      "options": [
       "The place of the action",
       "The doer of the action",
       "The thing acted upon",
       "The tool of the action"
      ],
      "answer": 1,
      "why": "فَاعِل is the active-participle pattern: كَاتِب is the one who writes."
     },
     {
      "q": "Which word from the root ك-ت-ب means 'written'?",
      "options": [
       "كَاتِب",
       "كِتَاب",
       "مَكْتُوب",
       "مَكْتَب"
      ],
      "answer": 2,
      "why": "مَكْتُوب is on the passive pattern مَفْعُول, 'the thing written'."
     },
     {
      "q": "In the grammarians' template convention, the letters ف-ع-ل stand for what?",
      "options": [
       "The three most common letters of the alphabet",
       "The first, second, and third consonants of any root",
       "A prefix added to every Arabic verb",
       "The three short vowels"
      ],
      "answer": 1,
      "why": "فَعَلَ 'to do' serves as the model: فَاء = first radical, عَيْن = second, لَام = third."
     },
     {
      "q": "مَكْتَب follows the pattern مَفْعَل. What does this pattern usually indicate?",
      "options": [
       "The doer of the action",
       "An intensive adjective",
       "The place where the action happens",
       "A diminutive"
      ],
      "answer": 2,
      "why": "مَفْعَل is the noun of place: مَكْتَب is where writing is done, as مَدْخَل is where entering happens (مَسْجِد uses the variant place-pattern مَفْعِل)."
     }
    ]
   },
   {
    "id": "g2",
    "title": "The Definite Article",
    "titleAr": "أَلْ التَّعْرِيفِ",
    "tagline": "One tiny prefix, two personalities: meet the sun letters that swallow it and the moon letters that let it shine.",
    "body": [
     "Arabic makes a noun definite with a single prefix: ال. So كِتَاب is 'a book' and الْكِتَاب is 'the book'. There is no separate word for 'a' at all - indefiniteness is marked instead by tanwīn, the doubled final vowel: كِتَابٌ (kitābun) is 'a book'. A noun is either wearing ال or wearing tanwīn; it never wears both.",
     "Now for the beautiful twist. Before roughly half the alphabet, the lām of ال refuses to be pronounced: the tongue is already so close to the next consonant that the lām assimilates into it, doubling it. These are the sun letters (الْحُرُوف الشَّمْسِيَّة), so named because شَمْس 'sun' begins with one: we write الشَّمْسُ and say ash-shamsu, with a shadda on the shīn and no audible lām. The fourteen sun letters are ت ث د ذ ر ز س ش ص ض ط ظ ل ن - all made with the tip or blade of the tongue.",
     "The other fourteen are the moon letters (الْحُرُوف الْقَمَرِيَّة), after قَمَر 'moon': before them the lām is pronounced with a clear sukūn, as in الْقَمَرُ (al-qamaru). The writing never drops the lām; only the vocalization tells you which pronunciation to use - shadda on a sun letter, sukūn on the lām before a moon letter. Say ash-shams and al-qamar aloud a few times, and your tongue will soon sort the letters by itself."
    ],
    "examples": [
     {
      "ar": "الشَّمْسُ طَالِعَةٌ",
      "translit": "ash-shamsu ṭāliʿatun",
      "en": "The sun is rising.",
      "note": "Sun letter ش: the lām assimilates, shown by the shadda on the shīn."
     },
     {
      "ar": "الْقَمَرُ مُنِيرٌ",
      "translit": "al-qamaru munīrun",
      "en": "The moon is shining.",
      "note": "Moon letter ق: the lām keeps its sukūn and is pronounced."
     },
     {
      "ar": "النُّورُ فِي السَّمَاءِ",
      "translit": "an-nūru fī as-samāʾi",
      "en": "The light is in the sky.",
      "note": "Both ن and س are sun letters - two assimilations in one short sentence."
     },
     {
      "ar": "قَرَأْتُ كِتَابًا",
      "translit": "qaraʾtu kitāban",
      "en": "I read a book.",
      "note": "No word for 'a': the tanwīn ending on كِتَابًا marks it as indefinite."
     },
     {
      "ar": "الْعِلْمُ نَافِعٌ",
      "translit": "al-ʿilmu nāfiʿun",
      "en": "Knowledge is beneficial.",
      "note": "ع is a moon letter, so the lām of ال is pronounced: al-ʿilmu."
     }
    ],
    "quiz": [
     {
      "q": "Which of these words begins with a sun letter?",
      "options": [
       "قَمَر",
       "شَمْس",
       "بَيْت",
       "كِتَاب"
      ],
      "answer": 1,
      "why": "ش is a sun letter - the very word شَمْس 'sun' gives the group its name."
     },
     {
      "q": "How is 'the sun' correctly written with full vocalization?",
      "options": [
       "الْشَمْسُ",
       "الشَّمْسُ",
       "أَلْشَمْسُ",
       "الشَمْسُ"
      ],
      "answer": 1,
      "why": "Before a sun letter the lām assimilates: no sukūn on the lām, shadda on the shīn."
     },
     {
      "q": "How does Classical Arabic mark a noun as indefinite, as in 'a book'?",
      "options": [
       "With the prefix ال",
       "With tanwīn: كِتَابٌ",
       "With a separate word meaning 'a'",
       "With a final sukūn"
      ],
      "answer": 1,
      "why": "There is no indefinite article; the doubled final vowel (tanwīn) does the job."
     },
     {
      "q": "In الْقَمَرُ (al-qamaru), why is the lām pronounced?",
      "options": [
       "Because ق is a moon letter",
       "Because ق is a sun letter",
       "Because the word is masculine",
       "Because of the final damma"
      ],
      "answer": 0,
      "why": "Before moon letters the lām keeps its sukūn and is heard clearly."
     },
     {
      "q": "Which pairing of spelling and pronunciation is correct?",
      "options": [
       "النَّهْرُ - an-nahru (sun letter)",
       "الرَّجُلُ - al-rajulu (moon letter)",
       "الشَّمْسُ - al-shamsu (moon letter)",
       "الْكِتَابُ - ak-kitābu (sun letter)"
      ],
      "answer": 0,
      "why": "ن is a sun letter, so the lām assimilates: an-nahru; ر and ش are also sun letters, while ك is a moon letter pronounced al-kitābu."
     }
    ]
   },
   {
    "id": "g3",
    "title": "Masculine & Feminine",
    "titleAr": "الْمُذَكَّرُ وَالْمُؤَنَّثُ",
    "tagline": "Every Arabic noun has a gender - and a small round letter usually gives the secret away.",
    "body": [
     "Every noun in Arabic is either masculine (مُذَكَّر) or feminine (مُؤَنَّث) - there is no neuter. The usual badge of the feminine is the tāʾ marbūṭa, the 'tied tāʾ' ة at the end of a word: مَدِينَة 'city', طَالِبَة 'female student', جَنَّة 'garden'. If you see ة, you are almost always looking at a feminine noun.",
     "But the language keeps a small treasury of feminine nouns that wear no marker at all, and they must simply be learned. Among the most important: شَمْس 'sun', أَرْض 'earth', نَار 'fire', يَد 'hand', and عَيْن 'eye'. Notice the pattern hiding here - paired parts of the body (hand, eye, foot, ear) are feminine. Meanwhile قَمَر 'moon', بَيْت 'house', and قَلَم 'pen' are ordinary masculines.",
     "Why does gender matter so much? Because Arabic loves agreement. An adjective must match its noun in gender: بَيْتٌ كَبِيرٌ 'a big house' but مَدِينَةٌ كَبِيرَةٌ 'a big city' - and, since شَمْس is feminine, شَمْسٌ حَارَّةٌ 'a hot sun', feminine adjective and all. Get the gender right and whole sentences fall into harmony around it."
    ],
    "examples": [
     {
      "ar": "الْمَدِينَةُ كَبِيرَةٌ",
      "translit": "al-madīnatu kabīratun",
      "en": "The city is large.",
      "note": "Feminine noun with tāʾ marbūṭa; the adjective takes ة to agree."
     },
     {
      "ar": "الْقَمَرُ جَمِيلٌ",
      "translit": "al-qamaru jamīlun",
      "en": "The moon is beautiful.",
      "note": "قَمَر is masculine, so the adjective stays masculine - no ة."
     },
     {
      "ar": "الشَّمْسُ حَارَّةٌ",
      "translit": "ash-shamsu ḥārratun",
      "en": "The sun is hot.",
      "note": "شَمْس has no ة yet is feminine - the adjective حَارَّةٌ proves it."
     },
     {
      "ar": "يَدُهُ قَوِيَّةٌ",
      "translit": "yaduhu qawiyyatun",
      "en": "His hand is strong.",
      "note": "يَد is feminine, like most paired body parts, so the adjective is feminine."
     },
     {
      "ar": "النَّارُ حَامِيَةٌ",
      "translit": "an-nāru ḥāmiyatun",
      "en": "The fire is scorching.",
      "note": "نَار is another unmarked feminine; compare the Qurʾānic phrase نَارٌ حَامِيَةٌ."
     }
    ],
    "quiz": [
     {
      "q": "Which noun is feminine even though it lacks tāʾ marbūṭa?",
      "options": [
       "قَمَر",
       "بَيْت",
       "شَمْس",
       "بَاب"
      ],
      "answer": 2,
      "why": "شَمْس 'sun' is one of the classic unmarked feminines; the other three are masculine."
     },
     {
      "q": "What is the usual written sign of a feminine noun?",
      "options": [
       "Tanwīn",
       "Tāʾ marbūṭa (ة)",
       "The prefix ال",
       "A final sukūn"
      ],
      "answer": 1,
      "why": "The tied tāʾ ة is the standard feminine ending, as in مَدِينَة and طَالِبَة."
     },
     {
      "q": "Choose the correct sentence for 'The hand is strong.'",
      "options": [
       "الْيَدُ قَوِيٌّ",
       "الْيَدُ قَوِيَّةٌ",
       "الْيَدَ قَوِيَّةٌ",
       "الْيَدُ قَوِيَّاتٌ"
      ],
      "answer": 1,
      "why": "يَد is feminine singular, so the adjective must be قَوِيَّةٌ, with both words in rafʿ."
     },
     {
      "q": "How would you say 'a small city' (city = مَدِينَة)?",
      "options": [
       "مَدِينَةٌ صَغِيرٌ",
       "مَدِينَةٌ صَغِيرَةٌ",
       "مَدِينَةُ صَغِيرَةُ",
       "مَدِينَةٌ الصَّغِيرَةُ"
      ],
      "answer": 1,
      "why": "The adjective agrees in gender (ة) and matches the noun's indefinite tanwīn."
     },
     {
      "q": "Which of these nouns is masculine?",
      "options": [
       "نَار",
       "أَرْض",
       "عَيْن",
       "قَلَم"
      ],
      "answer": 3,
      "why": "نَار, أَرْض, and عَيْن are all unmarked feminines; قَلَم 'pen' is masculine."
     }
    ]
   },
   {
    "id": "g4",
    "title": "The Nominal Sentence",
    "titleAr": "الْجُمْلَةُ الِاسْمِيَّةُ",
    "tagline": "Two nouns, no verb, a complete thought - the most economical sentence in any language.",
    "body": [
     "Here is one of the great surprises of Arabic: to say 'The house is big', you need no word for 'is'. You simply place two elements side by side: الْبَيْتُ كَبِيرٌ - literally 'the-house big'. This is the nominal sentence, الْجُمْلَة الِاسْمِيَّة, and it begins with a noun rather than a verb.",
     "Its two parts have names you will use forever. The مُبْتَدَأ (mubtadaʾ) is the starting point, the thing you are talking about: الْبَيْتُ. The خَبَر (khabar) is the news you deliver about it: كَبِيرٌ. Both stand in the rafʿ case, ending in -u (with tanwīn -un when indefinite) - the case of sentence pillars.",
     "Notice the elegant division of labor in definiteness: the mubtadaʾ is normally definite (you announce what you are talking about) while the khabar is normally indefinite (the new information). That very contrast is what makes الْبَيْتُ كَبِيرٌ a complete sentence, 'The house is big', rather than a mere phrase 'the big house' - which would be الْبَيْتُ الْكَبِيرُ, with both parts definite. Watch the ال and the tanwīn, and you will never confuse the two."
    ],
    "examples": [
     {
      "ar": "الْبَيْتُ كَبِيرٌ",
      "translit": "al-baytu kabīrun",
      "en": "The house is big.",
      "note": "No verb 'is': definite mubtadaʾ + indefinite khabar, both in rafʿ."
     },
     {
      "ar": "الطَّالِبُ مُجْتَهِدٌ",
      "translit": "aṭ-ṭālibu mujtahidun",
      "en": "The student is diligent.",
      "note": "Both parts end in the rafʿ vowel: -u on the definite, -un on the indefinite."
     },
     {
      "ar": "الصِّدْقُ نَجَاةٌ",
      "translit": "aṣ-ṣidqu najātun",
      "en": "Truthfulness is salvation.",
      "note": "The khabar can be a noun, not just an adjective - one noun equated with another."
     },
     {
      "ar": "الْمَدِينَةُ بَعِيدَةٌ",
      "translit": "al-madīnatu baʿīdatun",
      "en": "The city is far away.",
      "note": "A feminine mubtadaʾ takes a feminine khabar - agreement continues inside the sentence."
     },
     {
      "ar": "الْمُؤْمِنُونَ إِخْوَةٌ",
      "translit": "al-muʾminūna ikhwatun",
      "en": "The believers are brothers.",
      "note": "Rafʿ shows on a sound masculine plural as the ending ـُونَ instead of -u."
     }
    ],
    "quiz": [
     {
      "q": "In الْبَيْتُ كَبِيرٌ, which word is the mubtadaʾ?",
      "options": [
       "كَبِيرٌ",
       "الْبَيْتُ",
       "There is no mubtadaʾ",
       "The implied word 'is'"
      ],
      "answer": 1,
      "why": "The mubtadaʾ is the noun the sentence starts with and talks about: الْبَيْتُ."
     },
     {
      "q": "How does Classical Arabic express 'is' in 'The house is big'?",
      "options": [
       "With the verb كَانَ, which is required",
       "With no word at all - the two parts are simply juxtaposed",
       "With the particle إِنَّ",
       "With a preposition"
      ],
      "answer": 1,
      "why": "The present-tense copula is unexpressed; mubtadaʾ and khabar sit side by side."
     },
     {
      "q": "What case do the mubtadaʾ and the khabar both take?",
      "options": [
       "naṣb",
       "jarr",
       "rafʿ",
       "No case at all"
      ],
      "answer": 2,
      "why": "Both pillars of the nominal sentence stand in rafʿ: -u / -un."
     },
     {
      "q": "The classic definiteness pattern of a nominal sentence is:",
      "options": [
       "Indefinite subject + definite predicate",
       "Definite subject + indefinite predicate",
       "Both parts definite",
       "Both parts indefinite"
      ],
      "answer": 1,
      "why": "الْبَيْتُ كَبِيرٌ: the known topic carries ال, the new information carries tanwīn."
     },
     {
      "q": "Which is the correct nominal sentence for 'The student is diligent'?",
      "options": [
       "الطَّالِبَ مُجْتَهِدٌ",
       "الطَّالِبُ مُجْتَهِدًا",
       "الطَّالِبُ مُجْتَهِدٌ",
       "طَالِبٌ الْمُجْتَهِدُ"
      ],
      "answer": 2,
      "why": "Both parts must be in rafʿ (-u / -un), with a definite subject and indefinite predicate."
     }
    ]
   },
   {
    "id": "g5",
    "title": "The Three Cases",
    "titleAr": "الْإِعْرَابُ",
    "tagline": "Three little vowels - u, a, i - are the melody of Classical Arabic, singing each word's role in the sentence.",
    "body": [
     "Listen to any recitation of Classical Arabic and you will hear the ends of words dancing between -u, -a, and -i. This is الْإِعْرَاب, the case system, and it is not decoration: those final vowels announce each noun's job in the sentence. Word order can then flex freely, because the grammar rides on the vowels.",
     "The three cases are simple to state. Rafʿ, marked by damma (-u), is the case of sentence pillars: the subject of a verb and both parts of a nominal sentence. Naṣb, marked by fatha (-a), is above all the case of the direct object. Jarr, marked by kasra (-i), appears after prepositions and on the second term of the iḍāfa possessive construction you will soon meet.",
     "Indefinite nouns double the vowel as tanwīn: رَجُلٌ (rajulun), رَجُلًا (rajulan), رَجُلٍ (rajulin) - and in naṣb an alif is usually written after the tanwīn: كِتَابًا. So one sentence can show the whole system: جَاءَ الرَّجُلُ 'the man came' (rafʿ), رَأَيْتُ الرَّجُلَ 'I saw the man' (naṣb), مَرَرْتُ بِالرَّجُلِ 'I passed by the man' (jarr). Master this trio and you hold the key that unlocks every page of classical literature."
    ],
    "examples": [
     {
      "ar": "جَاءَ الرَّجُلُ",
      "translit": "jāʾa ar-rajulu",
      "en": "The man came.",
      "note": "Subject of the verb in rafʿ: final damma -u."
     },
     {
      "ar": "رَأَيْتُ الرَّجُلَ",
      "translit": "raʾaytu ar-rajula",
      "en": "I saw the man.",
      "note": "Direct object in naṣb: final fatha -a."
     },
     {
      "ar": "مَرَرْتُ بِالرَّجُلِ",
      "translit": "marartu bi-r-rajuli",
      "en": "I passed by the man.",
      "note": "After the preposition بِ the noun takes jarr: final kasra -i."
     },
     {
      "ar": "قَرَأَ الطَّالِبُ كِتَابًا جَدِيدًا",
      "translit": "qaraʾa aṭ-ṭālibu kitāban jadīdan",
      "en": "The student read a new book.",
      "note": "Indefinite object in naṣb takes tanwīn -an, written with a supporting alif; the adjective matches its case."
     },
     {
      "ar": "فِي الْبَيْتِ رَجُلٌ كَرِيمٌ",
      "translit": "fī al-bayti rajulun karīmun",
      "en": "In the house is a generous man.",
      "note": "Two cases at once: jarr after فِي, and rafʿ tanwīn -un on the indefinite subject."
     }
    ],
    "quiz": [
     {
      "q": "Which case marks the direct object of a verb?",
      "options": [
       "rafʿ (-u)",
       "naṣb (-a)",
       "jarr (-i)",
       "The object takes no case"
      ],
      "answer": 1,
      "why": "The direct object stands in naṣb, marked by fatha: رَأَيْتُ الرَّجُلَ."
     },
     {
      "q": "After a preposition such as فِي, a noun takes which ending?",
      "options": [
       "-u",
       "-a",
       "-i",
       "sukūn"
      ],
      "answer": 2,
      "why": "Prepositions govern jarr, marked by kasra: فِي الْبَيْتِ."
     },
     {
      "q": "Complete correctly: رَأَيْتُ ____ ('I saw the boy').",
      "options": [
       "الْوَلَدُ",
       "الْوَلَدِ",
       "الْوَلَدَ",
       "وَلَدٌ"
      ],
      "answer": 2,
      "why": "The direct object of رَأَيْتُ must be in naṣb: الْوَلَدَ with fatha."
     },
     {
      "q": "What does tanwīn (-un, -an, -in) added to a case vowel signal?",
      "options": [
       "That the noun is definite",
       "That the noun is indefinite",
       "That the noun is feminine",
       "That the noun is plural"
      ],
      "answer": 1,
      "why": "Tanwīn is the mark of indefiniteness; nouns with ال never take it."
     },
     {
      "q": "In جَاءَ الْمُعَلِّمُ ('The teacher came'), why does الْمُعَلِّمُ end in -u?",
      "options": [
       "It is the direct object",
       "It follows a preposition",
       "It is the subject of the verb, so it stands in rafʿ",
       "Masculine nouns always end in -u"
      ],
      "answer": 2,
      "why": "The doer of the verb takes rafʿ, marked by the final damma."
     }
    ]
   },
   {
    "id": "g6",
    "title": "Iḍāfa - Possession",
    "titleAr": "الْإِضَافَةُ",
    "tagline": "No word for 'of' needed: Arabic chains nouns together, and the case endings do all the work.",
    "body": [
     "How do you say 'the student's book'? Arabic simply places the two nouns together: كِتَابُ الطَّالِبِ - 'book-of the-student'. This construction is the iḍāfa (الْإِضَافَة, 'annexation'), and it is everywhere: in titles, in names, in the Qurʾān's opening words رَبِّ الْعَالَمِينَ 'Lord of the worlds'.",
     "The rules are strict and beautiful. The first term, the thing possessed, takes NO ال and NO tanwīn - ever. It carries whatever case the sentence assigns it, but its ending stays a single bare vowel. The second term, the possessor, always stands in jarr: كِتَابُ الطَّالِبِ, with kasra on الطَّالِبِ. And though the first term wears no ال, it is understood as definite through its partner: كِتَابُ الطَّالِبِ means THE book of the student.",
     "Best of all, iḍāfa chains. 'The door of the teacher's house' is بَابُ بَيْتِ الْمُعَلِّمِ: each middle link is at once possessed and possessor, so it drops its ال and stands in jarr, and only the final noun may carry the article. Once your eye learns to spot a noun stripped of both ال and tanwīn, you will read these chains as effortlessly as any native of Baghdad or Cordoba once did."
    ],
    "examples": [
     {
      "ar": "كِتَابُ الطَّالِبِ جَدِيدٌ",
      "translit": "kitābu aṭ-ṭālibi jadīdun",
      "en": "The student's book is new.",
      "note": "First term: no ال, no tanwīn; second term in jarr with kasra."
     },
     {
      "ar": "بَابُ الْمَسْجِدِ مَفْتُوحٌ",
      "translit": "bābu al-masjidi maftūḥun",
      "en": "The door of the mosque is open.",
      "note": "The iḍāfa as a whole is definite, so the khabar مَفْتُوحٌ stays indefinite - a complete nominal sentence."
     },
     {
      "ar": "رَبُّ الْعَالَمِينَ",
      "translit": "rabbu al-ʿālamīna",
      "en": "Lord of the worlds.",
      "note": "Qurʾānic iḍāfa; jarr on a sound masculine plural appears as the ending ـِينَ."
     },
     {
      "ar": "بَابُ بَيْتِ الْمُعَلِّمِ",
      "translit": "bābu bayti al-muʿallimi",
      "en": "The door of the teacher's house.",
      "note": "A chain: بَيْتِ is possessor of بَابُ and possessed of الْمُعَلِّمِ, so it is in jarr with no ال."
     },
     {
      "ar": "رَأَيْتُ كِتَابَ الْمُعَلِّمِ",
      "translit": "raʾaytu kitāba al-muʿallimi",
      "en": "I saw the teacher's book.",
      "note": "The first term takes the sentence's case (here naṣb -a as object); the second stays in jarr."
     }
    ],
    "quiz": [
     {
      "q": "Which is the correct way to say 'the student's book'?",
      "options": [
       "الْكِتَابُ الطَّالِبِ",
       "كِتَابٌ الطَّالِبِ",
       "كِتَابُ الطَّالِبِ",
       "كِتَابُ الطَّالِبُ"
      ],
      "answer": 2,
      "why": "First term bare of ال and tanwīn, second term definite and in jarr."
     },
     {
      "q": "The first term of an iḍāfa never takes:",
      "options": [
       "A case ending",
       "ال or tanwīn",
       "A long vowel",
       "A feminine ending"
      ],
      "answer": 1,
      "why": "It is stripped of both the article and tanwīn, though it still inflects for case."
     },
     {
      "q": "What case does the second term of an iḍāfa (the possessor) take?",
      "options": [
       "rafʿ",
       "naṣb",
       "jarr",
       "It is uninflected"
      ],
      "answer": 2,
      "why": "The possessor always stands in jarr: كِتَابُ الطَّالِبِ."
     },
     {
      "q": "In بَابُ بَيْتِ الْمُعَلِّمِ ('the door of the teacher's house'), why is بَيْتِ in jarr with no ال?",
      "options": [
       "It is the object of a verb",
       "It is at once possessor of بَابُ and possessed of الْمُعَلِّمِ",
       "It is indefinite",
       "Words after بَابُ always take kasra"
      ],
      "answer": 1,
      "why": "Middle links of an iḍāfa chain take jarr as possessors yet drop ال as possessed terms."
     },
     {
      "q": "Even without ال, the first term of كِتَابُ الطَّالِبِ is understood as:",
      "options": [
       "Indefinite: 'a book of the student'",
       "Definite through the iḍāfa: 'the book of the student'",
       "A verb",
       "Dual"
      ],
      "answer": 1,
      "why": "Annexation to a definite noun makes the whole phrase definite - which is exactly why the first term may not add ال."
     }
    ]
   },
   {
    "id": "g7",
    "title": "Prepositions & the Genitive",
    "titleAr": "حُرُوفُ الْجَرِّ",
    "tagline": "Eight tiny words that bend every noun they touch.",
    "body": [
     "Meet the eight little words that govern more Arabic than any others: فِي (in), مِنْ (from), إِلَى (to), عَلَى (on), عَنْ (about, away from), بِـ (with, by), لِـ (for, belonging to), and كَـ (like). The grammarians call them حُرُوفُ الْجَرِّ, the particles of jarr, because they drag every noun that follows them into the genitive case. No exceptions, ever — this is one of the most reliable rules in the entire language.",
     "So the noun after a preposition ends in kasra, or tanwin kasr if it is indefinite: فِي الْبَيْتِ (in the house), مِنْ رَجُلٍ (from a man). The one-letter prepositions بِـ and لِـ and كَـ can never stand alone; they attach directly to their noun: بِالْقَلَمِ (with the pen). With لِـ the alif of the definite article drops away entirely: لِلرَّجُلِ (for the man), and the majestic لِلَّهِ (belonging to God). One small sound rule: since مِنْ ends in sukun, it takes a helping fatha before the article — مِنَ الْبَيْتِ.",
     "Prepositions also merge with the pronoun suffixes: لَهُ (for him), مِنْهُ (from him), فِيهِ (in it), بِهِ (by it). Watch what happens with إِلَى and عَلَى — their final alif turns into a ya: إِلَيْهِ, عَلَيْهِ. And whenever the suffix ـهُ follows a kasra or a ya, its damma politely turns into a kasra: بِهِ not بِهُ, فِيهِ not فِيهُ. Master these small fusions and half of any classical page will suddenly parse itself."
    ],
    "examples": [
     {
      "ar": "الْوَلَدُ فِي الْمَسْجِدِ",
      "translit": "al-waladu fī l-masjidi",
      "en": "The boy is in the mosque.",
      "note": "After فِي the noun takes jarr: the kasra on الْمَسْجِدِ."
     },
     {
      "ar": "خَرَجَ الرَّجُلُ مِنَ الْبَيْتِ إِلَى السُّوقِ",
      "translit": "kharaja r-rajulu mina l-bayti ilā s-sūqi",
      "en": "The man went out of the house to the market.",
      "note": "مِنْ becomes مِنَ before the article; both الْبَيْتِ and السُّوقِ are majrūr."
     },
     {
      "ar": "كَتَبَ بِالْقَلَمِ عَلَى الْوَرَقِ",
      "translit": "kataba bi-l-qalami ʿalā l-waraqi",
      "en": "He wrote with the pen on the paper.",
      "note": "The one-letter بِـ attaches directly to its noun; both nouns end in kasra."
     },
     {
      "ar": "الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ",
      "translit": "al-ḥamdu li-llāhi rabbi l-ʿālamīna",
      "en": "Praise belongs to God, Lord of the worlds.",
      "note": "لِـ swallows the article's alif, giving لِلَّهِ; رَبِّ follows it in jarr."
     },
     {
      "ar": "ذَهَبْتُ إِلَيْهِ وَأَخَذْتُ مِنْهُ كِتَابًا",
      "translit": "dhahabtu ilayhi wa-akhadhtu minhu kitāban",
      "en": "I went to him and took a book from him.",
      "note": "إِلَى + هُ becomes إِلَيْهِ — the alif turns to ya, and ـهُ shifts to ـهِ after it."
     }
    ],
    "quiz": [
     {
      "q": "In مِنَ الْمَدِينَةِ ('from the city'), what case is الْمَدِينَةِ in?",
      "options": [
       "Raf' (nominative)",
       "Nasb (accusative)",
       "Jarr (genitive)",
       "Jazm"
      ],
      "answer": 2,
      "why": "Every noun after a preposition takes jarr — the rule has no exceptions."
     },
     {
      "q": "Which is the correct form of 'in the house'?",
      "options": [
       "فِي الْبَيْتُ",
       "فِي الْبَيْتَ",
       "فِي الْبَيْتِ",
       "فِي الْبَيْتٍ"
      ],
      "answer": 2,
      "why": "فِي forces jarr, so the noun ends in kasra; a definite noun can never carry tanwin."
     },
     {
      "q": "What is the correct combination of عَلَى + هُ ('on him')?",
      "options": [
       "عَلَاهُ",
       "عَلَيْهُ",
       "عَلَيْهِ",
       "عَلَهُ"
      ],
      "answer": 2,
      "why": "The alif of عَلَى becomes ya before a suffix, and ـهُ shifts to ـهِ after that ya."
     },
     {
      "q": "Why is مِنْ written مِنَ in مِنَ الْبَيْتِ?",
      "options": [
       "مِنْ always ends in fatha",
       "A helping fatha breaks the cluster of two sukūns before the article",
       "Because الْبَيْت is masculine",
       "The fatha marks nasb on مِنْ"
      ],
      "answer": 1,
      "why": "مِنْ ends in sukun and the article begins with one, so a helping fatha is inserted."
     },
     {
      "q": "Which is the correct way to write لِـ + اللَّه ('belonging to God')?",
      "options": [
       "لِلَّهِ",
       "لِاللَّهِ",
       "لِاللَّهُ",
       "لَللَّهِ"
      ],
      "answer": 0,
      "why": "With لِـ the article's alif drops, and the noun after the preposition takes jarr: لِلَّهِ."
     }
    ]
   },
   {
    "id": "g8",
    "title": "The Verbal Sentence",
    "titleAr": "الْجُمْلَةُ الْفِعْلِيَّةُ",
    "tagline": "Verb first: the sentence order Arabic was born with.",
    "body": [
     "Classical Arabic loves to lead with the action. The default sentence begins with a verb, then names its doer, then its object: كَتَبَ الْوَلَدُ الدَّرْسَ — 'the boy wrote the lesson', literally 'wrote the-boy the-lesson'. This verb–subject–object order is the heartbeat of classical prose, and the subject (الْفَاعِل) always stands in raf': الْوَلَدُ.",
     "Now for one of the most elegant surprises in the language. When the verb comes first, it agrees with its subject in gender but stays singular no matter how many people act: كَتَبَ الرِّجَالُ — 'the men wrote' — with the verb in the singular, not كَتَبُوا الرِّجَالُ. A feminine subject takes a feminine verb, still singular: قَرَأَتِ النِّسَاءُ 'the women read'. The plural marking on the verb only appears when the subject comes first or is left unspoken.",
     "The object (الْمَفْعُول بِهِ) takes nasb: a fatha, or tanwin fath on an indefinite noun — كَتَبَ الطَّالِبُ رِسَالَةً 'the student wrote a letter'. And here is the payoff of the case system: because raf' marks the doer and nasb marks the done-to, the words can trade places without confusion. Case endings, not word order, tell you who did what to whom."
    ],
    "examples": [
     {
      "ar": "كَتَبَ الْوَلَدُ الدَّرْسَ",
      "translit": "kataba l-waladu d-darsa",
      "en": "The boy wrote the lesson.",
      "note": "The classic shape: verb, then subject in raf', then object in nasb."
     },
     {
      "ar": "قَرَأَتِ الْبِنْتُ الْكِتَابَ",
      "translit": "qaraʾati l-bintu l-kitāba",
      "en": "The girl read the book.",
      "note": "Feminine subject, so the verb takes ـتْ; that tāʾ takes a kasra before the article."
     },
     {
      "ar": "خَرَجَ الرِّجَالُ مِنَ الْمَسْجِدِ",
      "translit": "kharaja r-rijālu mina l-masjidi",
      "en": "The men went out of the mosque.",
      "note": "Plural subject, but the fronted verb stays singular: خَرَجَ, not خَرَجُوا."
     },
     {
      "ar": "سَمِعَتِ النِّسَاءُ الْخَبَرَ",
      "translit": "samiʿati n-nisāʾu l-khabara",
      "en": "The women heard the news.",
      "note": "Feminine plural subject takes a feminine singular verb before it."
     },
     {
      "ar": "نَصَرَ اللَّهُ الْمُؤْمِنِينَ",
      "translit": "naṣara llāhu l-muʾminīna",
      "en": "God gave the believers victory.",
      "note": "The object الْمُؤْمِنِينَ shows nasb with ـِينَ, the sound masculine plural ending."
     }
    ],
    "quiz": [
     {
      "q": "What is the default word order of the Classical Arabic verbal sentence?",
      "options": [
       "Subject – Verb – Object",
       "Verb – Subject – Object",
       "Verb – Object – Subject",
       "Subject – Object – Verb"
      ],
      "answer": 1,
      "why": "The verbal sentence leads with the verb, then the doer in raf', then the object in nasb."
     },
     {
      "q": "Which is the correct way to say 'The men wrote' with the verb first?",
      "options": [
       "كَتَبَ الرِّجَالُ",
       "كَتَبُوا الرِّجَالُ",
       "كَتَبَا الرِّجَالُ",
       "كَتَبْنَ الرِّجَالُ"
      ],
      "answer": 0,
      "why": "A verb before its subject stays singular even when the subject is plural."
     },
     {
      "q": "In كَتَبَ الْوَلَدُ الدَّرْسَ, what case is the object الدَّرْسَ in?",
      "options": [
       "Raf' (nominative)",
       "Nasb (accusative)",
       "Jarr (genitive)",
       "Jazm"
      ],
      "answer": 1,
      "why": "The direct object (الْمَفْعُول بِهِ) always takes nasb, shown here by the fatha."
     },
     {
      "q": "Which verb correctly completes: ___ فَاطِمَةُ الْقُرْآنَ ('Fatima read the Quran')?",
      "options": [
       "قَرَأَ",
       "قَرَأَتْ",
       "قَرَأْنَ",
       "قَرَؤُوا"
      ],
      "answer": 1,
      "why": "The verb agrees in gender with فَاطِمَةُ, so it takes the feminine ـتْ while staying singular."
     },
     {
      "q": "In كَتَبَ الطَّالِبُ رِسَالَةً, why does رِسَالَةً end in -an?",
      "options": [
       "Because it is the subject of the sentence",
       "Because an indefinite direct object takes tanwīn fatḥ to mark nasb",
       "Because every noun after a verb takes fatha",
       "Because feminine nouns always end in -an"
      ],
      "answer": 1,
      "why": "رِسَالَةً is the indefinite object, so nasb appears as tanwin fath."
     }
    ]
   },
   {
    "id": "g9",
    "title": "Attached Pronouns",
    "titleAr": "الضَّمَائِرُ الْمُتَّصِلَةُ",
    "tagline": "One letter at the end changes everything: my, your, his, her.",
    "body": [
     "Arabic rarely uses separate words for 'my', 'him', or 'her'. Instead it glues short pronoun suffixes onto the ends of words: ـِي (my/me), ـكَ (your, masc.), ـكِ (your, fem.), ـهُ (his/him), ـهَا (her), ـنَا (our/us), ـكُمْ (your, pl.), ـهُمْ (their/them). One tiny ending, and a whole word of meaning appears.",
     "These suffixes live in three homes, and the home decides the meaning. On a noun, the suffix is a possessor — كِتَابِي 'my book', كِتَابُهُ 'his book' — and grammatically this is an idafa, so the noun loses its tanwin while keeping its case vowel before the suffix: كِتَابُهُ, كِتَابَهُ, كِتَابِهِ. Only ـِي is greedy: it swallows the case vowel entirely, so 'my book' is always كِتَابِي. On a verb, the suffix is the object: رَأَيْتُهُ 'I saw him'. On a preposition, it completes the phrase: لَهُ 'for him', مِنْهَا 'from her'.",
     "One golden sound rule ties this together: the damma of ـهُ (and of ـهُمْ, ـهُمَا, ـهُنَّ) turns to kasra whenever a kasra or a ya comes right before it. That is why we say بِهِ, فِيهِ, عَلَيْهِ, إِلَيْهِ — never بِهُ or فِيهُ. Say the pairs aloud a few times and your tongue will learn the rule before your eyes do."
    ],
    "examples": [
     {
      "ar": "كِتَابُكَ جَدِيدٌ",
      "translit": "kitābuka jadīdun",
      "en": "Your book is new.",
      "note": "On a noun the suffix marks the possessor; the raf' damma stands before ـكَ."
     },
     {
      "ar": "رَأَيْتُهُ فِي الْمَسْجِدِ",
      "translit": "raʾaytuhu fī l-masjidi",
      "en": "I saw him in the mosque.",
      "note": "On a verb the suffix ـهُ is the direct object."
     },
     {
      "ar": "أَخَذْتُ قَلَمِي مِنْهَا",
      "translit": "akhadhtu qalamī minhā",
      "en": "I took my pen from her.",
      "note": "ـِي 'my' replaces the case vowel on قَلَم; مِنْ + هَا fuses into مِنْهَا."
     },
     {
      "ar": "مَرَرْتُ بِهِ وَبِأَخِيهِ",
      "translit": "marartu bihi wa-bi-akhīhi",
      "en": "I passed by him and by his brother.",
      "note": "ـهُ becomes ـهِ after a kasra (بِهِ) and after a ya (أَخِيهِ)."
     },
     {
      "ar": "نَظَرْتُ إِلَيْهِ فَسَلَّمْتُ عَلَيْهِ",
      "translit": "naẓartu ilayhi fa-sallamtu ʿalayhi",
      "en": "I looked at him, then greeted him.",
      "note": "إِلَى and عَلَى become إِلَيْـ and عَلَيْـ before suffixes, and hu shifts to hi after the ya."
     }
    ],
    "quiz": [
     {
      "q": "Which form means 'his book'?",
      "options": [
       "كِتَابُهُ",
       "كِتَابُهَا",
       "كِتَابُكَ",
       "كِتَابِي"
      ],
      "answer": 0,
      "why": "ـهُ is the third person masculine suffix: كِتَابُهُ 'his book'."
     },
     {
      "q": "In رَأَيْتُهُ ('I saw him'), what is the function of ـهُ?",
      "options": [
       "Possessor of the verb",
       "Direct object of the verb",
       "Subject of the verb",
       "A preposition"
      ],
      "answer": 1,
      "why": "A pronoun suffix attached to a verb is its object; the subject here is the ـتُ 'I'."
     },
     {
      "q": "Why does Arabic say بِهِ rather than بِهُ?",
      "options": [
       "Because the verb before it requires kasra",
       "Because ـهُ shifts to ـهِ after a kasra or a yāʾ",
       "Because ـهِ is a different pronoun meaning 'her'",
       "Because بِ puts sukūn on what follows"
      ],
      "answer": 1,
      "why": "The kasra of بِ triggers the shift of the suffix's damma to kasra."
     },
     {
      "q": "What is the correct combination of فِي + هُ ('in it')?",
      "options": [
       "فِيهُ",
       "فِيهِ",
       "فِيهَا",
       "فَاهُ"
      ],
      "answer": 1,
      "why": "After the ya of فِي, the suffix ـهُ becomes ـهِ: فِيهِ."
     },
     {
      "q": "Which is the correct form of 'my house'?",
      "options": [
       "بَيْتِي",
       "بَيْتُي",
       "بَيْتِهِ",
       "بَيْتُنَا"
      ],
      "answer": 0,
      "why": "The suffix ـِي swallows the case vowel, so the noun ends in kasra plus ya: بَيْتِي."
     }
    ]
   },
   {
    "id": "g10",
    "title": "Inna, Kāna & their Sisters",
    "titleAr": "إِنَّ وَكَانَ وَأَخَوَاتُهُمَا",
    "tagline": "Two famous families walk into a nominal sentence — and change its cases.",
    "body": [
     "A plain nominal sentence keeps both of its parts in raf': الْبَيْتُ كَبِيرٌ 'the house is big'. But two celebrated families of words love to walk in and rearrange the cases, each in its own mirror-image way. Learn their signatures and you will read classical texts with new eyes.",
     "The first family is led by إِنَّ, the particle of emphasis: 'truly, indeed'. إِنَّ pushes the subject into nasb while the predicate stays in raf': إِنَّ الْبَيْتَ كَبِيرٌ 'truly the house is big'. In the most famous sentence pattern of all: إِنَّ اللَّهَ غَفُورٌ رَحِيمٌ. Her sisters govern the same way: أَنَّ 'that', لَكِنَّ 'but', and لِأَنَّ 'because'.",
     "The second family is led by the verb كَانَ 'was'. It does the exact opposite: its subject stays in raf', but its predicate drops into nasb: كَانَ الْبَيْتُ كَبِيرًا 'the house was big'. Its sisters include لَيْسَ 'is not', أَصْبَحَ 'became (in the morning)', and صَارَ 'became'. All of them keep the doer in raf' and put the predicate in nasb.",
     "A memory trick the classical students loved: إِنَّ seizes the first word, كَانَ seizes the second. Spot which family opens the sentence, and the two case endings fall into place by themselves."
    ],
    "examples": [
     {
      "ar": "إِنَّ اللَّهَ غَفُورٌ رَحِيمٌ",
      "translit": "inna llāha ghafūrun raḥīmun",
      "en": "Truly God is Forgiving, Merciful.",
      "note": "إِنَّ puts its subject اللَّهَ in nasb; the predicate stays raf' with tanwin damm."
     },
     {
      "ar": "كَانَ عُمَرُ عَادِلًا",
      "translit": "kāna ʿumaru ʿādilan",
      "en": "Umar was just.",
      "note": "كَانَ keeps its subject in raf' and puts the predicate عَادِلًا in nasb."
     },
     {
      "ar": "لَيْسَتِ الدُّنْيَا دَارَ بَقَاءٍ",
      "translit": "laysati d-dunyā dāra baqāʾin",
      "en": "This world is not an abode of permanence.",
      "note": "لَيْسَ works exactly like كَانَ: the predicate دَارَ takes nasb."
     },
     {
      "ar": "صَارَ التِّلْمِيذُ عَالِمًا",
      "translit": "ṣāra t-tilmīdhu ʿāliman",
      "en": "The pupil became a scholar.",
      "note": "صَارَ 'became' follows the كَانَ pattern: raf' subject, nasb predicate."
     },
     {
      "ar": "عَلِمْتُ أَنَّ الصِّدْقَ نَجَاةٌ",
      "translit": "ʿalimtu anna ṣ-ṣidqa najātun",
      "en": "I learned that truthfulness is salvation.",
      "note": "أَنَّ 'that' governs just like her sister إِنَّ: nasb subject, raf' predicate."
     }
    ],
    "quiz": [
     {
      "q": "After إِنَّ, what case does the subject take?",
      "options": [
       "Raf' (nominative)",
       "Nasb (accusative)",
       "Jarr (genitive)",
       "It keeps whatever case it had"
      ],
      "answer": 1,
      "why": "إِنَّ and her sisters put the subject in nasb while the predicate stays raf'."
     },
     {
      "q": "Which word correctly completes كَانَ الْوَلَدُ ___ ('The boy was small')?",
      "options": [
       "صَغِيرٌ",
       "صَغِيرًا",
       "صَغِيرٍ",
       "صَغِيرُ"
      ],
      "answer": 1,
      "why": "The predicate of كَانَ takes nasb: tanwin fath on صَغِيرًا."
     },
     {
      "q": "Which word correctly completes إِنَّ ___ وَاسِعٌ ('Truly the house is spacious')?",
      "options": [
       "الْبَيْتُ",
       "الْبَيْتَ",
       "الْبَيْتِ",
       "بَيْتٌ"
      ],
      "answer": 1,
      "why": "The subject of إِنَّ takes nasb, so the definite noun ends in fatha: الْبَيْتَ."
     },
     {
      "q": "Which sister of إِنَّ means 'but'?",
      "options": [
       "أَنَّ",
       "لَكِنَّ",
       "لِأَنَّ",
       "لَيْسَ"
      ],
      "answer": 1,
      "why": "لَكِنَّ means 'but' and governs like إِنَّ; لَيْسَ belongs to the كَانَ family."
     },
     {
      "q": "In لَيْسَ الْأَمْرُ سَهْلًا ('The matter is not easy'), why does سَهْلًا take nasb?",
      "options": [
       "It is the direct object of a verb of seeing",
       "It is the predicate of لَيْسَ, which governs like كَانَ",
       "It is an adverb of time",
       "Everything after لَيْسَ takes nasb"
      ],
      "answer": 1,
      "why": "لَيْسَ is a sister of كَانَ: subject raf' (الْأَمْرُ), predicate nasb (سَهْلًا)."
     }
    ]
   },
   {
    "id": "g11",
    "title": "Pointing & Connecting",
    "titleAr": "أَسْمَاءُ الْإِشَارَةِ وَالْمَوْصُولُ",
    "tagline": "Point at anything, connect any two ideas — with a handful of words.",
    "body": [
     "To point at things, Arabic gives you a small elegant set of demonstratives. For what is near: هَذَا (this, masc.), هَذِهِ (this, fem.), and هَؤُلَاءِ (these, for people). For what is far: ذَلِكَ (that, masc.), تِلْكَ (that, fem.), and أُولَئِكَ (those, for people). Six words, and you can point at anything in creation.",
     "Now the distinction that unlocks countless classical sentences. هَذَا كِتَابٌ, with an indefinite noun, is a complete sentence: 'This is a book.' But هَذَا الْكِتَابُ, with a definite noun, is not a sentence at all — it is one phrase, 'this book', still waiting for its predicate: هَذَا الْكِتَابُ نَافِعٌ 'this book is useful'. Definite or indefinite after the demonstrative — that single choice decides whether you have said something or merely pointed.",
     "To connect a description to a definite noun, Arabic uses the relative pronouns (الْأَسْمَاء الْمَوْصُولَة): الَّذِي (who/which, masc.), الَّتِي (fem.), الَّذِينَ (masc. plural). The clause that follows must contain a pronoun reaching back to the noun — the grammarians call it الْعَائِد, 'the returner': الرَّجُلُ الَّذِي رَأَيْتُهُ 'the man whom I saw him', as Arabic literally puts it. That little ـهُ is the thread that ties the clause to its noun."
    ],
    "examples": [
     {
      "ar": "هَذَا كِتَابٌ نَافِعٌ",
      "translit": "hādhā kitābun nāfiʿun",
      "en": "This is a useful book.",
      "note": "Indefinite noun after the demonstrative: a complete sentence, 'this is...'."
     },
     {
      "ar": "هَذَا الْكِتَابُ نَافِعٌ",
      "translit": "hādhā l-kitābu nāfiʿun",
      "en": "This book is useful.",
      "note": "Definite noun: هَذَا الْكِتَابُ is one phrase 'this book', and نَافِعٌ is the predicate."
     },
     {
      "ar": "تِلْكَ الْمَدِينَةُ بَعِيدَةٌ",
      "translit": "tilka l-madīnatu baʿīdatun",
      "en": "That city is far away.",
      "note": "تِلْكَ points at something far and feminine."
     },
     {
      "ar": "جَاءَ الرَّجُلُ الَّذِي رَأَيْتُهُ أَمْسِ",
      "translit": "jāʾa r-rajulu lladhī raʾaytuhu amsi",
      "en": "The man whom I saw yesterday came.",
      "note": "الَّذِي follows a definite noun; the ـهُ in رَأَيْتُهُ is the returning pronoun."
     },
     {
      "ar": "أُولَئِكَ هُمُ الْمُفْلِحُونَ",
      "translit": "ulāʾika humu l-mufliḥūna",
      "en": "Those — they are the successful.",
      "note": "أُولَئِكَ for distant people; the pronoun هُمُ separates subject from definite predicate."
     }
    ],
    "quiz": [
     {
      "q": "The demonstrative هَذِهِ is used for what kind of noun?",
      "options": [
       "Near masculine singular",
       "Near feminine singular",
       "Far feminine singular",
       "Near plural persons"
      ],
      "answer": 1,
      "why": "هَذِهِ points at a near feminine noun; the far feminine is تِلْكَ."
     },
     {
      "q": "What does هَذَا بَيْتٌ mean?",
      "options": [
       "'This is a house.' — a complete sentence",
       "'This house' — a phrase still needing a predicate",
       "'That is a house.'",
       "'The house is here.'"
      ],
      "answer": 0,
      "why": "An indefinite noun after the demonstrative makes a full sentence: 'this is a house'."
     },
     {
      "q": "Which relative pronoun correctly describes الرِّجَالُ ('the men')?",
      "options": [
       "الَّذِي",
       "الَّتِي",
       "الَّذِينَ",
       "تِلْكَ"
      ],
      "answer": 2,
      "why": "الَّذِينَ is the masculine plural relative pronoun: الرِّجَالُ الَّذِينَ..."
     },
     {
      "q": "Which word means 'that' for a far masculine singular noun?",
      "options": [
       "هَذَا",
       "ذَلِكَ",
       "تِلْكَ",
       "أُولَئِكَ"
      ],
      "answer": 1,
      "why": "ذَلِكَ is the far masculine singular demonstrative; تِلْكَ is its feminine partner."
     },
     {
      "q": "In الْكِتَابُ الَّذِي قَرَأْتُهُ ('the book that I read'), what is the role of ـهُ in قَرَأْتُهُ?",
      "options": [
       "An object marker with no reference",
       "The returning pronoun (الْعَائِد) referring back to الْكِتَابُ",
       "A possessive meaning 'his'",
       "The subject of the verb"
      ],
      "answer": 1,
      "why": "The relative clause must contain a pronoun that returns to the described noun."
     }
    ]
   },
   {
    "id": "g12",
    "title": "Dual & Plurals",
    "titleAr": "الْمُثَنَّى وَالْجُمُوعُ",
    "tagline": "Two is its own number, and plurals play by beautiful rules.",
    "body": [
     "Arabic counts in three numbers, not two: singular, dual, and plural. The dual is made with an ending, never a separate word: ـَانِ in raf' and ـَيْنِ in nasb and jarr. So 'two books' is كِتَابَانِ as a subject, but كِتَابَيْنِ after a verb or a preposition. Two endings, one graceful system.",
     "For plurals of people, Arabic has two 'sound' plurals that leave the word intact and add an ending. The sound masculine plural: ـُونَ in raf', ـِينَ in nasb and jarr — الْمُعَلِّمُونَ 'the teachers' as subject, الْمُعَلِّمِينَ elsewhere. The sound feminine plural adds ـَات: مُسْلِمَة becomes مُسْلِمَات. Watch its quirk: in nasb it takes kasra, never fatha — رَأَيْتُ الْمُسْلِمَاتِ 'I saw the Muslim women'.",
     "But most Arabic nouns form 'broken' plurals: the word itself is reshaped from within, its root poured into a new pattern. So كِتَاب becomes كُتُب, رَجُل becomes رِجَال, and بَيْت becomes بُيُوت. These must be learned word by word, but the patterns soon become old friends.",
     "And now one of the great secrets of Arabic grammar: plurals of non-human things are treated as feminine singular. Books, houses, and mountains, however many, take the agreement of a single 'she': الْكُتُبُ قَدِيمَةٌ 'the books are old', الْجِبَالُ عَالِيَةٌ 'the mountains are high'. Internalize this rule and whole pages of classical prose will suddenly agree with you."
    ],
    "examples": [
     {
      "ar": "جَاءَ الرَّجُلَانِ وَرَأَيْتُ الرَّجُلَيْنِ",
      "translit": "jāʾa r-rajulāni wa-raʾaytu r-rajulayni",
      "en": "The two men came, and I saw the two men.",
      "note": "The dual: ـَانِ in raf', ـَيْنِ in nasb (and jarr)."
     },
     {
      "ar": "الْمُؤْمِنُونَ صَادِقُونَ",
      "translit": "al-muʾminūna ṣādiqūna",
      "en": "The believers are truthful.",
      "note": "Sound masculine plural in raf': the ending ـُونَ on subject and predicate."
     },
     {
      "ar": "سَلَّمْتُ عَلَى الْمُعَلِّمِينَ",
      "translit": "sallamtu ʿalā l-muʿallimīna",
      "en": "I greeted the teachers.",
      "note": "After the preposition the sound masculine plural shows jarr with ـِينَ."
     },
     {
      "ar": "الْمُسْلِمَاتُ صَالِحَاتٌ",
      "translit": "al-muslimātu ṣāliḥātun",
      "en": "The Muslim women are righteous.",
      "note": "Sound feminine plural in ـَات; in nasb it would take kasra, never fatha."
     },
     {
      "ar": "الْجِبَالُ عَالِيَةٌ",
      "translit": "al-jibālu ʿāliyatun",
      "en": "The mountains are high.",
      "note": "جِبَال is a broken plural of جَبَل; being non-human, it takes feminine singular agreement."
     }
    ],
    "quiz": [
     {
      "q": "What is the dual of كِتَاب ('book') as the subject of a sentence?",
      "options": [
       "كِتَابَانِ",
       "كِتَابَيْنِ",
       "كُتُبٌ",
       "كِتَابُونَ"
      ],
      "answer": 0,
      "why": "The dual takes ـَانِ in raf'; ـَيْنِ appears only in nasb and jarr."
     },
     {
      "q": "In رَأَيْتُ الْمُعَلِّمِينَ ('I saw the teachers'), why the ending ـِينَ?",
      "options": [
       "It marks jarr only",
       "The sound masculine plural uses ـِينَ for both nasb and jarr",
       "It is a dual ending",
       "All plural nouns end in ـِينَ"
      ],
      "answer": 1,
      "why": "ـُونَ is the raf' form; ـِينَ serves as both the nasb and jarr form."
     },
     {
      "q": "What is the broken plural of رَجُل ('man')?",
      "options": [
       "رَجُلُونَ",
       "رِجَال",
       "رَجُلَانِ",
       "رَجُلَات"
      ],
      "answer": 1,
      "why": "رَجُل reshapes internally to رِجَال; it never takes the sound plural endings."
     },
     {
      "q": "Which sentence correctly says 'The houses are big'?",
      "options": [
       "الْبُيُوتُ كَبِيرَةٌ",
       "الْبُيُوتُ كَبِيرٌ",
       "الْبُيُوتُ كَبِيرُونَ",
       "الْبُيُوتُ كَبِيرَانِ"
      ],
      "answer": 0,
      "why": "Non-human plurals take feminine singular agreement: كَبِيرَةٌ."
     },
     {
      "q": "In إِنَّ الْمُسْلِمَاتِ صَادِقَاتٌ, why does الْمُسْلِمَاتِ end in kasra?",
      "options": [
       "Because it is in jarr after a preposition",
       "Because the sound feminine plural marks nasb with kasra instead of fatha",
       "Because إِنَّ requires jarr",
       "The sentence contains an error"
      ],
      "answer": 1,
      "why": "The subject of إِنَّ is in nasb, and the sound feminine plural shows nasb with kasra."
     }
    ]
   }
  ];

  var TEXTS = /*@DATA:TEXTS*/[
   {
    "id": "fatiha",
    "title": "The Opening",
    "titleAr": "سُورَةُ الْفَاتِحَةِ",
    "source": "Qurʾān, sūra 1",
    "kind": "quran",
    "intro": "The opening chapter of the Qurʾān, recited in every unit of the daily prayers and long cherished as the essence of the whole book.",
    "lines": [
     {
      "ar": "بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ",
      "translit": "bismi llāhi r-raḥmāni r-raḥīm",
      "en": "In the name of God, the Most Gracious, the Most Merciful.",
      "ref": "1:1",
      "words": [
       {
        "ar": "بِسْمِ",
        "en": "in-the-name-of"
       },
       {
        "ar": "اللَّهِ",
        "en": "God"
       },
       {
        "ar": "الرَّحْمَنِ",
        "en": "the-Most-Gracious"
       },
       {
        "ar": "الرَّحِيمِ",
        "en": "the-Most-Merciful"
       }
      ]
     },
     {
      "ar": "الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ",
      "translit": "al-ḥamdu li-llāhi rabbi l-ʿālamīn",
      "en": "Praise belongs to God, Lord of the worlds.",
      "ref": "1:2",
      "words": [
       {
        "ar": "الْحَمْدُ",
        "en": "the-praise"
       },
       {
        "ar": "لِلَّهِ",
        "en": "belongs-to-God"
       },
       {
        "ar": "رَبِّ",
        "en": "Lord-of"
       },
       {
        "ar": "الْعَالَمِينَ",
        "en": "the-worlds"
       }
      ]
     },
     {
      "ar": "الرَّحْمَنِ الرَّحِيمِ",
      "translit": "ar-raḥmāni r-raḥīm",
      "en": "The Most Gracious, the Most Merciful.",
      "ref": "1:3",
      "words": [
       {
        "ar": "الرَّحْمَنِ",
        "en": "the-Most-Gracious"
       },
       {
        "ar": "الرَّحِيمِ",
        "en": "the-Most-Merciful"
       }
      ]
     },
     {
      "ar": "مَالِكِ يَوْمِ الدِّينِ",
      "translit": "māliki yawmi d-dīn",
      "en": "Master of the Day of Judgment.",
      "ref": "1:4",
      "words": [
       {
        "ar": "مَالِكِ",
        "en": "Master-of"
       },
       {
        "ar": "يَوْمِ",
        "en": "day-of"
       },
       {
        "ar": "الدِّينِ",
        "en": "the-judgment"
       }
      ]
     },
     {
      "ar": "إِيَّاكَ نَعْبُدُ وَإِيَّاكَ نَسْتَعِينُ",
      "translit": "iyyāka naʿbudu wa-iyyāka nastaʿīn",
      "en": "You alone we worship, and You alone we ask for help.",
      "ref": "1:5",
      "words": [
       {
        "ar": "إِيَّاكَ",
        "en": "You-alone"
       },
       {
        "ar": "نَعْبُدُ",
        "en": "we-worship"
       },
       {
        "ar": "وَإِيَّاكَ",
        "en": "and-You-alone"
       },
       {
        "ar": "نَسْتَعِينُ",
        "en": "we-ask-for-help"
       }
      ]
     },
     {
      "ar": "اِهْدِنَا الصِّرَاطَ الْمُسْتَقِيمَ",
      "translit": "ihdinā ṣ-ṣirāṭa l-mustaqīm",
      "en": "Guide us on the straight path.",
      "ref": "1:6",
      "words": [
       {
        "ar": "اِهْدِنَا",
        "en": "guide-us"
       },
       {
        "ar": "الصِّرَاطَ",
        "en": "the-path"
       },
       {
        "ar": "الْمُسْتَقِيمَ",
        "en": "the-straight"
       }
      ]
     },
     {
      "ar": "صِرَاطَ الَّذِينَ أَنْعَمْتَ عَلَيْهِمْ غَيْرِ الْمَغْضُوبِ عَلَيْهِمْ وَلَا الضَّالِّينَ",
      "translit": "ṣirāṭa lladhīna anʿamta ʿalayhim ghayri l-maghḍūbi ʿalayhim wa-lā ḍ-ḍāllīn",
      "en": "The path of those You have blessed, not of those who have earned anger, nor of those who go astray.",
      "ref": "1:7",
      "words": [
       {
        "ar": "صِرَاطَ",
        "en": "path-of"
       },
       {
        "ar": "الَّذِينَ",
        "en": "those-who"
       },
       {
        "ar": "أَنْعَمْتَ",
        "en": "You-bestowed-favor"
       },
       {
        "ar": "عَلَيْهِمْ",
        "en": "upon-them"
       },
       {
        "ar": "غَيْرِ",
        "en": "not-of"
       },
       {
        "ar": "الْمَغْضُوبِ",
        "en": "those-who-earned-anger"
       },
       {
        "ar": "عَلَيْهِمْ",
        "en": "upon-them"
       },
       {
        "ar": "وَلَا",
        "en": "and-not"
       },
       {
        "ar": "الضَّالِّينَ",
        "en": "those-who-go-astray"
       }
      ]
     }
    ]
   },
   {
    "id": "ikhlas",
    "title": "Pure Faith",
    "titleAr": "سُورَةُ الْإِخْلَاصِ",
    "source": "Qurʾān, sūra 112",
    "kind": "quran",
    "intro": "A short, powerful chapter declaring God's absolute oneness, said by the Prophet to equal a third of the Qurʾān.",
    "lines": [
     {
      "ar": "قُلْ هُوَ اللَّهُ أَحَدٌ",
      "translit": "qul huwa llāhu aḥad",
      "en": "Say: He is God, the One.",
      "ref": "112:1",
      "words": [
       {
        "ar": "قُلْ",
        "en": "say"
       },
       {
        "ar": "هُوَ",
        "en": "He-is"
       },
       {
        "ar": "اللَّهُ",
        "en": "God"
       },
       {
        "ar": "أَحَدٌ",
        "en": "One"
       }
      ]
     },
     {
      "ar": "اللَّهُ الصَّمَدُ",
      "translit": "allāhu ṣ-ṣamad",
      "en": "God, the Eternal Refuge.",
      "ref": "112:2",
      "words": [
       {
        "ar": "اللَّهُ",
        "en": "God"
       },
       {
        "ar": "الصَّمَدُ",
        "en": "the-Eternal-Refuge"
       }
      ]
     },
     {
      "ar": "لَمْ يَلِدْ وَلَمْ يُولَدْ",
      "translit": "lam yalid wa-lam yūlad",
      "en": "He neither begets nor was He begotten.",
      "ref": "112:3",
      "words": [
       {
        "ar": "لَمْ",
        "en": "not"
       },
       {
        "ar": "يَلِدْ",
        "en": "He-begets"
       },
       {
        "ar": "وَلَمْ",
        "en": "and-not"
       },
       {
        "ar": "يُولَدْ",
        "en": "He-was-begotten"
       }
      ]
     },
     {
      "ar": "وَلَمْ يَكُنْ لَهُ كُفُوًا أَحَدٌ",
      "translit": "wa-lam yakun lahu kufuwan aḥad",
      "en": "And there is none equal to Him.",
      "ref": "112:4",
      "words": [
       {
        "ar": "وَلَمْ",
        "en": "and-not"
       },
       {
        "ar": "يَكُنْ",
        "en": "there-is"
       },
       {
        "ar": "لَهُ",
        "en": "to-Him"
       },
       {
        "ar": "كُفُوًا",
        "en": "an-equal"
       },
       {
        "ar": "أَحَدٌ",
        "en": "anyone"
       }
      ]
     }
    ]
   },
   {
    "id": "proverbs",
    "title": "Classical Proverbs",
    "titleAr": "أَمْثَالٌ عَرَبِيَّةٌ",
    "source": "Classical proverbs",
    "kind": "proverbs",
    "intro": "Eight timeless Arabic maxims, polished by centuries of use, each one a complete lesson in a single line.",
    "lines": [
     {
      "ar": "الْعِلْمُ نُورٌ",
      "translit": "al-ʿilmu nūrun",
      "en": "Knowledge is light.",
      "ref": "proverb",
      "words": [
       {
        "ar": "الْعِلْمُ",
        "en": "the-knowledge"
       },
       {
        "ar": "نُورٌ",
        "en": "is-light"
       }
      ]
     },
     {
      "ar": "مَنْ جَدَّ وَجَدَ",
      "translit": "man jadda wajada",
      "en": "Whoever strives, finds.",
      "ref": "proverb",
      "words": [
       {
        "ar": "مَنْ",
        "en": "whoever"
       },
       {
        "ar": "جَدَّ",
        "en": "strives"
       },
       {
        "ar": "وَجَدَ",
        "en": "finds"
       }
      ]
     },
     {
      "ar": "الْوَقْتُ كَالسَّيْفِ إِنْ لَمْ تَقْطَعْهُ قَطَعَكَ",
      "translit": "al-waqtu ka-s-sayfi in lam taqṭaʿhu qaṭaʿaka",
      "en": "Time is like a sword: if you do not cut it, it cuts you.",
      "ref": "proverb",
      "words": [
       {
        "ar": "الْوَقْتُ",
        "en": "the-time"
       },
       {
        "ar": "كَالسَّيْفِ",
        "en": "is-like-the-sword"
       },
       {
        "ar": "إِنْ",
        "en": "if"
       },
       {
        "ar": "لَمْ",
        "en": "not"
       },
       {
        "ar": "تَقْطَعْهُ",
        "en": "you-cut-it"
       },
       {
        "ar": "قَطَعَكَ",
        "en": "it-cuts-you"
       }
      ]
     },
     {
      "ar": "خَيْرُ الْكَلَامِ مَا قَلَّ وَدَلَّ",
      "translit": "khayru l-kalāmi mā qalla wa-dalla",
      "en": "The best speech is that which is brief and clear.",
      "ref": "proverb",
      "words": [
       {
        "ar": "خَيْرُ",
        "en": "best-of"
       },
       {
        "ar": "الْكَلَامِ",
        "en": "the-speech"
       },
       {
        "ar": "مَا",
        "en": "is-that-which"
       },
       {
        "ar": "قَلَّ",
        "en": "is-brief"
       },
       {
        "ar": "وَدَلَّ",
        "en": "and-conveys-meaning"
       }
      ]
     },
     {
      "ar": "الصَّبْرُ مِفْتَاحُ الْفَرَجِ",
      "translit": "aṣ-ṣabru miftāḥu l-faraji",
      "en": "Patience is the key to relief.",
      "ref": "proverb",
      "words": [
       {
        "ar": "الصَّبْرُ",
        "en": "the-patience"
       },
       {
        "ar": "مِفْتَاحُ",
        "en": "is-the-key-of"
       },
       {
        "ar": "الْفَرَجِ",
        "en": "the-relief"
       }
      ]
     },
     {
      "ar": "رُبَّ أَخٍ لَكَ لَمْ تَلِدْهُ أُمُّكَ",
      "translit": "rubba akhin laka lam talid-hu ummuka",
      "en": "Many a brother you have whom your mother did not bear.",
      "ref": "proverb",
      "words": [
       {
        "ar": "رُبَّ",
        "en": "many-a"
       },
       {
        "ar": "أَخٍ",
        "en": "brother"
       },
       {
        "ar": "لَكَ",
        "en": "you-have"
       },
       {
        "ar": "لَمْ",
        "en": "not"
       },
       {
        "ar": "تَلِدْهُ",
        "en": "bore-him"
       },
       {
        "ar": "أُمُّكَ",
        "en": "your-mother"
       }
      ]
     },
     {
      "ar": "الْقَنَاعَةُ كَنْزٌ لَا يَفْنَى",
      "translit": "al-qanāʿatu kanzun lā yafnā",
      "en": "Contentment is a treasure that never perishes.",
      "ref": "proverb",
      "words": [
       {
        "ar": "الْقَنَاعَةُ",
        "en": "the-contentment"
       },
       {
        "ar": "كَنْزٌ",
        "en": "is-a-treasure"
       },
       {
        "ar": "لَا",
        "en": "not"
       },
       {
        "ar": "يَفْنَى",
        "en": "it-perishes"
       }
      ]
     },
     {
      "ar": "مَنْ صَبَرَ ظَفِرَ",
      "translit": "man ṣabara ẓafira",
      "en": "Whoever is patient triumphs.",
      "ref": "proverb",
      "words": [
       {
        "ar": "مَنْ",
        "en": "whoever"
       },
       {
        "ar": "صَبَرَ",
        "en": "is-patient"
       },
       {
        "ar": "ظَفِرَ",
        "en": "triumphs"
       }
      ]
     }
    ]
   },
   {
    "id": "wisdom",
    "title": "Lines of Wisdom",
    "titleAr": "أَبْيَاتُ الْحِكْمَةِ",
    "source": "The classical canon",
    "kind": "poetry",
    "intro": "Four celebrated single lines from the classical canon — a prophetic saying and three verses every educated Arabic reader knows by heart.",
    "lines": [
     {
      "ar": "طَلَبُ الْعِلْمِ فَرِيضَةٌ عَلَى كُلِّ مُسْلِمٍ",
      "translit": "ṭalabu l-ʿilmi farīḍatun ʿalā kulli muslimin",
      "en": "Seeking knowledge is an obligation upon every Muslim.",
      "ref": "ḥadīth - Ibn Māja",
      "words": [
       {
        "ar": "طَلَبُ",
        "en": "seeking-of"
       },
       {
        "ar": "الْعِلْمِ",
        "en": "the-knowledge"
       },
       {
        "ar": "فَرِيضَةٌ",
        "en": "is-an-obligation"
       },
       {
        "ar": "عَلَى",
        "en": "upon"
       },
       {
        "ar": "كُلِّ",
        "en": "every"
       },
       {
        "ar": "مُسْلِمٍ",
        "en": "Muslim"
       }
      ]
     },
     {
      "ar": "الْخَيْلُ وَاللَّيْلُ وَالْبَيْدَاءُ تَعْرِفُنِي وَالسَّيْفُ وَالرُّمْحُ وَالْقِرْطَاسُ وَالْقَلَمُ",
      "translit": "al-khaylu wa-l-laylu wa-l-baydāʾu taʿrifunī wa-s-sayfu wa-r-rumḥu wa-l-qirṭāsu wa-l-qalamu",
      "en": "The horses, the night, and the desert know me — and the sword, the spear, the paper, and the pen.",
      "ref": "al-Mutanabbī",
      "words": [
       {
        "ar": "الْخَيْلُ",
        "en": "the-horses"
       },
       {
        "ar": "وَاللَّيْلُ",
        "en": "and-the-night"
       },
       {
        "ar": "وَالْبَيْدَاءُ",
        "en": "and-the-desert"
       },
       {
        "ar": "تَعْرِفُنِي",
        "en": "know-me"
       },
       {
        "ar": "وَالسَّيْفُ",
        "en": "and-the-sword"
       },
       {
        "ar": "وَالرُّمْحُ",
        "en": "and-the-spear"
       },
       {
        "ar": "وَالْقِرْطَاسُ",
        "en": "and-the-paper"
       },
       {
        "ar": "وَالْقَلَمُ",
        "en": "and-the-pen"
       }
      ]
     },
     {
      "ar": "نَعِيبُ زَمَانَنَا وَالْعَيْبُ فِينَا وَمَا لِزَمَانِنَا عَيْبٌ سِوَانَا",
      "translit": "naʿību zamānanā wa-l-ʿaybu fīnā wa-mā li-zamāninā ʿaybun siwānā",
      "en": "We blame our times, though the fault lies in us; our times have no fault except us.",
      "ref": "al-Imām ash-Shāfiʿī",
      "words": [
       {
        "ar": "نَعِيبُ",
        "en": "we-blame"
       },
       {
        "ar": "زَمَانَنَا",
        "en": "our-time"
       },
       {
        "ar": "وَالْعَيْبُ",
        "en": "while-the-fault"
       },
       {
        "ar": "فِينَا",
        "en": "is-in-us"
       },
       {
        "ar": "وَمَا",
        "en": "and-not"
       },
       {
        "ar": "لِزَمَانِنَا",
        "en": "to-our-time"
       },
       {
        "ar": "عَيْبٌ",
        "en": "any-fault"
       },
       {
        "ar": "سِوَانَا",
        "en": "other-than-us"
       }
      ]
     },
     {
      "ar": "وَمَهْمَا تَكُنْ عِنْدَ امْرِئٍ مِنْ خَلِيقَةٍ وَإِنْ خَالَهَا تَخْفَى عَلَى النَّاسِ تُعْلَمِ",
      "translit": "wa-mahmā takun ʿinda mriʾin min khalīqatin wa-in khālahā takhfā ʿalā n-nāsi tuʿlami",
      "en": "Whatever character a man possesses, though he thinks it hidden from people, it becomes known.",
      "ref": "Zuhayr ibn Abī Sulmā",
      "words": [
       {
        "ar": "وَمَهْمَا",
        "en": "and-whatever"
       },
       {
        "ar": "تَكُنْ",
        "en": "there-be"
       },
       {
        "ar": "عِنْدَ",
        "en": "with"
       },
       {
        "ar": "امْرِئٍ",
        "en": "a-man"
       },
       {
        "ar": "مِنْ",
        "en": "of"
       },
       {
        "ar": "خَلِيقَةٍ",
        "en": "character-trait"
       },
       {
        "ar": "وَإِنْ",
        "en": "and-even-if"
       },
       {
        "ar": "خَالَهَا",
        "en": "he-thinks-it"
       },
       {
        "ar": "تَخْفَى",
        "en": "hidden"
       },
       {
        "ar": "عَلَى",
        "en": "from"
       },
       {
        "ar": "النَّاسِ",
        "en": "the-people"
       },
       {
        "ar": "تُعْلَمِ",
        "en": "it-becomes-known"
       }
      ]
     }
    ]
   }
  ];

  var WEAK = /*@DATA:WEAK*/[];

  var PATTERNS = /*@DATA:PATTERNS*/{ plurals: [], masdars: [], quad: null };

  /* ---------------- alphabet helpers ---------------- */

  function letterByChar(ch) {
    for (var i = 0; i < LETTERS.length; i++) if (LETTERS[i].ar === ch) return LETTERS[i];
    return null;
  }

  function letterById(id) {
    for (var i = 0; i < LETTERS.length; i++) if (LETTERS[i].id === id) return LETTERS[i];
    return null;
  }

  // Letters visually confusable with each other — the distractors a good
  // teacher would pick. Groups share a skeleton and differ by dots.
  var SIMILAR = [
    ['ب', 'ت', 'ث', 'ن', 'ي'],
    ['ج', 'ح', 'خ'],
    ['د', 'ذ'],
    ['ر', 'ز'],
    ['س', 'ش'],
    ['ص', 'ض'],
    ['ط', 'ظ'],
    ['ع', 'غ'],
    ['ف', 'ق'],
    ['ه', 'ة'],
    ['ا', 'أ', 'إ', 'ل']
  ];

  function similarLetters(ch) {
    for (var i = 0; i < SIMILAR.length; i++) {
      if (SIMILAR[i].indexOf(ch) !== -1) {
        var out = [];
        for (var j = 0; j < SIMILAR[i].length; j++) {
          if (SIMILAR[i][j] !== ch && letterByChar(SIMILAR[i][j])) out.push(SIMILAR[i][j]);
        }
        return out;
      }
    }
    return [];
  }

  // The alphabet is taught in five groups of ~6 letters.
  function letterGroups() {
    var sizes = [6, 6, 6, 6, 5];
    var groups = [], at = 0;
    for (var i = 0; i < sizes.length; i++) {
      var slice = LETTERS.slice(at, at + sizes[i]);
      if (!slice.length) break;
      groups.push({
        idx: i,
        letters: slice,
        label: slice.map(function (l) { return l.ar; }).join(' ')
      });
      at += sizes[i];
    }
    return groups;
  }

  /* ---------------- quiz building (all seeded, all deterministic) ---------------- */
  // A question: { kind, prompt, promptAr, options: [{label, ar}], answer, why }
  // `answer` is the index of the correct option AFTER seeded shuffling.

  function finishQuestion(q, correct, distractors, seed) {
    var options = [correct].concat(distractors);
    var shuffled = seededShuffle(options, seed + ':opts');
    q.options = shuffled;
    q.answer = -1;
    for (var i = 0; i < shuffled.length; i++) if (shuffled[i] === correct) { q.answer = i; break; }
    return q;
  }

  // Pick distractor letters: visually similar first, then seeded others.
  function letterDistractors(letter, n, seed) {
    var sims = similarLetters(letter.ar), out = [];
    for (var i = 0; i < sims.length && out.length < n; i++) {
      var l = letterByChar(sims[i]);
      if (l) out.push(l);
    }
    var rest = [];
    for (var j = 0; j < LETTERS.length; j++) {
      var cand = LETTERS[j];
      if (cand.id === letter.id) continue;
      var dup = false;
      for (var k = 0; k < out.length; k++) if (out[k].id === cand.id) dup = true;
      if (!dup) rest.push(cand);
    }
    rest = seededShuffle(rest, seed + ':rest');
    while (out.length < n && rest.length) out.push(rest.shift());
    return out;
  }

  var LETTER_KINDS = ['glyph2name', 'name2glyph', 'glyph2sound', 'spotForm', 'sunmoon'];

  // Can a sun/moon question be asked fairly within this letter set?
  // It needs a target on one side and three wrong options on the other.
  function sunmoonViable(letters) {
    var sun = 0, moon = 0;
    for (var i = 0; i < (letters || []).length; i++) (letters[i].sun ? sun++ : moon++);
    return (sun >= 1 && moon >= 3) || (moon >= 1 && sun >= 3);
  }

  function letterQuestion(letter, kind, seed, set) {
    var d = letterDistractors(letter, 3, seed);
    var q, correct;
    if (kind === 'glyph2name') {
      q = { kind: kind, prompt: 'Which letter is this?', promptAr: letter.ar, why: letter.nameEn + ' — ' + letter.sound };
      correct = { label: letter.nameEn, ar: '' };
      return finishQuestion(q, correct, d.map(function (x) { return { label: x.nameEn, ar: '' }; }), seed);
    }
    if (kind === 'name2glyph') {
      q = { kind: kind, prompt: 'Pick the letter ' + letter.nameEn, promptAr: '', why: letter.ar + ' is ' + letter.nameEn };
      correct = { label: '', ar: letter.ar };
      return finishQuestion(q, correct, d.map(function (x) { return { label: '', ar: x.ar }; }), seed);
    }
    if (kind === 'glyph2sound') {
      q = { kind: kind, prompt: 'What sound does this letter make?', promptAr: letter.ar, why: letter.nameEn + ': ' + letter.sound };
      correct = { label: letter.sound, ar: '' };
      return finishQuestion(q, correct, d.map(function (x) { return { label: x.sound, ar: '' }; }), seed);
    }
    if (kind === 'spotForm') {
      var forms = ['initial', 'medial', 'final'];
      var form = forms[hashStr(seed + ':form') % forms.length];
      q = {
        kind: kind,
        prompt: 'This is the ' + form + ' form of which letter?',
        promptAr: letter[form],
        why: letter.nameEn + ' writes ' + letter[form] + ' in ' + form + ' position'
      };
      correct = { label: letter.nameEn, ar: '' };
      return finishQuestion(q, correct, d.map(function (x) { return { label: x.nameEn, ar: '' }; }), seed);
    }
    // sunmoon: which of these is a sun/moon letter? Drawn from the letters
    // THIS drill covers, so learners are never quizzed on unseen glyphs.
    var src = set && set.length ? set : LETTERS;
    var pool = { sun: [], moon: [] };
    for (var i = 0; i < src.length; i++) (src[i].sun ? pool.sun : pool.moon).push(src[i]);
    var wantSun = hashStr(seed + ':side') % 2 === 0;
    if (!((wantSun ? pool.sun : pool.moon).length >= 1 && (wantSun ? pool.moon : pool.sun).length >= 3)) wantSun = !wantSun;
    var target = pickN(wantSun ? pool.sun : pool.moon, 1, seed + ':t')[0] || letter;
    var wrongs = pickN(wantSun ? pool.moon : pool.sun, 3, seed + ':w');
    q = {
      kind: kind,
      prompt: 'Which of these is a ' + (wantSun ? 'sun' : 'moon') + ' letter (' + (wantSun ? 'assimilates' : 'keeps') + ' the ل of ال)?',
      promptAr: '',
      why: target.ar + ' (' + target.nameEn + ') is a ' + (wantSun ? 'sun' : 'moon') + ' letter'
    };
    correct = { label: '', ar: target.ar };
    return finishQuestion(q, correct, wrongs.map(function (x) { return { label: '', ar: x.ar }; }), seed);
  }

  // A drill over a set of letters (one teaching group, or the whole alphabet).
  function letterQuiz(letters, seed, n) {
    n = n || 8;
    var qs = [];
    var order = seededShuffle(letters || [], seed + ':order');
    if (!order.length) return qs;
    for (var i = 0; i < n; i++) {
      var letter = order[i % order.length];
      var kind = LETTER_KINDS[hashStr(seed + ':kind:' + i) % (i < 2 ? 3 : LETTER_KINDS.length)];
      if (kind === 'sunmoon' && !sunmoonViable(order)) kind = 'glyph2name';
      qs.push(letterQuestion(letter, kind, seed + ':' + i, order));
    }
    return qs;
  }

  function markQuiz(seed, n) {
    n = n || 8;
    var qs = [];
    var order = seededShuffle(MARKS, seed + ':order');
    if (!order.length) return qs;
    for (var i = 0; i < n; i++) {
      var mark = order[i % order.length];
      var others = [];
      for (var j = 0; j < MARKS.length; j++) if (MARKS[j].id !== mark.id) others.push(MARKS[j]);
      var d = pickN(others, 3, seed + ':' + i);
      var ask = hashStr(seed + ':ask:' + i) % 2 === 0;
      var q, correct;
      if (ask) {
        q = { kind: 'mark2name', prompt: 'What is this sign called?', promptAr: mark.display, why: mark.nameEn + ' — ' + mark.makes };
        correct = { label: mark.nameEn, ar: '' };
        qs.push(finishQuestion(q, correct, d.map(function (x) { return { label: x.nameEn, ar: '' }; }), seed + ':' + i));
      } else {
        q = { kind: 'mark2makes', prompt: 'What does this sign do?', promptAr: mark.display, why: mark.nameEn + ': ' + mark.makes };
        correct = { label: mark.makes, ar: '' };
        qs.push(finishQuestion(q, correct, d.map(function (x) { return { label: x.makes, ar: '' }; }), seed + ':' + i));
      }
    }
    return qs;
  }

  // Vocabulary: ar→en and en→ar, distractors of the same part of speech first.
  function vocabDistractors(word, unitWords, n, seed) {
    var samePos = [], rest = [];
    var all = allWords();
    for (var i = 0; i < all.length; i++) {
      var w = all[i];
      if (w.ar === word.ar || w.en === word.en) continue;
      (w.pos === word.pos ? samePos : rest).push(w);
    }
    // Same-pos first, then the rest — and never two options sharing a
    // gloss or a transliteration (the lexicon glosses both سَنَة and عَام
    // as "year", which would render as twin options).
    var pool = seededShuffle(samePos, seed + ':pos').concat(seededShuffle(rest, seed + ':rest'));
    var out = [], seen = {};
    seen['e:' + word.en.toLowerCase()] = 1;
    seen['t:' + word.translit] = 1;
    for (var p = 0; p < pool.length && out.length < n; p++) {
      var ke = 'e:' + pool[p].en.toLowerCase(), kt = 't:' + pool[p].translit;
      if (seen[ke] || seen[kt]) continue;
      seen[ke] = 1; seen[kt] = 1;
      out.push(pool[p]);
    }
    return out;
  }

  function vocabQuestion(word, dir, seed) {
    var d = vocabDistractors(word, null, 3, seed);
    var q, correct;
    if (dir === 'en2ar') {
      q = { kind: 'en2ar', prompt: 'Which is “' + word.en + '”?', promptAr: '', why: word.ar + ' (' + word.translit + ') = ' + word.en };
      correct = { label: word.translit, ar: word.ar };
      return finishQuestion(q, correct, d.map(function (x) { return { label: x.translit, ar: x.ar }; }), seed);
    }
    q = { kind: 'ar2en', prompt: 'What does this mean?', promptAr: word.ar, why: word.ar + ' (' + word.translit + ') = ' + word.en };
    correct = { label: word.en, ar: '' };
    return finishQuestion(q, correct, d.map(function (x) { return { label: x.en, ar: '' }; }), seed);
  }

  function vocabQuiz(words, seed, n) {
    n = n || 10;
    var qs = [];
    var order = seededShuffle(words || [], seed + ':order');
    if (!order.length) return qs;
    for (var i = 0; i < n; i++) {
      var word = order[i % order.length];
      var dir = hashStr(seed + ':dir:' + i) % 2 === 0 ? 'ar2en' : 'en2ar';
      qs.push(vocabQuestion(word, dir, seed + ':' + i));
    }
    return qs;
  }

  // Conjugation drill: which form of كتب goes with this pronoun?
  function conjQuiz(tense, seed, n) {
    n = n || 8;
    var qs = [];
    var rows = MORPH.paradigm || [];
    if (!rows.length) return qs;
    var order = seededShuffle(rows, seed + ':order');
    for (var i = 0; i < n; i++) {
      var row = order[i % order.length];
      var field = tense === 'present' ? 'present' : 'past';
      var others = [];
      for (var j = 0; j < rows.length; j++) if (rows[j][field] !== row[field]) others.push(rows[j]);
      // distinct wrong forms only
      var seen = {}, uniq = [];
      var shuffledOthers = seededShuffle(others, seed + ':' + i);
      for (var k = 0; k < shuffledOthers.length && uniq.length < 3; k++) {
        if (!seen[shuffledOthers[k][field]]) { seen[shuffledOthers[k][field]] = 1; uniq.push(shuffledOthers[k]); }
      }
      var q = {
        kind: 'conj',
        prompt: '“' + row.en + '” — pick the ' + (tense === 'present' ? 'present' : 'past') + ' of كَتَبَ (to write)',
        promptAr: row.pronoun,
        why: row.pronoun + ' → ' + row[field] + ' (' + (tense === 'present' ? row.presentTranslit : row.pastTranslit) + ')'
      };
      var correct = { label: tense === 'present' ? row.presentTranslit : row.pastTranslit, ar: row[field] };
      qs.push(finishQuestion(q, correct, uniq.map(function (x) {
        return { label: tense === 'present' ? x.presentTranslit : x.pastTranslit, ar: x[field] };
      }), seed + ':' + i));
    }
    return qs;
  }

  // Verb forms I–X drill: wazn → meaning, example → form.
  function formsQuiz(seed, n) {
    n = n || 8;
    var qs = [];
    var forms = MORPH.forms || [];
    if (!forms.length) return qs;
    var order = seededShuffle(forms, seed + ':order');
    for (var i = 0; i < n; i++) {
      var f = order[i % order.length];
      var others = [];
      for (var j = 0; j < forms.length; j++) if (forms[j].form !== f.form) others.push(forms[j]);
      var d = pickN(others, 3, seed + ':' + i);
      var ask = hashStr(seed + ':ask:' + i) % 2 === 0;
      var q, correct;
      if (ask) {
        q = { kind: 'wazn2meaning', prompt: 'Form ' + f.form + ' — what flavour of meaning does this pattern carry?', promptAr: f.wazn, why: f.wazn + ' (' + f.waznTranslit + '): ' + f.meaning + ' — e.g. ' + f.example.ar + ' “' + f.example.en + '”' };
        correct = { label: f.meaning, ar: '' };
        qs.push(finishQuestion(q, correct, d.map(function (x) { return { label: x.meaning, ar: '' }; }), seed + ':' + i));
      } else {
        q = { kind: 'verb2wazn', prompt: 'The verb ' + f.example.translit + ' “' + f.example.en + '” belongs to which pattern?', promptAr: f.example.ar, why: f.example.ar + ' is Form ' + f.form + ' — ' + f.wazn };
        correct = { label: 'Form ' + f.form + ' — ' + f.waznTranslit, ar: '' };
        qs.push(finishQuestion(q, correct, d.map(function (x) { return { label: 'Form ' + x.form + ' — ' + x.waznTranslit, ar: '' }; }), seed + ':' + i));
      }
    }
    return qs;
  }

  /* ---------------- weak verbs & patterns (the intermediate ṣarf) ---------------- */

  function weakClassById(id) {
    for (var i = 0; i < WEAK.length; i++) if (WEAK[i].id === id) return WEAK[i];
    return null;
  }

  // Drill one weak-verb class: pronoun → correct form, past and present mixed.
  function weakQuiz(classId, seed, n) {
    n = n || 8;
    var qs = [];
    var cls = weakClassById(classId);
    if (!cls || !cls.paradigm || !cls.paradigm.length) return qs;
    var rows = cls.paradigm;
    var order = seededShuffle(rows, seed + ':order');
    for (var i = 0; i < n; i++) {
      var row = order[i % order.length];
      var tense = hashStr(seed + ':tense:' + i) % 2 === 0 ? 'past' : 'present';
      var field = tense === 'present' ? 'present' : 'past';
      var trField = tense === 'present' ? 'presentTranslit' : 'pastTranslit';
      var seen = {}, uniq = [];
      seen[row[field]] = 1;
      var others = seededShuffle(rows, seed + ':' + i);
      for (var k = 0; k < others.length && uniq.length < 3; k++) {
        if (!seen[others[k][field]]) { seen[others[k][field]] = 1; uniq.push(others[k]); }
      }
      var q = {
        kind: 'weak',
        prompt: '“' + row.en + '” — pick the ' + tense + ' of ' + cls.model.translit + ' (' + cls.model.en + ')',
        promptAr: row.pronoun,
        why: row.pronoun + ' → ' + row[field] + ' (' + row[trField] + ')'
      };
      var correct = { label: row[trField], ar: row[field] };
      qs.push(finishQuestion(q, correct, uniq.map(function (x) {
        return { label: x[trField], ar: x[field] };
      }), seed + ':' + i));
    }
    return qs;
  }

  // Drill the broken plurals: singular → its attested plural, distractors
  // drawn from other patterns' plurals so the pattern is what's tested.
  function pluralQuiz(seed, n) {
    n = n || 8;
    var qs = [];
    var pool = [];
    for (var i = 0; i < (PATTERNS.plurals || []).length; i++) {
      var pat = PATTERNS.plurals[i];
      for (var j = 0; j < pat.examples.length; j++) {
        pool.push({ pat: pat, ex: pat.examples[j] });
      }
    }
    if (pool.length < 4) return qs;
    var order = seededShuffle(pool, seed + ':order');
    for (var k = 0; k < n; k++) {
      var it = order[k % order.length];
      var seen = {}, d = [];
      seen[it.ex.pl] = 1;
      var others = seededShuffle(pool, seed + ':' + k);
      for (var m = 0; m < others.length && d.length < 3; m++) {
        if (!seen[others[m].ex.pl]) { seen[others[m].ex.pl] = 1; d.push(others[m].ex); }
      }
      var q = {
        kind: 'plural',
        prompt: 'Pick the plural of ' + it.ex.singTranslit + ' “' + it.ex.en + '”',
        promptAr: it.ex.sing,
        why: it.ex.sing + ' → ' + it.ex.pl + ' (' + it.ex.plTranslit + ', pattern ' + it.pat.patternTranslit + ')'
      };
      var correct = { label: it.ex.plTranslit, ar: it.ex.pl };
      qs.push(finishQuestion(q, correct, d.map(function (x) {
        return { label: x.plTranslit, ar: x.pl };
      }), seed + ':' + k));
    }
    return qs;
  }

  // Reading comprehension: after meeting a text, the learner is quizzed on
  // the words inside it — glosses come straight from the text's own
  // word-by-word apparatus, distractors from its other words.
  function readQuiz(text, seed, n) {
    n = n || 6;
    var qs = [];
    if (!text || !text.lines) return qs;
    var pool = [], seenAr = {}, seenEn = {};
    for (var i = 0; i < text.lines.length; i++) {
      var words = text.lines[i].words || [];
      for (var j = 0; j < words.length; j++) {
        var w = words[j];
        var keyAr = normalizeAr(w.ar), keyEn = String(w.en).toLowerCase();
        if (stripTashkil(w.ar).length < 2) continue;
        if (seenAr[keyAr] || seenEn[keyEn]) continue;
        seenAr[keyAr] = 1; seenEn[keyEn] = 1;
        pool.push(w);
      }
    }
    if (pool.length < 4) return qs;
    var order = seededShuffle(pool, seed + ':order');
    var count = Math.min(n, order.length);
    for (var k = 0; k < count; k++) {
      var target = order[k];
      var others = [];
      for (var m = 0; m < pool.length; m++) if (pool[m].en !== target.en) others.push(pool[m]);
      var d = pickN(others, 3, seed + ':' + k);
      var q = { kind: 'read', prompt: 'In this text — what does this word mean?', promptAr: target.ar, why: target.ar + ' = ' + target.en };
      var correct = { label: target.en, ar: '' };
      qs.push(finishQuestion(q, correct, d.map(function (x) { return { label: x.en, ar: '' }; }), seed + ':' + k));
    }
    return qs;
  }

  // Grammar lessons ship authored questions; the engine reshuffles the
  // options per seed so the answer's position can't be memorized.
  function grammarQuiz(lesson, seed) {
    var qs = [];
    if (!lesson || !lesson.quiz) return qs;
    for (var i = 0; i < lesson.quiz.length; i++) {
      var src = lesson.quiz[i];
      var correct = src.options[src.answer];
      var q = { kind: 'grammar', prompt: src.q, promptAr: '', why: src.why };
      var rest = [];
      for (var j = 0; j < src.options.length; j++) if (j !== src.answer) rest.push(src.options[j]);
      var shuffled = seededShuffle([correct].concat(rest), seed + ':' + i);
      q.options = shuffled.map(function (o) { return { label: o, ar: '' }; });
      q.answer = shuffled.indexOf(correct);
      qs.push(q);
    }
    return qs;
  }

  function quizScore(answers, quiz) {
    var correct = 0;
    for (var i = 0; i < quiz.length; i++) {
      if (answers[i] === quiz[i].answer) correct++;
    }
    var total = quiz.length || 1;
    var pct = Math.round(100 * correct / total);
    var stars = pct >= 90 ? 3 : pct >= 70 ? 2 : pct >= 50 ? 1 : 0;
    return { correct: correct, total: quiz.length, pct: pct, stars: stars };
  }

  /* ---------------- spaced repetition: an SM-2-style scheduler ---------------- */
  // Grades: 0 again · 1 hard · 2 good · 3 easy. Intervals live in ms so the
  // whole thing stays clock-injected and testable.

  var EASE_MIN = 1.3, EASE_MAX = 3.0, IVL_MAX = 365 * DAY;

  function newCard(id, now) {
    return { id: id, reps: 0, lapses: 0, ease: 2.5, ivl: 0, due: now, last: 0 };
  }

  function gradeCard(card, grade, now) {
    var c = { id: card.id, reps: card.reps, lapses: card.lapses, ease: card.ease, ivl: card.ivl, due: card.due, last: now };
    if (grade <= 0) {
      c.ease = Math.max(EASE_MIN, c.ease - 0.2);
      if (c.reps > 0) c.lapses++;
      c.ivl = 0;
      c.due = now + 10 * MINUTE;
      return c;
    }
    if (grade === 1) {
      c.ease = Math.max(EASE_MIN, c.ease - 0.15);
      c.ivl = c.ivl < DAY ? 12 * HOUR : Math.min(IVL_MAX, Math.round(c.ivl * 1.2));
      c.reps++;
      c.due = now + c.ivl;
      return c;
    }
    if (grade === 2) {
      c.ivl = c.ivl < DAY ? DAY : Math.min(IVL_MAX, Math.round(c.ivl * c.ease));
      c.reps++;
      c.due = now + c.ivl;
      return c;
    }
    c.ease = Math.min(EASE_MAX, c.ease + 0.15);
    c.ivl = c.ivl < DAY ? 3 * DAY : Math.min(IVL_MAX, Math.round(c.ivl * c.ease * 1.3));
    c.reps++;
    c.due = now + c.ivl;
    return c;
  }

  function isDue(card, now) { return (card.due || 0) <= now; }

  function dueCards(cards, now, limit) {
    var out = [];
    for (var k in (cards || {})) if (isDue(cards[k], now)) out.push(cards[k]);
    out.sort(function (a, b) { return (a.due - b.due) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    return limit ? out.slice(0, limit) : out;
  }

  function srsStats(cards, now) {
    var total = 0, due = 0, learning = 0, young = 0, mature = 0;
    for (var k in (cards || {})) {
      var c = cards[k];
      total++;
      if (isDue(c, now)) due++;
      if (c.ivl < DAY) learning++;
      else if (c.ivl < 21 * DAY) young++;
      else mature++;
    }
    return { total: total, due: due, learning: learning, young: young, mature: mature };
  }

  function nextDueLabel(cards, now) {
    var soonest = Infinity;
    for (var k in (cards || {})) if (cards[k].due < soonest) soonest = cards[k].due;
    if (!isFinite(soonest)) return '';
    var d = soonest - now;
    if (d <= 0) return 'now';
    if (d < HOUR) return 'in ' + Math.max(1, Math.round(d / MINUTE)) + 'm';
    if (d < DAY) return 'in ' + Math.round(d / HOUR) + 'h';
    return 'in ' + Math.round(d / DAY) + 'd';
  }

  /* ---------------- streaks, XP and ranks ---------------- */

  // Difference in whole days between two ISO dates — pure calendar math.
  function isoDayDiff(a, b) {
    var pa = String(a || '').split('-'), pb = String(b || '').split('-');
    if (pa.length !== 3 || pb.length !== 3) return NaN;
    var ta = Date.UTC(+pa[0], +pa[1] - 1, +pa[2]);
    var tb = Date.UTC(+pb[0], +pb[1] - 1, +pb[2]);
    return Math.round((tb - ta) / DAY);
  }

  function bumpStreak(streak, isoDate) {
    var s = { count: (streak && streak.count) || 0, last: (streak && streak.last) || '', best: (streak && streak.best) || 0 };
    if (s.last === isoDate) return s;
    var diff = s.last ? isoDayDiff(s.last, isoDate) : NaN;
    if (diff <= 0) return s;   // the clock walked backwards — today is already counted
    s.count = diff === 1 ? s.count + 1 : 1;
    s.last = isoDate;
    if (s.count > s.best) s.best = s.count;
    return s;
  }

  function streakAlive(streak, isoDate) {
    if (!streak || !streak.last) return false;
    var diff = isoDayDiff(streak.last, isoDate);
    return diff <= 1;   // 0/1 = today/yesterday; negative = a backwards clock, still alive
  }

  // The ladder of ranks — classical titles for a classical pursuit.
  var RANKS = [
    { min: 0,    name: 'Mubtadiʾ',  ar: 'مُبْتَدِئ',      en: 'Beginner' },
    { min: 120,  name: 'Qāriʾ',     ar: 'قَارِئ',        en: 'Reader' },
    { min: 350,  name: 'Dāris',     ar: 'دَارِس',        en: 'Student' },
    { min: 750,  name: 'Kātib',     ar: 'كَاتِب',        en: 'Writer' },
    { min: 1300, name: 'Adīb',      ar: 'أَدِيب',        en: 'Man of Letters' },
    { min: 2000, name: 'ʿĀlim',     ar: 'عَالِم',        en: 'Scholar' },
    { min: 3000, name: 'Ḥakīm',     ar: 'حَكِيم',        en: 'Sage' },
    { min: 4500, name: 'Faṣīḥ',     ar: 'فَصِيح',        en: 'Master of Eloquence' },
    { min: 6500, name: 'ʿAllāma',   ar: 'عَلَّامَة',      en: 'Great Scholar' },
    { min: 9000, name: 'Lisān al-ʿArab', ar: 'لِسَان الْعَرَب', en: 'The Tongue of the Arabs' }
  ];

  function rankFor(xp) {
    var n = Math.max(0, xp | 0);
    var cur = RANKS[0], next = null;
    for (var i = 0; i < RANKS.length; i++) {
      if (n >= RANKS[i].min) cur = RANKS[i];
      else { next = RANKS[i]; break; }
    }
    var progress = 1;
    if (next) progress = (n - cur.min) / (next.min - cur.min);
    return {
      name: cur.name, ar: cur.ar, en: cur.en, min: cur.min,
      next: next ? { name: next.name, min: next.min, needed: next.min - n } : null,
      progress: Math.max(0, Math.min(1, progress))
    };
  }

  var XP = { question: 5, lessonRead: 10, stageClear: 20, review: 2 };

  /* ---------------- the course path ---------------- */
  // One road from the first letter to reading the Fātiḥa unaided: alphabet
  // groups, the signs, then vocabulary units braided with grammar, ṣarf
  // drills and real texts. Data-driven — every stage points into the
  // curriculum above.

  function unitById(id) {
    for (var i = 0; i < UNITS.length; i++) if (UNITS[i].id === id) return UNITS[i];
    return null;
  }

  function lessonById(id) {
    for (var i = 0; i < GRAMMAR.length; i++) if (GRAMMAR[i].id === id) return GRAMMAR[i];
    return null;
  }

  function textById(id) {
    for (var i = 0; i < TEXTS.length; i++) if (TEXTS[i].id === id) return TEXTS[i];
    return null;
  }

  // The road has three marḥalas: Foundation (letters → the Fātiḥa),
  // Intermediate (weak verbs, the harder naḥw, more Qurʾān and ḥadīth),
  // Advanced (the literary lexicon, balāgha, ʿarūḍ, the canon itself).
  var SECTIONS = [
    { id: 'foundation',   title: 'Foundation',   titleAr: 'الْأَسَاس' },
    { id: 'intermediate', title: 'Intermediate', titleAr: 'الْمَرْحَلَة الْمُتَوَسِّطَة' },
    { id: 'advanced',     title: 'Advanced',     titleAr: 'الْمَرْحَلَة الْمُتَقَدِّمَة' }
  ];

  var BRAIDS = {
    foundation: [
      ['grammar', 'g1'], ['vocab', 'u1'], ['grammar', 'g2'], ['vocab', 'u2'],
      ['grammar', 'g3'], ['vocab', 'u3'], ['grammar', 'g4'], ['conj', 'past'],
      ['vocab', 'u4'], ['grammar', 'g5'], ['vocab', 'u5'], ['grammar', 'g6'],
      ['read', 'proverbs'], ['conj', 'present'], ['vocab', 'u6'], ['grammar', 'g7'],
      ['vocab', 'u7'], ['grammar', 'g8'], ['vocab', 'u8'], ['grammar', 'g9'],
      ['forms', null], ['vocab', 'u9'], ['grammar', 'g10'], ['grammar', 'g11'],
      ['vocab', 'u10'], ['grammar', 'g12'], ['read', 'ikhlas'], ['read', 'fatiha'],
      ['read', 'wisdom']
    ],
    intermediate: [
      ['grammar', 'g13'], ['vocab', 'u11'], ['weak', 'hollow-waw'], ['vocab', 'u12'],
      ['grammar', 'g14'], ['weak', 'hollow-ya'], ['vocab', 'u13'], ['grammar', 'g15'],
      ['weak', 'hollow-a'], ['vocab', 'u14'], ['grammar', 'g16'], ['weak', 'doubled'],
      ['read', 'asr'], ['vocab', 'u15'], ['grammar', 'g17'], ['weak', 'assimilated'],
      ['vocab', 'u16'], ['grammar', 'g18'], ['weak', 'defective-u'], ['vocab', 'u17'],
      ['grammar', 'g19'], ['weak', 'defective-i'], ['vocab', 'u18'], ['grammar', 'g20'],
      ['weak', 'defective-a'], ['vocab', 'u19'], ['weak', 'hamzated'], ['vocab', 'u20'],
      ['read', 'falaq'], ['read', 'nas'], ['read', 'hadith'], ['read', 'kursi']
    ],
    advanced: [
      ['grammar', 'g21'], ['vocab', 'u21'], ['plurals', null], ['vocab', 'u22'],
      ['grammar', 'g22'], ['vocab', 'u23'], ['grammar', 'g23'], ['vocab', 'u24'],
      ['grammar', 'g24'], ['vocab', 'u25'], ['read', 'shafii'], ['vocab', 'u26'],
      ['grammar', 'g25'], ['vocab', 'u27'], ['grammar', 'g26'], ['vocab', 'u28'],
      ['read', 'kalila'], ['vocab', 'u29'], ['grammar', 'g27'], ['vocab', 'u30'],
      ['read', 'mutanabbi'], ['grammar', 'g28'], ['read', 'muallaqa']
    ]
  };

  var READ_ICONS = { quran: '📖', poetry: '🪶', hadith: '🌙', prose: '🏺', proverbs: '📜' };

  function pushBraid(path, braid, section) {
    for (var b = 0; b < braid.length; b++) {
      var kind = braid[b][0], ref = braid[b][1];
      if (kind === 'vocab') {
        var u = unitById(ref);
        if (u) path.push({ id: ref, kind: 'vocab', ref: ref, icon: u.icon, title: u.title, titleAr: u.titleAr, section: section });
      } else if (kind === 'grammar') {
        var g = lessonById(ref);
        if (g) path.push({ id: ref, kind: 'grammar', ref: ref, icon: '🧭', title: g.title, titleAr: g.titleAr, section: section });
      } else if (kind === 'read') {
        var t = textById(ref);
        if (t) path.push({ id: 'read-' + ref, kind: 'read', ref: ref, icon: READ_ICONS[t.kind] || '📜', title: t.title, titleAr: t.titleAr, section: section });
      } else if (kind === 'conj') {
        path.push({
          id: 'sarf-' + ref, kind: 'conj', ref: ref, icon: '⚙️',
          title: ref === 'past' ? 'Conjugation: the Past' : 'Conjugation: the Present',
          titleAr: ref === 'past' ? 'الْفِعْل الْمَاضِي' : 'الْفِعْل الْمُضَارِع',
          section: section
        });
      } else if (kind === 'forms') {
        path.push({ id: 'sarf-forms', kind: 'forms', ref: null, icon: '🏛️', title: 'The Ten Verb Forms', titleAr: 'أَوْزَان الْفِعْل', section: section });
      } else if (kind === 'weak') {
        var w = weakClassById(ref);
        if (w) path.push({ id: 'weak-' + ref, kind: 'weak', ref: ref, icon: '🌊', title: w.name, titleAr: w.nameAr, section: section });
      } else if (kind === 'plurals') {
        if ((PATTERNS.plurals || []).length) {
          path.push({ id: 'sarf-plurals', kind: 'plurals', ref: null, icon: '🧩', title: 'The Broken Plurals', titleAr: 'جُمُوع التَّكْسِير', section: section });
        }
      }
    }
  }

  function coursePath() {
    var path = [];
    var groups = letterGroups();
    for (var i = 0; i < groups.length; i++) {
      path.push({
        id: 'alpha' + (i + 1), kind: 'letters', ref: i, icon: '🔤',
        title: 'The Alphabet ' + ['I', 'II', 'III', 'IV', 'V'][i],
        titleAr: groups[i].label,
        section: 'foundation'
      });
    }
    path.push({ id: 'marks', kind: 'marks', ref: null, icon: '🎯', title: 'The Signs', titleAr: 'الْحَرَكَات', section: 'foundation' });
    pushBraid(path, BRAIDS.foundation, 'foundation');
    pushBraid(path, BRAIDS.intermediate, 'intermediate');
    pushBraid(path, BRAIDS.advanced, 'advanced');
    return path;
  }

  function stageStars(progress, stageId) {
    var st = progress && progress.stages && progress.stages[stageId];
    return st ? (st.stars || 0) : 0;
  }

  function isUnlocked(path, progress, idx) {
    if (idx <= 0) return true;
    return stageStars(progress, path[idx - 1].id) >= 1;
  }

  function courseProgress(progress, path) {
    path = path || coursePath();
    var done = 0, stars = 0;
    for (var i = 0; i < path.length; i++) {
      var s = stageStars(progress, path[i].id);
      if (s >= 1) done++;
      stars += s;
    }
    return { done: done, total: path.length, stars: stars, maxStars: path.length * 3, pct: path.length ? Math.round(100 * done / path.length) : 0 };
  }

  /* ---------------- profile: the learner's whole state, pure ---------------- */

  function defaultProfile() {
    return { xp: 0, streak: { count: 0, last: '', best: 0 }, stages: {}, cards: {}, reviews: 0 };
  }

  // Record a stage result. Stars only ever go up; XP always accrues.
  function recordStage(profile, stageId, score, isoDate) {
    var p = cloneProfile(profile);
    var prev = p.stages[stageId] || { stars: 0, best: 0, tries: 0 };
    var stars = Math.max(prev.stars, score.stars);
    p.stages[stageId] = { stars: stars, best: Math.max(prev.best, score.pct), tries: prev.tries + 1 };
    p.xp += score.correct * XP.question + (score.stars >= 1 && prev.stars === 0 ? XP.stageClear : 0);
    p.streak = bumpStreak(p.streak, isoDate);
    return p;
  }

  function recordReview(profile, card, isoDate) {
    var p = cloneProfile(profile);
    p.cards[card.id] = card;
    p.xp += XP.review;
    p.reviews = (p.reviews || 0) + 1;
    p.streak = bumpStreak(p.streak, isoDate);
    return p;
  }

  function cloneProfile(profile) {
    var src = profile || defaultProfile();
    var p = { xp: src.xp || 0, streak: { count: 0, last: '', best: 0 }, stages: {}, cards: {}, reviews: src.reviews || 0 };
    if (src.streak) p.streak = { count: src.streak.count || 0, last: src.streak.last || '', best: src.streak.best || 0 };
    for (var k in (src.stages || {})) p.stages[k] = src.stages[k];
    for (var c in (src.cards || {})) p.cards[c] = src.cards[c];
    return p;
  }

  // Cards enter the deck when their stage is first cleared.
  function seedCards(profile, words, now) {
    var p = cloneProfile(profile);
    for (var i = 0; i < words.length; i++) {
      var id = 'w:' + stripTashkil(words[i].ar) + ':' + words[i].en;
      if (!p.cards[id]) p.cards[id] = newCard(id, now);
    }
    return p;
  }

  function cardWord(card) {
    var all = allWords();
    for (var i = 0; i < all.length; i++) {
      var w = all[i];
      if ('w:' + stripTashkil(w.ar) + ':' + w.en === card.id) return w;
    }
    return null;
  }

  /* ---------------- vocabulary search ---------------- */

  function allWords() {
    var out = [];
    for (var i = 0; i < UNITS.length; i++) {
      for (var j = 0; j < UNITS[i].words.length; j++) out.push(UNITS[i].words[j]);
    }
    return out;
  }

  function searchVocab(query, limit) {
    var q = String(query == null ? '' : query).trim();
    if (!q) return [];
    limit = limit || 20;
    var qEn = q.toLowerCase(), qT = translitFold(q), qAr = normalizeAr(q);
    var out = [];
    var words = allWords();
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var score = 0;
      var en = w.en.toLowerCase(), tr = translitFold(w.translit), ar = normalizeAr(w.ar);
      if (en === qEn || (qT && tr === qT) || (qAr && ar === qAr)) score = 100;
      else if (en.indexOf(qEn) === 0 || (qT && tr.indexOf(qT) === 0) || (qAr && ar.indexOf(qAr) === 0)) score = 70;
      else if (en.indexOf(qEn) !== -1 || (qT && tr.indexOf(qT) !== -1) || (qAr && ar.indexOf(qAr) !== -1)) score = 40;
      if (score) out.push({ word: w, score: score });
    }
    out.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.word.en < b.word.en ? -1 : a.word.en > b.word.en ? 1 : 0;
    });
    return out.slice(0, limit);
  }

  /* ---------------- a line of wisdom for every day ---------------- */
  // The home screen greets the learner with one classical line a day,
  // drawn deterministically from the reader's proverbs and wisdom texts.
  function dailyWisdom(isoDate) {
    var pool = [];
    for (var i = 0; i < TEXTS.length; i++) {
      var t = TEXTS[i];
      if (t.kind !== 'proverbs' && t.kind !== 'poetry') continue;
      for (var j = 0; j < t.lines.length; j++) pool.push(t.lines[j]);
    }
    if (!pool.length) return null;
    var idx = hashStr('bayan-day:' + String(isoDate)) % pool.length;
    return pool[idx];
  }

  /* ---------------- exports ---------------- */

  var E = {
    SECOND: SECOND, MINUTE: MINUTE, HOUR: HOUR, DAY: DAY,
    LETTERS: LETTERS, MARKS: MARKS, UNITS: UNITS, MORPH: MORPH, GRAMMAR: GRAMMAR, TEXTS: TEXTS,
    WEAK: WEAK, PATTERNS: PATTERNS, SECTIONS: SECTIONS,
    RANKS: RANKS, XP: XP, SIMILAR: SIMILAR,
    hashStr: hashStr, rand01: rand01, escapeHTML: escapeHTML,
    seededShuffle: seededShuffle, pickN: pickN,
    stripTashkil: stripTashkil, normalizeAr: normalizeAr, arEq: arEq, translitFold: translitFold,
    letterByChar: letterByChar, letterById: letterById, similarLetters: similarLetters, letterGroups: letterGroups,
    letterQuiz: letterQuiz, markQuiz: markQuiz, vocabQuiz: vocabQuiz, conjQuiz: conjQuiz,
    formsQuiz: formsQuiz, grammarQuiz: grammarQuiz, readQuiz: readQuiz, quizScore: quizScore,
    weakClassById: weakClassById, weakQuiz: weakQuiz, pluralQuiz: pluralQuiz,
    newCard: newCard, gradeCard: gradeCard, isDue: isDue, dueCards: dueCards,
    srsStats: srsStats, nextDueLabel: nextDueLabel,
    isoDayDiff: isoDayDiff, bumpStreak: bumpStreak, streakAlive: streakAlive, rankFor: rankFor,
    coursePath: coursePath, unitById: unitById, lessonById: lessonById, textById: textById,
    stageStars: stageStars, isUnlocked: isUnlocked, courseProgress: courseProgress,
    defaultProfile: defaultProfile, recordStage: recordStage, recordReview: recordReview,
    seedCards: seedCards, cardWord: cardWord, allWords: allWords, searchVocab: searchVocab,
    dailyWisdom: dailyWisdom
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  root.BayanEngine = E;
})(typeof self !== 'undefined' ? self : this);
