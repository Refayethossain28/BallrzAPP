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
   },
   {
    "id": "u11",
    "title": "Movement & the Road",
    "titleAr": "السَّيْرُ وَالسَّفَرُ",
    "icon": "🐫",
    "intro": "Classical narrative is always in motion: these verbs and nouns of travel carry every journey in the Qur'an, the sīra, and the riḥla literature, from a single footstep to a sea voyage.",
    "words": [
     {
      "ar": "سَارَ",
      "translit": "sāra",
      "en": "to travel, journey on",
      "root": "س ي ر",
      "pos": "verb",
      "note": "pres. يَسِيرُ yasīru; vn. سَيْر sayr"
     },
     {
      "ar": "مَشَى",
      "translit": "mashā",
      "en": "to walk",
      "root": "م ش ي",
      "pos": "verb",
      "note": "pres. يَمْشِي yamshī"
     },
     {
      "ar": "رَجَعَ",
      "translit": "rajaʿa",
      "en": "to return, come back",
      "root": "ر ج ع",
      "pos": "verb",
      "note": "pres. يَرْجِعُ yarjiʿu; vn. رُجُوع rujūʿ"
     },
     {
      "ar": "وَقَفَ",
      "translit": "waqafa",
      "en": "to stop, stand still",
      "root": "و ق ف",
      "pos": "verb",
      "note": "pres. يَقِفُ yaqifu — the initial wāw drops in the present"
     },
     {
      "ar": "جَرَى",
      "translit": "jarā",
      "en": "to run, flow",
      "root": "ج ر ي",
      "pos": "verb",
      "note": "pres. يَجْرِي yajrī — of rivers: تَجْرِي مِنْ تَحْتِهَا الْأَنْهَارُ"
     },
     {
      "ar": "حَمَلَ",
      "translit": "ḥamala",
      "en": "to carry, bear",
      "root": "ح م ل",
      "pos": "verb",
      "note": "pres. يَحْمِلُ yaḥmilu; vn. حَمْل ḥaml"
     },
     {
      "ar": "رَكِبَ",
      "translit": "rakiba",
      "en": "to ride, mount, embark",
      "root": "ر ك ب",
      "pos": "verb",
      "note": "pres. يَرْكَبُ yarkabu — kasra in the past, fatha in the present"
     },
     {
      "ar": "طَارَ",
      "translit": "ṭāra",
      "en": "to fly",
      "root": "ط ي ر",
      "pos": "verb",
      "note": "pres. يَطِيرُ yaṭīru; whence طَائِر ṭāʾir 'bird'"
     },
     {
      "ar": "وَصَلَ",
      "translit": "waṣala",
      "en": "to arrive, reach",
      "root": "و ص ل",
      "pos": "verb",
      "note": "pres. يَصِلُ yaṣilu — takes إِلَى for the place reached"
     },
     {
      "ar": "سَفَر",
      "translit": "safar",
      "en": "journey, travel",
      "root": "س ف ر",
      "pos": "noun",
      "note": "pl. أَسْفَار asfār"
     },
     {
      "ar": "رِحْلَة",
      "translit": "riḥla",
      "en": "journey, trip; travel account",
      "root": "ر ح ل",
      "pos": "noun",
      "note": "pl. رِحَل riḥal — رِحْلَةَ الشِّتَاءِ وَالصَّيْفِ (Qur. 106:2)"
     },
     {
      "ar": "سَفِينَة",
      "translit": "safīna",
      "en": "ship",
      "root": "س ف ن",
      "pos": "noun",
      "note": "pl. سُفُن sufun"
     },
     {
      "ar": "خُطْوَة",
      "translit": "khuṭwa",
      "en": "step, footstep",
      "root": "خ ط و",
      "pos": "noun",
      "note": "pl. خُطُوَات khuṭuwāt — خُطُوَاتِ الشَّيْطَانِ 'the footsteps of Satan'"
     },
     {
      "ar": "دَابَّة",
      "translit": "dābba",
      "en": "beast, riding animal",
      "root": "د ب ب",
      "pos": "noun",
      "note": "pl. دَوَابّ dawābb — any creature that walks the earth, especially a mount"
     }
    ]
   },
   {
    "id": "u12",
    "title": "Trade & Wealth",
    "titleAr": "التِّجَارَةُ وَالْمَالُ",
    "icon": "🪙",
    "intro": "The Qur'an speaks the language of the market — buying, selling, price, profit and loss — and turns it into the vocabulary of salvation, so these words pay for themselves on every page of scripture, hadith, and law.",
    "words": [
     {
      "ar": "بَاعَ",
      "translit": "bāʿa",
      "en": "to sell",
      "root": "ب ي ع",
      "pos": "verb",
      "note": "pres. يَبِيعُ yabīʿu; vn. بَيْع bayʿ, the fiqh term for sale"
     },
     {
      "ar": "اِشْتَرَى",
      "translit": "ishtarā",
      "en": "to buy",
      "root": "ش ر ي",
      "pos": "verb",
      "note": "pres. يَشْتَرِي yashtarī — Form VIII; the Qur'an uses it for trading faith away"
     },
     {
      "ar": "تَاجِر",
      "translit": "tājir",
      "en": "merchant",
      "root": "ت ج ر",
      "pos": "noun",
      "note": "pl. تُجَّار tujjār"
     },
     {
      "ar": "مَال",
      "translit": "māl",
      "en": "wealth, property",
      "root": "م و ل",
      "pos": "noun",
      "note": "pl. أَمْوَال amwāl"
     },
     {
      "ar": "ثَمَن",
      "translit": "thaman",
      "en": "price",
      "root": "ث م ن",
      "pos": "noun",
      "note": "pl. أَثْمَان athmān — بِثَمَنٍ بَخْسٍ 'for a paltry price' (Qur. 12:20)"
     },
     {
      "ar": "تِجَارَة",
      "translit": "tijāra",
      "en": "trade, commerce",
      "root": "ت ج ر",
      "pos": "noun",
      "note": "تِجَارَةً لَنْ تَبُورَ 'a trade that will never perish' (Qur. 35:29)"
     },
     {
      "ar": "رِبْح",
      "translit": "ribḥ",
      "en": "profit, gain",
      "root": "ر ب ح",
      "pos": "noun",
      "note": "pl. أَرْبَاح arbāḥ; verb رَبِحَ rabiḥa — فَمَا رَبِحَتْ تِجَارَتُهُمْ (Qur. 2:16)"
     },
     {
      "ar": "خُسْرَان",
      "translit": "khusrān",
      "en": "loss, ruin",
      "root": "خ س ر",
      "pos": "noun",
      "note": "also خُسْر khusr (Qur. 103:2); opp. رِبْح"
     },
     {
      "ar": "فِضَّة",
      "translit": "fiḍḍa",
      "en": "silver",
      "root": "ف ض ض",
      "pos": "noun",
      "note": "constantly paired with ذَهَب dhahab 'gold'"
     },
     {
      "ar": "غَنِيّ",
      "translit": "ghaniyy",
      "en": "rich, free of need",
      "root": "غ ن ي",
      "pos": "adj",
      "note": "pl. أَغْنِيَاء aghniyāʾ; opp. فَقِير — of God: the One needing nothing"
     },
     {
      "ar": "فَقِير",
      "translit": "faqīr",
      "en": "poor, needy",
      "root": "ف ق ر",
      "pos": "adj",
      "note": "pl. فُقَرَاء fuqarāʾ; opp. غَنِيّ"
     },
     {
      "ar": "أَجْر",
      "translit": "ajr",
      "en": "wage; reward",
      "root": "أ ج ر",
      "pos": "noun",
      "note": "pl. أُجُور ujūr — both a worker's wage and God's recompense"
     },
     {
      "ar": "دِرْهَم",
      "translit": "dirham",
      "en": "dirham (silver coin)",
      "root": "د ر ه م",
      "pos": "noun",
      "note": "pl. دَرَاهِم darāhim"
     },
     {
      "ar": "دِينَار",
      "translit": "dīnār",
      "en": "dinar (gold coin)",
      "root": "د ن ر",
      "pos": "noun",
      "note": "pl. دَنَانِير danānīr"
     },
     {
      "ar": "كَنْز",
      "translit": "kanz",
      "en": "treasure, hoard",
      "root": "ك ن ز",
      "pos": "noun",
      "note": "pl. كُنُوز kunūz; verb كَنَزَ kanaza 'to hoard'"
     }
    ]
   },
   {
    "id": "u13",
    "title": "War & Peace",
    "titleAr": "الْحَرْبُ وَالسِّلْمُ",
    "icon": "⚔️",
    "intro": "From the battle narratives of the sīra to the Qur'an's promises of victory, classical prose assumes you know the army, its weapons, and the words that end a war.",
    "words": [
     {
      "ar": "حَرْب",
      "translit": "ḥarb",
      "en": "war",
      "root": "ح ر ب",
      "pos": "noun",
      "note": "feminine; pl. حُرُوب ḥurūb"
     },
     {
      "ar": "سِلْم",
      "translit": "silm",
      "en": "peace",
      "root": "س ل م",
      "pos": "noun",
      "note": "also سَلْم salm — اُدْخُلُوا فِي السِّلْمِ كَافَّةً (Qur. 2:208)"
     },
     {
      "ar": "سَيْف",
      "translit": "sayf",
      "en": "sword",
      "root": "س ي ف",
      "pos": "noun",
      "note": "pl. سُيُوف suyūf"
     },
     {
      "ar": "رُمْح",
      "translit": "rumḥ",
      "en": "spear, lance",
      "root": "ر م ح",
      "pos": "noun",
      "note": "pl. رِمَاح rimāḥ"
     },
     {
      "ar": "جَيْش",
      "translit": "jaysh",
      "en": "army",
      "root": "ج ي ش",
      "pos": "noun",
      "note": "pl. جُيُوش juyūsh"
     },
     {
      "ar": "عَدُوّ",
      "translit": "ʿaduww",
      "en": "enemy",
      "root": "ع د و",
      "pos": "noun",
      "note": "pl. أَعْدَاء aʿdāʾ — the singular often stands for a plural in the Qur'an"
     },
     {
      "ar": "نَصْر",
      "translit": "naṣr",
      "en": "victory, help",
      "root": "ن ص ر",
      "pos": "noun",
      "note": "vn. of نَصَرَ naṣara — إِذَا جَاءَ نَصْرُ اللَّهِ (Qur. 110:1)"
     },
     {
      "ar": "هَزِيمَة",
      "translit": "hazīma",
      "en": "defeat, rout",
      "root": "ه ز م",
      "pos": "noun",
      "note": "pl. هَزَائِم hazāʾim; verb هَزَمَ hazama 'to rout' — فَهَزَمُوهُمْ بِإِذْنِ اللَّهِ (Qur. 2:251)"
     },
     {
      "ar": "قَتَلَ",
      "translit": "qatala",
      "en": "to kill",
      "root": "ق ت ل",
      "pos": "verb",
      "note": "pres. يَقْتُلُ yaqtulu; vn. قَتْل qatl; Form III قَاتَلَ qātala 'to fight'"
     },
     {
      "ar": "غَزَا",
      "translit": "ghazā",
      "en": "to raid, go on campaign",
      "root": "غ ز و",
      "pos": "verb",
      "note": "pres. يَغْزُو yaghzū; whence غَزْوَة ghazwa 'expedition' of the sīra"
     },
     {
      "ar": "صُلْح",
      "translit": "ṣulḥ",
      "en": "peace settlement, reconciliation",
      "root": "ص ل ح",
      "pos": "noun",
      "note": "as in صُلْحُ الْحُدَيْبِيَةِ, the treaty of al-Ḥudaybiya"
     },
     {
      "ar": "فَارِس",
      "translit": "fāris",
      "en": "horseman, knight",
      "root": "ف ر س",
      "pos": "noun",
      "note": "pl. فُرْسَان fursān; from فَرَس faras 'horse'"
     },
     {
      "ar": "دِرْع",
      "translit": "dirʿ",
      "en": "coat of mail, armor",
      "root": "د ر ع",
      "pos": "noun",
      "note": "usually feminine; pl. دُرُوع durūʿ"
     },
     {
      "ar": "سَهْم",
      "translit": "sahm",
      "en": "arrow; share",
      "root": "س ه م",
      "pos": "noun",
      "note": "pl. سِهَام sihām — also a 'portion' in inheritance law"
     }
    ]
   },
   {
    "id": "u14",
    "title": "The Heart's Weather",
    "titleAr": "أَحْوَالُ الْقَلْبِ",
    "icon": "💗",
    "intro": "Fear and hope, grief and joy: classical texts map the states of the heart with precision, and these are the very words the Qur'an, the hadith, and the poets use to do it.",
    "words": [
     {
      "ar": "حُبّ",
      "translit": "ḥubb",
      "en": "love",
      "root": "ح ب ب",
      "pos": "noun",
      "note": "opp. بُغْض; verb أَحَبَّ aḥabba (Form IV), pres. يُحِبُّ yuḥibbu"
     },
     {
      "ar": "بُغْض",
      "translit": "bughḍ",
      "en": "hatred",
      "root": "ب غ ض",
      "pos": "noun",
      "note": "opp. حُبّ; verb أَبْغَضَ abghaḍa 'to detest'"
     },
     {
      "ar": "خَوْف",
      "translit": "khawf",
      "en": "fear",
      "root": "خ و ف",
      "pos": "noun",
      "note": "vn. of خَافَ khāfa, pres. يَخَافُ yakhāfu"
     },
     {
      "ar": "رَجَاء",
      "translit": "rajāʾ",
      "en": "hope",
      "root": "ر ج و",
      "pos": "noun",
      "note": "paired with خَوْف as the two wings of devotion; verb رَجَا rajā, pres. يَرْجُو yarjū"
     },
     {
      "ar": "حُزْن",
      "translit": "ḥuzn",
      "en": "grief, sorrow",
      "root": "ح ز ن",
      "pos": "noun",
      "note": "pl. أَحْزَان aḥzān; also حَزَن ḥazan — أَذْهَبَ عَنَّا الْحَزَنَ (Qur. 35:34)"
     },
     {
      "ar": "فَرَح",
      "translit": "faraḥ",
      "en": "joy",
      "root": "ف ر ح",
      "pos": "noun",
      "note": "opp. حُزْن"
     },
     {
      "ar": "غَضَب",
      "translit": "ghaḍab",
      "en": "anger, wrath",
      "root": "غ ض ب",
      "pos": "noun",
      "note": "vn. of غَضِبَ ghaḍiba, pres. يَغْضَبُ yaghḍabu — غَيْرِ الْمَغْضُوبِ عَلَيْهِمْ (Qur. 1:7)"
     },
     {
      "ar": "سُرُور",
      "translit": "surūr",
      "en": "gladness, delight",
      "root": "س ر ر",
      "pos": "noun",
      "note": "whence مَسْرُور masrūr 'glad' (Qur. 84:9)"
     },
     {
      "ar": "هَمّ",
      "translit": "hamm",
      "en": "worry, care",
      "root": "ه م م",
      "pos": "noun",
      "note": "pl. هُمُوم humūm — a favorite opening theme of the classical ode"
     },
     {
      "ar": "بَكَى",
      "translit": "bakā",
      "en": "to weep",
      "root": "ب ك ي",
      "pos": "verb",
      "note": "pres. يَبْكِي yabkī; vn. بُكَاء bukāʾ"
     },
     {
      "ar": "ضَحِكَ",
      "translit": "ḍaḥika",
      "en": "to laugh",
      "root": "ض ح ك",
      "pos": "verb",
      "note": "pres. يَضْحَكُ yaḍḥaku — أَضْحَكَ وَأَبْكَى 'He makes laugh and makes weep' (Qur. 53:43)"
     },
     {
      "ar": "خَشِيَ",
      "translit": "khashiya",
      "en": "to fear, dread",
      "root": "خ ش ي",
      "pos": "verb",
      "note": "pres. يَخْشَى yakhshā — reverent fear, especially of God"
     },
     {
      "ar": "اِشْتَاقَ",
      "translit": "ishtāqa",
      "en": "to long, yearn",
      "root": "ش و ق",
      "pos": "verb",
      "note": "pres. يَشْتَاقُ yashtāqu — Form VIII, with إِلَى; vn. اِشْتِيَاق ishtiyāq; cf. شَوْق shawq \"longing\""
     },
     {
      "ar": "فَرِحَ",
      "translit": "fariḥa",
      "en": "to rejoice",
      "root": "ف ر ح",
      "pos": "verb",
      "note": "pres. يَفْرَحُ yafraḥu — with بِ for the thing rejoiced at"
     },
     {
      "ar": "دَمْع",
      "translit": "damʿ",
      "en": "tears",
      "root": "د م ع",
      "pos": "noun",
      "note": "pl. دُمُوع dumūʿ — تَفِيضُ مِنَ الدَّمْعِ 'overflowing with tears' (Qur. 9:92)"
     }
    ]
   },
   {
    "id": "u15",
    "title": "Speech & Discourse",
    "titleAr": "الْقَوْلُ وَالْخِطَابُ",
    "icon": "🗣️",
    "intro": "Classical texts run on speech acts — commanding, forbidding, promising, calling, disputing — and these words name both the acts themselves and the genres built on them, from the Friday sermon to the hadith corpus.",
    "words": [
     {
      "ar": "خَطَبَ",
      "translit": "khaṭaba",
      "en": "to deliver a sermon, address",
      "root": "خ ط ب",
      "pos": "verb",
      "note": "pres. يَخْطُبُ yakhṭubu — the verb behind خُطْبَة and خَطِيب khaṭīb"
     },
     {
      "ar": "أَجَابَ",
      "translit": "ajāba",
      "en": "to answer, respond",
      "root": "ج و ب",
      "pos": "verb",
      "note": "pres. يُجِيبُ yujību — Form IV; of God: answering prayer"
     },
     {
      "ar": "نَادَى",
      "translit": "nādā",
      "en": "to call out, summon",
      "root": "ن د و",
      "pos": "verb",
      "note": "pres. يُنَادِي yunādī — Form III; vn. نِدَاء nidāʾ"
     },
     {
      "ar": "دَعَا",
      "translit": "daʿā",
      "en": "to call, invoke, invite",
      "root": "د ع و",
      "pos": "verb",
      "note": "pres. يَدْعُو yadʿū; vn. دُعَاء duʿāʾ 'supplication'"
     },
     {
      "ar": "أَمَرَ",
      "translit": "amara",
      "en": "to command, order",
      "root": "أ م ر",
      "pos": "verb",
      "note": "pres. يَأْمُرُ yaʾmuru — with بِ for the thing commanded"
     },
     {
      "ar": "نَهَى",
      "translit": "nahā",
      "en": "to forbid, prohibit",
      "root": "ن ه ي",
      "pos": "verb",
      "note": "pres. يَنْهَى yanhā — opp. أَمَرَ, with عَنْ for the thing forbidden"
     },
     {
      "ar": "وَعَدَ",
      "translit": "waʿada",
      "en": "to promise",
      "root": "و ع د",
      "pos": "verb",
      "note": "pres. يَعِدُ yaʿidu — the wāw drops in the present; vn. وَعْد waʿd"
     },
     {
      "ar": "حَلَفَ",
      "translit": "ḥalafa",
      "en": "to swear (an oath)",
      "root": "ح ل ف",
      "pos": "verb",
      "note": "pres. يَحْلِفُ yaḥlifu — with بِ for what is sworn by"
     },
     {
      "ar": "سَكَتَ",
      "translit": "sakata",
      "en": "to fall silent",
      "root": "س ك ت",
      "pos": "verb",
      "note": "pres. يَسْكُتُ yaskutu; vn. سُكُوت sukūt"
     },
     {
      "ar": "حَدِيث",
      "translit": "ḥadīth",
      "en": "speech, report; hadith",
      "root": "ح د ث",
      "pos": "noun",
      "note": "pl. أَحَادِيث aḥādīth — any account, and specifically the Prophet's sayings"
     },
     {
      "ar": "خُطْبَة",
      "translit": "khuṭba",
      "en": "sermon, oration",
      "root": "خ ط ب",
      "pos": "noun",
      "note": "pl. خُطَب khuṭab"
     },
     {
      "ar": "صَوْت",
      "translit": "ṣawt",
      "en": "voice, sound",
      "root": "ص و ت",
      "pos": "noun",
      "note": "pl. أَصْوَات aṣwāt"
     },
     {
      "ar": "لَفْظ",
      "translit": "lafẓ",
      "en": "utterance, wording",
      "root": "ل ف ظ",
      "pos": "noun",
      "note": "pl. أَلْفَاظ alfāẓ — the wording, as against the مَعْنَى maʿnā 'meaning'"
     },
     {
      "ar": "جِدَال",
      "translit": "jidāl",
      "en": "dispute, debate",
      "root": "ج د ل",
      "pos": "noun",
      "note": "vn. of Form III جَادَلَ jādala 'to dispute' — وَلَا جِدَالَ فِي الْحَجِّ (Qur. 2:197)"
     }
    ]
   },
   {
    "id": "u16",
    "title": "Rule & Judgment",
    "titleAr": "الْحُكْم وَالْعَدْل",
    "icon": "⚖️",
    "intro": "The vocabulary of rulers, judges, and justice that runs through Islamic law, court chronicles, and every classical history.",
    "words": [
     {
      "ar": "حَكَمَ",
      "translit": "ḥakama",
      "en": "to judge; to rule",
      "root": "ح ك م",
      "pos": "verb",
      "note": "pres. يَحْكُمُ yaḥkumu"
     },
     {
      "ar": "عَدَلَ",
      "translit": "ʿadala",
      "en": "to act justly, be fair",
      "root": "ع د ل",
      "pos": "verb",
      "note": "pres. يَعْدِلُ yaʿdilu"
     },
     {
      "ar": "ظَلَمَ",
      "translit": "ẓalama",
      "en": "to wrong, oppress",
      "root": "ظ ل م",
      "pos": "verb",
      "note": "pres. يَظْلِمُ yaẓlimu"
     },
     {
      "ar": "حُكْم",
      "translit": "ḥukm",
      "en": "judgment; rule, authority",
      "root": "ح ك م",
      "pos": "noun",
      "note": "pl. أَحْكَام aḥkām"
     },
     {
      "ar": "عَدْل",
      "translit": "ʿadl",
      "en": "justice",
      "root": "ع د ل",
      "pos": "noun",
      "note": "verbal noun of عَدَلَ; antonym ظُلْم ẓulm"
     },
     {
      "ar": "ظُلْم",
      "translit": "ẓulm",
      "en": "injustice, oppression",
      "root": "ظ ل م",
      "pos": "noun",
      "note": "the wrongdoer: ظَالِم ẓālim, pl. ظَالِمُون ẓālimūn"
     },
     {
      "ar": "قَاضٍ",
      "translit": "qāḍin",
      "en": "judge",
      "root": "ق ض ي",
      "pos": "noun",
      "note": "defective noun: with the article الْقَاضِي al-qāḍī; pl. قُضَاة quḍāh"
     },
     {
      "ar": "شَاهِد",
      "translit": "shāhid",
      "en": "witness",
      "root": "ش ه د",
      "pos": "noun",
      "note": "pl. شُهُود shuhūd"
     },
     {
      "ar": "خَلِيفَة",
      "translit": "khalīfah",
      "en": "caliph, successor",
      "root": "خ ل ف",
      "pos": "noun",
      "note": "masculine despite the ة; pl. خُلَفَاء khulafāʾ"
     },
     {
      "ar": "سُلْطَان",
      "translit": "sulṭān",
      "en": "sultan; authority, power",
      "root": "س ل ط",
      "pos": "noun",
      "note": "in the Qurʾān usually 'authority, warrant'; pl. سَلَاطِين salāṭīn"
     },
     {
      "ar": "أَمِير",
      "translit": "amīr",
      "en": "commander, prince",
      "root": "أ م ر",
      "pos": "noun",
      "note": "pl. أُمَرَاء umarāʾ; cf. أَمِير الْمُؤْمِنِين amīr al-muʾminīn"
     },
     {
      "ar": "وَزِير",
      "translit": "wazīr",
      "en": "vizier, minister",
      "root": "و ز ر",
      "pos": "noun",
      "note": "pl. وُزَرَاء wuzarāʾ"
     },
     {
      "ar": "شَرِيعَة",
      "translit": "sharīʿah",
      "en": "revealed law",
      "root": "ش ر ع",
      "pos": "noun",
      "note": "pl. شَرَائِع sharāʾiʿ"
     },
     {
      "ar": "سِجْن",
      "translit": "sijn",
      "en": "prison",
      "root": "س ج ن",
      "pos": "noun",
      "note": "pl. سُجُون sujūn"
     }
    ]
   },
   {
    "id": "u17",
    "title": "Bread & Provision",
    "titleAr": "الْخُبْز وَالرِّزْق",
    "icon": "🍞",
    "intro": "Daily bread in the classical world: the foods, drinks, and divine provision (rizq) that fill countless verses, hadiths, and proverbs.",
    "words": [
     {
      "ar": "طَعَام",
      "translit": "ṭaʿām",
      "en": "food",
      "root": "ط ع م",
      "pos": "noun",
      "note": "pl. أَطْعِمَة aṭʿimah"
     },
     {
      "ar": "شَرَاب",
      "translit": "sharāb",
      "en": "drink, beverage",
      "root": "ش ر ب",
      "pos": "noun",
      "note": "pl. أَشْرِبَة ashribah"
     },
     {
      "ar": "خُبْز",
      "translit": "khubz",
      "en": "bread",
      "root": "خ ب ز",
      "pos": "noun",
      "note": "a loaf: رَغِيف raghīf, pl. أَرْغِفَة arghifah"
     },
     {
      "ar": "لَحْم",
      "translit": "laḥm",
      "en": "meat, flesh",
      "root": "ل ح م",
      "pos": "noun",
      "note": "pl. لُحُوم luḥūm"
     },
     {
      "ar": "تَمْر",
      "translit": "tamr",
      "en": "dried dates",
      "root": "ت م ر",
      "pos": "noun",
      "note": "collective; a single date: تَمْرَة tamrah"
     },
     {
      "ar": "عَسَل",
      "translit": "ʿasal",
      "en": "honey",
      "root": "ع س ل",
      "pos": "noun",
      "note": "either gender in classical usage"
     },
     {
      "ar": "لَبَن",
      "translit": "laban",
      "en": "milk",
      "root": "ل ب ن",
      "pos": "noun",
      "note": "pl. أَلْبَان albān"
     },
     {
      "ar": "زَيْت",
      "translit": "zayt",
      "en": "olive oil",
      "root": "ز ي ت",
      "pos": "noun",
      "note": "the olive (tree and fruit): زَيْتُون zaytūn"
     },
     {
      "ar": "رِزْق",
      "translit": "rizq",
      "en": "provision, sustenance",
      "root": "ر ز ق",
      "pos": "noun",
      "note": "pl. أَرْزَاق arzāq; divine name الرَّزَّاق ar-razzāq 'the All-Provider'"
     },
     {
      "ar": "جُوع",
      "translit": "jūʿ",
      "en": "hunger",
      "root": "ج و ع",
      "pos": "noun",
      "note": "verb جَاعَ jāʿa, pres. يَجُوعُ yajūʿu"
     },
     {
      "ar": "عَطَش",
      "translit": "ʿaṭash",
      "en": "thirst",
      "root": "ع ط ش",
      "pos": "noun",
      "note": "verb عَطِشَ ʿaṭisha, pres. يَعْطَشُ yaʿṭashu"
     },
     {
      "ar": "زَرَعَ",
      "translit": "zaraʿa",
      "en": "to sow, cultivate",
      "root": "ز ر ع",
      "pos": "verb",
      "note": "pres. يَزْرَعُ yazraʿu; standing crop: زَرْع zarʿ"
     },
     {
      "ar": "حَصَدَ",
      "translit": "ḥaṣada",
      "en": "to reap, harvest",
      "root": "ح ص د",
      "pos": "verb",
      "note": "pres. يَحْصُدُ yaḥṣudu; the harvest: حَصَاد ḥaṣād"
     },
     {
      "ar": "ثَمَر",
      "translit": "thamar",
      "en": "fruit",
      "root": "ث م ر",
      "pos": "noun",
      "note": "collective; unit ثَمَرَة thamarah, pl. ثِمَار thimār"
     }
    ]
   },
   {
    "id": "u18",
    "title": "The Animal Kingdom",
    "titleAr": "مَمْلَكَة الْحَيَوَان",
    "icon": "🦁",
    "intro": "The beasts of the Qurʾān, the desert ode, and the fable — animals carried enormous practical and symbolic weight for the classical Arabs.",
    "words": [
     {
      "ar": "أَسَد",
      "translit": "asad",
      "en": "lion",
      "root": "أ س د",
      "pos": "noun",
      "note": "pl. أُسُود usūd; Arabic is famed for its hundreds of lion-names"
     },
     {
      "ar": "فَرَس",
      "translit": "faras",
      "en": "horse",
      "root": "ف ر س",
      "pos": "noun",
      "note": "either sex; pl. أَفْرَاس afrās, collective خَيْل khayl"
     },
     {
      "ar": "جَمَل",
      "translit": "jamal",
      "en": "camel (male)",
      "root": "ج م ل",
      "pos": "noun",
      "note": "pl. جِمَال jimāl"
     },
     {
      "ar": "فِيل",
      "translit": "fīl",
      "en": "elephant",
      "root": "ف ي ل",
      "pos": "noun",
      "note": "pl. فِيَلَة fiyala; sūrat الْفِيل (105) and the Year of the Elephant are named for it"
     },
     {
      "ar": "ذِئْب",
      "translit": "dhiʾb",
      "en": "wolf",
      "root": "ذ أ ب",
      "pos": "noun",
      "note": "pl. ذِئَاب dhiʾāb; the accused of Sūrat Yūsuf"
     },
     {
      "ar": "كَلْب",
      "translit": "kalb",
      "en": "dog",
      "root": "ك ل ب",
      "pos": "noun",
      "note": "pl. كِلَاب kilāb"
     },
     {
      "ar": "غَنَم",
      "translit": "ghanam",
      "en": "sheep and goats, small livestock",
      "root": "غ ن م",
      "pos": "noun",
      "note": "collective; pl. أَغْنَام aghnām"
     },
     {
      "ar": "بَقَرَة",
      "translit": "baqarah",
      "en": "cow",
      "root": "ب ق ر",
      "pos": "noun",
      "note": "unit noun of the collective بَقَر baqar; cf. سُورَة الْبَقَرَة sūrat al-baqarah"
     },
     {
      "ar": "طَيْر",
      "translit": "ṭayr",
      "en": "birds",
      "root": "ط ي ر",
      "pos": "noun",
      "note": "collective; a bird: طَائِر ṭāʾir, pl. طُيُور ṭuyūr"
     },
     {
      "ar": "نَحْل",
      "translit": "naḥl",
      "en": "bees",
      "root": "ن ح ل",
      "pos": "noun",
      "note": "collective; unit نَحْلَة naḥlah"
     },
     {
      "ar": "نَمْل",
      "translit": "naml",
      "en": "ants",
      "root": "ن م ل",
      "pos": "noun",
      "note": "collective; unit نَمْلَة namlah"
     },
     {
      "ar": "حُوت",
      "translit": "ḥūt",
      "en": "whale, great fish",
      "root": "ح و ت",
      "pos": "noun",
      "note": "pl. حِيتَان ḥītān; the fish of Yūnus"
     },
     {
      "ar": "حَيَّة",
      "translit": "ḥayyah",
      "en": "snake, serpent",
      "root": "ح ي ي",
      "pos": "noun",
      "note": "pl. حَيَّات ḥayyāt"
     },
     {
      "ar": "حِمَار",
      "translit": "ḥimār",
      "en": "donkey",
      "root": "ح م ر",
      "pos": "noun",
      "note": "pl. حَمِير ḥamīr"
     }
    ]
   },
   {
    "id": "u19",
    "title": "Virtue & Vice",
    "titleAr": "الْفَضِيلَة وَالرَّذِيلَة",
    "icon": "🕊️",
    "intro": "The moral lexicon of the Qurʾān and adab literature: paired virtues and vices that structure classical ethical writing.",
    "words": [
     {
      "ar": "صِدْق",
      "translit": "ṣidq",
      "en": "truthfulness",
      "root": "ص د ق",
      "pos": "noun",
      "note": "the truthful man: صَادِق ṣādiq; antonym كَذِب kadhib"
     },
     {
      "ar": "كَذِب",
      "translit": "kadhib",
      "en": "lying, falsehood",
      "root": "ك ذ ب",
      "pos": "noun",
      "note": "verb كَذَبَ kadhaba, pres. يَكْذِبُ yakdhibu"
     },
     {
      "ar": "كَرَم",
      "translit": "karam",
      "en": "generosity, nobility",
      "root": "ك ر م",
      "pos": "noun",
      "note": "verb كَرُمَ karuma; antonym بُخْل bukhl"
     },
     {
      "ar": "بُخْل",
      "translit": "bukhl",
      "en": "miserliness, avarice",
      "root": "ب خ ل",
      "pos": "noun",
      "note": "the miser: بَخِيل bakhīl, pl. بُخَلَاء bukhalāʾ"
     },
     {
      "ar": "شَجَاعَة",
      "translit": "shajāʿah",
      "en": "courage, bravery",
      "root": "ش ج ع",
      "pos": "noun",
      "note": "the brave man: شُجَاع shujāʿ"
     },
     {
      "ar": "جُبْن",
      "translit": "jubn",
      "en": "cowardice",
      "root": "ج ب ن",
      "pos": "noun",
      "note": "the coward: جَبَان jabān"
     },
     {
      "ar": "تَقْوَى",
      "translit": "taqwā",
      "en": "piety, fear of God",
      "root": "و ق ي",
      "pos": "noun",
      "note": "from اِتَّقَى ittaqā (form VIII) 'to be god-fearing'"
     },
     {
      "ar": "ذَنْب",
      "translit": "dhanb",
      "en": "sin, offence",
      "root": "ذ ن ب",
      "pos": "noun",
      "note": "pl. ذُنُوب dhunūb"
     },
     {
      "ar": "تَوْبَة",
      "translit": "tawbah",
      "en": "repentance",
      "root": "ت و ب",
      "pos": "noun",
      "note": "verb تَابَ tāba, pres. يَتُوبُ yatūbu"
     },
     {
      "ar": "حَيَاء",
      "translit": "ḥayāʾ",
      "en": "modesty, sense of shame",
      "root": "ح ي ي",
      "pos": "noun",
      "note": "verb اِسْتَحْيَا istaḥyā 'to be shy, ashamed'"
     },
     {
      "ar": "كِبْر",
      "translit": "kibr",
      "en": "arrogance, pride",
      "root": "ك ب ر",
      "pos": "noun",
      "note": "cf. كِبْرِيَاء kibriyāʾ 'grandeur'; antonym تَوَاضُع tawāḍuʿ"
     },
     {
      "ar": "تَوَاضُع",
      "translit": "tawāḍuʿ",
      "en": "humility",
      "root": "و ض ع",
      "pos": "noun",
      "note": "verbal noun of تَوَاضَعَ tawāḍaʿa (form VI)"
     },
     {
      "ar": "أَمَانَة",
      "translit": "amānah",
      "en": "trustworthiness; a thing held in trust",
      "root": "أ م ن",
      "pos": "noun",
      "note": "pl. أَمَانَات amānāt; antonym خِيَانَة khiyānah"
     },
     {
      "ar": "خِيَانَة",
      "translit": "khiyānah",
      "en": "treachery, betrayal",
      "root": "خ و ن",
      "pos": "noun",
      "note": "verb خَانَ khāna, pres. يَخُونُ yakhūnu"
     }
    ]
   },
   {
    "id": "u20",
    "title": "Fate & the Two Abodes",
    "titleAr": "الْقَدَر وَالدَّارَان",
    "icon": "⏳",
    "intro": "The words with which classical texts speak of destiny, death, and the world to come — the heart of Qurʾānic eschatology.",
    "words": [
     {
      "ar": "قَدَر",
      "translit": "qadar",
      "en": "divine decree, destiny",
      "root": "ق د ر",
      "pos": "noun",
      "note": "pl. أَقْدَار aqdār"
     },
     {
      "ar": "قَضَاء",
      "translit": "qaḍāʾ",
      "en": "decree; judgment",
      "root": "ق ض ي",
      "pos": "noun",
      "note": "paired in الْقَضَاءُ وَالْقَدَرُ al-qaḍāʾu wa-l-qadaru 'the divine decree'"
     },
     {
      "ar": "أَجَل",
      "translit": "ajal",
      "en": "appointed term, term of life",
      "root": "أ ج ل",
      "pos": "noun",
      "note": "pl. آجَال ājāl; cf. أَجَلٌ مُسَمًّى ajalun musamman 'a stated term'"
     },
     {
      "ar": "دُنْيَا",
      "translit": "dunyā",
      "en": "this world, the present life",
      "root": "د ن و",
      "pos": "noun",
      "note": "lit. 'the nearer (life)'; antonym آخِرَة ākhirah"
     },
     {
      "ar": "آخِرَة",
      "translit": "ākhirah",
      "en": "the hereafter",
      "root": "أ خ ر",
      "pos": "noun",
      "note": "from آخِر ākhir 'last'; antonym دُنْيَا dunyā"
     },
     {
      "ar": "مَاتَ",
      "translit": "māta",
      "en": "to die",
      "root": "م و ت",
      "pos": "verb",
      "note": "pres. يَمُوتُ yamūtu"
     },
     {
      "ar": "مَوْت",
      "translit": "mawt",
      "en": "death",
      "root": "م و ت",
      "pos": "noun",
      "note": "antonym حَيَاة ḥayāh"
     },
     {
      "ar": "حَيَاة",
      "translit": "ḥayāh",
      "en": "life",
      "root": "ح ي ي",
      "pos": "noun",
      "note": "verb حَيِيَ ḥayiya 'to live'"
     },
     {
      "ar": "قَبْر",
      "translit": "qabr",
      "en": "grave, tomb",
      "root": "ق ب ر",
      "pos": "noun",
      "note": "pl. قُبُور qubūr"
     },
     {
      "ar": "بَعْث",
      "translit": "baʿth",
      "en": "resurrection; sending forth",
      "root": "ب ع ث",
      "pos": "noun",
      "note": "verb بَعَثَ baʿatha; يَوْمُ الْبَعْثِ yawmu l-baʿthi 'the Day of Resurrection'"
     },
     {
      "ar": "حِسَاب",
      "translit": "ḥisāb",
      "en": "reckoning, account",
      "root": "ح س ب",
      "pos": "noun",
      "note": "يَوْمُ الْحِسَابِ yawmu l-ḥisābi 'the Day of Reckoning'"
     },
     {
      "ar": "ثَوَاب",
      "translit": "thawāb",
      "en": "reward, recompense",
      "root": "ث و ب",
      "pos": "noun",
      "note": "antonym عِقَاب ʿiqāb"
     },
     {
      "ar": "عِقَاب",
      "translit": "ʿiqāb",
      "en": "punishment",
      "root": "ع ق ب",
      "pos": "noun",
      "note": "verb عَاقَبَ ʿāqaba 'to punish'"
     },
     {
      "ar": "خُلُود",
      "translit": "khulūd",
      "en": "eternity, immortality",
      "root": "خ ل د",
      "pos": "noun",
      "note": "verb خَلَدَ khalada, pres. يَخْلُدُ yakhludu"
     }
    ]
   },
   {
    "id": "u21",
    "title": "The Poet's Landscape",
    "titleAr": "دِيَارُ الشَّاعِر",
    "icon": "🐪",
    "intro": "Most muʿallaqāt open over ruined campsites, she-camels, and desert rain — these words are the props of that scene, and hardly a classical ode reads without them.",
    "words": [
     {
      "ar": "طَلَل",
      "translit": "ṭalal",
      "en": "ruined traces of a campsite",
      "root": "ط ل ل",
      "pos": "noun",
      "note": "pl. أَطْلَال aṭlāl; the qasida traditionally opens with the poet halting to weep over them (الْوُقُوفُ عَلَى الْأَطْلَال)."
     },
     {
      "ar": "دِيَار",
      "translit": "diyār",
      "en": "abodes, dwelling-places",
      "root": "د و ر",
      "pos": "noun",
      "note": "broken pl. of دَار dār; the beloved's departed encampments, standard object of the poet's address."
     },
     {
      "ar": "رَبْع",
      "translit": "rabʿ",
      "en": "springtime abode, camping ground",
      "root": "ر ب ع",
      "pos": "noun",
      "note": "pl. رِبَاع ribāʿ, أَرْبُع arbuʿ; from the same root as رَبِيع 'spring'."
     },
     {
      "ar": "دِمْنَة",
      "translit": "dimna",
      "en": "darkened trace of habitation",
      "root": "د م ن",
      "pos": "noun",
      "note": "pl. دِمَن diman; ground blackened by dung and ashes — Zuhayr's muʿallaqa opens with one."
     },
     {
      "ar": "نَاقَة",
      "translit": "nāqa",
      "en": "she-camel",
      "root": "ن و ق",
      "pos": "noun",
      "note": "pl. نُوق nūq, نِيَاق niyāq; mount of the journey section (الرَّحِيل) and object of loving description."
     },
     {
      "ar": "بَيْدَاء",
      "translit": "baydāʾ",
      "en": "trackless desert, wasteland",
      "root": "ب ي د",
      "pos": "noun",
      "note": "pl. بِيد bīd; from بَادَ bāda 'to perish' — the desert that destroys those who cross it."
     },
     {
      "ar": "رَمْل",
      "translit": "raml",
      "en": "sand, sand dune",
      "root": "ر م ل",
      "pos": "noun",
      "note": "pl. رِمَال rimāl; the related رَمَل ramal (note the fatḥa) names one of the sixteen poetic metres."
     },
     {
      "ar": "وَادٍ",
      "translit": "wādin",
      "en": "valley, watercourse",
      "root": "و د ي",
      "pos": "noun",
      "note": "pl. أَوْدِيَة awdiya; defective noun — the tanwīn is its citation form; definite الْوَادِي al-wādī."
     },
     {
      "ar": "غَيْث",
      "translit": "ghayth",
      "en": "abundant rain",
      "root": "غ ي ث",
      "pos": "noun",
      "note": "pl. غُيُوث ghuyūth; rain as blessing and generosity — a generous man is likened to غَيْث."
     },
     {
      "ar": "بَرْق",
      "translit": "barq",
      "en": "lightning",
      "root": "ب ر ق",
      "pos": "noun",
      "note": "pl. بُرُوق burūq; poets watch distant lightning to guess where rain — and the beloved's tribe — may be."
     },
     {
      "ar": "سَرَاب",
      "translit": "sarāb",
      "en": "mirage",
      "root": "س ر ب",
      "pos": "noun",
      "note": "the shimmering illusion of midday; the early-morning mirage is آل āl — poets distinguish the two."
     },
     {
      "ar": "ظَبْي",
      "translit": "ẓaby",
      "en": "gazelle",
      "root": "ظ ب ي",
      "pos": "noun",
      "note": "pl. ظِبَاء ẓibāʾ; the beloved's eyes and neck are conventionally the gazelle's; fem. ظَبْيَة ẓabya."
     },
     {
      "ar": "أَثَافٍ",
      "translit": "athāfin",
      "en": "hearthstones",
      "root": "أ ث ف",
      "pos": "noun",
      "note": "pl. of أُثْفِيَّة uthfiyya; the three fire-blackened stones that prop the cooking-pot, left standing amid the ruins."
     },
     {
      "ar": "هَوْدَج",
      "translit": "hawdaj",
      "en": "camel litter",
      "root": "ه و د ج",
      "pos": "noun",
      "note": "pl. هَوَادِج hawādij; the curtained litter bearing the women away on the day of departure."
     }
    ]
   },
   {
    "id": "u22",
    "title": "Rhetoric & Letters",
    "titleAr": "الْبَلَاغَةُ وَالْأَدَب",
    "icon": "🖋️",
    "intro": "This is the working vocabulary of the critics and anthologists — the terms in which the tradition praised, scanned, and dissected its own poetry and prose.",
    "words": [
     {
      "ar": "بَلَاغَة",
      "translit": "balāgha",
      "en": "eloquence; the science of rhetoric",
      "root": "ب ل غ",
      "pos": "noun",
      "note": "from بَلَغَ 'to reach (the mark)'; its three branches: الْمَعَانِي, الْبَيَان, الْبَدِيع."
     },
     {
      "ar": "فَصَاحَة",
      "translit": "faṣāḥa",
      "en": "purity and clarity of diction",
      "root": "ف ص ح",
      "pos": "noun",
      "note": "adj. فَصِيح faṣīḥ 'eloquent, pure of speech' — whence الْفُصْحَى al-fuṣḥā itself."
     },
     {
      "ar": "نَثْر",
      "translit": "nathr",
      "en": "prose",
      "root": "ن ث ر",
      "pos": "noun",
      "note": "lit. 'scattering (of pearls)'; the standing opposite of نَظْم."
     },
     {
      "ar": "نَظْم",
      "translit": "naẓm",
      "en": "versification; ordered composition",
      "root": "ن ظ م",
      "pos": "noun",
      "note": "lit. 'stringing pearls'; al-Jurjānī's نَظْم theory grounds the inimitability of the Qurʾān in word order."
     },
     {
      "ar": "قَصِيدَة",
      "translit": "qaṣīda",
      "en": "ode, formal poem",
      "root": "ق ص د",
      "pos": "noun",
      "note": "pl. قَصَائِد qaṣāʾid; a mono-rhymed, mono-metred poem, classically of some length and multiple movements."
     },
     {
      "ar": "قَافِيَة",
      "translit": "qāfiya",
      "en": "rhyme",
      "root": "ق ف و",
      "pos": "noun",
      "note": "pl. قَوَافٍ qawāfin; one rhyme consonant (الرَّوِيّ) runs unchanged through the entire ode."
     },
     {
      "ar": "عَرُوض",
      "translit": "ʿarūḍ",
      "en": "prosody, the science of metre",
      "root": "ع ر ض",
      "pos": "noun",
      "note": "feminine; founded by al-Khalīl ibn Aḥmad, who mapped fifteen metres (الْبُحُور) — al-Akhfash later added the sixteenth, الْمُتَدَارِك."
     },
     {
      "ar": "مَجَاز",
      "translit": "majāz",
      "en": "figurative usage, trope",
      "root": "ج و ز",
      "pos": "noun",
      "note": "lit. 'a crossing-over'; opposite of حَقِيقَة ḥaqīqa 'literal usage'."
     },
     {
      "ar": "تَشْبِيه",
      "translit": "tashbīh",
      "en": "simile",
      "root": "ش ب ه",
      "pos": "noun",
      "note": "comparison with an explicit tool: the kāf or مِثْل mithl; its two terms are الْمُشَبَّه and الْمُشَبَّهُ بِهِ."
     },
     {
      "ar": "اِسْتِعَارَة",
      "translit": "istiʿāra",
      "en": "metaphor",
      "root": "ع و ر",
      "pos": "noun",
      "note": "lit. 'borrowing'; a تَشْبِيه with one of its two terms suppressed."
     },
     {
      "ar": "كِنَايَة",
      "translit": "kināya",
      "en": "metonymy, indirect expression",
      "root": "ك ن ي",
      "pos": "noun",
      "note": "e.g. كَثِيرُ الرَّمَادِ kathīru r-ramādi 'much ash at his hearth' = generous."
     },
     {
      "ar": "دِيوَان",
      "translit": "dīwān",
      "en": "collected poems; register",
      "root": "د و ن",
      "pos": "noun",
      "note": "pl. دَوَاوِين dawāwīn; also the state chancery — hence الشِّعْرُ دِيوَانُ الْعَرَبِ 'poetry is the register of the Arabs.'"
     },
     {
      "ar": "أَدَب",
      "translit": "adab",
      "en": "belles-lettres; refined culture",
      "root": "أ د ب",
      "pos": "noun",
      "note": "pl. آدَاب ādāb; spans literature and polished manners alike; the littérateur is أَدِيب adīb."
     },
     {
      "ar": "بَدِيع",
      "translit": "badīʿ",
      "en": "rhetorical embellishment",
      "root": "ب د ع",
      "pos": "noun",
      "note": "figures such as جِنَاس paronomasia and طِبَاق antithesis; Ibn al-Muʿtazz wrote the first treatise on it."
     }
    ]
   },
   {
    "id": "u23",
    "title": "Law & Scholarship",
    "titleAr": "الْفِقْهُ وَالْعِلْم",
    "icon": "⚖️",
    "intro": "The madrasa's core terms: how rulings are derived, reports transmitted, and proofs weighed in law, hadith, and exegesis.",
    "words": [
     {
      "ar": "فِقْه",
      "translit": "fiqh",
      "en": "jurisprudence",
      "root": "ف ق ه",
      "pos": "noun",
      "note": "lit. 'deep understanding'; the jurist is فَقِيه faqīh, pl. فُقَهَاء fuqahāʾ."
     },
     {
      "ar": "اِجْتِهَاد",
      "translit": "ijtihād",
      "en": "independent legal reasoning",
      "root": "ج ه د",
      "pos": "noun",
      "note": "Form VIII verbal noun, 'utmost exertion'; its practitioner is a مُجْتَهِد mujtahid."
     },
     {
      "ar": "إِجْمَاع",
      "translit": "ijmāʿ",
      "en": "consensus of the scholars",
      "root": "ج م ع",
      "pos": "noun",
      "note": "the third source of law, after the Qurʾān and the sunna."
     },
     {
      "ar": "قِيَاس",
      "translit": "qiyās",
      "en": "analogical reasoning",
      "root": "ق ي س",
      "pos": "noun",
      "note": "lit. 'measuring' a new case against a precedent; the fourth source of law."
     },
     {
      "ar": "فَتْوَى",
      "translit": "fatwā",
      "en": "legal opinion",
      "root": "ف ت ي",
      "pos": "noun",
      "note": "pl. فَتَاوَى fatāwā; issued by a مُفْتٍ muftin in answer to a question, without binding force."
     },
     {
      "ar": "رِوَايَة",
      "translit": "riwāya",
      "en": "transmission; transmitted report",
      "root": "ر و ي",
      "pos": "noun",
      "note": "the transmitter is رَاوٍ rāwin, pl. رُوَاة ruwāt; only much later 'novel'."
     },
     {
      "ar": "إِسْنَاد",
      "translit": "isnād",
      "en": "chain of transmission",
      "root": "س ن د",
      "pos": "noun",
      "note": "pl. أَسَانِيد asānīd; the 'so-and-so told me, from so-and-so' backbone of every hadith."
     },
     {
      "ar": "مَتْن",
      "translit": "matn",
      "en": "text (of a report)",
      "root": "م ت ن",
      "pos": "noun",
      "note": "pl. مُتُون mutūn; the wording of a ḥadīth, as opposed to its إِسْنَاد chain"
     },
     {
      "ar": "حُجَّة",
      "translit": "ḥujja",
      "en": "decisive proof, authority",
      "root": "ح ج ج",
      "pos": "noun",
      "note": "pl. حُجَج ḥujaj; also an honorific for a master hadith scholar."
     },
     {
      "ar": "دَلِيل",
      "translit": "dalīl",
      "en": "evidence, indicant",
      "root": "د ل ل",
      "pos": "noun",
      "note": "pl. أَدِلَّة adilla; the textual or rational evidence on which a ruling rests; also 'guide'."
     },
     {
      "ar": "مَذْهَب",
      "translit": "madhhab",
      "en": "school of law; doctrine",
      "root": "ذ ه ب",
      "pos": "noun",
      "note": "pl. مَذَاهِب madhāhib; lit. 'way taken' — the four Sunni schools are the classic examples."
     },
     {
      "ar": "تَفْسِير",
      "translit": "tafsīr",
      "en": "Qurʾānic exegesis",
      "root": "ف س ر",
      "pos": "noun",
      "note": "pl. تَفَاسِير tafāsīr; the genre's monument is al-Ṭabarī's commentary."
     },
     {
      "ar": "بِدْعَة",
      "translit": "bidʿa",
      "en": "innovation in religion",
      "root": "ب د ع",
      "pos": "noun",
      "note": "pl. بِدَع bidaʿ; pejorative in legal writing, as the opposite of established practice."
     },
     {
      "ar": "نَصّ",
      "translit": "naṣṣ",
      "en": "explicit text, authoritative wording",
      "root": "ن ص ص",
      "pos": "noun",
      "note": "pl. نُصُوص nuṣūṣ; a ruling given بِالنَّصِّ rests on explicit wording, not inference."
     }
    ]
   },
   {
    "id": "u24",
    "title": "Philosophy & the Mind",
    "titleAr": "الْفَلْسَفَةُ وَالْعَقْل",
    "icon": "💭",
    "intro": "The shared technical lexicon of the falāsifa and the mutakallimūn — open Ibn Sīnā or al-Ghazālī and these words stand on every page.",
    "words": [
     {
      "ar": "وُجُود",
      "translit": "wujūd",
      "en": "existence, being",
      "root": "و ج د",
      "pos": "noun",
      "note": "verbal noun of وَجَدَ 'to find'; Ibn Sīnā's God is وَاجِبُ الْوُجُودِ 'the Necessary Existent'."
     },
     {
      "ar": "عَدَم",
      "translit": "ʿadam",
      "en": "nonexistence, privation",
      "root": "ع د م",
      "pos": "noun",
      "note": "the standing opposite of وُجُود; creation from nothing is مِنَ الْعَدَمِ."
     },
     {
      "ar": "جَوْهَر",
      "translit": "jawhar",
      "en": "substance; essence",
      "root": "ج و ه ر",
      "pos": "noun",
      "note": "pl. جَوَاهِر jawāhir; arabicized Persian gawhar 'jewel'; what subsists in itself, vs. عَرَض."
     },
     {
      "ar": "عَرَض",
      "translit": "ʿaraḍ",
      "en": "accident (philosophical)",
      "root": "ع ر ض",
      "pos": "noun",
      "note": "pl. أَعْرَاض aʿrāḍ; a quality inhering in a substance — color, motion, heat."
     },
     {
      "ar": "عِلَّة",
      "translit": "ʿilla",
      "en": "cause",
      "root": "ع ل ل",
      "pos": "noun",
      "note": "pl. عِلَل ʿilal; also 'defect' in hadith criticism and 'weak radical' in grammar — a heavily worked term."
     },
     {
      "ar": "مَعْلُول",
      "translit": "maʿlūl",
      "en": "effect, the caused",
      "root": "ع ل ل",
      "pos": "noun",
      "note": "passive participle paired with its cause: الْعِلَّةُ وَالْمَعْلُول."
     },
     {
      "ar": "بُرْهَان",
      "translit": "burhān",
      "en": "demonstrative proof",
      "root": "ب ر ه ن",
      "pos": "noun",
      "note": "pl. بَرَاهِين barāhīn; the apodeictic demonstration of logic, the highest grade of argument."
     },
     {
      "ar": "مَنْطِق",
      "translit": "manṭiq",
      "en": "logic",
      "root": "ن ط ق",
      "pos": "noun",
      "note": "from نَطَقَ naṭaqa 'to speak'; the logician is مَنْطِقِيّ manṭiqī."
     },
     {
      "ar": "حِسّ",
      "translit": "ḥiss",
      "en": "sense perception",
      "root": "ح س س",
      "pos": "noun",
      "note": "the five senses are الْحَوَاسُّ الْخَمْس al-ḥawāssu l-khams; adjective حِسِّيّ 'sensible, empirical'."
     },
     {
      "ar": "وَهْم",
      "translit": "wahm",
      "en": "estimation; illusion",
      "root": "و ه م",
      "pos": "noun",
      "note": "pl. أَوْهَام awhām; in Avicennan psychology, the faculty by which the sheep 'perceives' the wolf's hostility."
     },
     {
      "ar": "يَقِين",
      "translit": "yaqīn",
      "en": "certainty",
      "root": "ي ق ن",
      "pos": "noun",
      "note": "knowledge that excludes all doubt; opposite of شَكّ."
     },
     {
      "ar": "شَكّ",
      "translit": "shakk",
      "en": "doubt",
      "root": "ش ك ك",
      "pos": "noun",
      "note": "pl. شُكُوك shukūk; al-Ghazālī's method makes doubt the road to certainty."
     },
     {
      "ar": "ظَنّ",
      "translit": "ẓann",
      "en": "supposition, probable opinion",
      "root": "ظ ن ن",
      "pos": "noun",
      "note": "pl. ظُنُون ẓunūn; graded between شَكّ and يَقِين — probable but not certain."
     },
     {
      "ar": "مَاهِيَّة",
      "translit": "māhiyya",
      "en": "quiddity, essence",
      "root": "—",
      "pos": "noun",
      "note": "coined from the question مَا هِيَ 'what is it?'; distinguished from existence in Avicenna's metaphysics."
     }
    ]
   },
   {
    "id": "u25",
    "title": "Becoming & Seeming",
    "titleAr": "أَخَوَاتُ كَانَ",
    "icon": "🌄",
    "intro": "These verbs enter a nominal sentence, keep its subject nominative, put its predicate in the accusative, and colour it with time, change, and continuance — no classical page goes far without them.",
    "words": [
     {
      "ar": "أَصْبَحَ",
      "translit": "aṣbaḥa",
      "en": "to become (by morning)",
      "root": "ص ب ح",
      "pos": "verb",
      "note": "pres. يُصْبِحُ yuṣbiḥu; kāna-sister — accusative predicate: أَصْبَحَ الْجَوُّ بَارِدًا; often simply 'to become'."
     },
     {
      "ar": "أَمْسَى",
      "translit": "amsā",
      "en": "to become (by evening)",
      "root": "م س ي",
      "pos": "verb",
      "note": "pres. يُمْسِي yumsī; kāna-sister; pairs with أَصْبَحَ to cover the whole day."
     },
     {
      "ar": "أَضْحَى",
      "translit": "aḍḥā",
      "en": "to become (by forenoon)",
      "root": "ض ح و",
      "pos": "verb",
      "note": "pres. يُضْحِي yuḍḥī; kāna-sister; from الضُّحَى, the bright forenoon."
     },
     {
      "ar": "بَاتَ",
      "translit": "bāta",
      "en": "to pass the night (in a state)",
      "root": "ب ي ت",
      "pos": "verb",
      "note": "pres. يَبِيتُ yabītu; kāna-sister: بَاتَ سَاهِرًا 'he spent the night awake'."
     },
     {
      "ar": "ظَلَّ",
      "translit": "ẓalla",
      "en": "to remain, keep on (by day)",
      "root": "ظ ل ل",
      "pos": "verb",
      "note": "pres. يَظَلُّ yaẓallu; kāna-sister — Qurʾānic: ظَلَّ وَجْهُهُ مُسْوَدًّا 'his face remained darkened'."
     },
     {
      "ar": "صَارَ",
      "translit": "ṣāra",
      "en": "to become",
      "root": "ص ي ر",
      "pos": "verb",
      "note": "pres. يَصِيرُ yaṣīru; the plain kāna-sister of transformation: صَارَ الْمَاءُ ثَلْجًا."
     },
     {
      "ar": "مَا زَالَ",
      "translit": "mā zāla",
      "en": "to be still, continue",
      "root": "ز ي ل",
      "pos": "verb",
      "note": "pres. لَا يَزَالُ lā yazālu; kāna-sister of continuance: مَا زَالَ قَائِمًا 'he is still standing'; distinct from زَالَ يَزُولُ 'to cease'."
     },
     {
      "ar": "مَا بَرِحَ",
      "translit": "mā bariḥa",
      "en": "to be still, not cease",
      "root": "ب ر ح",
      "pos": "verb",
      "note": "pres. لَا يَبْرَحُ lā yabraḥu; kāna-sister, synonym of مَا زَالَ; from بَرِحَ 'to depart'."
     },
     {
      "ar": "مَا فَتِئَ",
      "translit": "mā fatiʾa",
      "en": "to not cease, keep on",
      "root": "ف ت أ",
      "pos": "verb",
      "note": "pres. لَا يَفْتَأُ lā yaftaʾu; kāna-sister; after an oath the negative may drop: تَاللهِ تَفْتَأُ تَذْكُرُ يُوسُفَ (Q 12:85)."
     },
     {
      "ar": "مَا انْفَكَّ",
      "translit": "mā infakka",
      "en": "to not cease, remain",
      "root": "ف ك ك",
      "pos": "verb",
      "note": "pres. لَا يَنْفَكُّ lā yanfakku; kāna-sister; Form VII of فَكَّ 'to come loose'."
     },
     {
      "ar": "مَا دَامَ",
      "translit": "mā dāma",
      "en": "as long as (one) remains",
      "root": "د و م",
      "pos": "verb",
      "note": "kāna-sister used only after the temporal مَا: مَا دُمْتُ حَيًّا 'as long as I live' (Q 19:31)."
     },
     {
      "ar": "لَيْسَ",
      "translit": "laysa",
      "en": "to not be",
      "root": "ل ي س",
      "pos": "verb",
      "note": "frozen perfect-form verb; negates the nominal sentence: لَيْسَ الْأَمْرُ سَهْلًا; its predicate often takes بِـ: لَيْسَ بِسَهْلٍ."
     },
     {
      "ar": "بَدَا",
      "translit": "badā",
      "en": "to appear, seem",
      "root": "ب د و",
      "pos": "verb",
      "note": "pres. يَبْدُو yabdū; a full verb, not a kāna-sister: بَدَا لِي أَنَّ... 'it seemed to me that...'."
     },
     {
      "ar": "غَدَا",
      "translit": "ghadā",
      "en": "to become; to set out at morning",
      "root": "غ د و",
      "pos": "verb",
      "note": "pres. يَغْدُو yaghdū; as a kāna-sister it equals صَارَ; as a full verb, 'to go out early'."
     }
    ]
   },
   {
    "id": "u26",
    "title": "The Sea & the Sky",
    "titleAr": "الْبَحْرُ وَالسَّمَاءُ",
    "icon": "🌌",
    "intro": "Sailors, stargazers, and poets shared one cosmos: these are the words with which classical literature maps the heavens and the deep.",
    "words": [
     {
      "ar": "فُلْك",
      "translit": "fulk",
      "en": "ship, ark",
      "root": "ف ل ك",
      "pos": "noun",
      "note": "same form for singular and plural; distinguish from فَلَك falak 'celestial sphere'"
     },
     {
      "ar": "لُجَّة",
      "translit": "lujja",
      "en": "the deep (of the sea)",
      "root": "ل ج ج",
      "pos": "noun",
      "note": "a fathomless depth of water; cf. بَحْر لُجِّيّ (Qur. 24:40) \"a deep sea\""
     },
     {
      "ar": "مَوْج",
      "translit": "mawj",
      "en": "waves, surge",
      "root": "م و ج",
      "pos": "noun",
      "note": "collective; unit noun مَوْجَة mawja, pl. أَمْوَاج amwāj"
     },
     {
      "ar": "شَاطِئ",
      "translit": "shāṭiʾ",
      "en": "shore, bank",
      "root": "ش ط أ",
      "pos": "noun",
      "note": "pl. شَوَاطِئ shawāṭiʾ"
     },
     {
      "ar": "أُفُق",
      "translit": "ufuq",
      "en": "horizon",
      "root": "أ ف ق",
      "pos": "noun",
      "note": "pl. آفَاق āfāq 'the horizons, the wide world'"
     },
     {
      "ar": "شِهَاب",
      "translit": "shihāb",
      "en": "shooting star; firebrand",
      "root": "ش ه ب",
      "pos": "noun",
      "note": "pl. شُهُب shuhub"
     },
     {
      "ar": "بُرْج",
      "translit": "burj",
      "en": "tower; sign of the zodiac",
      "root": "ب ر ج",
      "pos": "noun",
      "note": "pl. بُرُوج burūj"
     },
     {
      "ar": "فَلَك",
      "translit": "falak",
      "en": "celestial sphere, orbit",
      "root": "ف ل ك",
      "pos": "noun",
      "note": "pl. أَفْلَاك aflāk; عِلْمُ الْفَلَك ʿilmu l-falak is astronomy"
     },
     {
      "ar": "هِلَال",
      "translit": "hilāl",
      "en": "crescent moon",
      "root": "ه ل ل",
      "pos": "noun",
      "note": "pl. أَهِلَّة ahilla; the new crescent that opens the month"
     },
     {
      "ar": "كَوْكَب",
      "translit": "kawkab",
      "en": "planet, bright star",
      "root": "ك و ك ب",
      "pos": "noun",
      "note": "pl. كَوَاكِب kawākib"
     },
     {
      "ar": "ثُرَيَّا",
      "translit": "thurayyā",
      "en": "the Pleiades",
      "root": "ث ر ي",
      "pos": "noun",
      "note": "used with the article: الثُّرَيَّا ath-thurayyā; proverbial for what is lofty and far"
     },
     {
      "ar": "سَحَاب",
      "translit": "saḥāb",
      "en": "clouds",
      "root": "س ح ب",
      "pos": "noun",
      "note": "collective; unit noun سَحَابَة saḥāba, pl. سُحُب suḥub"
     },
     {
      "ar": "مَشْرِق",
      "translit": "mashriq",
      "en": "east, place of sunrise",
      "root": "ش ر ق",
      "pos": "noun",
      "note": "pl. مَشَارِق mashāriq; opposite الْمَغْرِب al-maghrib"
     },
     {
      "ar": "مَغْرِب",
      "translit": "maghrib",
      "en": "west, place of sunset",
      "root": "غ ر ب",
      "pos": "noun",
      "note": "pl. مَغَارِب maghārib; also the time of sunset"
     }
    ]
   },
   {
    "id": "u27",
    "title": "The Court & the Caravan",
    "titleAr": "الْقَصْرُ وَالْقَافِلَةُ",
    "icon": "🐪",
    "intro": "From the caliph's audience hall to the desert caravan, this is the vocabulary of classical civilization in motion.",
    "words": [
     {
      "ar": "عَرْش",
      "translit": "ʿarsh",
      "en": "throne",
      "root": "ع ر ش",
      "pos": "noun",
      "note": "pl. عُرُوش ʿurūsh; the royal — and in the Qurʾān the divine — throne"
     },
     {
      "ar": "تَاج",
      "translit": "tāj",
      "en": "crown",
      "root": "ت و ج",
      "pos": "noun",
      "note": "pl. تِيجَان tījān; the crowned king is الْمُتَوَّج"
     },
     {
      "ar": "رَعِيَّة",
      "translit": "raʿiyya",
      "en": "subjects, the governed",
      "root": "ر ع ي",
      "pos": "noun",
      "note": "pl. رَعَايَا raʿāyā; from رَعَى \"to shepherd\" — the ruler's flock"
     },
     {
      "ar": "حَاجِب",
      "translit": "ḥājib",
      "en": "chamberlain",
      "root": "ح ج ب",
      "pos": "noun",
      "note": "pl. حُجَّاب ḥujjāb; from حَجَبَ 'to screen off'; also 'eyebrow'"
     },
     {
      "ar": "رِسَالَة",
      "translit": "risāla",
      "en": "epistle, letter",
      "root": "ر س ل",
      "pos": "noun",
      "note": "pl. رَسَائِل rasāʾil; the classical literary letter, and the messenger's mission"
     },
     {
      "ar": "مَجْلِس",
      "translit": "majlis",
      "en": "assembly, salon, session",
      "root": "ج ل س",
      "pos": "noun",
      "note": "pl. مَجَالِس majālis; from جَلَسَ 'to sit'"
     },
     {
      "ar": "نَدِيم",
      "translit": "nadīm",
      "en": "boon companion",
      "root": "ن د م",
      "pos": "noun",
      "note": "pl. نُدَمَاء nudamāʾ; the ruler's cultured drinking companion"
     },
     {
      "ar": "غُلَام",
      "translit": "ghulām",
      "en": "boy, page, servant",
      "root": "غ ل م",
      "pos": "noun",
      "note": "pl. غِلْمَان ghilmān"
     },
     {
      "ar": "ضَيْف",
      "translit": "ḍayf",
      "en": "guest",
      "root": "ض ي ف",
      "pos": "noun",
      "note": "pl. ضُيُوف ḍuyūf and أَضْيَاف aḍyāf"
     },
     {
      "ar": "وَفْد",
      "translit": "wafd",
      "en": "delegation, deputation",
      "root": "و ف د",
      "pos": "noun",
      "note": "pl. وُفُود wufūd"
     },
     {
      "ar": "قَافِلَة",
      "translit": "qāfila",
      "en": "caravan",
      "root": "ق ف ل",
      "pos": "noun",
      "note": "pl. قَوَافِل qawāfil; from قَفَلَ 'to return'"
     },
     {
      "ar": "رَاحِلَة",
      "translit": "rāḥila",
      "en": "riding camel, mount",
      "root": "ر ح ل",
      "pos": "noun",
      "note": "pl. رَوَاحِل rawāḥil; the beast one journeys on"
     },
     {
      "ar": "خَيْمَة",
      "translit": "khayma",
      "en": "tent",
      "root": "خ ي م",
      "pos": "noun",
      "note": "pl. خِيَام khiyām"
     },
     {
      "ar": "بَرِيد",
      "translit": "barīd",
      "en": "post, courier service",
      "root": "ب ر د",
      "pos": "noun",
      "note": "the caliphal courier relay; also a unit of distance"
     },
     {
      "ar": "خَرَاج",
      "translit": "kharāj",
      "en": "land tax",
      "root": "خ ر ج",
      "pos": "noun",
      "note": "the tax levied on conquered agricultural land"
     }
    ]
   },
   {
    "id": "u28",
    "title": "Illness & Healing",
    "titleAr": "الدَّاءُ وَالدَّوَاءُ",
    "icon": "🌿",
    "intro": "The physician's Arabic — disease and remedy, wound and recovery — runs through medicine, poetry, and prayer alike.",
    "words": [
     {
      "ar": "دَاء",
      "translit": "dāʾ",
      "en": "disease, ailment",
      "root": "د و أ",
      "pos": "noun",
      "note": "pl. أَدْوَاء adwāʾ; proverb: لِكُلِّ دَاءٍ دَوَاءٌ li-kulli dāʾin dawāʾun 'every disease has a cure'"
     },
     {
      "ar": "دَوَاء",
      "translit": "dawāʾ",
      "en": "remedy, medicine",
      "root": "د و ي",
      "pos": "noun",
      "note": "pl. أَدْوِيَة adwiya"
     },
     {
      "ar": "مَرَض",
      "translit": "maraḍ",
      "en": "illness, sickness",
      "root": "م ر ض",
      "pos": "noun",
      "note": "pl. أَمْرَاض amrāḍ; adj. مَرِيض marīḍ 'sick'"
     },
     {
      "ar": "طَبِيب",
      "translit": "ṭabīb",
      "en": "physician",
      "root": "ط ب ب",
      "pos": "noun",
      "note": "pl. أَطِبَّاء aṭibbāʾ; the art is الطِّبّ aṭ-ṭibb"
     },
     {
      "ar": "جُرْح",
      "translit": "jurḥ",
      "en": "wound",
      "root": "ج ر ح",
      "pos": "noun",
      "note": "pl. جُرُوح jurūḥ and جِرَاح jirāḥ"
     },
     {
      "ar": "أَلَم",
      "translit": "alam",
      "en": "pain",
      "root": "أ ل م",
      "pos": "noun",
      "note": "pl. آلَام ālām"
     },
     {
      "ar": "حُمَّى",
      "translit": "ḥummā",
      "en": "fever",
      "root": "ح م م",
      "pos": "noun",
      "note": "feminine; the sufferer is مَحْمُوم maḥmūm"
     },
     {
      "ar": "سُمّ",
      "translit": "summ",
      "en": "poison",
      "root": "س م م",
      "pos": "noun",
      "note": "pl. سُمُوم sumūm; also vocalized سَمّ samm"
     },
     {
      "ar": "سَقِيم",
      "translit": "saqīm",
      "en": "sick, ailing",
      "root": "س ق م",
      "pos": "adj",
      "note": "fem. سَقِيمَة saqīma; synonym of مَرِيض marīḍ; also of faulty speech"
     },
     {
      "ar": "عِلَاج",
      "translit": "ʿilāj",
      "en": "treatment, therapy",
      "root": "ع ل ج",
      "pos": "noun",
      "note": "from عَالَجَ ʿālaja 'to treat' (Form III)"
     },
     {
      "ar": "شِفَاء",
      "translit": "shifāʾ",
      "en": "cure, healing",
      "root": "ش ف ي",
      "pos": "noun",
      "note": "verbal noun of شَفَى"
     },
     {
      "ar": "شَفَى",
      "translit": "shafā",
      "en": "to heal, cure",
      "root": "ش ف ي",
      "pos": "verb",
      "note": "Form I; pres. يَشْفِي yashfī"
     },
     {
      "ar": "بُرْء",
      "translit": "burʾ",
      "en": "recovery, convalescence",
      "root": "ب ر أ",
      "pos": "noun",
      "note": "from بَرِئَ bariʾa 'to recover'"
     },
     {
      "ar": "عَافِيَة",
      "translit": "ʿāfiya",
      "en": "health, well-being",
      "root": "ع ف و",
      "pos": "noun",
      "note": "soundness of body; paired with الصِّحَّة aṣ-ṣiḥḥa"
     }
    ]
   },
   {
    "id": "u29",
    "title": "Refined Description",
    "titleAr": "الْوَصْفُ الرَّفِيعُ",
    "icon": "💎",
    "intro": "Classical critics praised and damned with precision; these adjectives let you weigh style, character, and worth like a connoisseur.",
    "words": [
     {
      "ar": "بَلِيغ",
      "translit": "balīgh",
      "en": "eloquent, telling",
      "root": "ب ل غ",
      "pos": "adj",
      "note": "pl. بُلَغَاء bulaghāʾ; whence الْبَلَاغَة al-balāgha 'eloquence'"
     },
     {
      "ar": "فَصِيح",
      "translit": "faṣīḥ",
      "en": "eloquent, pure in speech",
      "root": "ف ص ح",
      "pos": "adj",
      "note": "pl. فُصَحَاء fuṣaḥāʾ; whence الْفُصْحَى al-fuṣḥā"
     },
     {
      "ar": "وَجِيز",
      "translit": "wajīz",
      "en": "concise, brief",
      "root": "و ج ز",
      "pos": "adj",
      "note": "of speech; antonym مُطْنِب muṭnib 'prolix'"
     },
     {
      "ar": "جَزِيل",
      "translit": "jazīl",
      "en": "abundant, ample",
      "root": "ج ز ل",
      "pos": "adj",
      "note": "of gifts and rewards: عَطَاءٌ جَزِيلٌ ʿaṭāʾun jazīlun"
     },
     {
      "ar": "رَصِين",
      "translit": "raṣīn",
      "en": "firm, well-knit (of style)",
      "root": "ر ص ن",
      "pos": "adj",
      "note": "antonym رَكِيك rakīk"
     },
     {
      "ar": "رَكِيك",
      "translit": "rakīk",
      "en": "feeble, weak (of style)",
      "root": "ر ك ك",
      "pos": "adj",
      "note": "the critic's verdict on limp prose; antonym رَصِين raṣīn"
     },
     {
      "ar": "غَزِير",
      "translit": "ghazīr",
      "en": "copious, plentiful",
      "root": "غ ز ر",
      "pos": "adj",
      "note": "fem. غَزِيرَة ghazīra; of rain, tears, and learning"
     },
     {
      "ar": "نَفِيس",
      "translit": "nafīs",
      "en": "precious, priceless",
      "root": "ن ف س",
      "pos": "adj",
      "note": "pl. (of things) نَفَائِس nafāʾis 'treasures'"
     },
     {
      "ar": "أَصِيل",
      "translit": "aṣīl",
      "en": "of noble origin, authentic",
      "root": "أ ص ل",
      "pos": "adj",
      "note": "pl. أُصَلَاء uṣalāʾ; as a noun it is also \"late afternoon\" (بُكْرَةً وَأَصِيلًا) — context decides"
     },
     {
      "ar": "جَلِيل",
      "translit": "jalīl",
      "en": "majestic, momentous",
      "root": "ج ل ل",
      "pos": "adj",
      "note": "pl. أَجِلَّاء ajillāʾ; antonym حَقِير ḥaqīr"
     },
     {
      "ar": "حَقِير",
      "translit": "ḥaqīr",
      "en": "contemptible, paltry",
      "root": "ح ق ر",
      "pos": "adj",
      "note": "fem. حَقِيرَة ḥaqīra; antonym جَلِيل jalīl"
     },
     {
      "ar": "رَفِيع",
      "translit": "rafīʿ",
      "en": "lofty, elevated",
      "root": "ر ف ع",
      "pos": "adj",
      "note": "antonym وَضِيع waḍīʿ"
     },
     {
      "ar": "وَضِيع",
      "translit": "waḍīʿ",
      "en": "lowly, base",
      "root": "و ض ع",
      "pos": "adj",
      "note": "antonym رَفِيع rafīʿ"
     },
     {
      "ar": "عَذْب",
      "translit": "ʿadhb",
      "en": "sweet, agreeable",
      "root": "ع ذ ب",
      "pos": "adj",
      "note": "of water and of verse; antonym (of water) أُجَاج ujāj 'bitter'"
     }
    ]
   },
   {
    "id": "u30",
    "title": "Eloquent Verbs",
    "titleAr": "أَفْعَالُ الْبُلَغَاءِ",
    "icon": "✒️",
    "intro": "These derived-form verbs are the workhorses of elegant classical prose and poetry — each note names the verb's form and present tense.",
    "words": [
     {
      "ar": "اِرْتَحَلَ",
      "translit": "irtaḥala",
      "en": "to depart, journey on",
      "root": "ر ح ل",
      "pos": "verb",
      "note": "Form VIII; pres. يَرْتَحِلُ yartaḥilu; the qasida's verb of departure"
     },
     {
      "ar": "تَأَمَّلَ",
      "translit": "taʾammala",
      "en": "to contemplate, gaze reflectively",
      "root": "أ م ل",
      "pos": "verb",
      "note": "Form V; pres. يَتَأَمَّلُ yataʾammalu"
     },
     {
      "ar": "تَدَبَّرَ",
      "translit": "tadabbara",
      "en": "to ponder, reflect deeply",
      "root": "د ب ر",
      "pos": "verb",
      "note": "Form V; pres. يَتَدَبَّرُ yatadabbaru"
     },
     {
      "ar": "أَدْرَكَ",
      "translit": "adraka",
      "en": "to grasp, attain, overtake",
      "root": "د ر ك",
      "pos": "verb",
      "note": "Form IV; pres. يُدْرِكُ yudriku; of seizing both physically and mentally"
     },
     {
      "ar": "تَجَلَّى",
      "translit": "tajallā",
      "en": "to become manifest, shine forth",
      "root": "ج ل و",
      "pos": "verb",
      "note": "Form V; pres. يَتَجَلَّى yatajallā; of dawn, truth, and theophany"
     },
     {
      "ar": "اِزْدَادَ",
      "translit": "izdāda",
      "en": "to increase, grow",
      "root": "ز ي د",
      "pos": "verb",
      "note": "Form VIII — its تاء becomes دال after the ز; pres. يَزْدَادُ yazdādu"
     },
     {
      "ar": "اِنْقَضَى",
      "translit": "inqaḍā",
      "en": "to elapse, come to an end",
      "root": "ق ض ي",
      "pos": "verb",
      "note": "Form VII; pres. يَنْقَضِي yanqaḍī; of time and lives running out"
     },
     {
      "ar": "تَوَارَى",
      "translit": "tawārā",
      "en": "to hide oneself, vanish",
      "root": "و ر ي",
      "pos": "verb",
      "note": "Form VI; pres. يَتَوَارَى yatawārā; of the sun setting and persons slipping from view"
     },
     {
      "ar": "اِبْتَغَى",
      "translit": "ibtaghā",
      "en": "to seek, desire",
      "root": "ب غ ي",
      "pos": "verb",
      "note": "Form VIII; pres. يَبْتَغِي yabtaghī; loftier than طَلَبَ"
     },
     {
      "ar": "أَنْشَدَ",
      "translit": "anshada",
      "en": "to recite (poetry)",
      "root": "ن ش د",
      "pos": "verb",
      "note": "Form IV; pres. يُنْشِدُ yunshidu; the verb for declaiming verse aloud"
     },
     {
      "ar": "اِقْتَبَسَ",
      "translit": "iqtabasa",
      "en": "to borrow, quote",
      "root": "ق ب س",
      "pos": "verb",
      "note": "Form VIII; pres. يَقْتَبِسُ yaqtabisu; originally 'to take a live coal', hence 'to quote'"
     },
     {
      "ar": "أَجَادَ",
      "translit": "ajāda",
      "en": "to do excellently, master",
      "root": "ج و د",
      "pos": "verb",
      "note": "Form IV; pres. يُجِيدُ yujīdu"
     },
     {
      "ar": "تَبَسَّمَ",
      "translit": "tabassama",
      "en": "to smile",
      "root": "ب س م",
      "pos": "verb",
      "note": "Form V; pres. يَتَبَسَّمُ yatabassamu; the dignified smile of classical narrative"
     },
     {
      "ar": "اِرْتَجَلَ",
      "translit": "irtajala",
      "en": "to improvise (speech or verse)",
      "root": "ر ج ل",
      "pos": "verb",
      "note": "Form VIII; pres. يَرْتَجِلُ yartajilu; to compose on the spot, without preparation"
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
   },
   {
    "id": "g13",
    "title": "The Passive Voice",
    "titleAr": "الْمَبْنِيُّ لِلْمَجْهُولِ",
    "tagline": "Hide the doer, keep the deed: two vowel changes turn any verb inside out.",
    "body": [
     "Sometimes Classical Arabic wants the deed without the doer. When the agent is unknown, obvious, or deliberately left unnamed, the verb is rebuilt \"for the unknown\": الْفِعْلُ الْمَبْنِيُّ لِلْمَجْهُولِ. In the perfect, the pattern becomes فُعِلَ — a ḍamma on the first radical and a kasra before the last: كَتَبَ \"he wrote\" becomes كُتِبَ \"it was written\", and فَتَحَ becomes فُتِحَ.",
     "In the imperfect the pattern is يُفْعَلُ: the prefix takes ḍamma and the vowel before the final radical becomes fatḥa, whatever it was in the active. So يَكْتُبُ becomes يُكْتَبُ \"it is written\" and يَفْتَحُ becomes يُفْتَحُ. These two vowel changes are the whole machinery — the consonants of the root never move.",
     "With the doer gone, the old object steps into the empty seat of the subject. It is now called نَائِبُ الْفَاعِلِ, \"the deputy of the doer\", and like the fāʿil whose place it fills, it takes rafʿ. Compare كَتَبَ الرَّجُلُ الْكِتَابَ with كُتِبَ الْكِتَابُ: as object the book was manṣūb; as deputy it rises to ḍamma.",
     "Classical prose reaches for the passive precisely in order to silence the agent: when he is unknown (سُرِقَ الْمَتَاعُ \"the goods were stolen\"), when he is universally understood (خُلِقَ الْإِنْسَانُ \"man was created\" — by God), or when courtesy veils him. When a classical author wishes to name the doer, he simply returns to the active voice."
    ],
    "examples": [
     {
      "ar": "كُتِبَ الْكِتَابُ فِي بَغْدَادَ.",
      "translit": "kutiba al-kitābu fī baghdāda.",
      "en": "The book was written in Baghdad.",
      "note": "Perfect passive on the pattern فُعِلَ: ḍamma then kasra. الْكِتَابُ is the nāʾib al-fāʿil, so it stands in rafʿ. بَغْدَادَ is a diptote, so its jarr shows a fatḥa."
     },
     {
      "ar": "يُفْتَحُ الْبَابُ كُلَّ صَبَاحٍ.",
      "translit": "yuftaḥu al-bābu kulla ṣabāḥin.",
      "en": "The door is opened every morning.",
      "note": "Imperfect passive on the pattern يُفْعَلُ: ḍamma on the prefix, fatḥa before the last radical. The active is يَفْتَحُ — only the first vowel differs, so listen carefully."
     },
     {
      "ar": "قُتِلَ الْأَمِيرُ فِي الْمَعْرَكَةِ.",
      "translit": "qutila al-amīru fī al-maʿrakati.",
      "en": "The commander was killed in the battle.",
      "note": "A classic use of the passive in historical narration: the killer is unknown or unimportant, so the event itself takes center stage and الْأَمِيرُ becomes the deputy subject."
     },
     {
      "ar": "سُئِلَ الْعَالِمُ عَنْ مَسْأَلَةٍ صَعْبَةٍ.",
      "translit": "suʾila al-ʿālimu ʿan masʾalatin ṣaʿbatin.",
      "en": "The scholar was asked about a difficult question.",
      "note": "سُئِلَ is فُعِلَ applied to سَأَلَ; the hamza sits on yāʾ because of the surrounding kasra. This formula opens countless passages in classical scholarship."
     },
     {
      "ar": "يُعْرَفُ الرَّجُلُ بِأَفْعَالِهِ.",
      "translit": "yuʿrafu ar-rajulu bi-afʿālihi.",
      "en": "A man is known by his deeds.",
      "note": "A gnomic passive: no particular knower is meant, so the passive is the natural choice. الرَّجُلُ is nāʾib al-fāʿil in rafʿ; the active would be يَعْرِفُ."
     }
    ],
    "quiz": [
     {
      "q": "In the passive perfect, كَتَبَ becomes...",
      "options": [
       "كَتِبَ",
       "كُتِبَ",
       "كُتُبَ",
       "كِتَبَ"
      ],
      "answer": 1,
      "why": "The perfect passive follows فُعِلَ: ḍamma on the first radical, kasra before the last — كُتِبَ (kutiba), \"it was written\"."
     },
     {
      "q": "Which case does the نَائِبُ الْفَاعِلِ take?",
      "options": [
       "Naṣb, with fatḥa",
       "Jarr, with kasra",
       "Rafʿ, with ḍamma",
       "Jazm, with sukūn"
      ],
      "answer": 2,
      "why": "The deputy of the doer fills the seat of the fāʿil, and whoever sits in the subject's seat takes rafʿ."
     },
     {
      "q": "The passive of يَفْتَحُ is...",
      "options": [
       "يُفْتَحُ",
       "يَفْتُحُ",
       "يُفْتِحُ",
       "يَنْفَتِحُ"
      ],
      "answer": 0,
      "why": "Imperfect passive = ḍamma on the prefix + fatḥa before the last radical: يُفْتَحُ (yuftaḥu). يُفْتِحُ is Form IV active and يَنْفَتِحُ is Form VII."
     },
     {
      "q": "In كُسِرَ الْقَلَمُ, the word الْقَلَمُ is...",
      "options": [
       "the fāʿil",
       "the mafʿūl bihi",
       "the nāʾib al-fāʿil",
       "the mubtadaʾ"
      ],
      "answer": 2,
      "why": "The verb is passive (كُسِرَ, \"was broken\"), so the pen — the thing broken — has stepped into the subject's place as nāʾib al-fāʿil and taken rafʿ."
     },
     {
      "q": "Classical Arabic prefers the passive when...",
      "options": [
       "the doer is unknown, obvious, or deliberately unnamed",
       "the doer must be emphasized above all",
       "the action is negated",
       "the action lies in the future"
      ],
      "answer": 0,
      "why": "The passive exists to remove the agent from view — because he is unknown, universally understood, or politely concealed. To name the doer, classical style returns to the active."
     }
    ]
   },
   {
    "id": "g14",
    "title": "The Ḥāl",
    "titleAr": "الْحَال",
    "tagline": "The man came — but how? Riding, laughing, weeping? One accusative paints the scene.",
    "body": [
     "A verbal sentence tells you what happened; the ḥāl paints how the actor was while it happened. It answers the question كَيْفَ, \"in what state?\". In جَاءَ الرَّجُلُ رَاكِبًا \"the man came riding\", the word رَاكِبًا is the ḥāl, and الرَّجُلُ — the one whose state it depicts — is its owner, صَاحِبُ الْحَالِ.",
     "Three marks identify the single-word ḥāl: it is indefinite, it is manṣūb, and it is usually a derived descriptive such as an ism fāʿil. It agrees with its owner in gender and number: جَاءَتِ الْمَرْأَةُ رَاكِبَةً, جَاءَ الرِّجَالُ رَاكِبِينَ. The owner, by contrast, is normally definite — and this indefinite-after-definite pattern is how you tell a ḥāl from an ordinary adjective, which must match its noun in definiteness as well.",
     "A whole sentence may also serve as ḥāl. Most often it is tied to the main clause by وَاوُ الْحَالِ followed by a pronoun: خَرَجَ الْأَمِيرُ وَهُوَ يَبْتَسِمُ \"the prince went out while he was smiling\". An imperfect verb alone can do the same work without the wāw: جَاءَ يَرْكُضُ \"he came running\"."
    ],
    "examples": [
     {
      "ar": "جَاءَ الرَّجُلُ رَاكِبًا.",
      "translit": "jāʾa ar-rajulu rākiban.",
      "en": "The man came riding.",
      "note": "The textbook ḥāl: indefinite, manṣūb, an ism fāʿil describing the definite صَاحِبُ الْحَالِ at the very moment of the action."
     },
     {
      "ar": "رَجَعَتِ الْمَرْأَةُ مَسْرُورَةً.",
      "translit": "rajaʿati al-marʾatu masrūratan.",
      "en": "The woman returned pleased.",
      "note": "The ḥāl agrees with its feminine owner, hence the tāʾ marbūṭa: مَسْرُورَةً. Note رَجَعَتِ — the tāʾ takes kasra before hamzat al-waṣl to avoid two sukūns meeting."
     },
     {
      "ar": "شَرِبْتُ الْمَاءَ بَارِدًا.",
      "translit": "sharibtu al-māʾa bāridan.",
      "en": "I drank the water cold.",
      "note": "The owner of the ḥāl can be the object: بَارِدًا describes the state of الْمَاءَ when it was drunk — a passing state, not a permanent quality (that would be a ṣifa)."
     },
     {
      "ar": "دَخَلَ الطُّلَّابُ الْمَسْجِدَ خَاشِعِينَ.",
      "translit": "dakhala aṭ-ṭullābu al-masjida khāshiʿīna.",
      "en": "The students entered the mosque in humility.",
      "note": "Number agreement: a plural owner takes a plural ḥāl. The sound masculine plural shows its naṣb with ـِينَ, as you learned in the plurals lesson."
     },
     {
      "ar": "خَرَجَ الْأَمِيرُ وَهُوَ يَبْتَسِمُ.",
      "translit": "kharaja al-amīru wa-huwa yabtasimu.",
      "en": "The prince went out while he was smiling.",
      "note": "A ḥāl clause: وَاوُ الْحَالِ plus a pronoun referring back to the owner, then a full sentence. The whole clause sits in the position of naṣb."
     }
    ],
    "quiz": [
     {
      "q": "The single-word ḥāl always takes which case?",
      "options": [
       "Rafʿ",
       "Naṣb",
       "Jarr",
       "Whatever its owner takes"
      ],
      "answer": 1,
      "why": "The ḥāl is one of the fixed accusatives of Arabic: it is always manṣūb, regardless of the case of its owner."
     },
     {
      "q": "In شَرِبْتُ الْمَاءَ بَارِدًا, what does بَارِدًا describe?",
      "options": [
       "The state of the drinker",
       "The state of the water at the moment of drinking",
       "The vessel the water was in",
       "A permanent quality of all water"
      ],
      "answer": 1,
      "why": "The ḥāl here belongs to the object الْمَاءَ: the water was cold when I drank it. A permanent quality would be expressed with an adjective (ṣifa), not a ḥāl."
     },
     {
      "q": "Complete correctly: جَاءَتِ الْبِنْتُ ...",
      "options": [
       "رَاكِبًا",
       "رَاكِبَةٌ",
       "رَاكِبَةً",
       "الرَّاكِبَةُ"
      ],
      "answer": 2,
      "why": "The ḥāl must be feminine to match الْبِنْتُ, indefinite, and manṣūb: رَاكِبَةً. The masculine, the marfūʿ form, and the definite form each break one of the three rules."
     },
     {
      "q": "A typical single-word ḥāl is...",
      "options": [
       "definite and marfūʿ",
       "indefinite and manṣūb",
       "indefinite and majrūr",
       "definite and manṣūb"
      ],
      "answer": 1,
      "why": "Indefiniteness and naṣb are the two badges of the ḥāl — an indefinite accusative describing a definite owner. That mismatch in definiteness is what separates it from an adjective."
     },
     {
      "q": "The وَ in خَرَجَ الرَّجُلُ وَهُوَ يَضْحَكُ is...",
      "options": [
       "a simple conjunction joining two verbs",
       "the wāw of oath (qasam)",
       "wāw al-ḥāl, introducing a circumstantial clause",
       "part of the pronoun هُوَ"
      ],
      "answer": 2,
      "why": "This wāw does not add a second event; it opens a clause describing the man's state as he went out — \"he went out while he was laughing\". That is wāw al-ḥāl."
     }
    ]
   },
   {
    "id": "g15",
    "title": "The Tamyīz",
    "titleAr": "التَّمْيِيز",
    "tagline": "Twenty... twenty what? The accusative that rescues every vague sentence.",
    "body": [
     "Some words leave the listener hanging. عِشْرُونَ — twenty what? اِزْدَادَ — increased in what? The tamyīz is the indefinite manṣūb noun that pours content into that vagueness: عِشْرُونَ كِتَابًا \"twenty books\", اِزْدَادَ عِلْمًا \"he increased in knowledge\". Grammarians call it the accusative of specification.",
     "The first kind specifies a single vague word. After the numbers eleven through ninety-nine, the counted noun is a singular tamyīz: أَحَدَ عَشَرَ كَوْكَبًا \"eleven stars\", عِشْرُونَ كِتَابًا. The same happens after measures and weights: عِنْدِي رِطْلٌ زَيْتًا \"I have a pound of oil\".",
     "The second kind specifies a whole sentence. After verbs of increasing, filling, and excelling, and after the ism tafḍīl, the tamyīz names the respect in which the statement holds: اِزْدَادَ الطَّالِبُ عِلْمًا; طَابَ الرَّجُلُ نَفْسًا; هُوَ أَكْثَرُ مِنْكَ مَالًا. English usually renders it with \"in\": greater in wealth, increased in knowledge.",
     "Do not confuse it with the ḥāl you have just learned. Both are indefinite accusatives, but the ḥāl answers \"in what state?\" while the tamyīz answers \"in what respect?\". جَاءَ رَاكِبًا describes the comer's passing state; أَكْثَرُ مَالًا names the fixed dimension along which the comparison runs."
    ],
    "examples": [
     {
      "ar": "اِشْتَرَيْتُ عِشْرِينَ كِتَابًا.",
      "translit": "ishtaraytu ʿishrīna kitāban.",
      "en": "I bought twenty books.",
      "note": "After the tens (20–90) the counted noun is a singular manṣūb tamyīz: كِتَابًا, never a plural. عِشْرِينَ itself shows naṣb with yāʾ, like a sound masculine plural."
     },
     {
      "ar": "اِزْدَادَ الطَّالِبُ عِلْمًا.",
      "translit": "izdāda aṭ-ṭālibu ʿilman.",
      "en": "The student increased in knowledge.",
      "note": "Tamyīz of the sentence: the verb alone (\"increased\") is vague, and عِلْمًا names the respect in which the increase happened. This Form VIII verb is a favorite of classical scholarly prose."
     },
     {
      "ar": "هُوَ أَكْثَرُ مِنْكَ مَالًا.",
      "translit": "huwa aktharu minka mālan.",
      "en": "He is greater than you in wealth.",
      "note": "After the ism tafḍīl, the tamyīz tells you the dimension of the comparison. The construction echoes the Qurʾānic أَنَا أَكْثَرُ مِنْكَ مَالًا."
     },
     {
      "ar": "طَابَ الرَّجُلُ نَفْسًا.",
      "translit": "ṭāba ar-rajulu nafsan.",
      "en": "The man became glad of heart.",
      "note": "Literally \"the man was good — as to soul\". The tamyīz transfers the verb's meaning from the whole person to one aspect of him, a beloved classical turn of phrase."
     },
     {
      "ar": "عِنْدِي رِطْلٌ زَيْتًا.",
      "translit": "ʿindī riṭlun zaytan.",
      "en": "I have a pound of oil.",
      "note": "Tamyīz after a measure: رِطْلٌ is vague until زَيْتًا specifies it. Classical Arabic equally allows the iḍāfa رِطْلُ زَيْتٍ with the same meaning."
     }
    ],
    "quiz": [
     {
      "q": "The tamyīz is characteristically...",
      "options": [
       "definite and marfūʿ",
       "indefinite and manṣūb",
       "indefinite and majrūr",
       "definite and majrūr"
      ],
      "answer": 1,
      "why": "Like the ḥāl, the tamyīz is an indefinite accusative — but it specifies a respect or substance rather than describing a state."
     },
     {
      "q": "Complete correctly: اِشْتَرَى التَّاجِرُ ثَلَاثِينَ ...",
      "options": [
       "كِتَابٌ",
       "كُتُبًا",
       "كِتَابًا",
       "كِتَابٍ"
      ],
      "answer": 2,
      "why": "After the tens (20–90) the counted noun is a singular manṣūb tamyīz: ثَلَاثِينَ كِتَابًا. The plural كُتُبًا and the marfūʿ and majrūr forms are all impossible here."
     },
     {
      "q": "In اِزْدَادَ الطَّالِبُ عِلْمًا, the word عِلْمًا answers which question?",
      "options": [
       "In what state? (كَيْفَ)",
       "In what respect?",
       "When?",
       "Why?"
      ],
      "answer": 1,
      "why": "The verb \"increased\" is vague on its own; عِلْمًا specifies the respect in which the student increased. Answering \"in what state?\" is the job of the ḥāl, not the tamyīz."
     },
     {
      "q": "Which sentence contains a tamyīz?",
      "options": [
       "جَاءَ الرَّجُلُ رَاكِبًا",
       "هُوَ أَحْسَنُ النَّاسِ خُلُقًا",
       "كَتَبَ الطَّالِبُ الدَّرْسَ",
       "رَجَعَتِ الْمَرْأَةُ مَسْرُورَةً"
      ],
      "answer": 1,
      "why": "خُلُقًا specifies the respect of the excellence — \"the best of people in character\" — a tamyīz after the ism tafḍīl. رَاكِبًا and مَسْرُورَةً are ḥāl, and الدَّرْسَ is a plain object."
     },
     {
      "q": "After an ism tafḍīl such as أَكْثَر, the specifying noun (e.g. مَالًا) is parsed as...",
      "options": [
       "a ḥāl",
       "a mafʿūl bihi",
       "a tamyīz in naṣb",
       "a muḍāf ilayhi in jarr"
      ],
      "answer": 2,
      "why": "The comparative alone does not say along which dimension the comparison runs; the manṣūb noun that supplies it is the tamyīz."
     }
    ]
   },
   {
    "id": "g16",
    "title": "Exception",
    "titleAr": "الِاسْتِثْنَاء",
    "tagline": "Everyone came — except Zayd. Why is he sometimes zaydan, sometimes zaydun, sometimes zaydin?",
    "body": [
     "To except is to pull one item out of a general ruling. In جَاءَ الْقَوْمُ إِلَّا زَيْدًا \"the people came except Zayd\", the people are الْمُسْتَثْنَى مِنْهُ (that from which the exception is made), Zayd is الْمُسْتَثْنَى (the excepted), and إِلَّا is the tool of exception. Everything turns on the shape of the sentence before إِلَّا.",
     "Rule one: when the sentence is affirmative and the mustathnā minhu is mentioned, naṣb is obligatory: جَاءَ الْقَوْمُ إِلَّا زَيْدًا. Rule two: when the sentence is negative and the mustathnā minhu is still mentioned, the preferred reading makes the excepted noun a badal of it, matching its case — مَا جَاءَ الْقَوْمُ إِلَّا زَيْدٌ, with زَيْدٌ in rafʿ like الْقَوْمُ — though naṣb (زَيْدًا) remains permissible.",
     "Rule three is الِاسْتِثْنَاءُ الْمُفَرَّغُ, the \"emptied\" exception: the sentence is negative and the mustathnā minhu is absent. Here إِلَّا loses its grip on case entirely — parse the sentence as if إِلَّا were not there: مَا جَاءَ إِلَّا زَيْدٌ (Zayd is the fāʿil, so rafʿ), مَا رَأَيْتُ إِلَّا زَيْدًا (Zayd is the object, so naṣb).",
     "غَيْر and سِوَى are nouns, and they except by iḍāfa: the excluded noun follows them in jarr as muḍāf ilayhi, always. غَيْر itself then wears whatever case the noun after إِلَّا would have worn: جَاءَ الْقَوْمُ غَيْرَ زَيْدٍ, but مَا جَاءَ غَيْرُ زَيْدٍ."
    ],
    "examples": [
     {
      "ar": "جَاءَ الْقَوْمُ إِلَّا زَيْدًا.",
      "translit": "jāʾa al-qawmu illā zaydan.",
      "en": "The people came, except Zayd.",
      "note": "Affirmative sentence with the mustathnā minhu (الْقَوْمُ) present: the excepted noun must take naṣb — زَيْدًا, no other option."
     },
     {
      "ar": "مَا جَاءَ الْقَوْمُ إِلَّا زَيْدٌ.",
      "translit": "mā jāʾa al-qawmu illā zaydun.",
      "en": "The people did not come — except Zayd.",
      "note": "Negative sentence, mustathnā minhu present: the preferred parsing is badal, so زَيْدٌ copies the rafʿ of الْقَوْمُ. The naṣb زَيْدًا is also classical, but less favored."
     },
     {
      "ar": "مَا نَجَحَ إِلَّا الْمُجْتَهِدُ.",
      "translit": "mā najaḥa illā al-mujtahidu.",
      "en": "None succeeded but the diligent one.",
      "note": "The emptied exception (mufarragh): no mustathnā minhu, so read the sentence as if إِلَّا were absent — الْمُجْتَهِدُ is simply the fāʿil of نَجَحَ, hence rafʿ."
     },
     {
      "ar": "مَا رَأَيْتُ إِلَّا خَالِدًا.",
      "translit": "mā raʾaytu illā khālidan.",
      "en": "I saw no one but Khālid.",
      "note": "Also mufarragh, but here the position after the verb is that of the mafʿūl bihi, so خَالِدًا takes naṣb. In the emptied exception the position, not إِلَّا, assigns the case."
     },
     {
      "ar": "جَاءَ الْقَوْمُ غَيْرَ زَيْدٍ.",
      "translit": "jāʾa al-qawmu ghayra zaydin.",
      "en": "The people came, other than Zayd.",
      "note": "After غَيْر (and likewise سِوَى) the excluded noun is always majrūr as muḍāf ilayhi: زَيْدٍ. Meanwhile غَيْرَ itself takes naṣb — the very case زَيْدًا would take after إِلَّا in this sentence."
     }
    ],
    "quiz": [
     {
      "q": "Complete correctly: حَضَرَ الطُّلَّابُ إِلَّا ...",
      "options": [
       "عَلِيٌّ",
       "عَلِيًّا",
       "عَلِيٍّ",
       "عَلِيُّ"
      ],
      "answer": 1,
      "why": "The sentence is affirmative and the mustathnā minhu (الطُّلَّابُ) is mentioned, so naṣb is obligatory: عَلِيًّا."
     },
     {
      "q": "In مَا قَامَ الرِّجَالُ إِلَّا سَعِيدٌ, why is سَعِيدٌ in rafʿ?",
      "options": [
       "It is the fāʿil of قَامَ",
       "It is a badal of الرِّجَالُ, the preferred option in a negative complete sentence",
       "إِلَّا always imposes rafʿ",
       "It is a mubtadaʾ"
      ],
      "answer": 1,
      "why": "With negation and the mustathnā minhu present, the excepted noun is preferably a badal, copying the case of الرِّجَالُ — hence rafʿ. Naṣb (سَعِيدًا) would also be allowed, but rafʿ is favored."
     },
     {
      "q": "The noun that follows غَيْر or سِوَى is always...",
      "options": [
       "marfūʿ",
       "manṣūb",
       "majrūr, as muḍāf ilayhi",
       "in the same case as غَيْر itself"
      ],
      "answer": 2,
      "why": "غَيْر and سِوَى are nouns that form an iḍāfa with what follows them, and the muḍāf ilayhi is invariably in jarr: غَيْرَ زَيْدٍ, سِوَى خَالِدٍ."
     },
     {
      "q": "Complete correctly: مَا جَاءَ إِلَّا ...",
      "options": [
       "مُحَمَّدٌ",
       "مُحَمَّدًا",
       "مُحَمَّدٍ",
       "مُحَمَّدَ"
      ],
      "answer": 0,
      "why": "This is the emptied exception: no mustathnā minhu, so إِلَّا is ignored for case and the verb جَاءَ still needs its fāʿil — مُحَمَّدٌ in rafʿ."
     },
     {
      "q": "In جَاءَ الْقَوْمُ غَيْرَ زَيْدٍ, why does غَيْرَ carry naṣb?",
      "options": [
       "Every noun after a verb is manṣūb",
       "It takes the case the excepted noun would take after إِلَّا — here obligatory naṣb",
       "It is majrūr but written with fatḥa",
       "It agrees with زَيْدٍ"
      ],
      "answer": 1,
      "why": "غَيْر itself receives the case ruling of the noun after إِلَّا. The sentence is affirmative and complete, where إِلَّا would force naṣb, so we say غَيْرَ — while زَيْدٍ stays in jarr as muḍāf ilayhi."
     }
    ]
   },
   {
    "id": "g17",
    "title": "Conditionals",
    "titleAr": "الشَّرْط",
    "tagline": "If, when, and if only — building real and unreal conditions.",
    "body": [
     "A conditional sentence has two halves: the condition (الشَّرْط) and its result (جَوَابُ الشَّرْطِ). The classic conditional particle is إِنْ 'if': it governs the verb of both halves in the jussive mood (الْمَجْزُوم), marked by sukūn on the final radical. So إِنْ تَدْرُسْ تَنْجَحْ means 'if you study, you succeed' — both verbs carry sukūn because of إِنْ.",
     "إِذَا 'when, whenever' is used for expected, real conditions and is followed by a past-tense verb whose meaning is future: إِذَا جَاءَ الشِّتَاءُ لَبِسَ النَّاسُ الصُّوفَ 'when winter comes, people wear wool'. The past form here does not point to past time; Arabic uses it because the outcome is treated as certain.",
     "لَوْ marks the unreal, counterfactual condition — what did not happen. Both verbs are past in form, and the result clause normally opens with the emphatic لَ: لَوْ دَرَسْتَ لَنَجَحْتَ 'had you studied, you would have succeeded' — but the studying never took place.",
     "Certain nouns also work as conditionals and, like إِنْ, put both verbs in the jussive: مَنْ 'whoever', as in مَنْ يَزْرَعْ يَحْصُدْ; مَا 'whatever', as in مَا تَقْرَأْ يَنْفَعْكَ 'whatever you read benefits you'; and مَهْمَا 'no matter what'. Recognize the pattern: conditional word, jussive verb, jussive verb."
    ],
    "examples": [
     {
      "ar": "إِنْ تَدْرُسْ تَنْجَحْ",
      "translit": "in tadrus tanjaḥ",
      "en": "If you study, you will succeed.",
      "note": "إِنْ puts both verbs in the jussive; the sukūn on تَدْرُسْ and تَنْجَحْ is the jussive marker."
     },
     {
      "ar": "إِذَا جَاءَ الشِّتَاءُ لَبِسَ النَّاسُ الصُّوفَ",
      "translit": "idhā jāʾa ash-shitāʾu labisa an-nāsu aṣ-ṣūfa",
      "en": "When winter comes, people wear wool.",
      "note": "After إِذَا both verbs are past in form but future in meaning; إِذَا is used for real, expected conditions."
     },
     {
      "ar": "لَوْ دَرَسْتَ لَنَجَحْتَ",
      "translit": "law darasta la-najaḥta",
      "en": "Had you studied, you would have succeeded.",
      "note": "لَوْ + past verb marks an unreal condition; the لَ on لَنَجَحْتَ introduces the apodosis (the result clause)."
     },
     {
      "ar": "مَنْ يَزْرَعْ يَحْصُدْ",
      "translit": "man yazraʿ yaḥṣud",
      "en": "Whoever sows, reaps.",
      "note": "مَنْ 'whoever' is a conditional noun and works like إِنْ: both verbs are jussive."
     },
     {
      "ar": "مَهْمَا تَفْعَلْ مِنْ خَيْرٍ يَعْلَمْهُ اللَّهُ",
      "translit": "mahmā tafʿal min khayrin yaʿlamhu allāhu",
      "en": "Whatever good you do, God knows it.",
      "note": "مَهْمَا 'no matter what' is a conditional noun; يَعْلَمْ stays jussive even with the pronoun ـهُ attached."
     }
    ],
    "quiz": [
     {
      "q": "In إِنْ تَدْرُسْ تَنْجَحْ, why do both verbs end in sukūn?",
      "options": [
       "They are imperative forms",
       "Pausal pronunciation drops the final vowels",
       "إِنْ governs both the condition and the result in the jussive (الْمَجْزُوم)",
       "The verbs are subjunctive after أَنْ"
      ],
      "answer": 2,
      "why": "إِنْ is a jazm particle: it makes both the condition verb and the result verb jussive, and the jussive of a sound verb is marked by sukūn."
     },
     {
      "q": "Complete the sentence: إِنْ تَجْتَهِدْ ____",
      "options": [
       "تَنْجَحُ",
       "تَنْجَحْ",
       "تَنْجَحَ",
       "نَجَحْتَ"
      ],
      "answer": 1,
      "why": "The result clause of إِنْ is also jussive, so the verb must end in sukūn: تَنْجَحْ."
     },
     {
      "q": "Which sentence is counterfactual — the studying did NOT actually happen?",
      "options": [
       "لَوْ دَرَسْتَ لَنَجَحْتَ",
       "إِنْ تَدْرُسْ تَنْجَحْ",
       "إِذَا دَرَسْتَ نَجَحْتَ",
       "مَنْ يَدْرُسْ يَنْجَحْ"
      ],
      "answer": 0,
      "why": "لَوْ with a past verb and a لَ-apodosis expresses an unreal past condition: 'had you studied (but you did not), you would have succeeded'."
     },
     {
      "q": "In لَوْ جَاءَ لَأَكْرَمْتُهُ, what is the لَ of لَأَكْرَمْتُهُ?",
      "options": [
       "The preposition لِ meaning 'for'",
       "A lām of command",
       "The lām that introduces the answer (جَوَاب) of لَوْ",
       "Part of the verb's root"
      ],
      "answer": 2,
      "why": "The result clause of لَوْ is regularly introduced by this emphatic لَ: 'had he come, I would certainly have honored him'."
     },
     {
      "q": "What does مَهْمَا do in مَهْمَا تَفْعَلْ مِنْ خَيْرٍ يَعْلَمْهُ اللَّهُ?",
      "options": [
       "It negates the verb",
       "It asks a question meaning 'why?'",
       "It is a relative pronoun requiring a definite antecedent",
       "It is a conditional noun 'whatever / no matter what', putting both verbs in the jussive"
      ],
      "answer": 3,
      "why": "مَهْمَا belongs to the conditional nouns (with مَنْ and مَا): like إِنْ, it governs both the condition and the result in the jussive."
     }
    ]
   },
   {
    "id": "g18",
    "title": "The Numbers",
    "titleAr": "الْعَدَد",
    "tagline": "Gender polarity, tamyīz, and the elegant logic of Arabic counting.",
    "body": [
     "Arabic counts in four distinct zones, each with its own grammar. The numbers وَاحِد 'one' and اِثْنَانِ 'two' simply follow their noun as adjectives, agreeing in gender and case: كِتَابٌ وَاحِدٌ 'one book', بِنْتَانِ اثْنَتَانِ 'two girls'. Since the noun itself already shows oneness or duality, these two appear mainly for emphasis.",
     "From three to ten the famous gender polarity rules: the number takes the OPPOSITE gender of the counted noun's singular, and the noun follows as a plural in the genitive. So ثَلَاثَةُ كُتُبٍ 'three books' — the ة-form because كِتَاب is masculine — but ثَلَاثُ بَنَاتٍ 'three girls', without ة because بِنْت is feminine.",
     "From eleven to ninety-nine the counted noun switches to the singular accusative — a tamyīz, the very construction you met in the specification lesson: أَحَدَ عَشَرَ كَوْكَبًا 'eleven planets', عِشْرُونَ رَجُلًا 'twenty men'. In thirteen to nineteen the polarity still applies to the units digit, while the tens عِشْرُونَ، ثَلَاثُونَ and their sisters have a single form for both genders.",
     "Finally, مِئَة 'hundred' and أَلْف 'thousand' behave like the first term of an iḍāfa: the counted noun follows in the singular genitive — مِئَةُ رَجُلٍ 'a hundred men', أَلْفُ لَيْلَةٍ وَلَيْلَةٌ 'a thousand and one nights'."
    ],
    "examples": [
     {
      "ar": "جَاءَ رَجُلٌ وَاحِدٌ",
      "translit": "jāʾa rajulun wāḥidun",
      "en": "One man came.",
      "note": "One and two follow the noun like adjectives, agreeing in gender and case; they mostly add emphasis."
     },
     {
      "ar": "قَرَأْتُ ثَلَاثَةَ كُتُبٍ",
      "translit": "qaraʾtu thalāthata kutubin",
      "en": "I read three books.",
      "note": "3-10: gender polarity — masculine كِتَاب takes the ة-form ثَلَاثَة; the counted noun is plural genitive. The number itself declines: here it is accusative as the object."
     },
     {
      "ar": "فِي الْبَيْتِ ثَلَاثُ بَنَاتٍ",
      "translit": "fī al-bayti thalāthu banātin",
      "en": "In the house are three girls.",
      "note": "Feminine بِنْت takes the ة-less form ثَلَاثُ; بَنَاتٍ is plural genitive."
     },
     {
      "ar": "رَأَيْتُ أَحَدَ عَشَرَ كَوْكَبًا",
      "translit": "raʾaytu aḥada ʿashara kawkaban",
      "en": "I saw eleven planets.",
      "note": "11-99 take a singular accusative tamyīz; the compound أَحَدَ عَشَرَ is fixed on fatḥa in both halves."
     },
     {
      "ar": "فِي الْمَدِينَةِ مِئَةُ مَسْجِدٍ",
      "translit": "fī al-madīnati miʾatu masjidin",
      "en": "In the city are a hundred mosques.",
      "note": "مِئَة and أَلْف take a singular genitive after them, exactly like an iḍāfa."
     }
    ],
    "quiz": [
     {
      "q": "Which is correct for 'three pens' (قَلَم is masculine)?",
      "options": [
       "ثَلَاثُ أَقْلَامٍ",
       "ثَلَاثَةُ أَقْلَامٍ",
       "ثَلَاثَةُ أَقْلَامًا",
       "ثَلَاثُ قَلَمٍ"
      ],
      "answer": 1,
      "why": "3-10 take the opposite gender of the singular noun — masculine قَلَم needs the ة-form ثَلَاثَة — and the counted noun is a plural in the genitive."
     },
     {
      "q": "After عِشْرُونَ 'twenty', the counted noun appears as:",
      "options": [
       "a plural in the genitive",
       "a singular in the genitive",
       "a singular in the accusative",
       "a plural in the accusative"
      ],
      "answer": 2,
      "why": "All numbers from 11 to 99 take a singular accusative tamyīz: عِشْرُونَ رَجُلًا 'twenty men'."
     },
     {
      "q": "'Five girls' is:",
      "options": [
       "خَمْسَةُ بَنَاتٍ",
       "خَمْسُ بَنَاتٍ",
       "خَمْسُ بِنْتٍ",
       "خَمْسَةُ بِنْتًا"
      ],
      "answer": 1,
      "why": "بِنْت is feminine, so polarity demands the ة-less form خَمْسُ, followed by the plural genitive بَنَاتٍ."
     },
     {
      "q": "Complete: مِئَةُ ____ ('a hundred men').",
      "options": [
       "رَجُلٍ",
       "رِجَالٍ",
       "رَجُلًا",
       "رِجَالًا"
      ],
      "answer": 0,
      "why": "مِئَة and أَلْف are followed by a SINGULAR genitive: مِئَةُ رَجُلٍ, أَلْفُ لَيْلَةٍ."
     },
     {
      "q": "In كِتَابٌ وَاحِدٌ, how does وَاحِدٌ behave?",
      "options": [
       "It precedes the noun as the first term of an iḍāfa",
       "It takes a plural noun in the genitive",
       "It makes the noun accusative as tamyīz",
       "It follows the noun as an adjective, agreeing in gender and case"
      ],
      "answer": 3,
      "why": "One and two are the only numbers that behave as ordinary adjectives: they follow the noun and agree with it fully."
     }
    ]
   },
   {
    "id": "g19",
    "title": "Diptotes & the Five Nouns",
    "titleAr": "الْمَمْنُوعُ مِنَ الصَّرْفِ وَالْأَسْمَاءُ الْخَمْسَةُ",
    "tagline": "Nouns that refuse tanwīn — and five that decline with long vowels.",
    "body": [
     "Most nouns take all three case vowels plus tanwīn. But one class — الْمَمْنُوعُ مِنَ الصَّرْفِ, 'barred from full declension', the diptotes — refuses tanwīn entirely and uses fatḥa where kasra is expected: raf' with ḍamma, but BOTH naṣb and jarr with fatḥa. Hence مَرَرْتُ بِعُمَرَ 'I passed by ʿUmar', never بِعُمَرٍ.",
     "The main members of the class: many proper names (عُمَرُ، أَحْمَدُ، فَاطِمَةُ، مَكَّةُ), broken plurals on the patterns مَفَاعِل and مَفَاعِيل (مَسَاجِدُ، مَصَابِيحُ), and adjectives of color and defect on the pattern أَفْعَلُ (أَحْمَرُ، أَسْوَدُ) — a pattern shared by the comparative أَكْبَرُ.",
     "The restriction vanishes the moment the noun is made definite by ال or stands as the first term of an iḍāfa: فِي الْمَسَاجِدِ، فِي مَسَاجِدِ الْمَدِينَةِ — the ordinary kasra returns.",
     "Five little nouns — أَب 'father', أَخ 'brother', حَم 'father-in-law', فُو 'mouth', ذُو 'possessor of' — show their cases as LONG vowels when they head an iḍāfa: أَبُوهُ in raf', أَبَاهُ in naṣb, أَبِيهِ in jarr. Note that ذُو exists only in iḍāfa: هُوَ ذُو عِلْمٍ 'he is a man of knowledge'."
    ],
    "examples": [
     {
      "ar": "مَرَرْتُ بِعُمَرَ وَأَحْمَدَ",
      "translit": "marartu bi-ʿumara wa-aḥmada",
      "en": "I passed by Umar and Ahmad.",
      "note": "Diptote proper names take fatḥa in jarr and never carry tanwīn."
     },
     {
      "ar": "صَلَّيْتُ فِي مَسَاجِدَ كَثِيرَةٍ",
      "translit": "ṣallaytu fī masājida kathīratin",
      "en": "I prayed in many mosques.",
      "note": "Broken plurals of the pattern مَفَاعِل are diptotes: masājida, not masājidin — while the ordinary adjective كَثِيرَةٍ still shows kasra with tanwīn."
     },
     {
      "ar": "صَلَّيْتُ فِي مَسَاجِدِ الْمَدِينَةِ",
      "translit": "ṣallaytu fī masājidi al-madīnati",
      "en": "I prayed in the mosques of the city.",
      "note": "As first term of an iḍāfa the diptote regains its kasra — likewise with the article: فِي الْمَسَاجِدِ."
     },
     {
      "ar": "لَبِسْتُ ثَوْبًا أَحْمَرَ",
      "translit": "labistu thawban aḥmara",
      "en": "I wore a red garment.",
      "note": "Colors on the pattern أَفْعَل refuse tanwīn: ثَوْبًا carries tanwīn, أَحْمَرَ does not."
     },
     {
      "ar": "جَاءَ أَبُوهُ وَرَأَيْتُ أَبَاهُ وَذَهَبْتُ إِلَى أَبِيهِ",
      "translit": "jāʾa abūhu wa-raʾaytu abāhu wa-dhahabtu ilā abīhi",
      "en": "His father came, I saw his father, and I went to his father.",
      "note": "The five nouns show raf' with و, naṣb with ا, and jarr with ي when they head an iḍāfa."
     }
    ],
    "quiz": [
     {
      "q": "Which is the correct way to say 'I passed by ʿUmar'?",
      "options": [
       "مَرَرْتُ بِعُمَرٍ",
       "مَرَرْتُ بِعُمَرِ",
       "مَرَرْتُ بِعُمَرَ",
       "مَرَرْتُ بِعُمَرُ"
      ],
      "answer": 2,
      "why": "عُمَر is a diptote: in jarr it takes fatḥa instead of kasra and never takes tanwīn."
     },
     {
      "q": "Which of these nouns is مَمْنُوع مِنَ الصَّرْف (a diptote)?",
      "options": [
       "كُتُب",
       "مَسَاجِد",
       "بُيُوت",
       "رِجَال"
      ],
      "answer": 1,
      "why": "مَسَاجِد is a broken plural on the pattern مَفَاعِل, one of the classic diptote patterns; the others decline fully with tanwīn."
     },
     {
      "q": "Why does الْمَسَاجِدِ show a normal kasra in فِي الْمَسَاجِدِ?",
      "options": [
       "The article ال restores full declension to a diptote",
       "The noun is actually accusative here",
       "Feminine nouns always take kasra",
       "فِي requires fatḥa on diptotes only"
      ],
      "answer": 0,
      "why": "A diptote made definite by ال (or placed in iḍāfa) declines normally again, so jarr shows kasra."
     },
     {
      "q": "'I saw his father' is:",
      "options": [
       "رَأَيْتُ أَبُوهُ",
       "رَأَيْتُ أَبَاهُ",
       "رَأَيْتُ أَبِيهِ",
       "رَأَيْتُ أَبَهُ"
      ],
      "answer": 1,
      "why": "As one of the five nouns in iḍāfa, أَب marks naṣb with a long alif: أَبَاهُ."
     },
     {
      "q": "Complete: جَاءَ رَجُلٌ ____ مَالٍ ('a man of wealth came').",
      "options": [
       "ذَا",
       "ذِي",
       "ذُو",
       "ذَوُو"
      ],
      "answer": 2,
      "why": "ذُو must stand in iḍāfa and here describes the nominative رَجُلٌ, so it takes the raf' form with wāw: ذُو مَالٍ."
     }
    ]
   },
   {
    "id": "g20",
    "title": "Calling & Insisting",
    "titleAr": "النِّدَاءُ وَالتَّوْكِيدُ",
    "tagline": "Yā with ḍamma or naṣb — and every classical way to say 'really, truly, himself'.",
    "body": [
     "To call someone, Classical Arabic uses يَا. A single, definite addressee is built on a plain ḍamma with NO tanwīn: يَا رَجُلُ 'O man!', يَا مُحَمَّدُ 'O Muhammad!'. This ḍamma is fixed — the grammarians say the noun is مَبْنِيّ عَلَى الضَّمِّ — so it is not the ordinary subject ending, even though it looks like one.",
     "When the called noun is the first term of an iḍāfa, however, it takes naṣb: يَا عَبْدَ اللَّهِ 'O ʿAbdallāh!', يَا طَالِبَ الْعِلْمِ 'O seeker of knowledge!'. The rule is easy to hear: a bare name gets -u, a construct gets -a.",
     "Arabic also loves to insist. التَّوْكِيد 'emphasis' uses نَفْس 'self' and عَيْن (literally 'eye') for individuals — جَاءَ الْأَمِيرُ نَفْسُهُ 'the prince himself came' — and كُلّ for totality: جَاءَ الطُّلَّابُ كُلُّهُمْ 'the students came, all of them'. Each emphasizer copies the case of the noun it strengthens and carries a matching pronoun. Simple repetition emphasizes too: لَا، لَا أَبُوحُ بِالسِّرِّ 'no, no — I will not reveal the secret'.",
     "Finally, the إِنَّ you already know can be reinforced with an emphatic لَ on its predicate — the grammarians call it اللَّام الْمُزَحْلَقَة, the lām that 'slid over' from the noun to the predicate: إِنَّ الْعِلْمَ لَنَافِعٌ 'truly, knowledge is indeed beneficial'."
    ],
    "examples": [
     {
      "ar": "يَا رَجُلُ، اتَّقِ اللَّهَ",
      "translit": "yā rajulu, ittaqi allāha",
      "en": "O man, fear God!",
      "note": "A single definite addressee after يَا is built on ḍamma without tanwīn: مَبْنِيّ عَلَى الضَّمِّ."
     },
     {
      "ar": "يَا عَبْدَ اللَّهِ، تَعَالَ",
      "translit": "yā ʿabda allāhi, taʿāla",
      "en": "O ʿAbdallāh, come!",
      "note": "A called noun in iḍāfa takes naṣb: عَبْدَ is manṣūb as muḍāf to اللَّهِ."
     },
     {
      "ar": "جَاءَ الْأَمِيرُ نَفْسُهُ",
      "translit": "jāʾa al-amīru nafsuhu",
      "en": "The prince himself came.",
      "note": "نَفْس plus a matching pronoun emphasizes the individual; it copies the nominative case of الْأَمِيرُ."
     },
     {
      "ar": "جَاءَ الطُّلَّابُ كُلُّهُمْ",
      "translit": "jāʾa aṭ-ṭullābu kulluhum",
      "en": "The students came, all of them.",
      "note": "كُلّ plus a pronoun emphasizes totality and likewise matches the case of the emphasized noun."
     },
     {
      "ar": "إِنَّ الْعِلْمَ لَنَافِعٌ",
      "translit": "inna al-ʿilma la-nāfiʿun",
      "en": "Truly, knowledge is indeed beneficial.",
      "note": "The emphatic لَ (اللَّام الْمُزَحْلَقَة) attaches to the predicate of إِنَّ, doubling the emphasis."
     }
    ],
    "quiz": [
     {
      "q": "Why does يَا رَجُلُ end in a single ḍamma with no tanwīn?",
      "options": [
       "A single definite addressee after يَا is built on ḍamma (مَبْنِيّ عَلَى الضَّمِّ)",
       "It is the subject of an understood verb, so it takes normal raf'",
       "The vocative always takes tanwīn ḍamma",
       "يَا is a preposition that requires ḍamma"
      ],
      "answer": 0,
      "why": "The vocative of a single, definite addressee is invariable on ḍamma — a fixed form, not the ordinary nominative with tanwīn."
     },
     {
      "q": "Complete: يَا ____ اللَّهِ ('O ʿAbdallāh!').",
      "options": [
       "عَبْدُ",
       "عَبْدَ",
       "عَبْدِ",
       "عَبْدًا"
      ],
      "answer": 1,
      "why": "A called noun that is muḍāf takes naṣb: يَا عَبْدَ اللَّهِ. As a muḍāf it can never carry tanwīn, so عَبْدًا is doubly wrong."
     },
     {
      "q": "In جَاءَ الْأَمِيرُ نَفْسُهُ, what is نَفْسُهُ?",
      "options": [
       "The direct object of جَاءَ",
       "A ḥāl describing how he came",
       "An adjective meaning 'precious'",
       "تَوْكِيد (emphasis): it copies the case of الْأَمِيرُ and carries a matching pronoun"
      ],
      "answer": 3,
      "why": "نَفْس after a noun, with a pronoun referring back to it and the same case, is the classic emphasis 'himself'."
     },
     {
      "q": "Which word emphasizes a whole group, as in 'the students, ALL of them, came'?",
      "options": [
       "نَفْس",
       "عَيْن",
       "كُلّ",
       "بَعْض"
      ],
      "answer": 2,
      "why": "كُلّ with an attached pronoun (كُلُّهُمْ) emphasizes totality; نَفْس and عَيْن emphasize the identity of an individual, and بَعْض means only 'some'."
     },
     {
      "q": "In إِنَّ الْمُؤْمِنَ لَصَادِقٌ, what is the لَ of لَصَادِقٌ?",
      "options": [
       "The preposition لِ meaning 'for'",
       "The emphatic lām (اللَّام الْمُزَحْلَقَة) strengthening the predicate of إِنَّ",
       "A lām of command",
       "Part of the root of صَادِق"
      ],
      "answer": 1,
      "why": "إِنَّ ... لَ is a double emphasis: the lām 'slides' onto the predicate — 'the believer is indeed truthful'."
     }
    ]
   },
   {
    "id": "g21",
    "title": "Almost & Beginning",
    "titleAr": "كَادَ وَأَخَوَاتُهَا",
    "tagline": "Kāna's restless cousins: on the verge, in hope, and already under way.",
    "body": [
     "كَادَ and its sisters govern exactly like كَانَ: they enter upon a subject and predicate, keep the subject in rafʿ as their ism, and demand a khabar in the position of naṣb. The difference is that this khabar must be a verbal clause whose verb is a muḍāriʿ. In كَادَ الْوَلَدُ يَسْقُطُ, the noun الْوَلَدُ is the ism of كَادَ in rafʿ, and the clause يَسْقُطُ is its khabar: the boy was on the very point of falling.",
     "The sisters form three families. The verbs of nearness (أَفْعَالُ الْمُقَارَبَةِ), كَادَ and أَوْشَكَ, say the action almost happened. The verbs of hope (أَفْعَالُ الرَّجَاءِ), above all عَسَى, say it may yet happen: عَسَى اللَّهُ أَنْ يَغْفِرَ لَنَا. The verbs of beginning (أَفْعَالُ الشُّرُوعِ) — جَعَلَ, أَخَذَ, طَفِقَ — report that someone set about an action, and they are used only in the past tense.",
     "The particle أَنْ before the khabar-verb obeys a strict etiquette. With عَسَى it is the norm; with أَوْشَكَ it is frequent; with كَادَ the best usage omits it — كَادَ يَسْقُطُ, not كَادَ أَنْ يَسْقُطَ; and with the verbs of beginning it is impossible, because أَنْ points toward the future while these verbs assert an action already begun.",
     "Finally, negation turns كَادَ into 'scarcely': مَا كَادَ يَتَكَلَّمُ means he could hardly speak — the action just barely happened, and only with difficulty."
    ],
    "examples": [
     {
      "ar": "كَادَ الْوَلَدُ يَسْقُطُ مِنَ الشَّجَرَةِ",
      "translit": "kāda l-waladu yasquṭu mina sh-shajarati",
      "en": "The boy almost fell from the tree.",
      "note": "كَادَ raises الْوَلَدُ as its ism in rafʿ; the muḍāriʿ clause يَسْقُطُ is the khabar in the position of naṣb — the best usage omits أَنْ after كَادَ."
     },
     {
      "ar": "عَسَى اللَّهُ أَنْ يَغْفِرَ لَنَا",
      "translit": "ʿasā llāhu an yaghfira lanā",
      "en": "It may be that God will forgive us.",
      "note": "عَسَى, the verb of hope, regularly takes أَنْ + subjunctive as its khabar; يَغْفِرَ shows the fatḥa of naṣb."
     },
     {
      "ar": "أَخَذَ الشَّاعِرُ يُنْشِدُ قَصِيدَتَهُ",
      "translit": "akhadha sh-shāʿiru yunshidu qaṣīdatahu",
      "en": "The poet began to recite his poem.",
      "note": "Here أَخَذَ is not 'he took' but a verb of beginning; its khabar-verb يُنْشِدُ never takes أَنْ."
     },
     {
      "ar": "جَعَلَ الطِّفْلُ يَبْكِي",
      "translit": "jaʿala ṭ-ṭiflu yabkī",
      "en": "The child started to cry.",
      "note": "جَعَلَ as a verb of beginning; the verbs of beginning occur only in the past tense, though their khabar-verb is a muḍāriʿ."
     },
     {
      "ar": "مَا كَادَ الضَّيْفُ يَجْلِسُ حَتَّى قَامَ",
      "translit": "mā kāda ḍ-ḍayfu yajlisu ḥattā qāma",
      "en": "The guest had scarcely sat down when he rose.",
      "note": "Negated كَادَ means 'scarcely'; with a following حَتَّى clause it yields 'no sooner ... than.'"
     }
    ],
    "quiz": [
     {
      "q": "In كَادَ الْوَلَدُ يَسْقُطُ, what is the function of the clause يَسْقُطُ?",
      "options": [
       "Fāʿil of كَادَ",
       "Ḥāl describing الْوَلَدُ",
       "Khabar of كَادَ, a verbal clause in the position of naṣb",
       "Mafʿūl bihi of كَادَ"
      ],
      "answer": 2,
      "why": "كَادَ works exactly like كَانَ: الْوَلَدُ is its ism in rafʿ, and the muḍāriʿ clause serves as its khabar, occupying the position of naṣb."
     },
     {
      "q": "Which of these verbs most regularly takes أَنْ before its khabar-verb?",
      "options": [
       "كَادَ",
       "عَسَى",
       "أَخَذَ",
       "طَفِقَ"
      ],
      "answer": 1,
      "why": "عَسَى, the verb of hope, normally takes أَنْ + subjunctive (عَسَى أَنْ يَقُومَ); كَادَ rarely does, and the verbs of beginning never do."
     },
     {
      "q": "Which sentence is correct classical usage?",
      "options": [
       "جَعَلَ الرَّجُلُ أَنْ يَكْتُبَ",
       "طَفِقَ الرَّجُلُ أَنْ يَكْتُبَ",
       "أَخَذَ الرَّجُلُ أَنْ يَكْتُبَ",
       "أَخَذَ الرَّجُلُ يَكْتُبُ"
      ],
      "answer": 3,
      "why": "The verbs of beginning reject أَنْ entirely: their khabar is a bare muḍāriʿ, so only أَخَذَ الرَّجُلُ يَكْتُبُ is sound."
     },
     {
      "q": "What does مَا كَادَ الضَّيْفُ يَتَكَلَّمُ convey?",
      "options": [
       "The guest scarcely spoke",
       "The guest refused to speak",
       "The guest almost spoke twice",
       "The guest wished to speak"
      ],
      "answer": 0,
      "why": "Negated كَادَ means 'scarcely, hardly': the action barely happened, and only with difficulty."
     },
     {
      "q": "In عَسَى اللَّهُ أَنْ يَغْفِرَ لَنَا, why does يَغْفِرَ end in fatḥa?",
      "options": [
       "It is jussive after a hidden لَمْ",
       "It agrees with اللَّهُ",
       "It is manṣūb by أَنْ",
       "It is built on fatḥ"
      ],
      "answer": 2,
      "why": "أَنْ is a particle of naṣb: the muḍāriʿ after it takes the subjunctive fatḥa, hence يَغْفِرَ."
     }
    ]
   },
   {
    "id": "g22",
    "title": "The Mafʿūl Family",
    "titleAr": "الْمَفَاعِيلُ",
    "tagline": "The accusatives beyond the direct object: emphasis, motive, time, place, and company.",
    "body": [
     "You already know the direct object, الْمَفْعُولُ بِهِ. Classical grammar sets beside it a whole family of accusatives, الْمَفَاعِيلُ, each answering a different question about the verb — and every one of them stands in naṣb.",
     "The absolute object, الْمَفْعُولُ الْمُطْلَقُ, is a maṣdar of the verb's own root. Bare, it emphasizes: ضَرَبَهُ ضَرْبًا, he struck him indeed. Qualified or annexed, it states the kind: ضَرَبَهُ ضَرْبًا شَدِيدًا. In the dual or counted, it states the number: ضَرَبَهُ ضَرْبَتَيْنِ. The object of reason, الْمَفْعُولُ لِأَجْلِهِ, is a maṣdar giving the motive and answering لِمَاذَا: in قُمْتُ إِكْرَامًا لَهُ the standing happened for the sake of honoring him.",
     "The object of setting, الْمَفْعُولُ فِيهِ, is the ẓarf of time or place in naṣb: صُمْتُ يَوْمَ الْخَمِيسِ for time, جَلَسْتُ أَمَامَ الْبَابِ for place. Notice that a ẓarf of place such as أَمَامَ or خَلْفَ is usually the first term of an iḍāfa, so the noun after it is majrūr.",
     "The object of accompaniment, الْمَفْعُولُ مَعَهُ, follows وَاوُ الْمَعِيَّةِ, the wāw meaning 'together with': سِرْتُ وَالنَّهْرَ, I walked along the river. The river did not walk, so this wāw cannot be coordinating; the noun therefore takes naṣb instead of sharing the case of what precedes it."
    ],
    "examples": [
     {
      "ar": "ضَرَبَهُ ضَرْبًا شَدِيدًا",
      "translit": "ḍarabahu ḍarban shadīdan",
      "en": "He struck him a severe blow.",
      "note": "ضَرْبًا is a mafʿūl muṭlaq stating the kind of the action; its adjective شَدِيدًا follows it in naṣb."
     },
     {
      "ar": "قُمْتُ إِكْرَامًا لِلضَّيْفِ",
      "translit": "qumtu ikrāman li-ḍ-ḍayfi",
      "en": "I stood up in honor of the guest.",
      "note": "إِكْرَامًا is a mafʿūl li-ajlihi: a maṣdar in naṣb giving the motive, answering the question لِمَاذَا قُمْتَ."
     },
     {
      "ar": "صُمْتُ يَوْمَ الْخَمِيسِ",
      "translit": "ṣumtu yawma l-khamīsi",
      "en": "I fasted on Thursday.",
      "note": "يَوْمَ is a mafʿūl fīhi, a ẓarf of time in naṣb; الْخَمِيسِ is majrūr as the second term of the iḍāfa."
     },
     {
      "ar": "جَلَسَ التِّلْمِيذُ أَمَامَ الْمُعَلِّمِ",
      "translit": "jalasa t-tilmīdhu amāma l-muʿallimi",
      "en": "The pupil sat in front of the teacher.",
      "note": "أَمَامَ is a mafʿūl fīhi, a ẓarf of place in naṣb, standing as the first term of an iḍāfa with الْمُعَلِّمِ."
     },
     {
      "ar": "سِرْتُ وَالنَّهْرَ",
      "translit": "sirtu wa-n-nahra",
      "en": "I walked along the river.",
      "note": "النَّهْرَ is a mafʿūl maʿahu after وَاوُ الْمَعِيَّةِ: walking cannot be attributed to the river, so the wāw is not coordinating."
     }
    ],
    "quiz": [
     {
      "q": "In ضَرَبَهُ ضَرْبًا شَدِيدًا, what is ضَرْبًا?",
      "options": [
       "Mafʿūl bihi",
       "Ḥāl",
       "Mafʿūl muṭlaq stating the kind of the action",
       "Mafʿūl li-ajlihi"
      ],
      "answer": 2,
      "why": "It is a maṣdar of the same root as the verb, in naṣb; qualified by شَدِيدًا, it states the kind of striking."
     },
     {
      "q": "Which sentence contains a mafʿūl li-ajlihi?",
      "options": [
       "قُمْتُ إِكْرَامًا لِلضَّيْفِ",
       "قُمْتُ قِيَامًا سَرِيعًا",
       "قُمْتُ يَوْمَ الْجُمُعَةِ",
       "قُمْتُ أَمَامَ الْأَمِيرِ"
      ],
      "answer": 0,
      "why": "إِكْرَامًا gives the motive for standing, answering لِمَاذَا; the others show a mafʿūl muṭlaq, a ẓarf of time, and a ẓarf of place."
     },
     {
      "q": "Why is النَّهْرَ accusative in سِرْتُ وَالنَّهْرَ?",
      "options": [
       "It is coordinated with the subject by وَ",
       "It is a ẓarf makān",
       "It is the direct object of سِرْتُ",
       "It is a mafʿūl maʿahu after the wāw of accompaniment"
      ],
      "answer": 3,
      "why": "The wāw here means 'along with'; since walking is not attributed to the river, coordination is impossible, and the noun takes naṣb as mafʿūl maʿahu."
     },
     {
      "q": "In صُمْتُ يَوْمَ الْخَمِيسِ, what is يَوْمَ?",
      "options": [
       "Mafʿūl bihi",
       "Mafʿūl fīhi — a ẓarf of time",
       "Mafʿūl muṭlaq",
       "Badal of the subject"
      ],
      "answer": 1,
      "why": "يَوْمَ names the time in which the action occurred, so it is the mafʿūl fīhi (ẓarf zamān) in naṣb."
     },
     {
      "q": "Which example shows the mafʿūl muṭlaq of number?",
      "options": [
       "ضَرَبَهُ ضَرْبًا",
       "ضَرَبَهُ ضَرْبًا شَدِيدًا",
       "ضَرَبَهُ ضَرْبَتَيْنِ",
       "ضَرَبَهُ أَمَامَ النَّاسِ"
      ],
      "answer": 2,
      "why": "The dual ضَرْبَتَيْنِ counts the action — two blows; the bare maṣdar emphasizes, and the qualified maṣdar states the kind."
     }
    ]
   },
   {
    "id": "g23",
    "title": "The Followers",
    "titleAr": "التَّوَابِعُ",
    "tagline": "Naʿt, ʿaṭf, tawkīd, badal — how one word inherits another's case.",
    "body": [
     "The followers, التَّوَابِعُ, are words with no case of their own: each inherits the case of the word it follows, الْمَتْبُوعُ. Classical grammar counts four: the adjective (النَّعْتُ), coordination (الْعَطْفُ), emphasis (التَّوْكِيدُ), and substitution (الْبَدَلُ).",
     "The naʿt follows its noun in four things: in case, in definiteness or indefiniteness, in gender, and in number. Hence الرَّجُلُ الْكَرِيمُ but رَجُلٌ كَرِيمٌ, and رَأَيْتُ الْمَرْأَةَ الْكَرِيمَةَ with naṣb and the feminine. ʿAṭf links a second word by a particle — وَ, فَ, ثُمَّ, أَوْ, أَمْ, بَلْ, لَكِنْ, حَتَّى — and the word after the particle, الْمَعْطُوفُ, takes the case of the word before it.",
     "Tawkīd is of two kinds: literal, by repeating the very word, and semantic, with نَفْس, عَيْن, كُلّ, or جَمِيع carrying a pronoun that matches the emphasized noun: جَاءَ الْأَمِيرُ نَفْسُهُ, the emir himself came.",
     "Badal replaces its matbūʿ as the real target of the sentence. It is total, whole for whole: جَاءَ أَخُوكَ زَيْدٌ, where زَيْدٌ is the brother himself; partial, part for whole: أَكَلْتُ الرَّغِيفَ ثُلُثَهُ; or of inclusion, for an attribute contained in the matbūʿ: أَعْجَبَنِي زَيْدٌ عِلْمُهُ. In the last two kinds a pronoun must bind the badal back to its matbūʿ."
    ],
    "examples": [
     {
      "ar": "جَاءَ الرَّجُلُ الْكَرِيمُ",
      "translit": "jāʾa r-rajulu l-karīmu",
      "en": "The noble man came.",
      "note": "الْكَرِيمُ is a naʿt agreeing with its manʿūt in all four things: rafʿ, definiteness, masculine gender, and singular number."
     },
     {
      "ar": "مَرَرْتُ بِزَيْدٍ وَعَمْرٍو",
      "translit": "marartu bi-zaydin wa-ʿamrin",
      "en": "I passed by Zayd and ʿAmr.",
      "note": "عَمْرٍو is maʿṭūf on زَيْدٍ and inherits its jarr; the silent wāw of عَمْرٍو merely distinguishes it in writing from عُمَر."
     },
     {
      "ar": "جَاءَ الْقَوْمُ كُلُّهُمْ",
      "translit": "jāʾa l-qawmu kulluhum",
      "en": "The people came, all of them.",
      "note": "كُلُّهُمْ is a semantic tawkīd: كُلّ takes the rafʿ of الْقَوْمُ and carries the matching pronoun هُمْ."
     },
     {
      "ar": "جَاءَ أَخُوكَ زَيْدٌ",
      "translit": "jāʾa akhūka zaydun",
      "en": "Your brother Zayd came.",
      "note": "زَيْدٌ is a total badal (بَدَلٌ مُطَابِقٌ) of أَخُوكَ and inherits its rafʿ — أَخُوكَ itself shows rafʿ with the wāw."
     },
     {
      "ar": "أَعْجَبَنِي زَيْدٌ عِلْمُهُ",
      "translit": "aʿjabanī zaydun ʿilmuhu",
      "en": "Zayd impressed me — his learning did.",
      "note": "عِلْمُهُ is a badal of inclusion (بَدَلُ اشْتِمَالٍ): the learning is an attribute contained in Zayd, tied back by the pronoun هُ."
     }
    ],
    "quiz": [
     {
      "q": "In which four features does the naʿt follow its manʿūt?",
      "options": [
       "Case, definiteness, gender, number",
       "Case, root, pattern, gender",
       "Definiteness, gender, person, tense",
       "Case, number, person, mood"
      ],
      "answer": 0,
      "why": "The adjective matches its noun in one of the three cases, in definiteness or indefiniteness, in gender, and in number."
     },
     {
      "q": "In مَرَرْتُ بِزَيْدٍ وَعَمْرٍو, why is عَمْرٍو majrūr?",
      "options": [
       "It is the object of a separate verb",
       "It is maʿṭūf on زَيْدٍ and inherits its jarr",
       "It is a naʿt of زَيْدٍ",
       "It is a badal of the pronoun in مَرَرْتُ"
      ],
      "answer": 1,
      "why": "Coordination by وَ makes the maʿṭūf share the case of the word before the particle; زَيْدٍ is majrūr by بِ, so عَمْرٍو follows it."
     },
     {
      "q": "Which word is a tawkīd in جَاءَ الْقَوْمُ كُلُّهُمْ?",
      "options": [
       "جَاءَ",
       "الْقَوْمُ",
       "كُلُّهُمْ",
       "The sentence has no tawkīd"
      ],
      "answer": 2,
      "why": "كُلّ with a pronoun matching the emphasized noun is the semantic tawkīd; it follows الْقَوْمُ in rafʿ."
     },
     {
      "q": "In جَاءَ أَخُوكَ زَيْدٌ, what is زَيْدٌ?",
      "options": [
       "A total badal of أَخُوكَ, inheriting its rafʿ",
       "A mafʿūl bihi",
       "A literal tawkīd",
       "The mubtadaʾ of a new sentence"
      ],
      "answer": 0,
      "why": "زَيْدٌ and أَخُوكَ are the same person, so زَيْدٌ substitutes whole for whole (بَدَلٌ مُطَابِقٌ) and takes the same rafʿ."
     },
     {
      "q": "What kind of badal is ثُلُثَهُ in أَكَلْتُ الرَّغِيفَ ثُلُثَهُ?",
      "options": [
       "Badal muṭābiq — whole for whole",
       "Badal ishtimāl — of inclusion",
       "Badal baʿḍ min kull — part for whole",
       "It is not a badal but a tawkīd"
      ],
      "answer": 2,
      "why": "The third is a physical part of the loaf, so this is the badal of part for whole; the pronoun هُ ties it back to الرَّغِيفَ."
     }
    ]
   },
   {
    "id": "g24",
    "title": "Absolute Negation & Oaths",
    "titleAr": "لَا النَّافِيَةُ لِلْجِنْسِ وَالْقَسَمُ",
    "tagline": "Build the fatḥa and deny the whole genus — then swear an oath and answer it properly.",
    "body": [
     "لَا النَّافِيَةُ لِلْجِنْسِ denies the entire genus of its noun: لَا رَجُلَ فِي الدَّارِ means not one man of any description is in the house. It governs like إِنَّ — ism in naṣb, khabar in rafʿ — but when its ism is a single indefinite noun standing directly after it, that ism is built on fatḥ with no tanwīn: لَا رَجُلَ, لَا شَكَّ.",
     "Two conditions guard this construction: the ism must be indefinite, and nothing may separate it from لَا. If the noun is definite or separated, لَا loses its governance, the noun returns to rafʿ, and لَا is repeated: لَا فِي الدَّارِ رَجُلٌ وَلَا امْرَأَةٌ. The khabar is freely omitted when understood, as in لَا شَكَّ and لَا بَأْسَ.",
     "The oath, الْقَسَمُ, is sworn with three particles, all of which take jarr. وَ is the most common and attaches only to an explicit noun: وَاللَّهِ. بِ is the most versatile — it may follow a stated verb of swearing and may even take a pronoun: أُقْسِمُ بِاللَّهِ. تَ is reserved for the divine name alone: تَاللَّهِ.",
     "The oath demands an answer, جَوَابُ الْقَسَمِ, and the answer comes reinforced. A nominal answer takes إِنَّ with لَ on its khabar: وَاللَّهِ إِنَّ الصِّدْقَ لَنَجَاةٌ. A past-tense answer takes لَقَدْ: تَاللَّهِ لَقَدْ رَأَيْتُ عَجَبًا. A future answer takes لَ with the nūn of emphasis: وَاللَّهِ لَأَصْدُقَنَّ."
    ],
    "examples": [
     {
      "ar": "لَا رَجُلَ فِي الدَّارِ",
      "translit": "lā rajula fī d-dāri",
      "en": "There is no man at all in the house.",
      "note": "رَجُلَ is the ism of لَا النَّافِيَةِ لِلْجِنْسِ, built on fatḥ with no tanwīn; فِي الدَّارِ is the khabar in the position of rafʿ."
     },
     {
      "ar": "لَا شَكَّ فِي ذَلِكَ",
      "translit": "lā shakka fī dhālika",
      "en": "There is no doubt about that.",
      "note": "The genus of doubt is denied outright; in the fixed phrase لَا شَكَّ the khabar may be omitted entirely when understood."
     },
     {
      "ar": "وَاللَّهِ إِنَّ الصِّدْقَ لَنَجَاةٌ",
      "translit": "wa-llāhi inna ṣ-ṣidqa la-najātun",
      "en": "By God, truthfulness is surely deliverance.",
      "note": "The oath wāw puts اللَّهِ in jarr; the nominal answer is reinforced with إِنَّ and the lām on its khabar, لَنَجَاةٌ."
     },
     {
      "ar": "تَاللَّهِ لَقَدْ رَأَيْتُ عَجَبًا",
      "translit": "ta-llāhi la-qad raʾaytu ʿajaban",
      "en": "By God, I have indeed seen a wonder.",
      "note": "تَ is used only with the divine name; the past-tense answer of the oath is introduced by لَقَدْ."
     },
     {
      "ar": "وَاللَّهِ لَأَصْدُقَنَّ فِي كَلَامِي",
      "translit": "wa-llāhi la-aṣduqanna fī kalāmī",
      "en": "By God, I shall surely speak truthfully.",
      "note": "The future answer of the oath takes the lām plus the nūn of emphasis (نُونُ التَّوْكِيدِ): لَأَصْدُقَنَّ."
     }
    ],
    "quiz": [
     {
      "q": "Why does رَجُلَ end in a single fatḥa with no tanwīn in لَا رَجُلَ فِي الدَّارِ?",
      "options": [
       "It is manṣūb as a mafʿūl bihi",
       "It is the ism of لَا النَّافِيَةِ لِلْجِنْسِ, built on fatḥ",
       "It is a ẓarf of place",
       "It lost its tanwīn because it is definite"
      ],
      "answer": 1,
      "why": "A single indefinite noun directly after the genus-negating لَا is built on fatḥ without tanwīn — the mark of absolute negation."
     },
     {
      "q": "Which oath particle may be used only with the name اللَّه?",
      "options": [
       "وَ",
       "بِ",
       "لَ",
       "تَ"
      ],
      "answer": 3,
      "why": "تَ is restricted to the divine name (تَاللَّهِ); وَ attaches to any explicit sworn-by noun, بِ is the most versatile, and لَ is not an oath particle at all — it introduces the answer."
     },
     {
      "q": "What case does the noun take after the oath particles وَ, بِ, and تَ?",
      "options": [
       "Naṣb",
       "Rafʿ",
       "Jarr",
       "It is built on sukūn"
      ],
      "answer": 2,
      "why": "All three oath particles are particles of jarr, so the sworn-by noun is majrūr: وَاللَّهِ, بِاللَّهِ, تَاللَّهِ."
     },
     {
      "q": "Which is the correct reinforced nominal answer of an oath?",
      "options": [
       "وَاللَّهِ الْعِلْمُ نَافِعٌ",
       "وَاللَّهِ إِنَّ الْعِلْمَ لَنَافِعٌ",
       "وَاللَّهِ أَنَّ الْعِلْمَ نَافِعٌ",
       "وَاللَّهِ الْعِلْمَ نَافِعًا"
      ],
      "answer": 1,
      "why": "The nominal answer of the oath is strengthened with إِنَّ and the lām on its khabar: إِنَّ الْعِلْمَ لَنَافِعٌ; the bare sentence lacks the required reinforcement."
     },
     {
      "q": "In لَا فِي الدَّارِ رَجُلٌ وَلَا امْرَأَةٌ, why is رَجُلٌ in rafʿ?",
      "options": [
       "Because رَجُلٌ has become definite",
       "Because the ism is separated from لَا, so لَا is cancelled and must be repeated",
       "Because فِي الدَّارِ is the ism of لَا",
       "Because oaths require rafʿ after them"
      ],
      "answer": 1,
      "why": "When something separates لَا from its noun, لَا loses its governance: the noun reverts to rafʿ and لَا is repeated before each member."
     }
    ]
   },
   {
    "id": "g25",
    "title": "Simile & Metaphor",
    "titleAr": "التَّشْبِيهُ وَالِاسْتِعَارَةُ",
    "tagline": "Say he is a lion — the art of likeness, and of likeness compressed.",
    "body": [
     "At-tashbīh (التَّشْبِيهُ) is the explicit likening of one thing to another, and the rhetoricians analyse it into four pillars (أَرْكَان): al-mushabbah (الْمُشَبَّهُ), the thing likened; al-mushabbah bihi (الْمُشَبَّهُ بِهِ), the image it is likened to; adāt at-tashbīh (أَدَاةُ التَّشْبِيهِ), the tool of likening, such as الْكَاف or كَأَنَّ or مِثْل; and wajh ash-shabah (وَجْهُ الشَّبَهِ), the shared quality. In زَيْدٌ كَالْأَسَدِ فِي الشَّجَاعَةِ all four stand present: Zayd, the lion, the kāf, and courage.",
     "The art lies in omission. Drop the wajh ash-shabah and the simile is mujmal (مُجْمَل); drop the adāt and it is muʾakkad (مُؤَكَّد); drop both and you reach the strongest grade, at-tashbīh al-balīgh (التَّشْبِيهُ الْبَلِيغُ), as in الْعِلْمُ نُورٌ — knowledge is not merely like light, it is declared to be light.",
     "Compress one step further — delete one of the two sides itself — and simile becomes metaphor: al-istiʿāra (الِاسْتِعَارَةُ), literally 'the borrowing'. When the mushabbah is deleted and the borrowed image is stated openly, the metaphor is taṣrīḥiyya (تَصْرِيحِيَّة); when the image itself is deleted and betrayed only by one of its traits, it is makniyya (مَكْنِيَّة). In every istiʿāra a qarīna (قَرِينَة), a contextual clue, blocks the literal reading. ʿAbd al-Qāhir al-Jurjānī (d. 471 AH) built his أَسْرَارُ الْبَلَاغَةِ on exactly this insight: every metaphor is a simile whose scaffolding has been taken down."
    ],
    "examples": [
     {
      "ar": "الْعِلْمُ كَالنُّورِ فِي الْهِدَايَةِ",
      "translit": "al-ʿilmu ka-n-nūri fī l-hidāyati",
      "en": "Knowledge is like light in guiding.",
      "note": "A classroom model with all four pillars present: mushabbah = الْعِلْم, mushabbah bihi = النُّور, adāt = الْكَاف, wajh ash-shabah = الْهِدَايَة. Remove pieces and the grades of tashbīh appear."
     },
     {
      "ar": "وَإِنَّ صَخْرًا لَتَأْتَمُّ الْهُدَاةُ بِهِ كَأَنَّهُ عَلَمٌ فِي رَأْسِهِ نَارُ",
      "translit": "wa-inna ṣakhran la-taʾtammu l-hudātu bihi ka-annahu ʿalamun fī raʾsihi nāru",
      "en": "Truly the guides take Ṣakhr as their leader, as though he were a mountain with a fire at its summit.",
      "note": "Al-Khansāʾ, elegizing her brother Ṣakhr. Tashbīh with the adāt كَأَنَّ: mushabbah = Ṣakhr, mushabbah bihi = the beacon-mountain; the wajh (being seen and followed by all) is left unstated, so the simile is mujmal."
     },
     {
      "ar": "رَأَيْتُ أَسَدًا يَرْمِي",
      "translit": "raʾaytu asadan yarmī",
      "en": "I saw a lion shooting arrows.",
      "note": "The rhetoricians' stock example of istiʿāra taṣrīḥiyya: the brave man (mushabbah) is deleted, the lion (mushabbah bihi) is stated openly, and يَرْمِي is the qarīna proving a man, not a beast, is meant."
     },
     {
      "ar": "وَاشْتَعَلَ الرَّأْسُ شَيْبًا",
      "translit": "wa-shtaʿala r-raʾsu shayban",
      "en": "…and the head has blazed with white hair.",
      "note": "Qurʾān 19:4 (Sūrat Maryam). Istiʿāra: the blaze of fire is borrowed for white hair overrunning the head — fire itself is never named, evoked only through its verb اِشْتَعَلَ. Al-Jurjānī analyses this verse in Asrār al-Balāgha as a summit of the art."
     },
     {
      "ar": "وَإِذَا الْمَنِيَّةُ أَنْشَبَتْ أَظْفَارَهَا أَلْفَيْتَ كُلَّ تَمِيمَةٍ لَا تَنْفَعُ",
      "translit": "wa-idhā l-maniyyatu anshabat aẓfārahā alfayta kulla tamīmatin lā tanfaʿu",
      "en": "And when death sinks in its claws, you find every amulet of no avail.",
      "note": "Abū Dhuʾayb al-Hudhalī, from his famous elegy for his sons. Istiʿāra makniyya: death (الْمَنِيَّة) is likened to a beast of prey; the beast is deleted and signalled only by one of its traits — the claws (أَظْفَار)."
     }
    ],
    "quiz": [
     {
      "q": "In the tashbīh زَيْدٌ كَالْبَحْرِ فِي الْكَرَمِ, which word is الْمُشَبَّهُ بِهِ?",
      "options": [
       "زَيْد",
       "الْكَاف",
       "الْبَحْر",
       "الْكَرَم"
      ],
      "answer": 2,
      "why": "The sea is the image Zayd is likened to, so it is the mushabbah bihi; زَيْد is the mushabbah, the kāf is the adāt, and generosity is the wajh ash-shabah."
     },
     {
      "q": "What transforms a tashbīh into an istiʿāra?",
      "options": [
       "Adding the adāt كَأَنَّ",
       "Stating the wajh ash-shabah explicitly",
       "Putting it into verse",
       "Deleting one of the two sides (ṭarafayn) entirely"
      ],
      "answer": 3,
      "why": "Istiʿāra is a compressed simile: one of the two ṭarafayn — the mushabbah or the mushabbah bihi — is deleted, and a qarīna points to the intended meaning."
     },
     {
      "q": "In the stock example رَأَيْتُ أَسَدًا يَرْمِي, the brave man is unnamed while the lion is stated openly. Which device is this?",
      "options": [
       "تَشْبِيه بَلِيغ",
       "اِسْتِعَارَة مَكْنِيَّة",
       "اِسْتِعَارَة تَصْرِيحِيَّة",
       "طِبَاق"
      ],
      "answer": 2,
      "why": "The mushabbah bihi (الْأَسَد) is declared openly — ṣurriḥa bihi — while the mushabbah is deleted; يَرْمِي is the qarīna. That is the taṣrīḥiyya."
     },
     {
      "q": "In Abū Dhuʾayb's وَإِذَا الْمَنِيَّةُ أَنْشَبَتْ أَظْفَارَهَا, how is the omitted beast of prey signalled?",
      "options": [
       "By naming الْأَسَد explicitly",
       "By one of its traits — the claws أَظْفَار",
       "By the adāt كَأَنَّ",
       "By the rhyme letter"
      ],
      "answer": 1,
      "why": "In the istiʿāra makniyya the mushabbah bihi is deleted and betrayed by one of its lawāzim — here the claws. Had كَأَنَّ appeared, it would be a simile, not a metaphor."
     },
     {
      "q": "الْعِلْمُ نُورٌ omits both the adāt and the wajh ash-shabah. What is this called?",
      "options": [
       "تَشْبِيه بَلِيغ",
       "تَشْبِيه مُرْسَل",
       "اِسْتِعَارَة مَكْنِيَّة",
       "تَشْبِيه مُجْمَل"
      ],
      "answer": 0,
      "why": "With both the adāt and the wajh omitted, only the two ṭarafān remain face to face — the strongest grade of simile, at-tashbīh al-balīgh. It is still a simile, because both sides are present."
     }
    ]
   },
   {
    "id": "g26",
    "title": "The Ornaments",
    "titleAr": "الْبَدِيعُ",
    "tagline": "Jinās, ṭibāq and sajʿ — the jeweled surface of classical style.",
    "body": [
     "ʿIlm al-badīʿ (عِلْمُ الْبَدِيعِ) is the third science of balāgha — after al-maʿānī, which governs sentence purpose, and al-bayān, whose simile and metaphor you met in the last lesson. It studies the ornaments of speech, and its figures were first collected by the caliph-poet ʿAbd Allāh ibn al-Muʿtazz in his كِتَابُ الْبَدِيعِ of 274 AH.",
     "Al-jinās (الْجِنَاسُ), paronomasia, sets two words of like sound but unlike meaning side by side. It is tāmm (تَامّ), complete, when the two words agree in the kind of their letters, their number, their order and their vowelling; it is nāqiṣ (نَاقِص), deficient, when they differ in any one of these.",
     "Aṭ-ṭibāq (الطِّبَاقُ), antithesis, pairs a word with its opposite in one utterance; when two or more opposed pairs answer each other in order, the figure is called muqābala (مُقَابَلَة). As-sajʿ (السَّجْعُ) is rhymed prose: successive clauses close on the same final letter. It rules early oratory and the maqāmāt; the rhymed verse-endings of the Qurʾān, however, are traditionally called fawāṣil (فَوَاصِل) rather than sajʿ, out of reverence for its inimitability."
    ],
    "examples": [
     {
      "ar": "وَيَوْمَ تَقُومُ السَّاعَةُ يُقْسِمُ الْمُجْرِمُونَ مَا لَبِثُوا غَيْرَ سَاعَةٍ",
      "translit": "wa-yawma taqūmu s-sāʿatu yuqsimu l-mujrimūna mā labithū ghayra sāʿatin",
      "en": "And on the Day the Hour arrives, the criminals will swear they remained no longer than an hour.",
      "note": "Qurʾān 30:55 (Sūrat ar-Rūm). Jinās tāmm between السَّاعَة (the Hour of Resurrection) and سَاعَة (an hour of time): identical letters and vowelling, different meanings."
     },
     {
      "ar": "يَمُدُّونَ مِنْ أَيْدٍ عَوَاصٍ عَوَاصِمٍ تَصُولُ بِأَسْيَافٍ قَوَاضٍ قَوَاضِبِ",
      "translit": "yamuddūna min aydin ʿawāṣin ʿawāṣimin taṣūlu bi-asyāfin qawāḍin qawāḍibi",
      "en": "They stretch forth hands unyielding yet protecting, that strike with swords decreeing doom and cleaving.",
      "note": "Abū Tammām. A double jinās nāqiṣ: عَوَاصٍ / عَوَاصِم and قَوَاضٍ / قَوَاضِب — each pair differs by the addition of a single letter."
     },
     {
      "ar": "وَتَحْسَبُهُمْ أَيْقَاظًا وَهُمْ رُقُودٌ",
      "translit": "wa-taḥsabuhum ayqāẓan wa-hum ruqūdun",
      "en": "And you would think them awake, while they were asleep.",
      "note": "Qurʾān 18:18 (Sūrat al-Kahf), of the Sleepers of the Cave. Ṭibāq between أَيْقَاظ (awake) and رُقُود (asleep) — two opposites joined in one clause."
     },
     {
      "ar": "وَنَشْرَبُ إِنْ وَرَدْنَا الْمَاءَ صَفْوًا وَيَشْرَبُ غَيْرُنَا كَدِرًا وَطِينَا",
      "translit": "wa-nashrabu in waradnā l-māʾa ṣafwan wa-yashrabu ghayrunā kadiran wa-ṭīnā",
      "en": "When we come to the water we drink it clear, while others drink it murky and mixed with mire.",
      "note": "From the Muʿallaqa of ʿAmr ibn Kulthūm. Ṭibāq between صَفْو (clear) and كَدِر (murky), sharpened by the parallel وَنَشْرَبُ / وَيَشْرَبُ."
     },
     {
      "ar": "اللَّهُمَّ أَعْطِ مُنْفِقًا خَلَفًا وَأَعْطِ مُمْسِكًا تَلَفًا",
      "translit": "allāhumma aʿṭi munfiqan khalafan wa-aʿṭi mumsikan talafan",
      "en": "O God, give the spender a replacement, and give the withholder ruin.",
      "note": "The prayer of the two angels in the ḥadīth reported by al-Bukhārī and Muslim. Sajʿ: the two clauses close on the matching endings خَلَفًا / تَلَفًا; the same line also carries ṭibāq between مُنْفِق and مُمْسِك."
     }
    ],
    "quiz": [
     {
      "q": "Jinās is tāmm (complete) only when the two words agree in:",
      "options": [
       "Meaning alone",
       "The kind, number, order and vowelling of their letters",
       "The rhyme letter alone",
       "Their triliteral root"
      ],
      "answer": 1,
      "why": "Complete jinās demands identity in all four respects — kind, number, order and vowelling of the letters — while the meanings differ; any single difference makes it nāqiṣ."
     },
     {
      "q": "Which ornament appears in وَتَحْسَبُهُمْ أَيْقَاظًا وَهُمْ رُقُودٌ (Qurʾān 18:18)?",
      "options": [
       "جِنَاس تَامّ",
       "سَجْع",
       "طِبَاق",
       "اِسْتِعَارَة"
      ],
      "answer": 2,
      "why": "Awake (أَيْقَاظ) and asleep (رُقُود) are opposites paired in a single utterance — the definition of ṭibāq."
     },
     {
      "q": "In Qurʾān 30:55, why do السَّاعَةُ and سَاعَةٍ form jinās tāmm?",
      "options": [
       "The two words sound identical yet mean different things",
       "They share only a root",
       "They merely rhyme at clause-end",
       "They are opposites in meaning"
      ],
      "answer": 0,
      "why": "The Hour of Resurrection and an hour of time coincide in letters, order and vowelling while their meanings diverge — the perfect (tāmm) jinās."
     },
     {
      "q": "What is as-sajʿ (السَّجْع)?",
      "options": [
       "A poetic meter of al-Khalīl",
       "The pairing of a word with its opposite",
       "The agreement of prose clause-endings on one rhyme letter",
       "A simile whose adāt has been deleted"
      ],
      "answer": 2,
      "why": "Sajʿ is rhymed prose: successive clauses close on the same final letter. Meters belong to ʿarūḍ, opposites to ṭibāq, and the clipped simile to tashbīh."
     },
     {
      "q": "In اللَّهُمَّ أَعْطِ مُنْفِقًا خَلَفًا وَأَعْطِ مُمْسِكًا تَلَفًا, the pair مُنْفِق / مُمْسِك and the pair خَلَف / تَلَف are, respectively:",
      "options": [
       "سَجْع then طِبَاق",
       "جِنَاس تَامّ then سَجْع",
       "سَجْع then جِنَاس",
       "طِبَاق then سَجْع"
      ],
      "answer": 3,
      "why": "Spender and withholder are opposites — ṭibāq; the clause-endings خَلَفًا / تَلَفًا carry the sajʿ (and, as a bonus, form a jinās nāqiṣ, differing in one letter)."
     }
    ]
   },
   {
    "id": "g27",
    "title": "The Meters",
    "titleAr": "الْعَرُوضُ",
    "tagline": "Cords, pegs and feet — how al-Khalīl weighed Arabic poetry.",
    "body": [
     "ʿIlm al-ʿarūḍ (عِلْمُ الْعَرُوضِ), prosody, was founded by al-Khalīl ibn Aḥmad al-Farāhīdī (d. c. 175 AH), the same mind that arranged the first Arabic dictionary. A verse is weighed by ear, letter by letter as pronounced, not as spelled: a vowelled letter is mutaḥarrik (مُتَحَرِّك), an unvowelled one sākin (سَاكِن); tanwīn counts as a pronounced nūn, and the letters of prolongation count as sākin.",
     "Two small units build everything. The sabab (سَبَب), 'cord', is two letters: khafīf when a vowelled letter is followed by a quiescent one, as in لُنْ or قَدْ, and thaqīl when both are vowelled, as in لَكَ. The watid (وَتِد), 'peg', is three letters: majmūʿ when two vowelled letters precede the quiescent, as in فَعُو or نَعَمْ, and mafrūq when the quiescent splits them, as in لَيْتَ. Cords and pegs combine into the tafāʿīl (تَفَاعِيل), memory-feet such as فَعُولُنْ and مُتَفَاعِلُنْ, and the feet into the sixteen meters — fifteen derived by al-Khalīl, with al-mutadārik added by his pupil al-Akhfash.",
     "Aṭ-Ṭawīl (الطَّوِيلُ), the most frequent meter of classical poetry, runs فَعُولُنْ مَفَاعِيلُنْ فَعُولُنْ مَفَاعِيلُنْ in each hemistich. Al-Kāmil (الْكَامِلُ) runs مُتَفَاعِلُنْ three times per hemistich. Licensed lightenings called ziḥāf (زِحَاف) vary the feet without breaking the meter: qabḍ (الْقَبْض) deletes a foot's fifth quiescent letter, turning مَفَاعِيلُنْ into مَفَاعِلُنْ, and iḍmār (الْإِضْمَار) stills the second letter of مُتَفَاعِلُنْ into مُتْفَاعِلُنْ."
    ],
    "examples": [
     {
      "ar": "قَدْ",
      "translit": "qad",
      "en": "indeed; already (particle)",
      "note": "The model sabab khafīf (سَبَب خَفِيف): one vowelled letter, then one quiescent — the light cord. Its heavy sibling, the sabab thaqīl, is two vowelled letters, as in لَكَ."
     },
     {
      "ar": "نَعَمْ",
      "translit": "naʿam",
      "en": "yes",
      "note": "The model watid majmūʿ (وَتِد مَجْمُوع): two vowelled letters, then a quiescent — the bound peg. In the watid mafrūq the quiescent splits the two vowelled letters, as in لَيْتَ."
     },
     {
      "ar": "فَعُولُنْ مَفَاعِيلُنْ",
      "translit": "faʿūlun mafāʿīlun",
      "en": "the recurring foot-pair of aṭ-Ṭawīl",
      "note": "Every tafʿīla is pegs plus cords: فَعُولُنْ = the watid فَعُو + the sabab لُنْ; مَفَاعِيلُنْ = the watid مَفَا + the sababs عِي and لُنْ. Doubling this pair yields one hemistich of aṭ-Ṭawīl."
     },
     {
      "ar": "قِفَا نَبْكِ مِنْ ذِكْرَى حَبِيبٍ وَمَنْزِلِ بِسِقْطِ اللِّوَى بَيْنَ الدَّخُولِ فَحَوْمَلِ",
      "translit": "qifā nabki min dhikrā ḥabībin wa-manzili bi-siqṭi l-liwā bayna d-dakhūli fa-ḥawmali",
      "en": "Halt, you two, and let us weep for the memory of a beloved and a dwelling, where the sands curve between ad-Dakhūl and Ḥawmal.",
      "note": "Opening of the Muʿallaqa of Imruʾ al-Qays — aṭ-Ṭawīl. First hemistich scanned: qi-fā-nab / ki-min-dhik-rā / ḥa-bī-bin / wa-man-zi-lī = فَعُولُنْ مَفَاعِيلُنْ فَعُولُنْ مَفَاعِلُنْ; the fourth foot shows qabḍ, regular at this position in aṭ-Ṭawīl, and the rhyme kasra is lengthened in recitation."
     },
     {
      "ar": "هَلْ غَادَرَ الشُّعَرَاءُ مِنْ مُتَرَدَّمِ أَمْ هَلْ عَرَفْتَ الدَّارَ بَعْدَ تَوَهُّمِ",
      "translit": "hal ghādara sh-shuʿarāʾu min mutaraddami am hal ʿarafta d-dāra baʿda tawahhumi",
      "en": "Have the poets left any patch unstitched? Or did you recognize the abode after long conjecture?",
      "note": "Opening of the Muʿallaqa of ʿAntara ibn Shaddād — al-Kāmil. First hemistich scanned: hal-ghā-da-rash / shu-ʿa-rā-ʾu-min / mu-ta-rad-da-mī = مُتْفَاعِلُنْ مُتَفَاعِلُنْ مُتَفَاعِلُنْ; the first foot shows iḍmār, and the rhyme kasra is lengthened in recitation."
     }
    ],
    "quiz": [
     {
      "q": "A sabab khafīf (سَبَب خَفِيف) consists of:",
      "options": [
       "Two vowelled letters",
       "One vowelled letter followed by one quiescent letter",
       "Two vowelled letters followed by one quiescent",
       "Two quiescent letters"
      ],
      "answer": 1,
      "why": "The light cord is mutaḥarrik + sākin, as in لُنْ or قَدْ; two vowelled letters make the sabab thaqīl, and two vowelled plus a quiescent make the watid majmūʿ."
     },
     {
      "q": "The word نَعَمْ is the model of which prosodic unit?",
      "options": [
       "سَبَب خَفِيف",
       "سَبَب ثَقِيل",
       "وَتِد مَجْمُوع",
       "وَتِد مَفْرُوق"
      ],
      "answer": 2,
      "why": "نَعَمْ is two vowelled letters followed by a quiescent — the bound peg (watid majmūʿ). قَدْ models the sabab khafīf, and لَيْتَ the watid mafrūq."
     },
     {
      "q": "One hemistich of aṭ-Ṭawīl runs:",
      "options": [
       "فَعُولُنْ مَفَاعِيلُنْ فَعُولُنْ مَفَاعِيلُنْ",
       "مُتَفَاعِلُنْ مُتَفَاعِلُنْ مُتَفَاعِلُنْ",
       "مَفَاعِيلُنْ مَفَاعِيلُنْ فَعُولُنْ",
       "فَاعِلَاتُنْ فَاعِلَاتُنْ فَاعِلَاتُنْ"
      ],
      "answer": 0,
      "why": "Aṭ-Ṭawīl doubles the pair فَعُولُنْ مَفَاعِيلُنْ in each hemistich; مُتَفَاعِلُنْ three times is al-Kāmil, and فَاعِلَاتُنْ three times is ar-Ramal."
     },
     {
      "q": "To which meter does قِفَا نَبْكِ مِنْ ذِكْرَى حَبِيبٍ وَمَنْزِلِ scan?",
      "options": [
       "الْكَامِل",
       "الْوَافِر",
       "الْبَسِيط",
       "الطَّوِيل"
      ],
      "answer": 3,
      "why": "It scans qi-fā-nab / ki-min-dhik-rā = فَعُولُنْ مَفَاعِيلُنْ — the Ṭawīl opening of the Muʿallaqa of Imruʾ al-Qays."
     },
     {
      "q": "In al-Kāmil, مُتَفَاعِلُنْ frequently appears as مُتْفَاعِلُنْ. This licensed variation is called:",
      "options": [
       "الْقَبْض",
       "الْإِضْمَار",
       "الْخَبْن",
       "الطَّيّ"
      ],
      "answer": 1,
      "why": "Iḍmār stills (gives sukūn to) the second letter of مُتَفَاعِلُنْ. Qabḍ instead deletes a fifth quiescent letter, as when مَفَاعِيلُنْ becomes مَفَاعِلُنْ in aṭ-Ṭawīl."
     }
    ]
   },
   {
    "id": "g28",
    "title": "Reading the Unvocalized Page",
    "titleAr": "قِرَاءَةُ غَيْرِ الْمَشْكُولِ",
    "tagline": "Bare consonants, full meaning — vocalize the page like a scholar.",
    "body": [
     "Classical books were copied, and are still printed, with bare consonants: قرأ الطالب الكتاب carries not a single vowel sign, yet a trained reader pronounces قَرَأَ الطَّالِبُ الْكِتَابَ without hesitation. Vocalization is not memorized word by word — it is computed. This capstone lesson gathers everything you have built into a reading method.",
     "First, weigh the word: a skeleton usually admits only one wazn. A shape like مكتوب or معلوم can only be مَفْعُول; a noun shaped like فاعل after ال reads فَاعِل. Second, parse the slot: the article ال excludes tanwīn; a preposition forces jarr on what follows; the subject stands in rafʿ and the object in naṣb; and the first term of an iḍāfa takes its case from its own position but never takes tanwīn or the article.",
     "Third, read the verb's skeleton: initial است announces Form X (اِسْتَفْعَلَ), initial ان before the root announces Form VII (اِنْفَعَلَ), and a doubled middle radical marks Form II. Then ask whether an agent is on stage: كتبت الرسالة with no writer in sight is the passive كُتِبَتِ الرِّسَالَةُ. Finally, read to the end of the sentence before fixing the final vowels — iʿrāb is decided by the whole clause, which is why the masters warn: never vocalize the end of a word before you know its place."
    ],
    "examples": [
     {
      "ar": "استخرج الرجل الماء من البئر ← اِسْتَخْرَجَ الرَّجُلُ الْمَاءَ مِنَ الْبِئْرِ",
      "translit": "istakhraja r-rajulu l-māʾa mina l-biʾri",
      "en": "The man drew the water out of the well.",
      "note": "Initial است announces Form X اِسْتَفْعَلَ, fixing every internal vowel; then the syntax finishes the job — subject in rafʿ, object in naṣb, jarr after مِنْ."
     },
     {
      "ar": "المكتوب في الكتاب مفهوم ← الْمَكْتُوبُ فِي الْكِتَابِ مَفْهُومٌ",
      "translit": "al-maktūbu fī l-kitābi mafhūmun",
      "en": "What is written in the book is understood.",
      "note": "Both مكتوب and مفهوم sit on the skeleton of مَفْعُول, so their internal vowels are locked. The article rules out tanwīn on the mubtadaʾ, فِي forces jarr, and the indefinite khabar closes with tanwīn ḍamm."
     },
     {
      "ar": "انكسر الزجاج في البيت ← اِنْكَسَرَ الزُّجَاجُ فِي الْبَيْتِ",
      "translit": "inkasara z-zujāju fī l-bayti",
      "en": "The glass broke in the house.",
      "note": "Initial ان before the root marks Form VII اِنْفَعَلَ, which is always intransitive — so الزُّجَاجُ can only be its subject, in rafʿ."
     },
     {
      "ar": "كتاب الطالب جديد ← كِتَابُ الطَّالِبِ جَدِيدٌ",
      "translit": "kitābu ṭ-ṭālibi jadīdun",
      "en": "The student's book is new.",
      "note": "A bare noun followed directly by a definite noun signals iḍāfa: no tanwīn on the muḍāf (which takes rafʿ as mubtadaʾ), jarr on the muḍāf ilayhi, and the khabar closes in rafʿ with tanwīn."
     },
     {
      "ar": "فتح الباب ← فُتِحَ الْبَابُ",
      "translit": "futiḥa l-bābu",
      "en": "The door was opened.",
      "note": "No agent stands in the sentence, so read the passive fuʿila with الْبَابُ as nāʾib al-fāʿil. Had the text continued فَتَحَ الرَّجُلُ الْبَابَ, the named agent would force the active reading."
     }
    ],
    "quiz": [
     {
      "q": "In the unvocalized sentence ذهب الولد إلى المسجد, how must the last word be read?",
      "options": [
       "الْمَسْجِدِ",
       "الْمَسْجِدُ",
       "الْمَسْجِدَ",
       "مَسْجِدٍ"
      ],
      "answer": 0,
      "why": "After the preposition إِلَى the noun must stand in jarr: إِلَى الْمَسْجِدِ. The article forbids tanwīn, which also eliminates مَسْجِدٍ."
     },
     {
      "q": "In كاتب العالم تلميذه في مسألة من النحو, how should كاتب be read?",
      "options": [
       "كَاتِبٌ",
       "كَاتَبَ",
       "كَاتِبَ",
       "كَاتِبِ"
      ],
      "answer": 1,
      "why": "The clause needs a verb: Form III كَاتَبَ, 'he corresponded with', takes الْعَالِمُ as subject in rafʿ and تِلْمِيذَهُ as object in naṣb. Reading a participle iḍāfa ('the scholar's scribe is his pupil — about a grammar question') leaves the sentence hanging."
     },
     {
      "q": "In كتبت الرسالة ولا يعرف كاتبها, how should كتبت be read?",
      "options": [
       "كَتَبْتُ",
       "كَتَبَتْ",
       "كُتِبَتْ",
       "كَتَّبْتُ"
      ],
      "answer": 2,
      "why": "The continuation 'its writer is unknown' rules out a named agent, and a letter cannot write — so read the passive كُتِبَتِ الرِّسَالَةُ, with الرِّسَالَةُ as nāʾib al-fāʿil."
     },
     {
      "q": "The unpointed word مشهور admits only one reading. Which?",
      "options": [
       "مِشْهُور",
       "مَشَهُور",
       "مُشْهُور",
       "مَشْهُور"
      ],
      "answer": 3,
      "why": "The skeleton fits exactly one pattern, the passive participle مَفْعُول: mashhūr, 'famous'. Arabic has no patterns yielding mishhūr or mashahūr, so the wazn fixes every vowel."
     },
     {
      "q": "Which is the correct full vocalization of باب المدينة واسع?",
      "options": [
       "بَابُ الْمَدِينَةِ وَاسِعٌ",
       "بَابٌ الْمَدِينَةِ وَاسِعٌ",
       "بَابُ الْمَدِينَةُ وَاسِعَةٌ",
       "بَابِ الْمَدِينَةَ وَاسِعٍ"
      ],
      "answer": 0,
      "why": "This is an iḍāfa: the muḍāf بَابُ takes rafʿ as mubtadaʾ but never tanwīn, الْمَدِينَةِ is majrūr as muḍāf ilayhi, and the khabar وَاسِعٌ is marfūʿ, agreeing with masculine بَاب."
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
   },
   {
    "id": "kursi",
    "title": "The Throne Verse",
    "titleAr": "آيَةُ الْكُرْسِيِّ",
    "source": "Qurʾān 2:255",
    "kind": "quran",
    "intro": "The most celebrated single verse of the Qurʾān strings together nominal sentences, relative clauses, and attached pronouns you already know — read it slowly and track every case ending.",
    "lines": [
     {
      "ar": "اللَّهُ لَا إِلَهَ إِلَّا هُوَ الْحَيُّ الْقَيُّومُ",
      "translit": "Allāhu lā ilāha illā huwa l-ḥayyu l-qayyūm",
      "en": "Allah — there is no god but He, the Ever-Living, the Self-Subsisting.",
      "ref": "2:255 (1/5)",
      "words": [
       {
        "ar": "اللَّهُ",
        "en": "Allah"
       },
       {
        "ar": "لَا",
        "en": "there is no"
       },
       {
        "ar": "إِلَهَ",
        "en": "god"
       },
       {
        "ar": "إِلَّا",
        "en": "except"
       },
       {
        "ar": "هُوَ",
        "en": "He"
       },
       {
        "ar": "الْحَيُّ",
        "en": "the Ever-Living"
       },
       {
        "ar": "الْقَيُّومُ",
        "en": "the Self-Subsisting"
       }
      ]
     },
     {
      "ar": "لَا تَأْخُذُهُ سِنَةٌ وَلَا نَوْمٌ لَهُ مَا فِي السَّمَاوَاتِ وَمَا فِي الْأَرْضِ",
      "translit": "lā taʾkhudhuhu sinatun wa-lā nawm; lahu mā fī s-samāwāti wa-mā fī l-arḍ",
      "en": "Neither drowsiness overtakes Him nor sleep; to Him belongs whatever is in the heavens and whatever is on the earth.",
      "ref": "2:255 (2/5)",
      "words": [
       {
        "ar": "لَا",
        "en": "not"
       },
       {
        "ar": "تَأْخُذُهُ",
        "en": "does (it) overtake Him"
       },
       {
        "ar": "سِنَةٌ",
        "en": "drowsiness"
       },
       {
        "ar": "وَلَا",
        "en": "nor"
       },
       {
        "ar": "نَوْمٌ",
        "en": "sleep"
       },
       {
        "ar": "لَهُ",
        "en": "to Him belongs"
       },
       {
        "ar": "مَا",
        "en": "whatever (is)"
       },
       {
        "ar": "فِي",
        "en": "in"
       },
       {
        "ar": "السَّمَاوَاتِ",
        "en": "the heavens"
       },
       {
        "ar": "وَمَا",
        "en": "and whatever (is)"
       },
       {
        "ar": "فِي",
        "en": "in"
       },
       {
        "ar": "الْأَرْضِ",
        "en": "the earth"
       }
      ]
     },
     {
      "ar": "مَنْ ذَا الَّذِي يَشْفَعُ عِنْدَهُ إِلَّا بِإِذْنِهِ يَعْلَمُ مَا بَيْنَ أَيْدِيهِمْ وَمَا خَلْفَهُمْ",
      "translit": "man dhā lladhī yashfaʿu ʿindahu illā bi-idhnih; yaʿlamu mā bayna aydīhim wa-mā khalfahum",
      "en": "Who is it that can intercede with Him except by His permission? He knows what lies before them and what lies behind them.",
      "ref": "2:255 (3/5)",
      "words": [
       {
        "ar": "مَنْ",
        "en": "who (is)"
       },
       {
        "ar": "ذَا",
        "en": "the one"
       },
       {
        "ar": "الَّذِي",
        "en": "who"
       },
       {
        "ar": "يَشْفَعُ",
        "en": "intercedes"
       },
       {
        "ar": "عِنْدَهُ",
        "en": "with Him"
       },
       {
        "ar": "إِلَّا",
        "en": "except"
       },
       {
        "ar": "بِإِذْنِهِ",
        "en": "by His permission"
       },
       {
        "ar": "يَعْلَمُ",
        "en": "He knows"
       },
       {
        "ar": "مَا",
        "en": "what (is)"
       },
       {
        "ar": "بَيْنَ",
        "en": "between"
       },
       {
        "ar": "أَيْدِيهِمْ",
        "en": "their hands (i.e. before them)"
       },
       {
        "ar": "وَمَا",
        "en": "and what (is)"
       },
       {
        "ar": "خَلْفَهُمْ",
        "en": "behind them"
       }
      ]
     },
     {
      "ar": "وَلَا يُحِيطُونَ بِشَيْءٍ مِنْ عِلْمِهِ إِلَّا بِمَا شَاءَ وَسِعَ كُرْسِيُّهُ السَّمَاوَاتِ وَالْأَرْضَ",
      "translit": "wa-lā yuḥīṭūna bi-shayʾin min ʿilmihi illā bi-mā shāʾ; wasiʿa kursiyyuhu s-samāwāti wa-l-arḍ",
      "en": "They encompass nothing of His knowledge except what He wills; His Footstool extends over the heavens and the earth.",
      "ref": "2:255 (4/5)",
      "words": [
       {
        "ar": "وَلَا",
        "en": "and not"
       },
       {
        "ar": "يُحِيطُونَ",
        "en": "do they encompass"
       },
       {
        "ar": "بِشَيْءٍ",
        "en": "anything"
       },
       {
        "ar": "مِنْ",
        "en": "of"
       },
       {
        "ar": "عِلْمِهِ",
        "en": "His knowledge"
       },
       {
        "ar": "إِلَّا",
        "en": "except"
       },
       {
        "ar": "بِمَا",
        "en": "what"
       },
       {
        "ar": "شَاءَ",
        "en": "He willed"
       },
       {
        "ar": "وَسِعَ",
        "en": "extends over"
       },
       {
        "ar": "كُرْسِيُّهُ",
        "en": "His Footstool (Kursī)"
       },
       {
        "ar": "السَّمَاوَاتِ",
        "en": "the heavens"
       },
       {
        "ar": "وَالْأَرْضَ",
        "en": "and the earth"
       }
      ]
     },
     {
      "ar": "وَلَا يَئُودُهُ حِفْظُهُمَا وَهُوَ الْعَلِيُّ الْعَظِيمُ",
      "translit": "wa-lā yaʾūduhu ḥifẓuhumā wa-huwa l-ʿaliyyu l-ʿaẓīm",
      "en": "Preserving them both does not weary Him; and He is the Most High, the Magnificent.",
      "ref": "2:255 (5/5)",
      "words": [
       {
        "ar": "وَلَا",
        "en": "and not"
       },
       {
        "ar": "يَئُودُهُ",
        "en": "does (it) weary Him"
       },
       {
        "ar": "حِفْظُهُمَا",
        "en": "the preserving of them both"
       },
       {
        "ar": "وَهُوَ",
        "en": "and He (is)"
       },
       {
        "ar": "الْعَلِيُّ",
        "en": "the Most High"
       },
       {
        "ar": "الْعَظِيمُ",
        "en": "the Magnificent"
       }
      ]
     }
    ]
   },
   {
    "id": "asr",
    "title": "Sūrat al-ʿAṣr",
    "titleAr": "سُورَةُ الْعَصْرِ",
    "source": "Qurʾān, sūra 103",
    "kind": "quran",
    "intro": "This three-verse sūra is a complete classical argument in miniature: an oath, a universal claim reinforced by inna and the emphatic la-, and a fourfold exception.",
    "lines": [
     {
      "ar": "وَالْعَصْرِ",
      "translit": "wa-l-ʿaṣr",
      "en": "By the passing time!",
      "ref": "103:1",
      "words": [
       {
        "ar": "وَالْعَصْرِ",
        "en": "by the passing time! (oath wa-)"
       }
      ]
     },
     {
      "ar": "إِنَّ الْإِنْسَانَ لَفِي خُسْرٍ",
      "translit": "inna l-insāna la-fī khusr",
      "en": "Indeed, man is surely in loss.",
      "ref": "103:2",
      "words": [
       {
        "ar": "إِنَّ",
        "en": "indeed"
       },
       {
        "ar": "الْإِنْسَانَ",
        "en": "man, humankind"
       },
       {
        "ar": "لَفِي",
        "en": "is surely in (emphatic la- + fī)"
       },
       {
        "ar": "خُسْرٍ",
        "en": "loss"
       }
      ]
     },
     {
      "ar": "إِلَّا الَّذِينَ آمَنُوا وَعَمِلُوا الصَّالِحَاتِ وَتَوَاصَوْا بِالْحَقِّ وَتَوَاصَوْا بِالصَّبْرِ",
      "translit": "illā lladhīna āmanū wa-ʿamilū ṣ-ṣāliḥāti wa-tawāṣaw bi-l-ḥaqqi wa-tawāṣaw bi-ṣ-ṣabr",
      "en": "Except those who believe, do righteous deeds, enjoin one another to the truth, and enjoin one another to patience.",
      "ref": "103:3",
      "words": [
       {
        "ar": "إِلَّا",
        "en": "except"
       },
       {
        "ar": "الَّذِينَ",
        "en": "those who"
       },
       {
        "ar": "آمَنُوا",
        "en": "believed"
       },
       {
        "ar": "وَعَمِلُوا",
        "en": "and did"
       },
       {
        "ar": "الصَّالِحَاتِ",
        "en": "the righteous deeds"
       },
       {
        "ar": "وَتَوَاصَوْا",
        "en": "and enjoined one another"
       },
       {
        "ar": "بِالْحَقِّ",
        "en": "to the truth"
       },
       {
        "ar": "وَتَوَاصَوْا",
        "en": "and enjoined one another"
       },
       {
        "ar": "بِالصَّبْرِ",
        "en": "to patience"
       }
      ]
     }
    ]
   },
   {
    "id": "falaq",
    "title": "Sūrat al-Falaq",
    "titleAr": "سُورَةُ الْفَلَقِ",
    "source": "Qurʾān, sūra 113",
    "kind": "quran",
    "intro": "A morning-and-evening refuge prayer built on the preposition min and a chain of idafa constructions after sharri — 'the evil of…'.",
    "lines": [
     {
      "ar": "قُلْ أَعُوذُ بِرَبِّ الْفَلَقِ",
      "translit": "qul aʿūdhu bi-rabbi l-falaq",
      "en": "Say: I take refuge in the Lord of the daybreak,",
      "ref": "113:1",
      "words": [
       {
        "ar": "قُلْ",
        "en": "say!"
       },
       {
        "ar": "أَعُوذُ",
        "en": "I take refuge"
       },
       {
        "ar": "بِرَبِّ",
        "en": "in the Lord of"
       },
       {
        "ar": "الْفَلَقِ",
        "en": "the daybreak"
       }
      ]
     },
     {
      "ar": "مِنْ شَرِّ مَا خَلَقَ",
      "translit": "min sharri mā khalaq",
      "en": "from the evil of what He created,",
      "ref": "113:2",
      "words": [
       {
        "ar": "مِنْ",
        "en": "from"
       },
       {
        "ar": "شَرِّ",
        "en": "the evil of"
       },
       {
        "ar": "مَا",
        "en": "what"
       },
       {
        "ar": "خَلَقَ",
        "en": "He created"
       }
      ]
     },
     {
      "ar": "وَمِنْ شَرِّ غَاسِقٍ إِذَا وَقَبَ",
      "translit": "wa-min sharri ghāsiqin idhā waqab",
      "en": "and from the evil of darkness when it settles,",
      "ref": "113:3",
      "words": [
       {
        "ar": "وَمِنْ",
        "en": "and from"
       },
       {
        "ar": "شَرِّ",
        "en": "the evil of"
       },
       {
        "ar": "غَاسِقٍ",
        "en": "darkness"
       },
       {
        "ar": "إِذَا",
        "en": "when"
       },
       {
        "ar": "وَقَبَ",
        "en": "it settles"
       }
      ]
     },
     {
      "ar": "وَمِنْ شَرِّ النَّفَّاثَاتِ فِي الْعُقَدِ",
      "translit": "wa-min sharri n-naffāthāti fī l-ʿuqad",
      "en": "and from the evil of the women who blow on knots,",
      "ref": "113:4",
      "words": [
       {
        "ar": "وَمِنْ",
        "en": "and from"
       },
       {
        "ar": "شَرِّ",
        "en": "the evil of"
       },
       {
        "ar": "النَّفَّاثَاتِ",
        "en": "the women who blow"
       },
       {
        "ar": "فِي",
        "en": "on"
       },
       {
        "ar": "الْعُقَدِ",
        "en": "the knots"
       }
      ]
     },
     {
      "ar": "وَمِنْ شَرِّ حَاسِدٍ إِذَا حَسَدَ",
      "translit": "wa-min sharri ḥāsidin idhā ḥasad",
      "en": "and from the evil of an envier when he envies.",
      "ref": "113:5",
      "words": [
       {
        "ar": "وَمِنْ",
        "en": "and from"
       },
       {
        "ar": "شَرِّ",
        "en": "the evil of"
       },
       {
        "ar": "حَاسِدٍ",
        "en": "an envier"
       },
       {
        "ar": "إِذَا",
        "en": "when"
       },
       {
        "ar": "حَسَدَ",
        "en": "he envies"
       }
      ]
     }
    ]
   },
   {
    "id": "nas",
    "title": "Sūrat an-Nās",
    "titleAr": "سُورَةُ النَّاسِ",
    "source": "Qurʾān, sūra 114",
    "kind": "quran",
    "intro": "The Qurʾān's final sūra piles up genitive constructions ending in an-nās and a relative clause with alladhī — perfect practice for the idafa you have mastered.",
    "lines": [
     {
      "ar": "قُلْ أَعُوذُ بِرَبِّ النَّاسِ",
      "translit": "qul aʿūdhu bi-rabbi n-nās",
      "en": "Say: I take refuge in the Lord of mankind,",
      "ref": "114:1",
      "words": [
       {
        "ar": "قُلْ",
        "en": "say!"
       },
       {
        "ar": "أَعُوذُ",
        "en": "I take refuge"
       },
       {
        "ar": "بِرَبِّ",
        "en": "in the Lord of"
       },
       {
        "ar": "النَّاسِ",
        "en": "mankind"
       }
      ]
     },
     {
      "ar": "مَلِكِ النَّاسِ",
      "translit": "maliki n-nās",
      "en": "the King of mankind,",
      "ref": "114:2",
      "words": [
       {
        "ar": "مَلِكِ",
        "en": "the King of"
       },
       {
        "ar": "النَّاسِ",
        "en": "mankind"
       }
      ]
     },
     {
      "ar": "إِلَهِ النَّاسِ",
      "translit": "ilāhi n-nās",
      "en": "the God of mankind,",
      "ref": "114:3",
      "words": [
       {
        "ar": "إِلَهِ",
        "en": "the God of"
       },
       {
        "ar": "النَّاسِ",
        "en": "mankind"
       }
      ]
     },
     {
      "ar": "مِنْ شَرِّ الْوَسْوَاسِ الْخَنَّاسِ",
      "translit": "min sharri l-waswāsi l-khannās",
      "en": "from the evil of the retreating whisperer,",
      "ref": "114:4",
      "words": [
       {
        "ar": "مِنْ",
        "en": "from"
       },
       {
        "ar": "شَرِّ",
        "en": "the evil of"
       },
       {
        "ar": "الْوَسْوَاسِ",
        "en": "the whisperer"
       },
       {
        "ar": "الْخَنَّاسِ",
        "en": "the one who slinks away"
       }
      ]
     },
     {
      "ar": "الَّذِي يُوَسْوِسُ فِي صُدُورِ النَّاسِ",
      "translit": "alladhī yuwaswisu fī ṣudūri n-nās",
      "en": "who whispers in the breasts of mankind,",
      "ref": "114:5",
      "words": [
       {
        "ar": "الَّذِي",
        "en": "who"
       },
       {
        "ar": "يُوَسْوِسُ",
        "en": "whispers"
       },
       {
        "ar": "فِي",
        "en": "in"
       },
       {
        "ar": "صُدُورِ",
        "en": "the breasts of"
       },
       {
        "ar": "النَّاسِ",
        "en": "mankind"
       }
      ]
     },
     {
      "ar": "مِنَ الْجِنَّةِ وَالنَّاسِ",
      "translit": "mina l-jinnati wa-n-nās",
      "en": "from among the jinn and mankind.",
      "ref": "114:6",
      "words": [
       {
        "ar": "مِنَ",
        "en": "from among"
       },
       {
        "ar": "الْجِنَّةِ",
        "en": "the jinn"
       },
       {
        "ar": "وَالنَّاسِ",
        "en": "and mankind"
       }
      ]
     }
    ]
   },
   {
    "id": "hadith",
    "title": "Six Prophetic Sayings",
    "titleAr": "سِتَّةُ أَحَادِيثَ نَبَوِيَّةٍ",
    "source": "The Prophetic Sunna",
    "kind": "hadith",
    "intro": "Six of the most famous, rigorously authenticated short sayings of the Prophet, each a compact model of classical syntax — nominal sentences, relatives with man and mā, and the jussive of command.",
    "lines": [
     {
      "ar": "إِنَّمَا الْأَعْمَالُ بِالنِّيَّاتِ",
      "translit": "innamā l-aʿmālu bi-n-niyyāt",
      "en": "Deeds are only according to intentions.",
      "ref": "al-Bukhārī & Muslim",
      "words": [
       {
        "ar": "إِنَّمَا",
        "en": "only"
       },
       {
        "ar": "الْأَعْمَالُ",
        "en": "deeds (are)"
       },
       {
        "ar": "بِالنِّيَّاتِ",
        "en": "according to intentions"
       }
      ]
     },
     {
      "ar": "الدِّينُ النَّصِيحَةُ",
      "translit": "ad-dīnu n-naṣīḥa",
      "en": "Religion is sincere counsel.",
      "ref": "Muslim",
      "words": [
       {
        "ar": "الدِّينُ",
        "en": "religion (is)"
       },
       {
        "ar": "النَّصِيحَةُ",
        "en": "sincere counsel"
       }
      ]
     },
     {
      "ar": "مِنْ حُسْنِ إِسْلَامِ الْمَرْءِ تَرْكُهُ مَا لَا يَعْنِيهِ",
      "translit": "min ḥusni islāmi l-marʾi tarkuhu mā lā yaʿnīh",
      "en": "Part of the excellence of a person's Islam is his leaving what does not concern him.",
      "ref": "at-Tirmidhī",
      "words": [
       {
        "ar": "مِنْ",
        "en": "part of"
       },
       {
        "ar": "حُسْنِ",
        "en": "the excellence of"
       },
       {
        "ar": "إِسْلَامِ",
        "en": "the Islam of"
       },
       {
        "ar": "الْمَرْءِ",
        "en": "the person"
       },
       {
        "ar": "تَرْكُهُ",
        "en": "(is) his leaving"
       },
       {
        "ar": "مَا",
        "en": "what"
       },
       {
        "ar": "لَا",
        "en": "not"
       },
       {
        "ar": "يَعْنِيهِ",
        "en": "does concern him"
       }
      ]
     },
     {
      "ar": "لَا يُؤْمِنُ أَحَدُكُمْ حَتَّى يُحِبَّ لِأَخِيهِ مَا يُحِبُّ لِنَفْسِهِ",
      "translit": "lā yuʾminu aḥadukum ḥattā yuḥibba li-akhīhi mā yuḥibbu li-nafsih",
      "en": "None of you believes until he loves for his brother what he loves for himself.",
      "ref": "al-Bukhārī & Muslim",
      "words": [
       {
        "ar": "لَا",
        "en": "not"
       },
       {
        "ar": "يُؤْمِنُ",
        "en": "does believe"
       },
       {
        "ar": "أَحَدُكُمْ",
        "en": "any one of you"
       },
       {
        "ar": "حَتَّى",
        "en": "until"
       },
       {
        "ar": "يُحِبَّ",
        "en": "he loves"
       },
       {
        "ar": "لِأَخِيهِ",
        "en": "for his brother"
       },
       {
        "ar": "مَا",
        "en": "what"
       },
       {
        "ar": "يُحِبُّ",
        "en": "he loves"
       },
       {
        "ar": "لِنَفْسِهِ",
        "en": "for himself"
       }
      ]
     },
     {
      "ar": "الْمُسْلِمُ مَنْ سَلِمَ الْمُسْلِمُونَ مِنْ لِسَانِهِ وَيَدِهِ",
      "translit": "al-muslimu man salima l-muslimūna min lisānihi wa-yadih",
      "en": "The Muslim is the one from whose tongue and hand the Muslims are safe.",
      "ref": "al-Bukhārī & Muslim",
      "words": [
       {
        "ar": "الْمُسْلِمُ",
        "en": "the Muslim (is)"
       },
       {
        "ar": "مَنْ",
        "en": "the one from whom"
       },
       {
        "ar": "سَلِمَ",
        "en": "are safe"
       },
       {
        "ar": "الْمُسْلِمُونَ",
        "en": "the Muslims"
       },
       {
        "ar": "مِنْ",
        "en": "from"
       },
       {
        "ar": "لِسَانِهِ",
        "en": "his tongue"
       },
       {
        "ar": "وَيَدِهِ",
        "en": "and his hand"
       }
      ]
     },
     {
      "ar": "مَنْ كَانَ يُؤْمِنُ بِاللَّهِ وَالْيَوْمِ الْآخِرِ فَلْيَقُلْ خَيْرًا أَوْ لِيَصْمُتْ",
      "translit": "man kāna yuʾminu bi-llāhi wa-l-yawmi l-ākhiri fa-l-yaqul khayran aw li-yaṣmut",
      "en": "Whoever believes in Allah and the Last Day, let him speak good or keep silent.",
      "ref": "al-Bukhārī & Muslim",
      "words": [
       {
        "ar": "مَنْ",
        "en": "whoever"
       },
       {
        "ar": "كَانَ",
        "en": "is (one who)"
       },
       {
        "ar": "يُؤْمِنُ",
        "en": "believes"
       },
       {
        "ar": "بِاللَّهِ",
        "en": "in Allah"
       },
       {
        "ar": "وَالْيَوْمِ",
        "en": "and the Day"
       },
       {
        "ar": "الْآخِرِ",
        "en": "the Last"
       },
       {
        "ar": "فَلْيَقُلْ",
        "en": "then let him say"
       },
       {
        "ar": "خَيْرًا",
        "en": "good"
       },
       {
        "ar": "أَوْ",
        "en": "or"
       },
       {
        "ar": "لِيَصْمُتْ",
        "en": "let him keep silent"
       }
      ]
     }
    ]
   },
   {
    "id": "muallaqa",
    "title": "The Muʿallaqa of Imruʾ al-Qays (Opening)",
    "titleAr": "مُعَلَّقَةُ امْرِئِ الْقَيْسِ",
    "source": "Muʿallaqat Imriʾ al-Qays",
    "kind": "poetry",
    "intro": "The most famous opening in all of Arabic poetry: the pre-Islamic prince Imruʾ al-Qays halts his two companions at a deserted campsite between ad-Dakhūl and Ḥawmal to weep over a lost beloved.",
    "lines": [
     {
      "ar": "قِفَا نَبْكِ مِنْ ذِكْرَى حَبِيبٍ وَمَنْزِلِ بِسِقْطِ اللِّوَى بَيْنَ الدَّخُولِ فَحَوْمَلِ",
      "translit": "qifā nabki min dhikrā ḥabībin wa-manzili bi-siqṭi al-liwā bayna ad-dakhūli fa-ḥawmali",
      "en": "Halt, you two, and let us weep for the memory of a beloved and a dwelling, at the dune's edge where the sands twist, between ad-Dakhūl and Ḥawmal.",
      "ref": "bayt 1",
      "words": [
       {
        "ar": "قِفَا",
        "en": "halt, you two!"
       },
       {
        "ar": "نَبْكِ",
        "en": "let us weep"
       },
       {
        "ar": "مِنْ",
        "en": "at (lit. from)"
       },
       {
        "ar": "ذِكْرَى",
        "en": "the memory of"
       },
       {
        "ar": "حَبِيبٍ",
        "en": "a beloved"
       },
       {
        "ar": "وَمَنْزِلِ",
        "en": "and a dwelling-place (wa- + manzil)"
       },
       {
        "ar": "بِسِقْطِ",
        "en": "at the curving edge of (bi- + siqṭ)"
       },
       {
        "ar": "اللِّوَى",
        "en": "the twisting sands"
       },
       {
        "ar": "بَيْنَ",
        "en": "between"
       },
       {
        "ar": "الدَّخُولِ",
        "en": "ad-Dakhūl (a place)"
       },
       {
        "ar": "فَحَوْمَلِ",
        "en": "and Ḥawmal (fa- + place name)"
       }
      ]
     },
     {
      "ar": "فَتُوضِحَ فَالْمِقْرَاةِ لَمْ يَعْفُ رَسْمُهَا لِمَا نَسَجَتْهَا مِنْ جَنُوبٍ وَشَمْأَلِ",
      "translit": "fa-tūḍiḥa fa-al-miqrāti lam yaʿfu rasmuhā li-mā nasajat-hā min janūbin wa-shamʾali",
      "en": "Then Tūḍiḥ, then al-Miqrāt — their trace has not been effaced, for all that the south wind and the north have woven across them.",
      "ref": "bayt 2",
      "words": [
       {
        "ar": "فَتُوضِحَ",
        "en": "then Tūḍiḥ (fa- + place name)"
       },
       {
        "ar": "فَالْمِقْرَاةِ",
        "en": "then al-Miqrāt (fa- + place name)"
       },
       {
        "ar": "لَمْ",
        "en": "not"
       },
       {
        "ar": "يَعْفُ",
        "en": "was effaced"
       },
       {
        "ar": "رَسْمُهَا",
        "en": "its trace (rasm + its)"
       },
       {
        "ar": "لِمَا",
        "en": "because of what (li- + mā)"
       },
       {
        "ar": "نَسَجَتْهَا",
        "en": "wove over it (they wove + it)"
       },
       {
        "ar": "مِنْ",
        "en": "of"
       },
       {
        "ar": "جَنُوبٍ",
        "en": "south wind"
       },
       {
        "ar": "وَشَمْأَلِ",
        "en": "and north wind (wa- + shamʾal)"
       }
      ]
     },
     {
      "ar": "تَرَى بَعَرَ الْأَرْآمِ فِي عَرَصَاتِهَا وَقِيعَانِهَا كَأَنَّهُ حَبُّ فُلْفُلِ",
      "translit": "tarā baʿara al-arʾāmi fī ʿaraṣātihā wa-qīʿānihā ka-annahu ḥabbu fulfuli",
      "en": "You see the droppings of the white antelopes in its open courts and its hollows, as though they were peppercorns.",
      "ref": "bayt 3",
      "words": [
       {
        "ar": "تَرَى",
        "en": "you see"
       },
       {
        "ar": "بَعَرَ",
        "en": "the droppings of"
       },
       {
        "ar": "الْأَرْآمِ",
        "en": "the white antelopes"
       },
       {
        "ar": "فِي",
        "en": "in"
       },
       {
        "ar": "عَرَصَاتِهَا",
        "en": "its open courts (+ its)"
       },
       {
        "ar": "وَقِيعَانِهَا",
        "en": "and its hollows (wa- + qīʿān + its)"
       },
       {
        "ar": "كَأَنَّهُ",
        "en": "as though they were (ka-anna + it)"
       },
       {
        "ar": "حَبُّ",
        "en": "grains of"
       },
       {
        "ar": "فُلْفُلِ",
        "en": "pepper"
       }
      ]
     }
    ]
   },
   {
    "id": "mutanabbi",
    "title": "Celebrated Lines of al-Mutanabbī",
    "titleAr": "مِنْ شِعْرِ الْمُتَنَبِّي",
    "source": "Dīwān al-Mutanabbī",
    "kind": "poetry",
    "intro": "Four of the proudest and most quoted single verses of al-Mutanabbī (d. 354/965), the supreme master of the Abbasid ode, whose lines on resolve, fame, and ambition became proverbs of the language.",
    "lines": [
     {
      "ar": "عَلَى قَدْرِ أَهْلِ الْعَزْمِ تَأْتِي الْعَزَائِمُ وَتَأْتِي عَلَى قَدْرِ الْكِرَامِ الْمَكَارِمُ",
      "translit": "ʿalā qadri ahli al-ʿazmi taʾtī al-ʿazāʾimu wa-taʾtī ʿalā qadri al-kirāmi al-makārimu",
      "en": "According to the measure of men of resolve come the resolves, and according to the measure of the noble come the noble deeds.",
      "ref": "opening of the ode on Sayf ad-Dawla's campaign at al-Ḥadath",
      "words": [
       {
        "ar": "عَلَى",
        "en": "according to"
       },
       {
        "ar": "قَدْرِ",
        "en": "the measure of"
       },
       {
        "ar": "أَهْلِ",
        "en": "the people of"
       },
       {
        "ar": "الْعَزْمِ",
        "en": "resolve"
       },
       {
        "ar": "تَأْتِي",
        "en": "come"
       },
       {
        "ar": "الْعَزَائِمُ",
        "en": "the resolves"
       },
       {
        "ar": "وَتَأْتِي",
        "en": "and (there) come (wa- + come)"
       },
       {
        "ar": "عَلَى",
        "en": "according to"
       },
       {
        "ar": "قَدْرِ",
        "en": "the measure of"
       },
       {
        "ar": "الْكِرَامِ",
        "en": "the noble ones"
       },
       {
        "ar": "الْمَكَارِمُ",
        "en": "the noble deeds"
       }
      ]
     },
     {
      "ar": "أَنَا الَّذِي نَظَرَ الْأَعْمَى إِلَى أَدَبِي وَأَسْمَعَتْ كَلِمَاتِي مَنْ بِهِ صَمَمُ",
      "translit": "anā alladhī naẓara al-aʿmā ilā adabī wa-asmaʿat kalimātī man bihi ṣamamu",
      "en": "I am he upon whose learning the blind man has gazed, and whose words have made him hear in whom there is deafness.",
      "ref": "from the ode of reproach to Sayf ad-Dawla (wā-ḥarra qalbāhu)",
      "words": [
       {
        "ar": "أَنَا",
        "en": "I (am)"
       },
       {
        "ar": "الَّذِي",
        "en": "the one whose"
       },
       {
        "ar": "نَظَرَ",
        "en": "gazed"
       },
       {
        "ar": "الْأَعْمَى",
        "en": "the blind man"
       },
       {
        "ar": "إِلَى",
        "en": "upon"
       },
       {
        "ar": "أَدَبِي",
        "en": "my learning (adab + my)"
       },
       {
        "ar": "وَأَسْمَعَتْ",
        "en": "and made hear (wa- + made hear)"
       },
       {
        "ar": "كَلِمَاتِي",
        "en": "my words (kalimāt + my)"
       },
       {
        "ar": "مَنْ",
        "en": "him who"
       },
       {
        "ar": "بِهِ",
        "en": "in whom (bi- + him)"
       },
       {
        "ar": "صَمَمُ",
        "en": "(there is) deafness"
       }
      ]
     },
     {
      "ar": "وَإِذَا كَانَتِ النُّفُوسُ كِبَارًا تَعِبَتْ فِي مُرَادِهَا الْأَجْسَامُ",
      "translit": "wa-idhā kānati an-nufūsu kibāran taʿibat fī murādihā al-ajsāmu",
      "en": "And when souls are great, the bodies grow weary in pursuit of their desire.",
      "ref": "from the ode in praise of Badr ibn ʿAmmār",
      "words": [
       {
        "ar": "وَإِذَا",
        "en": "and when (wa- + idhā)"
       },
       {
        "ar": "كَانَتِ",
        "en": "are"
       },
       {
        "ar": "النُّفُوسُ",
        "en": "the souls"
       },
       {
        "ar": "كِبَارًا",
        "en": "great"
       },
       {
        "ar": "تَعِبَتْ",
        "en": "grow weary"
       },
       {
        "ar": "فِي",
        "en": "in (pursuit of)"
       },
       {
        "ar": "مُرَادِهَا",
        "en": "their desire (murād + their)"
       },
       {
        "ar": "الْأَجْسَامُ",
        "en": "the bodies"
       }
      ]
     },
     {
      "ar": "الْخَيْلُ وَاللَّيْلُ وَالْبَيْدَاءُ تَعْرِفُنِي وَالسَّيْفُ وَالرُّمْحُ وَالْقِرْطَاسُ وَالْقَلَمُ",
      "translit": "al-khaylu wa-al-laylu wa-al-baydāʾu taʿrifunī wa-as-sayfu wa-ar-rumḥu wa-al-qirṭāsu wa-al-qalamu",
      "en": "The horses, the night, and the desert know me — and the sword, the spear, the paper, and the pen.",
      "ref": "from the ode of reproach to Sayf ad-Dawla (wā-ḥarra qalbāhu)",
      "words": [
       {
        "ar": "الْخَيْلُ",
        "en": "the horses"
       },
       {
        "ar": "وَاللَّيْلُ",
        "en": "and the night (wa- + al-layl)"
       },
       {
        "ar": "وَالْبَيْدَاءُ",
        "en": "and the desert (wa- + al-baydāʾ)"
       },
       {
        "ar": "تَعْرِفُنِي",
        "en": "know me (know + me)"
       },
       {
        "ar": "وَالسَّيْفُ",
        "en": "and the sword (wa- + as-sayf)"
       },
       {
        "ar": "وَالرُّمْحُ",
        "en": "and the spear (wa- + ar-rumḥ)"
       },
       {
        "ar": "وَالْقِرْطَاسُ",
        "en": "and the paper (wa- + al-qirṭās)"
       },
       {
        "ar": "وَالْقَلَمُ",
        "en": "and the pen (wa- + al-qalam)"
       }
      ]
     }
    ]
   },
   {
    "id": "shafii",
    "title": "Let the Days Do as They Will",
    "titleAr": "دَعِ الْأَيَّامَ تَفْعَلُ مَا تَشَاءُ",
    "source": "Dīwān ash-Shāfiʿī (attributed)",
    "kind": "poetry",
    "intro": "The first four verses of the celebrated poem of consolation attributed to al-Imām ash-Shāfiʿī (d. 204/820); the fourth verse opens a condition that the following verse completes with the counsel to veil one's faults with generosity.",
    "lines": [
     {
      "ar": "دَعِ الْأَيَّامَ تَفْعَلُ مَا تَشَاءُ وَطِبْ نَفْسًا إِذَا حَكَمَ الْقَضَاءُ",
      "translit": "daʿi al-ayyāma tafʿalu mā tashāʾu wa-ṭib nafsan idhā ḥakama al-qaḍāʾu",
      "en": "Let the days do what they will, and be of good cheer when destiny gives its decree.",
      "ref": "bayt 1",
      "words": [
       {
        "ar": "دَعِ",
        "en": "let, leave"
       },
       {
        "ar": "الْأَيَّامَ",
        "en": "the days"
       },
       {
        "ar": "تَفْعَلُ",
        "en": "do"
       },
       {
        "ar": "مَا",
        "en": "what"
       },
       {
        "ar": "تَشَاءُ",
        "en": "they will"
       },
       {
        "ar": "وَطِبْ",
        "en": "and be content (wa- + ṭib)"
       },
       {
        "ar": "نَفْسًا",
        "en": "in soul"
       },
       {
        "ar": "إِذَا",
        "en": "when"
       },
       {
        "ar": "حَكَمَ",
        "en": "decrees"
       },
       {
        "ar": "الْقَضَاءُ",
        "en": "the (divine) decree"
       }
      ]
     },
     {
      "ar": "وَلَا تَجْزَعْ لِحَادِثَةِ اللَّيَالِي فَمَا لِحَوَادِثِ الدُّنْيَا بَقَاءُ",
      "translit": "wa-lā tajzaʿ li-ḥādithati al-layālī fa-mā li-ḥawādithi ad-dunyā baqāʾu",
      "en": "Do not despair at the calamity the nights bring, for the calamities of this world do not endure.",
      "ref": "bayt 2",
      "words": [
       {
        "ar": "وَلَا",
        "en": "and do not (wa- + lā)"
       },
       {
        "ar": "تَجْزَعْ",
        "en": "despair"
       },
       {
        "ar": "لِحَادِثَةِ",
        "en": "at the calamity of (li- + ḥāditha)"
       },
       {
        "ar": "اللَّيَالِي",
        "en": "the nights"
       },
       {
        "ar": "فَمَا",
        "en": "for there is no (fa- + mā)"
       },
       {
        "ar": "لِحَوَادِثِ",
        "en": "for the calamities of (li- + ḥawādith)"
       },
       {
        "ar": "الدُّنْيَا",
        "en": "this world"
       },
       {
        "ar": "بَقَاءُ",
        "en": "permanence"
       }
      ]
     },
     {
      "ar": "وَكُنْ رَجُلًا عَلَى الْأَهْوَالِ جَلْدًا وَشِيمَتُكَ السَّمَاحَةُ وَالْوَفَاءُ",
      "translit": "wa-kun rajulan ʿalā al-ahwāli jaldan wa-shīmatuka as-samāḥatu wa-al-wafāʾu",
      "en": "Be a man steadfast in the face of terrors, and let your nature be generosity and fidelity.",
      "ref": "bayt 3",
      "words": [
       {
        "ar": "وَكُنْ",
        "en": "and be (wa- + kun)"
       },
       {
        "ar": "رَجُلًا",
        "en": "a man"
       },
       {
        "ar": "عَلَى",
        "en": "in the face of"
       },
       {
        "ar": "الْأَهْوَالِ",
        "en": "the terrors"
       },
       {
        "ar": "جَلْدًا",
        "en": "steadfast"
       },
       {
        "ar": "وَشِيمَتُكَ",
        "en": "while your nature (wa- + shīma + your)"
       },
       {
        "ar": "السَّمَاحَةُ",
        "en": "(is) generosity"
       },
       {
        "ar": "وَالْوَفَاءُ",
        "en": "and fidelity (wa- + al-wafāʾ)"
       }
      ]
     },
     {
      "ar": "وَإِنْ كَثُرَتْ عُيُوبُكَ فِي الْبَرَايَا وَسَرَّكَ أَنْ يَكُونَ لَهَا غِطَاءُ",
      "translit": "wa-in kathurat ʿuyūbuka fī al-barāyā wa-sarraka an yakūna lahā ghiṭāʾu",
      "en": "And if your faults among created beings be many, and it would gladden you that they should have a veil —",
      "ref": "bayt 4",
      "words": [
       {
        "ar": "وَإِنْ",
        "en": "and if (wa- + in)"
       },
       {
        "ar": "كَثُرَتْ",
        "en": "are many"
       },
       {
        "ar": "عُيُوبُكَ",
        "en": "your faults (ʿuyūb + your)"
       },
       {
        "ar": "فِي",
        "en": "among"
       },
       {
        "ar": "الْبَرَايَا",
        "en": "created beings"
       },
       {
        "ar": "وَسَرَّكَ",
        "en": "and it gladden you (wa- + gladdened + you)"
       },
       {
        "ar": "أَنْ",
        "en": "that"
       },
       {
        "ar": "يَكُونَ",
        "en": "there should be"
       },
       {
        "ar": "لَهَا",
        "en": "for them (li- + them)"
       },
       {
        "ar": "غِطَاءُ",
        "en": "a covering"
       }
      ]
     }
    ]
   },
   {
    "id": "kalila",
    "title": "The Lion and the Hare",
    "titleAr": "الْأَسَدُ وَالْأَرْنَبُ",
    "source": "Kalīla wa-Dimna (Ibn al-Muqaffaʿ)",
    "kind": "prose",
    "intro": "The opening of the fable of the lion and the hare, told by Dimna in Ibn al-Muqaffaʿ's Kalīla wa-Dimna: the wild beasts of a fertile land strike a bargain with the lion who terrorizes them.",
    "lines": [
     {
      "ar": "زَعَمُوا أَنَّ أَسَدًا كَانَ فِي أَرْضٍ مُخْصِبَةٍ كَثِيرَةِ الْمِيَاهِ وَالْوُحُوشِ",
      "translit": "zaʿamū anna asadan kāna fī arḍin mukhṣibatin kathīrati al-miyāhi wa-al-wuḥūshi",
      "en": "They relate that a lion dwelt in a fertile land abounding in waters and wild beasts.",
      "ref": "The Lion and the Hare, line 1",
      "words": [
       {
        "ar": "زَعَمُوا",
        "en": "they relate"
       },
       {
        "ar": "أَنَّ",
        "en": "that"
       },
       {
        "ar": "أَسَدًا",
        "en": "a lion"
       },
       {
        "ar": "كَانَ",
        "en": "was"
       },
       {
        "ar": "فِي",
        "en": "in"
       },
       {
        "ar": "أَرْضٍ",
        "en": "a land"
       },
       {
        "ar": "مُخْصِبَةٍ",
        "en": "fertile"
       },
       {
        "ar": "كَثِيرَةِ",
        "en": "abounding in"
       },
       {
        "ar": "الْمِيَاهِ",
        "en": "the waters"
       },
       {
        "ar": "وَالْوُحُوشِ",
        "en": "and the wild beasts (wa- + al-wuḥūsh)"
       }
      ]
     },
     {
      "ar": "وَكَانَتِ الْوُحُوشُ لَا تَنْتَفِعُ بِمَا هِيَ فِيهِ مِنْ خِصْبٍ لِخَوْفِهَا مِنَ الْأَسَدِ",
      "translit": "wa-kānati al-wuḥūshu lā tantafiʿu bi-mā hiya fīhi min khiṣbin li-khawfihā mina al-asadi",
      "en": "Yet the beasts had no profit of the plenty they lived in, for their fear of the lion.",
      "ref": "The Lion and the Hare, line 2",
      "words": [
       {
        "ar": "وَكَانَتِ",
        "en": "and were (wa- + kānat)"
       },
       {
        "ar": "الْوُحُوشُ",
        "en": "the wild beasts"
       },
       {
        "ar": "لَا",
        "en": "not"
       },
       {
        "ar": "تَنْتَفِعُ",
        "en": "profiting"
       },
       {
        "ar": "بِمَا",
        "en": "by what (bi- + mā)"
       },
       {
        "ar": "هِيَ",
        "en": "they"
       },
       {
        "ar": "فِيهِ",
        "en": "were in (fī + it)"
       },
       {
        "ar": "مِنْ",
        "en": "of"
       },
       {
        "ar": "خِصْبٍ",
        "en": "abundance"
       },
       {
        "ar": "لِخَوْفِهَا",
        "en": "because of their fear (li- + khawf + their)"
       },
       {
        "ar": "مِنَ",
        "en": "of"
       },
       {
        "ar": "الْأَسَدِ",
        "en": "the lion"
       }
      ]
     },
     {
      "ar": "فَاجْتَمَعَتْ وَأَتَتِ الْأَسَدَ فَقَالَتْ لَهُ إِنَّكَ لَا تُصِيبُ مِنَّا الدَّابَّةَ إِلَّا بَعْدَ تَعَبٍ وَمَشَقَّةٍ",
      "translit": "fa-ijtamaʿat wa-atati al-asada fa-qālat lahu innaka lā tuṣību minnā ad-dābbata illā baʿda taʿabin wa-mashaqqatin",
      "en": "So they gathered together and came to the lion and said to him, 'You take no beast of ours save after toil and hardship.'",
      "ref": "The Lion and the Hare, line 3",
      "words": [
       {
        "ar": "فَاجْتَمَعَتْ",
        "en": "so they gathered (fa- + gathered)"
       },
       {
        "ar": "وَأَتَتِ",
        "en": "and came to (wa- + came)"
       },
       {
        "ar": "الْأَسَدَ",
        "en": "the lion"
       },
       {
        "ar": "فَقَالَتْ",
        "en": "and said (fa- + said)"
       },
       {
        "ar": "لَهُ",
        "en": "to him (li- + him)"
       },
       {
        "ar": "إِنَّكَ",
        "en": "verily you (inna + you)"
       },
       {
        "ar": "لَا",
        "en": "not"
       },
       {
        "ar": "تُصِيبُ",
        "en": "seize"
       },
       {
        "ar": "مِنَّا",
        "en": "from us (min + us)"
       },
       {
        "ar": "الدَّابَّةَ",
        "en": "the beast"
       },
       {
        "ar": "إِلَّا",
        "en": "except"
       },
       {
        "ar": "بَعْدَ",
        "en": "after"
       },
       {
        "ar": "تَعَبٍ",
        "en": "toil"
       },
       {
        "ar": "وَمَشَقَّةٍ",
        "en": "and hardship (wa- + mashaqqa)"
       }
      ]
     },
     {
      "ar": "وَنَحْنُ لَكَ عَلَى خَوْفٍ وَأَنْتَ مِنَّا فِي عَنَاءٍ",
      "translit": "wa-naḥnu laka ʿalā khawfin wa-anta minnā fī ʿanāʾin",
      "en": "'We live in fear of you, and you in weariness because of us.'",
      "ref": "The Lion and the Hare, line 4",
      "words": [
       {
        "ar": "وَنَحْنُ",
        "en": "and we (wa- + we)"
       },
       {
        "ar": "لَكَ",
        "en": "because of you (li- + you)"
       },
       {
        "ar": "عَلَى",
        "en": "are in (lit. upon)"
       },
       {
        "ar": "خَوْفٍ",
        "en": "fear"
       },
       {
        "ar": "وَأَنْتَ",
        "en": "and you (wa- + you)"
       },
       {
        "ar": "مِنَّا",
        "en": "because of us (min + us)"
       },
       {
        "ar": "فِي",
        "en": "are in"
       },
       {
        "ar": "عَنَاءٍ",
        "en": "weariness"
       }
      ]
     },
     {
      "ar": "فَإِنْ جَعَلْتَ لَنَا أَمَانًا جَعَلْنَا لَكَ فِي كُلِّ يَوْمٍ دَابَّةً نُرْسِلُ بِهَا إِلَيْكَ عِنْدَ غَدَائِكَ",
      "translit": "fa-in jaʿalta lanā amānan jaʿalnā laka fī kulli yawmin dābbatan nursilu bihā ilayka ʿinda ghadāʾika",
      "en": "'If you grant us a pledge of safety, we shall appoint for you each day a beast that we send to you at your midday meal.'",
      "ref": "The Lion and the Hare, line 5",
      "words": [
       {
        "ar": "فَإِنْ",
        "en": "so if (fa- + in)"
       },
       {
        "ar": "جَعَلْتَ",
        "en": "you grant (lit. make)"
       },
       {
        "ar": "لَنَا",
        "en": "for us (li- + us)"
       },
       {
        "ar": "أَمَانًا",
        "en": "a pledge of safety"
       },
       {
        "ar": "جَعَلْنَا",
        "en": "we shall appoint"
       },
       {
        "ar": "لَكَ",
        "en": "for you (li- + you)"
       },
       {
        "ar": "فِي",
        "en": "on"
       },
       {
        "ar": "كُلِّ",
        "en": "every"
       },
       {
        "ar": "يَوْمٍ",
        "en": "day"
       },
       {
        "ar": "دَابَّةً",
        "en": "a beast"
       },
       {
        "ar": "نُرْسِلُ",
        "en": "we send"
       },
       {
        "ar": "بِهَا",
        "en": "it along (bi- + it)"
       },
       {
        "ar": "إِلَيْكَ",
        "en": "to you (ilā + you)"
       },
       {
        "ar": "عِنْدَ",
        "en": "at (the time of)"
       },
       {
        "ar": "غَدَائِكَ",
        "en": "your midday meal (ghadāʾ + your)"
       }
      ]
     },
     {
      "ar": "فَرَضِيَ الْأَسَدُ بِذَلِكَ",
      "translit": "fa-raḍiya al-asadu bi-dhālika",
      "en": "And the lion was content with that.",
      "ref": "The Lion and the Hare, line 6",
      "words": [
       {
        "ar": "فَرَضِيَ",
        "en": "and was content (fa- + was pleased)"
       },
       {
        "ar": "الْأَسَدُ",
        "en": "the lion"
       },
       {
        "ar": "بِذَلِكَ",
        "en": "with that (bi- + that)"
       }
      ]
     }
    ]
   }
  ];

  var WEAK = /*@DATA:WEAK*/[
   {
    "id": "hollow-waw",
    "name": "The Hollow Verb (wāw)",
    "nameAr": "الْأَجْوَف الْوَاوِيّ",
    "desc": "The middle radical is wāw: it surfaces as ā in the past (qāla) and as long ū in the present (yaqūlu) as long as the stem syllable stays open. Because Classical Arabic forbids a long vowel in a closed syllable, the stem shortens whenever a consonant-initial suffix closes it: in the past to u — the trace of the wāw — giving qultu, qulnā, qulna, and in the present before -na, giving taqulna, yaqulna. The imperative is built on this short stem, so the masculine singular is قُلْ qul, while vowel-initial endings restore the length: قُولِي qūlī, قُولُوا qūlū.",
    "model": {
     "ar": "قَالَ / يَقُولُ",
     "translit": "qāla / yaqūlu",
     "en": "to say"
    },
    "paradigm": [
     {
      "pronoun": "أَنَا",
      "pronounTranslit": "anā",
      "en": "I",
      "past": "قُلْتُ",
      "pastTranslit": "qultu",
      "present": "أَقُولُ",
      "presentTranslit": "aqūlu"
     },
     {
      "pronoun": "نَحْنُ",
      "pronounTranslit": "naḥnu",
      "en": "we",
      "past": "قُلْنَا",
      "pastTranslit": "qulnā",
      "present": "نَقُولُ",
      "presentTranslit": "naqūlu"
     },
     {
      "pronoun": "أَنْتَ",
      "pronounTranslit": "anta",
      "en": "you (m)",
      "past": "قُلْتَ",
      "pastTranslit": "qulta",
      "present": "تَقُولُ",
      "presentTranslit": "taqūlu"
     },
     {
      "pronoun": "أَنْتِ",
      "pronounTranslit": "anti",
      "en": "you (f)",
      "past": "قُلْتِ",
      "pastTranslit": "qulti",
      "present": "تَقُولِينَ",
      "presentTranslit": "taqūlīna"
     },
     {
      "pronoun": "أَنْتُمَا",
      "pronounTranslit": "antumā",
      "en": "you two",
      "past": "قُلْتُمَا",
      "pastTranslit": "qultumā",
      "present": "تَقُولَانِ",
      "presentTranslit": "taqūlāni"
     },
     {
      "pronoun": "أَنْتُمْ",
      "pronounTranslit": "antum",
      "en": "you (m pl)",
      "past": "قُلْتُمْ",
      "pastTranslit": "qultum",
      "present": "تَقُولُونَ",
      "presentTranslit": "taqūlūna"
     },
     {
      "pronoun": "أَنْتُنَّ",
      "pronounTranslit": "antunna",
      "en": "you (f pl)",
      "past": "قُلْتُنَّ",
      "pastTranslit": "qultunna",
      "present": "تَقُلْنَ",
      "presentTranslit": "taqulna"
     },
     {
      "pronoun": "هُوَ",
      "pronounTranslit": "huwa",
      "en": "he",
      "past": "قَالَ",
      "pastTranslit": "qāla",
      "present": "يَقُولُ",
      "presentTranslit": "yaqūlu"
     },
     {
      "pronoun": "هِيَ",
      "pronounTranslit": "hiya",
      "en": "she",
      "past": "قَالَتْ",
      "pastTranslit": "qālat",
      "present": "تَقُولُ",
      "presentTranslit": "taqūlu"
     },
     {
      "pronoun": "هُمَا",
      "pronounTranslit": "humā",
      "en": "they two (m)",
      "past": "قَالَا",
      "pastTranslit": "qālā",
      "present": "يَقُولَانِ",
      "presentTranslit": "yaqūlāni"
     },
     {
      "pronoun": "هُمَا",
      "pronounTranslit": "humā",
      "en": "they two (f)",
      "past": "قَالَتَا",
      "pastTranslit": "qālatā",
      "present": "تَقُولَانِ",
      "presentTranslit": "taqūlāni"
     },
     {
      "pronoun": "هُمْ",
      "pronounTranslit": "hum",
      "en": "they (m)",
      "past": "قَالُوا",
      "pastTranslit": "qālū",
      "present": "يَقُولُونَ",
      "presentTranslit": "yaqūlūna"
     },
     {
      "pronoun": "هُنَّ",
      "pronounTranslit": "hunna",
      "en": "they (f)",
      "past": "قُلْنَ",
      "pastTranslit": "qulna",
      "present": "يَقُلْنَ",
      "presentTranslit": "yaqulna"
     }
    ]
   },
   {
    "id": "hollow-ya",
    "name": "The Hollow Verb (yāʾ)",
    "nameAr": "الْأَجْوَف الْيَائِيّ",
    "desc": "Here the middle radical is yāʾ: it lengthens to ā in the past (bāʿa) and to ī in the open-syllable present (yabīʿu). Before a consonant-initial suffix the long vowel cannot stand in the now-closed syllable, so the stem shortens to i — the trace of the yāʾ — giving biʿtu, biʿnā, biʿna in the past and tabiʿna, yabiʿna in the present. The imperative masculine singular is therefore بِعْ biʿ, with the length restored before vowel-initial endings: بِيعِي bīʿī, بِيعُوا bīʿū.",
    "model": {
     "ar": "بَاعَ / يَبِيعُ",
     "translit": "bāʿa / yabīʿu",
     "en": "to sell"
    },
    "paradigm": [
     {
      "pronoun": "أَنَا",
      "pronounTranslit": "anā",
      "en": "I",
      "past": "بِعْتُ",
      "pastTranslit": "biʿtu",
      "present": "أَبِيعُ",
      "presentTranslit": "abīʿu"
     },
     {
      "pronoun": "نَحْنُ",
      "pronounTranslit": "naḥnu",
      "en": "we",
      "past": "بِعْنَا",
      "pastTranslit": "biʿnā",
      "present": "نَبِيعُ",
      "presentTranslit": "nabīʿu"
     },
     {
      "pronoun": "أَنْتَ",
      "pronounTranslit": "anta",
      "en": "you (m)",
      "past": "بِعْتَ",
      "pastTranslit": "biʿta",
      "present": "تَبِيعُ",
      "presentTranslit": "tabīʿu"
     },
     {
      "pronoun": "أَنْتِ",
      "pronounTranslit": "anti",
      "en": "you (f)",
      "past": "بِعْتِ",
      "pastTranslit": "biʿti",
      "present": "تَبِيعِينَ",
      "presentTranslit": "tabīʿīna"
     },
     {
      "pronoun": "أَنْتُمَا",
      "pronounTranslit": "antumā",
      "en": "you two",
      "past": "بِعْتُمَا",
      "pastTranslit": "biʿtumā",
      "present": "تَبِيعَانِ",
      "presentTranslit": "tabīʿāni"
     },
     {
      "pronoun": "أَنْتُمْ",
      "pronounTranslit": "antum",
      "en": "you (m pl)",
      "past": "بِعْتُمْ",
      "pastTranslit": "biʿtum",
      "present": "تَبِيعُونَ",
      "presentTranslit": "tabīʿūna"
     },
     {
      "pronoun": "أَنْتُنَّ",
      "pronounTranslit": "antunna",
      "en": "you (f pl)",
      "past": "بِعْتُنَّ",
      "pastTranslit": "biʿtunna",
      "present": "تَبِعْنَ",
      "presentTranslit": "tabiʿna"
     },
     {
      "pronoun": "هُوَ",
      "pronounTranslit": "huwa",
      "en": "he",
      "past": "بَاعَ",
      "pastTranslit": "bāʿa",
      "present": "يَبِيعُ",
      "presentTranslit": "yabīʿu"
     },
     {
      "pronoun": "هِيَ",
      "pronounTranslit": "hiya",
      "en": "she",
      "past": "بَاعَتْ",
      "pastTranslit": "bāʿat",
      "present": "تَبِيعُ",
      "presentTranslit": "tabīʿu"
     },
     {
      "pronoun": "هُمَا",
      "pronounTranslit": "humā",
      "en": "they two (m)",
      "past": "بَاعَا",
      "pastTranslit": "bāʿā",
      "present": "يَبِيعَانِ",
      "presentTranslit": "yabīʿāni"
     },
     {
      "pronoun": "هُمَا",
      "pronounTranslit": "humā",
      "en": "they two (f)",
      "past": "بَاعَتَا",
      "pastTranslit": "bāʿatā",
      "present": "تَبِيعَانِ",
      "presentTranslit": "tabīʿāni"
     },
     {
      "pronoun": "هُمْ",
      "pronounTranslit": "hum",
      "en": "they (m)",
      "past": "بَاعُوا",
      "pastTranslit": "bāʿū",
      "present": "يَبِيعُونَ",
      "presentTranslit": "yabīʿūna"
     },
     {
      "pronoun": "هُنَّ",
      "pronounTranslit": "hunna",
      "en": "they (f)",
      "past": "بِعْنَ",
      "pastTranslit": "biʿna",
      "present": "يَبِعْنَ",
      "presentTranslit": "yabiʿna"
     }
    ]
   },
   {
    "id": "hollow-a",
    "name": "The Hollow Verb (a-imperfect)",
    "nameAr": "الْأَجْوَف عَلَى وَزْنِ فَعِلَ يَفْعَلُ",
    "desc": "This class follows the pattern faʿila / yafʿalu, so the present keeps ā (yakhāfu) even though the root is خ-و-ف with a wāw. When a consonant-initial suffix closes the stem syllable, the past shortens to i — reflecting the underlying stem vowel of khawifa — giving khiftu, khifnā, khifna, while the present ā shortens to a: takhafna, yakhafna. The imperative masculine singular is accordingly خَفْ khaf, and the length returns before vowel-initial endings: خَافِي khāfī, خَافُوا khāfū.",
    "model": {
     "ar": "خَافَ / يَخَافُ",
     "translit": "khāfa / yakhāfu",
     "en": "to fear"
    },
    "paradigm": [
     {
      "pronoun": "أَنَا",
      "pronounTranslit": "anā",
      "en": "I",
      "past": "خِفْتُ",
      "pastTranslit": "khiftu",
      "present": "أَخَافُ",
      "presentTranslit": "akhāfu"
     },
     {
      "pronoun": "نَحْنُ",
      "pronounTranslit": "naḥnu",
      "en": "we",
      "past": "خِفْنَا",
      "pastTranslit": "khifnā",
      "present": "نَخَافُ",
      "presentTranslit": "nakhāfu"
     },
     {
      "pronoun": "أَنْتَ",
      "pronounTranslit": "anta",
      "en": "you (m)",
      "past": "خِفْتَ",
      "pastTranslit": "khifta",
      "present": "تَخَافُ",
      "presentTranslit": "takhāfu"
     },
     {
      "pronoun": "أَنْتِ",
      "pronounTranslit": "anti",
      "en": "you (f)",
      "past": "خِفْتِ",
      "pastTranslit": "khifti",
      "present": "تَخَافِينَ",
      "presentTranslit": "takhāfīna"
     },
     {
      "pronoun": "أَنْتُمَا",
      "pronounTranslit": "antumā",
      "en": "you two",
      "past": "خِفْتُمَا",
      "pastTranslit": "khiftumā",
      "present": "تَخَافَانِ",
      "presentTranslit": "takhāfāni"
     },
     {
      "pronoun": "أَنْتُمْ",
      "pronounTranslit": "antum",
      "en": "you (m pl)",
      "past": "خِفْتُمْ",
      "pastTranslit": "khiftum",
      "present": "تَخَافُونَ",
      "presentTranslit": "takhāfūna"
     },
     {
      "pronoun": "أَنْتُنَّ",
      "pronounTranslit": "antunna",
      "en": "you (f pl)",
      "past": "خِفْتُنَّ",
      "pastTranslit": "khiftunna",
      "present": "تَخَفْنَ",
      "presentTranslit": "takhafna"
     },
     {
      "pronoun": "هُوَ",
      "pronounTranslit": "huwa",
      "en": "he",
      "past": "خَافَ",
      "pastTranslit": "khāfa",
      "present": "يَخَافُ",
      "presentTranslit": "yakhāfu"
     },
     {
      "pronoun": "هِيَ",
      "pronounTranslit": "hiya",
      "en": "she",
      "past": "خَافَتْ",
      "pastTranslit": "khāfat",
      "present": "تَخَافُ",
      "presentTranslit": "takhāfu"
     },
     {
      "pronoun": "هُمَا",
      "pronounTranslit": "humā",
      "en": "they two (m)",
      "past": "خَافَا",
      "pastTranslit": "khāfā",
      "present": "يَخَافَانِ",
      "presentTranslit": "yakhāfāni"
     },
     {
      "pronoun": "هُمَا",
      "pronounTranslit": "humā",
      "en": "they two (f)",
      "past": "خَافَتَا",
      "pastTranslit": "khāfatā",
      "present": "تَخَافَانِ",
      "presentTranslit": "takhāfāni"
     },
     {
      "pronoun": "هُمْ",
      "pronounTranslit": "hum",
      "en": "they (m)",
      "past": "خَافُوا",
      "pastTranslit": "khāfū",
      "present": "يَخَافُونَ",
      "presentTranslit": "yakhāfūna"
     },
     {
      "pronoun": "هُنَّ",
      "pronounTranslit": "hunna",
      "en": "they (f)",
      "past": "خِفْنَ",
      "pastTranslit": "khifna",
      "present": "يَخَفْنَ",
      "presentTranslit": "yakhafna"
     }
    ]
   },
   {
    "id": "doubled",
    "name": "The Doubled Verb",
    "nameAr": "الْمُضَعَّف",
    "desc": "In the doubled verb the second and third radicals are identical and fuse into a single geminate whenever a vowel follows the third radical: madda, maddat, yamuddu, maddū. Before a consonant-initial suffix no vowel follows, and a geminate cannot be sustained at the end of a closed syllable, so the two radicals break apart with a full vowel between them: madadtu, madadnā, madadna, and in the present tamdudna, yamdudna. The imperative shows both treatments: contracted مُدَّ mudda (also مُدِّ muddi) or the broken-open اُمْدُدْ umdud.",
    "model": {
     "ar": "مَدَّ / يَمُدُّ",
     "translit": "madda / yamuddu",
     "en": "to extend"
    },
    "paradigm": [
     {
      "pronoun": "أَنَا",
      "pronounTranslit": "anā",
      "en": "I",
      "past": "مَدَدْتُ",
      "pastTranslit": "madadtu",
      "present": "أَمُدُّ",
      "presentTranslit": "amuddu"
     },
     {
      "pronoun": "نَحْنُ",
      "pronounTranslit": "naḥnu",
      "en": "we",
      "past": "مَدَدْنَا",
      "pastTranslit": "madadnā",
      "present": "نَمُدُّ",
      "presentTranslit": "namuddu"
     },
     {
      "pronoun": "أَنْتَ",
      "pronounTranslit": "anta",
      "en": "you (m)",
      "past": "مَدَدْتَ",
      "pastTranslit": "madadta",
      "present": "تَمُدُّ",
      "presentTranslit": "tamuddu"
     },
     {
      "pronoun": "أَنْتِ",
      "pronounTranslit": "anti",
      "en": "you (f)",
      "past": "مَدَدْتِ",
      "pastTranslit": "madadti",
      "present": "تَمُدِّينَ",
      "presentTranslit": "tamuddīna"
     },
     {
      "pronoun": "أَنْتُمَا",
      "pronounTranslit": "antumā",
      "en": "you two",
      "past": "مَدَدْتُمَا",
      "pastTranslit": "madadtumā",
      "present": "تَمُدَّانِ",
      "presentTranslit": "tamuddāni"
     },
     {
      "pronoun": "أَنْتُمْ",
      "pronounTranslit": "antum",
      "en": "you (m pl)",
      "past": "مَدَدْتُمْ",
      "pastTranslit": "madadtum",
      "present": "تَمُدُّونَ",
      "presentTranslit": "tamuddūna"
     },
     {
      "pronoun": "أَنْتُنَّ",
      "pronounTranslit": "antunna",
      "en": "you (f pl)",
      "past": "مَدَدْتُنَّ",
      "pastTranslit": "madadtunna",
      "present": "تَمْدُدْنَ",
      "presentTranslit": "tamdudna"
     },
     {
      "pronoun": "هُوَ",
      "pronounTranslit": "huwa",
      "en": "he",
      "past": "مَدَّ",
      "pastTranslit": "madda",
      "present": "يَمُدُّ",
      "presentTranslit": "yamuddu"
     },
     {
      "pronoun": "هِيَ",
      "pronounTranslit": "hiya",
      "en": "she",
      "past": "مَدَّتْ",
      "pastTranslit": "maddat",
      "present": "تَمُدُّ",
      "presentTranslit": "tamuddu"
     },
     {
      "pronoun": "هُمَا",
      "pronounTranslit": "humā",
      "en": "they two (m)",
      "past": "مَدَّا",
      "pastTranslit": "maddā",
      "present": "يَمُدَّانِ",
      "presentTranslit": "yamuddāni"
     },
     {
      "pronoun": "هُمَا",
      "pronounTranslit": "humā",
      "en": "they two (f)",
      "past": "مَدَّتَا",
      "pastTranslit": "maddatā",
      "present": "تَمُدَّانِ",
      "presentTranslit": "tamuddāni"
     },
     {
      "pronoun": "هُمْ",
      "pronounTranslit": "hum",
      "en": "they (m)",
      "past": "مَدُّوا",
      "pastTranslit": "maddū",
      "present": "يَمُدُّونَ",
      "presentTranslit": "yamuddūna"
     },
     {
      "pronoun": "هُنَّ",
      "pronounTranslit": "hunna",
      "en": "they (f)",
      "past": "مَدَدْنَ",
      "pastTranslit": "madadna",
      "present": "يَمْدُدْنَ",
      "presentTranslit": "yamdudna"
     }
    ]
   },
   {
    "id": "assimilated",
    "name": "The Assimilated Verb (wāw)",
    "nameAr": "الْمِثَال",
    "desc": "The assimilated verb (al-mithāl) has wāw as its first radical. Its past tense conjugates exactly like a sound verb (waṣaltu, waṣalnā), but in the i-imperfect of Form I the wāw drops throughout the present: yaṣilu, never yawṣilu. The imperative is likewise reduced to the last two radicals: صِلْ ṣil.",
    "model": {
     "ar": "وَصَلَ / يَصِلُ",
     "translit": "waṣala / yaṣilu",
     "en": "to arrive"
    },
    "paradigm": [
     {
      "pronoun": "أَنَا",
      "pronounTranslit": "anā",
      "en": "I arrived / I arrive",
      "past": "وَصَلْتُ",
      "pastTranslit": "waṣaltu",
      "present": "أَصِلُ",
      "presentTranslit": "aṣilu"
     },
     {
      "pronoun": "نَحْنُ",
      "pronounTranslit": "naḥnu",
      "en": "we arrived / we arrive",
      "past": "وَصَلْنَا",
      "pastTranslit": "waṣalnā",
      "present": "نَصِلُ",
      "presentTranslit": "naṣilu"
     },
     {
      "pronoun": "أَنْتَ",
      "pronounTranslit": "anta",
      "en": "you (m sg) arrived / you arrive",
      "past": "وَصَلْتَ",
      "pastTranslit": "waṣalta",
      "present": "تَصِلُ",
      "presentTranslit": "taṣilu"
     },
     {
      "pronoun": "أَنْتِ",
      "pronounTranslit": "anti",
      "en": "you (f sg) arrived / you arrive",
      "past": "وَصَلْتِ",
      "pastTranslit": "waṣalti",
      "present": "تَصِلِينَ",
      "presentTranslit": "taṣilīna"
     },
     {
      "pronoun": "أَنْتُمَا",
      "pronounTranslit": "antumā",
      "en": "you two arrived / you arrive",
      "past": "وَصَلْتُمَا",
      "pastTranslit": "waṣaltumā",
      "present": "تَصِلَانِ",
      "presentTranslit": "taṣilāni"
     },
     {
      "pronoun": "أَنْتُمْ",
      "pronounTranslit": "antum",
      "en": "you (m pl) arrived / you arrive",
      "past": "وَصَلْتُمْ",
      "pastTranslit": "waṣaltum",
      "present": "تَصِلُونَ",
      "presentTranslit": "taṣilūna"
     },
     {
      "pronoun": "أَنْتُنَّ",
      "pronounTranslit": "antunna",
      "en": "you (f pl) arrived / you arrive",
      "past": "وَصَلْتُنَّ",
      "pastTranslit": "waṣaltunna",
      "present": "تَصِلْنَ",
      "presentTranslit": "taṣilna"
     },
     {
      "pronoun": "هُوَ",
      "pronounTranslit": "huwa",
      "en": "he arrived / he arrives",
      "past": "وَصَلَ",
      "pastTranslit": "waṣala",
      "present": "يَصِلُ",
      "presentTranslit": "yaṣilu"
     },
     {
      "pronoun": "هِيَ",
      "pronounTranslit": "hiya",
      "en": "she arrived / she arrives",
      "past": "وَصَلَتْ",
      "pastTranslit": "waṣalat",
      "present": "تَصِلُ",
      "presentTranslit": "taṣilu"
     },
     {
      "pronoun": "هُمَا",
      "pronounTranslit": "humā",
      "en": "they two (m) arrived / they arrive",
      "past": "وَصَلَا",
      "pastTranslit": "waṣalā",
      "present": "يَصِلَانِ",
      "presentTranslit": "yaṣilāni"
     },
     {
      "pronoun": "هُمَا",
      "pronounTranslit": "humā",
      "en": "they two (f) arrived / they arrive",
      "past": "وَصَلَتَا",
      "pastTranslit": "waṣalatā",
      "present": "تَصِلَانِ",
      "presentTranslit": "taṣilāni"
     },
     {
      "pronoun": "هُمْ",
      "pronounTranslit": "hum",
      "en": "they (m) arrived / they arrive",
      "past": "وَصَلُوا",
      "pastTranslit": "waṣalū",
      "present": "يَصِلُونَ",
      "presentTranslit": "yaṣilūna"
     },
     {
      "pronoun": "هُنَّ",
      "pronounTranslit": "hunna",
      "en": "they (f) arrived / they arrive",
      "past": "وَصَلْنَ",
      "pastTranslit": "waṣalna",
      "present": "يَصِلْنَ",
      "presentTranslit": "yaṣilna"
     }
    ]
   },
   {
    "id": "defective-u",
    "name": "The Defective Verb (wāw)",
    "nameAr": "النَّاقِص الْوَاوِيّ",
    "desc": "In the final-wāw defective verb the third radical surfaces as alif in daʿā but returns as the diphthong -aw before consonant-initial suffixes: daʿawtu, daʿawnā; in the third masculine plural the alif is elided before wāw al-jamāʿa, giving daʿaw. Before the tāʾ of the 3rd person feminine the long vowel contracts away entirely: daʿat, daʿatā. In the present the stem-final -ū fuses with the masculine plural ending (yadʿūna) but yields to -īna in the 2nd feminine singular: tadʿīna.",
    "model": {
     "ar": "دَعَا / يَدْعُو",
     "translit": "daʿā / yadʿū",
     "en": "to call"
    },
    "paradigm": [
     {
      "pronoun": "أَنَا",
      "pronounTranslit": "anā",
      "en": "I called / I call",
      "past": "دَعَوْتُ",
      "pastTranslit": "daʿawtu",
      "present": "أَدْعُو",
      "presentTranslit": "adʿū"
     },
     {
      "pronoun": "نَحْنُ",
      "pronounTranslit": "naḥnu",
      "en": "we called / we call",
      "past": "دَعَوْنَا",
      "pastTranslit": "daʿawnā",
      "present": "نَدْعُو",
      "presentTranslit": "nadʿū"
     },
     {
      "pronoun": "أَنْتَ",
      "pronounTranslit": "anta",
      "en": "you (m sg) called / you call",
      "past": "دَعَوْتَ",
      "pastTranslit": "daʿawta",
      "present": "تَدْعُو",
      "presentTranslit": "tadʿū"
     },
     {
      "pronoun": "أَنْتِ",
      "pronounTranslit": "anti",
      "en": "you (f sg) called / you call",
      "past": "دَعَوْتِ",
      "pastTranslit": "daʿawti",
      "present": "تَدْعِينَ",
      "presentTranslit": "tadʿīna"
     },
     {
      "pronoun": "أَنْتُمَا",
      "pronounTranslit": "antumā",
      "en": "you two called / you call",
      "past": "دَعَوْتُمَا",
      "pastTranslit": "daʿawtumā",
      "present": "تَدْعُوَانِ",
      "presentTranslit": "tadʿuwāni"
     },
     {
      "pronoun": "أَنْتُمْ",
      "pronounTranslit": "antum",
      "en": "you (m pl) called / you call",
      "past": "دَعَوْتُمْ",
      "pastTranslit": "daʿawtum",
      "present": "تَدْعُونَ",
      "presentTranslit": "tadʿūna"
     },
     {
      "pronoun": "أَنْتُنَّ",
      "pronounTranslit": "antunna",
      "en": "you (f pl) called / you call",
      "past": "دَعَوْتُنَّ",
      "pastTranslit": "daʿawtunna",
      "present": "تَدْعُونَ",
      "presentTranslit": "tadʿūna"
     },
     {
      "pronoun": "هُوَ",
      "pronounTranslit": "huwa",
      "en": "he called / he calls",
      "past": "دَعَا",
      "pastTranslit": "daʿā",
      "present": "يَدْعُو",
      "presentTranslit": "yadʿū"
     },
     {
      "pronoun": "هِيَ",
      "pronounTranslit": "hiya",
      "en": "she called / she calls",
      "past": "دَعَتْ",
      "pastTranslit": "daʿat",
      "present": "تَدْعُو",
      "presentTranslit": "tadʿū"
     },
     {
      "pronoun": "هُمَا",
      "pronounTranslit": "humā",
      "en": "they two (m) called / they call",
      "past": "دَعَوَا",
      "pastTranslit": "daʿawā",
      "present": "يَدْعُوَانِ",
      "presentTranslit": "yadʿuwāni"
     },
     {
      "pronoun": "هُمَا",
      "pronounTranslit": "humā",
      "en": "they two (f) called / they call",
      "past": "دَعَتَا",
      "pastTranslit": "daʿatā",
      "present": "تَدْعُوَانِ",
      "presentTranslit": "tadʿuwāni"
     },
     {
      "pronoun": "هُمْ",
      "pronounTranslit": "hum",
      "en": "they (m) called / they call",
      "past": "دَعَوْا",
      "pastTranslit": "daʿaw",
      "present": "يَدْعُونَ",
      "presentTranslit": "yadʿūna"
     },
     {
      "pronoun": "هُنَّ",
      "pronounTranslit": "hunna",
      "en": "they (f) called / they call",
      "past": "دَعَوْنَ",
      "pastTranslit": "daʿawna",
      "present": "يَدْعُونَ",
      "presentTranslit": "yadʿūna"
     }
    ]
   },
   {
    "id": "defective-i",
    "name": "The Defective Verb (yāʾ)",
    "nameAr": "النَّاقِص الْيَائِيّ",
    "desc": "The final-yāʾ defective verb ends in alif maqṣūra in the bare past (ramā), while the yāʾ reappears before consonant-initial suffixes: ramaytu, ramaynā. The 3rd feminine contracts (ramat, ramatā) and the 3rd masculine plural collapses to the diphthong -aw: ramaw. In the present the stem-final -ī of yarmī drops before the vowel-initial endings: yarmūna, tarmīna.",
    "model": {
     "ar": "رَمَى / يَرْمِي",
     "translit": "ramā / yarmī",
     "en": "to throw"
    },
    "paradigm": [
     {
      "pronoun": "أَنَا",
      "pronounTranslit": "anā",
      "en": "I threw / I throw",
      "past": "رَمَيْتُ",
      "pastTranslit": "ramaytu",
      "present": "أَرْمِي",
      "presentTranslit": "armī"
     },
     {
      "pronoun": "نَحْنُ",
      "pronounTranslit": "naḥnu",
      "en": "we threw / we throw",
      "past": "رَمَيْنَا",
      "pastTranslit": "ramaynā",
      "present": "نَرْمِي",
      "presentTranslit": "narmī"
     },
     {
      "pronoun": "أَنْتَ",
      "pronounTranslit": "anta",
      "en": "you (m sg) threw / you throw",
      "past": "رَمَيْتَ",
      "pastTranslit": "ramayta",
      "present": "تَرْمِي",
      "presentTranslit": "tarmī"
     },
     {
      "pronoun": "أَنْتِ",
      "pronounTranslit": "anti",
      "en": "you (f sg) threw / you throw",
      "past": "رَمَيْتِ",
      "pastTranslit": "ramayti",
      "present": "تَرْمِينَ",
      "presentTranslit": "tarmīna"
     },
     {
      "pronoun": "أَنْتُمَا",
      "pronounTranslit": "antumā",
      "en": "you two threw / you throw",
      "past": "رَمَيْتُمَا",
      "pastTranslit": "ramaytumā",
      "present": "تَرْمِيَانِ",
      "presentTranslit": "tarmiyāni"
     },
     {
      "pronoun": "أَنْتُمْ",
      "pronounTranslit": "antum",
      "en": "you (m pl) threw / you throw",
      "past": "رَمَيْتُمْ",
      "pastTranslit": "ramaytum",
      "present": "تَرْمُونَ",
      "presentTranslit": "tarmūna"
     },
     {
      "pronoun": "أَنْتُنَّ",
      "pronounTranslit": "antunna",
      "en": "you (f pl) threw / you throw",
      "past": "رَمَيْتُنَّ",
      "pastTranslit": "ramaytunna",
      "present": "تَرْمِينَ",
      "presentTranslit": "tarmīna"
     },
     {
      "pronoun": "هُوَ",
      "pronounTranslit": "huwa",
      "en": "he threw / he throws",
      "past": "رَمَى",
      "pastTranslit": "ramā",
      "present": "يَرْمِي",
      "presentTranslit": "yarmī"
     },
     {
      "pronoun": "هِيَ",
      "pronounTranslit": "hiya",
      "en": "she threw / she throws",
      "past": "رَمَتْ",
      "pastTranslit": "ramat",
      "present": "تَرْمِي",
      "presentTranslit": "tarmī"
     },
     {
      "pronoun": "هُمَا",
      "pronounTranslit": "humā",
      "en": "they two (m) threw / they throw",
      "past": "رَمَيَا",
      "pastTranslit": "ramayā",
      "present": "يَرْمِيَانِ",
      "presentTranslit": "yarmiyāni"
     },
     {
      "pronoun": "هُمَا",
      "pronounTranslit": "humā",
      "en": "they two (f) threw / they throw",
      "past": "رَمَتَا",
      "pastTranslit": "ramatā",
      "present": "تَرْمِيَانِ",
      "presentTranslit": "tarmiyāni"
     },
     {
      "pronoun": "هُمْ",
      "pronounTranslit": "hum",
      "en": "they (m) threw / they throw",
      "past": "رَمَوْا",
      "pastTranslit": "ramaw",
      "present": "يَرْمُونَ",
      "presentTranslit": "yarmūna"
     },
     {
      "pronoun": "هُنَّ",
      "pronounTranslit": "hunna",
      "en": "they (f) threw / they throw",
      "past": "رَمَيْنَ",
      "pastTranslit": "ramayna",
      "present": "يَرْمِينَ",
      "presentTranslit": "yarmīna"
     }
    ]
   },
   {
    "id": "defective-a",
    "name": "The Defective Verb (a-imperfect)",
    "nameAr": "النَّاقِصُ مِنْ بَابِ فَعِلَ يَفْعَلُ",
    "desc": "Defective verbs of the faʿila yafʿalu class keep the yāʾ as long ī before consonant-initial past suffixes (nasītu, nasīna) but lose it in the 3rd masculine plural: nasū. The imperfect ends in alif maqṣūra (yansā), and before the plural and 2nd feminine singular endings this -ā breaks into the diphthongs -aw- and -ay-: yansawna, tansayna.",
    "model": {
     "ar": "نَسِيَ / يَنْسَى",
     "translit": "nasiya / yansā",
     "en": "to forget"
    },
    "paradigm": [
     {
      "pronoun": "أَنَا",
      "pronounTranslit": "anā",
      "en": "I forgot / I forget",
      "past": "نَسِيتُ",
      "pastTranslit": "nasītu",
      "present": "أَنْسَى",
      "presentTranslit": "ansā"
     },
     {
      "pronoun": "نَحْنُ",
      "pronounTranslit": "naḥnu",
      "en": "we forgot / we forget",
      "past": "نَسِينَا",
      "pastTranslit": "nasīnā",
      "present": "نَنْسَى",
      "presentTranslit": "nansā"
     },
     {
      "pronoun": "أَنْتَ",
      "pronounTranslit": "anta",
      "en": "you (m sg) forgot / you forget",
      "past": "نَسِيتَ",
      "pastTranslit": "nasīta",
      "present": "تَنْسَى",
      "presentTranslit": "tansā"
     },
     {
      "pronoun": "أَنْتِ",
      "pronounTranslit": "anti",
      "en": "you (f sg) forgot / you forget",
      "past": "نَسِيتِ",
      "pastTranslit": "nasīti",
      "present": "تَنْسَيْنَ",
      "presentTranslit": "tansayna"
     },
     {
      "pronoun": "أَنْتُمَا",
      "pronounTranslit": "antumā",
      "en": "you two forgot / you forget",
      "past": "نَسِيتُمَا",
      "pastTranslit": "nasītumā",
      "present": "تَنْسَيَانِ",
      "presentTranslit": "tansayāni"
     },
     {
      "pronoun": "أَنْتُمْ",
      "pronounTranslit": "antum",
      "en": "you (m pl) forgot / you forget",
      "past": "نَسِيتُمْ",
      "pastTranslit": "nasītum",
      "present": "تَنْسَوْنَ",
      "presentTranslit": "tansawna"
     },
     {
      "pronoun": "أَنْتُنَّ",
      "pronounTranslit": "antunna",
      "en": "you (f pl) forgot / you forget",
      "past": "نَسِيتُنَّ",
      "pastTranslit": "nasītunna",
      "present": "تَنْسَيْنَ",
      "presentTranslit": "tansayna"
     },
     {
      "pronoun": "هُوَ",
      "pronounTranslit": "huwa",
      "en": "he forgot / he forgets",
      "past": "نَسِيَ",
      "pastTranslit": "nasiya",
      "present": "يَنْسَى",
      "presentTranslit": "yansā"
     },
     {
      "pronoun": "هِيَ",
      "pronounTranslit": "hiya",
      "en": "she forgot / she forgets",
      "past": "نَسِيَتْ",
      "pastTranslit": "nasiyat",
      "present": "تَنْسَى",
      "presentTranslit": "tansā"
     },
     {
      "pronoun": "هُمَا",
      "pronounTranslit": "humā",
      "en": "they two (m) forgot / they forget",
      "past": "نَسِيَا",
      "pastTranslit": "nasiyā",
      "present": "يَنْسَيَانِ",
      "presentTranslit": "yansayāni"
     },
     {
      "pronoun": "هُمَا",
      "pronounTranslit": "humā",
      "en": "they two (f) forgot / they forget",
      "past": "نَسِيَتَا",
      "pastTranslit": "nasiyatā",
      "present": "تَنْسَيَانِ",
      "presentTranslit": "tansayāni"
     },
     {
      "pronoun": "هُمْ",
      "pronounTranslit": "hum",
      "en": "they (m) forgot / they forget",
      "past": "نَسُوا",
      "pastTranslit": "nasū",
      "present": "يَنْسَوْنَ",
      "presentTranslit": "yansawna"
     },
     {
      "pronoun": "هُنَّ",
      "pronounTranslit": "hunna",
      "en": "they (f) forgot / they forget",
      "past": "نَسِينَ",
      "pastTranslit": "nasīna",
      "present": "يَنْسَيْنَ",
      "presentTranslit": "yansayna"
     }
    ]
   },
   {
    "id": "hamzated",
    "name": "The Hamzated Verb",
    "nameAr": "الْمَهْمُوز",
    "desc": "The hamzated verb conjugates like a sound verb, since hamza is a full consonant; only its written seat shifts with the neighboring vowels (أَخَذَ, يَأْخُذُ). When the 1st person prefix hamza meets the radical hamza, the two fuse into madda: آخُذُ ākhudhu. Note the irregular imperative خُذْ khudh, which drops the initial hamza altogether, as do كُلْ kul and مُرْ mur.",
    "model": {
     "ar": "أَخَذَ / يَأْخُذُ",
     "translit": "akhadha / yaʾkhudhu",
     "en": "to take"
    },
    "paradigm": [
     {
      "pronoun": "أَنَا",
      "pronounTranslit": "anā",
      "en": "I took / I take",
      "past": "أَخَذْتُ",
      "pastTranslit": "akhadhtu",
      "present": "آخُذُ",
      "presentTranslit": "ākhudhu"
     },
     {
      "pronoun": "نَحْنُ",
      "pronounTranslit": "naḥnu",
      "en": "we took / we take",
      "past": "أَخَذْنَا",
      "pastTranslit": "akhadhnā",
      "present": "نَأْخُذُ",
      "presentTranslit": "naʾkhudhu"
     },
     {
      "pronoun": "أَنْتَ",
      "pronounTranslit": "anta",
      "en": "you (m sg) took / you take",
      "past": "أَخَذْتَ",
      "pastTranslit": "akhadhta",
      "present": "تَأْخُذُ",
      "presentTranslit": "taʾkhudhu"
     },
     {
      "pronoun": "أَنْتِ",
      "pronounTranslit": "anti",
      "en": "you (f sg) took / you take",
      "past": "أَخَذْتِ",
      "pastTranslit": "akhadhti",
      "present": "تَأْخُذِينَ",
      "presentTranslit": "taʾkhudhīna"
     },
     {
      "pronoun": "أَنْتُمَا",
      "pronounTranslit": "antumā",
      "en": "you two took / you take",
      "past": "أَخَذْتُمَا",
      "pastTranslit": "akhadhtumā",
      "present": "تَأْخُذَانِ",
      "presentTranslit": "taʾkhudhāni"
     },
     {
      "pronoun": "أَنْتُمْ",
      "pronounTranslit": "antum",
      "en": "you (m pl) took / you take",
      "past": "أَخَذْتُمْ",
      "pastTranslit": "akhadhtum",
      "present": "تَأْخُذُونَ",
      "presentTranslit": "taʾkhudhūna"
     },
     {
      "pronoun": "أَنْتُنَّ",
      "pronounTranslit": "antunna",
      "en": "you (f pl) took / you take",
      "past": "أَخَذْتُنَّ",
      "pastTranslit": "akhadhtunna",
      "present": "تَأْخُذْنَ",
      "presentTranslit": "taʾkhudhna"
     },
     {
      "pronoun": "هُوَ",
      "pronounTranslit": "huwa",
      "en": "he took / he takes",
      "past": "أَخَذَ",
      "pastTranslit": "akhadha",
      "present": "يَأْخُذُ",
      "presentTranslit": "yaʾkhudhu"
     },
     {
      "pronoun": "هِيَ",
      "pronounTranslit": "hiya",
      "en": "she took / she takes",
      "past": "أَخَذَتْ",
      "pastTranslit": "akhadhat",
      "present": "تَأْخُذُ",
      "presentTranslit": "taʾkhudhu"
     },
     {
      "pronoun": "هُمَا",
      "pronounTranslit": "humā",
      "en": "they two (m) took / they take",
      "past": "أَخَذَا",
      "pastTranslit": "akhadhā",
      "present": "يَأْخُذَانِ",
      "presentTranslit": "yaʾkhudhāni"
     },
     {
      "pronoun": "هُمَا",
      "pronounTranslit": "humā",
      "en": "they two (f) took / they take",
      "past": "أَخَذَتَا",
      "pastTranslit": "akhadhatā",
      "present": "تَأْخُذَانِ",
      "presentTranslit": "taʾkhudhāni"
     },
     {
      "pronoun": "هُمْ",
      "pronounTranslit": "hum",
      "en": "they (m) took / they take",
      "past": "أَخَذُوا",
      "pastTranslit": "akhadhū",
      "present": "يَأْخُذُونَ",
      "presentTranslit": "yaʾkhudhūna"
     },
     {
      "pronoun": "هُنَّ",
      "pronounTranslit": "hunna",
      "en": "they (f) took / they take",
      "past": "أَخَذْنَ",
      "pastTranslit": "akhadhna",
      "present": "يَأْخُذْنَ",
      "presentTranslit": "yaʾkhudhna"
     }
    ]
   }
  ];

  var PATTERNS = /*@DATA:PATTERNS*/{
   "masdars": [
    {
     "form": "I",
     "patterns": "varies — must be learned (e.g. فَعْل، فُعُول، فِعَالَة)",
     "patternsTranslit": "varies — must be learned (e.g. faʿl, fuʿūl, fiʿāla)",
     "example": {
      "ar": "ضَرْب",
      "translit": "ḍarb",
      "en": "striking, hitting (from ضَرَبَ)"
     }
    },
    {
     "form": "II",
     "patterns": "تَفْعِيل",
     "patternsTranslit": "tafʿīl",
     "example": {
      "ar": "تَعْلِيم",
      "translit": "taʿlīm",
      "en": "teaching, instruction (from عَلَّمَ)"
     }
    },
    {
     "form": "III",
     "patterns": "مُفَاعَلَة / فِعَال",
     "patternsTranslit": "mufāʿala / fiʿāl",
     "example": {
      "ar": "قِتَال",
      "translit": "qitāl",
      "en": "fighting, combat (from قَاتَلَ)"
     }
    },
    {
     "form": "IV",
     "patterns": "إِفْعَال",
     "patternsTranslit": "ifʿāl",
     "example": {
      "ar": "إِسْلَام",
      "translit": "islām",
      "en": "submission, surrender (from أَسْلَمَ)"
     }
    },
    {
     "form": "V",
     "patterns": "تَفَعُّل",
     "patternsTranslit": "tafaʿʿul",
     "example": {
      "ar": "تَعَلُّم",
      "translit": "taʿallum",
      "en": "learning (from تَعَلَّمَ)"
     }
    },
    {
     "form": "VI",
     "patterns": "تَفَاعُل",
     "patternsTranslit": "tafāʿul",
     "example": {
      "ar": "تَعَاوُن",
      "translit": "taʿāwun",
      "en": "mutual help, cooperation (from تَعَاوَنَ)"
     }
    },
    {
     "form": "VII",
     "patterns": "اِنْفِعَال",
     "patternsTranslit": "infiʿāl",
     "example": {
      "ar": "اِنْكِسَار",
      "translit": "inkisār",
      "en": "being broken, breaking apart (from اِنْكَسَرَ)"
     }
    },
    {
     "form": "VIII",
     "patterns": "اِفْتِعَال",
     "patternsTranslit": "iftiʿāl",
     "example": {
      "ar": "اِجْتِمَاع",
      "translit": "ijtimāʿ",
      "en": "gathering, meeting (from اِجْتَمَعَ)"
     }
    },
    {
     "form": "IX",
     "patterns": "اِفْعِلَال",
     "patternsTranslit": "ifʿilāl",
     "example": {
      "ar": "اِحْمِرَار",
      "translit": "iḥmirār",
      "en": "turning red, reddening (from اِحْمَرَّ)"
     }
    },
    {
     "form": "X",
     "patterns": "اِسْتِفْعَال",
     "patternsTranslit": "istifʿāl",
     "example": {
      "ar": "اِسْتِغْفَار",
      "translit": "istighfār",
      "en": "asking forgiveness (from اِسْتَغْفَرَ)"
     }
    }
   ],
   "plurals": [
    {
     "pattern": "أَفْعَال",
     "patternTranslit": "afʿāl",
     "desc": "The single most frequent broken plural, taken above all by short triliteral singulars of the shapes فَعَل، فَعْل، فِعْل and فُعْل.",
     "examples": [
      {
       "sing": "قَلَم",
       "singTranslit": "qalam",
       "pl": "أَقْلَام",
       "plTranslit": "aqlām",
       "en": "pen, reed pen"
      },
      {
       "sing": "وَلَد",
       "singTranslit": "walad",
       "pl": "أَوْلَاد",
       "plTranslit": "awlād",
       "en": "boy, child"
      },
      {
       "sing": "نَهْر",
       "singTranslit": "nahr",
       "pl": "أَنْهَار",
       "plTranslit": "anhār",
       "en": "river"
      }
     ]
    },
    {
     "pattern": "فُعُول",
     "patternTranslit": "fuʿūl",
     "desc": "Very common for singulars of the shapes فَعْل and فِعْل, both concrete nouns and abstracts.",
     "examples": [
      {
       "sing": "قَلْب",
       "singTranslit": "qalb",
       "pl": "قُلُوب",
       "plTranslit": "qulūb",
       "en": "heart"
      },
      {
       "sing": "بَيْت",
       "singTranslit": "bayt",
       "pl": "بُيُوت",
       "plTranslit": "buyūt",
       "en": "house"
      },
      {
       "sing": "عِلْم",
       "singTranslit": "ʿilm",
       "pl": "عُلُوم",
       "plTranslit": "ʿulūm",
       "en": "knowledge, science"
      }
     ]
    },
    {
     "pattern": "فِعَال",
     "patternTranslit": "fiʿāl",
     "desc": "Common for singulars of the shapes فَعَل، فَعْل and فَعُل, including some of the best-known nouns for people and nature.",
     "examples": [
      {
       "sing": "جَبَل",
       "singTranslit": "jabal",
       "pl": "جِبَال",
       "plTranslit": "jibāl",
       "en": "mountain"
      },
      {
       "sing": "رَجُل",
       "singTranslit": "rajul",
       "pl": "رِجَال",
       "plTranslit": "rijāl",
       "en": "man"
      },
      {
       "sing": "بَحْر",
       "singTranslit": "baḥr",
       "pl": "بِحَار",
       "plTranslit": "biḥār",
       "en": "sea"
      }
     ]
    },
    {
     "pattern": "أَفْعُل",
     "patternTranslit": "afʿul",
     "desc": "A plural of paucity (three to ten) taken chiefly by فَعْل singulars, many of them feminine by nature such as body parts.",
     "examples": [
      {
       "sing": "عَيْن",
       "singTranslit": "ʿayn",
       "pl": "أَعْيُن",
       "plTranslit": "aʿyun",
       "en": "eye"
      },
      {
       "sing": "نَفْس",
       "singTranslit": "nafs",
       "pl": "أَنْفُس",
       "plTranslit": "anfus",
       "en": "soul, self"
      },
      {
       "sing": "شَهْر",
       "singTranslit": "shahr",
       "pl": "أَشْهُر",
       "plTranslit": "ashhur",
       "en": "month"
      }
     ]
    },
    {
     "pattern": "فُعُل",
     "patternTranslit": "fuʿul",
     "desc": "Taken by singulars with a long second syllable, above all the shapes فِعَال، فَعُول and فَعِيلَة.",
     "examples": [
      {
       "sing": "كِتَاب",
       "singTranslit": "kitāb",
       "pl": "كُتُب",
       "plTranslit": "kutub",
       "en": "book"
      },
      {
       "sing": "رَسُول",
       "singTranslit": "rasūl",
       "pl": "رُسُل",
       "plTranslit": "rusul",
       "en": "messenger"
      },
      {
       "sing": "مَدِينَة",
       "singTranslit": "madīna",
       "pl": "مُدُن",
       "plTranslit": "mudun",
       "en": "city"
      }
     ]
    },
    {
     "pattern": "فُعَلَاء",
     "patternTranslit": "fuʿalāʾ",
     "desc": "For nouns and adjectives denoting male persons of a quality, rank or profession, mostly of the shapes فَعِيل and فَاعِل.",
     "examples": [
      {
       "sing": "وَزِير",
       "singTranslit": "wazīr",
       "pl": "وُزَرَاء",
       "plTranslit": "wuzarāʾ",
       "en": "minister, vizier"
      },
      {
       "sing": "عَالِم",
       "singTranslit": "ʿālim",
       "pl": "عُلَمَاء",
       "plTranslit": "ʿulamāʾ",
       "en": "scholar, learned man"
      },
      {
       "sing": "شَاعِر",
       "singTranslit": "shāʿir",
       "pl": "شُعَرَاء",
       "plTranslit": "shuʿarāʾ",
       "en": "poet"
      }
     ]
    },
    {
     "pattern": "أَفْعِلَاء",
     "patternTranslit": "afʿilāʾ",
     "desc": "The counterpart of فُعَلَاء used when the فَعِيل singular denoting a person has a weak third radical or a doubled root.",
     "examples": [
      {
       "sing": "نَبِيّ",
       "singTranslit": "nabiyy",
       "pl": "أَنْبِيَاء",
       "plTranslit": "anbiyāʾ",
       "en": "prophet"
      },
      {
       "sing": "وَلِيّ",
       "singTranslit": "waliyy",
       "pl": "أَوْلِيَاء",
       "plTranslit": "awliyāʾ",
       "en": "friend, ally, patron"
      },
      {
       "sing": "غَنِيّ",
       "singTranslit": "ghaniyy",
       "pl": "أَغْنِيَاء",
       "plTranslit": "aghniyāʾ",
       "en": "rich (man)"
      }
     ]
    },
    {
     "pattern": "فَوَاعِل",
     "patternTranslit": "fawāʿil",
     "desc": "For singulars of the shapes فَاعِل and فَاعِلَة, chiefly non-human nouns and feminines.",
     "examples": [
      {
       "sing": "شَارِع",
       "singTranslit": "shāriʿ",
       "pl": "شَوَارِع",
       "plTranslit": "shawāriʿ",
       "en": "street"
      },
      {
       "sing": "قَاعِدَة",
       "singTranslit": "qāʿida",
       "pl": "قَوَاعِد",
       "plTranslit": "qawāʿid",
       "en": "rule, foundation"
      },
      {
       "sing": "عَاصِفَة",
       "singTranslit": "ʿāṣifa",
       "pl": "عَوَاصِف",
       "plTranslit": "ʿawāṣif",
       "en": "storm"
      }
     ]
    },
    {
     "pattern": "مَفَاعِل",
     "patternTranslit": "mafāʿil",
     "desc": "The regular plural of mīm-prefixed nouns of place and instrument of the shapes مَفْعَل، مَفْعِل and مَفْعَلَة with a short final syllable.",
     "examples": [
      {
       "sing": "مَسْجِد",
       "singTranslit": "masjid",
       "pl": "مَسَاجِد",
       "plTranslit": "masājid",
       "en": "mosque"
      },
      {
       "sing": "مَدْرَسَة",
       "singTranslit": "madrasa",
       "pl": "مَدَارِس",
       "plTranslit": "madāris",
       "en": "school"
      },
      {
       "sing": "مَكْتَب",
       "singTranslit": "maktab",
       "pl": "مَكَاتِب",
       "plTranslit": "makātib",
       "en": "place of writing; the elementary school (kuttāb)"
      }
     ]
    },
    {
     "pattern": "مَفَاعِيل",
     "patternTranslit": "mafāʿīl",
     "desc": "Like مَفَاعِل but for mīm-prefixed singulars with a long vowel before the last radical, such as مِفْعَال and مَفْعُول.",
     "examples": [
      {
       "sing": "مِفْتَاح",
       "singTranslit": "miftāḥ",
       "pl": "مَفَاتِيح",
       "plTranslit": "mafātīḥ",
       "en": "key"
      },
      {
       "sing": "مِصْبَاح",
       "singTranslit": "miṣbāḥ",
       "pl": "مَصَابِيح",
       "plTranslit": "maṣābīḥ",
       "en": "lamp"
      },
      {
       "sing": "مَكْتُوب",
       "singTranslit": "maktūb",
       "pl": "مَكَاتِيب",
       "plTranslit": "makātīb",
       "en": "letter, written message"
      }
     ]
    }
   ],
   "quad": {
    "desc": "Alongside the triliteral system stands the quadriliteral verb, built on four root consonants in the pattern فَعْلَلَ (faʿlala), whether from reduplication like زَلْزَلَ (zalzala, \"to shake violently\") or from expanded and borrowed roots. Despite its extra radical it introduces no new machinery: it behaves exactly like Form II, with imperfect يُفَعْلِلُ (yufaʿlilu) taking a ḍamma on the prefix, participles مُفَعْلِل / مُفَعْلَل, and maṣdar فَعْلَلَة (faʿlala).",
    "model": {
     "ar": "دَحْرَجَ / يُدَحْرِجُ",
     "translit": "daḥraja / yudaḥriju",
     "en": "to roll (something)"
    },
    "paradigmNote": "دَحْرَجَ conjugates exactly like Form II عَلَّمَ / يُعَلِّمُ — the same ḍamma prefix in the imperfect, the same stem vowels, the same participle shapes (مُدَحْرِج / مُدَحْرَج) — but its maṣdar is its own: فَعْلَلَة (دَحْرَجَة daḥraja).",
    "example2": {
     "ar": "تَرْجَمَ / يُتَرْجِمُ",
     "translit": "tarjama / yutarjimu",
     "en": "to translate"
    }
   }
  };

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
