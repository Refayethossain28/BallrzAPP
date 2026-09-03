/* Babel — the pure universal-translator engine.
 * =====================================================================
 * Babel is the pocket Babel fish that never phones home: say or type
 * anything — "where is the train station?", "¿dónde está el baño?",
 * "1996", "14:30" — and a wall of 36 languages answers at once, in
 * native script with a romanization underneath. It is honest
 * engineering dressed as Star Trek: it only claims translation where
 * deterministic logic is genuinely correct — a hand-checked traveller
 * phrasebook reachable from any of its 36 languages (typo-tolerant),
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

  /* ---------------- the core twelve languages ---------------- */
  // The founding wall, chosen for script diversity and detection
  // separability; 24 more languages are folded in by the extended-wall
  // merge further down. RTL: Arabic here, joined later by fa/ur/he.

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
  // 40 traveller phrases, hand-translated into all 36 languages — the
  // first eleven non-English renderings inline here, the other 24
  // merged in from PX by the extended-wall section below.
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
    { id: 'how-are-you', cat: 'greetings', en: 'How are you?', aliases: ['how are you', "how's it going"],
      t: { es: '¿Cómo está?', fr: 'Comment allez-vous ?', de: 'Wie geht es Ihnen?', tr: 'Nasılsınız?', ru: 'Как у вас дела?', el: 'Πώς είστε;', ar: 'كيف حالك؟', hi: 'आप कैसे हैं?', zh: '你好吗？', ja: 'おげんきですか', ko: '잘 지내세요?' },
      r: { ar: 'kayfa haluk', hi: 'aap kaise hain', zh: 'nǐ hǎo ma' } },
    { id: 'im-fine', cat: 'greetings', en: "I'm fine, thank you", aliases: ["i'm fine thank you", 'i am fine', 'fine thanks'],
      t: { es: 'Estoy bien, gracias', fr: 'Je vais bien, merci', de: 'Mir geht es gut, danke', tr: 'İyiyim, teşekkürler', ru: 'Хорошо, спасибо', el: 'Καλά, ευχαριστώ', ar: 'أنا بخير، شكرًا', hi: 'मैं ठीक हूँ, धन्यवाद', zh: '我很好，谢谢', ja: 'げんきです、ありがとう ございます', ko: '잘 지내요, 감사합니다' },
      r: { ar: 'ana bikhayr shukran', hi: 'main theek hoon, dhanyavad', zh: 'wǒ hěn hǎo, xièxie' } },
    { id: 'whats-your-name', cat: 'greetings', en: 'What is your name?', aliases: ["what's your name", 'your name'],
      t: { es: '¿Cómo se llama?', fr: 'Comment vous appelez-vous ?', de: 'Wie heißen Sie?', tr: 'Adınız nedir?', ru: 'Как вас зовут?', el: 'Πώς σας λένε;', ar: 'ما اسمك؟', hi: 'आपका नाम क्या है?', zh: '你叫什么名字？', ja: 'おなまえは なんですか', ko: '이름이 뭐예요?' },
      r: { ar: 'ma ismuk', hi: 'aapka naam kya hai', zh: 'nǐ jiào shénme míngzi' } },
    { id: 'nice-to-meet-you', cat: 'greetings', en: 'Nice to meet you', aliases: ['pleased to meet you'],
      t: { es: 'Mucho gusto', fr: 'Enchanté', de: 'Freut mich', tr: 'Memnun oldum', ru: 'Очень приятно', el: 'Χαίρω πολύ', ar: 'تشرفنا', hi: 'आपसे मिलकर खुशी हुई', zh: '很高兴认识你', ja: 'はじめまして', ko: '만나서 반가워요' },
      r: { ar: 'tasharrafna', hi: 'aapse milkar khushi hui', zh: 'hěn gāoxìng rènshi nǐ' } },

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

  // shared-script disambiguators, filled in by the extended-language merge
  var SCRIPT_REFINE = {};

  var STOPWORDS = {
    en: ['the', 'is', 'where', 'you', 'a', 'to', 'of', 'and', 'i', 'it', 'my', 'do', 'please'],
    es: ['el', 'la', 'es', 'donde', 'que', 'de', 'un', 'una', 'por', 'como', 'esta', 'yo', 'favor'],
    fr: ['le', 'la', 'les', 'est', 'ou', 'que', 'de', 'un', 'une', 'vous', 'je', 'sont', 'plait'],
    de: ['der', 'die', 'das', 'ist', 'wo', 'ich', 'sie', 'ein', 'und', 'nicht', 'bitte', 'was', 'guten', 'danke', 'morgen', 'entschuldigung', 'sprechen'],
    tr: ['bir', 'bu', 'ne', 'nerede', 've', 'icin', 'mi', 'ben', 'var', 'yok', 'lutfen', 'evet']
  };

  var DIACRITICS = {
    es: 'ñ¡¿', fr: 'œêàçùè', de: 'ß', tr: 'ğşıİ'
  };

  var LATIN_LANGS = ['en', 'es', 'fr', 'de', 'tr'];

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
      if (SCRIPT_REFINE[bestScript.script]) lang = SCRIPT_REFINE[bestScript.script](text);
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
    var latin = LATIN_LANGS;
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
    if (!ranked.length || scores[0].raw < 3 || (scores[1] && scores[1].raw === scores[0].raw)) {
      return { best: null, ranked: ranked, script: 'latin' };
    }
    var conf = ranked.length > 1 ? ranked[0].score - ranked[1].score : ranked[0].score;
    conf = conf * Math.min(1, scores[0].raw / 6);
    return { best: { lang: ranked[0].lang, confidence: round4(conf) }, ranked: ranked, script: 'latin' };
  }

  /* ---------------- fuzzy phrase matching ---------------- */
  // Every phrase is reachable from its English text, its aliases, AND all
  // 36 bundled renderings (the index builds lazily, after the merge) — so
  // "¿dónde está el baño?" and "wher is teh
  // bathrom" both land on where-bathroom. Score = half token-set Jaccard,
  // half Damerau-Levenshtein similarity; ties break by phrase id.

  var MATCH_THRESHOLD = 0.55;

  var CANDIDATES = null;
  function buildCandidates() {
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
  }
  function getCandidates() {
    if (!CANDIDATES) CANDIDATES = buildCandidates();
    return CANDIDATES;
  }

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
    if (normText.length > 120) normText = normText.slice(0, 120);
    var toks = tokensOf(text), best = {}, i, cands = getCandidates();
    for (i = 0; i < cands.length; i++) {
      var c = cands[i], sc = scoreCandidate(normText, toks, c);
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
    if (PX[lang]) return xNum(lang, n);
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
    if (PX[lang]) return xTime(lang, h, m);
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
    if (PX[lang]) return xDate(lang, y, m, d);
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

  function romanize(text, langHint) {
    var src = stripAccents(String(text == null ? '' : text));
    // katakana → hiragana so one kana table serves both
    src = src.replace(/[ァ-ヶ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); });
    // the topic particle は is pronounced wa; treat any は that ends a
    // kana run (space, punctuation, …, end) as the particle
    src = src.replace(/は(?![ぁ-ゖー])/g, 'わ');
    // Ukrainian mode (г→h, и→y): by explicit hint, or a marker letter
    var ukMode = langHint === 'uk' || /[іїєґІЇЄҐ]/.test(src);
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


  /* ---------------- the extended wall: 24 more languages ---------------- */
  // Everything below was authored per-language and independently verified
  // by native-speaker-lens review; the composers implement each verified
  // rule set and every golden is pinned in scripts/test-babel-logic.mjs.
  // PX holds the data (phrases, months, number tables, clock words);
  // LANGS_X the metadata. The merge at the end folds it all into the
  // structures the rest of the engine already reads.

  var LANGS_X = [{"code":"pt","name":"Portuguese","native":"Português","flag":"🇧🇷","script":"latin","dir":"ltr","voice":"pt-BR"},{"code":"it","name":"Italian","native":"Italiano","flag":"🇮🇹","script":"latin","dir":"ltr","voice":"it-IT"},{"code":"nl","name":"Dutch","native":"Nederlands","flag":"🇳🇱","script":"latin","dir":"ltr","voice":"nl-NL"},{"code":"pl","name":"Polish","native":"Polski","flag":"🇵🇱","script":"latin","dir":"ltr","voice":"pl-PL"},{"code":"uk","name":"Ukrainian","native":"Українська","flag":"🇺🇦","script":"cyrillic","dir":"ltr","voice":"uk-UA"},{"code":"cs","name":"Czech","native":"Čeština","flag":"🇨🇿","script":"latin","dir":"ltr","voice":"cs-CZ"},{"code":"ro","name":"Romanian","native":"Română","flag":"🇷🇴","script":"latin","dir":"ltr","voice":"ro-RO"},{"code":"sv","name":"Swedish","native":"Svenska","flag":"🇸🇪","script":"latin","dir":"ltr","voice":"sv-SE"},{"code":"hu","name":"Hungarian","native":"Magyar","flag":"🇭🇺","script":"latin","dir":"ltr","voice":"hu-HU"},{"code":"id","name":"Indonesian","native":"Bahasa Indonesia","flag":"🇮🇩","script":"latin","dir":"ltr","voice":"id-ID"},{"code":"vi","name":"Vietnamese","native":"Tiếng Việt","flag":"🇻🇳","script":"latin","dir":"ltr","voice":"vi-VN"},{"code":"th","name":"Thai","native":"ไทย","flag":"🇹🇭","script":"thai","dir":"ltr","voice":"th-TH"},{"code":"fil","name":"Filipino","native":"Filipino","flag":"🇵🇭","script":"latin","dir":"ltr","voice":"fil-PH"},{"code":"fa","name":"Persian","native":"فارسی","flag":"🇮🇷","script":"arabic","dir":"rtl","voice":"fa-IR"},{"code":"he","name":"Hebrew","native":"עברית","flag":"🇮🇱","script":"hebrew","dir":"rtl","voice":"he-IL"},{"code":"bn","name":"Bengali","native":"বাংলা","flag":"🇧🇩","script":"bengali","dir":"ltr","voice":"bn-BD"},{"code":"ur","name":"Urdu","native":"اردو","flag":"🇵🇰","script":"arabic","dir":"rtl","voice":"ur-PK"},{"code":"pa","name":"Punjabi","native":"ਪੰਜਾਬੀ","flag":"🇮🇳","script":"gurmukhi","dir":"ltr","voice":"pa-IN"},{"code":"mr","name":"Marathi","native":"मराठी","flag":"🇮🇳","script":"devanagari","dir":"ltr","voice":"mr-IN"},{"code":"ta","name":"Tamil","native":"தமிழ்","flag":"🇮🇳","script":"tamil","dir":"ltr","voice":"ta-IN"},{"code":"te","name":"Telugu","native":"తెలుగు","flag":"🇮🇳","script":"telugu","dir":"ltr","voice":"te-IN"},{"code":"sw","name":"Swahili","native":"Kiswahili","flag":"🇰🇪","script":"latin","dir":"ltr","voice":"sw-KE"},{"code":"am","name":"Amharic","native":"አማርኛ","flag":"🇪🇹","script":"ethiopic","dir":"ltr","voice":"am-ET"},{"code":"ka","name":"Georgian","native":"ქართული","flag":"🇬🇪","script":"georgian","dir":"ltr","voice":"ka-GE"}];

  var PX = {"pt":{"ph":{"help":["Socorro!",0],"call-police":["Chame a polícia",0],"need-doctor":["Preciso de um médico",0],"where-hospital":["Onde fica o hospital?",0],"im-allergic":["Tenho alergia",0],"im-lost":["Estou perdido",0],"hello":["Olá",0],"good-morning":["Bom dia",0],"good-evening":["Boa noite",0],"goodbye":["Tchau",0],"please":["Por favor",0],"thank-you":["Obrigado",0],"excuse-me":["Com licença",0],"yes":["Sim",0],"no":["Não",0],"dont-understand":["Não entendo",0],"speak-english":["Você fala inglês?",0],"speak-slowly":["Fale mais devagar, por favor",0],"write-down":["Você pode escrever isso?",0],"my-name-is":["Meu nome é…",0],"where-bathroom":["Onde fica o banheiro?",0],"where-station":["Onde fica a estação de trem?",0],"where-airport":["Onde fica o aeroporto?",0],"left":["À esquerda",0],"right":["À direita",0],"straight-ahead":["Sempre em frente",0],"one-ticket":["Uma passagem, por favor",0],"taxi-please":["Um táxi, por favor",0],"how-much":["Quanto custa?",0],"the-bill":["A conta, por favor",0],"water-please":["Água, por favor",0],"menu-please":["O cardápio, por favor",0],"vegetarian":["Sou vegetariano",0],"delicious":["Está delicioso!",0],"take-cards":["Vocês aceitam cartão?",0],"too-expensive":["É muito caro",0],"how-are-you":["Como vai?",0],"im-fine":["Estou bem, obrigado",0],"whats-your-name":["Qual é o seu nome?",0],"nice-to-meet-you":["Muito prazer",0]},"mon":["janeiro","fevereiro","março","abril","maio","junho","julho","agosto","setembro","outubro","novembro","dezembro"],"monR":null,"num":{"u":["zero","um","dois","três","quatro","cinco","seis","sete","oito","nove","dez","onze","doze","treze","quatorze","quinze","dezesseis","dezessete","dezoito","dezenove"],"t":["","","vinte","trinta","quarenta","cinquenta","sessenta","setenta","oitenta","noventa"],"h":["","cento","duzentos","trezentos","quatrocentos","quinhentos","seiscentos","setecentos","oitocentos","novecentos"],"hx":"cem"},"det":[["onde","fica","nao","voce","obrigado","quanto","preciso","fala","muito","isso","com","uma","fale","devagar","passagem","cardapio","licenca","esquerda","direita","socorro","aceitam","cartao"],"ãõâô"]},"it":{"ph":{"help":["Aiuto!",0],"call-police":["Chiami la polizia",0],"need-doctor":["Ho bisogno di un medico",0],"where-hospital":["Dov'è l'ospedale?",0],"im-allergic":["Ho un'allergia",0],"im-lost":["Mi sono perso",0],"hello":["Salve",0],"good-morning":["Buongiorno",0],"good-evening":["Buonasera",0],"goodbye":["Arrivederci",0],"please":["Per favore",0],"thank-you":["Grazie",0],"excuse-me":["Mi scusi",0],"yes":["Sì",0],"no":["No",0],"dont-understand":["Non capisco",0],"speak-english":["Parla inglese?",0],"speak-slowly":["Parli più lentamente, per favore",0],"write-down":["Può scriverlo?",0],"my-name-is":["Mi chiamo…",0],"where-bathroom":["Dov'è il bagno?",0],"where-station":["Dov'è la stazione?",0],"where-airport":["Dov'è l'aeroporto?",0],"left":["A sinistra",0],"right":["A destra",0],"straight-ahead":["Sempre dritto",0],"one-ticket":["Un biglietto, per favore",0],"taxi-please":["Un taxi, per favore",0],"how-much":["Quanto costa?",0],"the-bill":["Il conto, per favore",0],"water-please":["Dell'acqua, per favore",0],"menu-please":["Il menù, per favore",0],"vegetarian":["Sono vegetariano",0],"delicious":["È delizioso!",0],"take-cards":["Accettate carte di credito?",0],"too-expensive":["È troppo caro",0],"how-are-you":["Come sta?",0],"im-fine":["Sto bene, grazie",0],"whats-your-name":["Come si chiama?",0],"nice-to-meet-you":["Piacere di conoscerla",0]},"mon":["gennaio","febbraio","marzo","aprile","maggio","giugno","luglio","agosto","settembre","ottobre","novembre","dicembre"],"monR":null,"num":{"u":["zero","uno","due","tre","quattro","cinque","sei","sette","otto","nove","dieci","undici","dodici","tredici","quattordici","quindici","sedici","diciassette","diciotto","diciannove"],"t":["","","venti","trenta","quaranta","cinquanta","sessanta","settanta","ottanta","novanta"]},"det":[["il","dov","dove","che","sono","non","per","grazie","scusi","vorrei","questo","e","stazione"],"ìòÈ"]},"nl":{"ph":{"help":["Help!",0],"call-police":["Bel de politie!",0],"need-doctor":["Ik heb een dokter nodig",0],"where-hospital":["Waar is het ziekenhuis?",0],"im-allergic":["Ik ben allergisch",0],"im-lost":["Ik ben verdwaald",0],"hello":["Hallo",0],"good-morning":["Goedemorgen",0],"good-evening":["Goedenavond",0],"goodbye":["Tot ziens",0],"please":["Alstublieft",0],"thank-you":["Dank u wel",0],"excuse-me":["Pardon",0],"yes":["Ja",0],"no":["Nee",0],"dont-understand":["Ik begrijp het niet",0],"speak-english":["Spreekt u Engels?",0],"speak-slowly":["Kunt u langzamer spreken, alstublieft?",0],"write-down":["Kunt u dat opschrijven?",0],"my-name-is":["Mijn naam is…",0],"where-bathroom":["Waar is het toilet?",0],"where-station":["Waar is het station?",0],"where-airport":["Waar is het vliegveld?",0],"left":["Links",0],"right":["Rechts",0],"straight-ahead":["Rechtdoor",0],"one-ticket":["Eén kaartje, alstublieft",0],"taxi-please":["Een taxi, alstublieft",0],"how-much":["Hoeveel kost het?",0],"the-bill":["De rekening, alstublieft",0],"water-please":["Water, alstublieft",0],"menu-please":["De menukaart, alstublieft",0],"vegetarian":["Ik ben vegetariër",0],"delicious":["Het is heerlijk!",0],"take-cards":["Kan ik met kaart betalen?",0],"too-expensive":["Dat is te duur",0],"how-are-you":["Hoe gaat het met u?",0],"im-fine":["Goed, dank u",0],"whats-your-name":["Hoe heet u?",0],"nice-to-meet-you":["Aangenaam kennis te maken",0]},"mon":["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"],"monR":null,"num":{"u":["nul","een","twee","drie","vier","vijf","zes","zeven","acht","negen","tien","elf","twaalf","dertien","veertien","vijftien","zestien","zeventien","achttien","negentien"],"t":["","","twintig","dertig","veertig","vijftig","zestig","zeventig","tachtig","negentig"]},"det":[["het","waar","ik","een","niet","alstublieft","hoeveel","kunt","spreekt","graag","wel","mijn"],"ëïĳ"]},"pl":{"ph":{"help":["Pomocy!",0],"call-police":["Proszę wezwać policję",0],"need-doctor":["Potrzebuję lekarza",0],"where-hospital":["Gdzie jest szpital?",0],"im-allergic":["Mam alergię",0],"im-lost":["Zgubiłem się",0],"hello":["Dzień dobry",0],"good-morning":["Dzień dobry",0],"good-evening":["Dobry wieczór",0],"goodbye":["Do widzenia",0],"please":["Proszę",0],"thank-you":["Dziękuję",0],"excuse-me":["Przepraszam",0],"yes":["Tak",0],"no":["Nie",0],"dont-understand":["Nie rozumiem",0],"speak-english":["Czy mówi pan po angielsku?",0],"speak-slowly":["Proszę mówić wolniej",0],"write-down":["Proszę to napisać",0],"my-name-is":["Nazywam się…",0],"where-bathroom":["Gdzie jest toaleta?",0],"where-station":["Gdzie jest dworzec kolejowy?",0],"where-airport":["Gdzie jest lotnisko?",0],"left":["Po lewej stronie",0],"right":["Po prawej stronie",0],"straight-ahead":["Prosto",0],"one-ticket":["Poproszę jeden bilet",0],"taxi-please":["Poproszę taksówkę",0],"how-much":["Ile to kosztuje?",0],"the-bill":["Poproszę rachunek",0],"water-please":["Poproszę wodę",0],"menu-please":["Poproszę menu",0],"vegetarian":["Jestem wegetarianinem",0],"delicious":["To jest pyszne!",0],"take-cards":["Czy można płacić kartą?",0],"too-expensive":["To za drogo",0],"how-are-you":["Jak się pan/pani miewa?",0],"im-fine":["Dobrze, dziękuję",0],"whats-your-name":["Jak się pan/pani nazywa?",0],"nice-to-meet-you":["Bardzo mi miło",0]},"mon":["stycznia","lutego","marca","kwietnia","maja","czerwca","lipca","sierpnia","września","października","listopada","grudnia"],"monR":null,"num":{"u":["zero","jeden","dwa","trzy","cztery","pięć","sześć","siedem","osiem","dziewięć","dziesięć","jedenaście","dwanaście","trzynaście","czternaście","piętnaście","szesnaście","siedemnaście","osiemnaście","dziewiętnaście"],"t":["dwadzieścia","trzydzieści","czterdzieści","pięćdziesiąt","sześćdziesiąt","siedemdziesiąt","osiemdziesiąt","dziewięćdziesiąt"],"h":["sto","dwieście","trzysta","czterysta","pięćset","sześćset","siedemset","osiemset","dziewięćset"],"th":["tysiąc","tysiące","tysięcy"],"mi":["milion","miliony","milionów"]},"det":[["gdzie","jest","czy","prosze","poprosze","przepraszam","dziekuje","tak","rozumiem","kosztuje","jak","dworzec"],"ąęłńśźżć"]},"uk":{"ph":{"help":["Допоможіть!",0],"call-police":["Викличте поліцію",0],"need-doctor":["Мені потрібен лікар",0],"where-hospital":["Де лікарня?",0],"im-allergic":["У мене алергія",0],"im-lost":["Я заблукав",0],"hello":["Добрий день",0],"good-morning":["Доброго ранку",0],"good-evening":["Добрий вечір",0],"goodbye":["До побачення",0],"please":["Будь ласка",0],"thank-you":["Дякую",0],"excuse-me":["Вибачте",0],"yes":["Так",0],"no":["Ні",0],"dont-understand":["Я не розумію",0],"speak-english":["Ви розмовляєте англійською?",0],"speak-slowly":["Говоріть повільніше, будь ласка",0],"write-down":["Напишіть це, будь ласка",0],"my-name-is":["Мене звати…",0],"where-bathroom":["Де туалет?",0],"where-station":["Де вокзал?",0],"where-airport":["Де аеропорт?",0],"left":["Ліворуч",0],"right":["Праворуч",0],"straight-ahead":["Прямо",0],"one-ticket":["Один квиток, будь ласка",0],"taxi-please":["Таксі, будь ласка",0],"how-much":["Скільки це коштує?",0],"the-bill":["Рахунок, будь ласка",0],"water-please":["Води, будь ласка",0],"menu-please":["Меню, будь ласка",0],"vegetarian":["Я вегетаріанець",0],"delicious":["Дуже смачно!",0],"take-cards":["Можна карткою?",0],"too-expensive":["Занадто дорого",0],"how-are-you":["Як у вас справи?",0],"im-fine":["Добре, дякую",0],"whats-your-name":["Як вас звати?",0],"nice-to-meet-you":["Дуже приємно",0]},"mon":["січня","лютого","березня","квітня","травня","червня","липня","серпня","вересня","жовтня","листопада","грудня"],"monR":null,"num":{"u":["нуль","один","два","три","чотири","п’ять","шість","сім","вісім","дев’ять","десять","одинадцять","дванадцять","тринадцять","чотирнадцять","п’ятнадцять","шістнадцять","сімнадцять","вісімнадцять","дев’ятнадцять"],"t":["двадцять","тридцять","сорок","п’ятдесят","шістдесят","сімдесят","вісімдесят","дев’яносто"],"h":["сто","двісті","триста","чотириста","п’ятсот","шістсот","сімсот","вісімсот","дев’ятсот"],"fem":{"1":"одна","2":"дві"},"th":["тисяча","тисячі","тисяч"],"mi":["мільйон","мільйони","мільйонів"]}},"cs":{"ph":{"help":["Pomoc!",0],"call-police":["Zavolejte policii",0],"need-doctor":["Potřebuji lékaře",0],"where-hospital":["Kde je nemocnice?",0],"im-allergic":["Mám alergii",0],"im-lost":["Ztratil jsem se",0],"hello":["Dobrý den",0],"good-morning":["Dobré ráno",0],"good-evening":["Dobrý večer",0],"goodbye":["Na shledanou",0],"please":["Prosím",0],"thank-you":["Děkuji",0],"excuse-me":["Promiňte",0],"yes":["Ano",0],"no":["Ne",0],"dont-understand":["Nerozumím",0],"speak-english":["Mluvíte anglicky?",0],"speak-slowly":["Mluvte pomalu, prosím",0],"write-down":["Můžete mi to napsat?",0],"my-name-is":["Jmenuji se…",0],"where-bathroom":["Kde je toaleta?",0],"where-station":["Kde je nádraží?",0],"where-airport":["Kde je letiště?",0],"left":["Vlevo",0],"right":["Vpravo",0],"straight-ahead":["Rovně",0],"one-ticket":["Jednu jízdenku, prosím",0],"taxi-please":["Taxi, prosím",0],"how-much":["Kolik to stojí?",0],"the-bill":["Účet, prosím",0],"water-please":["Vodu, prosím",0],"menu-please":["Jídelní lístek, prosím",0],"vegetarian":["Jsem vegetarián",0],"delicious":["Je to výborné!",0],"take-cards":["Berete karty?",0],"too-expensive":["To je moc drahé",0],"how-are-you":["Jak se máte?",0],"im-fine":["Mám se dobře, děkuji",0],"whats-your-name":["Jak se jmenujete?",0],"nice-to-meet-you":["Těší mě",0]},"mon":["ledna","února","března","dubna","května","června","července","srpna","září","října","listopadu","prosince"],"monR":null,"num":{"u":["nula","jedna","dva","tři","čtyři","pět","šest","sedm","osm","devět","deset","jedenáct","dvanáct","třináct","čtrnáct","patnáct","šestnáct","sedmnáct","osmnáct","devatenáct"],"t":["dvacet","třicet","čtyřicet","padesát","šedesát","sedmdesát","osmdesát","devadesát"],"h":["sto","dvě stě","tři sta","čtyři sta","pět set","šest set","sedm set","osm set","devět set"],"th":["tisíc","tisíce","tisíc"],"mi":["milion","miliony","milionů"]},"det":[["kde","prosim","jsem","kolik","dekuji","ano","mluvite","nerozumim","muzete","dobry","stoji"],"čěřůťďňšž"]},"ro":{"ph":{"help":["Ajutor!",0],"call-police":["Chemați poliția",0],"need-doctor":["Am nevoie de un doctor",0],"where-hospital":["Unde este spitalul?",0],"im-allergic":["Am o alergie",0],"im-lost":["M-am rătăcit",0],"hello":["Bună ziua",0],"good-morning":["Bună dimineața",0],"good-evening":["Bună seara",0],"goodbye":["La revedere",0],"please":["Vă rog",0],"thank-you":["Mulțumesc",0],"excuse-me":["Scuzați-mă",0],"yes":["Da",0],"no":["Nu",0],"dont-understand":["Nu înțeleg",0],"speak-english":["Vorbiți engleza?",0],"speak-slowly":["Vorbiți mai rar, vă rog",0],"write-down":["Puteți să scrieți asta?",0],"my-name-is":["Mă numesc…",0],"where-bathroom":["Unde este toaleta?",0],"where-station":["Unde este gara?",0],"where-airport":["Unde este aeroportul?",0],"left":["La stânga",0],"right":["La dreapta",0],"straight-ahead":["Drept înainte",0],"one-ticket":["Un bilet, vă rog",0],"taxi-please":["Un taxi, vă rog",0],"how-much":["Cât costă?",0],"the-bill":["Nota de plată, vă rog",0],"water-please":["Apă, vă rog",0],"menu-please":["Meniul, vă rog",0],"vegetarian":["Sunt vegetarian",0],"delicious":["E delicios!",0],"take-cards":["Acceptați carduri?",0],"too-expensive":["E prea scump",0],"how-are-you":["Ce mai faceți?",0],"im-fine":["Bine, mulțumesc",0],"whats-your-name":["Cum vă numiți?",0],"nice-to-meet-you":["Îmi pare bine",0]},"mon":["ianuarie","februarie","martie","aprilie","mai","iunie","iulie","august","septembrie","octombrie","noiembrie","decembrie"],"monR":null,"num":{"u":["zero","unu","doi","trei","patru","cinci","șase","șapte","opt","nouă","zece","unsprezece","doisprezece","treisprezece","paisprezece","cincisprezece","șaisprezece","șaptesprezece","optsprezece","nouăsprezece"],"t":["","zece","douăzeci","treizeci","patruzeci","cincizeci","șaizeci","șaptezeci","optzeci","nouăzeci"],"fem":{"1":"una","2":"două","12":"douăsprezece"}},"det":[["unde","este","sunt","nu","rog","vorbiti","multumesc","buna","inteleg","pentru","aveti","dumneavoastra"],"șțăȘȚĂţŢ"]},"sv":{"ph":{"help":["Hjälp!",0],"call-police":["Ring polisen",0],"need-doctor":["Jag behöver en läkare",0],"where-hospital":["Var är sjukhuset?",0],"im-allergic":["Jag är allergisk",0],"im-lost":["Jag har gått vilse",0],"hello":["Hej",0],"good-morning":["God morgon",0],"good-evening":["God kväll",0],"goodbye":["Hej då",0],"please":["Tack",0],"thank-you":["Tack",0],"excuse-me":["Ursäkta",0],"yes":["Ja",0],"no":["Nej",0],"dont-understand":["Jag förstår inte",0],"speak-english":["Talar du engelska?",0],"speak-slowly":["Kan du tala långsammare?",0],"write-down":["Kan du skriva ner det?",0],"my-name-is":["Jag heter…",0],"where-bathroom":["Var är toaletten?",0],"where-station":["Var är tågstationen?",0],"where-airport":["Var är flygplatsen?",0],"left":["Till vänster",0],"right":["Till höger",0],"straight-ahead":["Rakt fram",0],"one-ticket":["En biljett, tack",0],"taxi-please":["En taxi, tack",0],"how-much":["Vad kostar det?",0],"the-bill":["Notan, tack",0],"water-please":["Vatten, tack",0],"menu-please":["Menyn, tack",0],"vegetarian":["Jag är vegetarian",0],"delicious":["Det är jättegott!",0],"take-cards":["Tar ni kort?",0],"too-expensive":["Det är för dyrt",0],"how-are-you":["Hur mår du?",0],"im-fine":["Jag mår bra, tack",0],"whats-your-name":["Vad heter du?",0],"nice-to-meet-you":["Trevligt att träffas",0]},"mon":["januari","februari","mars","april","maj","juni","juli","augusti","september","oktober","november","december"],"monR":null,"num":{"u":["noll","ett","två","tre","fyra","fem","sex","sju","åtta","nio","tio","elva","tolv","tretton","fjorton","femton","sexton","sjutton","arton","nitton"],"t":["","","tjugo","trettio","fyrtio","femtio","sextio","sjuttio","åttio","nittio"]},"det":[["jag","ar","och","inte","det","tack","hej","kan","har","ligger","vad","ursakta"],"åäö"]},"hu":{"ph":{"help":["Segítség!",0],"call-police":["Hívja a rendőrséget!",0],"need-doctor":["Orvosra van szükségem",0],"where-hospital":["Hol van a kórház?",0],"im-allergic":["Allergiás vagyok",0],"im-lost":["Eltévedtem",0],"hello":["Jó napot!",0],"good-morning":["Jó reggelt!",0],"good-evening":["Jó estét!",0],"goodbye":["Viszontlátásra!",0],"please":["Kérem",0],"thank-you":["Köszönöm",0],"excuse-me":["Elnézést",0],"yes":["Igen",0],"no":["Nem",0],"dont-understand":["Nem értem",0],"speak-english":["Beszél angolul?",0],"speak-slowly":["Kérem, beszéljen lassabban",0],"write-down":["Le tudná írni?",0],"my-name-is":["A nevem…",0],"where-bathroom":["Hol van a mosdó?",0],"where-station":["Hol van a vasútállomás?",0],"where-airport":["Hol van a repülőtér?",0],"left":["Balra",0],"right":["Jobbra",0],"straight-ahead":["Egyenesen előre",0],"one-ticket":["Egy jegyet kérek",0],"taxi-please":["Egy taxit kérek",0],"how-much":["Mennyibe kerül?",0],"the-bill":["A számlát kérem",0],"water-please":["Vizet kérek",0],"menu-please":["Az étlapot kérem",0],"vegetarian":["Vegetáriánus vagyok",0],"delicious":["Nagyon finom!",0],"take-cards":["Fizethetek kártyával?",0],"too-expensive":["Ez túl drága",0],"how-are-you":["Hogy van?",0],"im-fine":["Jól vagyok, köszönöm",0],"whats-your-name":["Hogy hívják?",0],"nice-to-meet-you":["Örvendek",0]},"mon":["január","február","március","április","május","június","július","augusztus","szeptember","október","november","december"],"monR":null,"num":{"u":["nulla","egy","kettő","három","négy","öt","hat","hét","nyolc","kilenc"],"t":["","tíz","húsz","harminc","negyven","ötven","hatvan","hetven","nyolcvan","kilencven"]},"det":[["hol","van","egy","nem","igen","kerem","kerek","koszonom","vagyok","beszel","mennyibe","nagyon"],"öüőű"]},"id":{"ph":{"help":["Tolong!",0],"call-police":["Panggil polisi!",0],"need-doctor":["Saya perlu dokter",0],"where-hospital":["Di mana rumah sakit?",0],"im-allergic":["Saya punya alergi",0],"im-lost":["Saya tersesat",0],"hello":["Halo",0],"good-morning":["Selamat pagi",0],"good-evening":["Selamat malam",0],"goodbye":["Selamat tinggal",0],"please":["Tolong",0],"thank-you":["Terima kasih",0],"excuse-me":["Permisi",0],"yes":["Ya",0],"no":["Tidak",0],"dont-understand":["Saya tidak mengerti",0],"speak-english":["Apakah Anda bisa berbahasa Inggris?",0],"speak-slowly":["Tolong bicara pelan-pelan",0],"write-down":["Bisa tolong tuliskan?",0],"my-name-is":["Nama saya…",0],"where-bathroom":["Di mana kamar kecil?",0],"where-station":["Di mana stasiun kereta?",0],"where-airport":["Di mana bandara?",0],"left":["Di sebelah kiri",0],"right":["Di sebelah kanan",0],"straight-ahead":["Lurus terus",0],"one-ticket":["Minta satu tiket",0],"taxi-please":["Tolong panggilkan taksi",0],"how-much":["Berapa harganya?",0],"the-bill":["Minta bonnya",0],"water-please":["Minta air putih",0],"menu-please":["Minta menunya",0],"vegetarian":["Saya vegetarian",0],"delicious":["Enak sekali!",0],"take-cards":["Bisa bayar pakai kartu?",0],"too-expensive":["Itu terlalu mahal",0],"how-are-you":["Apa kabar?",0],"im-fine":["Baik-baik saja, terima kasih",0],"whats-your-name":["Siapa nama Anda?",0],"nice-to-meet-you":["Senang bertemu dengan Anda",0]},"mon":["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"],"monR":null,"num":{"u":["nol","satu","dua","tiga","empat","lima","enam","tujuh","delapan","sembilan","sepuluh","sebelas","dua belas","tiga belas","empat belas","lima belas","enam belas","tujuh belas","delapan belas","sembilan belas"],"t":["","sepuluh","dua puluh","tiga puluh","empat puluh","lima puluh","enam puluh","tujuh puluh","delapan puluh","sembilan puluh"],"h":["","seratus","dua ratus","tiga ratus","empat ratus","lima ratus","enam ratus","tujuh ratus","delapan ratus","sembilan ratus"]},"det":[["saya","di","mana","tidak","bisa","apakah","tolong","minta","selamat","kasih","anda","berapa"],""]},"vi":{"ph":{"help":["Cứu tôi với!",0],"call-police":["Làm ơn gọi cảnh sát",0],"need-doctor":["Tôi cần gặp bác sĩ",0],"where-hospital":["Bệnh viện ở đâu?",0],"im-allergic":["Tôi bị dị ứng",0],"im-lost":["Tôi bị lạc đường",0],"hello":["Xin chào",0],"good-morning":["Chào buổi sáng",0],"good-evening":["Chào buổi tối",0],"goodbye":["Tạm biệt",0],"please":["Làm ơn",0],"thank-you":["Cảm ơn",0],"excuse-me":["Xin lỗi",0],"yes":["Vâng",0],"no":["Không",0],"dont-understand":["Tôi không hiểu",0],"speak-english":["Bạn có nói tiếng Anh không?",0],"speak-slowly":["Làm ơn nói chậm lại",0],"write-down":["Bạn có thể viết ra được không?",0],"my-name-is":["Tôi tên là…",0],"where-bathroom":["Nhà vệ sinh ở đâu?",0],"where-station":["Ga tàu ở đâu?",0],"where-airport":["Sân bay ở đâu?",0],"left":["Bên trái",0],"right":["Bên phải",0],"straight-ahead":["Đi thẳng",0],"one-ticket":["Cho tôi một vé",0],"taxi-please":["Làm ơn gọi taxi",0],"how-much":["Bao nhiêu tiền?",0],"the-bill":["Làm ơn tính tiền",0],"water-please":["Cho tôi xin nước",0],"menu-please":["Cho tôi xem thực đơn",0],"vegetarian":["Tôi ăn chay",0],"delicious":["Ngon quá!",0],"take-cards":["Có nhận thẻ không?",0],"too-expensive":["Đắt quá!",0],"how-are-you":["Bạn có khỏe không?",0],"im-fine":["Tôi khỏe, cảm ơn",0],"whats-your-name":["Bạn tên là gì?",0],"nice-to-meet-you":["Rất vui được gặp bạn",0]},"mon":["tháng một","tháng hai","tháng ba","tháng tư","tháng năm","tháng sáu","tháng bảy","tháng tám","tháng chín","tháng mười","tháng mười một","tháng mười hai"],"monR":null,"num":{"u":["không","một","hai","ba","bốn","năm","sáu","bảy","tám","chín"]},"det":[["toi","khong","dau","đau","xin","chao","lam","nhieu","tien","duoc","đuoc","cua","nuoc","bao"],"đĐơƠưƯạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịĩọỏốồổỗộớờởỡợụủũứừửữựỳỵỷỹý"]},"th":{"ph":{"help":["ช่วยด้วย!","chuai duai"],"call-police":["ช่วยเรียกตำรวจหน่อย","chuai riak tamruat noi"],"need-doctor":["ฉันต้องการหมอ","chan tongkan mo"],"where-hospital":["โรงพยาบาลอยู่ที่ไหน","rongphayaban yu thi nai"],"im-allergic":["ฉันมีอาการแพ้","chan mi akan phae"],"im-lost":["ฉันหลงทาง","chan long thang"],"hello":["สวัสดี","sawatdi"],"good-morning":["สวัสดีตอนเช้า","sawatdi ton chao"],"good-evening":["สวัสดีตอนเย็น","sawatdi ton yen"],"goodbye":["ลาก่อน","la kon"],"please":["กรุณา","karuna"],"thank-you":["ขอบคุณ","khop khun"],"excuse-me":["ขอโทษ","kho thot"],"yes":["ใช่","chai"],"no":["ไม่ใช่","mai chai"],"dont-understand":["ฉันไม่เข้าใจ","chan mai khao chai"],"speak-english":["คุณพูดภาษาอังกฤษได้ไหม","khun phut phasa angkrit dai mai"],"speak-slowly":["พูดช้าๆ หน่อย","phut cha cha noi"],"write-down":["ช่วยเขียนให้หน่อยได้ไหม","chuai khian hai noi dai mai"],"my-name-is":["ฉันชื่อ…","chan chue ..."],"where-bathroom":["ห้องน้ำอยู่ที่ไหน","hong nam yu thi nai"],"where-station":["สถานีรถไฟอยู่ที่ไหน","sathani rotfai yu thi nai"],"where-airport":["สนามบินอยู่ที่ไหน","sanam bin yu thi nai"],"left":["ทางซ้าย","thang sai"],"right":["ทางขวา","thang khwa"],"straight-ahead":["ตรงไป","trong pai"],"one-ticket":["ขอตั๋วหนึ่งใบ","kho tua nueng bai"],"taxi-please":["ขอแท็กซี่หน่อย","kho thaeksi noi"],"how-much":["เท่าไหร่","thao rai"],"the-bill":["เก็บเงินด้วย","kep ngoen duai"],"water-please":["ขอน้ำหน่อย","kho nam noi"],"menu-please":["ขอเมนูหน่อย","kho menu noi"],"vegetarian":["ฉันกินมังสวิรัติ","chan kin mangsawirat"],"delicious":["อร่อยมาก!","aroi mak"],"take-cards":["รับบัตรไหม","rap bat mai"],"too-expensive":["แพงเกินไป","phaeng koen pai"],"how-are-you":["สบายดีไหม","sabai di mai"],"im-fine":["สบายดี ขอบคุณ","sabai di khop khun"],"whats-your-name":["คุณชื่ออะไร","khun chue arai"],"nice-to-meet-you":["ยินดีที่ได้รู้จัก","yindi thi dai ruchak"]},"mon":["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"],"monR":["mokkarakhom","kumphaphan","minakhom","mesayon","phruetsaphakhom","mithunayon","karakadakhom","singhakhom","kanyayon","tulakhom","phruetsachikayon","thanwakhom"],"num":{"u":["ศูนย์","หนึ่ง","สอง","สาม","สี่","ห้า","หก","เจ็ด","แปด","เก้า"],"ur":["sun","nueng","song","sam","si","ha","hok","chet","paet","kao"],"p":{"10":["สิบ","sip"],"100":["ร้อย","roi"],"1000":["พัน","phan"],"10000":["หมื่น","muen"],"100000":["แสน","saen"],"1000000":["ล้าน","lan"]},"et":["เอ็ด","et"],"yi":["ยี่","yi"]}},"fil":{"ph":{"help":["Saklolo!",0],"call-police":["Pakitawag po ang pulis",0],"need-doctor":["Kailangan ko po ng doktor",0],"where-hospital":["Nasaan po ang ospital?",0],"im-allergic":["May alerhiya po ako",0],"im-lost":["Naliligaw po ako",0],"hello":["Kumusta po",0],"good-morning":["Magandang umaga po",0],"good-evening":["Magandang gabi po",0],"goodbye":["Paalam na po",0],"please":["Pakiusap po",0],"thank-you":["Salamat po",0],"excuse-me":["Paumanhin po",0],"yes":["Opo",0],"no":["Hindi po",0],"dont-understand":["Hindi ko po naiintindihan",0],"speak-english":["Marunong po ba kayong mag-Ingles?",0],"speak-slowly":["Pakibagalan po ang pagsasalita",0],"write-down":["Puwede po bang isulat ninyo iyon?",0],"my-name-is":["Ang pangalan ko po ay…",0],"where-bathroom":["Nasaan po ang banyo?",0],"where-station":["Nasaan po ang istasyon ng tren?",0],"where-airport":["Nasaan po ang paliparan?",0],"left":["Sa kaliwa po",0],"right":["Sa kanan po",0],"straight-ahead":["Diretso lang po",0],"one-ticket":["Isang tiket po",0],"taxi-please":["Pakitawag po ng taksi",0],"how-much":["Magkano po?",0],"the-bill":["Pahingi po ng bill",0],"water-please":["Pahingi po ng tubig",0],"menu-please":["Pahingi po ng menu",0],"vegetarian":["Vegetarian po ako",0],"delicious":["Ang sarap po!",0],"take-cards":["Tumatanggap po ba kayo ng card?",0],"too-expensive":["Masyado pong mahal",0],"how-are-you":["Kumusta po kayo?",0],"im-fine":["Mabuti naman po, salamat",0],"whats-your-name":["Ano po ang pangalan ninyo?",0],"nice-to-meet-you":["Ikinagagalak ko po kayong makilala",0]},"mon":["Enero","Pebrero","Marso","Abril","Mayo","Hunyo","Hulyo","Agosto","Setyembre","Oktubre","Nobyembre","Disyembre"],"monR":null,"num":{"u":["sero","isa","dalawa","tatlo","apat","lima","anim","pito","walo","siyam"],"teens":["labing-isa","labindalawa","labintatlo","labing-apat","labinlima","labing-anim","labimpito","labingwalo","labinsiyam"],"t":["","sampu","dalawampu","tatlumpu","apatnapu","limampu","animnapu","pitumpu","walumpu","siyamnapu"],"h":["","isang daan","dalawang daan","tatlong daan","apat na raan","limang daan","anim na raan","pitong daan","walong daan","siyam na raan"]},"det":[["po","ang","ng","mga","ako","nasaan","kayo","hindi","opo","salamat","magkano","pahingi"],""],"time":{"hourNames":["ala-una","alas-dos","alas-tres","alas-kuwatro","alas-singko","alas-sais","alas-siyete","alas-otso","alas-nuwebe","alas-diyes","alas-onse","alas-dose"],"minuteUnits":["","uno","dos","tres","kuwatro","singko","sais","siyete","otso","nuwebe"],"minuteTeens":["diyes","onse","dose","trese","katorse","kinse","disisais","disisiyete","disiotso","disinuwebe"],"minuteTens":["","","beynte","trenta","kuwarenta","singkuwenta"]}},"fa":{"ph":{"help":["کمک!","komak"],"call-police":["به پلیس زنگ بزنید","be polis zang bezanid"],"need-doctor":["دکتر لازم دارم","doktor lazem daram"],"where-hospital":["بیمارستان کجاست؟","bimarestan kojast"],"im-allergic":["من آلرژی دارم","man alerzhi daram"],"im-lost":["من گم شده‌ام","man gom shode-am"],"hello":["سلام","salam"],"good-morning":["صبح بخیر","sobh bekheyr"],"good-evening":["عصر بخیر","asr bekheyr"],"goodbye":["خداحافظ","khodahafez"],"please":["لطفاً","lotfan"],"thank-you":["متشکرم","motashakkeram"],"excuse-me":["ببخشید","bebakhshid"],"yes":["بله","bale"],"no":["نه","na"],"dont-understand":["نمی‌فهمم","nemifahmam"],"speak-english":["انگلیسی صحبت می‌کنید؟","engelisi sohbat mikonid"],"speak-slowly":["لطفاً آهسته صحبت کنید","lotfan aheste sohbat konid"],"write-down":["می‌توانید آن را بنویسید؟","mitavanid an ra benevisid"],"my-name-is":["اسم من … است","esm-e man … ast"],"where-bathroom":["دستشویی کجاست؟","dastshui kojast"],"where-station":["ایستگاه قطار کجاست؟","istgah-e ghatar kojast"],"where-airport":["فرودگاه کجاست؟","forudgah kojast"],"left":["سمت چپ","samt-e chap"],"right":["سمت راست","samt-e rast"],"straight-ahead":["مستقیم","mostaghim"],"one-ticket":["یک بلیت، لطفاً","yek belit lotfan"],"taxi-please":["یک تاکسی، لطفاً","yek taksi lotfan"],"how-much":["قیمتش چقدر است؟","gheymatash cheghadr ast"],"the-bill":["صورت‌حساب، لطفاً","surat-hesab lotfan"],"water-please":["آب، لطفاً","ab lotfan"],"menu-please":["منو، لطفاً","meno lotfan"],"vegetarian":["من گیاه‌خوارم","man giyahkharam"],"delicious":["خیلی خوشمزه است!","kheyli khoshmaze ast"],"take-cards":["کارت قبول می‌کنید؟","kart ghabul mikonid"],"too-expensive":["خیلی گران است","kheyli geran ast"],"how-are-you":["حال شما چطور است؟","hal-e shoma chetor ast"],"im-fine":["خوبم، متشکرم","khubam motashakkeram"],"whats-your-name":["اسم شما چیست؟","esm-e shoma chist"],"nice-to-meet-you":["از آشنایی با شما خوشوقتم","az ashnayi ba shoma khoshvaghtam"]},"mon":["ژانویه","فوریه","مارس","آوریل","مه","ژوئن","ژوئیه","اوت","سپتامبر","اکتبر","نوامبر","دسامبر"],"monR":["zhanviye","fevriye","mars","avril","me","zhu’an","zhu’iye","ut","septambr","oktobr","novambr","desambr"],"num":{"u":["صفر","یک","دو","سه","چهار","پنج","شش","هفت","هشت","نه","ده","یازده","دوازده","سیزده","چهارده","پانزده","شانزده","هفده","هجده","نوزده"],"ur":["sefr","yek","do","se","chahar","panj","shesh","haft","hasht","noh","dah","yazdah","davazdah","sizdah","chahardah","panzdah","shanzdah","hefdah","hejdah","nuzdah"],"t":["","","بیست","سی","چهل","پنجاه","شصت","هفتاد","هشتاد","نود"],"tr":["","","bist","si","chehel","panjah","shast","haftad","hashtad","navad"],"h":["","صد","دویست","سیصد","چهارصد","پانصد","ششصد","هفتصد","هشتصد","نهصد"],"hr":["","sad","devist","sisad","chaharsad","pansad","sheshsad","haftsad","hashtsad","nohsad"]}},"he":{"ph":{"help":["הצילו!","hatzilu"],"call-police":["תתקשרו למשטרה","titkashru la-mishtara"],"need-doctor":["אני צריך רופא","ani tzarich rofe"],"where-hospital":["איפה בית החולים?","eifo beit ha-cholim"],"im-allergic":["יש לי אלרגיה","yesh li alergya"],"im-lost":["הלכתי לאיבוד","halachti le'ibud"],"hello":["שלום","shalom"],"good-morning":["בוקר טוב","boker tov"],"good-evening":["ערב טוב","erev tov"],"goodbye":["להתראות","lehitra'ot"],"please":["בבקשה","bevakasha"],"thank-you":["תודה","toda"],"excuse-me":["סליחה","slicha"],"yes":["כן","ken"],"no":["לא","lo"],"dont-understand":["אני לא מבין","ani lo mevin"],"speak-english":["אתה מדבר אנגלית?","ata medaber anglit"],"speak-slowly":["דבר לאט, בבקשה","daber le'at bevakasha"],"write-down":["אתה יכול לכתוב את זה?","ata yachol lichtov et ze"],"my-name-is":["קוראים לי…","kor'im li…"],"where-bathroom":["איפה השירותים?","eifo ha-sherutim"],"where-station":["איפה תחנת הרכבת?","eifo tachanat ha-rakevet"],"where-airport":["איפה שדה התעופה?","eifo sde ha-te'ufa"],"left":["שמאלה","smola"],"right":["ימינה","yamina"],"straight-ahead":["ישר","yashar"],"one-ticket":["כרטיס אחד, בבקשה","kartis echad bevakasha"],"taxi-please":["מונית, בבקשה","monit bevakasha"],"how-much":["כמה זה עולה?","kama ze ole"],"the-bill":["חשבון, בבקשה","cheshbon bevakasha"],"water-please":["מים, בבקשה","mayim bevakasha"],"menu-please":["תפריט, בבקשה","tafrit bevakasha"],"vegetarian":["אני צמחוני","ani tzimchoni"],"delicious":["זה טעים מאוד!","ze ta'im me'od"],"take-cards":["אתם מקבלים כרטיסי אשראי?","atem mekablim kartisei ashrai"],"too-expensive":["זה יקר מדי","ze yakar midai"],"how-are-you":["מה שלומך?","ma shlomcha"],"im-fine":["אני בסדר, תודה","ani beseder toda"],"whats-your-name":["איך קוראים לך?","eich kor'im lecha"],"nice-to-meet-you":["נעים מאוד","na'im me'od"]},"mon":["ינואר","פברואר","מרץ","אפריל","מאי","יוני","יולי","אוגוסט","ספטמבר","אוקטובר","נובמבר","דצמבר"],"monR":["yanuar","februar","mertz","april","mai","yuni","yuli","ogust","september","oktober","november","detzember"],"num":{"u":["אפס","אחת","שתיים","שלוש","ארבע","חמש","שש","שבע","שמונה","תשע","עשר","אחת עשרה","שתים עשרה","שלוש עשרה","ארבע עשרה","חמש עשרה","שש עשרה","שבע עשרה","שמונה עשרה","תשע עשרה"],"ur":["efes","achat","shtayim","shalosh","arba","chamesh","shesh","sheva","shmone","tesha","eser","achat esre","shteim esre","shlosh esre","arba esre","chamesh esre","shesh esre","shva esre","shmone esre","tsha esre"],"t":["עשרים","שלושים","ארבעים","חמישים","שישים","שבעים","שמונים","תשעים"],"tr":["esrim","shloshim","arba'im","chamishim","shishim","shiv'im","shmonim","tish'im"],"h":["מאה","מאתיים","שלוש מאות","ארבע מאות","חמש מאות","שש מאות","שבע מאות","שמונה מאות","תשע מאות"],"hr":["me'a","matayim","shlosh me'ot","arba me'ot","chamesh me'ot","shesh me'ot","shva me'ot","shmone me'ot","tsha me'ot"],"um":["אחד","שניים","שלושה","ארבעה","חמישה","שישה","שבעה","שמונה","תשעה","עשרה"],"umr":["echad","shnayim","shlosha","arba'a","chamisha","shisha","shiv'a","shmona","tish'a","asara"],"cm":["שלושת","ארבעת","חמשת","ששת","שבעת","שמונת","תשעת","עשרת"],"cmr":["shloshet","arba'at","chameshet","sheshet","shiv'at","shmonat","tish'at","aseret"]}},"bn":{"ph":{"help":["সাহায্য করুন!","shahajjo korun"],"call-police":["পুলিশ ডাকুন","pulish dakun"],"need-doctor":["আমার ডাক্তার দরকার","amar daktar dorkar"],"where-hospital":["হাসপাতাল কোথায়?","hashpatal kothay"],"im-allergic":["আমার অ্যালার্জি আছে","amar allergy achhe"],"im-lost":["আমি হারিয়ে গেছি","ami hariye gechhi"],"hello":["নমস্কার","nomoshkar"],"good-morning":["শুভ সকাল","shubho shokal"],"good-evening":["শুভ সন্ধ্যা","shubho shondha"],"goodbye":["বিদায়","biday"],"please":["দয়া করে","doya kore"],"thank-you":["ধন্যবাদ","dhonnobad"],"excuse-me":["মাফ করবেন","maf korben"],"yes":["হ্যাঁ","hyan"],"no":["না","na"],"dont-understand":["আমি বুঝতে পারছি না","ami bujhte parchhi na"],"speak-english":["আপনি কি ইংরেজি বলতে পারেন?","apni ki ingreji bolte paren"],"speak-slowly":["দয়া করে আস্তে বলুন","doya kore aste bolun"],"write-down":["এটা কি লিখে দিতে পারবেন?","eta ki likhe dite parben"],"my-name-is":["আমার নাম…","amar nam…"],"where-bathroom":["টয়লেট কোথায়?","toilet kothay"],"where-station":["রেল স্টেশন কোথায়?","rel steshon kothay"],"where-airport":["বিমানবন্দর কোথায়?","bimanbondor kothay"],"left":["বাম দিকে","bam dike"],"right":["ডান দিকে","dan dike"],"straight-ahead":["সোজা","shoja"],"one-ticket":["একটা টিকিট দিন","ekta tikit din"],"taxi-please":["একটা ট্যাক্সি ডাকুন","ekta taxi dakun"],"how-much":["এটার দাম কত?","etar dam koto"],"the-bill":["বিল দিন","bil din"],"water-please":["পানি দিন","pani din"],"menu-please":["মেনু দিন","menu din"],"vegetarian":["আমি নিরামিষ খাই","ami niramish khai"],"delicious":["খুব মজা!","khub moja"],"take-cards":["আপনি কি কার্ড নেন?","apni ki card nen"],"too-expensive":["এটা খুব দামি","eta khub dami"],"how-are-you":["আপনি কেমন আছেন?","apni kemon achhen"],"im-fine":["আমি ভালো আছি, ধন্যবাদ","ami bhalo achhi, dhonnobad"],"whats-your-name":["আপনার নাম কী?","apnar nam ki"],"nice-to-meet-you":["আপনার সাথে দেখা হয়ে ভালো লাগলো","apnar sathe dekha hoye bhalo laglo"]},"mon":["জানুয়ারি","ফেব্রুয়ারি","মার্চ","এপ্রিল","মে","জুন","জুলাই","আগস্ট","সেপ্টেম্বর","অক্টোবর","নভেম্বর","ডিসেম্বর"],"monR":["januari","februari","march","april","me","jun","julai","agost","september","october","november","december"],"num":{"u99":["শূন্য","এক","দুই","তিন","চার","পাঁচ","ছয়","সাত","আট","নয়","দশ","এগারো","বারো","তেরো","চৌদ্দ","পনেরো","ষোলো","সতেরো","আঠারো","উনিশ","বিশ","একুশ","বাইশ","তেইশ","চব্বিশ","পঁচিশ","ছাব্বিশ","সাতাশ","আঠাশ","ঊনত্রিশ","ত্রিশ","একত্রিশ","বত্রিশ","তেত্রিশ","চৌত্রিশ","পঁয়ত্রিশ","ছত্রিশ","সাঁইত্রিশ","আটত্রিশ","ঊনচল্লিশ","চল্লিশ","একচল্লিশ","বিয়াল্লিশ","তেতাল্লিশ","চুয়াল্লিশ","পঁয়তাল্লিশ","ছেচল্লিশ","সাতচল্লিশ","আটচল্লিশ","ঊনপঞ্চাশ","পঞ্চাশ","একান্ন","বাহান্ন","তিপ্পান্ন","চুয়ান্ন","পঞ্চান্ন","ছাপ্পান্ন","সাতান্ন","আটান্ন","ঊনষাট","ষাট","একষট্টি","বাষট্টি","তেষট্টি","চৌষট্টি","পঁয়ষট্টি","ছেষট্টি","সাতষট্টি","আটষট্টি","ঊনসত্তর","সত্তর","একাত্তর","বাহাত্তর","তিয়াত্তর","চুয়াত্তর","পঁচাত্তর","ছিয়াত্তর","সাতাত্তর","আটাত্তর","ঊনআশি","আশি","একাশি","বিরাশি","তিরাশি","চুরাশি","পঁচাশি","ছিয়াশি","সাতাশি","আটাশি","ঊননব্বই","নব্বই","একানব্বই","বিরানব্বই","তিরানব্বই","চুরানব্বই","পঁচানব্বই","ছিয়ানব্বই","সাতানব্বই","আটানব্বই","নিরানব্বই"],"u99r":["shunno","ek","dui","tin","char","pach","chhoy","shat","at","noy","dosh","egaro","baro","tero","chouddo","ponero","sholo","shotero","atharo","unish","bish","ekush","baish","teish","chobbish","pochish","chhabbish","shatash","athash","unotrish","trish","ektrish","botrish","tetrish","choutrish","poytrish","chhotrish","shaitrish","attrish","unochollish","chollish","ekchollish","biyallish","tetallish","chuyallish","poytallish","chhechollish","shatchollish","atchollish","unoponchash","ponchash","ekanno","bahanno","tippanno","chuyanno","ponchanno","chhappanno","shatanno","atanno","unoshaat","shaat","ekshotti","bashotti","teshotti","choushotti","poyshotti","chheshotti","shatshotti","atshotti","unoshottor","shottor","ekattor","bahattor","tiyattor","chuyattor","pochattor","chhiyattor","shatattor","atattor","unashi","ashi","ekashi","birashi","tirashi","churashi","pochashi","chhiyashi","shatashi","atashi","unonobboi","nobboi","ekanobboi","biranobboi","tiranobboi","churanobboi","pochanobboi","chhiyanobboi","shatanobboi","atanobboi","niranobboi"],"hFused":["একশ","দুইশ","তিনশ","চারশ","পাঁচশ","ছয়শ","সাতশ","আটশ","নয়শ"],"hFusedR":["eksho","duisho","tinsho","charsho","pachsho","chhoysho","shatsho","atsho","noysho"],"sc":{"thousand":["হাজার","hajar"],"lakh":["লাখ","lakh"],"crore":["কোটি","koti"]}}},"ur":{"ph":{"help":["مدد کیجیے!","madad kijie"],"call-police":["پولیس کو بلائیے","pulis ko bulaie"],"need-doctor":["مجھے ڈاکٹر چاہیے","mujhe doctor chahie"],"where-hospital":["ہسپتال کہاں ہے؟","haspatal kahan hai"],"im-allergic":["مجھے الرجی ہے","mujhe allergy hai"],"im-lost":["میں راستہ بھول گیا ہوں","main raasta bhool gaya hoon"],"hello":["السلام علیکم","assalam alaikum"],"good-morning":["صبح بخیر","subah bakhair"],"good-evening":["شام بخیر","shaam bakhair"],"goodbye":["خدا حافظ","khuda hafiz"],"please":["براہ مہربانی","barah-e-meharbani"],"thank-you":["شکریہ","shukriya"],"excuse-me":["معاف کیجیے","maaf kijie"],"yes":["جی ہاں","ji haan"],"no":["جی نہیں","ji nahin"],"dont-understand":["مجھے سمجھ نہیں آئی","mujhe samajh nahin aai"],"speak-english":["کیا آپ انگریزی بولتے ہیں؟","kya aap angrezi bolte hain"],"speak-slowly":["براہ مہربانی آہستہ بولیے","barah-e-meharbani aahista bolie"],"write-down":["کیا آپ یہ لکھ سکتے ہیں؟","kya aap yeh likh sakte hain"],"my-name-is":["میرا نام … ہے","mera naam … hai"],"where-bathroom":["واش روم کہاں ہے؟","washroom kahan hai"],"where-station":["ریلوے اسٹیشن کہاں ہے؟","railway station kahan hai"],"where-airport":["ہوائی اڈا کہاں ہے؟","hawai adda kahan hai"],"left":["بائیں طرف","bayen taraf"],"right":["دائیں طرف","dayen taraf"],"straight-ahead":["سیدھا آگے","seedha aage"],"one-ticket":["ایک ٹکٹ دیجیے","ek ticket dijie"],"taxi-please":["ایک ٹیکسی بلائیے","ek taxi bulaie"],"how-much":["یہ کتنے کا ہے؟","yeh kitne ka hai"],"the-bill":["بل دیجیے","bill dijie"],"water-please":["پانی دیجیے","paani dijie"],"menu-please":["مینو دیجیے","menu dijie"],"vegetarian":["میں سبزی خور ہوں","main sabzi khor hoon"],"delicious":["بہت مزیدار ہے!","bohat mazedar hai"],"take-cards":["کیا آپ کارڈ لیتے ہیں؟","kya aap card lete hain"],"too-expensive":["یہ بہت مہنگا ہے","yeh bohat mehnga hai"],"how-are-you":["آپ کیسے ہیں؟","aap kaise hain"],"im-fine":["میں ٹھیک ہوں، شکریہ","main theek hoon shukriya"],"whats-your-name":["آپ کا نام کیا ہے؟","aap ka naam kya hai"],"nice-to-meet-you":["آپ سے مل کر خوشی ہوئی","aap se mil kar khushi hui"]},"mon":["جنوری","فروری","مارچ","اپریل","مئی","جون","جولائی","اگست","ستمبر","اکتوبر","نومبر","دسمبر"],"monR":["janvari","farvari","march","april","mai","june","julai","agast","sitambar","aktoobar","navambar","disambar"],"num":{"u99":["صفر","ایک","دو","تین","چار","پانچ","چھ","سات","آٹھ","نو","دس","گیارہ","بارہ","تیرہ","چودہ","پندرہ","سولہ","سترہ","اٹھارہ","انیس","بیس","اکیس","بائیس","تئیس","چوبیس","پچیس","چھبیس","ستائیس","اٹھائیس","انتیس","تیس","اکتیس","بتیس","تینتیس","چونتیس","پینتیس","چھتیس","سینتیس","اڑتیس","انتالیس","چالیس","اکتالیس","بیالیس","تینتالیس","چوالیس","پینتالیس","چھیالیس","سینتالیس","اڑتالیس","انچاس","پچاس","اکاون","باون","ترپن","چون","پچپن","چھپن","ستاون","اٹھاون","انسٹھ","ساٹھ","اکسٹھ","باسٹھ","ترسٹھ","چونسٹھ","پینسٹھ","چھیاسٹھ","سڑسٹھ","اڑسٹھ","انہتر","ستر","اکہتر","بہتر","تہتر","چوہتر","پچھتر","چھہتر","ستتر","اٹھتر","اناسی","اسی","اکیاسی","بیاسی","تراسی","چوراسی","پچاسی","چھیاسی","ستاسی","اٹھاسی","نواسی","نوے","اکانوے","بانوے","ترانوے","چورانوے","پچانوے","چھیانوے","ستانوے","اٹھانوے","ننانوے"],"u99r":["sifar","ek","do","teen","chaar","paanch","chhe","saat","aath","nau","das","gyaarah","baarah","terah","chaudah","pandrah","solah","satrah","athaarah","unnees","bees","ikkees","baees","teis","chaubees","pachchees","chhabbees","sattaees","atthaees","untees","tees","iktees","battees","taintees","chauntees","paintees","chhattees","saintees","artees","untaalees","chaalees","iktaalees","bayaalees","taintaalees","chawaalees","paintaalees","chhiyaalees","saintaalees","artaalees","unchaas","pachaas","ikaawan","baawan","tirpan","chawwan","pachpan","chhappan","sattaawan","atthaawan","unsath","saath","iksath","baasath","tirsath","chaunsath","painsath","chhiyaasath","sarsath","arsath","unhattar","sattar","ikahattar","bahattar","tihattar","chauhattar","pachhattar","chhihattar","satattar","athattar","unaasi","assi","ikyaasi","bayaasi","tiraasi","chauraasi","pachaasi","chhiyaasi","sattaasi","atthaasi","nawaasi","nawwe","ikaanwe","baanwe","tiraanwe","chauraanwe","pachaanwe","chhiyaanwe","sattaanwe","atthaanwe","ninnaanwe"],"sc":{"hundred":["سو","sau"],"thousand":["ہزار","hazaar"],"lakh":["لاکھ","laakh"],"crore":["کروڑ","crore"]}}},"pa":{"ph":{"help":["ਮਦਦ ਕਰੋ!","madad karo"],"call-police":["ਪੁਲਿਸ ਨੂੰ ਬੁਲਾਓ","pulis nu bulao"],"need-doctor":["ਮੈਨੂੰ ਡਾਕਟਰ ਚਾਹੀਦਾ ਹੈ","mainu daktar chaahida hai"],"where-hospital":["ਹਸਪਤਾਲ ਕਿੱਥੇ ਹੈ?","haspataal kitthe hai"],"im-allergic":["ਮੈਨੂੰ ਐਲਰਜੀ ਹੈ","mainu allergy hai"],"im-lost":["ਮੈਂ ਗੁਆਚ ਗਿਆ ਹਾਂ","main guaach gia haan"],"hello":["ਸਤ ਸ੍ਰੀ ਅਕਾਲ","sat sri akaal"],"good-morning":["ਸ਼ੁਭ ਸਵੇਰ","shubh saver"],"good-evening":["ਸ਼ੁਭ ਸ਼ਾਮ","shubh shaam"],"goodbye":["ਅਲਵਿਦਾ","alvida"],"please":["ਕਿਰਪਾ ਕਰਕੇ","kirpa karke"],"thank-you":["ਧੰਨਵਾਦ","dhannvaad"],"excuse-me":["ਮਾਫ਼ ਕਰਨਾ","maaf karna"],"yes":["ਹਾਂ ਜੀ","haan ji"],"no":["ਨਹੀਂ ਜੀ","nahin ji"],"dont-understand":["ਮੈਨੂੰ ਸਮਝ ਨਹੀਂ ਆਈ","mainu samajh nahin aai"],"speak-english":["ਕੀ ਤੁਸੀਂ ਅੰਗਰੇਜ਼ੀ ਬੋਲਦੇ ਹੋ?","ki tusin angrezi bolde ho"],"speak-slowly":["ਕਿਰਪਾ ਕਰਕੇ ਹੌਲੀ ਬੋਲੋ","kirpa karke hauli bolo"],"write-down":["ਕੀ ਤੁਸੀਂ ਇਹ ਲਿਖ ਸਕਦੇ ਹੋ?","ki tusin ih likh sakde ho"],"my-name-is":["ਮੇਰਾ ਨਾਮ … ਹੈ","mera naam … hai"],"where-bathroom":["ਗੁਸਲਖ਼ਾਨਾ ਕਿੱਥੇ ਹੈ?","gusalkhaana kitthe hai"],"where-station":["ਰੇਲਵੇ ਸਟੇਸ਼ਨ ਕਿੱਥੇ ਹੈ?","railway station kitthe hai"],"where-airport":["ਹਵਾਈ ਅੱਡਾ ਕਿੱਥੇ ਹੈ?","havaai adda kitthe hai"],"left":["ਖੱਬੇ ਪਾਸੇ","khabbe paase"],"right":["ਸੱਜੇ ਪਾਸੇ","sajje paase"],"straight-ahead":["ਸਿੱਧਾ ਅੱਗੇ","siddha agge"],"one-ticket":["ਇੱਕ ਟਿਕਟ ਦਿਓ ਜੀ","ikk ticket dio ji"],"taxi-please":["ਇੱਕ ਟੈਕਸੀ ਬੁਲਾਓ ਜੀ","ikk taxi bulao ji"],"how-much":["ਇਹ ਕਿੰਨੇ ਦਾ ਹੈ?","ih kinne da hai"],"the-bill":["ਬਿੱਲ ਦਿਓ ਜੀ","bill dio ji"],"water-please":["ਪਾਣੀ ਦਿਓ ਜੀ","paani dio ji"],"menu-please":["ਮੀਨੂ ਦਿਓ ਜੀ","menu dio ji"],"vegetarian":["ਮੈਂ ਸ਼ਾਕਾਹਾਰੀ ਹਾਂ","main shaakaahaari haan"],"delicious":["ਬਹੁਤ ਸੁਆਦ ਹੈ!","bahut suaad hai"],"take-cards":["ਕੀ ਕਾਰਡ ਚੱਲੇਗਾ?","ki card challega"],"too-expensive":["ਇਹ ਬਹੁਤ ਮਹਿੰਗਾ ਹੈ","ih bahut mahinga hai"],"how-are-you":["ਤੁਸੀਂ ਕਿਵੇਂ ਹੋ?","tusi kiven ho"],"im-fine":["ਮੈਂ ਠੀਕ ਹਾਂ, ਧੰਨਵਾਦ","main theek haan, dhannvaad"],"whats-your-name":["ਤੁਹਾਡਾ ਨਾਮ ਕੀ ਹੈ?","tuhada naam ki hai"],"nice-to-meet-you":["ਤੁਹਾਨੂੰ ਮਿਲ ਕੇ ਖੁਸ਼ੀ ਹੋਈ","tuhanu mil ke khushi hoi"]},"mon":["ਜਨਵਰੀ","ਫਰਵਰੀ","ਮਾਰਚ","ਅਪ੍ਰੈਲ","ਮਈ","ਜੂਨ","ਜੁਲਾਈ","ਅਗਸਤ","ਸਤੰਬਰ","ਅਕਤੂਬਰ","ਨਵੰਬਰ","ਦਸੰਬਰ"],"monR":["janvari","farvari","march","april","mai","june","julai","agast","satambar","aktoobar","navambar","dasambar"],"num":{"u99":["ਸਿਫ਼ਰ","ਇੱਕ","ਦੋ","ਤਿੰਨ","ਚਾਰ","ਪੰਜ","ਛੇ","ਸੱਤ","ਅੱਠ","ਨੌਂ","ਦਸ","ਗਿਆਰਾਂ","ਬਾਰਾਂ","ਤੇਰਾਂ","ਚੌਦਾਂ","ਪੰਦਰਾਂ","ਸੋਲਾਂ","ਸਤਾਰਾਂ","ਅਠਾਰਾਂ","ਉੱਨੀ","ਵੀਹ","ਇੱਕੀ","ਬਾਈ","ਤੇਈ","ਚੌਵੀ","ਪੱਚੀ","ਛੱਬੀ","ਸਤਾਈ","ਅਠਾਈ","ਉਨੱਤੀ","ਤੀਹ","ਇਕੱਤੀ","ਬੱਤੀ","ਤੇਤੀ","ਚੌਂਤੀ","ਪੈਂਤੀ","ਛੱਤੀ","ਸੈਂਤੀ","ਅਠੱਤੀ","ਉਨਤਾਲੀ","ਚਾਲੀ","ਇਕਤਾਲੀ","ਬਤਾਲੀ","ਤਰਤਾਲੀ","ਚੁਤਾਲੀ","ਪੰਤਾਲੀ","ਛਿਆਲੀ","ਸੰਤਾਲੀ","ਅਠਤਾਲੀ","ਉਨੰਜਾ","ਪੰਜਾਹ","ਇਕਵੰਜਾ","ਬਵੰਜਾ","ਤਰਵੰਜਾ","ਚੁਰੰਜਾ","ਪਚਵੰਜਾ","ਛਪੰਜਾ","ਸਤਵੰਜਾ","ਅਠਵੰਜਾ","ਉਨਾਹਠ","ਸੱਠ","ਇਕਾਹਠ","ਬਾਹਠ","ਤਰੇਹਠ","ਚੌਂਹਠ","ਪੈਂਹਠ","ਛਿਆਹਠ","ਸਤਾਹਠ","ਅਠਾਹਠ","ਉਨੱਤਰ","ਸੱਤਰ","ਇਕਹੱਤਰ","ਬਹੱਤਰ","ਤਿਹੱਤਰ","ਚੌਹੱਤਰ","ਪੰਝੱਤਰ","ਛਿਹੱਤਰ","ਸਤੱਤਰ","ਅਠੱਤਰ","ਉਨਾਸੀ","ਅੱਸੀ","ਇਕਾਸੀ","ਬਿਆਸੀ","ਤਰਾਸੀ","ਚੁਰਾਸੀ","ਪਚਾਸੀ","ਛਿਆਸੀ","ਸਤਾਸੀ","ਅਠਾਸੀ","ਉਨਾਨਵੇਂ","ਨੱਬੇ","ਇਕਾਨਵੇਂ","ਬਾਨਵੇਂ","ਤਰਾਨਵੇਂ","ਚੁਰਾਨਵੇਂ","ਪਚਾਨਵੇਂ","ਛਿਆਨਵੇਂ","ਸਤਾਨਵੇਂ","ਅਠਾਨਵੇਂ","ਨੜਿੰਨਵੇਂ"],"u99r":["sifar","ikk","do","tinn","chaar","panj","chhe","satt","atth","naun","das","giaaraan","baaraan","teraan","chaudaan","pandraan","solaan","sataaraan","athaaraan","unni","veeh","ikki","baai","tei","chauvi","pachchi","chhabbi","sataai","athaai","unatti","teeh","ikatti","batti","teti","chaunti","painti","chhatti","sainti","athatti","untaali","chaali","iktaali","bataali","tartaali","chutaali","pantaali","chhiaali","santaali","athtaali","unanja","panjaah","ikvanja","bavanja","tarvanja","churanja","pachvanja","chhapanja","satvanja","athvanja","unaahath","satth","ikaahath","baahath","tarehath","chaunhath","painhath","chhiaahath","sataahath","athaahath","unattar","sattar","ikahattar","bahattar","tihattar","chauhattar","panjhattar","chhihattar","satattar","athattar","unaasi","assi","ikaasi","biaasi","taraasi","churaasi","pachaasi","chhiaasi","sataasi","athaasi","unaanven","nabbe","ikaanven","baanven","taraanven","churaanven","pachaanven","chhiaanven","sataanven","athaanven","narhinnven"],"sc":{"hundred":["ਸੌ","sau"],"thousand":["ਹਜ਼ਾਰ","hazaar"],"lakh":["ਲੱਖ","lakkh"],"crore":["ਕਰੋੜ","karor"]}}},"mr":{"ph":{"help":["मदत करा!","madat kara"],"call-police":["पोलिसांना बोलवा","polisanna bolva"],"need-doctor":["मला डॉक्टरची गरज आहे","mala doctorchi garaj aahe"],"where-hospital":["रुग्णालय कुठे आहे?","rugnalay kuthe aahe"],"im-allergic":["मला ॲलर्जी आहे","mala allergy aahe"],"im-lost":["मी हरवलो आहे","mi haravlo aahe"],"hello":["नमस्कार","namaskar"],"good-morning":["शुभ सकाळ","shubh sakal"],"good-evening":["शुभ संध्याकाळ","shubh sandhyakal"],"goodbye":["पुन्हा भेटू","punha bhetu"],"please":["कृपया","krupaya"],"thank-you":["धन्यवाद","dhanyavad"],"excuse-me":["माफ करा","maaf kara"],"yes":["हो","ho"],"no":["नाही","nahi"],"dont-understand":["मला समजत नाही","mala samajat nahi"],"speak-english":["तुम्ही इंग्रजी बोलता का?","tumhi ingraji bolta ka"],"speak-slowly":["कृपया हळू बोला","krupaya halu bola"],"write-down":["तुम्ही ते लिहून द्याल का?","tumhi te lihun dyal ka"],"my-name-is":["माझे नाव … आहे","mazhe naav … aahe"],"where-bathroom":["शौचालय कुठे आहे?","shauchalay kuthe aahe"],"where-station":["रेल्वे स्टेशन कुठे आहे?","railway station kuthe aahe"],"where-airport":["विमानतळ कुठे आहे?","vimantal kuthe aahe"],"left":["डावीकडे","davikade"],"right":["उजवीकडे","ujavikade"],"straight-ahead":["सरळ पुढे","saral pudhe"],"one-ticket":["एक तिकीट द्या","ek tikit dya"],"taxi-please":["एक टॅक्सी बोलवा","ek taxi bolva"],"how-much":["याची किंमत किती?","yachi kimmat kiti"],"the-bill":["बिल द्या","bil dya"],"water-please":["पाणी द्या","pani dya"],"menu-please":["मेनू द्या","menu dya"],"vegetarian":["मी शाकाहारी आहे","mi shakahari aahe"],"delicious":["खूप चविष्ट आहे!","khup chavisht aahe"],"take-cards":["कार्ड चालेल का?","card chalel ka"],"too-expensive":["हे खूप महाग आहे","he khup mahag aahe"],"how-are-you":["तुम्ही कसे आहात?","tumhi kase aahat"],"im-fine":["मी ठीक आहे, धन्यवाद","mi theek aahe, dhanyavad"],"whats-your-name":["तुमचे नाव काय आहे?","tumche naav kay aahe"],"nice-to-meet-you":["तुम्हाला भेटून आनंद झाला","tumhala bhetun anand jhala"]},"mon":["जानेवारी","फेब्रुवारी","मार्च","एप्रिल","मे","जून","जुलै","ऑगस्ट","सप्टेंबर","ऑक्टोबर","नोव्हेंबर","डिसेंबर"],"monR":["janevari","februvari","march","april","me","june","julai","august","september","october","novhember","december"],"num":{"u99":["शून्य","एक","दोन","तीन","चार","पाच","सहा","सात","आठ","नऊ","दहा","अकरा","बारा","तेरा","चौदा","पंधरा","सोळा","सतरा","अठरा","एकोणीस","वीस","एकवीस","बावीस","तेवीस","चोवीस","पंचवीस","सव्वीस","सत्तावीस","अठ्ठावीस","एकोणतीस","तीस","एकतीस","बत्तीस","तेहतीस","चौतीस","पस्तीस","छत्तीस","सदतीस","अडतीस","एकोणचाळीस","चाळीस","एक्केचाळीस","बेचाळीस","त्रेचाळीस","चव्वेचाळीस","पंचेचाळीस","शेहेचाळीस","सत्तेचाळीस","अठ्ठेचाळीस","एकोणपन्नास","पन्नास","एक्कावन्न","बावन्न","त्रेपन्न","चोपन्न","पंचावन्न","छप्पन्न","सत्तावन्न","अठ्ठावन्न","एकोणसाठ","साठ","एकसष्ट","बासष्ट","त्रेसष्ट","चौसष्ट","पासष्ट","सहासष्ट","सदुसष्ट","अडुसष्ट","एकोणसत्तर","सत्तर","एक्काहत्तर","बाहत्तर","त्र्याहत्तर","चौऱ्याहत्तर","पंच्याहत्तर","शहात्तर","सत्याहत्तर","अठ्ठ्याहत्तर","एकोणऐंशी","ऐंशी","एक्याऐंशी","ब्याऐंशी","त्र्याऐंशी","चौऱ्याऐंशी","पंच्याऐंशी","शहाऐंशी","सत्त्याऐंशी","अठ्ठ्याऐंशी","एकोणनव्वद","नव्वद","एक्याण्णव","ब्याण्णव","त्र्याण्णव","चौऱ्याण्णव","पंच्याण्णव","शहाण्णव","सत्त्याण्णव","अठ्ठ्याण्णव","नव्व्याण्णव"],"u99r":["shunya","ek","don","teen","chaar","paach","sahaa","saat","aath","nau","dahaa","akraa","baaraa","teraa","chaudaa","pandhraa","solaa","satraa","athraa","ekonees","vees","ekvees","baavees","tevees","chovees","panchvees","savvees","sattaavees","atthaavees","ekontees","tees","ektees","battees","tehtees","chautees","pastees","chhattees","sadtees","adtees","ekonchaalees","chaalees","ekkechaalees","bechaalees","trechaalees","chavvechaalees","panchechaalees","shehechaalees","sattechaalees","atthechaalees","ekonpannaas","pannaas","ekkaavann","baavann","trepann","chopann","panchaavann","chhappann","sattaavann","atthaavann","ekonsaath","saath","eksashta","baasashta","tresashta","chausashta","paasashta","sahaasashta","sadusashta","adusashta","ekonsattar","sattar","ekkaahattar","baahattar","tryaahattar","chauryaahattar","panchyaahattar","shahaattar","satyaahattar","atthyaahattar","ekonainshi","ainshi","ekyaainshi","byaainshi","tryaainshi","chauryaainshi","panchyaainshi","shahaainshi","sattyaainshi","atthyaainshi","ekonnavvad","navvad","ekyaannav","byaannav","tryaannav","chauryaannav","panchyaannav","shahaannav","sattyaannav","atthyaannav","navvyaannav"],"hFused":["एकशे","दोनशे","तीनशे","चारशे","पाचशे","सहाशे","सातशे","आठशे","नऊशे"],"hFusedR":["ekshe","donshe","teenshe","chaarshe","paachshe","sahaashe","saatshe","aathshe","naushe"],"h100":["शंभर","shambhar"],"sc":{"thousand":["हजार","hajaar"],"lakh":["लाख","laakh"],"crore":["कोटी","koti"]}}},"ta":{"ph":{"help":["உதவி!","udhavi"],"call-police":["போலீஸைக் கூப்பிடுங்கள்","polisai kooppidungal"],"need-doctor":["எனக்கு டாக்டர் வேண்டும்","enakku daaktar vendum"],"where-hospital":["மருத்துவமனை எங்கே?","maruththuvamanai enge"],"im-allergic":["எனக்கு அலர்ஜி இருக்கிறது","enakku alarji irukkiradhu"],"im-lost":["நான் வழி தவறிவிட்டேன்","naan vazhi thavarivitten"],"hello":["வணக்கம்","vanakkam"],"good-morning":["காலை வணக்கம்","kaalai vanakkam"],"good-evening":["மாலை வணக்கம்","maalai vanakkam"],"goodbye":["போய் வருகிறேன்","poi varugiren"],"please":["தயவு செய்து","thayavu seidhu"],"thank-you":["நன்றி","nandri"],"excuse-me":["மன்னிக்கவும்","mannikkavum"],"yes":["ஆம்","aam"],"no":["இல்லை","illai"],"dont-understand":["எனக்குப் புரியவில்லை","enakku puriyavillai"],"speak-english":["உங்களுக்கு ஆங்கிலம் தெரியுமா?","ungalukku aangilam theriyuma"],"speak-slowly":["தயவு செய்து மெதுவாகப் பேசுங்கள்","thayavu seidhu medhuvaaga pesungal"],"write-down":["அதை எழுதித் தர முடியுமா?","adhai ezhudhi thara mudiyuma"],"my-name-is":["என் பெயர்…","en peyar…"],"where-bathroom":["கழிப்பறை எங்கே?","kazhipparai enge"],"where-station":["ரயில் நிலையம் எங்கே?","rayil nilaiyam enge"],"where-airport":["விமான நிலையம் எங்கே?","vimaana nilaiyam enge"],"left":["இடது பக்கம்","idadhu pakkam"],"right":["வலது பக்கம்","valadhu pakkam"],"straight-ahead":["நேராகச் செல்லுங்கள்","neraaga sellungal"],"one-ticket":["ஒரு டிக்கெட் கொடுங்கள்","oru tikket kodungal"],"taxi-please":["ஒரு டாக்ஸி கூப்பிடுங்கள்","oru taaksi kooppidungal"],"how-much":["இது எவ்வளவு?","idhu evvalavu"],"the-bill":["பில் கொடுங்கள்","bil kodungal"],"water-please":["தண்ணீர் கொடுங்கள்","thanneer kodungal"],"menu-please":["மெனு கொடுங்கள்","menu kodungal"],"vegetarian":["நான் சைவம்","naan saivam"],"delicious":["மிகவும் சுவையாக இருக்கிறது!","migavum suvaiyaaga irukkiradhu"],"take-cards":["கார்டு செல்லுமா?","kaardu selluma"],"too-expensive":["விலை ரொம்ப அதிகம்","vilai romba adhigam"],"how-are-you":["எப்படி இருக்கிறீர்கள்?","eppadi irukkireergal"],"im-fine":["நன்றாக இருக்கிறேன், நன்றி","nandraaga irukkiren, nandri"],"whats-your-name":["உங்கள் பெயர் என்ன?","ungal peyar enna"],"nice-to-meet-you":["உங்களைச் சந்தித்ததில் மகிழ்ச்சி","ungalai sandhithadhil magizhchi"]},"mon":["ஜனவரி","பிப்ரவரி","மார்ச்","ஏப்ரல்","மே","ஜூன்","ஜூலை","ஆகஸ்ட்","செப்டம்பர்","அக்டோபர்","நவம்பர்","டிசம்பர்"],"monR":["janavari","pipravari","march","april","me","joon","joolai","aagast","septambar","aktobar","navambar","disambar"],"num":{"units":{"values":[0,1,2,3,4,5,6,7,8,9],"text":["பூஜ்ஜியம்","ஒன்று","இரண்டு","மூன்று","நான்கு","ஐந்து","ஆறு","ஏழு","எட்டு","ஒன்பது"],"romans":["poojjiyam","ondru","irandu","moondru","naangu","aindhu","aaru","ezhu","ettu","onbadhu"]},"teens":{"values":[10,11,12,13,14,15,16,17,18,19],"text":["பத்து","பதினொன்று","பன்னிரண்டு","பதின்மூன்று","பதினான்கு","பதினைந்து","பதினாறு","பதினேழு","பதினெட்டு","பத்தொன்பது"],"romans":["paththu","padhinondru","pannirandu","padhinmoondru","padhinaangu","padhinaindhu","padhinaaru","padhinezhu","padhinettu","paththonbadhu"]},"tensStandalone":{"values":[20,30,40,50,60,70,80,90],"text":["இருபது","முப்பது","நாற்பது","ஐம்பது","அறுபது","எழுபது","எண்பது","தொண்ணூறு"],"romans":["irubadhu","muppadhu","naarpadhu","aimbadhu","arubadhu","ezhubadhu","enbadhu","thonnooru"]},"tensCombining":{"values":[20,30,40,50,60,70,80,90],"text":["இருபத்து","முப்பத்து","நாற்பத்து","ஐம்பத்து","அறுபத்து","எழுபத்து","எண்பத்து","தொண்ணூற்று"],"romans":["irubaththu","muppaththu","naarpaththu","aimbaththu","arubaththu","ezhubaththu","enbaththu","thonnootru"]},"hundredsStandalone":{"values":[100,200,300,400,500,600,700,800,900],"text":["நூறு","இருநூறு","முந்நூறு","நானூறு","ஐந்நூறு","அறுநூறு","எழுநூறு","எண்ணூறு","தொள்ளாயிரம்"],"romans":["nooru","irunooru","munnooru","naanooru","ainnooru","arunooru","ezhunooru","ennooru","thollaayiram"]},"hundredsCombining":{"values":[100,200,300,400,500,600,700,800,900],"text":["நூற்று","இருநூற்று","முந்நூற்று","நானூற்று","ஐந்நூற்று","அறுநூற்று","எழுநூற்று","எண்ணூற்று","தொள்ளாயிரத்து"],"romans":["nootru","irunootru","munnootru","naanootru","ainnootru","arunootru","ezhunootru","ennootru","thollaayiraththu"]},"thousandFusedUnits":{"values":[1,2,3,4,5,6,7,8,9],"text":["ஓராயிரம்","இரண்டாயிரம்","மூன்றாயிரம்","நான்காயிரம்","ஐந்தாயிரம்","ஆறாயிரம்","ஏழாயிரம்","எட்டாயிரம்","ஒன்பதாயிரம்"],"romans":["oraayiram","irandaayiram","moondraayiram","naankaayiram","aindhaayiram","aaraayiram","ezhaayiram","ettaayiram","onbadhaayiram"],"note":"index 1 (ஓராயிரம்) is used only after a combining tens word (21000 இருபத்து ஓராயிரம்); bare 1000 is ஆயிரம்"},"thousandFusedTeens":{"values":[10,11,12,13,14,15,16,17,18,19],"text":["பத்தாயிரம்","பதினோராயிரம்","பன்னிரண்டாயிரம்","பதின்மூன்றாயிரம்","பதினான்காயிரம்","பதினைந்தாயிரம்","பதினாறாயிரம்","பதினேழாயிரம்","பதினெட்டாயிரம்","பத்தொன்பதாயிரம்"],"romans":["paththaayiram","padhinoraayiram","pannirandaayiram","padhinmoondraayiram","padhinaankaayiram","padhinaindhaayiram","padhinaaraayiram","padhinezhaayiram","padhinettaayiram","paththonbadhaayiram"]},"thousandFusedTens":{"values":[20,30,40,50,60,70,80,90],"text":["இருபதாயிரம்","முப்பதாயிரம்","நாற்பதாயிரம்","ஐம்பதாயிரம்","அறுபதாயிரம்","எழுபதாயிரம்","எண்பதாயிரம்","தொண்ணூறாயிரம்"],"romans":["irubadhaayiram","muppadhaayiram","naarpadhaayiram","aimbadhaayiram","arubadhaayiram","ezhubadhaayiram","enbadhaayiram","thonnooraayiram"]},"scales":{"names":["thousand","lakh","crore"],"standalone":["ஆயிரம்","லட்சம்","கோடி"],"standaloneRomans":["aayiram","latcham","kodi"],"combining":["ஆயிரத்து","லட்சத்து","கோடியே"],"combiningRomans":["aayiraththu","latchaththu","kodiye"],"note":"combining form is used whenever any lower non-zero group follows; the thousands combining swap applies to the LAST word of the thousands group whatever its fused shape (…ஆயிரம் -> …ஆயிரத்து, roman -aayiram -> -aayiraththu)"},"attributiveOne":{"text":"ஒரு","roman":"oru","note":"replaces a final ஒன்று before the scale nouns லட்சம்/கோடி and before மணி (clock hours); before ஆயிரம் the unit 1 instead fuses as ஓராயிரம்"}}},"te":{"ph":{"help":["సహాయం చేయండి!","sahaayam cheyandi"],"call-police":["పోలీసులను పిలవండి","poleesulanu pilavandi"],"need-doctor":["నాకు డాక్టర్ కావాలి","naaku doctor kaavaali"],"where-hospital":["ఆసుపత్రి ఎక్కడ ఉంది?","aasupatri ekkada undi"],"im-allergic":["నాకు అలర్జీ ఉంది","naaku allergy undi"],"im-lost":["నేను దారి తప్పాను","nenu daari tappaanu"],"hello":["నమస్కారం","namaskaaram"],"good-morning":["శుభోదయం","shubhodayam"],"good-evening":["శుభ సాయంత్రం","shubha saayantram"],"goodbye":["సెలవు","selavu"],"please":["దయచేసి","dayachesi"],"thank-you":["ధన్యవాదాలు","dhanyavaadaalu"],"excuse-me":["క్షమించండి","kshaminchandi"],"yes":["అవును","avunu"],"no":["కాదు","kaadu"],"dont-understand":["నాకు అర్థం కాలేదు","naaku artham kaaledu"],"speak-english":["మీరు ఇంగ్లీషు మాట్లాడతారా?","meeru english maatlaadataaraa"],"speak-slowly":["దయచేసి నెమ్మదిగా మాట్లాడండి","dayachesi nemmadigaa maatlaadandi"],"write-down":["దాన్ని రాసి ఇవ్వగలరా?","daanni raasi ivvagalaraa"],"my-name-is":["నా పేరు…","naa peru…"],"where-bathroom":["టాయిలెట్ ఎక్కడ ఉంది?","toilet ekkada undi"],"where-station":["రైల్వే స్టేషన్ ఎక్కడ ఉంది?","railway station ekkada undi"],"where-airport":["విమానాశ్రయం ఎక్కడ ఉంది?","vimaanaashrayam ekkada undi"],"left":["ఎడమ వైపు","edama vaipu"],"right":["కుడి వైపు","kudi vaipu"],"straight-ahead":["నేరుగా వెళ్ళండి","nerugaa vellandi"],"one-ticket":["ఒక టికెట్ ఇవ్వండి","oka ticket ivvandi"],"taxi-please":["ఒక టాక్సీ పిలవండి","oka taxi pilavandi"],"how-much":["ఇది ఎంత?","idi enta"],"the-bill":["బిల్లు ఇవ్వండి","bill ivvandi"],"water-please":["మంచినీళ్ళు ఇవ్వండి","manchineellu ivvandi"],"menu-please":["మెనూ ఇవ్వండి","menu ivvandi"],"vegetarian":["నేను శాకాహారిని","nenu shaakaahaarini"],"delicious":["చాలా రుచిగా ఉంది!","chaalaa ruchigaa undi"],"take-cards":["కార్డు తీసుకుంటారా?","card teesukuntaaraa"],"too-expensive":["ఇది చాలా ఖరీదుగా ఉంది","idi chaalaa khareedugaa undi"],"how-are-you":["మీరు ఎలా ఉన్నారు?","meeru elaa unnaaru"],"im-fine":["బాగున్నాను, ధన్యవాదాలు","baagunnaanu, dhanyavaadaalu"],"whats-your-name":["మీ పేరు ఏమిటి?","mee peeru eemiti"],"nice-to-meet-you":["మిమ్మల్ని కలిసినందుకు సంతోషం","mimmalni kalisinanduku santosham"]},"mon":["జనవరి","ఫిబ్రవరి","మార్చి","ఏప్రిల్","మే","జూన్","జూలై","ఆగస్టు","సెప్టెంబరు","అక్టోబరు","నవంబరు","డిసెంబరు"],"monR":["janavari","fibravari","march","april","may","june","julai","aagastu","septembaru","aktobaru","navambaru","disembaru"],"num":{"u":["సున్నా","ఒకటి","రెండు","మూడు","నాలుగు","ఐదు","ఆరు","ఏడు","ఎనిమిది","తొమ్మిది","పది","పదకొండు","పన్నెండు","పదమూడు","పద్నాలుగు","పదిహేను","పదహారు","పదిహేడు","పద్దెనిమిది","పంతొమ్మిది"],"ur":["sunnaa","okati","rendu","moodu","naalugu","aidu","aaru","edu","enimidi","tommidi","padi","padakondu","pannendu","padamoodu","padnaalugu","padihenu","padahaaru","padihedu","paddenimidi","pantommidi"],"t":["","","ఇరవై","ముప్పై","నలభై","యాభై","అరవై","డెబ్బై","ఎనభై","తొంభై"],"tr":["","","iravai","muppai","nalabhai","yaabhai","aravai","debbai","enabhai","tombhai"],"one":{"final":"ఒకటి","attr":"ఒక్క","finalR":"okati","attrR":"okka"},"hundred":{"alone":"వంద","combining":"నూట","plural":"వందలు","oblique":"వందల"},"hundredR":{"alone":"vanda","combining":"noota","plural":"vandalu","oblique":"vandala"},"thousand":{"alone":"వెయ్యి","plural":"వేలు","oblique":"వేల"},"thousandR":{"alone":"veyyi","plural":"velu","oblique":"vela"},"lakh":{"alone":"లక్ష","combining":"లక్షా","plural":"లక్షలు","oblique":"లక్షల"},"lakhR":{"alone":"laksha","combining":"lakshaa","plural":"lakshalu","oblique":"lakshala"},"crore":{"alone":"కోటి","combining":"కోటీ","plural":"కోట్లు","oblique":"కోట్ల"},"croreR":{"alone":"koti","combining":"kotee","plural":"kotlu","oblique":"kotla"}}},"sw":{"ph":{"help":["Saidia!",0],"call-police":["Waite polisi",0],"need-doctor":["Nahitaji daktari",0],"where-hospital":["Hospitali iko wapi?",0],"im-allergic":["Nina mzio",0],"im-lost":["Nimepotea",0],"hello":["Hujambo",0],"good-morning":["Habari za asubuhi",0],"good-evening":["Habari za jioni",0],"goodbye":["Kwaheri",0],"please":["Tafadhali",0],"thank-you":["Asante",0],"excuse-me":["Samahani",0],"yes":["Ndiyo",0],"no":["Hapana",0],"dont-understand":["Sielewi",0],"speak-english":["Unasema Kiingereza?",0],"speak-slowly":["Tafadhali sema polepole",0],"write-down":["Unaweza kuiandika?",0],"my-name-is":["Jina langu ni…",0],"where-bathroom":["Choo kiko wapi?",0],"where-station":["Stesheni ya treni iko wapi?",0],"where-airport":["Uwanja wa ndege uko wapi?",0],"left":["Kushoto",0],"right":["Kulia",0],"straight-ahead":["Moja kwa moja",0],"one-ticket":["Tikiti moja, tafadhali",0],"taxi-please":["Teksi, tafadhali",0],"how-much":["Ni bei gani?",0],"the-bill":["Bili, tafadhali",0],"water-please":["Maji, tafadhali",0],"menu-please":["Menyu, tafadhali",0],"vegetarian":["Mimi ni mla mboga",0],"delicious":["Ni kitamu sana!",0],"take-cards":["Mnakubali kadi?",0],"too-expensive":["Ni ghali sana",0],"how-are-you":["Habari yako?",0],"im-fine":["Nzuri, asante",0],"whats-your-name":["Jina lako ni nani?",0],"nice-to-meet-you":["Nimefurahi kukutana nawe",0]},"mon":["Januari","Februari","Machi","Aprili","Mei","Juni","Julai","Agosti","Septemba","Oktoba","Novemba","Desemba"],"monR":null,"num":{"u":["sifuri","moja","mbili","tatu","nne","tano","sita","saba","nane","tisa"],"t":["","kumi","ishirini","thelathini","arobaini","hamsini","sitini","sabini","themanini","tisini"]},"det":[["wapi","iko","kiko","uko","tafadhali","asante","sana","ndiyo","hapana","habari","kwa","moja"],""]},"am":{"ph":{"help":["እርዱኝ!","erdugn"],"call-police":["ፖሊስ ይጥሩ!","polis yitru"],"need-doctor":["ሐኪም እፈልጋለሁ","hakim efelgalehu"],"where-hospital":["ሆስፒታል የት ነው?","hospital yet new"],"im-allergic":["አለርጂ አለብኝ","alerji alebign"],"im-lost":["ጠፍቻለሁ","tefchalehu"],"hello":["ሰላም","selam"],"good-morning":["እንደምን አደሩ","endemin aderu"],"good-evening":["እንደምን አመሹ","endemin ameshu"],"goodbye":["ደህና ሁኑ","dehna hunu"],"please":["እባክዎ","ebakwo"],"thank-you":["አመሰግናለሁ","amesegnalehu"],"excuse-me":["ይቅርታ","yikirta"],"yes":["አዎ","awo"],"no":["አይ","ay"],"dont-understand":["አልገባኝም","algebagnim"],"speak-english":["እንግሊዝኛ ይናገራሉ?","inglizegna yinageralu"],"speak-slowly":["እባክዎ ቀስ ብለው ይናገሩ","ebakwo kes bilew yinageru"],"write-down":["ሊጽፉት ይችላሉ?","litsifut yichilalu"],"my-name-is":["ስሜ … ነው","sime … new"],"where-bathroom":["ሽንት ቤት የት ነው?","shint bet yet new"],"where-station":["የባቡር ጣቢያ የት ነው?","yebabur tabiya yet new"],"where-airport":["አየር ማረፊያ የት ነው?","ayer marefiya yet new"],"left":["በግራ በኩል","begra bekul"],"right":["በቀኝ በኩል","bekegn bekul"],"straight-ahead":["ቀጥታ","ketita"],"one-ticket":["አንድ ትኬት እባክዎ","and tiket ebakwo"],"taxi-please":["ታክሲ እባክዎ","taksi ebakwo"],"how-much":["ስንት ነው?","sint new"],"the-bill":["ሂሳብ እባክዎ","hisab ebakwo"],"water-please":["ውሃ እባክዎ","wiha ebakwo"],"menu-please":["ሜኑ እባክዎ","menu ebakwo"],"vegetarian":["ስጋ አልበላም","siga albelam"],"delicious":["በጣም ጣፋጭ ነው!","betam tafach new"],"take-cards":["ካርድ ይቀበላሉ?","kard yikebelalu"],"too-expensive":["በጣም ውድ ነው","betam wid new"],"how-are-you":["እንደምን ነዎት?","endemin newot"],"im-fine":["ደህና ነኝ፣ አመሰግናለሁ","dehna negn amesegnalehu"],"whats-your-name":["ስምዎ ማን ነው?","simwo man new"],"nice-to-meet-you":["ስለተዋወቅን ደስ ብሎኛል","siletewawekin des bilognal"]},"mon":["ጃንዋሪ","ፌብሩዋሪ","ማርች","ኤፕሪል","ሜይ","ጁን","ጁላይ","ኦገስት","ሴፕቴምበር","ኦክቶበር","ኖቬምበር","ዲሴምበር"],"monR":["janwari","februwari","march","april","mey","jun","julay","ogest","september","oktober","november","disember"],"num":{"u":["ዜሮ","አንድ","ሁለት","ሶስት","አራት","አምስት","ስድስት","ሰባት","ስምንት","ዘጠኝ","አስር","አስራ አንድ","አስራ ሁለት","አስራ ሶስት","አስራ አራት","አስራ አምስት","አስራ ስድስት","አስራ ሰባት","አስራ ስምንት","አስራ ዘጠኝ"],"ur":["zero","and","hulet","sost","arat","amist","sidist","sebat","simint","zetegn","asir","asra and","asra hulet","asra sost","asra arat","asra amist","asra sidist","asra sebat","asra simint","asra zetegn"],"t":["","","ሃያ","ሰላሳ","አርባ","ሃምሳ","ስልሳ","ሰባ","ሰማንያ","ዘጠና"],"tr":["","","haya","selasa","arba","hamsa","silsa","seba","semanya","zetena"],"h":["መቶ","ሁለት መቶ","ሶስት መቶ","አራት መቶ","አምስት መቶ","ስድስት መቶ","ሰባት መቶ","ስምንት መቶ","ዘጠኝ መቶ"],"hr":["meto","hulet meto","sost meto","arat meto","amist meto","sidist meto","sebat meto","simint meto","zetegn meto"]}},"ka":{"ph":{"help":["მიშველეთ!",0],"call-police":["გამოიძახეთ პოლიცია",0],"need-doctor":["ექიმი მჭირდება",0],"where-hospital":["სად არის საავადმყოფო?",0],"im-allergic":["ალერგია მაქვს",0],"im-lost":["დავიკარგე",0],"hello":["გამარჯობა",0],"good-morning":["დილა მშვიდობისა",0],"good-evening":["საღამო მშვიდობისა",0],"goodbye":["ნახვამდის",0],"please":["გთხოვთ",0],"thank-you":["მადლობა",0],"excuse-me":["უკაცრავად",0],"yes":["დიახ",0],"no":["არა",0],"dont-understand":["არ მესმის",0],"speak-english":["ინგლისურად ლაპარაკობთ?",0],"speak-slowly":["გთხოვთ, ნელა ილაპარაკეთ",0],"write-down":["შეგიძლიათ დამიწეროთ?",0],"my-name-is":["მე მქვია…",0],"where-bathroom":["სად არის ტუალეტი?",0],"where-station":["სად არის რკინიგზის სადგური?",0],"where-airport":["სად არის აეროპორტი?",0],"left":["მარცხნივ",0],"right":["მარჯვნივ",0],"straight-ahead":["პირდაპირ",0],"one-ticket":["ერთი ბილეთი, თუ შეიძლება",0],"taxi-please":["ტაქსი, თუ შეიძლება",0],"how-much":["რა ღირს?",0],"the-bill":["ანგარიში, თუ შეიძლება",0],"water-please":["წყალი, თუ შეიძლება",0],"menu-please":["მენიუ, თუ შეიძლება",0],"vegetarian":["ვეგეტარიანელი ვარ",0],"delicious":["ძალიან გემრიელია!",0],"take-cards":["ბარათით გადახდა შეიძლება?",0],"too-expensive":["ძალიან ძვირია",0],"how-are-you":["როგორ ხართ?",0],"im-fine":["კარგად ვარ, მადლობა",0],"whats-your-name":["რა გქვიათ?",0],"nice-to-meet-you":["სასიამოვნოა თქვენი გაცნობა",0]},"mon":["იანვარი","თებერვალი","მარტი","აპრილი","მაისი","ივნისი","ივლისი","აგვისტო","სექტემბერი","ოქტომბერი","ნოემბერი","დეკემბერი"],"monR":null,"num":{"u":["ნული","ერთი","ორი","სამი","ოთხი","ხუთი","ექვსი","შვიდი","რვა","ცხრა","ათი"],"ur":["nuli","erti","ori","sami","otkhi","khuti","ekvsi","shvidi","rva","tskhra","ati"],"teens":["თერთმეტი","თორმეტი","ცამეტი","თოთხმეტი","თხუთმეტი","თექვსმეტი","ჩვიდმეტი","თვრამეტი","ცხრამეტი"],"teensr":["tertmeti","tormeti","tsameti","totkhmeti","tkhutmeti","tekvsmeti","chvidmeti","tvrameti","tskhrameti"],"sc20":["ოცი","ორმოცი","სამოცი","ოთხმოცი"],"sc20r":["otsi","ormotsi","samotsi","otkhmotsi"],"sc20c":["ოცდა","ორმოცდა","სამოცდა","ოთხმოცდა"],"sc20cr":["otsda","ormotsda","samotsda","otkhmotsda"],"h":["ასი","ორასი","სამასი","ოთხასი","ხუთასი","ექვსასი","შვიდასი","რვაასი","ცხრაასი"],"hr":["asi","orasi","samasi","otkhasi","khutasi","ekvsasi","shvidasi","rvaasi","tskhraasi"],"hc":["ას","ორას","სამას","ოთხას","ხუთას","ექვსას","შვიდას","რვაას","ცხრაას"],"hcr":["as","oras","samas","otkhas","khutas","ekvsas","shvidas","rvaas","tskhraas"]}}};

  var CURATED_R = ['ar', 'hi', 'zh', 'fa', 'ur', 'he', 'th', 'bn', 'ta', 'te', 'mr', 'pa', 'am'];

  function xJoin(toks, sep) { return toks.join(sep === undefined ? ' ' : sep); }

  /* ---- western-family helpers ---- */

  function ptSub100(x) { var d = PX.pt.num; return x < 20 ? d.u[x] : d.t[Math.floor(x / 10)] + (x % 10 ? ' e ' + d.u[x % 10] : ''); }
  function ptSub1000(x) {
    var d = PX.pt.num;
    if (x === 100) return d.hx;
    var h = Math.floor(x / 100), r = x % 100;
    if (!h) return ptSub100(x);
    return d.h[h] + (r ? ' e ' + ptSub100(r) : '');
  }
  function ptNum(n) {
    if (!n) return 'zero';
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, parts = [];
    if (m) parts.push(m === 1 ? 'um milhão' : ptSub1000(m) + ' milhões');
    if (t) parts.push((m && !r && (t < 100 || t % 100 === 0) ? 'e ' : '') + (t === 1 ? 'mil' : ptSub1000(t) + ' mil'));
    if (r) parts.push((parts.length && (r < 100 || r % 100 === 0) ? 'e ' : '') + ptSub1000(r));
    return parts.join(' ');
  }

  function itSub100(x) {
    var d = PX.it.num;
    if (x < 20) return d.u[x];
    var t = d.t[Math.floor(x / 10)], u = x % 10;
    if (!u) return t;
    if (u === 1 || u === 8) t = t.slice(0, -1);
    return t + (u === 3 ? 'tré' : d.u[u]);
  }
  function itSub1000(x) {
    var d = PX.it.num, h = Math.floor(x / 100), r = x % 100;
    if (!h) return itSub100(x);
    var head = h === 1 ? 'cento' : d.u[h] + 'cento';
    if (!r) return head;
    var tail = r === 3 ? 'tré' : itSub100(r);
    if (tail.charAt(0) === 'o') head = head.slice(0, -1);
    return head + tail;
  }
  function itNum(n) {
    if (!n) return 'zero';
    var m = Math.floor(n / 1e6), rest = n % 1e6, parts = [];
    if (m) parts.push(m === 1 ? 'un milione' : itSub1000(m) + ' milioni');
    if (rest) {
      var t = Math.floor(rest / 1000), r = rest % 1000, word;
      if (t) {
        var mult = t === 1 ? '' : itSub1000(t).replace(/uno$/, 'un').replace(/tré$/, 'tre');
        word = (t === 1 ? 'mille' : mult + 'mila') + (r ? (r === 3 ? 'tré' : itSub1000(r)) : '');
      } else word = itSub1000(r);
      parts.push(word);
    }
    return parts.join(' ');
  }

  function nlSub100(x, standalone) {
    var d = PX.nl.num;
    if (x === 1 && standalone) return 'één';
    if (x < 20) return d.u[x];
    var t = d.t[Math.floor(x / 10)], u = x % 10;
    if (!u) return t;
    var uw = d.u[u];
    return (uw === 'twee' || uw === 'drie' ? uw + 'ën' : uw + 'en') + t;
  }
  function nlSub1000(x, standalone) {
    var d = PX.nl.num, h = Math.floor(x / 100), r = x % 100;
    if (!h) return nlSub100(x, standalone);
    return (h === 1 ? 'honderd' : d.u[h] + 'honderd') + (r ? nlSub100(r, false) : '');
  }
  function nlNum(n) {
    if (!n) return 'nul';
    if (n === 1) return 'één';
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, parts = [];
    if (m) parts.push((m === 1 ? 'een' : nlSub1000(m, false)) + ' miljoen');
    if (t) parts.push(t === 1 ? 'duizend' : nlSub1000(t, false) + 'duizend');
    if (r) parts.push(nlSub1000(r, false));
    return parts.join(' ');
  }

  function svSub100(x) {
    var d = PX.sv.num;
    if (x < 20) return d.u[x];
    return d.t[Math.floor(x / 10)] + (x % 10 ? d.u[x % 10] : '');
  }
  function svSub1000(x) {
    var d = PX.sv.num, h = Math.floor(x / 100), r = x % 100;
    if (!h) return svSub100(x);
    return (h === 1 ? 'hundra' : d.u[h] + 'hundra') + (r ? svSub100(r) : '');
  }
  function svNum(n) {
    if (!n) return 'noll';
    var m = Math.floor(n / 1e6), rest = n % 1e6, parts = [];
    if (m) parts.push(m === 1 ? 'en miljon' : svSub1000(m).replace(/ett$/, 'en') + ' miljoner');
    if (rest) {
      var t = Math.floor(rest / 1000), r = rest % 1000, word = '';
      if (t === 1) word = 'tusen';
      else if (t) {
        var mult = svSub1000(t);
        word = /ett$/.test(mult) ? mult + 'usen' : mult + 'tusen';
      }
      parts.push(word + (r ? svSub1000(r) : ''));
    }
    return parts.join(' ');
  }

  function huSub100(x) {
    var d = PX.hu.num;
    if (x < 10) return d.u[x];
    if (x === 10) return d.t[1];
    if (x < 20) return 'tizen' + d.u[x % 10];
    if (x === 20) return d.t[2];
    if (x < 30) return 'huszon' + d.u[x % 10];
    return d.t[Math.floor(x / 10)] + (x % 10 ? d.u[x % 10] : '');
  }
  function huAttr(s) { return s.replace(/kettő$/, 'két'); }
  function huSub1000(x) {
    var d = PX.hu.num, h = Math.floor(x / 100), r = x % 100;
    if (!h) return huSub100(x);
    return (h === 1 ? '' : huAttr(huSub100(h))) + 'száz' + (r ? huSub100(r) : '');
  }
  function huNum(n) {
    if (!n) return 'nulla';
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, parts = [];
    if (m) parts.push((m === 1 ? 'egy' : huAttr(huSub1000(m))) + 'millió');
    if (t) parts.push((t === 1 ? '' : huAttr(huSub1000(t))) + 'ezer');
    if (r) parts.push(huSub1000(r));
    return n <= 2000 ? parts.join('') : parts.join('-');
  }

  function idSub100(x) {
    var d = PX.id.num;
    if (x < 20) return d.u[x];
    return d.t[Math.floor(x / 10)] + (x % 10 ? ' ' + d.u[x % 10] : '');
  }
  function idSub1000(x) {
    var d = PX.id.num, h = Math.floor(x / 100), r = x % 100;
    if (!h) return idSub100(x);
    return d.h[h] + (r ? ' ' + idSub100(r) : '');
  }
  function idNum(n) {
    if (!n) return 'nol';
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, parts = [];
    if (m) parts.push(idSub1000(m) + ' juta');
    if (t) parts.push(t === 1 ? 'seribu' : idSub1000(t) + ' ribu');
    if (r) parts.push(idSub1000(r));
    return parts.join(' ');
  }

  function viSub100(x) {
    var d = PX.vi.num;
    if (x < 10) return d.u[x];
    if (x < 20) return 'mười' + (x % 10 ? ' ' + (x % 10 === 5 ? 'lăm' : d.u[x % 10]) : '');
    var u = x % 10;
    return d.u[Math.floor(x / 10)] + ' mươi' + (u ? ' ' + (u === 1 ? 'mốt' : u === 5 ? 'lăm' : d.u[u]) : '');
  }
  function viSub1000(x) {
    var d = PX.vi.num, h = Math.floor(x / 100), r = x % 100;
    if (!h) return viSub100(x);
    return d.u[h] + ' trăm' + (r ? (r < 10 ? ' linh ' + d.u[r] : ' ' + viSub100(r)) : '');
  }
  function viNum(n) {
    var d = PX.vi.num;
    if (!n) return d.u[0];
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, parts = [];
    if (m) parts.push(viSub1000(m) + ' triệu');
    if (t) parts.push(viSub1000(t) + ' nghìn');
    if (r) {
      if (parts.length && r < 100) parts.push('không trăm' + (r < 10 ? ' linh ' + d.u[r] : ' ' + viSub100(r)));
      else parts.push(viSub1000(r));
    }
    return parts.join(' ');
  }

  function swSub999(x) {
    var d = PX.sw.num, comps = [];
    var h = Math.floor(x / 100), t = Math.floor(x % 100 / 10), u = x % 10;
    if (h) comps.push('mia ' + d.u[h]);
    if (t) comps.push(d.t[t]);
    if (u) comps.push(d.u[u]);
    if (comps.length >= 2) {
      var last = comps.pop();
      return comps.join(' ') + ' na ' + last;
    }
    return comps[0] || '';
  }
  function swComps(x) {
    return (Math.floor(x / 100) ? 1 : 0) + (Math.floor(x % 100 / 10) ? 1 : 0) + (x % 10 ? 1 : 0);
  }
  function swNum(n) {
    var d = PX.sw.num;
    if (!n) return d.u[0];
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, parts = [];
    if (m) parts.push('milioni ' + swSub999(m));
    if (t) parts.push('elfu ' + swSub999(t));
    if (r) parts.push((parts.length && swComps(r) === 1 ? 'na ' : '') + swSub999(r));
    return parts.join(' ');
  }

  /* ---- slavic family ---- */

  function slavicSelect(x) {
    var d2 = x % 100, d1 = x % 10;
    if (d2 >= 11 && d2 <= 14) return 2;
    if (d1 === 1) return 0;
    if (d1 >= 2 && d1 <= 4) return 1;
    return 2;
  }
  function plSub1000(x) {
    var d = PX.pl.num, parts = [];
    var h = Math.floor(x / 100), r = x % 100;
    if (h) parts.push(d.h[h - 1]);
    if (r) {
      if (r < 20) parts.push(d.u[r]);
      else parts.push(d.t[Math.floor(r / 10) - 2] + (r % 10 ? ' ' + d.u[r % 10] : ''));
    }
    return parts.join(' ');
  }
  function plSelect(x) {
    // Polish: only a bare 1 is singular; compounds ending in 1 go genitive-plural
    if (x === 1) return 0;
    var d1 = x % 10, d2 = x % 100;
    if (d1 >= 2 && d1 <= 4 && !(d2 >= 12 && d2 <= 14)) return 1;
    return 2;
  }
  function plNum(n) {
    var d = PX.pl.num;
    if (!n) return d.u[0];
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, parts = [];
    if (m) parts.push((m === 1 ? '' : plSub1000(m) + ' ') + d.mi[plSelect(m)]);
    if (t) parts.push((t === 1 ? '' : plSub1000(t) + ' ') + d.th[plSelect(t)]);
    if (r) parts.push(plSub1000(r));
    return parts.join(' ');
  }
  function ukSub1000(x, fem) {
    var d = PX.uk.num, parts = [];
    var h = Math.floor(x / 100), r = x % 100;
    if (h) parts.push(d.h[h - 1]);
    if (r) {
      if (r < 20) parts.push(fem && d.fem[r] ? d.fem[r] : d.u[r]);
      else parts.push(d.t[Math.floor(r / 10) - 2] + (r % 10 ? ' ' + (fem && d.fem[r % 10] ? d.fem[r % 10] : d.u[r % 10]) : ''));
    }
    return parts.join(' ');
  }
  function ukNum(n) {
    var d = PX.uk.num;
    if (!n) return d.u[0];
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, parts = [];
    if (m) parts.push(ukSub1000(m, false) + ' ' + d.mi[slavicSelect(m)]);
    if (t) parts.push((t === 1 ? '' : ukSub1000(t, true) + ' ') + d.th[slavicSelect(t)]);
    if (r) parts.push(ukSub1000(r, false));
    return parts.join(' ');
  }
  function csSub1000(x) {
    var d = PX.cs.num, parts = [];
    var h = Math.floor(x / 100), r = x % 100;
    if (h) parts.push(d.h[h - 1]);
    if (r) {
      if (r < 20) parts.push(d.u[r]);
      else parts.push(d.t[Math.floor(r / 10) - 2] + (r % 10 ? ' ' + d.u[r % 10] : ''));
    }
    return parts.join(' ');
  }
  function csScale(v, forms) {
    // Czech: only a WHOLE multiplier of 2-4 takes the paucal form
    return v >= 2 && v <= 4 ? forms[1] : forms[2];
  }
  function csNum(n) {
    var d = PX.cs.num;
    if (!n) return d.u[0];
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, parts = [];
    if (m) parts.push((m === 1 ? '' : csSub1000(m) + ' ') + (m === 1 ? d.mi[0] : csScale(m, d.mi)));
    if (t) parts.push((t === 1 ? '' : csSub1000(t) + ' ') + (t === 1 ? d.th[0] : csScale(t, d.th)));
    if (r) parts.push(csSub1000(r));
    return parts.join(' ');
  }

  /* ---- Romanian ---- */

  function roSub100(x) {
    var d = PX.ro.num;
    if (x < 20) return d.u[x];
    return d.t[Math.floor(x / 10)] + (x % 10 ? ' și ' + d.u[x % 10] : '');
  }
  function roSub1000(x) {
    var h = Math.floor(x / 100), r = x % 100;
    if (!h) return roSub100(x);
    var head = h === 1 ? 'o sută' : (h === 2 ? 'două' : PX.ro.num.u[h]) + ' sute';
    return head + (r ? ' ' + roSub100(r) : '');
  }
  function roFem(s, x) {
    if (x === 12) return PX.ro.num.fem[12];
    var u = x % 10, d2 = x % 100;
    if (d2 >= 11 && d2 <= 19) return s;
    if (u === 1) return s.replace(/unu$/, PX.ro.num.fem[1]);
    if (u === 2) return s.replace(/doi$/, PX.ro.num.fem[2]);
    return s;
  }
  function roDe(v) { var d2 = v % 100; return d2 === 0 || d2 >= 20; }
  function roNum(n) {
    if (!n) return 'zero';
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, parts = [];
    if (m) {
      if (m === 1) parts.push('un milion');
      else parts.push(roSub1000(m).replace(/doi$/, 'două') + (roDe(m) ? ' de milioane' : ' milioane'));
    }
    if (t) {
      if (t === 1) parts.push('o mie');
      else parts.push(roFem(roSub1000(t), t) + (roDe(t) ? ' de mii' : ' mii'));
    }
    if (r) parts.push(roSub1000(r));
    return parts.join(' ');
  }

  /* ---- pair-based composers (text + reading assembled together) ---- */

  function faGroup(x) {
    var d = PX.fa.num, T = [], R = [];
    var h = Math.floor(x / 100), r = x % 100;
    if (h) { T.push(d.h[h]); R.push(d.hr[h]); }
    if (r) {
      if (r < 20) { T.push(d.u[r]); R.push(d.ur[r]); }
      else {
        T.push(d.t[Math.floor(r / 10)]); R.push(d.tr[Math.floor(r / 10)]);
        if (r % 10) { T.push(d.u[r % 10]); R.push(d.ur[r % 10]); }
      }
    }
    return [T.join(' و '), R.join(' o ')];
  }
  function faNum(n) {
    var d = PX.fa.num;
    if (!n) return { text: d.u[0], roman: d.ur[0] };
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, T = [], R = [];
    if (m) { var g = faGroup(m); T.push(g[0] + ' میلیون'); R.push(g[1] + ' milyun'); }
    if (t) {
      if (t === 1) { T.push('هزار'); R.push('hezar'); }
      else { var g2 = faGroup(t); T.push(g2[0] + ' هزار'); R.push(g2[1] + ' hezar'); }
    }
    if (r) { var g3 = faGroup(r); T.push(g3[0]); R.push(g3[1]); }
    return { text: T.join(' و '), roman: R.join(' o ') };
  }

  function heComps(x, masc) {
    // component list [ [text, roman], ... ]; the ו prefixes the last one
    var d = PX.he.num, out = [];
    var h = Math.floor(x / 100), r = x % 100;
    if (h) out.push([d.h[h - 1], d.hr[h - 1]]);
    if (r) {
      if (r < 20) {
        if (masc && r >= 1 && r <= 10) out.push([d.um[r - 1], d.umr[r - 1]]);
        else if (masc && r === 12) out.push(['שנים עשר', 'shneim asar']);
        else if (masc && r > 10) out.push([d.um[r % 10 - 1] + ' עשר', d.umr[r % 10 - 1] + ' asar']);
        else out.push([d.u[r], d.ur[r]]);
      } else {
        out.push([d.t[Math.floor(r / 10) - 2], d.tr[Math.floor(r / 10) - 2]]);
        var u = r % 10;
        if (u) {
          if (masc) out.push([d.um[u - 1], d.umr[u - 1]]);
          else out.push([d.u[u], d.ur[u]]);
        }
      }
    }
    return out;
  }
  function heJoin(comps) {
    var T = [], R = [], i;
    for (i = 0; i < comps.length; i++) {
      if (i === comps.length - 1 && comps.length >= 2) { T.push('ו' + comps[i][0]); R.push('ve-' + comps[i][1]); }
      else { T.push(comps[i][0]); R.push(comps[i][1]); }
    }
    return [T.join(' '), R.join(' ')];
  }
  function heNum(n) {
    var d = PX.he.num;
    if (!n) return { text: d.u[0], roman: d.ur[0] };
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, T = [], R = [];
    if (m) {
      if (m === 1) { T.push('מיליון'); R.push('milyon'); }
      else if (m === 2) { T.push('שני מיליון'); R.push('shnei milyon'); }
      else { var g = heJoin(heComps(m, true)); T.push(g[0] + ' מיליון'); R.push(g[1] + ' milyon'); }
    }
    if (t) {
      if (t === 1) { T.push('אלף'); R.push('elef'); }
      else if (t === 2) { T.push('אלפיים'); R.push('alpayim'); }
      else if (t >= 3 && t <= 10) { T.push(d.cm[t - 3] + ' אלפים'); R.push(d.cmr[t - 3] + ' alafim'); }
      else { var g2 = heJoin(heComps(t, true)); T.push(g2[0] + ' אלף'); R.push(g2[1] + ' elef'); }
    }
    if (r) { var g3 = heJoin(heComps(r, false)); T.push(g3[0]); R.push(g3[1]); }
    return { text: T.join(' '), roman: R.join(' ') };
  }

  function amNum(n) {
    var d = PX.am.num;
    if (!n) return { text: d.u[0], roman: d.ur[0] };
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, T = [], R = [];
    function sub(x) {
      var h = Math.floor(x / 100), rr = x % 100, TT = [], RR = [];
      if (h) { TT.push(d.h[h - 1]); RR.push(d.hr[h - 1]); }
      if (rr) {
        if (rr < 20) { TT.push(d.u[rr]); RR.push(d.ur[rr]); }
        else {
          TT.push(d.t[Math.floor(rr / 10)]); RR.push(d.tr[Math.floor(rr / 10)]);
          if (rr % 10) { TT.push(d.u[rr % 10]); RR.push(d.ur[rr % 10]); }
        }
      }
      return [TT.join(' '), RR.join(' ')];
    }
    if (m) { var g = sub(m); T.push((m === 1 ? d.u[1] + ' ' : g[0] + ' ') + 'ሚሊዮን'); R.push((m === 1 ? d.ur[1] + ' ' : g[1] + ' ') + 'miliyon'); }
    if (t) {
      if (t === 1) { T.push('ሺህ'); R.push('shih'); }
      else { var g2 = sub(t); T.push(g2[0] + ' ሺህ'); R.push(g2[1] + ' shih'); }
    }
    if (r) { var g3 = sub(r); T.push(g3[0]); R.push(g3[1]); }
    return { text: T.join(' '), roman: R.join(' ') };
  }

  function thNum(n) {
    var d = PX.th.num;
    if (!n) return { text: d.u[0], roman: d.ur[0] };
    var T = [], R = [];
    function subM(x, prefixed) {
      // digit walk over 1e5..1: emitted units + power words
      var powers = [100000, 10000, 1000, 100, 10, 1], names = d.p, i;
      var any = prefixed;
      for (i = 0; i < powers.length; i++) {
        var dg = Math.floor(x / powers[i]) % 10;
        if (!dg) continue;
        if (powers[i] === 10) {
          if (dg === 2) { T.push(d.yi[0]); R.push(d.yi[1]); }
          else if (dg > 2) { T.push(d.u[dg]); R.push(d.ur[dg]); }
          T.push(names[10][0]); R.push(names[10][1]);
        } else if (powers[i] === 1) {
          if (dg === 1 && any) { T.push(d.et[0]); R.push(d.et[1]); }
          else { T.push(d.u[dg]); R.push(d.ur[dg]); }
        } else {
          T.push(d.u[dg]); R.push(d.ur[dg]);
          T.push(names[powers[i]][0]); R.push(names[powers[i]][1]);
        }
        any = true;
      }
    }
    var m = Math.floor(n / 1e6), rest = n % 1e6;
    if (m) { subM(m, false); T.push(d.p[1000000][0]); R.push(d.p[1000000][1]); }
    if (rest) subM(rest, m > 0);
    return { text: T.join(''), roman: R.join(' ') };
  }

  /* ---- indic family (0-99 lookup + lakh/crore grouping) ---- */

  function indicNum(lang, n) {
    var d = PX[lang].num;
    if (!n) return { text: d.u99[0], roman: d.u99r[0] };
    var groups = [
      [Math.floor(n / 1e7), 'crore'], [Math.floor(n % 1e7 / 1e5), 'lakh'],
      [Math.floor(n % 1e5 / 1000), 'thousand'], [Math.floor(n % 1000 / 100), 'hundred'],
      [n % 100, null]
    ];
    var T = [], R = [], i;
    for (i = 0; i < groups.length; i++) {
      var v = groups[i][0], scale = groups[i][1];
      if (!v) continue;
      if (scale === 'hundred') {
        if (d.hFused) { T.push(d.hFused[v - 1]); R.push(d.hFusedR[v - 1]); }
        else { T.push(d.u99[v] + ' ' + d.sc.hundred[0]); R.push(d.u99r[v] + ' ' + d.sc.hundred[1]); }
      } else if (scale) {
        T.push(d.u99[v] + ' ' + d.sc[scale][0]); R.push(d.u99r[v] + ' ' + d.sc[scale][1]);
      } else { T.push(d.u99[v]); R.push(d.u99r[v]); }
    }
    return { text: T.join(' '), roman: R.join(' ') };
  }
  function mrNum(n) {
    if (n === 100) { return { text: PX.mr.num.h100[0], roman: PX.mr.num.h100[1] }; }
    return indicNum('mr', n);
  }

  /* ---- Tamil (sandhi combining forms) ---- */

  function taSub100(x, pair) {
    // pair-returning: [text, roman]
    var d = PX.ta.num;
    if (x < 10) return [d.units.text[x], d.units.romans[x]];
    if (x < 20) return [d.teens.text[x - 10], d.teens.romans[x - 10]];
    var ti = Math.floor(x / 10) - 2, u = x % 10;
    if (!u) return [d.tensStandalone.text[ti], d.tensStandalone.romans[ti]];
    return [d.tensCombining.text[ti] + ' ' + d.units.text[u], d.tensCombining.romans[ti] + ' ' + d.units.romans[u]];
  }
  function taSub1000(x) {
    var d = PX.ta.num, h = Math.floor(x / 100), r = x % 100;
    if (!h) return taSub100(x);
    var hi = h - 1;
    if (!r) return [d.hundredsStandalone.text[hi], d.hundredsStandalone.romans[hi]];
    var lo = taSub100(r);
    return [d.hundredsCombining.text[hi] + ' ' + lo[0], d.hundredsCombining.romans[hi] + ' ' + lo[1]];
  }
  function taThousand(t) {
    var d = PX.ta.num;
    if (t === 1) return [d.scales.standalone[0], d.scales.standaloneRomans[0]];
    if (t < 10) return [d.thousandFusedUnits.text[t - 1], d.thousandFusedUnits.romans[t - 1]];
    if (t < 20) return [d.thousandFusedTeens.text[t - 10], d.thousandFusedTeens.romans[t - 10]];
    var ti = Math.floor(t / 10) - 2, u = t % 10;
    if (!u) return [d.thousandFusedTens.text[ti], d.thousandFusedTens.romans[ti]];
    return [d.tensCombining.text[ti] + ' ' + d.thousandFusedUnits.text[u - 1], d.tensCombining.romans[ti] + ' ' + d.thousandFusedUnits.romans[u - 1]];
  }
  function taMult(x) {
    // multiplier for lakh/crore: sub-100 with a final ஒன்று → ஒரு
    var d = PX.ta.num, p = taSub100(x);
    if (x % 10 === 1 && (x < 10 || x >= 20)) {
      p = [p[0].replace(/ஒன்று$/, d.attributiveOne.text), p[1].replace(/ondru$/, d.attributiveOne.roman)];
    }
    return p;
  }
  function taNum(n) {
    var d = PX.ta.num;
    if (!n) return { text: d.units.text[0], roman: d.units.romans[0] };
    var c = Math.floor(n / 1e7), l = Math.floor(n % 1e7 / 1e5), t = Math.floor(n % 1e5 / 1000), r = n % 1000;
    var T = [], R = [];
    function pushScale(v, si, following) {
      var head = v === 1 ? [v === 1 && si === 0 ? d.scales.standalone[0] : d.attributiveOne.text + ' ' + d.scales.standalone[si], ''] : null;
      var word = following ? d.scales.combining[si] : d.scales.standalone[si];
      var wordR = following ? d.scales.combiningRomans[si] : d.scales.standaloneRomans[si];
      if (si === 0) {
        var th = taThousand(v);
        if (following) { th = [th[0].replace(/யிரம்$/, 'யிரத்து'), th[1].replace(/aayiram$/, 'aayiraththu')]; }
        T.push(th[0]); R.push(th[1]);
      } else if (v === 1) {
        T.push(d.attributiveOne.text + ' ' + word); R.push(d.attributiveOne.roman + ' ' + wordR);
      } else {
        var mlt = taMult(v);
        T.push(mlt[0] + ' ' + word); R.push(mlt[1] + ' ' + wordR);
      }
    }
    if (c) pushScale(c, 2, l || t || r);
    if (l) pushScale(l, 1, t || r);
    if (t) pushScale(t, 0, r);
    if (r) { var p = taSub1000(r); T.push(p[0]); R.push(p[1]); }
    return { text: T.join(' '), roman: R.join(' ') };
  }

  /* ---- Telugu (alone/combining/plural/oblique scale forms) ---- */

  function teSub100(x) {
    var d = PX.te.num;
    if (x < 20) return [d.u[x], d.ur[x]];
    var ti = Math.floor(x / 10), u = x % 10;
    return [d.t[ti] + (u ? ' ' + d.u[u] : ''), d.tr[ti] + (u ? ' ' + d.ur[u] : '')];
  }
  function teMult(x) {
    var d = PX.te.num, p = teSub100(x);
    if (x % 10 === 1 && (x < 10 || x >= 20)) {
      p = [p[0].replace(new RegExp(d.one.final + '$'), d.one.attr), p[1].replace(new RegExp(d.one.finalR + '$'), d.one.attrR)];
    }
    return p;
  }
  function teSub1000(x) {
    var d = PX.te.num, h = Math.floor(x / 100), r = x % 100;
    if (!h) return teSub100(x);
    if (h === 1) {
      if (!r) return [d.hundred.alone, d.hundredR.alone];
      var lo = teSub100(r);
      return [d.hundred.combining + ' ' + lo[0], d.hundredR.combining + ' ' + lo[1]];
    }
    var m2 = teMult(h);
    if (!r) return [m2[0] + ' ' + d.hundred.plural, m2[1] + ' ' + d.hundredR.plural];
    var lo2 = teSub100(r);
    return [m2[0] + ' ' + d.hundred.oblique + ' ' + lo2[0], m2[1] + ' ' + d.hundredR.oblique + ' ' + lo2[1]];
  }
  function teScale(v, w, wr, rest) {
    if (v === 1) return rest && w.combining ? [w.combining, wr.combining] : [w.alone, wr.alone];
    var m2 = teMult(v);
    return [m2[0] + ' ' + (rest ? w.oblique : w.plural), m2[1] + ' ' + (rest ? wr.oblique : wr.plural)];
  }
  function teNum(n) {
    var d = PX.te.num;
    if (!n) return { text: d.u[0], roman: d.ur[0] };
    var c = Math.floor(n / 1e7), l = Math.floor(n % 1e7 / 1e5), t = Math.floor(n % 1e5 / 1000), r = n % 1000;
    var T = [], R = [], p;
    if (c) { p = teScale(c, d.crore, d.croreR, l || t || r); T.push(p[0]); R.push(p[1]); }
    if (l) { p = teScale(l, d.lakh, d.lakhR, t || r); T.push(p[0]); R.push(p[1]); }
    if (t) { p = teScale(t, d.thousand, d.thousandR, r); T.push(p[0]); R.push(p[1]); }
    if (r) { p = teSub1000(r); T.push(p[0]); R.push(p[1]); }
    return { text: T.join(' '), roman: R.join(' ') };
  }

  /* ---- Georgian (vigesimal, truncating heads) ---- */

  function kaSub100(x) {
    var d = PX.ka.num;
    if (x <= 10) return [d.u[x], d.ur[x]];
    if (x < 20) return [d.teens[x - 11], d.teensr[x - 11]];
    var q = Math.floor(x / 20), r = x % 20;
    if (!r) return [d.sc20[q - 1], d.sc20r[q - 1]];
    var lo = kaSub100(r);
    return [d.sc20c[q - 1] + lo[0], d.sc20cr[q - 1] + lo[1]];
  }
  function kaSub1000(x) {
    var d = PX.ka.num, h = Math.floor(x / 100), r = x % 100;
    if (!h) return kaSub100(x);
    if (!r) return [d.h[h - 1], d.hr[h - 1]];
    var lo = kaSub100(r);
    return [d.hc[h - 1] + ' ' + lo[0], d.hcr[h - 1] + ' ' + lo[1]];
  }
  function kaNum(n) {
    var d = PX.ka.num;
    if (!n) return { text: d.u[0], roman: d.ur[0] };
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, T = [], R = [];
    if (m) {
      var rest1 = t || r, p1 = kaSub1000(m);
      T.push((m === 1 ? '' : p1[0] + ' ') + (rest1 ? 'მილიონ' : 'მილიონი'));
      R.push((m === 1 ? '' : p1[1] + ' ') + (rest1 ? 'milion' : 'milioni'));
    }
    if (t) {
      var p2 = kaSub1000(t);
      T.push((t === 1 ? '' : p2[0] + ' ') + (r ? 'ათას' : 'ათასი'));
      R.push((t === 1 ? '' : p2[1] + ' ') + (r ? 'atas' : 'atasi'));
    }
    if (r) { var p3 = kaSub1000(r); T.push(p3[0]); R.push(p3[1]); }
    return { text: T.join(' '), roman: R.join(' ') };
  }

  /* ---- Filipino (linkers and the ’t ligature) ---- */

  function filSub100(x) {
    var d = PX.fil.num;
    if (x < 10) return d.u[x];
    if (x === 10) return d.t[1];
    if (x < 20) return d.teens[x - 11];
    return d.t[Math.floor(x / 10)] + (x % 10 ? '’t ' + d.u[x % 10] : '');
  }
  function filSub999(x) {
    var d = PX.fil.num, h = Math.floor(x / 100), r = x % 100;
    if (!h) return filSub100(x);
    return d.h[h] + (r ? ' at ' + filSub100(r) : '');
  }
  function filLinker(s) {
    var last = s.charAt(s.length - 1);
    if ('aeiou'.indexOf(last) !== -1) return s + 'ng';
    if (last === 'n') return s + 'g';
    return s + ' na';
  }
  function filNum(n) {
    if (!n) return PX.fil.num.u[0];
    var m = Math.floor(n / 1e6), t = Math.floor(n % 1e6 / 1000), r = n % 1000, parts = [];
    if (m) parts.push(filLinker(filSub999(m)) + ' milyon');
    if (t) parts.push(filLinker(filSub999(t)) + ' libo');
    if (r) parts.push(filSub999(r));
    return parts.join(' ');
  }

  /* ---- xNum dispatch ---- */

  function xNum(lang, n) {
    switch (lang) {
      case 'pt': return { text: ptNum(n), roman: null };
      case 'it': return { text: itNum(n), roman: null };
      case 'nl': return { text: nlNum(n), roman: null };
      case 'pl': return { text: plNum(n), roman: null };
      case 'uk': var u = ukNum(n); return { text: u, roman: romanize(u, 'uk').roman };
      case 'cs': return { text: csNum(n), roman: null };
      case 'ro': return { text: roNum(n), roman: null };
      case 'sv': return { text: svNum(n), roman: null };
      case 'hu': return { text: huNum(n), roman: null };
      case 'id': return { text: idNum(n), roman: null };
      case 'vi': return { text: viNum(n), roman: null };
      case 'th': return thNum(n);
      case 'fil': return { text: filNum(n), roman: null };
      case 'fa': return faNum(n);
      case 'he': return heNum(n);
      case 'bn': return indicNum('bn', n);
      case 'ur': return indicNum('ur', n);
      case 'pa': return indicNum('pa', n);
      case 'mr': return mrNum(n);
      case 'ta': return taNum(n);
      case 'te': return teNum(n);
      case 'sw': return { text: swNum(n), roman: null };
      case 'am': return amNum(n);
      case 'ka': var k = kaNum(n); return { text: k.text, roman: k.roman };
    }
  }

  /* ---- clocks for the extended languages ---- */

  var PL_HOUR_ORD = ['', 'pierwsza', 'druga', 'trzecia', 'czwarta', 'piąta', 'szósta', 'siódma', 'ósma', 'dziewiąta', 'dziesiąta', 'jedenasta', 'dwunasta', 'trzynasta', 'czternasta', 'piętnasta', 'szesnasta', 'siedemnasta', 'osiemnasta', 'dziewiętnasta', 'dwudziesta', 'dwudziesta pierwsza', 'dwudziesta druga', 'dwudziesta trzecia'];

  function xTime(lang, h, m) {
    var a, b, t, r, hw;
    switch (lang) {
      case 'pt':
        a = h === 0 ? 'zero' : h === 1 ? 'uma' : ptNum(h).replace(/dois$/, 'duas').replace(/um$/, 'uma');
        t = a + (h === 0 || h === 1 ? ' hora' : ' horas') + (m ? ' e ' + ptNum(m) : h === 0 ? '' : ' em ponto');
        return { text: t, roman: null };
      case 'it':
        if (h === 0) t = 'è mezzanotte' + (m ? ' e ' + itNum(m) : '');
        else if (h === 1) t = "è l'una" + (m ? ' e ' + itNum(m) : '');
        else t = 'sono le ' + itNum(h) + (m ? ' e ' + itNum(m) : '');
        return { text: t, roman: null };
      case 'nl':
        return { text: nlNum(h) + ' uur' + (m ? ' ' + nlNum(m) : ''), roman: null };
      case 'pl':
        a = h === 0 ? (m ? 'zero' : 'północ') : PL_HOUR_ORD[h];
        return { text: a + (m ? ' ' + (m < 10 ? 'zero ' : '') + plNum(m) : ''), roman: null };
      case 'uk':
        if (m) t = ukNum(h) + ' ' + (m < 10 ? 'нуль ' : '') + ukNum(m);
        else {
          hw = ['година', 'години', 'годин'][slavicSelect(h)];
          if (h === 0) hw = 'годин';
          t = ukSub1000(h, true) + ' ' + hw;
          if (h === 0) t = 'нуль годин';
        }
        return { text: t, roman: romanize(t, 'uk').roman };
      case 'cs':
        if (m) t = csNum(h) + ' ' + (m < 10 ? 'nula ' : '') + csNum(m);
        else if (h === 0) t = 'nula hodin';
        else if (h === 1) t = 'jedna hodina';
        else if (h === 2) t = 'dvě hodiny';
        else t = csNum(h) + (h <= 4 ? ' hodiny' : ' hodin');
        return { text: t, roman: null };
      case 'ro':
        a = h === 1 ? 'unu' : h === 0 ? 'zero' : roFem(roSub1000(h), h);
        if (h === 12) a = PX.ro.num.fem[12];
        if (!m) return { text: 'este ora ' + a, roman: null };
        b = m === 1 ? 'un minut' : roFem(roSub1000(m), m).replace(/două$/, 'două') + (roDe(m) ? ' de minute' : ' minute');
        if (m === 2) b = 'două minute';
        return { text: 'este ora ' + a + ' și ' + b, roman: null };
      case 'sv':
        return { text: 'klockan ' + svNum(h) + (m ? ' ' + (m < 10 ? 'noll ' : '') + svNum(m) : ''), roman: null };
      case 'hu':
        return { text: huAttr(huNum(h)) + ' óra' + (m ? ' ' + huAttr(huNum(m)) + ' perc' : ''), roman: null };
      case 'id':
        return { text: 'pukul ' + idNum(h) + (m ? ' lewat ' + idNum(m) + ' menit' : ''), roman: null };
      case 'vi':
        return { text: viNum(h) + ' giờ' + (m ? ' ' + viNum(m) + ' phút' : ''), roman: null };
      case 'th':
        a = thNum(h); b = m ? thNum(m) : null;
        return { text: a.text + 'นาฬิกา' + (b ? b.text + 'นาที' : ''), roman: a.roman + ' nalika' + (b ? ' ' + b.roman + ' nathi' : '') };
      case 'fil':
        var dial = h % 12 === 0 ? 12 : h % 12;
        var part = h === 0 ? 'ng hatinggabi' : h < 12 ? 'ng umaga' : h === 12 ? 'ng tanghali' : h <= 17 ? 'ng hapon' : 'ng gabi';
        a = PX.fil.time.hourNames[dial - 1];
        if (!m) return { text: a + ' ' + part, roman: null };
        if (m === 30) return { text: a + ' y medya ' + part, roman: null };
        b = m < 10 ? PX.fil.time.minuteUnits[m] : m < 20 ? PX.fil.time.minuteTeens[m - 10] : PX.fil.time.minuteTens[Math.floor(m / 10)] + (m % 10 ? ' ' + PX.fil.time.minuteUnits[m % 10] : '');
        return { text: a + ' ' + b + ' ' + part, roman: null };
      case 'fa':
        a = faNum(h); b = m ? faNum(m) : null;
        return { text: 'ساعت ' + a.text + (b ? ' و ' + b.text + ' دقیقه' : ''), roman: 'sa’at-e ' + a.roman + (b ? ' o ' + b.roman + ' daghighe' : '') };
      case 'he':
        a = heNum(h); b = m ? heNum(m) : null;
        if (!b) return { text: 'השעה ' + a.text, roman: "ha-sha'a " + a.roman };
        t = 'השעה ' + a.text + ' ו' + b.text + (m < 10 ? ' דקות' : '');
        return { text: t, roman: "ha-sha'a " + a.roman + ' ve-' + b.roman + (m < 10 ? ' dakot' : '') };
      case 'bn':
        a = indicNum('bn', h); b = m ? indicNum('bn', m) : null;
        if (!b) return { text: a.text + 'টা বাজে', roman: a.roman + 'ta baje' };
        return { text: a.text + 'টা বেজে ' + b.text + ' মিনিট', roman: a.roman + 'ta beje ' + b.roman + ' minit' };
      case 'ur':
        a = indicNum('ur', h); b = m ? indicNum('ur', m) : null;
        if (!b) return { text: a.text + ' بجے', roman: a.roman + ' baje' };
        return { text: a.text + ' بج کر ' + b.text + ' منٹ', roman: a.roman + ' baj kar ' + b.roman + ' minute' };
      case 'pa':
        a = indicNum('pa', h); b = m ? indicNum('pa', m) : null;
        if (!b) return { text: a.text + ' ਵਜੇ', roman: a.roman + ' vaje' };
        return { text: a.text + ' ਵੱਜ ਕੇ ' + b.text + ' ਮਿੰਟ', roman: a.roman + ' vaj ke ' + b.roman + ' mint' };
      case 'mr':
        a = mrNum(h); b = m ? mrNum(m) : null;
        if (!b) {
          if (h === 1) return { text: 'एक वाजला', roman: 'ek vajla' };
          return { text: a.text + ' वाजले', roman: a.roman + ' vajle' };
        }
        return { text: a.text + ' वाजून ' + b.text + (m === 1 ? ' मिनिट' : ' मिनिटे'), roman: a.roman + ' vajun ' + b.roman + (m === 1 ? ' minit' : ' minite') };
      case 'ta':
        a = h === 0 ? taNum(12) : h === 1 ? { text: PX.ta.num.attributiveOne.text, roman: PX.ta.num.attributiveOne.roman } : taNum(h);
        if (h > 1 && h % 10 === 1) {
          // hours ending in 1 take attributive ஒரு: இருபத்து ஒரு மணி, பதினொரு மணி
          a = {
            text: a.text.replace(/ஒன்று$/, PX.ta.num.attributiveOne.text).replace(/னொன்று$/, 'னொரு'),
            roman: a.roman.replace(/ondru$/, PX.ta.num.attributiveOne.roman)
          };
        }
        b = m ? taNum(m) : null;
        return { text: a.text + ' மணி' + (b ? ' ' + b.text + ' நிமிடம்' : ''), roman: a.roman + ' mani' + (b ? ' ' + b.roman + ' nimidam' : '') };
      case 'te':
        b = m ? (m === 1 ? { text: 'ఒక నిమిషం', roman: 'oka nimisham' } : { text: teNum(m).text + ' నిమిషాలు', roman: teNum(m).roman + ' nimishaalu' }) : null;
        if (h === 1) {
          t = 'ఒంటి గంట' + (b ? ' ' + b.text : '');
          return { text: t, roman: 'onti ganta' + (b ? ' ' + b.roman : '') };
        }
        a = teNum(h);
        if (!b) return { text: a.text + ' గంటలు', roman: a.roman + ' gantalu' };
        return { text: a.text + ' గంటల ' + b.text, roman: a.roman + ' gantala ' + b.roman };
      case 'sw':
        var swh = ((h % 12) + 6) % 12; if (swh === 0) swh = 12;
        var period = h >= 5 && h <= 11 ? ' asubuhi' : h >= 12 && h <= 15 ? ' mchana' : h >= 16 && h <= 18 ? ' jioni' : ' usiku';
        if (m === 45) {
          var swh2 = ((h % 12) + 7) % 12; if (swh2 === 0) swh2 = 12;
          t = 'saa ' + swNum(swh2) + ' kasoro robo' + period;
        } else {
          t = 'saa ' + swNum(swh) + (m === 0 ? ' kamili' : m === 15 ? ' na robo' : m === 30 ? ' na nusu' : ' na dakika ' + swNum(m)) + period;
        }
        return { text: t, roman: null };
      case 'am':
        a = amNum(h); b = m ? amNum(m) : null;
        return { text: a.text + ' ሰዓት' + (b ? ' ከ' + b.text + ' ደቂቃ' : ''), roman: a.roman + ' se’at' + (b ? ' ke-' + b.roman + ' dekika' : '') };
      case 'ka':
        a = kaNum(h); b = m ? kaNum(m) : null;
        return { text: a.text + ' საათი' + (b ? ' და ' + b.text + ' წუთი' : ''), roman: a.roman + ' saati' + (b ? ' da ' + b.roman + ' tsuti' : '') };
    }
  }

  /* ---- dates for the extended languages ---- */

  var BN_DIGITS = '০১২৩৪৫৬৭৮৯';
  function bnDigits(x) {
    var s = String(x), out = '', i;
    for (i = 0; i < s.length; i++) out += BN_DIGITS.charAt(s.charCodeAt(i) - 48);
    return out;
  }

  function xDate(lang, y, mo, d) {
    var mon = PX[lang].mon[mo - 1];
    var monR = PX[lang].monR ? PX[lang].monR[mo - 1] : null;
    var t;
    switch (lang) {
      case 'pt': return { text: (d === 1 ? '1º' : d) + ' de ' + mon + ' de ' + y, roman: null };
      case 'it': return { text: 'il ' + (d === 1 ? 'primo' : d) + ' ' + mon + ' ' + y, roman: null };
      case 'nl': return { text: d + ' ' + mon + ' ' + y, roman: null };
      case 'pl': return { text: d + ' ' + mon + ' ' + y + ' r.', roman: null };
      case 'uk': t = d + ' ' + mon + ' ' + y + ' р.'; return { text: t, roman: romanize(t, 'uk').roman };
      case 'cs': return { text: d + '. ' + mon + ' ' + y, roman: null };
      case 'ro': return { text: d + ' ' + mon + ' ' + y, roman: null };
      case 'sv': return { text: 'den ' + d + ' ' + mon + ' ' + y, roman: null };
      case 'hu': return { text: y + '. ' + mon + ' ' + d + '.', roman: null };
      case 'id': return { text: d + ' ' + mon + ' ' + y, roman: null };
      case 'vi': return { text: 'ngày ' + d + ' tháng ' + mo + ' năm ' + y, roman: null };
      case 'th': return { text: d + ' ' + mon + ' ค.ศ. ' + y, roman: d + ' ' + monR + ' kho so ' + y };
      case 'fil': return { text: 'ika-' + d + ' ng ' + mon + ', ' + y, roman: null };
      case 'fa': return { text: d + ' ' + mon + ' ' + y, roman: d + ' ' + monR + ' ' + y };
      case 'he': return { text: d + ' ב' + mon + ' ' + y, roman: d + ' be-' + monR + ' ' + y };
      case 'bn': return { text: bnDigits(d) + ' ' + mon + ' ' + bnDigits(y), roman: d + ' ' + monR + ' ' + y };
      case 'ur': return { text: d + ' ' + mon + ' ' + y, roman: d + ' ' + monR + ' ' + y };
      case 'pa': return { text: d + ' ' + mon + ' ' + y, roman: d + ' ' + monR + ' ' + y };
      case 'mr': return { text: d + ' ' + mon + ' ' + y, roman: d + ' ' + monR + ' ' + y };
      case 'ta': return { text: d + ' ' + mon + ' ' + y, roman: d + ' ' + monR + ' ' + y };
      case 'te': return { text: d + ' ' + mon + ', ' + y, roman: d + ' ' + monR + ', ' + y };
      case 'sw': return { text: 'tarehe ' + d + ' ' + mon + ' ' + y, roman: null };
      case 'am': return { text: mon + ' ' + d + ' ቀን ' + y, roman: monR + ' ' + d + ' ken ' + y };
      case 'ka': t = y + ' წლის ' + d + ' ' + mon; return { text: t, roman: romanize(t).roman };
    }
  }

  /* ---- fold the extended languages into the engine ---- */

  (function () {
    var i, j;
    for (i = 0; i < LANGS_X.length; i++) {
      LANGS.push(LANGS_X[i]);
      LANG_BY_CODE[LANGS_X[i].code] = LANGS_X[i];
    }
    for (i = 0; i < PHRASES.length; i++) {
      var p = PHRASES[i];
      for (j = 0; j < LANGS_X.length; j++) {
        var code = LANGS_X[j].code, cell = PX[code].ph[p.id];
        p.t[code] = cell[0];
        if (cell[1]) p.r[code] = cell[1];
      }
    }
    // detection: new self-identifying scripts…
    var ranges = [
      ['thai', 'th', /[฀-๿]/], ['hebrew', 'he', /[֐-׿]/],
      ['bengali', 'bn', /[ঀ-৿]/], ['gurmukhi', 'pa', /[਀-੿]/],
      ['tamil', 'ta', /[஀-௿]/], ['telugu', 'te', /[ఀ-౿]/],
      ['ethiopic', 'am', /[ሀ-፿]/], ['georgian', 'ka', /[Ⴀ-ჿ]/]
    ];
    for (i = 0; i < ranges.length; i++) {
      SCRIPT_RANGES.push({ script: ranges[i][0], lang: ranges[i][1], re: ranges[i][2] });
    }
    // …and refinements for scripts shared between languages
    SCRIPT_REFINE.arabic = function (text) {
      if (/[ٹڈڑںےھہ]/.test(text)) return 'ur';
      if (/[پچژگ]/.test(text)) return 'fa';
      var toks = String(text).split(/[\s،؟٬\u200c!.]+/), i;
      var faWords = ['سلام', 'خداحافظ', 'لطفا', 'لطفاً', 'است', 'بله', 'ممنون', 'متشکرم', 'کجاست'];
      var urWords = ['آپ', 'کیا', 'مجھے', 'شکریہ', 'علیکم'];
      for (i = 0; i < toks.length; i++) {
        if (faWords.indexOf(toks[i]) !== -1) return 'fa';
        if (urWords.indexOf(toks[i]) !== -1) return 'ur';
      }
      // ک/ی are Perso-Urdu letters Arabic never uses; unmarked text
      // carrying them defaults to the far more common Persian
      if (/[کی]/.test(text)) return 'fa';
      return 'ar';
    };
    SCRIPT_REFINE.devanagari = function (text) {
      if (/[ळऱ]/.test(text)) return 'mr';
      return /(^|\s)(आहे|आहेत|नाही|करा|द्या|बोलवा|मला|माझे|माझं|तुम्ही|किती|कुठे)(?=[\s?!.,।]|$)/.test(text) ? 'mr' : 'hi';
    };
    SCRIPT_REFINE.cyrillic = function (text) {
      var t = String(text).toLowerCase();
      var uk = (t.match(/[іїєґ]/g) || []).length;
      var ru = (t.match(/[ыэъё]/g) || []).length;
      var ukWords = ['будь ласка', 'дякую', 'добри', 'доброго', 'вибачте', 'побачення', 'скільки', 'коштує', 'квиток', 'рахунок', 'смачно', 'мене звати', 'допоможіть', 'розумію'];
      var ruWords = ['пожалуйста', 'спасибо', 'здравствуйте', 'извините', 'привет', 'хорошо'];
      var i;
      for (i = 0; i < ukWords.length; i++) { if (t.indexOf(ukWords[i]) !== -1) uk += 2; }
      for (i = 0; i < ruWords.length; i++) { if (t.indexOf(ruWords[i]) !== -1) ru += 2; }
      return uk > ru ? 'uk' : 'ru';
    };
    // Latin-script scoring lists (referee-de-collided against each other)
    for (i = 0; i < LANGS_X.length; i++) {
      var L = LANGS_X[i], det = PX[L.code].det;
      if (L.script === 'latin' && det) {
        STOPWORDS[L.code] = det[0];
        DIACRITICS[L.code] = det[1];
        LATIN_LANGS.push(L.code);
      }
    }
  })();

  /* ---------------- orchestration ---------------- */

  function phraseIn(id, lang) {
    var p = PHRASE_BY_ID[id];
    if (!p) throw new Error('unknown phrase: ' + id);
    var L = LANG_BY_CODE[lang];
    if (!L) throw new Error('unknown lang: ' + lang);
    var text = lang === 'en' ? p.en : p.t[lang];
    var roman = null;
    if (p.r && p.r[lang]) roman = p.r[lang];
    else if (L.script === 'cyrillic' || L.script === 'greek' || L.script === 'kana' || L.script === 'hangul' || L.script === 'georgian') {
      roman = romanize(text, lang).roman;
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
    var ranked = rankPhrases(input);
    if (!ranked.length || ranked[0].score < MATCH_THRESHOLD) {
      return {
        kind: 'none', detected: detected,
        suggestions: ranked.slice(0, 3).map(function (r) { return { id: r.id, en: PHRASE_BY_ID[r.id].en, score: r.score }; })
      };
    }
    var top = ranked[0], hit = PHRASE_BY_ID[top.id];
    sig = signalsFor(hit.en);
    return {
      kind: 'phrase', detected: detected,
      match: {
        id: hit.id, cat: hit.cat, en: hit.en, score: top.score, sourceLang: top.sourceLang,
        alternates: ranked.slice(1, 4).map(function (r) { return { id: r.id, en: PHRASE_BY_ID[r.id].en, score: r.score }; })
      },
      results: cardsFor(function (code) { return phraseIn(hit.id, code); }),
      signal: sig.signal, vessel: sig.vessel
    };
  }

  // One interpreter turn: work out what was said (and by whom), then
  // hand back the target-language rendering ready to be spoken aloud.
  // Pure like everything else — the UI owns the microphone and voices.
  function interpret(input, toLang, fromHint) {
    var to = LANG_BY_CODE[toLang];
    if (!to) throw new Error('unknown lang: ' + toLang);
    if (fromHint && !LANG_BY_CODE[fromHint]) throw new Error('unknown lang: ' + fromHint);
    // an explicit hint outranks detection: the caller knows which language the
    // recognizer transcribed in, and detection can be confidently wrong on
    // near-twin scripts (uk/ru, tr/hu) even for exact phrasebook renderings.
    var detected = detect(input);
    var from = fromHint || (detected.best ? detected.best.lang : null);
    var parsed = parseInput(input), v;
    if (parsed.kind === 'number') v = spellNumber(parsed.n, toLang);
    else if (parsed.kind === 'time') v = spellTime(parsed.h, parsed.m, toLang);
    else if (parsed.kind === 'date') v = spellDate(parsed.y, parsed.m, parsed.d, toLang);
    if (v) {
      return { ok: true, kind: parsed.kind, from: from, heard: input, heardAs: input,
        text: v.text, roman: v.roman, dir: to.dir, voice: to.voice, to: toLang };
    }
    var ranked = rankPhrases(input);
    if (!ranked.length || ranked[0].score < MATCH_THRESHOLD) {
      return {
        ok: false, kind: 'none', from: from, heard: input, to: toLang,
        suggestions: ranked.slice(0, 3).map(function (r) { return { id: r.id, en: PHRASE_BY_ID[r.id].en, score: r.score }; })
      };
    }
    var top = ranked[0], p = PHRASE_BY_ID[top.id];
    if (!from) from = top.sourceLang;
    var cell = phraseIn(top.id, toLang);
    // what Babel understood, echoed in the speaker's own language
    var heardAs = from && from !== 'en' && p.t[from] ? p.t[from] : p.en;
    return {
      ok: true, kind: 'phrase', id: p.id, en: p.en, score: top.score,
      from: from, heard: input, heardAs: heardAs,
      text: cell.text, roman: cell.roman, dir: cell.dir, voice: to.voice, to: toLang
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
    MATCH_THRESHOLD: MATCH_THRESHOLD, VESSEL: VESSEL, CURATED_R: CURATED_R,
    hashStr: hashStr, rand01: rand01, escapeHTML: escapeHTML,
    normalize: normalize, similarity: similarity, editDistance: editDistance,
    detect: detect, matchPhrase: matchPhrase, rankPhrases: rankPhrases,
    phraseIn: phraseIn, phrasesByCategory: phrasesByCategory,
    spellNumber: spellNumber, spellTime: spellTime, spellDate: spellDate,
    parseInput: parseInput, romanize: romanize,
    canonical: canonical, encode: encode, decode: decode,
    vesselEncode: vesselEncode, vesselDecode: vesselDecode,
    translate: translate, interpret: interpret, dailyPhrase: dailyPhrase
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = E;
  root.BabelEngine = E;
})(typeof self !== 'undefined' ? self : this);
