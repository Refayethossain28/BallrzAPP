/* Imposter — the game engine. Pure, deterministic, dependency-free logic so it
 * can be unit-tested in a Node `vm` sandbox (see scripts/test-imposter-logic.mjs)
 * and reused verbatim by the browser UI (index.html loads this file as-is).
 *
 * The rules in one breath: everyone but the imposter(s) shares one secret word.
 * Players take turns giving a one-word clue about it. The imposter doesn't know
 * the word and has to bluff. Then everyone votes. Crew win by unmasking an
 * imposter; the unmasked imposter can still steal the round by naming the word.
 *
 * Nothing here touches the DOM, the clock, or global randomness — every function
 * that needs entropy takes an `rng` (0..1) so play is reproducible in tests. */

/* ------------------------------------------------------------------ *
 *  Word packs. Each entry is a single concrete noun that's easy to
 *  hint at in one word but hard to say outright — the sweet spot for
 *  the game. Decoy mode pulls the imposter's fake word from the same
 *  pack, so packs want enough internal variety to mislead.
 * ------------------------------------------------------------------ */
const WORD_PACKS = {
  food: { name: 'Food', emoji: '🍔', words: [
    'Pizza', 'Sushi', 'Burger', 'Taco', 'Pancake', 'Spaghetti', 'Burrito', 'Donut',
    'Lasagna', 'Omelette', 'Dumpling', 'Croissant', 'Waffle', 'Nachos', 'Ramen',
    'Curry', 'Hotdog', 'Cheesecake', 'Pretzel', 'Falafel', 'Risotto', 'Paella',
    'Gnocchi', 'Quesadilla', 'Meatball', 'Pudding', 'Brownie', 'Bagel', 'Kebab', 'Sandwich' ] },
  animals: { name: 'Animals', emoji: '🦊', words: [
    'Elephant', 'Penguin', 'Dolphin', 'Kangaroo', 'Octopus', 'Giraffe', 'Hedgehog',
    'Cheetah', 'Walrus', 'Flamingo', 'Raccoon', 'Panda', 'Koala', 'Otter', 'Sloth',
    'Hippo', 'Gorilla', 'Peacock', 'Chameleon', 'Platypus', 'Lobster', 'Jellyfish',
    'Squirrel', 'Tortoise', 'Owl', 'Bat', 'Wolf', 'Llama', 'Crab', 'Seal' ] },
  places: { name: 'Places', emoji: '🗺️', words: [
    'Beach', 'Airport', 'Library', 'Hospital', 'Casino', 'Volcano', 'Desert',
    'Castle', 'Stadium', 'Aquarium', 'Cinema', 'Cemetery', 'Lighthouse', 'Subway',
    'Vineyard', 'Glacier', 'Pyramid', 'Waterfall', 'Carnival', 'Greenhouse',
    'Dungeon', 'Harbour', 'Observatory', 'Mosque', 'Bakery', 'Prison', 'Spa',
    'Temple', 'Bunker', 'Rainforest' ] },
  movies: { name: 'Movies & TV', emoji: '🎬', words: [
    'Titanic', 'Frozen', 'Avatar', 'Joker', 'Shrek', 'Gladiator', 'Inception',
    'Jaws', 'Matrix', 'Aladdin', 'Rocky', 'Up', 'Coco', 'Encanto', 'Twilight',
    'Grease', 'Tangled', 'Moana', 'Dune', 'Barbie', 'Friends', 'Lost',
    'Sherlock', 'Westworld', 'Vikings', 'Succession', 'Severance', 'Dexter',
    'Heat', 'Cars' ] },
  sports: { name: 'Sports', emoji: '⚽', words: [
    'Football', 'Boxing', 'Tennis', 'Cricket', 'Surfing', 'Skiing', 'Bowling',
    'Archery', 'Fencing', 'Rugby', 'Hockey', 'Cycling', 'Rowing', 'Karate',
    'Golf', 'Climbing', 'Diving', 'Curling', 'Snooker', 'Baseball', 'Marathon',
    'Wrestling', 'Skating', 'Polo', 'Gymnastics', 'Volleyball', 'Sailing',
    'Darts', 'Judo', 'Basketball' ] },
  jobs: { name: 'Jobs', emoji: '💼', words: [
    'Surgeon', 'Pilot', 'Plumber', 'Lawyer', 'Chef', 'Teacher', 'Firefighter',
    'Astronaut', 'Barber', 'Detective', 'Electrician', 'Journalist', 'Lifeguard',
    'Magician', 'Dentist', 'Farmer', 'Architect', 'Carpenter', 'Sailor',
    'Referee', 'Tattooist', 'Butcher', 'Janitor', 'Florist', 'Locksmith',
    'Paramedic', 'Sculptor', 'Beekeeper', 'Diplomat', 'Cashier' ] },
  household: { name: 'Around the House', emoji: '🏠', words: [
    'Toaster', 'Mirror', 'Pillow', 'Kettle', 'Candle', 'Blender', 'Ladder',
    'Umbrella', 'Vacuum', 'Mattress', 'Curtain', 'Doorbell', 'Fridge', 'Hammer',
    'Stapler', 'Teapot', 'Bathtub', 'Lampshade', 'Wardrobe', 'Cushion',
    'Coaster', 'Mousetrap', 'Corkscrew', 'Spatula', 'Thermostat', 'Drawer',
    'Whisk', 'Broom', 'Sponge', 'Clock' ] },
  nature: { name: 'Nature', emoji: '🌿', words: [
    'Rainbow', 'Thunder', 'Tornado', 'Cactus', 'Iceberg', 'Mushroom', 'Quicksand',
    'Avalanche', 'Geyser', 'Coral', 'Meteor', 'Wildfire', 'Sunflower', 'Maple',
    'Blizzard', 'Canyon', 'Tsunami', 'Dewdrop', 'Marsh', 'Boulder', 'Comet',
    'Eclipse', 'Fjord', 'Lava', 'Pollen', 'Reef', 'Tundra', 'Whirlpool',
    'Moss', 'Frost' ] },
  tech: { name: 'Tech', emoji: '💻', words: [
    'Robot', 'Keyboard', 'Headphones', 'Joystick', 'Drone', 'Webcam', 'Router',
    'Microchip', 'Hologram', 'Satellite', 'Touchscreen', 'Hardrive', 'Charger',
    'Speaker', 'Printer', 'Scanner', 'Firewall', 'Bluetooth', 'Cursor', 'Pixel',
    'Server', 'Algorithm', 'Battery', 'Antenna', 'Modem', 'Emoji', 'Password',
    'Spreadsheet', 'Podcast', 'Avatar' ] },
  travel: { name: 'Travel', emoji: '✈️', words: [
    'Passport', 'Suitcase', 'Compass', 'Hammock', 'Snorkel', 'Postcard', 'Tent',
    'Cruise', 'Backpack', 'Souvenir', 'Hostel', 'Safari', 'Gondola', 'Cablecar',
    'Roadtrip', 'Visa', 'Sunscreen', 'Map', 'Ferry', 'Camel', 'Igloo', 'Resort',
    'Layover', 'Monsoon', 'Bazaar', 'Caravan', 'Ticket', 'Lagoon', 'Trek', 'Customs' ] },
  music: { name: 'Music', emoji: '🎸', words: [
    'Guitar', 'Drums', 'Violin', 'Trumpet', 'Piano', 'Harmonica', 'Saxophone',
    'Banjo', 'Flute', 'Cello', 'Accordion', 'Tambourine', 'Microphone', 'Choir',
    'Orchestra', 'Karaoke', 'Bagpipes', 'Ukulele', 'Harp', 'Xylophone', 'Concert',
    'Vinyl', 'Encore', 'Lullaby', 'Trombone', 'Maracas', 'Anthem', 'Opera',
    'Whistle', 'Bass' ] },
  fantasy: { name: 'Fantasy', emoji: '🐉', words: [
    'Dragon', 'Wizard', 'Unicorn', 'Goblin', 'Mermaid', 'Vampire', 'Phoenix',
    'Werewolf', 'Sorcerer', 'Griffin', 'Troll', 'Pegasus', 'Banshee', 'Kraken',
    'Genie', 'Centaur', 'Gargoyle', 'Wraith', 'Elf', 'Ogre', 'Fairy', 'Minotaur',
    'Zombie', 'Witch', 'Knight', 'Cyclops', 'Hydra', 'Ghost', 'Yeti', 'Imp' ] },
};

/* Pack key list, in a stable display order. */
const PACK_KEYS = Object.keys(WORD_PACKS);

/* ------------------------------------------------------------------ *
 *  RNG. mulberry32 — a tiny deterministic PRNG so a seed reproduces a
 *  whole game in tests. The UI seeds it from crypto for real randomness.
 * ------------------------------------------------------------------ */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Fisher–Yates using a provided rng(); returns a new array. */
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

const randInt = (rng, n) => Math.floor(rng() * n);
const pick = (rng, arr) => arr[randInt(rng, arr.length)];

/* ------------------------------------------------------------------ *
 *  Setup helpers
 * ------------------------------------------------------------------ */

/* Default imposter count scales with the table: one is plenty up to five,
 * two keeps a big table tense. Always leaves at least two crew so there's a
 * word-sharing majority to deduce against. */
function suggestImposters(playerCount) {
  if (playerCount >= 7) return 2;
  return 1;
}

/* The most imposters a table can legally run: never half-or-more (the crew
 * must outnumber them), and never fewer than one crew-pair to compare clues. */
function maxImposters(playerCount) {
  return Math.max(1, Math.min(Math.floor((playerCount - 1) / 2), playerCount - 2));
}

/* Resolve "which words are in play" for a pack key. 'mixed' merges every pack;
 * a custom array is passed straight through. */
function resolveWordList(packKey, custom) {
  if (Array.isArray(custom) && custom.length) return custom.slice();
  if (packKey === 'mixed') return PACK_KEYS.flatMap((k) => WORD_PACKS[k].words);
  const pack = WORD_PACKS[packKey];
  return pack ? pack.words.slice() : [];
}

/* ------------------------------------------------------------------ *
 *  Dealing a round
 * ------------------------------------------------------------------ */

/* Modes:
 *   'classic' — imposter is told they're the imposter, gets no word.
 *   'decoy'   — imposter gets a *different* word from the same pack, so they
 *               can bluff a plausible clue without knowing they're adrift.
 *
 *   `players` : array of { id, name }
 *   returns   : { secret, decoy, category, packKey, mode, order, assignments }
 *     assignments: [{ id, name, role:'crew'|'imposter', word|null, isImposter }]
 *     order: array of player ids = clue-giving order, starting player first.
 */
function dealRound(opts) {
  const {
    players, imposterCount = 1, packKey = 'food', mode = 'classic',
    custom = null, rng = Math.random,
  } = opts;

  if (!players || players.length < 3) throw new Error('Need at least 3 players');
  const imps = Math.max(1, Math.min(imposterCount, maxImposters(players.length)));

  const words = resolveWordList(packKey, custom);
  if (words.length < 2) throw new Error('Word list too small');

  const secret = pick(rng, words);
  // Decoy is any *other* word from the same list.
  let decoy = null;
  if (mode === 'decoy') {
    const others = words.filter((w) => w !== secret);
    decoy = others.length ? pick(rng, others) : secret;
  }

  // Choose who the imposters are.
  const ids = players.map((p) => p.id);
  const imposterIds = new Set(shuffle(ids, rng).slice(0, imps));

  const assignments = players.map((p) => {
    const isImposter = imposterIds.has(p.id);
    return {
      id: p.id,
      name: p.name,
      role: isImposter ? 'imposter' : 'crew',
      isImposter,
      word: isImposter ? (mode === 'decoy' ? decoy : null) : secret,
    };
  });

  // Clue order: a fresh shuffle so the same person doesn't always open.
  const order = shuffle(ids, rng);

  const category = packKey === 'mixed'
    ? 'Mixed'
    : (custom ? 'Custom' : (WORD_PACKS[packKey] ? WORD_PACKS[packKey].name : packKey));

  return { secret, decoy, category, packKey, mode, order, assignments };
}

/* ------------------------------------------------------------------ *
 *  Voting
 * ------------------------------------------------------------------ */

/* votes: array of accused player ids (one per voter, abstain = null/undefined).
 * Returns { counts: {id:n}, max, leaders:[ids], tie:bool, eliminated:id|null }.
 * A tie (or no votes) eliminates nobody — the table has to live with it. */
function tallyVotes(votes) {
  const counts = {};
  for (const v of votes) {
    if (v == null) continue;
    counts[v] = (counts[v] || 0) + 1;
  }
  let max = 0;
  for (const id in counts) if (counts[id] > max) max = counts[id];
  const leaders = Object.keys(counts).filter((id) => counts[id] === max && max > 0);
  const tie = leaders.length !== 1;
  return { counts, max, leaders, tie, eliminated: tie ? null : leaders[0] };
}

/* ------------------------------------------------------------------ *
 *  Scoring
 * ------------------------------------------------------------------ */
const SCORE = Object.freeze({
  CREW_CATCH: 1,      // each crew member, for unmasking an imposter
  IMPOSTER_STEAL: 3,  // each imposter, when an unmasked imposter names the word
  IMPOSTER_EVADE: 2,  // each imposter, when the table eliminates a crewmate or hangs
});

/* Resolve a round once a player has been voted out (or nobody was).
 *
 *   assignments    : from dealRound
 *   eliminatedId   : tallyVotes().eliminated (may be null on a tie)
 *   guessedWord    : the word an unmasked imposter named (or null/'' if none)
 *   secret         : the round's secret word
 *
 * Returns { outcome, winner, caughtImposter, stolen, scores:{id:delta}, summary }.
 *   outcome: 'crew' | 'imposter'
 */
function resolveRound(args) {
  const { assignments, eliminatedId, guessedWord = null, secret } = args;
  const imposters = assignments.filter((a) => a.isImposter);
  const crew = assignments.filter((a) => !a.isImposter);
  const eliminated = assignments.find((a) => a.id === eliminatedId) || null;
  const scores = {};
  for (const a of assignments) scores[a.id] = 0;

  const norm = (s) => String(s || '').trim().toLowerCase();
  const guessRight = !!guessedWord && norm(guessedWord) === norm(secret);

  let outcome, caughtImposter = false, stolen = false, summary;

  if (eliminated && eliminated.isImposter) {
    caughtImposter = true;
    if (guessRight) {
      // Caught — but the imposter named the word and steals the round.
      stolen = true;
      outcome = 'imposter';
      for (const a of imposters) scores[a.id] = SCORE.IMPOSTER_STEAL;
      summary = `${eliminated.name} was the imposter — but guessed “${secret}” and stole it.`;
    } else {
      outcome = 'crew';
      for (const a of crew) scores[a.id] = SCORE.CREW_CATCH;
      summary = `${eliminated.name} was the imposter. The crew wins.`;
    }
  } else {
    // An innocent was voted out, or the vote tied — imposters get away with it.
    outcome = 'imposter';
    for (const a of imposters) scores[a.id] = SCORE.IMPOSTER_EVADE;
    summary = eliminated
      ? `${eliminated.name} was innocent. The imposter walks free.`
      : `The vote was tied — the imposter walks free.`;
  }

  return { outcome, winner: outcome, caughtImposter, stolen, guessRight, scores, summary };
}

/* Fold a round's score deltas into a running totals map (id -> total). */
function applyScores(totals, deltas) {
  const out = Object.assign({}, totals);
  for (const id in deltas) out[id] = (out[id] || 0) + deltas[id];
  return out;
}

/* ------------------------------------------------------------------ *
 *  Exports — works under Node (vm/CommonJS) and as a browser global.
 * ------------------------------------------------------------------ */
const API = {
  WORD_PACKS, PACK_KEYS, SCORE,
  mulberry32, shuffle, pick, randInt,
  suggestImposters, maxImposters, resolveWordList,
  dealRound, tallyVotes, resolveRound, applyScores,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.Imposter = API;
