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
  brands: { name: 'Brands', emoji: '🛍️', words: [
    'Nike', 'Apple', 'Lego', 'Ferrari', 'Gucci', 'Netflix', 'Spotify', 'Adidas',
    'Rolex', 'Tesla', 'Pixar', 'Amazon', 'Disney', 'Samsung', 'Nintendo', 'Chanel',
    'Pepsi', 'Ikea', 'Heinz', 'Google', 'Lacoste', 'Puma', 'Oreo', 'Nutella',
    'Toyota', 'Lamborghini', 'Sony', 'Uber', 'Airbnb', 'Starbucks' ] },
  emotions: { name: 'Feelings', emoji: '😶‍🌫️', words: [
    'Jealousy', 'Nostalgia', 'Boredom', 'Euphoria', 'Dread', 'Relief', 'Awe',
    'Guilt', 'Pride', 'Envy', 'Curiosity', 'Loneliness', 'Excitement', 'Panic',
    'Serenity', 'Frustration', 'Hope', 'Embarrassment', 'Gratitude', 'Suspicion',
    'Confusion', 'Contentment', 'Anticipation', 'Regret', 'Wonder', 'Anxiety',
    'Joy', 'Grief', 'Courage', 'Surprise' ] },
  mythic: { name: 'World Wonders', emoji: '🏛️', words: [
    'Colosseum', 'Stonehenge', 'Pyramids', 'Taj Mahal', 'Acropolis', 'Petra',
    'Machu Picchu', 'Eiffel Tower', 'Big Ben', 'Sphinx', 'Kremlin', 'Alhambra',
    'Pantheon', 'Sagrada', 'Versailles', 'Vatican', 'Louvre', 'Colossus',
    'Angkor', 'Parthenon', 'Pompeii', 'Atlantis', 'Babylon', 'Camelot' ] },
};

/* Pack key list, in a stable display order. */
const PACK_KEYS = Object.keys(WORD_PACKS);

/* ------------------------------------------------------------------ *
 *  Locations (Spyfall-style mode). Everyone at the table is dealt the
 *  same location plus a unique character role to play; the spy gets no
 *  location and has to deduce it from the conversation. Each location
 *  ships enough roles to cover a full table.
 * ------------------------------------------------------------------ */
const LOCATIONS = {
  casino: { name: 'Casino', emoji: '🎰', roles: ['Dealer', 'High Roller', 'Bartender', 'Security Guard', 'Cocktail Waitress', 'Pit Boss', 'Card Counter', 'Tourist', 'Cashier', 'Magician'] },
  airplane: { name: 'Airplane', emoji: '✈️', roles: ['Pilot', 'Flight Attendant', 'First-Class Passenger', 'Air Marshal', 'Nervous Flyer', 'Toddler', 'Co-Pilot', 'Tired Businessman', 'Honeymooner', 'Snoring Passenger'] },
  hospital: { name: 'Hospital', emoji: '🏥', roles: ['Surgeon', 'Nurse', 'Patient', 'Paramedic', 'Receptionist', 'Anesthetist', 'Intern', 'Worried Relative', 'Therapist', 'Cleaner'] },
  beach: { name: 'Beach', emoji: '🏖️', roles: ['Lifeguard', 'Surfer', 'Ice-Cream Vendor', 'Sunbather', 'Sandcastle Kid', 'Beach Photographer', 'Fisherman', 'Volleyball Player', 'Tourist', 'Snorkeler'] },
  school: { name: 'School', emoji: '🏫', roles: ['Teacher', 'Principal', 'Student', 'Janitor', 'Cafeteria Cook', 'Librarian', 'Coach', 'New Kid', 'Hall Monitor', 'Substitute'] },
  spaceStation: { name: 'Space Station', emoji: '🛰️', roles: ['Commander', 'Engineer', 'Scientist', 'Medic', 'Rookie Astronaut', 'Robot', 'Pilot', 'Botanist', 'Mission Control', 'Alien Stowaway'] },
  pirateShip: { name: 'Pirate Ship', emoji: '🏴‍☠️', roles: ['Captain', 'First Mate', 'Cabin Boy', 'Cook', 'Lookout', 'Gunner', 'Prisoner', 'Navigator', 'Stowaway', 'Parrot Keeper'] },
  movieSet: { name: 'Movie Set', emoji: '🎬', roles: ['Director', 'Lead Actor', 'Stunt Double', 'Makeup Artist', 'Cameraman', 'Extra', 'Producer', 'Sound Engineer', 'Caterer', 'Screenwriter'] },
  restaurant: { name: 'Restaurant', emoji: '🍽️', roles: ['Head Chef', 'Waiter', 'Food Critic', 'Sommelier', 'Dishwasher', 'Host', 'Birthday Guest', 'Picky Eater', 'Busboy', 'Manager'] },
  museum: { name: 'Museum', emoji: '🏛️', roles: ['Curator', 'Tour Guide', 'Security Guard', 'Art Thief', 'School Group', 'Restorer', 'Donor', 'Photographer', 'Cleaner', 'Lost Tourist'] },
  ski: { name: 'Ski Resort', emoji: '🎿', roles: ['Ski Instructor', 'Snowboarder', 'Lift Operator', 'Hot-Cocoa Vendor', 'Beginner', 'Rescue Patrol', 'Lodge Receptionist', 'Photographer', 'Ice Sculptor', 'Tourist'] },
  bank: { name: 'Bank', emoji: '🏦', roles: ['Teller', 'Manager', 'Customer', 'Security Guard', 'Robber', 'Loan Officer', 'Janitor', 'Armored-Truck Driver', 'Intern', 'Inspector'] },
  circus: { name: 'Circus', emoji: '🎪', roles: ['Ringmaster', 'Acrobat', 'Clown', 'Lion Tamer', 'Juggler', 'Ticket Seller', 'Trapeze Artist', 'Strongman', 'Magician', 'Popcorn Vendor'] },
  hauntedHouse: { name: 'Haunted House', emoji: '👻', roles: ['Ghost', 'Caretaker', 'Ghost Hunter', 'Lost Tourist', 'Medium', 'Skeptic', 'Butler', 'Vampire', 'Trapped Guest', 'Tour Guide'] },
  subway: { name: 'Subway', emoji: '🚇', roles: ['Driver', 'Commuter', 'Busker', 'Ticket Inspector', 'Pickpocket', 'Tourist', 'Sleeping Passenger', 'Station Cleaner', 'Lost Child', 'Rush-Hour Worker'] },
  weddingHall: { name: 'Wedding', emoji: '💒', roles: ['Bride', 'Groom', 'Best Man', 'Wedding Planner', 'Photographer', 'DJ', 'Flower Girl', 'Caterer', 'Officiant', 'Awkward Ex'] },
};
const LOCATION_KEYS = Object.keys(LOCATIONS);

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
 * Game types:
 *   'word'     — everyone shares one secret word (see modes below).
 *   'location' — Spyfall-style: everyone shares a location AND gets a unique
 *                character role to play; the imposter ("the spy") gets neither
 *                and must deduce the location. The location name is the secret
 *                the spy can name to steal, so the rest of the pipeline is shared.
 *
 * Word modes:
 *   'classic' — imposter is told they're the imposter, gets no word.
 *   'decoy'   — imposter gets a *different* word from the same pack, so they
 *               can bluff a plausible clue without knowing they're adrift.
 *
 *   `players` : array of { id, name }
 *   returns   : { gameType, secret, decoy, category, emoji, packKey, mode, order, assignments }
 *     assignments: [{ id, name, role:'crew'|'imposter', word|null, roleName?, isImposter }]
 *     order: array of player ids = clue-giving order, starting player first.
 */
function dealRound(opts) {
  const {
    players, imposterCount = 1, gameType = 'word', packKey = 'food', mode = 'classic',
    custom = null, locationKey = 'mixed', rng = Math.random,
  } = opts;

  if (!players || players.length < 3) throw new Error('Need at least 3 players');
  const imps = Math.max(1, Math.min(imposterCount, maxImposters(players.length)));

  // Who the imposters are (shared across game types).
  const ids = players.map((p) => p.id);
  const imposterIds = new Set(shuffle(ids, rng).slice(0, imps));
  const order = shuffle(ids, rng); // fresh shuffle so the same person doesn't always open

  if (gameType === 'location') {
    const loc = locationKey === 'mixed'
      ? LOCATIONS[pick(rng, LOCATION_KEYS)]
      : (LOCATIONS[locationKey] || LOCATIONS[pick(rng, LOCATION_KEYS)]);
    const secret = loc.name;
    const roles = shuffle(loc.roles, rng);
    let r = 0;
    const assignments = players.map((p) => {
      const isImposter = imposterIds.has(p.id);
      const roleName = isImposter ? 'The Spy' : roles[r++ % roles.length];
      return {
        id: p.id, name: p.name,
        role: isImposter ? 'imposter' : 'crew', isImposter,
        word: isImposter ? null : secret,
        roleName,
      };
    });
    return {
      gameType: 'location', secret, decoy: null, category: 'Location',
      emoji: loc.emoji, locationName: loc.name, packKey: locationKey, mode: 'classic',
      order, assignments,
    };
  }

  // --- word game ---
  const words = resolveWordList(packKey, custom);
  if (words.length < 2) throw new Error('Word list too small');

  const secret = pick(rng, words);
  let decoy = null;
  if (mode === 'decoy') {
    const others = words.filter((w) => w !== secret);
    decoy = others.length ? pick(rng, others) : secret;
  }

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

  const category = packKey === 'mixed'
    ? 'Mixed'
    : (custom ? 'Custom' : (WORD_PACKS[packKey] ? WORD_PACKS[packKey].name : packKey));
  const emoji = (custom || packKey === 'mixed') ? '🎲' : (WORD_PACKS[packKey] ? WORD_PACKS[packKey].emoji : '🎲');

  return { gameType: 'word', secret, decoy, category, emoji, packKey, mode, order, assignments };
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
 *  Match standings — rank players, flag the leader, and decide whether
 *  the match is won (someone has reached the target score, with a clear
 *  single leader). `players` is [{id,name}], totals is id->points.
 * ------------------------------------------------------------------ */
function standings(players, totals, target) {
  const rows = players.map((p) => ({ id: p.id, name: p.name, points: (totals && totals[p.id]) || 0 }));
  rows.sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.rank = i + 1; });
  const top = rows.length ? rows[0].points : 0;
  const leaders = rows.filter((r) => r.points === top && top > 0);
  const reached = !!target && top >= target;
  const won = reached && leaders.length === 1;
  return {
    rows,
    leader: leaders.length === 1 ? leaders[0] : null,
    mvp: rows.length && top > 0 ? rows[0] : null,
    topScore: top,
    matchWon: won,
    champion: won ? leaders[0] : null,
    tiedAtTop: reached && leaders.length > 1, // reached target but needs a decider
  };
}

/* ------------------------------------------------------------------ *
 *  Per-player stats. Fold one resolved round into a running stats map
 *  (id -> { rounds, asImposter, caught, steals, wins }). "win" = you were
 *  on the side that won the round (crew won and you're crew, or imposters
 *  won and you're an imposter). Pure — feed it dealRound()+resolveRound().
 * ------------------------------------------------------------------ */
function blankStat() { return { rounds: 0, asImposter: 0, caught: 0, steals: 0, wins: 0 }; }

function applyRoundStats(stats, assignments, res) {
  const out = Object.assign({}, stats);
  const impWon = res.outcome === 'imposter';
  for (const a of assignments) {
    const s = Object.assign(blankStat(), out[a.id]);
    s.rounds += 1;
    if (a.isImposter) {
      s.asImposter += 1;
      if (res.caughtImposter) s.caught += 1;     // an imposter was unmasked this round
      if (res.stolen) s.steals += 1;             // and stole it back
      if (impWon) s.wins += 1;
    } else if (!impWon) {
      s.wins += 1;                               // crew member on a crew win
    }
    out[a.id] = s;
  }
  return out;
}

/* Derived headline rate for a single player's stat row (0..1, or null if n/a). */
function winRate(stat) {
  if (!stat || !stat.rounds) return null;
  return stat.wins / stat.rounds;
}

/* ------------------------------------------------------------------ *
 *  Exports — works under Node (vm/CommonJS) and as a browser global.
 * ------------------------------------------------------------------ */
const API = {
  WORD_PACKS, PACK_KEYS, LOCATIONS, LOCATION_KEYS, SCORE,
  mulberry32, shuffle, pick, randInt,
  suggestImposters, maxImposters, resolveWordList,
  dealRound, tallyVotes, resolveRound, applyScores,
  standings, applyRoundStats, blankStat, winRate,
};

if (typeof module !== 'undefined' && module.exports) module.exports = API;
if (typeof window !== 'undefined') window.Imposter = API;
