/* Babel — the pure universal-translator engine.
 * =====================================================================
 * Babel is the pocket Babel fish that never phones home: say or type
 * anything — "where is the train station?", "¿dónde está el baño?",
 * "1996", "14:30" — and a wall of 12 languages answers at once, in
 * native script with a romanization underneath. It is honest
 * engineering dressed as Star Trek: it only claims translation where
 * deterministic logic is genuinely correct — a hand-checked traveller
 * phrasebook reachable from any of its 12 languages (typo-tolerant),
 * real-grammar number/time/date spelling (French vigesimals, German
 * compounds, Chinese 零-insertion, Hindi lakh/crore), computed
 * romanization of Cyrillic/Greek/Hangul/kana, reversible signal codecs
 * (Morse, NATO, Braille, Elder Futhark) and Vessel, a round-trippable
 * constructed language. Every rule lives HERE as pure, deterministic,
 * clock-injected functions with zero DOM and zero I/O — unit-tested in
 * scripts/test-babel-logic.mjs, rendered by index.html.
 *
 * Classic script on purpose: it must load in a browser <script>, in the
 * headless smoke sandbox, and via module.exports in the test runner.
 */
(function (root) {
  'use strict';

  var SECOND = 1000, MINUTE = 60 * SECOND, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

  /* ---------------- primitives ---------------- */

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

  // Matching-normalization: strip Latin/Greek/Cyrillic accents (NFD then
  // recompose, so Hangul syllables and kana survive intact), casefold,
  // collapse everything that isn't a letter or digit to single spaces.
  function normalize(s) {
    s = String(s == null ? '' : s);
    try {
      s = s.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
    } catch (e) { /* very old engines: match on raw text */ }
    s = s.toLowerCase().replace(/ς/g, 'σ');
    s = s.replace(/[^\p{L}\p{N}]+/gu, ' ');
    return s.replace(/ +/g, ' ').replace(/^ | $/g, '');
  }

  // Damerau-Levenshtein (optimal string alignment) distance.
  // Three reused rows, not a full matrix — this runs per keystroke
  // against ~500 phrasebook candidates.
  function editDistance(a, b) {
    var la = a.length, lb = b.length, i, j;
    if (!la) return lb;
    if (!lb) return la;
    var prev2 = new Array(lb + 1), prev = new Array(lb + 1), cur = new Array(lb + 1), tmp;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur[0] = i;
      var ca = a.charCodeAt(i - 1);
      for (j = 1; j <= lb; j++) {
        var v = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
        if (prev[j] + 1 < v) v = prev[j] + 1;
        if (cur[j - 1] + 1 < v) v = cur[j - 1] + 1;
        if (i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1) && prev2[j - 2] + 1 < v) {
          v = prev2[j - 2] + 1;
        }
        cur[j] = v;
      }
      tmp = prev2; prev2 = prev; prev = cur; cur = tmp;
    }
    return prev[lb];
  }

  // 1 - editDistance/maxLen over normalized text; 1 for two empties.
  function similarity(a, b) {
    var na = normalize(a), nb = normalize(b);
    var max = Math.max(na.length, nb.length);
    if (!max) return 1;
    return 1 - editDistance(na, nb) / max;
  }

  function round4(x) { return Math.round(x * 10000) / 10000; }

  function tokensOf(s) {
    var out = [], parts = normalize(s).split(' ');
    for (var i = 0; i < parts.length; i++) { if (parts[i]) out.push(parts[i]); }
    return out;
  }

  // Typo-tolerant token equality: one edit for words of 4+, two for 7+.
  function tokenMatches(t, list) {
    for (var i = 0; i < list.length; i++) {
      var u = list[i];
      if (t === u) return true;
      var len = Math.max(t.length, u.length);
      var allowed = len >= 7 ? 2 : len >= 4 ? 1 : 0;
      if (!allowed || Math.abs(t.length - u.length) > allowed) continue;
      if (editDistance(t, u) <= allowed) return true;
    }
    return false;
  }

  function jaccard(a, b) {
    if (!a.length && !b.length) return 1;
    var matched = 0;
    for (var i = 0; i < a.length; i++) { if (tokenMatches(a[i], b)) matched++; }
    var union = a.length + b.length - matched;
    return union ? matched / union : 1;
  }

  /* ---------------- the twelve languages ---------------- */
  // Chosen for script diversity and detection separability: five Latin
  // languages split by stopwords + signature diacritics, seven scripts
  // that identify themselves. Only Arabic runs right-to-left.

  var LANGS = [
    { code: 'en', name: 'English', native: 'English', flag: '🇬🇧', script: 'latin', dir: 'ltr', voice: 'en-GB' },
    { code: 'es', name: 'Spanish', native: 'Español', flag: '🇪🇸', script: 'latin', dir: 'ltr', voice: 'es-ES' },
    { code: 'fr', name: 'French', native: 'Français', flag: '🇫🇷', script: 'latin', dir: 'ltr', voice: 'fr-FR' },
    { code: 'de', name: 'German', native: 'Deutsch', flag: '🇩🇪', script: 'latin', dir: 'ltr', voice: 'de-DE' },
    { code: 'tr', name: 'Turkish', native: 'Türkçe', flag: '🇹🇷', script: 'latin', dir: 'ltr', voice: 'tr-TR' },
    { code: 'ru', name: 'Russian', native: 'Русский', flag: '🇷🇺', script: 'cyrillic', dir: 'ltr', voice: 'ru-RU' },
    { code: 'el', name: 'Greek', native: 'Ελληνικά', flag: '🇬🇷', script: 'greek', dir: 'ltr', voice: 'el-GR' },
    { code: 'ar', name: 'Arabic', native: 'العربية', flag: '🇸🇦', script: 'arabic', dir: 'rtl', voice: 'ar-SA' },
    { code: 'hi', name: 'Hindi', native: 'हिन्दी', flag: '🇮🇳', script: 'devanagari', dir: 'ltr', voice: 'hi-IN' },
    { code: 'zh', name: 'Mandarin', native: '中文', flag: '🇨🇳', script: 'han', dir: 'ltr', voice: 'zh-CN' },
    { code: 'ja', name: 'Japanese', native: '日本語', flag: '🇯🇵', script: 'kana', dir: 'ltr', voice: 'ja-JP' },
    { code: 'ko', name: 'Korean', native: '한국어', flag: '🇰🇷', script: 'hangul', dir: 'ltr', voice: 'ko-KR' }
  ];

  var LANG_BY_CODE = {};
  (function () { for (var i = 0; i < LANGS.length; i++) LANG_BY_CODE[LANGS[i].code] = LANGS[i]; })();

  var CATEGORIES = [
    { id: 'emergency', label: 'Emergency', emoji: '🆘' },
    { id: 'greetings', label: 'Greetings', emoji: '👋' },
    { id: 'essentials', label: 'Essentials', emoji: '💬' },
    { id: 'directions', label: 'Getting around', emoji: '🧭' },
    { id: 'food', label: 'Food & money', emoji: '🍜' }
  ];

  /* ---------------- the phrasebook ---------------- */
  // 36 traveller phrases, hand-translated into all 12 languages.
  // Japanese is stored kana-only, with spaces at particle boundaries, so
  // Hepburn romaji is COMPUTED (never guessed); Russian, Greek and Korean
  // romanization is computed too. Curated transcriptions (r) exist only
  // where an algorithm can't be honest: Arabic, Hindi and Mandarin pinyin.

  var PHRASES = [
    { id: 'help', cat: 'emergency', en: 'Help!', aliases: ['help me', 'help'],
      t: { es: '¡Ayuda!', fr: 'Au secours !', de: 'Hilfe!', tr: 'İmdat!', ru: 'Помогите!', el: 'Βοήθεια!', ar: 'النجدة!', hi: 'मदद कीजिए!', zh: '救命！', ja: 'たすけて！', ko: '도와주세요!' },
      r: { ar: 'an-najda', hi: 'madad kijie', zh: 'jiùmìng' } },
    { id: 'call-police', cat: 'emergency', en: 'Call the police', aliases: ['police', 'call the police please'],
      t: { es: 'Llame a la policía', fr: 'Appelez la police', de: 'Rufen Sie die Polizei', tr: 'Polisi arayın', ru: 'Вызовите полицию', el: 'Καλέστε την αστυνομία', ar: 'اتصل بالشرطة', hi: 'पुलिस को बुलाइए', zh: '请叫警察', ja: 'けいさつを よんで ください', ko: '경찰을 불러 주세요' },
      r: { ar: 'ittasil bish-shurta', hi: 'pulis ko bulaie', zh: 'qǐng jiào jǐngchá' } },
    { id: 'need-doctor', cat: 'emergency', en: 'I need a doctor', aliases: ['doctor please', 'i need a doctor'],
      t: { es: 'Necesito un médico', fr: "J'ai besoin d'un médecin", de: 'Ich brauche einen Arzt', tr: 'Bir doktora ihtiyacım var', ru: 'Мне нужен врач', el: 'Χρειάζομαι γιατρό', ar: 'أحتاج إلى طبيب', hi: 'मुझे डॉक्टर चाहिए', zh: '我需要医生', ja: 'いしゃが ひつようです', ko: '의사가 필요해요' },
      r: { ar: 'ahtaj ila tabib', hi: 'mujhe doctor chahie', zh: 'wǒ xūyào yīshēng' } },
    { id: 'where-hospital', cat: 'emergency', en: 'Where is the hospital?', aliases: ['hospital'],
      t: { es: '¿Dónde está el hospital?', fr: "Où est l'hôpital ?", de: 'Wo ist das Krankenhaus?', tr: 'Hastane nerede?', ru: 'Где больница?', el: 'Πού είναι το νοσοκομείο;', ar: 'أين المستشفى؟', hi: 'अस्पताल कहाँ है?', zh: '医院在哪里？', ja: 'びょういんは どこですか', ko: '병원이 어디예요?' },
      r: { ar: 'ayna al-mustashfa', hi: 'aspatal kahan hai', zh: 'yīyuàn zài nǎlǐ' } },
    { id: 'im-allergic', cat: 'emergency', en: 'I have an allergy', aliases: ["i'm allergic", 'allergy'],
      t: { es: 'Tengo una alergia', fr: "J'ai une allergie", de: 'Ich habe eine Allergie', tr: 'Alerjim var', ru: 'У меня аллергия', el: 'Έχω αλλεργία', ar: 'عندي حساسية', hi: 'मुझे एलर्जी है', zh: '我过敏', ja: 'アレルギーが あります', ko: '알레르기가 있어요' },
      r: { ar: 'indi hasasiyya', hi: 'mujhe allergy hai', zh: 'wǒ guòmǐn' } },
    { id: 'im-lost', cat: 'emergency', en: 'I am lost', aliases: ["i'm lost"],
      t: { es: 'Estoy perdido', fr: 'Je suis perdu', de: 'Ich habe mich verlaufen', tr: 'Kayboldum', ru: 'Я заблудился', el: 'Έχω χαθεί', ar: 'أنا تائه', hi: 'मैं खो गया हूँ', zh: '我迷路了', ja: 'みちに まよいました', ko: '길을 잃었어요' },
      r: { ar: 'ana ta’ih', hi: 'main kho gaya hoon', zh: 'wǒ mílù le' } },

    { id: 'hello', cat: 'greetings', en: 'Hello', aliases: ['hi', 'hey'],
      t: { es: 'Hola', fr: 'Bonjour', de: 'Hallo', tr: 'Merhaba', ru: 'Здравствуйте', el: 'Γεια σας', ar: 'مرحبا', hi: 'नमस्ते', zh: '你好', ja: 'こんにちは', ko: '안녕하세요' },
      r: { ar: 'marhaban', hi: 'namaste', zh: 'nǐ hǎo' } },
    { id: 'good-morning', cat: 'greetings', en: 'Good morning', aliases: [],
      t: { es: 'Buenos días', fr: 'Bonjour', de: 'Guten Morgen', tr: 'Günaydın', ru: 'Доброе утро', el: 'Καλημέρα', ar: 'صباح الخير', hi: 'सुप्रभात', zh: '早上好', ja: 'おはよう ございます', ko: '좋은 아침이에요' },
      r: { ar: 'sabah al-khayr', hi: 'suprabhat', zh: 'zǎoshang hǎo' } },
    { id: 'good-evening', cat: 'greetings', en: 'Good evening', aliases: ['good night'],
      t: { es: 'Buenas noches', fr: 'Bonsoir', de: 'Guten Abend', tr: 'İyi akşamlar', ru: 'Добрый вечер', el: 'Καλησπέρα', ar: 'مساء الخير', hi: 'शुभ संध्या', zh: '晚上好', ja: 'こんばんは', ko: '좋은 저녁이에요' },
      r: { ar: 'masa’ al-khayr', hi: 'shubh sandhya', zh: 'wǎnshang hǎo' } },
    { id: 'goodbye', cat: 'greetings', en: 'Goodbye', aliases: ['bye'],
      t: { es: 'Adiós', fr: 'Au revoir', de: 'Auf Wiedersehen', tr: 'Hoşça kalın', ru: 'До свидания', el: 'Αντίο', ar: 'مع السلامة', hi: 'अलविदा', zh: '再见', ja: 'さようなら', ko: '안녕히 가세요' },
      r: { ar: 'ma’a s-salama', hi: 'alvida', zh: 'zàijiàn' } },
    { id: 'please', cat: 'greetings', en: 'Please', aliases: [],
      t: { es: 'Por favor', fr: "S'il vous plaît", de: 'Bitte', tr: 'Lütfen', ru: 'Пожалуйста', el: 'Παρακαλώ', ar: 'من فضلك', hi: 'कृपया', zh: '请', ja: 'おねがいします', ko: '부탁해요' },
      r: { ar: 'min fadlik', hi: 'kripaya', zh: 'qǐng' } },
    { id: 'thank-you', cat: 'greetings', en: 'Thank you', aliases: ['thanks', 'thank you very much'],
      t: { es: 'Gracias', fr: 'Merci', de: 'Danke', tr: 'Teşekkürler', ru: 'Спасибо', el: 'Ευχαριστώ', ar: 'شكرا', hi: 'धन्यवाद', zh: '谢谢', ja: 'ありがとう ございます', ko: '감사합니다' },
      r: { ar: 'shukran', hi: 'dhanyavad', zh: 'xièxie' } },
    { id: 'excuse-me', cat: 'greetings', en: 'Excuse me', aliases: ['sorry', 'pardon'],
      t: { es: 'Perdón', fr: 'Excusez-moi', de: 'Entschuldigung', tr: 'Affedersiniz', ru: 'Извините', el: 'Συγγνώμη', ar: 'عفوا', hi: 'माफ़ कीजिए', zh: '不好意思', ja: 'すみません', ko: '실례합니다' },
      r: { ar: 'afwan', hi: 'maaf kijie', zh: 'bù hǎoyìsi' } },

    { id: 'yes', cat: 'essentials', en: 'Yes', aliases: [],
      t: { es: 'Sí', fr: 'Oui', de: 'Ja', tr: 'Evet', ru: 'Да', el: 'Ναι', ar: 'نعم', hi: 'हाँ', zh: '是', ja: 'はい', ko: '네' },
      r: { ar: 'na’am', hi: 'haan', zh: 'shì' } },
    { id: 'no', cat: 'essentials', en: 'No', aliases: [],
      t: { es: 'No', fr: 'Non', de: 'Nein', tr: 'Hayır', ru: 'Нет', el: 'Όχι', ar: 'لا', hi: 'नहीं', zh: '不是', ja: 'いいえ', ko: '아니요' },
      r: { ar: 'la', hi: 'nahin', zh: 'bù shì' } },
    { id: 'dont-understand', cat: 'essentials', en: "I don't understand", aliases: ['i do not understand'],
      t: { es: 'No entiendo', fr: 'Je ne comprends pas', de: 'Ich verstehe nicht', tr: 'Anlamıyorum', ru: 'Я не понимаю', el: 'Δεν καταλαβαίνω', ar: 'لا أفهم', hi: 'मुझे समझ नहीं आया', zh: '我不明白', ja: 'わかりません', ko: '이해가 안 돼요' },
      r: { ar: 'la afham', hi: 'mujhe samajh nahin aaya', zh: 'wǒ bù míngbai' } },
    { id: 'speak-english', cat: 'essentials', en: 'Do you speak English?', aliases: ['english'],
      t: { es: '¿Habla inglés?', fr: 'Parlez-vous anglais ?', de: 'Sprechen Sie Englisch?', tr: 'İngilizce biliyor musunuz?', ru: 'Вы говорите по-английски?', el: 'Μιλάτε αγγλικά;', ar: 'هل تتكلم الإنجليزية؟', hi: 'क्या आप अंग्रेज़ी बोलते हैं?', zh: '你会说英语吗？', ja: 'えいごを はなせますか', ko: '영어를 할 수 있어요?' },
      r: { ar: 'hal tatakallam al-injliziyya', hi: 'kya aap angrezi bolte hain', zh: 'nǐ huì shuō yīngyǔ ma' } },
    { id: 'speak-slowly', cat: 'essentials', en: 'Please speak slowly', aliases: ['slower please', 'speak slowly'],
      t: { es: 'Hable más despacio, por favor', fr: "Parlez plus lentement, s'il vous plaît", de: 'Bitte sprechen Sie langsamer', tr: 'Lütfen yavaş konuşun', ru: 'Говорите медленнее, пожалуйста', el: 'Μιλήστε πιο αργά, παρακαλώ', ar: 'تكلم ببطء من فضلك', hi: 'कृपया धीरे बोलिए', zh: '请说慢一点', ja: 'ゆっくり はなして ください', ko: '천천히 말해 주세요' },
      r: { ar: 'takallam bibut’ min fadlik', hi: 'kripaya dheere bolie', zh: 'qǐng shuō màn yìdiǎn' } },
    { id: 'write-down', cat: 'essentials', en: 'Can you write that down?', aliases: ['write it please', 'write it down'],
      t: { es: '¿Puede escribirlo?', fr: "Pouvez-vous l'écrire ?", de: 'Können Sie das aufschreiben?', tr: 'Yazabilir misiniz?', ru: 'Напишите это, пожалуйста', el: 'Μπορείτε να το γράψετε;', ar: 'هل يمكنك كتابتها؟', hi: 'क्या आप इसे लिख सकते हैं?', zh: '请写下来', ja: 'かいて ください', ko: '써 주세요' },
      r: { ar: 'hal yumkinuk kitabatuha', hi: 'kya aap ise likh sakte hain', zh: 'qǐng xiě xiàlái' } },
    { id: 'my-name-is', cat: 'essentials', en: 'My name is…', aliases: ['i am called', 'my name is'],
      t: { es: 'Me llamo…', fr: "Je m'appelle…", de: 'Ich heiße…', tr: 'Benim adım…', ru: 'Меня зовут…', el: 'Με λένε…', ar: 'اسمي…', hi: 'मेरा नाम … है', zh: '我叫…', ja: 'わたしの なまえは…', ko: '제 이름은…' },
      r: { ar: 'ismi…', hi: 'mera naam … hai', zh: 'wǒ jiào…' } },

    { id: 'where-bathroom', cat: 'directions', en: 'Where is the bathroom?', aliases: ['toilet', 'restroom', 'wc', 'loo', 'bathroom', 'where is the toilet'],
      t: { es: '¿Dónde está el baño?', fr: 'Où sont les toilettes ?', de: 'Wo ist die Toilette?', tr: 'Tuvalet nerede?', ru: 'Где туалет?', el: 'Πού είναι η τουαλέτα;', ar: 'أين الحمام؟', hi: 'शौचालय कहाँ है?', zh: '洗手间在哪里？', ja: 'トイレは どこですか', ko: '화장실이 어디예요?' },
      r: { ar: 'ayna al-hammam', hi: 'shauchalay kahan hai', zh: 'xǐshǒujiān zài nǎlǐ' } },
    { id: 'where-station', cat: 'directions', en: 'Where is the train station?', aliases: ['train station', 'the station', 'station'],
      t: { es: '¿Dónde está la estación de tren?', fr: 'Où est la gare ?', de: 'Wo ist der Bahnhof?', tr: 'Tren istasyonu nerede?', ru: 'Где вокзал?', el: 'Πού είναι ο σταθμός του τρένου;', ar: 'أين محطة القطار؟', hi: 'रेलवे स्टेशन कहाँ है?', zh: '火车站在哪里？', ja: 'えきは どこですか', ko: '기차역이 어디예요?' },
      r: { ar: 'ayna mahattat al-qitar', hi: 'railway station kahan hai', zh: 'huǒchēzhàn zài nǎlǐ' } },
    { id: 'where-airport', cat: 'directions', en: 'Where is the airport?', aliases: ['airport'],
      t: { es: '¿Dónde está el aeropuerto?', fr: "Où est l'aéroport ?", de: 'Wo ist der Flughafen?', tr: 'Havalimanı nerede?', ru: 'Где аэропорт?', el: 'Πού είναι το αεροδρόμιο;', ar: 'أين المطار؟', hi: 'हवाई अड्डा कहाँ है?', zh: '机场在哪里？', ja: 'くうこうは どこですか', ko: '공항이 어디예요?' },
      r: { ar: 'ayna al-matar', hi: 'havai adda kahan hai', zh: 'jīchǎng zài nǎlǐ' } },
    { id: 'left', cat: 'directions', en: 'On the left', aliases: ['left'],
      t: { es: 'A la izquierda', fr: 'À gauche', de: 'Links', tr: 'Solda', ru: 'Налево', el: 'Αριστερά', ar: 'على اليسار', hi: 'बाईं ओर', zh: '在左边', ja: 'ひだりです', ko: '왼쪽이에요' },
      r: { ar: 'ala l-yasar', hi: 'bayin or', zh: 'zài zuǒbian' } },
    { id: 'right', cat: 'directions', en: 'On the right', aliases: ['right'],
      t: { es: 'A la derecha', fr: 'À droite', de: 'Rechts', tr: 'Sağda', ru: 'Направо', el: 'Δεξιά', ar: 'على اليمين', hi: 'दाईं ओर', zh: '在右边', ja: 'みぎです', ko: '오른쪽이에요' },
      r: { ar: 'ala l-yamin', hi: 'dayin or', zh: 'zài yòubian' } },
    { id: 'straight-ahead', cat: 'directions', en: 'Straight ahead', aliases: ['straight on', 'go straight'],
      t: { es: 'Todo recto', fr: 'Tout droit', de: 'Geradeaus', tr: 'Düz gidin', ru: 'Прямо', el: 'Ευθεία', ar: 'على طول', hi: 'सीधे', zh: '一直走', ja: 'まっすぐです', ko: '쭉 가세요' },
      r: { ar: 'ala tul', hi: 'seedhe', zh: 'yìzhí zǒu' } },
    { id: 'one-ticket', cat: 'directions', en: 'One ticket, please', aliases: ['a ticket please', 'ticket'],
      t: { es: 'Un billete, por favor', fr: "Un billet, s'il vous plaît", de: 'Eine Fahrkarte, bitte', tr: 'Bir bilet, lütfen', ru: 'Один билет, пожалуйста', el: 'Ένα εισιτήριο, παρακαλώ', ar: 'تذكرة واحدة من فضلك', hi: 'एक टिकट दीजिए', zh: '一张票', ja: 'きっぷを いちまい ください', ko: '표 한 장 주세요' },
      r: { ar: 'tadhkara wahida min fadlik', hi: 'ek ticket dijie', zh: 'yì zhāng piào' } },
    { id: 'taxi-please', cat: 'directions', en: 'A taxi, please', aliases: ['taxi', 'call a taxi'],
      t: { es: 'Un taxi, por favor', fr: "Un taxi, s'il vous plaît", de: 'Ein Taxi, bitte', tr: 'Bir taksi, lütfen', ru: 'Такси, пожалуйста', el: 'Ένα ταξί, παρακαλώ', ar: 'تاكسي من فضلك', hi: 'एक टैक्सी बुलाइए', zh: '请叫出租车', ja: 'タクシーを おねがいします', ko: '택시를 불러 주세요' },
      r: { ar: 'taksi min fadlik', hi: 'ek taxi bulaie', zh: 'qǐng jiào chūzūchē' } },

    { id: 'how-much', cat: 'food', en: 'How much is it?', aliases: ['how much does it cost', 'price', 'how much'],
      t: { es: '¿Cuánto cuesta?', fr: "C'est combien ?", de: 'Wie viel kostet das?', tr: 'Ne kadar?', ru: 'Сколько это стоит?', el: 'Πόσο κάνει;', ar: 'كم الثمن؟', hi: 'यह कितने का है?', zh: '多少钱？', ja: 'いくらですか', ko: '얼마예요?' },
      r: { ar: 'kam ath-thaman', hi: 'yah kitne ka hai', zh: 'duōshao qián' } },
    { id: 'the-bill', cat: 'food', en: 'The bill, please', aliases: ['the check please', 'bill please', 'bill'],
      t: { es: 'La cuenta, por favor', fr: "L'addition, s'il vous plaît", de: 'Die Rechnung, bitte', tr: 'Hesap, lütfen', ru: 'Счёт, пожалуйста', el: 'Τον λογαριασμό, παρακαλώ', ar: 'الحساب من فضلك', hi: 'बिल दीजिए', zh: '买单', ja: 'おかいけいを おねがいします', ko: '계산서 주세요' },
      r: { ar: 'al-hisab min fadlik', hi: 'bill dijie', zh: 'mǎidān' } },
    { id: 'water-please', cat: 'food', en: 'Water, please', aliases: ['water', 'some water please'],
      t: { es: 'Agua, por favor', fr: "De l'eau, s'il vous plaît", de: 'Wasser, bitte', tr: 'Su, lütfen', ru: 'Воды, пожалуйста', el: 'Νερό, παρακαλώ', ar: 'ماء من فضلك', hi: 'पानी दीजिए', zh: '请给我水', ja: 'おみずを ください', ko: '물 주세요' },
      r: { ar: 'ma’ min fadlik', hi: 'paani dijie', zh: 'qǐng gěi wǒ shuǐ' } },
    { id: 'menu-please', cat: 'food', en: 'The menu, please', aliases: ['menu'],
      t: { es: 'El menú, por favor', fr: "La carte, s'il vous plaît", de: 'Die Speisekarte, bitte', tr: 'Menü, lütfen', ru: 'Меню, пожалуйста', el: 'Τον κατάλογο, παρακαλώ', ar: 'قائمة الطعام من فضلك', hi: 'मेनू दीजिए', zh: '请给我菜单', ja: 'メニューを ください', ko: '메뉴판 주세요' },
      r: { ar: 'qa’imat at-ta’am min fadlik', hi: 'menu dijie', zh: 'qǐng gěi wǒ càidān' } },
    { id: 'vegetarian', cat: 'food', en: "I'm vegetarian", aliases: ['no meat', 'i am vegetarian'],
      t: { es: 'Soy vegetariano', fr: 'Je suis végétarien', de: 'Ich bin Vegetarier', tr: 'Vejetaryenim', ru: 'Я вегетарианец', el: 'Είμαι χορτοφάγος', ar: 'أنا نباتي', hi: 'मैं शाकाहारी हूँ', zh: '我吃素', ja: 'ベジタリアンです', ko: '저는 채식주의자예요' },
      r: { ar: 'ana nabati', hi: 'main shakahari hoon', zh: 'wǒ chī sù' } },
    { id: 'delicious', cat: 'food', en: "It's delicious!", aliases: ['very good', 'tasty', 'delicious'],
      t: { es: '¡Está delicioso!', fr: 'C’est délicieux !', de: 'Das ist köstlich!', tr: 'Çok lezzetli!', ru: 'Очень вкусно!', el: 'Πολύ νόστιμο!', ar: 'لذيذ جدا', hi: 'बहुत स्वादिष्ट है', zh: '很好吃！', ja: 'おいしいです', ko: '맛있어요' },
      r: { ar: 'ladhidh jiddan', hi: 'bahut swadisht hai', zh: 'hěn hǎochī' } },
    { id: 'take-cards', cat: 'food', en: 'Do you take cards?', aliases: ['credit card', 'can i pay by card'],
      t: { es: '¿Aceptan tarjetas?', fr: 'Vous acceptez la carte ?', de: 'Kann ich mit Karte zahlen?', tr: 'Kart geçiyor mu?', ru: 'Можно картой?', el: 'Δέχεστε κάρτες;', ar: 'هل تقبلون البطاقات؟', hi: 'क्या कार्ड चलेगा?', zh: '可以刷卡吗？', ja: 'カードは つかえますか', ko: '카드 돼요?' },
      r: { ar: 'hal taqbalun al-bitaqat', hi: 'kya card chalega', zh: 'kěyǐ shuākǎ ma' } },
    { id: 'too-expensive', cat: 'food', en: "That's too expensive", aliases: ['too expensive'],
      t: { es: 'Es demasiado caro', fr: "C'est trop cher", de: 'Das ist zu teuer', tr: 'Çok pahalı', ru: 'Слишком дорого', el: 'Είναι πολύ ακριβό', ar: 'هذا غال جدا', hi: 'यह बहुत महंगा है', zh: '太贵了', ja: 'たかすぎます', ko: '너무 비싸요' },
      r: { ar: 'hadha ghalin jiddan', hi: 'yah bahut mahanga hai', zh: 'tài guì le' } }
  ];

  var PHRASE_BY_ID = {};
  (function () { for (var i = 0; i < PHRASES.length; i++) PHRASE_BY_ID[PHRASES[i].id] = PHRASES[i]; })();

  /* ---------------- language detection ---------------- */
  // Non-Latin scripts identify themselves by codepoint ranges; the five
  // Latin languages are split by stopwords (+2 each) and signature
  // diacritics (+3 each). Evidence strings show WHY a language won.

  var SCRIPT_RANGES = [
    { script: 'cyrillic', lang: 'ru', re: /[Ѐ-ӿ]/ },
    { script: 'greek', lang: 'el', re: /[Ͱ-Ͽ]/ },
    { script: 'arabic', lang: 'ar', re: /[؀-ۿ]/ },
    { script: 'devanagari', lang: 'hi', re: /[ऀ-ॿ]/ },
    { script: 'hangul', lang: 'ko', re: /[가-힯ᄀ-ᇿ㄰-㆏]/ },
    { script: 'kana', lang: 'ja', re: /[぀-ヿ]/ },
    { script: 'han', lang: 'zh', re: /[一-鿿]/ }
  ];

  var STOPWORDS = {
    en: ['the', 'is', 'where', 'you', 'a', 'to', 'of', 'and', 'i', 'it', 'my', 'do', 'please'],
    es: ['el', 'la', 'es', 'donde', 'que', 'de', 'un', 'una', 'por', 'como', 'esta', 'yo', 'favor'],
    fr: ['le', 'la', 'les', 'est', 'ou', 'que', 'de', 'un', 'une', 'vous', 'je', 'sont', 'plait'],
    de: ['der', 'die', 'das', 'ist', 'wo', 'ich', 'sie', 'ein', 'und', 'nicht', 'bitte', 'was'],
    tr: ['bir', 'bu', 'ne', 'nerede', 've', 'icin', 'mi', 'ben', 'var', 'yok', 'lutfen', 'evet']
  };

  var DIACRITICS = {
    es: 'ñ¡¿', fr: 'œêàçùè', de: 'ßäöü', tr: 'ğşıİ'
  };

  function detect(text) {
    text = String(text == null ? '' : text);
    var letters = text.match(/\p{L}/gu) || [];
    if (!letters.length) return { best: null, ranked: [], script: null };

    // 1) script vote — any non-Latin script holding >30% of letters wins.
    var counts = {}, i, j;
    for (i = 0; i < letters.length; i++) {
      for (j = 0; j < SCRIPT_RANGES.length; j++) {
        if (SCRIPT_RANGES[j].re.test(letters[i])) { counts[SCRIPT_RANGES[j].script] = (counts[SCRIPT_RANGES[j].script] || 0) + 1; break; }
      }
    }
    var hasKana = (counts.kana || 0) > 0;
    var bestScript = null, bestShare = 0;
    for (j = 0; j < SCRIPT_RANGES.length; j++) {
      var s = SCRIPT_RANGES[j].script, share = (counts[s] || 0) / letters.length;
      if (share > bestShare) { bestShare = share; bestScript = SCRIPT_RANGES[j]; }
    }
    if (bestScript && bestShare > 0.3) {
      var lang = bestScript.lang;
      // Han characters read as Japanese when any kana is present.
      if (bestScript.script === 'han' && hasKana) lang = 'ja';
      if (bestScript.script === 'kana') lang = 'ja';
      var share2 = bestScript.script === 'han' && hasKana
        ? ((counts.han || 0) + (counts.kana || 0)) / letters.length : bestShare;
      return {
        best: { lang: lang, confidence: round4(share2) },
        ranked: [{ lang: lang, score: round4(share2), evidence: ['script:' + bestScript.script] }],
        script: bestScript.script
      };
    }

    // 2) Latin scoring: stopwords + signature diacritics.
    var toks = normalize(text).split(' ');
    var scores = [], total = 0;
    var latin = ['en', 'es', 'fr', 'de', 'tr'];
    for (i = 0; i < latin.length; i++) {
      var code = latin[i], score = 0, evidence = [];
      var sw = STOPWORDS[code];
      for (j = 0; j < toks.length; j++) {
        if (toks[j] && sw.indexOf(toks[j]) !== -1) { score += 2; evidence.push('stopword:' + toks[j]); }
      }
      var dia = DIACRITICS[code] || '';
      for (j = 0; j < text.length; j++) {
        var sig = text.charAt(j);
        if (dia.indexOf(sig) !== -1 || dia.indexOf(sig.toLowerCase()) !== -1) {
          score += 3; evidence.push('char:' + sig);
        }
      }
      scores.push({ lang: code, raw: score, evidence: evidence });
      total += score;
    }
    scores.sort(function (a, b) { return b.raw - a.raw || (a.lang < b.lang ? -1 : 1); });
    var ranked = [];
    for (i = 0; i < scores.length; i++) {
      if (!scores[i].raw) continue;
      ranked.push({ lang: scores[i].lang, score: round4(scores[i].raw / total), evidence: scores[i].evidence });
    }
    if (!ranked.length || scores[0].raw < 2) return { best: null, ranked: ranked, script: 'latin' };
    var conf = ranked.length > 1 ? ranked[0].score - ranked[1].score : ranked[0].score;
    return { best: { lang: ranked[0].lang, confidence: round4(conf) }, ranked: ranked, script: 'latin' };
  }

  /* ---------------- fuzzy phrase matching ---------------- */
  // Every phrase is reachable from its English text, its aliases, AND all
  // 12 bundled renderings — so "¿dónde está el baño?" and "wher is teh
  // bathrom" both land on where-bathroom. Score = half token-set Jaccard,
  // half Damerau-Levenshtein similarity; ties break by phrase id.

  var MATCH_THRESHOLD = 0.55;

  var CANDIDATES = (function () {
    var out = [], i, j, p;
    for (i = 0; i < PHRASES.length; i++) {
      p = PHRASES[i];
      out.push({ id: p.id, lang: 'en', raw: p.en, norm: normalize(p.en), toks: tokensOf(p.en) });
      for (j = 0; j < p.aliases.length; j++) {
        out.push({ id: p.id, lang: 'en', raw: p.aliases[j], norm: normalize(p.aliases[j]), toks: tokensOf(p.aliases[j]) });
      }
      for (j = 0; j < LANGS.length; j++) {
        var code = LANGS[j].code;
        if (code === 'en') continue;
        out.push({ id: p.id, lang: code, raw: p.t[code], norm: normalize(p.t[code]), toks: tokensOf(p.t[code]) });
      }
    }
    return out;
  })();

  function scoreCandidate(normText, toks, cand) {
    if (!cand.norm) return 0;
    var sim = 1 - editDistance(normText, cand.norm) / Math.max(normText.length, cand.norm.length);
    return round4(0.5 * jaccard(toks, cand.toks) + 0.5 * sim);
  }

  // Best match across all phrases, or null under the threshold.
  function matchPhrase(text) {
    var normText = normalize(text);
    if (!normText) return null;
    var ranked = rankPhrases(text);
    if (!ranked.length || ranked[0].score < MATCH_THRESHOLD) return null;
    var top = ranked[0], p = PHRASE_BY_ID[top.id];
    return {
      id: p.id, cat: p.cat, en: p.en, score: top.score,
      sourceLang: top.sourceLang, matchedText: top.matchedText,
      alternates: ranked.slice(1, 4).map(function (r) { return { id: r.id, en: PHRASE_BY_ID[r.id].en, score: r.score }; })
    };
  }

  // Per-phrase best candidate scores, best first (used for suggestions too).
  function rankPhrases(text) {
    var normText = normalize(text);
    if (!normText) return [];
    var toks = tokensOf(text), best = {}, i;
    for (i = 0; i < CANDIDATES.length; i++) {
      var c = CANDIDATES[i], sc = scoreCandidate(normText, toks, c);
      if (!best[c.id] || sc > best[c.id].score) {
        best[c.id] = { id: c.id, score: sc, sourceLang: c.lang, matchedText: c.raw };
      }
    }
    var list = [];
    for (var id in best) list.push(best[id]);
    list.sort(function (a, b) { return b.score - a.score || (a.id < b.id ? -1 : 1); });
    return list;
  }

  function phrasesByCategory(cat) {
    var ok = false, i;
    for (i = 0; i < CATEGORIES.length; i++) { if (CATEGORIES[i].id === cat) ok = true; }
    if (!ok) throw new Error('unknown category: ' + cat);
    var out = [];
    for (i = 0; i < PHRASES.length; i++) {
      if (PHRASES[i].cat === cat) out.push({ id: PHRASES[i].id, en: PHRASES[i].en });
    }
    return out;
  }

  /* ---------------- number spelling ---------------- */
  // 0..999,999,999 in every language's real grammar. Latin-script
  // languages return roman:null; Arabic/Hindi/Chinese/Japanese assemble
  // curated readings alongside the glyphs; Russian/Greek/Korean romanize
  // the finished text algorithmically.

  var EN_U = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  var EN_T = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

  function en100(n) {
    if (n < 20) return EN_U[n];
    var t = Math.floor(n / 10), u = n % 10;
    return EN_T[t] + (u ? '-' + EN_U[u] : '');
  }
  function en1000(n) {
    var h = Math.floor(n / 100), r = n % 100;
    if (!h) return en100(n);
    return EN_U[h] + ' hundred' + (r ? ' and ' + en100(r) : '');
  }
  function spellEN(n) {
    if (!n) return 'zero';
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, parts = [];
    if (m) parts.push(en1000(m) + ' million');
    if (t) parts.push(en1000(t) + ' thousand');
    if (r) parts.push(parts.length && r < 100 ? 'and ' + en100(r) : en1000(r));
    return parts.join(' ');
  }

  var ES_U = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
  var ES_T = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
  var ES_H = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

  function es100(n) {
    if (n < 30) return ES_U[n];
    var t = Math.floor(n / 10), u = n % 10;
    return ES_T[t] + (u ? ' y ' + ES_U[u] : '');
  }
  function es1000(n) {
    if (n === 100) return 'cien';
    var h = Math.floor(n / 100), r = n % 100;
    if (!h) return es100(n);
    return ES_H[h] + (r ? ' ' + es100(r) : '');
  }
  // "uno" apocopates before mil/millones: veintiuno → veintiún.
  function esApocope(s) {
    return s.replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un');
  }
  function spellES(n) {
    if (!n) return 'cero';
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, parts = [];
    if (m) parts.push(m === 1 ? 'un millón' : esApocope(es1000(m)) + ' millones');
    if (t) parts.push(t === 1 ? 'mil' : esApocope(es1000(t)) + ' mil');
    if (r) parts.push(es1000(r));
    return parts.join(' ');
  }

  var FR_U = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize', 'dix-sept', 'dix-huit', 'dix-neuf'];
  var FR_T = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'];

  function fr100(n) {
    if (n < 20) return FR_U[n];
    if (n < 70) {
      var t = Math.floor(n / 10), u = n % 10;
      return u === 1 ? FR_T[t] + ' et un' : FR_T[t] + (u ? '-' + FR_U[u] : '');
    }
    if (n < 80) return n === 71 ? 'soixante et onze' : 'soixante-' + FR_U[n - 60];
    if (n === 80) return 'quatre-vingts';
    return 'quatre-vingt-' + FR_U[n - 80];
  }
  function fr1000(n) {
    var h = Math.floor(n / 100), r = n % 100;
    if (!h) return fr100(n);
    var s = h === 1 ? 'cent' : FR_U[h] + ' cent' + (r ? '' : 's');
    return s + (r ? ' ' + fr100(r) : '');
  }
  function spellFR(n) {
    if (!n) return 'zéro';
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, parts = [];
    if (m) parts.push(m === 1 ? 'un million' : fr1000(m) + ' millions');
    // quatre-vingts / deux cents drop their s before the numeral mille
    if (t) parts.push(t === 1 ? 'mille' : fr1000(t).replace(/(vingt|cent)s$/, '$1') + ' mille');
    if (r) parts.push(fr1000(r));
    return parts.join(' ');
  }

  var DE_U = ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn'];
  var DE_T = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];

  // final: a trailing 1 is "eins", but inside a compound it's "ein-".
  function de100(n, final) {
    if (n === 1) return final ? 'eins' : 'ein';
    if (n < 20) return DE_U[n];
    var t = Math.floor(n / 10), u = n % 10;
    return (u ? (u === 1 ? 'ein' : DE_U[u]) + 'und' : '') + DE_T[t];
  }
  function de1000(n, final) {
    var h = Math.floor(n / 100), r = n % 100;
    if (!h) return de100(n, final);
    return (h === 1 ? 'ein' : DE_U[h]) + 'hundert' + (r ? de100(r, final) : '');
  }
  function spellDE(n) {
    if (!n) return 'null';
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000;
    var tail = (t ? de1000(t, false) + 'tausend' : '') + (r ? de1000(r, true) : '');
    if (!m) return tail;
    var head = m === 1 ? 'eine Million' : de1000(m, false) + ' Millionen';
    return tail ? head + ' ' + tail : head;
  }

  var TR_U = ['sıfır', 'bir', 'iki', 'üç', 'dört', 'beş', 'altı', 'yedi', 'sekiz', 'dokuz'];
  var TR_T = ['', 'on', 'yirmi', 'otuz', 'kırk', 'elli', 'altmış', 'yetmiş', 'seksen', 'doksan'];

  function tr100(n) {
    var t = Math.floor(n / 10), u = n % 10;
    if (!t) return TR_U[u];
    return TR_T[t] + (u ? ' ' + TR_U[u] : '');
  }
  function tr1000(n) {
    var h = Math.floor(n / 100), r = n % 100;
    if (!h) return tr100(n);
    return (h === 1 ? '' : TR_U[h] + ' ') + 'yüz' + (r ? ' ' + tr100(r) : '');
  }
  function spellTR(n) {
    if (!n) return 'sıfır';
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, parts = [];
    if (m) parts.push(tr1000(m) + ' milyon');
    if (t) parts.push(t === 1 ? 'bin' : tr1000(t) + ' bin');
    if (r) parts.push(tr1000(r));
    return parts.join(' ');
  }

  var RU_U = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
  var RU_T = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
  var RU_H = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

  // Russian agreement: 1/2 are feminine before тысяча (одна/две тысячи).
  function ru1000(n, fem) {
    var h = Math.floor(n / 100), r = n % 100, parts = [];
    if (h) parts.push(RU_H[h]);
    if (r) {
      if (r < 20) parts.push(fem && r === 1 ? 'одна' : fem && r === 2 ? 'две' : RU_U[r]);
      else {
        var t = Math.floor(r / 10), u = r % 10;
        parts.push(RU_T[t] + (u ? ' ' + (fem && u === 1 ? 'одна' : fem && u === 2 ? 'две' : RU_U[u]) : ''));
      }
    }
    return parts.join(' ');
  }
  function ruPlural(n, forms) {
    var d2 = n % 100, d1 = n % 10;
    if (d2 >= 11 && d2 <= 14) return forms[2];
    if (d1 === 1) return forms[0];
    if (d1 >= 2 && d1 <= 4) return forms[1];
    return forms[2];
  }
  function spellRU(n) {
    if (!n) return 'ноль';
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, parts = [];
    if (m) parts.push(ru1000(m, false) + ' ' + ruPlural(m, ['миллион', 'миллиона', 'миллионов']));
    if (t) parts.push((t === 1 ? 'тысяча' : ru1000(t, true) + ' ' + ruPlural(t, ['тысяча', 'тысячи', 'тысяч'])));
    if (r) parts.push(ru1000(r, false));
    return parts.join(' ');
  }

  var EL_U = ['μηδέν', 'ένα', 'δύο', 'τρία', 'τέσσερα', 'πέντε', 'έξι', 'επτά', 'οκτώ', 'εννέα', 'δέκα', 'έντεκα', 'δώδεκα', 'δεκατρία', 'δεκατέσσερα', 'δεκαπέντε', 'δεκαέξι', 'δεκαεπτά', 'δεκαοκτώ', 'δεκαεννέα'];
  var EL_T = ['', '', 'είκοσι', 'τριάντα', 'σαράντα', 'πενήντα', 'εξήντα', 'εβδομήντα', 'ογδόντα', 'ενενήντα'];
  var EL_H = ['', 'εκατό', 'διακόσια', 'τριακόσια', 'τετρακόσια', 'πεντακόσια', 'εξακόσια', 'επτακόσια', 'οκτακόσια', 'εννιακόσια'];

  function el100(n) {
    if (n < 20) return EL_U[n];
    var t = Math.floor(n / 10), u = n % 10;
    return EL_T[t] + (u ? ' ' + EL_U[u] : '');
  }
  function el1000(n) {
    var h = Math.floor(n / 100), r = n % 100;
    if (!h) return el100(n);
    var s = h === 1 ? (r ? 'εκατόν' : 'εκατό') : EL_H[h];
    return s + (r ? ' ' + el100(r) : '');
  }
  // χιλιάδες is feminine: hundreds and trailing ένα/τρία/τέσσερα shift
  // form (compound δεκατρία keeps its accent: δεκατρείς).
  function elFem(s) {
    return s.replace(/όσια(?= |$)/g, 'όσιες')
      .replace(/δεκατρία$/, 'δεκατρείς')
      .replace(/ένα$/, 'μία').replace(/τρία$/, 'τρεις').replace(/τέσσερα$/, 'τέσσερις');
  }
  function spellEL(n) {
    if (!n) return 'μηδέν';
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, parts = [];
    if (m) parts.push(m === 1 ? 'ένα εκατομμύριο' : el1000(m) + ' εκατομμύρια');
    if (t) parts.push(t === 1 ? 'χίλια' : elFem(el1000(t)) + ' χιλιάδες');
    if (r) parts.push(el1000(r));
    return parts.join(' ');
  }

  // Arabic: [text, reading] pairs assembled in parallel, joined with و.
  var AR_U = [['صفر', 'sifr'], ['واحد', 'wahid'], ['اثنان', 'ithnan'], ['ثلاثة', 'thalatha'], ['أربعة', 'arba’a'], ['خمسة', 'khamsa'], ['ستة', 'sitta'], ['سبعة', 'sab’a'], ['ثمانية', 'thamaniya'], ['تسعة', 'tis’a'], ['عشرة', 'ashara'], ['أحد عشر', 'ahada ashar'], ['اثنا عشر', 'ithna ashar']];
  var AR_T = [['عشرون', 'ishrun'], ['ثلاثون', 'thalathun'], ['أربعون', 'arba’un'], ['خمسون', 'khamsun'], ['ستون', 'sittun'], ['سبعون', 'sab’un'], ['ثمانون', 'thamanun'], ['تسعون', 'tis’un']];
  var AR_H = [['مئة', 'mi’a'], ['مئتان', 'mi’atan'], ['ثلاثمئة', 'thalathumi’a'], ['أربعمئة', 'arba’umi’a'], ['خمسمئة', 'khamsumi’a'], ['ستمئة', 'sittumi’a'], ['سبعمئة', 'sab’umi’a'], ['ثمانمئة', 'thamanumi’a'], ['تسعمئة', 'tis’umi’a']];

  function ar100(n) {
    if (n <= 12) return AR_U[n];
    if (n < 20) return [AR_U[n - 10][0] + ' عشر', AR_U[n - 10][1] + ' ashar'];
    var t = Math.floor(n / 10) - 2, u = n % 10;
    if (!u) return AR_T[t];
    return [AR_U[u][0] + ' و' + AR_T[t][0], AR_U[u][1] + ' wa-' + AR_T[t][1]];
  }
  function ar1000(n) {
    var h = Math.floor(n / 100), r = n % 100, parts = [];
    if (h) parts.push(AR_H[h - 1]);
    if (r || !parts.length) parts.push(ar100(r));
    return joinAR(parts);
  }
  function joinAR(parts) {
    var text = '', roman = '';
    for (var i = 0; i < parts.length; i++) {
      text += (i ? ' و' : '') + parts[i][0];
      roman += (i ? ' wa-' : '') + parts[i][1];
    }
    return [text, roman];
  }
  function scaleAR(v, one, two, few, many) {
    if (v === 1) return one;
    if (v === 2) return two;
    var s = ar1000(v);
    if (v <= 10) return [s[0] + ' ' + few[0], s[1] + ' ' + few[1]];
    return [s[0] + ' ' + many[0], s[1] + ' ' + many[1]];
  }
  function spellAR(n) {
    if (!n) return { text: 'صفر', roman: 'sifr' };
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, parts = [];
    if (m) parts.push(scaleAR(m, ['مليون', 'milyun'], ['مليونان', 'milyunan'], ['ملايين', 'malayin'], ['مليون', 'milyun']));
    if (t) parts.push(scaleAR(t, ['ألف', 'alf'], ['ألفان', 'alfan'], ['آلاف', 'alaf'], ['ألف', 'alf']));
    if (r) parts.push(ar1000(r));
    var out = joinAR(parts);
    return { text: out[0], roman: out[1] };
  }

  // Hindi 0-99 is genuinely irregular — the lookup table IS the grammar.
  var HI_DEV = ('शून्य एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस चालीस इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ साठ इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उन्यासी अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे इक्यानवे बानवे तिरानवे चौरानवे पंचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे').split(' ');
  var HI_ROM = ('shunya ek do teen chaar paanch chhah saat aath nau das gyaarah baarah terah chaudah pandrah solah satrah athaarah unnees bees ikkees baaees teis chaubees pachchees chhabbees sattaees atthaees untees tees iktees battees taintees chauntees paintees chhattees saintees adtees untaalees chaalees iktaalees bayaalees taintaalees chavaalees paintaalees chhiyaalees saintaalees adtaalees unchaas pachaas ikyaavan baavan tirpan chauvan pachpan chhappan sattaavan atthaavan unsath saath iksath baasath tirsath chaunsath painsath chhiyaasath sadsath adsath unhattar sattar ikahattar bahattar tihattar chauhattar pachhattar chhihattar satahattar athahattar unyaasi assi ikyaasi bayaasi tiraasi chauraasi pachaasi chhiyaasi sattaasi atthaasi navaasi nabbe ikyaanave baanave tiraanave chauraanave panchaanave chhiyaanave sattaanave atthaanave ninyaanave').split(' ');

  // Indian grouping: crore (1e7), lakh (1e5), hazaar (1e3), sau (100).
  function spellHI(n) {
    if (!n) return { text: HI_DEV[0], roman: HI_ROM[0] };
    var groups = [
      [Math.floor(n / 1e7), 'करोड़', 'crore'],
      [Math.floor(n % 1e7 / 1e5), 'लाख', 'laakh'],
      [Math.floor(n % 1e5 / 1000), 'हज़ार', 'hazaar'],
      [Math.floor(n % 1000 / 100), 'सौ', 'sau'],
      [n % 100, '', '']
    ];
    var text = [], roman = [];
    for (var i = 0; i < groups.length; i++) {
      var v = groups[i][0];
      if (!v) continue;
      text.push(HI_DEV[v] + (groups[i][1] ? ' ' + groups[i][1] : ''));
      roman.push(HI_ROM[v] + (groups[i][2] ? ' ' + groups[i][2] : ''));
    }
    return { text: text.join(' '), roman: roman.join(' ') };
  }

  // Chinese & Japanese: myriad (10^4) grouping with [glyph, reading] pairs.
  var ZH_D = [['零', 'líng'], ['一', 'yī'], ['二', 'èr'], ['三', 'sān'], ['四', 'sì'], ['五', 'wǔ'], ['六', 'liù'], ['七', 'qī'], ['八', 'bā'], ['九', 'jiǔ']];
  var ZH_U = [['', ''], ['十', 'shí'], ['百', 'bǎi'], ['千', 'qiān']];

  function zhGroup(g, wholeIsTeens) {
    // spell 1..9999 as [glyph, reading] with 零-insertion inside the group
    var digits = [Math.floor(g / 1000), Math.floor(g % 1000 / 100), Math.floor(g % 100 / 10), g % 10];
    var toks = [], zeroPending = false, started = false;
    for (var i = 0; i < 4; i++) {
      var d = digits[i], u = ZH_U[3 - i];
      if (!d) { if (started) zeroPending = true; continue; }
      if (zeroPending) { toks.push(ZH_D[0]); zeroPending = false; }
      // bare 十 for the whole number 10-19 (十四 not 一十四)
      var dropOne = d === 1 && 3 - i === 1 && wholeIsTeens && !started;
      if (!dropOne) toks.push(ZH_D[d]);
      if (u[0]) toks.push(u);
      started = true;
    }
    return toks;
  }
  function spellZH(n) {
    if (!n) return { text: ZH_D[0][0], roman: ZH_D[0][1] };
    var yi = Math.floor(n / 1e8), wan = Math.floor(n % 1e8 / 1e4), low = n % 1e4;
    var toks = [];
    if (yi) { toks = toks.concat(zhGroup(yi, n < 20)); toks.push(['亿', 'yì']); }
    if (wan) {
      if (yi && wan < 1000) toks.push(ZH_D[0]);
      toks = toks.concat(zhGroup(wan, !yi && wan < 20)); toks.push(['万', 'wàn']);
    }
    if (low) {
      // a zero-digit gap before the low group needs 零 — either the low
      // group starts below 千, or the 万 group itself ends in a zero digit
      if ((yi || wan) && (low < 1000 || !(wan % 10))) toks.push(ZH_D[0]);
      toks = toks.concat(zhGroup(low, n < 20));
    }
    var text = '', roman = [];
    for (var i = 0; i < toks.length; i++) { text += toks[i][0]; roman.push(toks[i][1]); }
    return { text: text, roman: roman.join(' ') };
  }

  var JA_D = ['', 'ichi', 'ni', 'san', 'yon', 'go', 'roku', 'nana', 'hachi', 'kyuu'];
  var JA_DG = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  // rendaku/gemination irregulars: 300 sanbyaku, 600 roppyaku, 800 happyaku…
  var JA_SOUND = { '3hyaku': 'sanbyaku', '6hyaku': 'roppyaku', '8hyaku': 'happyaku', '3sen': 'sanzen', '8sen': 'hassen' };

  function jaPair(d, unitGlyph, unitRead, high) {
    // a 千 heading a 万/億 multiplier keeps its 一: 一千万 issen-man
    if (d === 1 && unitRead === 'sen' && high) return ['一千', 'issen'];
    var glyph = (d === 1 && unitRead !== 'man' && unitRead !== 'oku' ? '' : JA_DG[d]) + unitGlyph;
    var read = JA_SOUND[d + unitRead] ||
      ((d === 1 && unitRead !== 'man' && unitRead !== 'oku' ? '' : JA_D[d]) + unitRead);
    return [glyph, read];
  }
  function jaGroup(g, high) {
    var toks = [], parts = [[Math.floor(g / 1000), '千', 'sen'], [Math.floor(g % 1000 / 100), '百', 'hyaku'], [Math.floor(g % 100 / 10), '十', 'juu'], [g % 10, '', '']];
    for (var i = 0; i < parts.length; i++) {
      var d = parts[i][0];
      if (!d) continue;
      if (!parts[i][1]) toks.push([JA_DG[d], JA_D[d]]);
      else toks.push(jaPair(d, parts[i][1], parts[i][2], high));
    }
    return toks;
  }
  function spellJA(n) {
    if (!n) return { text: 'ゼロ', roman: 'zero' };
    var oku = Math.floor(n / 1e8), man = Math.floor(n % 1e8 / 1e4), low = n % 1e4;
    var toks = [];
    if (oku === 1) toks.push(['一億', 'ichioku']);
    else if (oku) { toks = toks.concat(jaGroup(oku)); toks.push(['億', 'oku']); }
    if (man) { toks = toks.concat(man === 1 ? [['一万', 'ichiman']] : jaGroup(man, true).concat([['万', 'man']])); }
    if (low) toks = toks.concat(jaGroup(low));
    var text = '', roman = [];
    for (var i = 0; i < toks.length; i++) { text += toks[i][0]; roman.push(toks[i][1]); }
    return { text: text, roman: roman.join(' ') };
  }

  // Korean Sino numerals; romanization is computed from the Hangul itself.
  var KO_D = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];

  function koGroup(g) {
    var out = '', parts = [[Math.floor(g / 1000), '천'], [Math.floor(g % 1000 / 100), '백'], [Math.floor(g % 100 / 10), '십'], [g % 10, '']];
    for (var i = 0; i < parts.length; i++) {
      var d = parts[i][0];
      if (!d) continue;
      out += (d === 1 && parts[i][1] ? '' : KO_D[d]) + parts[i][1];
    }
    return out;
  }
  function spellKO(n) {
    if (!n) return { text: '영', roman: 'yeong' };
    var eok = Math.floor(n / 1e8), man = Math.floor(n % 1e8 / 1e4), low = n % 1e4, parts = [];
    if (eok) parts.push((eok === 1 ? '일' : koGroup(eok)) + '억');
    if (man) parts.push((man === 1 ? (eok ? '일' : '') : koGroup(man)) + '만');
    if (low) parts.push(koGroup(low));
    var text = parts.join(' ');
    return { text: text, roman: romanize(text).roman };
  }

  function spellNumber(n, lang) {
    if (!LANG_BY_CODE[lang]) throw new Error('unknown lang: ' + lang);
    if (typeof n !== 'number' || !isFinite(n) || Math.floor(n) !== n || n < 0 || n > 999999999) return null;
    var s;
    switch (lang) {
      case 'en': return { text: spellEN(n), roman: null };
      case 'es': return { text: spellES(n), roman: null };
      case 'fr': return { text: spellFR(n), roman: null };
      case 'de': return { text: spellDE(n), roman: null };
      case 'tr': return { text: spellTR(n), roman: null };
      case 'ru': s = spellRU(n); return { text: s, roman: romanize(s).roman };
      case 'el': s = spellEL(n); return { text: s, roman: romanize(s).roman };
      case 'ar': return spellAR(n);
      case 'hi': return spellHI(n);
      case 'zh': return spellZH(n);
      case 'ja': return spellJA(n);
      case 'ko': return spellKO(n);
    }
  }

  /* ---------------- times and dates ---------------- */

  var MONTHS = {
    en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
    fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
    de: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'],
    tr: ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'],
    ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
    el: ['Ιανουαρίου', 'Φεβρουαρίου', 'Μαρτίου', 'Απριλίου', 'Μαΐου', 'Ιουνίου', 'Ιουλίου', 'Αυγούστου', 'Σεπτεμβρίου', 'Οκτωβρίου', 'Νοεμβρίου', 'Δεκεμβρίου'],
    ar: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
    hi: ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर']
  };
  var MONTHS_R = {
    ar: ['yanayir', 'fibrayir', 'maris', 'abril', 'mayu', 'yuniyu', 'yuliyu', 'aghustus', 'sibtambir', 'uktubir', 'nufambir', 'disambir'],
    hi: ['janvari', 'farvari', 'march', 'april', 'mai', 'june', 'julai', 'agast', 'sitambar', 'october', 'navambar', 'disambar']
  };
  // Arabic clock hours are feminine ordinals (الساعة الثالثة) on a
  // 12-hour dial with a morning/evening marker for 24-hour input.
  var AR_HOUR = ['الثانية عشرة', 'الواحدة', 'الثانية', 'الثالثة', 'الرابعة', 'الخامسة', 'السادسة', 'السابعة', 'الثامنة', 'التاسعة', 'العاشرة', 'الحادية عشرة'];
  var AR_HOUR_R = ['ath-thaniya ashra', 'al-wahida', 'ath-thaniya', 'ath-thalitha', 'ar-rabi’a', 'al-khamisa', 'as-sadisa', 'as-sabi’a', 'ath-thamina', 'at-tasi’a', 'al-ashira', 'al-hadiya ashra'];
  // the 時 counter forces irregular hour readings; 0時 is 零時 reiji
  var JA_HOUR_R = { 0: 'rei', 4: 'yo', 7: 'shichi', 9: 'ku', 14: 'juu yo', 17: 'juu shichi', 19: 'juu ku' };
  // the 分 counter geminates after 1/3/4/6/8 and a trailing 十: ippun, sanjuppun…
  function jaMinuteRead(m) {
    var r = spellJA(m).roman, u = m % 10;
    if (u === 1) return r.replace(/ichi$/, 'ippun');
    if (u === 3) return r.replace(/san$/, 'sanpun');
    if (u === 4) return r.replace(/yon$/, 'yonpun');
    if (u === 6) return r.replace(/roku$/, 'roppun');
    if (u === 8) return r.replace(/hachi$/, 'happun');
    if (u === 0) return r.replace(/juu$/, 'juppun');
    return r + ' fun';
  }
  // Korean hours use NATIVE numerals (한 시, 두 시), minutes Sino.
  var KO_NATIVE_H = ['영', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열', '열한', '열두', '열세', '열네', '열다섯', '열여섯', '열일곱', '열여덟', '열아홉', '스무', '스물한', '스물두', '스물세'];

  function spellTime(h, m, lang) {
    if (!LANG_BY_CODE[lang]) throw new Error('unknown lang: ' + lang);
    if (typeof h !== 'number' || typeof m !== 'number' || Math.floor(h) !== h || Math.floor(m) !== m ||
        h < 0 || h > 23 || m < 0 || m > 59) throw new RangeError('bad time: ' + h + ':' + m);
    var a, b, t;
    switch (lang) {
      case 'en': return { text: m ? spellEN(h) + ' ' + (m < 10 ? 'oh ' : '') + spellEN(m) : spellEN(h) + " o'clock", roman: null };
      case 'es':
        t = h === 1 ? 'la una' : h === 0 ? 'las cero horas' : 'las ' + spellES(h).replace(/uno$/, 'una');
        return { text: t + (m ? ' y ' + spellES(m) : h === 0 ? '' : ' en punto'), roman: null };
      case 'fr': return { text: 'il est ' + (h === 1 ? 'une heure' : spellFR(h) + (h === 0 ? ' heure' : ' heures')) + (m ? ' ' + spellFR(m) : ''), roman: null };
      case 'de': return { text: (h === 1 ? 'ein' : spellDE(h)) + ' Uhr' + (m ? ' ' + spellDE(m) : ''), roman: null };
      case 'tr': return { text: 'saat ' + spellTR(h) + (m ? ' ' + spellTR(m) : ''), roman: null };
      case 'ru':
        t = m ? spellRU(h) + ' ' + (m < 10 ? 'ноль ' : '') + spellRU(m) : spellRU(h) + ' ' + ruPlural(h, ['час', 'часа', 'часов']);
        return { text: t, roman: romanize(t).roman };
      case 'el':
        t = m ? elFem(spellEL(h)) + ' και ' + spellEL(m) : elFem(spellEL(h)) + ' η ώρα';
        return { text: t, roman: romanize(t).roman };
      case 'ar':
        b = m ? spellAR(m) : null;
        return {
          text: 'الساعة ' + AR_HOUR[h % 12] + (b ? ' و' + b.text + ' دقيقة' : '') + (h < 12 ? ' صباحا' : ' مساء'),
          roman: 'as-sa’a ' + AR_HOUR_R[h % 12] + (b ? ' wa-' + b.roman + ' daqiqa' : '') + (h < 12 ? ' sabahan' : ' masa’an')
        };
      case 'hi':
        a = spellHI(h); b = m ? spellHI(m) : null;
        return b ? { text: a.text + ' बजकर ' + b.text + ' मिनट', roman: a.roman + ' bajkar ' + b.roman + ' minute' }
          : { text: a.text + ' बजे', roman: a.roman + ' baje' };
      case 'zh':
        a = h === 2 ? { text: '两', roman: 'liǎng' } : spellZH(h);
        b = m ? spellZH(m) : null;
        return {
          text: a.text + '点' + (b ? (m < 10 ? '零' : '') + b.text + '分' : ''),
          roman: a.roman + ' diǎn' + (b ? ' ' + (m < 10 ? 'líng ' : '') + b.roman + ' fēn' : '')
        };
      case 'ja':
        a = h === 0 ? { text: '零', roman: 'rei' } : spellJA(h);
        return {
          text: a.text + '時' + (m ? spellJA(m).text + '分' : ''),
          roman: (JA_HOUR_R[h] || a.roman) + ' ji' + (m ? ' ' + jaMinuteRead(m) : '')
        };
      case 'ko':
        t = KO_NATIVE_H[h] + ' 시' + (m ? ' ' + spellKO(m).text + ' 분' : '');
        return { text: t, roman: romanize(t).roman };
    }
  }

  function daysInMonth(y, m) {
    var leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  }

  function spellDate(y, m, d, lang) {
    if (!LANG_BY_CODE[lang]) throw new Error('unknown lang: ' + lang);
    if (typeof y !== 'number' || typeof m !== 'number' || typeof d !== 'number' ||
        Math.floor(y) !== y || Math.floor(m) !== m || Math.floor(d) !== d ||
        y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
      throw new RangeError('bad date: ' + y + '-' + m + '-' + d);
    }
    var mon, t;
    switch (lang) {
      case 'en': return { text: MONTHS.en[m - 1] + ' ' + d + ', ' + y, roman: null };
      case 'es': return { text: d + ' de ' + MONTHS.es[m - 1] + ' de ' + y, roman: null };
      case 'fr': return { text: (d === 1 ? 'le premier' : 'le ' + d) + ' ' + MONTHS.fr[m - 1] + ' ' + y, roman: null };
      case 'de': return { text: d + '. ' + MONTHS.de[m - 1] + ' ' + y, roman: null };
      case 'tr': return { text: d + ' ' + MONTHS.tr[m - 1] + ' ' + y, roman: null };
      case 'ru': t = d + ' ' + MONTHS.ru[m - 1] + ' ' + y + ' г.'; return { text: t, roman: romanize(t).roman };
      case 'el': t = d + ' ' + MONTHS.el[m - 1] + ' ' + y; return { text: t, roman: romanize(t).roman };
      case 'ar': return { text: d + ' ' + MONTHS.ar[m - 1] + ' ' + y, roman: d + ' ' + MONTHS_R.ar[m - 1] + ' ' + y };
      case 'hi': return { text: d + ' ' + MONTHS.hi[m - 1] + ' ' + y, roman: d + ' ' + MONTHS_R.hi[m - 1] + ' ' + y };
      case 'zh': return { text: y + '年' + m + '月' + d + '日', roman: y + ' nián ' + m + ' yuè ' + d + ' rì' };
      case 'ja': return { text: y + '年' + m + '月' + d + '日', roman: y + ' nen ' + m + ' gatsu ' + d + ' nichi' };
      case 'ko': t = y + '년 ' + m + '월 ' + d + '일'; return { text: t, roman: romanize(t).roman };
    }
  }

  // What kind of thing did the traveller type?
  function parseInput(text) {
    var s = String(text == null ? '' : text).replace(/^\s+|\s+$/g, '');
    var tm = s.match(/^(\d{1,2}):(\d{2})$/);
    if (tm) {
      var h = parseInt(tm[1], 10), mi = parseInt(tm[2], 10);
      if (h <= 23 && mi <= 59) return { kind: 'time', h: h, m: mi };
      return { kind: 'text' };
    }
    var dm = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (dm) {
      var y = parseInt(dm[1], 10), mo = parseInt(dm[2], 10), d = parseInt(dm[3], 10);
      if (y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)) return { kind: 'date', y: y, m: mo, d: d };
      return { kind: 'text' };
    }
    var digits = s.replace(/[,\s]/g, '');
    if (/^\d{1,9}$/.test(digits) && /^[\d,\s]+$/.test(s)) return { kind: 'number', n: parseInt(digits, 10) };
    return { kind: 'text' };
  }

  /* ---------------- romanization ---------------- */
  // Per-character script dispatch: Cyrillic and Greek tables, Hangul by
  // pure U+AC00 arithmetic (Revised Romanization, with vowel-liaison),
  // kana by Hepburn (digraphs, っ gemination, ー long vowels, particle
  // は→wa at word end). Latin passes through; Han/kanji pass through
  // verbatim and lower the honesty `coverage` fraction.

  // Ukrainian-only letters are unique codepoints — safe in the shared map;
  // г/и differ between Russian and Ukrainian, handled by ukMode below.
  var CYR_UK = { 'і': 'i', 'ї': 'yi', 'є': 'ye', 'ґ': 'g' };
  var CYR_UK_MODE = { 'г': 'h', 'и': 'y' };
  var CYR = { 'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'yo', 'ж': 'zh', 'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'yu', 'я': 'ya' };

  var GRK2 = { 'ου': 'ou', 'αι': 'ai', 'ει': 'ei', 'οι': 'oi', 'αυ': 'av', 'ευ': 'ev', 'γγ': 'ng', 'γκ': 'gk', 'μπ': 'b', 'ντ': 'nt' };
  var GRK1 = { 'α': 'a', 'β': 'v', 'γ': 'g', 'δ': 'd', 'ε': 'e', 'ζ': 'z', 'η': 'i', 'θ': 'th', 'ι': 'i', 'κ': 'k', 'λ': 'l', 'μ': 'm', 'ν': 'n', 'ξ': 'x', 'ο': 'o', 'π': 'p', 'ρ': 'r', 'σ': 's', 'ς': 's', 'τ': 't', 'υ': 'y', 'φ': 'f', 'χ': 'ch', 'ψ': 'ps', 'ω': 'o' };

  var KANA2 = { 'きゃ': 'kya', 'きゅ': 'kyu', 'きょ': 'kyo', 'しゃ': 'sha', 'しゅ': 'shu', 'しょ': 'sho', 'ちゃ': 'cha', 'ちゅ': 'chu', 'ちょ': 'cho', 'にゃ': 'nya', 'にゅ': 'nyu', 'にょ': 'nyo', 'ひゃ': 'hya', 'ひゅ': 'hyu', 'ひょ': 'hyo', 'みゃ': 'mya', 'みゅ': 'myu', 'みょ': 'myo', 'りゃ': 'rya', 'りゅ': 'ryu', 'りょ': 'ryo', 'ぎゃ': 'gya', 'ぎゅ': 'gyu', 'ぎょ': 'gyo', 'じゃ': 'ja', 'じゅ': 'ju', 'じょ': 'jo', 'びゃ': 'bya', 'びゅ': 'byu', 'びょ': 'byo', 'ぴゃ': 'pya', 'ぴゅ': 'pyu', 'ぴょ': 'pyo' };
  var KANA1 = { 'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o', 'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko', 'さ': 'sa', 'し': 'shi', 'す': 'su', 'せ': 'se', 'そ': 'so', 'た': 'ta', 'ち': 'chi', 'つ': 'tsu', 'て': 'te', 'と': 'to', 'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no', 'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho', 'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo', 'や': 'ya', 'ゆ': 'yu', 'よ': 'yo', 'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro', 'わ': 'wa', 'を': 'o', 'ん': 'n', 'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'u', 'ぇ': 'e', 'ぉ': 'o', 'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go', 'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo', 'だ': 'da', 'ぢ': 'ji', 'づ': 'zu', 'で': 'de', 'ど': 'do', 'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo', 'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po', 'ゔ': 'vu' };

  var GEO = { 'ა': 'a', 'ბ': 'b', 'გ': 'g', 'დ': 'd', 'ე': 'e', 'ვ': 'v', 'ზ': 'z', 'თ': 't', 'ი': 'i', 'კ': 'k', 'ლ': 'l', 'მ': 'm', 'ნ': 'n', 'ო': 'o', 'პ': 'p', 'ჟ': 'zh', 'რ': 'r', 'ს': 's', 'ტ': 't', 'უ': 'u', 'ფ': 'p', 'ქ': 'k', 'ღ': 'gh', 'ყ': 'q', 'შ': 'sh', 'ჩ': 'ch', 'ც': 'ts', 'ძ': 'dz', 'წ': 'ts', 'ჭ': 'ch', 'ხ': 'kh', 'ჯ': 'j', 'ჰ': 'h' };

  var RR_INIT = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
  var RR_VOW = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
  var RR_FIN = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
  // when the next syllable starts with silent ㅇ, the final carries over
  var RR_LIAISON = { 1: 'g', 2: 'kk', 4: 'n', 7: 'd', 8: 'r', 16: 'm', 17: 'b', 19: 's', 20: 'ss', 22: 'j', 23: 'ch', 25: 't', 26: 'p', 27: '' };

  function stripAccents(s) {
    // й and ё decompose under NFD into и/е + a combining mark that the
    // strip would eat — shelter them so the CYR table still sees them.
    s = String(s).replace(/й/g, '\uE000').replace(/Й/g, '\uE001').replace(/ё/g, '\uE002').replace(/Ё/g, '\uE003');
    try { s = s.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC'); } catch (e) {}
    return s.replace(/\uE000/g, 'й').replace(/\uE001/g, 'Й').replace(/\uE002/g, 'ё').replace(/\uE003/g, 'Ё');
  }

  function isVowelChar(c) { return 'aeiou'.indexOf(c) !== -1; }

  function romanize(text) {
    var src = stripAccents(String(text == null ? '' : text));
    // katakana → hiragana so one kana table serves both
    src = src.replace(/[ァ-ヶ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); });
    // the topic particle は is pronounced wa; treat any は that ends a
    // kana run (space, punctuation, …, end) as the particle
    src = src.replace(/は(?![ぁ-ゖー])/g, 'わ');
    // a Ukrainian marker letter anywhere switches г/и to their Ukrainian values
    var ukMode = /[іїєґІЇЄҐ]/.test(src);
    var out = '', covered = 0, total = 0, i = 0, n = src.length;
    while (i < n) {
      var c = src.charAt(i), lower = c.toLowerCase(), code = src.charCodeAt(i);
      var isSpace = /\s/.test(c);
      if (!isSpace) total++;
      var piece = null;

      if (CYR_UK[lower] !== undefined) {
        piece = CYR_UK[lower]; i++;
      } else if (ukMode && CYR_UK_MODE[lower] !== undefined) {
        piece = CYR_UK_MODE[lower]; i++;
      } else if (CYR[lower] !== undefined) {
        piece = CYR[lower]; i++;
      } else if (GEO[c] !== undefined) {
        piece = GEO[c]; i++;
      } else if (GRK2[src.substr(i, 2).toLowerCase()] !== undefined && i + 1 < n) {
        var g2 = src.substr(i, 2).toLowerCase();
        piece = GRK2[g2];
        var nx = i + 2 < n ? src.charAt(i + 2).toLowerCase() : '';
        var nxGreek = GRK1[nx] !== undefined;
        if (g2 === 'αυ' || g2 === 'ευ') {
          // af/ef before voiceless consonants and word-finally (ELOT 743)
          if (!nxGreek || 'θκξπστφχψς'.indexOf(nx) !== -1) piece = g2 === 'αυ' ? 'af' : 'ef';
        } else if (g2 === 'μπ') {
          // b at word edges, mp inside a word (λάμπα → lampa)
          var pv = i > 0 ? src.charAt(i - 1).toLowerCase() : '';
          if (GRK1[pv] !== undefined && nxGreek) piece = 'mp';
        }
        covered++; total++; i += 2;
      } else if (GRK1[lower] !== undefined) {
        piece = GRK1[lower]; i++;
      } else if (code >= 0xAC00 && code <= 0xD7A3) {
        var idx = code - 0xAC00, ini = Math.floor(idx / 588), vow = Math.floor((idx % 588) / 28), fin = idx % 28;
        var nc = i + 1 < n ? src.charCodeAt(i + 1) : 0;
        var nextSilent = nc >= 0xAC00 && nc <= 0xD7A3 && Math.floor((nc - 0xAC00) / 588) === 11;
        var finR = fin && nextSilent && RR_LIAISON[fin] !== undefined ? RR_LIAISON[fin] : RR_FIN[fin];
        piece = RR_INIT[ini] + RR_VOW[vow] + finR;
        i++;
      } else if (c === 'っ') {
        // gemination: double the next syllable's first consonant (t before ch)
        var rest = romanizeKanaAt(src, i + 1);
        piece = rest ? (rest.charAt(0) === 'c' ? 't' : rest.charAt(0)) : 'tsu';
        i++;
      } else if (KANA2[src.substr(i, 2)] !== undefined) {
        piece = KANA2[src.substr(i, 2)]; covered++; total++; i += 2;
      } else if (KANA1[c] !== undefined) {
        piece = KANA1[c]; i++;
      } else if (c === 'ー') {
        piece = out && isVowelChar(out.charAt(out.length - 1)) ? out.charAt(out.length - 1) : '';
        i++;
      } else {
        // Latin (and digits/punct) pass through and count as covered;
        // anything else (kanji, Han, emoji) passes through uncovered.
        out += c;
        if (!isSpace && (code < 0x2E80 || /[\p{Script=Latin}\p{N}]/u.test(c))) covered++;
        i++;
        continue;
      }
      // preserve capitalization of transliterated letters
      if (piece && c !== lower) piece = piece.charAt(0).toUpperCase() + piece.slice(1);
      out += piece;
      if (!isSpace) covered++;
    }
    return { roman: out, coverage: total ? round4(covered / total) : 1 };
  }

  // first romanized syllable at position i (helper for っ lookahead)
  function romanizeKanaAt(s, i) {
    if (KANA2[s.substr(i, 2)] !== undefined) return KANA2[s.substr(i, 2)];
    if (KANA1[s.charAt(i)] !== undefined) return KANA1[s.charAt(i)];
    return '';
  }

  /* ---------------- signal codecs ---------------- */
  // Four reversible encodings obeying one machine-checked law:
  //   decode(encode(x, c), c) === canonical(x, c)
  // canonical() is what survives the codec — the law is exact, not fuzzy.

  var CODECS = [
    { id: 'morse', name: 'Morse code', hint: 'letters ·−, words /' },
    { id: 'nato', name: 'NATO phonetic', hint: 'Alfa Bravo Charlie' },
    { id: 'braille', name: 'Braille', hint: 'Grade-1 Unicode cells' },
    { id: 'futhark', name: 'Elder Futhark', hint: '24 runes, ᚦ=th ᛜ=ng' }
  ];

  var MORSE = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..', '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-', '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.', '.': '.-.-.-', ',': '--..--', '?': '..--..' };
  var MORSE_REV = {};
  var NATO = { A: 'Alfa', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf', H: 'Hotel', I: 'India', J: 'Juliett', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November', O: 'Oscar', P: 'Papa', Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango', U: 'Uniform', V: 'Victor', W: 'Whiskey', X: 'X-ray', Y: 'Yankee', Z: 'Zulu', '0': 'Zero', '1': 'One', '2': 'Two', '3': 'Three', '4': 'Four', '5': 'Five', '6': 'Six', '7': 'Seven', '8': 'Eight', '9': 'Nine' };
  var NATO_REV = {};
  var BRAILLE = { a: '⠁', b: '⠃', c: '⠉', d: '⠙', e: '⠑', f: '⠋', g: '⠛', h: '⠓', i: '⠊', j: '⠚', k: '⠅', l: '⠇', m: '⠍', n: '⠝', o: '⠕', p: '⠏', q: '⠟', r: '⠗', s: '⠎', t: '⠞', u: '⠥', v: '⠧', w: '⠺', x: '⠭', y: '⠽', z: '⠵' };
  var BRAILLE_REV = {};
  var BRAILLE_NUM = '⠼', BRAILLE_LETTER = '⠰';
  var DIGIT_CELLS = 'jabcdefghi'; // 0..9 share cells with j,a..i
  var FUTHARK = { f: 'ᚠ', u: 'ᚢ', th: 'ᚦ', a: 'ᚨ', r: 'ᚱ', k: 'ᚲ', g: 'ᚷ', w: 'ᚹ', h: 'ᚺ', n: 'ᚾ', i: 'ᛁ', j: 'ᛃ', p: 'ᛈ', z: 'ᛉ', s: 'ᛊ', t: 'ᛏ', b: 'ᛒ', e: 'ᛖ', m: 'ᛗ', l: 'ᛚ', ng: 'ᛜ', d: 'ᛞ', o: 'ᛟ' };
  var FUTHARK_REV = { 'ᛇ': 'ei' }; // eihwaz decodes; encode never emits it
  (function () {
    var k;
    for (k in MORSE) MORSE_REV[MORSE[k]] = k;
    for (k in NATO) NATO_REV[NATO[k].toLowerCase()] = k;
    for (k in BRAILLE) BRAILLE_REV[BRAILLE[k]] = k;
    for (k in FUTHARK) FUTHARK_REV[FUTHARK[k]] = k;
  })();

  function canonical(text, codecId) {
    var s = stripAccents(String(text == null ? '' : text));
    switch (codecId) {
      case 'morse':
        return s.toUpperCase().replace(/[^A-Z0-9.,? ]+/g, ' ').replace(/ +/g, ' ').replace(/^ | $/g, '');
      case 'nato':
        return s.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').replace(/ +/g, ' ').replace(/^ | $/g, '');
      case 'braille':
        return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/ +/g, ' ').replace(/^ | $/g, '');
      case 'futhark':
        return s.toLowerCase().replace(/c|q/g, 'k').replace(/v/g, 'w').replace(/x/g, 'ks').replace(/y/g, 'i')
          .replace(/[^a-z ]+/g, ' ').replace(/ +/g, ' ').replace(/^ | $/g, '');
      default: throw new Error('unknown codec: ' + codecId);
    }
  }

  function encode(text, codecId) {
    var s = canonical(text, codecId), words, i, j, out;
    switch (codecId) {
      case 'morse':
        words = s.split(' ');
        out = [];
        for (i = 0; i < words.length; i++) {
          var letters = [];
          for (j = 0; j < words[i].length; j++) letters.push(MORSE[words[i].charAt(j)]);
          out.push(letters.join(' '));
        }
        return out.join(' / ');
      case 'nato':
        words = s.split(' ');
        out = [];
        for (i = 0; i < words.length; i++) {
          var codes = [];
          for (j = 0; j < words[i].length; j++) codes.push(NATO[words[i].charAt(j)]);
          out.push(codes.join(' '));
        }
        return out.join(' / ');
      case 'braille':
        out = '';
        var numMode = false;
        for (i = 0; i < s.length; i++) {
          var c = s.charAt(i);
          if (c === ' ') { out += ' '; numMode = false; }
          else if (c >= '0' && c <= '9') {
            if (!numMode) { out += BRAILLE_NUM; numMode = true; }
            out += BRAILLE[DIGIT_CELLS.charAt(c.charCodeAt(0) - 48)];
          } else {
            // a–j after digits needs the letter sign or it reads as a digit
            if (numMode && DIGIT_CELLS.indexOf(c) !== -1) out += BRAILLE_LETTER;
            numMode = false;
            out += BRAILLE[c];
          }
        }
        return out;
      case 'futhark':
        out = '';
        i = 0;
        while (i < s.length) {
          if (s.charAt(i) === ' ') { out += '᛬'; i++; continue; }
          var two = s.substr(i, 2);
          if (FUTHARK[two]) { out += FUTHARK[two]; i += 2; }
          else { out += FUTHARK[s.charAt(i)]; i++; }
        }
        return out;
      default: throw new Error('unknown codec: ' + codecId);
    }
  }

  function decode(text, codecId) {
    var s = String(text == null ? '' : text), words, i, j, out;
    switch (codecId) {
      case 'morse':
        words = s.replace(/^\s+|\s+$/g, '').split(/\s*\/\s*/);
        out = [];
        for (i = 0; i < words.length; i++) {
          var toks = words[i].split(/\s+/), w = '';
          for (j = 0; j < toks.length; j++) { if (toks[j]) w += MORSE_REV[toks[j]] || ''; }
          out.push(w);
        }
        return out.join(' ').replace(/ +/g, ' ').replace(/^ | $/g, '');
      case 'nato':
        words = s.replace(/^\s+|\s+$/g, '').split(/\s*\/\s*/);
        out = [];
        for (i = 0; i < words.length; i++) {
          var codes2 = words[i].split(/\s+/), w2 = '';
          for (j = 0; j < codes2.length; j++) { if (codes2[j]) w2 += NATO_REV[codes2[j].toLowerCase()] || ''; }
          out.push(w2);
        }
        return out.join(' ').replace(/ +/g, ' ').replace(/^ | $/g, '');
      case 'braille':
        out = '';
        var digits = false;
        for (i = 0; i < s.length; i++) {
          var cell = s.charAt(i);
          if (cell === ' ') { out += ' '; digits = false; }
          else if (cell === BRAILLE_NUM) digits = true;
          else if (cell === BRAILLE_LETTER) digits = false;
          else {
            var letter = BRAILLE_REV[cell];
            if (!letter) continue;
            if (digits && DIGIT_CELLS.indexOf(letter) !== -1) out += String(DIGIT_CELLS.indexOf(letter));
            else { digits = false; out += letter; }
          }
        }
        return out;
      case 'futhark':
        out = '';
        for (i = 0; i < s.length; i++) {
          var ch = s.charAt(i);
          if (ch === '᛬') out += ' ';
          else out += FUTHARK_REV[ch] || '';
        }
        return out;
      default: throw new Error('unknown codec: ' + codecId);
    }
  }

  /* ---------------- Vessel, the constructed language ---------------- */
  // A prefix-free CV-syllable codebook (no codeword is a prefix of another
  // — asserted by a meta-test) plus an apostrophe escape for capitals,
  // literal dashes and literal apostrophes, so that
  //   vesselDecode(vesselEncode(s)) === s   EXACTLY, for every string.

  var VESSEL = {
    a: 'ka', b: 'ze', c: 'vi', d: 'xo', e: 'ru', f: 'tha', g: 'she', h: 'ni', i: 'mo',
    j: 'lu', k: 'za', l: 've', m: 'xi', n: 'ro', o: 'thu', p: 'sha', q: 'ne', r: 'mi',
    s: 'lo', t: 'ku', u: 'zi', v: 'vo', w: 'xu', x: 'ra', y: 'the', z: 'shi',
    '0': 'no', '1': 'ma', '2': 'li', '3': 'ko', '4': 'zu', '5': 'va', '6': 'xe',
    '7': 'ri', '8': 'tho', '9': 'shu'
  };
  var VESSEL_REV = {};
  (function () { for (var k in VESSEL) VESSEL_REV[VESSEL[k]] = k; })();

  function vesselEncode(text) {
    var s = String(text == null ? '' : text), out = '', i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charAt(i);
      if (c >= 'A' && c <= 'Z') out += "'" + VESSEL[c.toLowerCase()];
      else if (VESSEL[c]) out += VESSEL[c];
      else if (c === ' ') out += '-';
      else if (c === '-') out += "'-";
      else if (c === "'") out += "''";
      else out += c;
    }
    return out;
  }

  function vesselDecode(text) {
    var s = String(text == null ? '' : text), out = '', i = 0, n = s.length;
    while (i < n) {
      var c = s.charAt(i);
      if (c === "'") {
        var next = s.charAt(i + 1);
        if (next === "'") { out += "'"; i += 2; continue; }
        if (next === '-') { out += '-'; i += 2; continue; }
        var cap = vesselWordAt(s, i + 1);
        if (cap) { out += VESSEL_REV[cap].toUpperCase(); i += 1 + cap.length; continue; }
        out += c; i++; continue;
      }
      if (c === '-') { out += ' '; i++; continue; }
      var w = vesselWordAt(s, i);
      if (w) { out += VESSEL_REV[w]; i += w.length; continue; }
      out += c; i++;
    }
    return out;
  }

  // longest codeword starting at i (3-char syllables before 2-char)
  function vesselWordAt(s, i) {
    var three = s.substr(i, 3), two = s.substr(i, 2);
    if (VESSEL_REV[three]) return three;
    if (VESSEL_REV[two]) return two;
    return null;
  }

  /* ---------------- orchestration ---------------- */

  function phraseIn(id, lang) {
    var p = PHRASE_BY_ID[id];
    if (!p) throw new Error('unknown phrase: ' + id);
    var L = LANG_BY_CODE[lang];
    if (!L) throw new Error('unknown lang: ' + lang);
    var text = lang === 'en' ? p.en : p.t[lang];
    var roman = null;
    if (p.r && p.r[lang]) roman = p.r[lang];
    else if (L.script === 'cyrillic' || L.script === 'greek' || L.script === 'kana' || L.script === 'hangul') {
      roman = romanize(text).roman;
    }
    return { text: text, roman: roman, dir: L.dir };
  }

  function cardsFor(fn) {
    var out = [];
    for (var i = 0; i < LANGS.length; i++) {
      var L = LANGS[i], v = fn(L.code);
      out.push({ lang: L.code, name: L.name, native: L.native, flag: L.flag, dir: L.dir, voice: L.voice, text: v.text, roman: v.roman });
    }
    return out;
  }

  function signalsFor(text) {
    return {
      signal: { morse: encode(text, 'morse'), nato: encode(text, 'nato') },
      vessel: { text: vesselEncode(text) }
    };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // The one hero call: route input to phrase / number / time / date and
  // answer in all 12 languages at once. `now` is accepted for signature
  // uniformity with the rest of the engine (the UI owns the clock).
  function translate(input, now) {
    var parsed = parseInput(input), sig;
    if (parsed.kind === 'number') {
      sig = signalsFor(String(parsed.n));
      return { kind: 'number', n: parsed.n, results: cardsFor(function (code) { return spellNumber(parsed.n, code); }), signal: sig.signal, vessel: sig.vessel };
    }
    if (parsed.kind === 'time') {
      sig = signalsFor(pad2(parsed.h) + ':' + pad2(parsed.m));
      return { kind: 'time', h: parsed.h, m: parsed.m, results: cardsFor(function (code) { return spellTime(parsed.h, parsed.m, code); }), signal: sig.signal, vessel: sig.vessel };
    }
    if (parsed.kind === 'date') {
      sig = signalsFor(parsed.y + '-' + pad2(parsed.m) + '-' + pad2(parsed.d));
      return { kind: 'date', y: parsed.y, m: parsed.m, d: parsed.d, results: cardsFor(function (code) { return spellDate(parsed.y, parsed.m, parsed.d, code); }), signal: sig.signal, vessel: sig.vessel };
    }
    var detected = detect(input);
    var match = matchPhrase(input);
    if (!match) {
      return {
        kind: 'none', detected: detected,
        suggestions: rankPhrases(input).slice(0, 3).map(function (r) { return { id: r.id, en: PHRASE_BY_ID[r.id].en, score: r.score }; })
      };
    }
    sig = signalsFor(match.en);
    return {
      kind: 'phrase', detected: detected,
      match: { id: match.id, cat: match.cat, en: match.en, score: match.score, sourceLang: match.sourceLang, alternates: match.alternates },
      results: cardsFor(function (code) { return phraseIn(match.id, code); }),
      signal: sig.signal, vessel: sig.vessel
    };
  }

  // Deterministic phrase-of-the-day: same UTC day, same phrase — and
  // never a plain-English feature card. The only clock-derived entry point.
  function dailyPhrase(now) {
    var h = hashStr('babel:' + Math.floor(now / DAY));
    var p = PHRASES[h % PHRASES.length];
    var li = (h >>> 8) % LANGS.length;
    if (LANGS[li].code === 'en') li = (li + 1) % LANGS.length;
    return { id: p.id, lang: LANGS[li].code };
  }

  /* ---------------- exports ---------------- */

  var E = {
    SECOND: SECOND, MINUTE: MINUTE, HOUR: HOUR, DAY: DAY,
    LANGS: LANGS, CATEGORIES: CATEGORIES, PHRASES: PHRASES, CODECS: CODECS,
    MATCH_THRESHOLD: MATCH_THRESHOLD, VESSEL: VESSEL,
    hashStr: hashStr, rand01: rand01, escapeHTML: escapeHTML,
    normalize: normalize, similarity: similarity, editDistance: editDistance,
    detect: detect, matchPhrase: matchPhrase, rankPhrases: rankPhrases,
    phraseIn: phraseIn, phrasesByCategory: phrasesByCategory,
    spellNumber: spellNumber, spellTime: spellTime, spellDate: spellDate,
    parseInput: parseInput, romanize: romanize,
    canonical: canonical, encode: encode, decode: decode,
    vesselEncode: vesselEncode, vesselDecode: vesselDecode,
    translate: translate, dailyPhrase: dailyPhrase
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  root.BabelEngine = E;
})(typeof self !== 'undefined' ? self : this);
