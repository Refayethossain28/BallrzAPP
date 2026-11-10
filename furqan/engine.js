/* Furqan — the pure "ask the Qur'an" engine.
 * =====================================================================
 * Furqan (al-Furqān, "the Criterion") answers questions about Islam by
 * FINDING and QUOTING verses of the Qur'an — never by generating them. The
 * text it quotes is the verified Uthmani mushaf with Pickthall's translation
 * (furqan/quran.json, built and checksummed by scripts/build-furqan-corpus.mjs).
 * A language model, however large, can produce text that merely LOOKS like
 * scripture; this engine only ever returns verses by their (surah, ayah)
 * address, so nothing it shows can be invented.
 *
 * Everything that is a rule lives here as pure, deterministic functions with
 * zero DOM and zero I/O: Arabic and English normalisation (harakāt-aware,
 * Pickthall's "ye/thee/hath" mapped to modern words, light stemming), a
 * BM25 search index over all 6,236 ayat, a curated topic lexicon that maps
 * the questions people actually ask ("what does the Qur'an say about
 * patience?") to the classic passages, reference parsing ("2:255",
 * "Al-Kahf 10", "surah yasin", "ayat al-kursi"), passage assembly, the
 * honesty notes (rulings need qualified scholars; some questions are not in
 * the Qur'an at all), a verse of the day, and — for the optional Live AI
 * explanation — the grounding prompt plus a verifier that checks every quote
 * the model makes against the real text before the page shows it.
 * Unit-tested in scripts/test-furqan-logic.mjs, rendered by index.html.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

  var DAY = 24 * 60 * 60 * 1000;

  /* ---------------- deterministic hashing ---------------- */
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

  /* ---------------- text safety ---------------- */
  function escapeHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- Arabic normalisation ----------------
   * The Uthmani text carries harakāt, Qur'anic pause and recitation marks,
   * superscript alefs and alef-wasla. For SEARCH we strip all of that and
   * unify the letter variants, so "الصبر" finds "بِٱلصَّبۡرِ". Display always
   * uses the untouched verse text. */
  var AR_MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭ࣓-ࣿـ]/g;
  // The Uthmani script writes some long vowels as small letters: a dagger alef
  // in Ibrahim's name, a small yeh/waw elsewhere. Standard spelling writes them
  // as full letters (إبراهيم) — or not at all (الرحمن). `expand` = true turns
  // the small letters into full ones; the index keeps BOTH forms of every word.
  function normalizeArabic(s, expand) {
    s = String(s || '');
    // the vocative is one written word in the mushaf (يَٰٓأَيُّهَا) and two in standard spelling (يا أيها)
    s = s.replace(/ي[ً-ْٰٓ]*(?:أ|ا[ً-ْ]*ٔ)/g, 'يا أ');
    if (expand) {
      // the alif of صلاة / زكاة / حياة / ربا is written waw + dagger alef, that of
      // توراة yeh + dagger alef: restore the alif BEFORE the generic rule
      s = s.replace(/وٰا?/g, 'ا').replace(/ىٰ/g, 'ا')
           .replace(/ٰ/g, 'ا').replace(/[ۦۧ]/g, 'ي').replace(/ۥ/g, 'و');
    }
    return s
      .replace(AR_MARKS, '')
      .replace(/[ٱآأإ]/g, 'ا')   // ٱ آ أ إ -> ا
      .replace(/ءا/g, 'ا')                  // ءا (قرءان) -> ا
      .replace(/ة/g, 'ه')                        // ة -> ه
      .replace(/ى/g, 'ي')                        // ى -> ي
      .replace(/ؤ/g, 'و')                        // ؤ -> و
      .replace(/ئ/g, 'ي')                        // ئ -> ي
      .replace(/[^ء-ي٠-٩\s]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function stripLayer(w, prefixes) {
    for (var i = 0; i < prefixes.length; i++) {
      var p = prefixes[i];
      if (w.length > p.length + 2 && w.indexOf(p) === 0) return w.slice(p.length);
    }
    return null;
  }
  var AR_CONJ = ['و', 'ف'], AR_PREP = ['ب', 'ل', 'ك'], AR_ART = ['ال', 'لل'];
  // Index tokens for Arabic text: every word in both spellings, plus the word
  // with its conjunction, preposition and article peeled off in turn (each
  // stage kept), so a search for "الصبر" or "صبر" meets "وبالصبر".
  function arabicTokens(s) {
    var out = [], seen = Object.create(null);
    function add(w) { if (w && !seen[w]) { seen[w] = 1; out.push(w); } }
    normalizeArabic(s).split(' ').concat(normalizeArabic(s, true).split(' ')).forEach(function (w) {
      if (!w) return;
      add(w);
      var x = stripLayer(w, AR_CONJ); if (x) add(x); else x = w;
      var y = stripLayer(x, AR_PREP); if (y) add(y); else y = x;
      var z = stripLayer(y, AR_ART); if (z) add(z);
    });
    return out;
  }
  function hasArabic(s) { return /[؀-ۿ]/.test(String(s || '')); }

  /* ---------------- English normalisation ----------------
   * Pickthall (1930) writes "ye", "thee", "hath", "believeth". People ask in
   * 2026 English. Map the archaic forms to modern ones, then stem lightly, so
   * "believers" and "they who believeth" land on the same term. */
  var ARCHAIC = {
    ye: 'you', thee: 'you', thou: 'you', thy: 'your', thine: 'your', hath: 'has', doth: 'does',
    dost: 'do', hast: 'have', shalt: 'shall', wilt: 'will', wert: 'were', unto: 'to',
    wherefore: 'why', whence: 'where', whither: 'where', hither: 'here', thither: 'there',
    whoso: 'whoever', whosoever: 'whoever', whomso: 'whomever', naught: 'nothing', aught: 'anything',
    ere: 'before', oft: 'often', nigh: 'near', lo: '', verily: '', nay: 'no', yea: 'yes',
    saith: 'say', spake: 'spoke', didst: 'did', canst: 'can', mayest: 'may', wouldst: 'would',
    shouldst: 'should', couldst: 'could', hadst: 'had', therein: 'in', thereof: 'of', thereto: 'to',
    thereby: 'by', wherein: 'in', whereby: 'by', herein: 'in', hereafter: 'hereafter'
  };
  var STOP = {};
  ('a an the and or of to in on at by for with from as is are was were be been being am do does did ' +
   'not no nor so if then than that this these those there here it its he him his she her they them ' +
   'their we us our you your i me my mine who whom whose which what when where why how all any each ' +
   'every some such only own same too very can will just about into over under again further once ' +
   'also but because while during before after above below up down out off through between both ' +
   'said say says tell told verse verses quran koran qur surah sura chapter ayah ayat aya quote ' +
   'mention mentioned mentions talk talks about regarding does say islam islamic muslim muslims ' +
   'allah god lord swt know mean meaning explain explanation o oh has have had having shall should ' +
   'would could may might must let lets like want wants need needs get got make made please ' +
   'thing things one ones way ways al ar ul el ash').split(' ').forEach(function (w) { STOP[w] = 1; });
  // Topic matching keeps a few words the search index treats as noise, because
  // "Who is God?" is a real question with a real topic. They weigh less.
  var TOPIC_STOP = {};
  for (var sw in STOP) TOPIC_STOP[sw] = 1;
  var GENERIC = { allah: 0.4, god: 0.6, lord: 0.4, one: 0.3 };
  for (var gw in GENERIC) delete TOPIC_STOP[gw];
  function topicTokens(s) { return englishTokens(s, true).filter(function (w) { return !TOPIC_STOP[w]; }); }
  function stem(w) {
    if (w.length <= 3) return w;
    if (/ies$/.test(w)) return w.slice(0, -3) + 'y';
    if (/eth$/.test(w) && w.length > 5) w = w.slice(0, -3);
    else if (/ness$/.test(w) && w.length > 6) w = w.slice(0, -4);
    else if (/ing$/.test(w) && w.length > 5) w = w.slice(0, -3);
    else if (/eed$/.test(w) && w.length > 4) w = w.slice(0, -1);        // agreed -> agree (Porter's EED rule)
    else if (/ed$/.test(w) && w.length > 4) w = w.slice(0, -2);
    else if (/es$/.test(w) && w.length > 4 && !/ss$/.test(w)) w = w.slice(0, -2);
    else if (/s$/.test(w) && w.length > 3 && !/[su]s$/.test(w)) w = w.slice(0, -1);
    if (/e$/.test(w) && w.length > 4) w = w.slice(0, -1);
    return w;
  }
  function englishTokens(s, keepStop) {
    var out = [];
    String(s || '').toLowerCase()
      .replace(/[‘’ʼ]/g, "'").replace(/\b(thou|who|nor|or)\s+art\b/g, '$1 are').replace(/\bart\s+thou\b/g, 'are thou')   // the verb, not the noun of 21:80
      .replace(/'s\b/g, '').replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/).forEach(function (w) {
        if (!w) return;
        if (Object.prototype.hasOwnProperty.call(ARCHAIC, w)) w = ARCHAIC[w];
        if (!w) return;
        w.split(' ').forEach(function (x) {
          if (!keepStop && STOP[x]) return;
          var st = stem(x);
          if (st) out.push(st);
        });
      });
    return out;
  }

  /* ---------------- the index ---------------- */
  // ctx = { quran, docs, en: {postings, avgLen, lens}, ar: {...}, aliases }
  function flatten(quran) {
    var docs = [];
    quran.surahs.forEach(function (su) {
      su.ayat.forEach(function (pair, i) {
        docs.push({ i: docs.length, s: su.n, a: i + 1, ar: pair[0], en: pair[1] });
      });
    });
    return docs;
  }
  function buildField(docs, tokenize, key) {
    var postings = Object.create(null), lens = new Array(docs.length), total = 0;
    docs.forEach(function (d) {
      var toks = tokenize(d[key]), tf = Object.create(null);
      toks.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
      lens[d.i] = toks.length; total += toks.length;
      for (var t in tf) (postings[t] || (postings[t] = [])).push([d.i, tf[t]]);
    });
    return { postings: postings, lens: lens, avgLen: total / Math.max(1, docs.length), N: docs.length };
  }
  function bm25(field, terms) {
    var k1 = 1.2, b = 0.75, scores = Object.create(null), N = field.N;
    terms.forEach(function (t) {
      var pl = field.postings[t];
      if (!pl) return;
      var idf = Math.log(1 + (N - pl.length + 0.5) / (pl.length + 0.5));
      pl.forEach(function (p) {
        var tf = p[1], len = field.lens[p[0]];
        scores[p[0]] = (scores[p[0]] || 0) + idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * len / field.avgLen));
      });
    });
    return scores;
  }
  function buildContext(quran) {
    var docs = flatten(quran);
    return {
      quran: quran, docs: docs,
      en: buildField(docs, function (t) { return englishTokens(t); }, 'en'),
      ar: buildField(docs, arabicTokens, 'ar'),
      aliases: buildAliases(quran),
    };
  }
  function verseIndex(ctx, s, a) {
    var su = ctx.quran.surahs[s - 1];
    if (!su || a < 1 || a > su.ayat.length) return -1;
    var base = 0;
    for (var i = 0; i < s - 1; i++) base += ctx.quran.surahs[i].ayat.length;
    return base + a - 1;
  }
  function getVerse(ctx, s, a) {
    var i = verseIndex(ctx, s, a);
    return i < 0 ? null : ctx.docs[i];
  }
  function surahOf(ctx, s) { return ctx.quran.surahs[s - 1] || null; }
  function refLabel(ctx, s, a, b) {
    var su = surahOf(ctx, s);
    var name = su ? su.name : 'Surah ' + s;
    return name + ' ' + s + ':' + a + (b && b !== a ? '-' + b : '');
  }

  /* ---------------- surah names and aliases ---------------- */
  var EXTRA_ALIASES = {
    1: ['fatiha', 'fatihah', 'opening', 'alhamd'], 2: ['baqarah', 'bakara', 'cow'], 3: ['imran', 'ali imran', 'al imran', 'aal imran', 'al e imran', 'family of imran'],
    4: ['nisa', 'nisaa', 'women'], 5: ['maida', 'maidah', 'table spread', 'table'], 6: ['anam', 'cattle'], 7: ['araf', 'heights'],
    8: ['anfal', 'spoils of war', 'spoils'], 9: ['tawbah', 'tauba', 'taubah', 'repentance', 'baraah'], 10: ['yunus', 'jonah'], 11: ['hud'],
    12: ['yusuf', 'joseph'], 13: ['rad', 'raad', 'thunder'], 14: ['ibrahim', 'abraham'], 15: ['hijr', 'rocky tract'], 16: ['nahl', 'bee', 'bees'],
    17: ['isra', 'israa', 'bani israil', 'night journey', 'children of israel'], 18: ['kahf', 'cave'], 19: ['maryam', 'mary'], 20: ['taha', 'ta ha'],
    21: ['anbiya', 'anbiyaa', 'prophets'], 22: ['hajj', 'pilgrimage'], 23: ['muminun', 'muminoon', 'believers'], 24: ['nur', 'noor', 'light'],
    25: ['furqan', 'criterion'], 26: ['shuara', 'poets'], 27: ['naml', 'ant', 'ants'], 28: ['qasas', 'stories', 'narrations'], 29: ['ankabut', 'spider'],
    30: ['rum', 'room', 'romans', 'byzantines'], 31: ['luqman', 'lukman'], 32: ['sajdah', 'sajda', 'prostration'], 33: ['ahzab', 'confederates', 'clans'],
    34: ['saba', 'sheba'], 35: ['fatir', 'originator', 'angels'], 36: ['yasin', 'yaseen', 'ya sin'], 37: ['saffat', 'ranks', 'those who set the ranks'],
    38: ['sad', 'saad'], 39: ['zumar', 'troops', 'groups'], 40: ['ghafir', 'mumin', 'forgiver', 'believer'], 41: ['fussilat', 'ha mim', 'explained in detail'],
    42: ['shura', 'shuraa', 'consultation'], 43: ['zukhruf', 'ornaments', 'gold'], 44: ['dukhan', 'smoke'], 45: ['jathiya', 'jathiyah', 'kneeling', 'crouching'],
    46: ['ahqaf', 'dunes', 'sandhills'], 47: ['muhammad'], 48: ['fath', 'fatah', 'victory', 'conquest'], 49: ['hujurat', 'hujuraat', 'rooms', 'chambers', 'private apartments'],
    50: ['qaf'], 51: ['dhariyat', 'zariyat', 'winnowing winds', 'scatterers'], 52: ['tur', 'mount', 'mountain'], 53: ['najm', 'star'], 54: ['qamar', 'moon'],
    55: ['rahman', 'beneficent', 'merciful'], 56: ['waqia', 'waqiah', 'event', 'inevitable'], 57: ['hadid', 'iron'], 58: ['mujadila', 'mujadilah', 'she that disputeth', 'pleading woman'],
    59: ['hashr', 'exile', 'gathering'], 60: ['mumtahina', 'mumtahanah', 'she that is to be examined', 'examined one'], 61: ['saff', 'ranks', 'battle array'],
    62: ['jumua', 'jumuah', 'friday', 'congregation'], 63: ['munafiqun', 'munafiqoon', 'hypocrites'], 64: ['taghabun', 'mutual disillusion', 'loss and gain'],
    65: ['talaq', 'divorce'], 66: ['tahrim', 'banning', 'prohibition'], 67: ['mulk', 'sovereignty', 'kingdom', 'dominion'], 68: ['qalam', 'pen'],
    69: ['haqqa', 'haqqah', 'reality'], 70: ['maarij', 'ascending stairways', 'ways of ascent'], 71: ['nuh', 'noah'], 72: ['jinn'],
    73: ['muzzammil', 'enshrouded one'], 74: ['muddaththir', 'muddathir', 'cloaked one'], 75: ['qiyama', 'qiyamah', 'resurrection', 'rising of the dead'],
    76: ['insan', 'dahr', 'man', 'time'], 77: ['mursalat', 'emissaries', 'those sent forth'], 78: ['naba', 'tidings', 'news'], 79: ['naziat', 'those who drag forth'],
    80: ['abasa', 'he frowned'], 81: ['takwir', 'overthrowing', 'folding up'], 82: ['infitar', 'cleaving'], 83: ['mutaffifin', 'defrauding', 'dealers in fraud'],
    84: ['inshiqaq', 'sundering', 'splitting'], 85: ['buruj', 'mansions of the stars', 'constellations'], 86: ['tariq', 'morning star', 'night comer'],
    87: ['ala', 'most high'], 88: ['ghashiya', 'ghashiyah', 'overwhelming'], 89: ['fajr', 'dawn'], 90: ['balad', 'city'], 91: ['shams', 'sun'],
    92: ['layl', 'lail', 'night'], 93: ['duha', 'dhuha', 'morning hours', 'morning brightness'], 94: ['sharh', 'inshirah', 'alam nashrah', 'solace', 'relief', 'expansion'],
    95: ['tin', 'fig'], 96: ['alaq', 'clot', 'iqra'], 97: ['qadr', 'power', 'night of power', 'night of decree'], 98: ['bayyina', 'bayyinah', 'clear proof', 'evidence'],
    99: ['zalzala', 'zalzalah', 'earthquake'], 100: ['adiyat', 'coursers', 'chargers'], 101: ['qaria', 'qariah', 'calamity'], 102: ['takathur', 'rivalry in worldly increase', 'competition'],
    103: ['asr', 'declining day', 'time', 'afternoon'], 104: ['humaza', 'humazah', 'traducer', 'slanderer'], 105: ['fil', 'elephant'], 106: ['quraysh', 'quraish'],
    107: ['maun', 'small kindnesses', 'almsgiving'], 108: ['kawthar', 'kauthar', 'abundance'], 109: ['kafirun', 'kafiroon', 'disbelievers'], 110: ['nasr', 'succour', 'help', 'divine support'],
    111: ['masad', 'lahab', 'palm fibre', 'flame'], 112: ['ikhlas', 'ikhlaas', 'sincerity', 'purity', 'unity'], 113: ['falaq', 'daybreak'], 114: ['nas', 'naas', 'mankind', 'people']
  };
  function aliasKey(s) {
    return String(s || '').toLowerCase().replace(/[‘’ʼ']/g, '').replace(/^(surah|surat|sura|sourat|chapter)\s+/, '')
      .replace(/^(al|an|ar|as|at|ad|az|ash|ath|aal|aale|ali)[\s-]+(?!imran)/, '').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
  }
  function buildAliases(quran) {
    var map = Object.create(null);
    function put(k, n) { k = aliasKey(k); if (k && !map[k]) map[k] = n; }
    quran.surahs.forEach(function (su) {
      put(su.name, su.n); put(su.en, su.n);
      put(su.name.replace(/aa/g, 'a'), su.n); put(su.name.replace(/aa/g, 'a') + 'h', su.n);
      put(su.name + 'h', su.n);
      (EXTRA_ALIASES[su.n] || []).forEach(function (x) { put(x, su.n); });
    });
    return map;
  }
  // Famous passages people name rather than number.
  var NAMED = [
    { re: /\b(ayat?\s*(al|ul|el)?[\s-]*kursi|throne\s*verse|verse of the throne)\b/i, s: 2, a: 255 },
    { re: /\b(ayat?\s*(al|ul|an|el)?[\s-]*n[uo]+r|light\s*verse|verse of light)\b/i, s: 24, a: 35 },
    { re: /\b(last (two )?verses? of (al[\s-]*)?baqarah?|amana\s*r+asul)\b/i, s: 2, a: 285, b: 286 },
    { re: /\b(verse of (the )?debt|ayat (al|ad)[\s-]*dayn)\b/i, s: 2, a: 282 },
    { re: /\b(bismillah|basmala)\b/i, s: 1, a: 1 },
    { re: /\b(four quls?|4 quls?)\b/i, s: 112, a: 1, b: 4 },
  ];

  /* ---------------- reference parsing ---------------- */
  // "2:255", "2 255", "2:255-257", "surah 2 verse 255", "al-baqarah 255", "baqara 255-7",
  // "surah yasin", "kahf", "ayat al-kursi" -> {s, a, b} (a/b omitted = the whole surah)
  function parseReference(ctx, q) {
    var text = String(q || '').trim();
    if (!text) return null;
    var m, s, a, b;
    for (var i = 0; i < NAMED.length; i++) if (NAMED[i].re.test(text)) return clampRef(ctx, NAMED[i].s, NAMED[i].a, NAMED[i].b);
    text = text.replace(/^[\s(\[]+|[\s)\]]+$/g, '');          // "(2:255)" and friends
    if ((m = text.match(/^\s*(\d{1,3})\s*[:.∶]\s*(\d{1,3})(?:\s*[-–—]\s*(\d{1,3}))?\s*$/)) || (m = text.match(/^\s*(\d{1,3})\s+(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*$/))) {
      return clampRef(ctx, +m[1], +m[2], m[3] ? +m[3] : null);
    }
    if ((m = text.match(/^\s*(\d{1,3})\s*$/)) && +m[1] >= 1 && +m[1] <= 114) return clampRef(ctx, +m[1], null, null);
    // "Al-Baqarah 2:255", "Surah Al-Baqarah 2:255-257": the name must agree with the number
    if ((m = text.match(/^\s*(?:surat|surah|sourat|sura|chapter)?\s*([a-z][a-z'’\s-]{1,40}?)[\s,]+(\d{1,3})\s*:\s*(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?\s*$/i))) {
      var byName = ctx.aliases[aliasKey(m[1])];
      if (byName && byName === +m[2]) return clampRef(ctx, +m[2], +m[3], m[4] ? +m[4] : null);
    }
    if ((m = text.match(/\b(?:surah|sura|surat|chapter|ch\.?)\s*(\d{1,3})\b(?:(?:\s*(?:[:,]|verse|verses|ayah|ayat|aya|v\.?))+\s*(\d{1,3})(?:\s*(?:[-–]|to|and)\s*(\d{1,3}))?)?/i))) {
      return clampRef(ctx, +m[1], m[2] ? +m[2] : null, m[3] ? +m[3] : null);
    }
    if ((m = text.match(/^\s*(?:surat|surah|sourat|sura|chapter)?\s*([a-z][a-z'’\s-]{1,40}?)\s*(?:[:,]|verse|verses|ayah|ayat|aya|v\.?)?\s*(\d{1,3})?(?:\s*(?:[-–]|to)\s*(\d{1,3}))?\s*$/i))) {
      var key = aliasKey(m[1]);
      s = ctx.aliases[key];
      if (!s && /^(surah|sura|surat)/i.test(text)) s = ctx.aliases[aliasKey(m[1].replace(/^(surah|sura|surat)\s*/i, ''))];
      if (s) return clampRef(ctx, s, m[2] ? +m[2] : null, m[3] ? +m[3] : null);
    }
    return null;
  }
  // "what is al-fatiha about", "tell me about surah yusuf": a surah named inside
  // a question (only explicit forms — "surah X" or an "al-" name — so that
  // ordinary words like "light" or "women" do not hijack a question).
  function surahMentioned(ctx, text) {
    var t = String(text || '').toLowerCase(), m;
    if ((m = t.match(/\b(?:surah|sura|surat|chapter)\s+([a-z][a-z'\u2019-]+(?:\s+[a-z][a-z'\u2019-]+)?)/))) {
      var two = ctx.aliases[aliasKey(m[1])], one = ctx.aliases[aliasKey(m[1].split(/\s+/)[0])];
      if (two) return two;
      if (one) return one;
    }
    var re = /\b(?:al|an|ar|as|at|ad|az|ash|ath)-([a-z][a-z'\u2019]+)\b/g;
    while ((m = re.exec(t))) { var n = ctx.aliases[aliasKey(m[1])]; if (n) return n; }
    return 0;
  }
  function clampRef(ctx, s, a, b) {
    var su = surahOf(ctx, s);
    if (!su) return null;
    var n = su.ayat.length;
    if (a == null) return { s: s, a: 1, b: n, whole: true };
    if (a < 1 || a > n) return { s: s, a: null, b: null, invalid: true, max: n };
    if (b == null || b < a) b = a;
    if (b > n) b = n;
    return { s: s, a: a, b: b, whole: a === 1 && b === n };
  }

  /* ---------------- the topic lexicon ----------------
   * `match`: words (modern English, transliterations, Arabic) that a question
   * about the topic contains; `terms`: what to search for in Pickthall's
   * text; `seeds`: the classic passages for the topic, which lead the answer
   * (every one checked against the text, and audited for relevance: a seed
   * that only touches the topic in its last clause, or whose history a reader
   * needs, was dropped, demoted or given a `note` shown with the answer). */
  var TOPICS = [
    { id: 'tawhid', title: 'The oneness of God', match: 'god one oneness tawhid tawheed monotheism who is allah unity allah', terms: 'one god deity partner beget', seeds: ['112:1-4', '2:255', '59:22-24', '2:163', '47:19', '21:22', '6:103', '42:11', '3:18', '57:3'] },
    { id: 'islam', title: 'Islam — the religion of submission', match: 'submission submit pillars', phrases: ['what is islam', 'about islam', 'pillars of islam', 'religion of islam', 'meaning of islam', 'islam teach', 'islam say'], terms: 'religion surrender submit', seeds: ['3:19', '5:3', '3:85', '2:208', '49:14-15', '22:78', '2:136', '3:67', '2:177', '2:285'] },
    { id: 'shirk', title: 'Ascribing partners to God (shirk)', match: 'shirk partner partners idol idols idolatry associating polytheism', terms: 'partner partners idols associate ascribe', seeds: ['4:48', '31:13', '4:116', '5:72', '39:65', '22:31'] },
    { id: 'prayer', title: 'Prayer (salah)', match: 'pray prayer prayers salah salat salaat namaz worship prostrate bow times of prayer', terms: 'worship prayer establish bow prostrate', seeds: ['2:43', '4:103', '29:45', '17:78', '20:14', '2:45', '2:238', '11:114', '23:1-2', '107:4-5', '70:34', '62:9'] },
    { id: 'fasting', title: 'Fasting and Ramadan', match: 'fast fasting fasts sawm siyam ramadan ramadhan iftar suhoor', terms: 'fast fasting ramadan', seeds: ['2:183-185', '2:187', '97:1-5', '33:35'] },
    { id: 'zakat', title: 'Charity, zakat and alms', match: 'charity zakat zakah alms sadaqah sadaqa giving donate spend spending poor needy generosity', terms: 'alms poor needy spend charity', seeds: ['2:177', '2:261-262', '2:264', '2:267', '2:271', '9:60', '2:274', '3:92', '51:19', '9:103'] },
    { id: 'hajj', title: 'Pilgrimage (hajj and umrah)', match: 'hajj haj pilgrimage umrah umra mecca makkah kaaba kabah kaba', terms: 'pilgrimage house mecca sacred mosque', seeds: ['3:96-97', '2:196-197', '2:198-199', '22:26-29', '2:158', '2:125', '5:97'] },
    { id: 'quran', title: 'The Qur’an itself', match: 'quran koran book revelation revealed scripture recite recitation', terms: 'book scripture revealed reminder guidance', seeds: ['2:2', '15:9', '17:9', '17:82', '54:17', '2:185', '17:88', '39:23', '56:77-79', '73:4', '25:32'] },
    { id: 'prophet', title: 'The Prophet Muhammad', match: 'muhammad mohammed mohammad prophet messenger rasul rasool nabi sunnah mercy to the worlds', terms: 'messenger prophet muhammad', seeds: ['33:40', '21:107', '68:4', '33:21', '9:128', '3:159', '33:45-46', '3:144', '3:31', '4:80', '33:56', '48:29'], note: 'Verses about the Prophet’s companions and their opponents (such as 48:29) were revealed in specific conflicts; scholars read them with that history.' },
    { id: 'prophets', title: 'The prophets and messengers', match: 'prophets messengers nabi prophet sent', terms: 'messenger messengers prophets', seeds: ['2:136', '2:285', '4:163-165', '16:36', '10:47', '3:84', '21:25', '42:13', '6:83-90'] },
    { id: 'jesus', title: 'Jesus (Isa)', match: 'jesus isa christ messiah', terms: 'jesus messiah mary son', seeds: ['3:45-47', '19:16-36', '4:171', '5:72-75', '4:157-158', '3:59', '5:110', '5:116-117', '61:6', '43:63-64'] },
    { id: 'mary', title: 'Mary (Maryam)', match: 'mary maryam mariam virgin', terms: 'mary', seeds: ['3:42-43', '3:45-47', '19:16-29', '66:12', '3:35-37', '21:91'] },
    { id: 'moses', title: 'Moses (Musa)', match: 'moses musa pharaoh firaun fir’aun exodus israel', terms: 'moses pharaoh', seeds: ['20:9-24', '28:3-14', '7:103-137', '7:143', '26:10-68', '20:77-79', '2:49-61'] },
    { id: 'abraham', title: 'Abraham (Ibrahim)', match: 'abraham ibrahim ismail ishmael isaac khalil', terms: 'abraham', seeds: ['2:124-129', '6:74-83', '21:51-70', '37:99-111', '4:125', '16:120-123', '3:67', '14:35-41'] },
    { id: 'noah', title: 'Noah (Nuh)', match: 'noah nuh ark flood', terms: 'noah ark flood', seeds: ['71:1-28', '11:25-48', '7:59-64', '37:75-82', '54:9-15', '29:14-15'] },
    { id: 'joseph', title: 'Joseph (Yusuf)', match: 'joseph yusuf jacob yaqub dream brothers egypt', terms: 'joseph jacob', seeds: ['12:3-6', '12:18', '12:23-29', '12:87', '12:90-92', '12:101'] },
    { id: 'adam', title: 'Adam and the first humans', match: 'adam eve hawa first human garden fall', terms: 'adam', seeds: ['2:30-39', '7:11-27', '4:1', '20:115-123', '15:26-43'] },
    { id: 'angels', title: 'Angels', match: 'angel angels malaika gabriel jibril jibreel mikail israfil', terms: 'angels angel', seeds: ['2:30-34', '35:1', '2:97-98', '50:17-18', '66:6', '82:10-12', '13:11', '40:7', '21:19-20', '2:285'] },
    { id: 'jinn', title: 'Jinn', match: 'jinn jin genie genies demons', terms: 'jinn', seeds: ['72:1-15', '51:56', '18:50', '55:14-15', '46:29-32', '6:130', '15:27', '27:17', '34:12-14'] },
    { id: 'satan', title: 'Satan (Iblis / Shaytan)', match: 'satan shaytan shaitan iblis devil devils whisper whispers', terms: 'devil satan iblis', seeds: ['7:11-18', '2:34', '15:28-42', '14:22', '38:71-85', '7:200-201', '114:1-6', '35:6', '17:53', '2:168-169'] },
    { id: 'paradise', title: 'Paradise (Jannah)', match: 'paradise heaven jannah jannat garden gardens rivers hereafter reward', terms: 'gardens rivers paradise reward', seeds: ['2:25', '89:27-30', '56:10-40', '55:46-78', '3:133', '9:72', '47:15', '32:17', '13:35', '44:51-57', '76:12-22'] },
    { id: 'hell', title: 'Hell (Jahannam)', match: 'hell hellfire jahannam fire punishment torment doom', terms: 'hell fire doom', seeds: ['4:56', '67:6-11', '74:26-31', '104:4-9', '66:6', '39:71-72', '14:16-17', '15:43-44'] },
    { id: 'judgement', title: 'The Day of Judgement', match: 'judgement judgment judgment day day of resurrection last day reckoning accountable accountability qiyamah qiyama', terms: 'day judgment reckoning resurrection', seeds: ['99:1-8', '101:1-11', '82:1-19', '81:1-14', '39:68-75', '18:49', '21:47', '1:4', '75:1-15', '69:13-37', '80:33-42'] },
    { id: 'resurrection', title: 'Resurrection and life after death', match: 'resurrection resurrected raised afterlife after death graves bones', terms: 'raise bones dead quicken', seeds: ['36:77-83', '75:3-4', '22:5-7', '36:51-53', '17:49-52', '50:3-4', '30:19', '2:28', '2:259-260'] },
    { id: 'death', title: 'Death', match: 'death die dying dead mortality soul taken', terms: 'death die soul taste', seeds: ['3:185', '21:35', '29:57', '67:2', '4:78', '62:8', '3:145', '39:42', '2:156', '63:10-11', '32:11', '56:83-87'] },
    { id: 'qadar', title: 'Divine decree and destiny (qadar)', match: 'destiny fate decree predestination qadar qadr preordained written', terms: 'decree ordained book leave', seeds: ['57:22-23', '9:51', '64:11', '87:2-3', '25:2', '6:59', '54:49', '35:11', '3:145'] },
    { id: 'freewill', title: 'Free will and guidance', match: 'free will choice choose freewill guidance guided misguided responsibility', terms: 'will guide whom choose', seeds: ['18:29', '76:3', '76:29-30', '10:99', '2:256', '90:10', '91:7-10', '81:28-29', '28:56', '13:11', '6:104'] },
    { id: 'repentance', title: 'Repentance (tawbah)', match: 'repent repentance tawbah tauba turn back sins forgiven forgive me sinned', terms: 'repent repentance forgive forgiving', seeds: ['39:53', '66:8', '20:82', '9:104', '25:70-71', '4:110', '3:135', '42:25', '11:3', '4:17-18'] },
    { id: 'forgiveness', title: 'Forgiveness and pardon', match: 'forgive forgiveness forgiving pardon pardoning mercy merciful', terms: 'forgive pardon merciful mercy', seeds: ['39:53', '3:134', '24:22', '42:40', '42:43', '64:14', '7:199', '2:286', '4:110', '3:135', '41:34', '42:37', '4:48'] },
    { id: 'mercy', title: 'God’s mercy', match: 'mercy merciful rahma rahmah compassion compassionate kind', terms: 'mercy merciful', seeds: ['7:156', '1:1-3', '6:12', '39:53', '21:107', '15:49', '6:54', '2:218', '12:64', '17:24', '30:50'] },
    { id: 'patience', title: 'Patience (sabr)', match: 'patience patient sabr sabar persevere perseverance endure hardship hardships trial trials test tested difficulties difficulty', terms: 'patience patient steadfast persevere endure', seeds: ['2:153', '2:155-157', '3:200', '103:1-3', '94:5-6', '39:10', '2:45', '16:127', '29:2-3', '12:18', '3:186', '2:286', '31:17', '11:115', '70:5'] },
    { id: 'trust', title: 'Trust in God (tawakkul)', match: 'trust tawakkul tawakul rely reliance depend worry worried anxious anxiety provision provide rizq sustenance', terms: 'trust provide sustenance', seeds: ['3:159', '3:173', '33:3', '65:3', '9:51', '11:6', '25:58', '14:12', '29:60', '13:28', '94:5-6', '2:286', '12:87'] },
    { id: 'gratitude', title: 'Gratitude (shukr)', match: 'grateful gratitude thank thankful thanks shukr blessings blessing', terms: 'thankful thank grateful give thanks', seeds: ['14:7', '2:152', '16:18', '39:7', '31:12', '14:34', '55:13', '27:40', '2:172', '34:13', '2:243'] },
    { id: 'dua', title: 'Supplication (dua)', match: 'dua duaa supplication supplicate ask call upon invoke answer prayers answered', terms: 'call pray supplication answer', seeds: ['2:186', '40:60', '7:55-56', '20:25-28', '2:201', '25:74', '3:38', '21:87-88', '27:62', '7:180', '14:40-41', '25:77'] },
    { id: 'dhikr', title: 'Remembrance of God (dhikr)', match: 'remember remembrance dhikr zikr thikr remembering hearts rest peace of heart', terms: 'remember remembrance', seeds: ['13:28', '2:152', '33:41-42', '29:45', '20:14', '3:191', '8:2', '62:10', '63:9', '7:205', '20:124', '33:35'] },
    { id: 'parents', title: 'Parents', match: 'parents parent mother father mom dad obey honour honor kindness to parents family', terms: 'parents mother father', seeds: ['17:23-24', '31:14-15', '46:15', '4:36', '2:83', '6:151', '29:8', '19:14', '19:32', '2:215', '14:41'] },
    { id: 'children', title: 'Children', match: 'children child kids son daughter daughters sons raising infanticide', terms: 'children offspring son daughter', seeds: ['17:31', '6:151', '66:6', '18:46', '31:13-19', '16:58-59', '42:49-50', '81:8-9', '2:233', '25:74', '64:15'] },
    { id: 'marriage', title: 'Marriage', match: 'marriage marry married wife wives husband spouse spouses nikah dowry mahr polygamy', terms: 'marry wives husband wife mates', seeds: ['30:21', '4:3', '4:4', '24:32', '4:19', '4:129', '4:35', '2:221', '4:22-23', '5:5', '4:21', '7:189', '25:74', '2:235', '4:34-35'], note: 'Verses on marital life (4:3, 4:34, 4:129…) are read by scholars together and in their context; no single verse is the whole teaching, and rulings belong to qualified scholars.' },
    { id: 'divorce', title: 'Divorce', match: 'divorce divorced talaq iddah iddat waiting period separation', terms: 'divorce divorced waiting', seeds: ['2:228-232', '65:1-7', '2:241', '4:35', '4:128-130', '2:226-227', '2:236-237', '33:49'] },
    { id: 'women', title: 'Women', match: 'women woman female girls girl gender equality mothers', terms: 'women woman', seeds: ['4:1', '3:195', '33:35', '4:124', '4:32', '2:228', '16:97', '4:7', '4:19', '24:30-31', '49:13', '9:71', '30:21'] },
    { id: 'inheritance', title: 'Inheritance', match: 'inheritance inherit heirs will wills estate shares legacy', terms: 'inherit heirs legacy share', seeds: ['4:7', '4:11-12', '4:13-14', '4:176', '2:180', '4:8', '4:33', '2:181-182', '89:19'] },
    { id: 'orphans', title: 'Orphans', match: 'orphan orphans fatherless', terms: 'orphan orphans', seeds: ['93:6-9', '4:10', '2:220', '4:2', '4:6', '17:34', '107:1-3', '89:17', '90:12-16', '76:8', '2:177', '4:36'] },
    { id: 'neighbours', title: 'Neighbours and the needy', match: 'neighbour neighbor neighbours neighbors traveller wayfarer kindness kind', terms: 'neighbour wayfarer needy kinsman', seeds: ['4:36', '2:177', '2:83', '17:26', '30:38', '76:8-9', '107:1-7', '90:12-17', '51:19', '2:273'] },
    { id: 'justice', title: 'Justice', match: 'justice just fair fairness unjust injustice oppression oppressed witness testimony', terms: 'justice just witness equity', seeds: ['4:135', '5:8', '16:90', '4:58', '57:25', '6:152', '38:26', '7:29', '55:7-9', '49:9', '42:42', '60:8'] },
    { id: 'honesty', title: 'Honesty, truth and lying', match: 'honest honesty truth truthful lie lying liar lies deceit deceive cheat cheating', terms: 'truth truthful lie liar false', seeds: ['9:119', '33:70-71', '16:105', '2:42', '17:36', '83:1-3', '17:35', '2:188', '61:2-3', '2:283', '4:107'] },
    { id: 'promise', title: 'Promises, trusts and contracts', match: 'promise promises covenant covenants contract contracts agreement trust amanah oath oaths', terms: 'covenant promise trust oath', seeds: ['5:1', '17:34', '16:91', '23:8', '2:177', '4:58', '8:27', '3:76', '5:89', '33:72', '2:282', '70:32'] },
    { id: 'backbiting', title: 'Backbiting, mockery and suspicion', match: 'backbite backbiting gossip slander mock mocking ridicule insult suspicion spy spying nicknames', terms: 'backbite suspicion spy deride', seeds: ['49:11-12', '104:1', '24:19', '24:11-16', '24:23', '83:29-33', '33:58', '68:10-13', '24:4'] },
    { id: 'arrogance', title: 'Arrogance and humility', match: 'arrogant arrogance pride proud humble humility boast boasting show off', terms: 'pride proud arrogant humble boast scorn', seeds: ['31:18-19', '17:37', '7:146', '16:23', '25:63', '7:12-13', '28:83', '40:35', '57:23', '7:40', '4:36', '2:34'] },
    { id: 'anger', title: 'Anger and self-control', match: 'anger angry rage temper control restrain', terms: 'anger wrath restrain', seeds: ['3:134', '42:37', '42:43', '7:199', '41:34-35', '13:22', '25:63', '23:96', '3:159'] },
    { id: 'envy', title: 'Envy and jealousy', match: 'envy envious jealous jealousy hasad evil eye', terms: 'envy envious envier', seeds: ['113:1-5', '4:54', '2:109', '4:32', '12:5', '28:79-82'] },
    { id: 'wealth', title: 'Wealth and worldly life', match: 'wealth rich money materialism possessions worldly dunya greed hoarding luxury', terms: 'wealth world life riches hoard', seeds: ['102:1-8', '104:1-4', '57:20', '63:9', '3:14', '28:76-82', '18:45-46', '9:34-35', '92:8-11', '17:26-29', '89:20', '100:8', '8:28', '64:15'] },
    { id: 'poverty', title: 'Poverty and the poor', match: 'poor poverty needy hunger hungry beggar begging homeless', terms: 'poor needy destitute beggar', seeds: ['2:273', '93:9-10', '107:1-7', '2:177', '76:8-9', '89:17-18', '70:24-25', '90:11-16', '9:60', '2:268', '51:19'] },
    { id: 'riba', title: 'Interest and usury (riba)', match: 'interest usury riba loan loans lending debt debts mortgage bank', terms: 'usury debt loan', seeds: ['2:275-280', '3:130', '30:39', '2:282', '2:283', '2:245', '57:11'] },
    { id: 'trade', title: 'Trade, business and fair dealing', match: 'trade business buying selling sell buy merchant commerce measure weight cheating fraud scales', terms: 'trade measure weight balance fraud', seeds: ['4:29', '83:1-3', '2:282', '17:35', '26:181-183', '6:152', '11:85', '2:188', '5:1', '2:275', '55:7-9', '62:9-10'] },
    { id: 'alcohol', title: 'Intoxicants and gambling', match: 'alcohol wine drink drinking intoxicant intoxicants drunk beer liquor gambling gamble lottery betting khamr', terms: 'strong drink wine intoxicant games of chance', seeds: ['5:90-91', '2:219', '4:43'] },
    { id: 'food', title: 'Food: lawful and unlawful', match: 'food eat eating pork pig swine meat slaughter carrion blood diet dietary', terms: 'eat food swine carrion lawful forbidden', seeds: ['2:172-173', '5:3', '5:4-5', '6:145', '16:114-115', '5:96', '7:31', '5:1', '5:87-88', '2:168', '6:118-121'] },
    { id: 'modesty', title: 'Modesty, dress and the hijab', match: 'hijab modesty modest dress clothing veil cover covering gaze lower gaze niqab awrah', terms: 'modesty veils cloaks lower gaze adornment', seeds: ['24:30-31', '33:59', '7:26', '24:60', '24:58-59', '33:32-33'], note: '33:32-33 address the Prophet’s wives specifically; scholars differ on how far such verses extend to others.' },
    { id: 'adultery', title: 'Chastity and adultery (zina)', match: 'adultery fornication zina chastity chaste unlawful sex sexual relationship relationships dating boyfriend girlfriend', terms: 'adultery chaste lewd', seeds: ['17:32', '24:2-3', '25:68-70', '23:5-7', '24:30-31', '12:23-24', '33:35', '24:4-5', '24:33', '4:15-16'], note: 'Scholars understand 24:2 to have superseded the earlier procedure in 4:15-16; the legal detail belongs to them.' },
    { id: 'homosexuality', title: 'The people of Lot', match: 'lut sodom homosexuality homosexual gay lgbt', phrases: ['people of lot', 'folk of lot', 'prophet lot', 'story of lot'], terms: 'lot lust', seeds: ['7:80-84', '26:160-175', '27:54-58', '11:77-83', '29:28-35', '15:61-77', '54:33-39', '21:74-75'], note: 'These are the narratives of the people of Lot; questions of law and of pastoral care belong to qualified scholars.' },
    { id: 'killing', title: 'The sanctity of life and killing', match: 'kill killing murder murdered life sanctity innocent terrorism terrorist violence', terms: 'slay slain kill soul', seeds: ['5:32', '17:33', '6:151', '5:27-31', '4:93', '25:68', '17:31', '81:8-9', '2:178-179', '4:92'] },
    { id: 'suicide', title: 'Harming oneself', match: 'suicide kill myself kill yourself self harm selfharm end my life', terms: 'kill yourselves', seeds: ['2:195', '39:53', '2:286', '93:3-5', '94:5-6', '13:28', '2:153', '12:87', '4:29'] },
    { id: 'war', title: 'Fighting, war and peace', match: 'war fight fighting jihad battle enemy enemies peace treaty aggression self defence defense violence', terms: 'fight fighting war peace aggress', seeds: ['2:190-194', '8:61', '60:8-9', '22:39-40', '2:256', '9:6', '4:90', '4:94', '8:60-61', '49:9-10', '5:8', '4:75', '2:216', '47:4', '9:4-7', '9:29'], note: 'The fighting verses were revealed amid particular wars and treaties. The general rules come first here — fight only those who fight you, do not transgress, incline to peace, keep treaties, no compulsion in religion — and scholars read the specific verses with that context.' },
    { id: 'peace', title: 'Peace and reconciliation', match: 'peace peaceful reconcile reconciliation harmony salam', terms: 'peace reconcile make peace', seeds: ['8:61', '49:9-10', '4:128', '4:114', '10:25', '4:94', '25:63', '41:34', '60:8', '59:23'] },
    { id: 'brotherhood', title: 'Brotherhood, unity and community', match: 'brotherhood brothers brother unity united ummah community division divided sect sects', terms: 'brothers brethren unite rope divide', seeds: ['49:10', '3:103', '9:71', '3:105', '8:46', '59:9', '23:52', '21:92', '42:13', '6:159', '30:31-32', '49:13'] },
    { id: 'equality', title: 'Human equality, race and nations', match: 'race racism racist equality equal colour color tribes nations ethnicity diversity languages', terms: 'tribes nations colours languages know one another', seeds: ['49:13', '30:22', '4:1', '17:70', '49:11', '35:28', '2:213', '5:48'] },
    { id: 'knowledge', title: 'Knowledge and learning', match: 'knowledge learn learning study education scholar scholars science wisdom reason think reflect ponder read', terms: 'knowledge know wisdom reflect ponder think read', seeds: ['96:1-5', '20:114', '39:9', '58:11', '35:28', '2:269', '3:190-191', '2:31-33', '12:76', '16:43', '17:36', '18:66', '41:53', '29:20', '67:10'] },
    { id: 'creation', title: 'Creation of the universe and of humans', match: 'creation created create universe heavens earth big bang cosmos human embryo womb clot', terms: 'created create heavens earth clot womb', seeds: ['21:30', '41:9-12', '23:12-14', '7:54', '96:1-2', '32:7-9', '22:5', '51:47', '36:36', '55:1-13', '24:45', '30:20-25', '2:30-34', '67:3-4', '86:5-7'] },
    { id: 'nature', title: 'Nature, animals and the environment', match: 'nature animals animal environment earth trees plants water sea rain mountains birds bees cattle corruption pollution', terms: 'cattle birds bees rain mountains sea corruption land', seeds: ['6:38', '30:41', '7:56', '16:68-69', '16:5-8', '24:41', '17:44', '2:164', '27:18-19', '7:31', '2:205', '21:30', '55:7-10', '6:141', '67:19'] },
    { id: 'health', title: 'Health, healing and illness', match: 'health healing heal sick sickness illness ill disease cure medicine honey doctor', terms: 'healing heal sick disease honey', seeds: ['17:82', '26:78-81', '16:69', '21:83-84', '38:41-42', '10:57', '41:44', '2:184', '24:61', '2:195'] },
    { id: 'grief', title: 'Grief, sadness and consolation', match: 'sad sadness grief grieve grieving sorrow depressed depression loss lost loved one pain hurt hurting lonely despair hopeless hope', terms: 'grieve grief sorrow despair hope', seeds: ['94:1-8', '93:1-11', '2:286', '3:139', '12:87', '12:84-86', '39:53', '9:40', '20:46', '13:28', '2:153', '2:155-157', '57:22-23', '19:24-26'] },
    { id: 'fear', title: 'Fear and reassurance', match: 'fear afraid scared frightened worry worried anxiety anxious calm reassurance', terms: 'fear grieve afraid', seeds: ['2:38', '3:139', '9:40', '3:173-175', '20:46', '26:61-62', '46:13', '10:62-64', '41:30', '13:28'] },
    { id: 'hope', title: 'Hope in God', match: 'hope hopeful hopeless give up despair giving up', terms: 'despair hope mercy', seeds: ['39:53', '12:87', '93:3-5', '15:56', '94:5-6', '65:3', '7:56', '2:218', '17:57', '30:36'] },
    { id: 'sincerity', title: 'Sincerity and intention', match: 'sincere sincerity intention intentions niyyah ikhlas showing off riya', terms: 'sincere sincerity show off', seeds: ['98:5', '39:2-3', '18:110', '39:11', '7:29', '107:4-7', '76:8-9', '2:264', '4:142', '6:162-163'] },
    { id: 'taqwa', title: 'God-consciousness (taqwa)', match: 'taqwa piety pious righteous righteousness godfearing conscious consciousness', terms: 'righteous dutiful ward off evil keep duty', seeds: ['2:177', '49:13', '65:2-3', '3:102', '2:197', '2:183', '7:26', '3:133-136', '22:37', '3:76', '8:29', '2:2-5'] },
    { id: 'friday', title: 'Friday prayer and the mosque', match: 'friday jummah jumuah jumua mosque masjid congregation', terms: 'friday congregation mosque places of worship', seeds: ['62:9-11', '9:18', '72:18', '24:36-37', '9:108', '17:1', '2:125', '2:114', '7:31'] },
    { id: 'quranrecite', title: 'Reciting and reflecting on the Qur’an', match: 'recite recitation memorise memorize hifz reflect tafsir understanding', terms: 'recite recitation reflect ponder', seeds: ['73:4', '47:24', '38:29', '4:82', '7:204', '16:98', '17:106', '75:16-18', '54:17', '2:121', '35:29'] },
    { id: 'hereafter', title: 'This life and the hereafter', match: 'hereafter afterlife akhirah akhira next life eternal eternity', terms: 'hereafter world life eternal', seeds: ['87:16-17', '28:77', '29:64', '57:20', '18:45-46', '42:20', '17:18-19', '3:185', '6:32', '40:39', '93:4'] },
    { id: 'nightofpower', title: 'Laylat al-Qadr, the Night of Power', match: 'laylatul qadr laylat al qadr night of power night of decree thousand months', terms: 'night power thousand months', seeds: ['97:1-5', '44:3-4', '2:185'] },
    { id: 'hypocrisy', title: 'Hypocrisy', match: 'hypocrite hypocrites hypocrisy munafiq munafiqun two faced', terms: 'hypocrites hypocrite', seeds: ['63:1-4', '2:8-16', '4:142-143', '4:145', '9:67-68', '9:75-77', '24:47-50'] },
    { id: 'peopleofbook', title: 'Jews, Christians and the People of the Book', match: 'jews jewish christians christian people of the book bible torah gospel church interfaith other religions', terms: 'people scripture jews christians torah gospel', seeds: ['3:64', '29:46', '5:69', '2:62', '5:82', '5:5', '5:44-48', '3:113-115', '3:199', '2:136', '60:8', '2:256', '22:40'], note: 'Some verses address particular communities of the Prophet’s time; the general rule of courteous argument and justice (29:46, 60:8) frames them.' },
    { id: 'tolerance', title: 'Religious freedom and tolerance', match: 'tolerance tolerate compulsion force forced conversion convert freedom of religion coexist', terms: 'compulsion religion believe disbelieve', seeds: ['2:256', '109:1-6', '10:99', '18:29', '6:108', '60:8', '16:125', '50:45', '42:48', '11:118', '5:48', '88:21-22'] },
    { id: 'dawah', title: 'Inviting others to faith (dawah)', match: 'dawah da’wah invite inviting preach preaching convince argue debate', terms: 'call invite wisdom fair exhortation argue', seeds: ['16:125', '41:33', '3:104', '12:108', '29:46', '88:21-22', '3:110', '28:56', '3:20', '5:67', '10:99'] },
    { id: 'leadership', title: 'Leadership and consultation (shura)', match: 'leader leadership ruler rulers government authority obey those in authority consultation shura politics', terms: 'authority counsel consult obey', seeds: ['42:38', '3:159', '4:59', '4:58', '27:32-34', '28:26', '2:247', '2:124', '38:26', '5:8', '21:73'] },
    { id: 'migration', title: 'Migration and refugees (hijrah)', match: 'migration migrate hijrah hijra refugee refugees emigrate emigrants flee persecution', terms: 'emigrate fled homes driven out', seeds: ['4:97-100', '8:72-75', '59:8-9', '9:40', '16:41', '3:195', '2:218', '9:100', '22:58', '29:56'] },
    { id: 'time', title: 'Time and its value', match: 'time waste wasting procrastinate procrastination life short', terms: 'time age declining day loss', seeds: ['103:1-3', '63:9-11', '23:99-100', '35:37', '7:34', '25:62', '71:4', '31:34'] },
    { id: 'sleep', title: 'Sleep, night and day', match: 'sleep sleeping night day rest', terms: 'sleep night day rest repose', seeds: ['25:47', '78:9-11', '30:23', '39:42', '51:17-18', '32:16', '17:79', '10:67', '28:73'] },
    { id: 'dreams', title: 'Dreams and visions', match: 'dream dreams vision visions interpretation interpret', terms: 'dream dreams vision interpretation', seeds: ['12:4-6', '12:36-41', '12:43-49', '12:100-101', '37:102-105', '48:27', '17:60', '8:43'] },
    { id: 'friends', title: 'Friendship and company', match: 'friend friends friendship companions company good company bad company', terms: 'friend friends companion', seeds: ['43:67', '25:27-29', '18:28', '9:71', '3:103', '8:63', '4:69', '49:11-12', '60:8-9', '49:10'] },
    { id: 'speech', title: 'Speech, manners and kindness', match: 'speak speech words kind kindness gentle gently manners etiquette rude harsh tongue', terms: 'kindly gentle word goodly soft speech', seeds: ['17:53', '2:83', '20:44', '31:19', '4:86', '2:263', '41:34', '33:70', '25:63', '17:28', '50:18', '3:159', '16:125', '14:24-26'] },
    { id: 'love', title: 'Love', match: 'love loves loved loving beloved affection', terms: 'love loveth loves affection', seeds: ['3:31', '30:21', '2:165', '5:54', '19:96', '2:195', '3:134', '9:24', '3:92', '60:7', '49:7'] },
    { id: 'guidance', title: 'Guidance and the straight path', match: 'guidance guide guided straight path misguidance lost way', terms: 'guide guidance straight path', seeds: ['1:5-7', '2:2', '6:153', '29:69', '2:256', '13:27', '39:23', '76:3', '28:56', '64:11', '6:125'] },
    { id: 'signs', title: 'Signs of God and reflection', match: 'signs sign ayah miracle miracles proof proofs reflect think evidence', terms: 'signs portents reflect men of understanding', seeds: ['3:190-191', '2:164', '30:20-25', '41:53', '67:3-4', '36:33-40', '51:20-21', '16:10-13', '21:30', '45:3-5', '88:17-20', '6:95-99', '10:5-6'] },
    { id: 'names', title: 'The names and attributes of God', match: 'names attributes beautiful names asma ul husna ninety nine', terms: 'names knower hearer seer wise mighty', seeds: ['59:22-24', '7:180', '17:110', '20:8', '2:255', '112:1-4', '24:35', '57:3', '2:163', '85:14-16', '6:103', '42:11'] },
    { id: 'evil', title: 'Good and evil, sin and virtue', match: 'evil good sin sins sinful virtue virtuous righteous deeds bad deeds', terms: 'good evil deed sin', seeds: ['99:7-8', '4:31', '53:32', '16:90', '6:160', '91:7-10', '41:34', '3:134-135', '11:114', '7:33', '4:79', '2:177', '103:1-3'] },
    { id: 'purpose', title: 'The purpose of life', match: 'purpose meaning of life why created why are we here existence test', terms: 'created serve worship try test', seeds: ['51:56', '67:2', '23:115', '21:16', '2:30', '76:2-3', '18:7', '3:191', '75:36', '33:72', '2:155', '29:2-3'] },
    { id: 'environment', title: 'Stewardship of the earth', match: 'steward stewardship khalifa caretaker waste excess extravagance extravagant', terms: 'excess prodigal waste corruption', seeds: ['7:31', '6:141', '17:26-27', '30:41', '55:7-9', '2:30', '2:205', '2:60', '7:56', '6:38', '28:77'] },
  ];
  var TOPIC_INDEX = TOPICS.map(function (t) {
    var m = Object.create(null);
    topicTokens(t.match).forEach(function (w) { m[w] = 1; });
    // short phrases ("night of power", "kindness to parents") checked on the raw text
    var phrases = (t.phrases || []).concat(t.match.match(/\b[a-z]+ (?:of|to|in|my)(?: the)? [a-z]+\b/g) || []);
    return { topic: t, stems: m, phrases: phrases };
  });
  // A trigger word shared by many topics ("day", "life") says less than one
  // owned by a single topic ("zakat"): weight by inverse topic frequency.
  var STEM_DF = Object.create(null);
  TOPIC_INDEX.forEach(function (ti) { for (var w in ti.stems) STEM_DF[w] = (STEM_DF[w] || 0) + 1; });
  function matchTopics(question) {
    var toks = topicTokens(question), raw = ' ' + String(question || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ') + ' ';
    var scored = [];
    TOPIC_INDEX.forEach(function (ti) {
      var score = 0, hits = 0, matched = [];
      toks.forEach(function (w) {
        if (!ti.stems[w]) return;
        hits++; matched.push(w);
        score += (GENERIC[w] || 1) / STEM_DF[w];
      });
      ti.phrases.forEach(function (p) { if (raw.indexOf(' ' + p + ' ') >= 0) { hits++; score += 2; matched.push(p); } });
      if (hits) scored.push({ id: ti.topic.id, title: ti.topic.title, hits: hits, score: score, matched: matched, topic: ti.topic });
    });
    scored.sort(function (x, y) { return y.score - x.score || x.id.localeCompare(y.id); });
    return scored.slice(0, 3);
  }

  /* ---------------- scope notes ---------------- */
  var RULING_RE = /\b(haram|halal|haraam|halaal|permissible|permitted|forbidden|allowed|allow|lawful|unlawful|is it (ok|okay|wrong|a sin|sinful)|sin to|can i|may i|am i allowed|ruling|fatwa|fatwah|hukm|makruh|obligatory|fard|wajib|sunnah|bidah)\b/i;
  var DISTRESS_RE = /\b(suicide|suicidal|kill (myself|me)|end (my (own )?life|it all)|want to die|self[\s-]?harm|hurt myself|no reason to live)\b/i;
  // "How can I be patient?" asks for guidance, not a verdict: strip those forms before the ruling test.
  var GUIDANCE_RE = /\b(how|what|where|when|why|who)\s+(can|could|may|should)\s+i\b/gi;
  // Questions the Qur'an does not answer directly. `seeds` are the general
  // principles scholars reason from (shown instead of weak text matches).
  var NOT_IN_QURAN = [
    { re: /\b(music|songs?|singing|instruments?)\b/i, note: 'Music is not addressed directly in the Qur’an; the discussion lives in the Sunnah and the schools of law.', seeds: [] },
    { re: /\b(beard|beards|moustache)\b/i, note: 'The Qur’an mentions a beard once (20:94, Aaron speaking to Moses); rulings about the beard and moustache come from the hadith literature.', seeds: ['20:94'] },
    { re: /\b(eid|eids)\b/i, note: 'The two Eids are not named in the Qur’an; they are established by the Sunnah. The verses on completing Ramadan, gratitude and remembrance are shown.', seeds: ['2:185', '14:7', '2:152'] },
    { re: /\b(how many (daily )?prayers|five (daily )?prayers|5 prayers)\b/i, note: 'The Qur’an commands prayer at set times (shown here); the count of five and their form come from the Sunnah.', seeds: ['4:103', '17:78', '11:114', '20:130', '30:17-18'] },
    { re: /\b(smoking|smokers?|cigarettes?|cigars?|tobacco|nicotine|shisha|hookah|vap(e|ing))\b|\bto smoke\b|\b(i|we|you|they|muslims?|people) smoke\b/i, note: 'Smoking is not mentioned in the Qur’an; scholars reason from its general principles about harm and waste, shown here.', seeds: ['2:195', '4:29', '7:31', '17:26-27'] },
    { re: /\b(hadith|hadiths|ahadith|bukhari|muslim collection|sunan)\b/i, note: 'Furqan only quotes the Qur’an. Hadith are a separate body of texts with their own sciences of verification.', seeds: [] },
  ];
  // Words that say "ruling" rather than "subject": they drive the note, not the search.
  var RULING_WORDS = {};
  'haram halal haraam halaal permissible permitted permit forbidden forbid allowed allow lawful unlawful sin sinful ruling fatwa fatwah hukm makruh obligatory fard wajib bidah ok okay wrong'
    .split(' ').forEach(function (w) { RULING_WORDS[stem(w)] = 1; });
  function scopeNotes(question, found) {
    var notes = [];
    var q = String(question || '');
    if (DISTRESS_RE.test(q)) {
      notes.push({ kind: 'support', text: 'If you are thinking about harming yourself, please reach out now to someone who can help: a trusted person, your doctor, or your local emergency or crisis line. The verses here are for comfort; they are not a substitute for care.' });
    }
    if (RULING_RE.test(q.replace(GUIDANCE_RE, ''))) {
      notes.push({ kind: 'ruling', text: 'This looks like a question about a religious ruling. Furqan shows the verses the Qur’an has on the subject; it does not issue rulings. Rulings are derived by qualified scholars from the Qur’an together with the Sunnah and the scholarly tradition, and often depend on your circumstances — please ask one.' });
    }
    NOT_IN_QURAN.forEach(function (n) { if (n.re.test(q)) notes.push({ kind: 'scope', text: n.note }); });
    if (!found) notes.push({ kind: 'none', text: 'No passage matched closely. Try other words, an Arabic term, a topic from the list, or a reference like 2:255 or Al-Kahf 10.' });
    return notes;
  }

  /* ---------------- passages ---------------- */
  function parseSeed(ref) {
    var m = String(ref).match(/^(\d+):(\d+)(?:-(\d+))?$/);
    return m ? { s: +m[1], a: +m[2], b: m[3] ? +m[3] : +m[2] } : null;
  }
  function passage(ctx, s, a, b, why) {
    var su = surahOf(ctx, s);
    if (!su) return null;
    if (b == null) b = a;
    if (a < 1) a = 1;
    if (b > su.ayat.length) b = su.ayat.length;
    if (b < a) return null;
    var verses = [];
    for (var i = a; i <= b; i++) {
      var d = getVerse(ctx, s, i);
      verses.push({ a: i, ar: d.ar, en: d.en });
    }
    return { s: s, a: a, b: b, name: su.name, en: su.en, label: refLabel(ctx, s, a, b), verses: verses, why: why || 'search' };
  }
  function overlaps(p, s, a, b) { return p.s === s && !(b < p.a || a > p.b); }
  // Merge adjacent ranked verses of one surah into a passage, highest first.
  function mergeHits(ctx, ranked, limit) {
    var out = [], used = Object.create(null);
    for (var i = 0; i < ranked.length && out.length < limit; i++) {
      var d = ctx.docs[ranked[i].i];
      if (used[d.s + ':' + d.a]) continue;
      var a = d.a, b = d.a;
      // extend to neighbours that are also hits (within 2 ranks of relevance)
      var nb = Object.create(null);
      ranked.forEach(function (r) { var x = ctx.docs[r.i]; if (x.s === d.s && r.score >= ranked[i].score * 0.35) nb[x.a] = 1; });
      while (nb[a - 1] && b - a < 4) a--;
      while (nb[b + 1] && b - a < 4) b++;
      for (var k = a; k <= b; k++) used[d.s + ':' + k] = 1;
      var p = passage(ctx, d.s, a, b, 'search');
      p.score = ranked[i].score;
      out.push(p);
    }
    return out;
  }

  /* ---------------- the answer ---------------- */
  // answer(ctx, question, opts) -> { kind, question, reference?, topics, passages, notes, terms }
  function answer(ctx, question, opts) {
    opts = opts || {};
    var limit = opts.limit || 8;
    var q = String(question || '').trim();
    var res = { kind: 'none', question: q, topics: [], passages: [], notes: [], terms: [] };
    var byTopic = opts.topic ? topicById(opts.topic) : null;
    if (!q && !byTopic) { res.notes = scopeNotes(q, false); return res; }

    if (byTopic) {
      res.kind = 'topic'; res.question = byTopic.title; res.topics = [{ id: byTopic.id, title: byTopic.title, matched: [] }];
      var seedPassages = [];
      byTopic.seeds.forEach(function (ref) {
        var sd = parseSeed(ref);
        if (sd && seedPassages.length < limit && !seedPassages.some(function (p) { return overlaps(p, sd.s, sd.a, sd.b); })) {
          var sp = passage(ctx, sd.s, sd.a, sd.b, 'topic'); if (sp) { sp.topic = byTopic.id; seedPassages.push(sp); }
        }
      });
      var tTerms = englishTokens(byTopic.terms), tScores = bm25(ctx.en, tTerms), tRanked = [];
      for (var tk in tScores) tRanked.push({ i: +tk, score: tScores[tk] });
      tRanked.sort(function (x, y) { return y.score - x.score || x.i - y.i; });
      mergeHits(ctx, tRanked.slice(0, 40), limit).forEach(function (p) {
        if (seedPassages.length < limit && !seedPassages.some(function (x) { return overlaps(x, p.s, p.a, p.b); })) seedPassages.push(p);
      });
      res.passages = seedPassages; res.terms = tTerms;
      res.notes = byTopic.note ? [{ kind: 'scope', text: byTopic.note }] : [];
      return res;
    }

    var ref = parseReference(ctx, q);
    var named = !ref && surahMentioned(ctx, q);
    if (named) { ref = clampRef(ctx, named, null, null); res.named = true; }
    if (ref && ref.invalid) {
      res.kind = 'reference'; res.reference = ref;
      res.notes = [{ kind: 'scope', text: refLabel(ctx, ref.s, 1, ref.max).replace(/ 1-\d+$/, '') + ' has ' + ref.max + ' ayat.' }];
      return res;
    }
    if (ref) {
      res.kind = 'reference'; res.reference = ref;
      var su = surahOf(ctx, ref.s);
      res.surah = { n: su.n, name: su.name, en: su.en, ar: su.ar, rev: su.rev, ayat: su.ayat.length };
      var cap = ref.whole ? Math.min(su.ayat.length, opts.wholeLimit || 300) : Math.min(ref.b, ref.a + 60);
      res.passages = [passage(ctx, ref.s, ref.a, cap, 'reference')];
      if (ref.whole && cap < su.ayat.length) res.notes.push({ kind: 'scope', text: 'Showing the first ' + cap + ' of ' + su.ayat.length + ' ayat — open the surah in Browse for all of it.' });
      if (res.named) res.notes.unshift({ kind: 'scope', text: 'You named ' + su.name + ', so here is the surah itself. To search inside it, ask in words without the name.' });
      return res;
    }

    var topics = matchTopics(q);
    res.topics = topics.map(function (t) { return { id: t.id, title: t.title, matched: t.matched }; });

    var outside = NOT_IN_QURAN.filter(function (n) { return n.re.test(q); });

    // search terms: the question's own words (minus ruling words) plus the lead topic's terms
    var terms = englishTokens(q).filter(function (t) { return !RULING_WORDS[t]; });
    if (topics.length) englishTokens(topics[0].topic.terms).forEach(function (t) { if (terms.indexOf(t) < 0) terms.push(t); });
    res.terms = terms.slice();
    var scores = bm25(ctx.en, terms);
    if (hasArabic(q)) {
      var arScores = bm25(ctx.ar, arabicTokens(q));
      for (var k in arScores) scores[k] = (scores[k] || 0) + arScores[k] * 1.5;
    }
    var ranked = [];
    for (var di in scores) ranked.push({ i: +di, score: scores[di] });
    ranked.sort(function (x, y) { return y.score - x.score || x.i - y.i; });
    var top = ranked.length ? ranked[0].score : 0;
    ranked = ranked.filter(function (r) { return r.score >= Math.max(1.0, top * 0.25); }).slice(0, 60);

    var passages = [];
    // 0. a subject the Qur'an does not address directly: the principles, and no weak text matches
    if (outside.length) {
      outside.forEach(function (n) {
        n.seeds.forEach(function (ref) {
          var sd = parseSeed(ref);
          if (sd && !passages.some(function (p) { return overlaps(p, sd.s, sd.a, sd.b); })) passages.push(passage(ctx, sd.s, sd.a, sd.b, 'principle'));
        });
      });
      if (!topics.length) ranked = [];
    }
    // 1. the classic passages of the matched topics lead
    topics.slice(0, 2).forEach(function (t, ti) {
      t.topic.seeds.forEach(function (ref) {
        if (passages.length >= limit) return;
        var sd = parseSeed(ref);
        if (!sd) return;
        if (passages.some(function (p) { return overlaps(p, sd.s, sd.a, sd.b); })) return;
        var p = passage(ctx, sd.s, sd.a, sd.b, ti === 0 ? 'topic' : 'topic2');
        if (p) { p.topic = t.id; passages.push(p); }
      });
    });
    // 2. then the best text matches not already shown
    mergeHits(ctx, ranked, limit).forEach(function (p) {
      if (passages.length >= limit) return;
      if (passages.some(function (x) { return overlaps(x, p.s, p.a, p.b); })) return;
      passages.push(p);
    });
    res.passages = passages;
    res.kind = passages.length ? (topics.length ? 'topic' : 'search') : 'none';
    res.notes = scopeNotes(q, passages.length > 0);
    if (topics.length && topics[0].topic.note) res.notes.push({ kind: 'scope', text: topics[0].topic.note });
    return res;
  }

  /* ---------------- verse of the day ---------------- */
  var DAILY = ['2:286', '94:5-6', '2:152', '13:28', '39:53', '3:139', '65:2-3', '2:186', '49:13', '17:23-24', '103:1-3', '112:1-4',
    '55:13', '2:255', '24:35', '93:3-5', '14:7', '2:153', '3:200', '16:90', '4:36', '5:8', '21:107', '33:70-71', '25:63', '31:17-18',
    '42:38', '3:159', '2:177', '9:51', '64:11', '57:20', '10:57', '17:82', '20:114', '96:1-5', '54:17', '7:199', '41:34', '23:1-11',
    '2:201', '3:8', '1:1-7', '67:2', '51:56', '29:69', '2:45', '11:115', '16:97', '30:21', '2:45-46', '18:10', '28:77', '59:22-24',
    '3:190-191', '2:164', '30:22', '49:10', '62:9-10', '2:183'];
  function verseOfDay(ctx, now) {
    var day = Math.floor((now == null ? 0 : now) / DAY);
    var ref = parseSeed(DAILY[hashStr('furqan-day-' + day) % DAILY.length]);
    return passage(ctx, ref.s, ref.a, ref.b, 'daily');
  }

  /* ---------------- Live AI grounding ----------------
   * The model is given the passages and told to explain from them only. Its
   * reply is then CHECKED: every verse it quotes must appear in the real
   * text, every citation must be a real address. Anything it says that is
   * not backed by the passages is a model's opinion, and the page says so. */
  function buildLivePrompt(ctx, question, passages, opts) {
    opts = opts || {};
    var maxChars = opts.maxChars || 7500;   // the hosted proxy truncates at 8,000; the question must survive
    var lines = [];
    lines.push('You are helping a reader understand what the Qur’an says. Below are passages from the Qur’an in the Pickthall translation, selected by a search engine for the question. Rules:');
    lines.push('1. Answer ONLY from these passages. Do not add verses, hadith, rulings, or claims about what the Qur’an says beyond them.');
    lines.push('2. When you quote, quote the translation VERBATIM and cite it as (Surah s:a). Never paraphrase inside quotation marks.');
    lines.push('3. If the passages do not really address the question, say so plainly in the first sentence.');
    lines.push('4. Give no religious rulings (halal/haram verdicts) and no medical, legal or personal advice; say such questions need a qualified scholar or professional.');
    lines.push('5. Be respectful, concise (under ' + (opts.maxWords || 220) + ' words), plain text, no headings. Note that translations are interpretations of the Arabic.');
    lines.push('');
    lines.push('PASSAGES:');
    var qline = 'QUESTION: ' + String(question || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    var used = lines.join('\n').length + qline.length + 2, omitted = 0;
    passages.forEach(function (p) {
      var block = p.verses.map(function (v) { return '(' + p.name + ' ' + p.s + ':' + v.a + ') ' + v.en; }).join('\n');
      if (used + block.length + 1 > maxChars) { omitted++; return; }
      lines.push(block); used += block.length + 1;
    });
    if (omitted) lines.push('(' + omitted + ' further passage' + (omitted === 1 ? '' : 's') + ' omitted for length; they are shown to the reader.)');
    lines.push('');
    lines.push(qline);
    return lines.join('\n');
  }
  function normQuote(s) { return englishTokens(s, true).join(' '); }
  function containsWords(hay, needle) { return (' ' + hay + ' ').indexOf(' ' + needle + ' ') >= 0; }
  function arabicTokenSets(ctx) {
    if (!ctx._arSets) ctx._arSets = ctx.docs.map(function (d) { var set = Object.create(null); arabicTokens(d.ar).forEach(function (t) { set[t] = 1; }); return set; });
    return ctx._arSets;
  }
  // An Arabic quotation is checked by word overlap, because a model quotes in
  // standard orthography and the text is Uthmani: 3/4 of the quote's words
  // (prefixes peeled) must occur in one verse.
  function arabicQuoteFound(ctx, text, candidates) {
    var toks = [], seen = Object.create(null);
    normalizeArabic(text, true).split(' ').forEach(function (w) { if (w && !seen[w]) { seen[w] = 1; toks.push(w); } });
    if (toks.length < 3) return { found: true, short: true };
    var sets = arabicTokenSets(ctx), best = 0, where = -1;
    function score(i) {
      var set = sets[i], n = 0;
      toks.forEach(function (w) {
        if (set[w]) { n++; return; }
        var x = stripLayer(w, AR_CONJ) || w, y = stripLayer(x, AR_PREP) || x, z = stripLayer(y, AR_ART) || y;
        if (set[x] || set[y] || set[z]) n++;
      });
      return n / toks.length;
    }
    for (var c = 0; c < candidates.length; c++) { var sc = score(candidates[c]); if (sc > best) { best = sc; where = candidates[c]; } }
    if (best < 0.75) for (var i = 0; i < sets.length; i++) { var s2 = score(i); if (s2 > best) { best = s2; where = i; if (best >= 0.75) break; } }
    return { found: best >= 0.75, where: where };
  }
  // verifyReply(ctx, reply, passages) ->
  //   { citations: [{ref, s, a, b, valid, inPassages, text}], quotes: [{text, verified, misattributed}], ok, problems }
  // Every quoted span of 20+ characters must occur, word for word, in the real
  // text (first in the quoted passages, then anywhere in the Qur'an); a quote
  // followed by a citation must occur in THAT verse; every citation must be a
  // real address. Short spans are not verse claims and are left alone.
  function verifyReply(ctx, reply, passages) {
    var text = String(reply || '');
    var shown = Object.create(null), shownIdx = [], passageText = [];
    (passages || []).forEach(function (p) {
      passageText.push(p.verses.map(function (v) { return normQuote(v.en); }).join(' '));
      p.verses.forEach(function (v) { shown[p.s + ':' + v.a] = 1; var ix = verseIndex(ctx, p.s, v.a); if (ix >= 0) shownIdx.push(ix); });
    });
    var citations = [], seen = Object.create(null), m;
    function addCitation(s, a, b, matchedText, index) {
      if (b == null || b < a) b = a;
      var ref = s + ':' + a + (b !== a ? '-' + b : '');
      if (seen[ref]) return; seen[ref] = 1;
      var valid = s >= 1 && s <= 114 && a >= 1 && verseIndex(ctx, s, a) >= 0 && verseIndex(ctx, s, b) >= 0;
      var inP = false;
      if (valid) for (var x = a; x <= b; x++) if (shown[s + ':' + x]) inP = true;
      citations.push({ ref: ref, s: s, a: a, b: b, valid: valid, inPassages: inP, text: matchedText, index: index });
    }
    var nre = /(^|[^\d:])(\d{1,3}):(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?(?!\d)/g;
    while ((m = nre.exec(text))) addCitation(+m[2], +m[3], m[4] ? +m[4] : null, m[2] + ':' + m[3] + (m[4] ? '-' + m[4] : ''), m.index + m[1].length);
    // "Surah 2 verse 255", "Surah Al-Baqarah, verse 255", "chapter 18 (The Cave) verses 1 to 3"
    var wre = /\b(?:surah|sura|surat|chapter)\s+(?:([a-z'’-]+(?:\s+[a-z'’-]+){0,3}?)|(\d{1,3}))[\s,]*(?:\([^)]{0,30}\))?[\s,]*(?:verse|verses|ayah|ayat|aya|v\.?)\s*(\d{1,3})(?:\s*(?:-|–|—|to|and)\s*(\d{1,3}))?/gi;
    while ((m = wre.exec(text))) {
      var sNum = m[2] ? +m[2] : (ctx.aliases[aliasKey(m[1])] || 0);
      if (!sNum) continue;   // an unknown name is not struck: we cannot tell what was meant
      addCitation(sNum, +m[3], m[4] ? +m[4] : null, m[0], m.index);
    }
    var quotes = [];
    var qre = /(^|[^A-Za-z؀-ۿ])(?:[“"]([^”"\n]{20,}?)[”"]|«\s*([^»\n]{20,}?)\s*»|[‘']((?:[^‘’'\n]|[’'](?=[A-Za-z])){20,}?)[’'](?![A-Za-z]))/g;
    while ((m = qre.exec(text))) {
      var body = m[2] || m[3] || m[4];
      var raw = body.replace(/^\(?[A-Za-z'’ -]*\d{1,3}:\d{1,3}(?:-\d{1,3})?\)?\s*/, '');   // "(2:153) Seek help…"
      var end = m.index + m[0].length;
      var entry = { text: body, verified: false, misattributed: false };
      if (hasArabic(raw)) {
        var ar = arabicQuoteFound(ctx, raw, shownIdx);
        if (ar.short) continue;
        entry.verified = ar.found; entry.where = ar.where;
      } else {
        var frags = raw.split(/…|\.\.\./).map(normQuote).filter(function (f) { return f.split(' ').length >= 4; });
        if (!frags.length) continue;                 // too short to be a verse claim
        var allIn = frags.every(function (f) { return passageText.some(function (pt) { return containsWords(pt, f); }); });
        var whereDoc = -1;
        if (!allIn) {
          for (var d = 0; d < ctx.docs.length; d++) {
            var hay = normQuote(ctx.docs[d].en);
            if (frags.every(function (f) { return containsWords(hay, f); })) { whereDoc = d; break; }
          }
        }
        entry.verified = allIn || whereDoc >= 0;
        // a citation right after the quote must be the verse the words come from
        if (entry.verified) {
          var after = text.slice(end, end + 40), cm = after.match(/(\d{1,3}):(\d{1,3})(?:\s*[-–]\s*(\d{1,3}))?/);
          if (cm) {
            var cs = +cm[1], ca = +cm[2], cb = cm[3] ? +cm[3] : ca, cited = [];
            for (var y = ca; y <= Math.min(cb, ca + 30); y++) { var vi = verseIndex(ctx, cs, y); if (vi >= 0) cited.push(normQuote(ctx.docs[vi].en)); }
            if (cited.length) {
              var citedText = cited.join(' ');
              if (!frags.every(function (f) { return containsWords(citedText, f); })) { entry.verified = false; entry.misattributed = true; }
            }
          }
        }
      }
      quotes.push(entry);
    }
    var bad = citations.filter(function (c) { return !c.valid; }).length + quotes.filter(function (qq) { return !qq.verified; }).length;
    return { citations: citations, quotes: quotes, ok: bad === 0, problems: bad };
  }

  // The byte stream the builder hashed (scripts/build-furqan-corpus.mjs): the
  // page recomputes its SHA-256 and refuses a file that does not match.
  function integrityStream(quran) {
    var parts = [];
    quran.surahs.forEach(function (su) {
      su.ayat.forEach(function (pair, i) { parts.push(su.n + ':' + (i + 1) + '\u0001' + pair[0] + '\u0001' + pair[1] + '\n'); });
    });
    return parts.join('');
  }

  /* ---------------- misc helpers for the page ---------------- */
  function surahList(ctx) {
    return ctx.quran.surahs.map(function (su) { return { n: su.n, name: su.name, en: su.en, ar: su.ar, rev: su.rev, ayat: su.ayat.length }; });
  }
  function topicList() { return TOPICS.map(function (t) { return { id: t.id, title: t.title }; }); }
  function topicById(id) { for (var i = 0; i < TOPICS.length; i++) if (TOPICS[i].id === id) return TOPICS[i]; return null; }
  function toArabicDigits(n) { return String(n).replace(/[0-9]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'[+d]; }); }
  // integrity: does a loaded file have the canonical shape?
  function checkIntegrity(quran) {
    var problems = [];
    if (!quran || !quran.surahs || quran.surahs.length !== 114) { problems.push('surah count'); return { ok: false, problems: problems }; }
    var n = 0;
    quran.surahs.forEach(function (su, i) {
      if (su.n !== i + 1) problems.push('surah order ' + (i + 1));
      if (!su.ayat || !su.ayat.length) problems.push('empty surah ' + (i + 1));
      else su.ayat.forEach(function (p, k) { if (!p || !p[0] || !p[1]) problems.push('empty ' + (i + 1) + ':' + (k + 1)); });
      n += su.ayat ? su.ayat.length : 0;
    });
    if (n !== 6236) problems.push('verse count ' + n);
    return { ok: problems.length === 0, problems: problems.slice(0, 10), verses: n };
  }

  var E = {
    DAY: DAY, hashStr: hashStr, escapeHTML: escapeHTML,
    normalizeArabic: normalizeArabic, arabicTokens: arabicTokens, hasArabic: hasArabic,
    englishTokens: englishTokens, stem: stem, ARCHAIC: ARCHAIC,
    buildContext: buildContext, bm25: bm25, getVerse: getVerse, verseIndex: verseIndex, surahOf: surahOf, refLabel: refLabel,
    aliasKey: aliasKey, parseReference: parseReference, TOPICS: TOPICS, matchTopics: matchTopics, topicList: topicList, topicById: topicById,
    scopeNotes: scopeNotes, passage: passage, answer: answer, verseOfDay: verseOfDay, DAILY: DAILY,
    buildLivePrompt: buildLivePrompt, verifyReply: verifyReply, surahList: surahList, toArabicDigits: toArabicDigits,
    checkIntegrity: checkIntegrity, integrityStream: integrityStream, parseSeed: parseSeed, topicTokens: topicTokens,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  root.FurqanEngine = E;
})(typeof self !== 'undefined' ? self : this);
