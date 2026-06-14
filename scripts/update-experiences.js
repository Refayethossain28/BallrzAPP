#!/usr/bin/env node
/**
 * Weekly Experiences Updater
 * Runs every Monday via GitHub Actions. Picks 8 seasonally-relevant
 * London luxury experiences for the current week and patches EXPERIENCES
 * in apexvip-client.html.
 */

const fs   = require('fs');
const path = require('path');

// ── Full-year experience calendar ─────────────────────────────────────────
// Each entry: months[] = months it's relevant (1-12), optional week[] for
// finer targeting (1-4 = week of month). Priority drives tie-breaking.
const CALENDAR = [

  // ── JANUARY ───────────────────────────────────────────────────────────
  {id:'jan1',name:'London Restaurant Week',type:'Dining',emoji:'🍽',
   tagline:'Prix-fixe at 200+ restaurants · Jan',
   desc:"London's biggest dining event: prix-fixe menus at over 200 of the city's finest restaurants. ApexVIP lines up the table, the car, and the sommelier recommendation.",
   price:95,car:110,slots:['18:30','19:00','20:00'],guests:'up to 4',
   tags:['Dining','Season','Value'],months:[1],priority:10},

  {id:'jan2',name:'Frieze Masters Opening',type:'Culture',emoji:'🖼',
   tagline:'Private view · Regent\'s Park',
   desc:'VIP access to the private view of Frieze Masters — five millennia of art under one roof in Regent\'s Park. Champagne on arrival, gallery specialist briefing, car throughout.',
   price:0,car:120,slots:['17:00','18:00'],guests:'up to 4',
   tags:['Art','Private','Culture'],months:[1,10],priority:8},

  {id:'jan3',name:'Burns Night Supper',type:'Dining',emoji:'🏴󠁧󠁢󠁳󠁣󠁴󠁿',
   tagline:'25 January · traditional Scottish dinner',
   desc:'An authentic Burns Night supper at a private Mayfair dining room. Haggis, neeps and tatties, whisky flights from a curated selection, and the Address to a Haggis performed tableside.',
   price:210,car:120,slots:['19:00','19:30'],guests:'up to 8',
   tags:['Dining','Culture','Seasonal'],months:[1],priority:9},

  // ── FEBRUARY ──────────────────────────────────────────────────────────
  {id:'feb1',name:"Valentine's at The Savoy",type:'Dining',emoji:'🌹',
   tagline:'Thames-view dining · February 14',
   desc:"A reserved window table at The Savoy's Thames Foyer for Valentine's Day. Seven-course tasting menu, rose on arrival, and your car waiting beneath the art deco canopy.",
   price:380,car:130,slots:['19:00','19:30'],guests:'up to 2',
   tags:['Romance','Seasonal','Michelin'],months:[2],priority:10},

  {id:'feb2',name:'BAFTA Film Awards Evening',type:'Events',emoji:'🎬',
   tagline:'Red carpet access · Royal Festival Hall',
   desc:'VIP entry to the BAFTA Film Awards at the Royal Festival Hall. Champagne reception, reserved seats in the ceremony, and front-of-house car for the evening.',
   price:850,car:150,slots:['17:00','17:30'],guests:'up to 4',
   tags:['Awards','Exclusive','Evening'],months:[2],priority:9},

  // ── MARCH ─────────────────────────────────────────────────────────────
  {id:'mar1',name:'Cheltenham Gold Cup',type:'Events',emoji:'🐎',
   tagline:'Gold Cup day · Cheltenham Festival',
   desc:"The greatest jump racing day on the calendar. ApexVIP arranges hospitality in the Champion's Club, car to Cheltenham, and a table for the Gold Cup raceday luncheon.",
   price:620,car:200,slots:['09:30','10:00'],guests:'up to 4',
   tags:['Racing','Season','Classic'],months:[3],priority:10},

  {id:'mar2',name:'Tate Modern: Special Exhibition',type:'Culture',emoji:'🖼',
   tagline:'Private after-hours viewing',
   desc:'Exclusive access to the current Tate Modern major exhibition after public hours close, with a dedicated curator. Fully private, champagne, car waits on Bankside.',
   price:320,car:130,slots:['19:30','20:00'],guests:'up to 6',
   tags:['Art','Private','Culture'],months:[3,4,5,6,7,8,9,10,11],priority:5},

  // ── APRIL ─────────────────────────────────────────────────────────────
  {id:'apr1',name:'London Marathon VIP',type:'Events',emoji:'🏃',
   tagline:'Elite start · corporate enclosure · April',
   desc:'A premier vantage point at the London Marathon: corporate enclosure on the Embankment, elite-start access, and a post-race private dinner. Car navigates you ahead of road closures.',
   price:480,car:130,slots:['08:00','08:30'],guests:'up to 6',
   tags:['Sport','Season','Exclusive'],months:[4],priority:9},

  {id:'apr2',name:'Chelsea Physic Garden Evening',type:'Culture',emoji:'🌿',
   tagline:'Private evening · oldest botanic garden',
   desc:"A private evening in London's oldest botanic garden, opened exclusively after hours. Guided walk with the head botanist, a garden supper, and candlelit cocktails on the lawn.",
   price:290,car:110,slots:['18:30','19:00'],guests:'up to 8',
   tags:['Culture','Private','Garden'],months:[4,5,6],priority:7},

  // ── MAY ───────────────────────────────────────────────────────────────
  {id:'may1',name:'Chelsea Flower Show',type:'Events',emoji:'🌸',
   tagline:'RHS · Gala Preview Evening',
   desc:"The world's greatest flower show. ApexVIP secures tickets for the RHS Gala Preview Evening — when the show is at its freshest and the crowds are at their most exclusive.",
   price:340,car:120,slots:['17:30','18:00'],guests:'up to 4',
   tags:['Garden','Season','Classic'],months:[5],priority:10},

  {id:'may2',name:'Royal Windsor Horse Show',type:'Events',emoji:'🏇',
   tagline:'Windsor · Royal Family attendance',
   desc:'Five days of premier equestrian sport in the private grounds of Windsor Castle, often attended by the Royal Family. VIP enclosure, car to Windsor, private picnic arranged.',
   price:380,car:180,slots:['10:00','10:30'],guests:'up to 4',
   tags:['Royal','Season','Classic'],months:[5],priority:9},

  // ── JUNE ──────────────────────────────────────────────────────────────
  {id:'jun1',name:'Royal Ascot 2026',type:'Events',emoji:'🎩',
   tagline:'Royal Enclosure · June 16–20',
   desc:'The pinnacle of the British racing calendar. ApexVIP arranges Royal Enclosure badges, car to the course, and a reserved table at the Parade Ring restaurant. Dress code briefing and return journey included.',
   price:680,car:160,slots:['09:30','10:00','10:30'],guests:'up to 4',
   tags:['Racing','Season','Exclusive'],months:[6],priority:10},

  {id:'jun2',name:'Trooping the Colour',type:'Culture',emoji:'👑',
   tagline:'Horse Guards Parade · Royal Procession',
   desc:"A grandstand seat for the King's Birthday Parade on Horse Guards Parade. Watch the Household Division's full-dress ceremony and the RAF flypast, car via St James's.",
   price:290,car:120,slots:['09:00','09:30'],guests:'up to 4',
   tags:['Royal','Culture','Season'],months:[6],priority:9},

  {id:'jun3',name:'Glyndebourne Opera',type:'Culture',emoji:'🎭',
   tagline:'Evening performance · long interval picnic',
   desc:'A full evening at Glyndebourne Festival Opera in the Sussex Downs. During the long interval, a private Fortnum & Mason hamper awaits on the lawn. Evening dress, car throughout.',
   price:420,car:200,slots:['16:00','16:30'],guests:'up to 4',
   tags:['Opera','Evening','Classic'],months:[6,7,8],priority:8},

  // ── JULY ──────────────────────────────────────────────────────────────
  {id:'jul1',name:'Wimbledon Centre Court',type:'Events',emoji:'🎾',
   tagline:'Centre Court · Debenture seats',
   desc:"Premium debenture seats for the world's most prestigious tennis tournament. Strawberries and cream in the Debenture holders lounge. Car on standby at Gate 3.",
   price:1200,car:160,slots:['11:00','13:00'],guests:'up to 2',
   tags:['Sport','Season','Exclusive'],months:[7],priority:10},

  {id:'jul2',name:'Henley Royal Regatta',type:'Events',emoji:'⛵',
   tagline:"Stewards' Enclosure · July 1–5",
   desc:"Five days of world-class rowing on the Thames. ApexVIP secures Stewards' Enclosure badges, a private riverside hospitality tent, and car on call throughout.",
   price:580,car:180,slots:['10:00','10:30','11:00'],guests:'up to 4',
   tags:['Regatta','Season','Classic'],months:[7],priority:9},

  {id:'jul3',name:'Goodwood Festival of Speed',type:'Events',emoji:'🏎',
   tagline:'Motorsport · Goodwood House · July',
   desc:'The world\'s greatest motoring garden party at Goodwood House. Exclusive paddock access, lunch at Goodwood House, and your car to West Sussex and back.',
   price:520,car:200,slots:['09:00','09:30'],guests:'up to 4',
   tags:['Motorsport','Season','Exclusive'],months:[7],priority:8},

  // ── AUGUST ────────────────────────────────────────────────────────────
  {id:'aug1',name:'BBC Proms at the Royal Albert Hall',type:'Culture',emoji:'🎻',
   tagline:'Arena stalls · Last Night experience',
   desc:'Premium Arena stalls seats for the BBC Proms. ApexVIP can arrange Last Night tickets and a pre-concert dinner at a nearby Michelin restaurant. Car via Kensington.',
   price:180,car:120,slots:['18:30','19:00'],guests:'up to 4',
   tags:['Music','Culture','Classic'],months:[7,8,9],priority:7},

  {id:'aug2',name:'Notting Hill Carnival VIP',type:'Events',emoji:'🎺',
   tagline:'Rooftop view · private terrace · August',
   desc:'A private rooftop terrace above the Notting Hill Carnival route. Champagne, Caribbean canapés, and the best view of the sound systems and floats. Car navigates you in and out ahead of crowds.',
   price:350,car:140,slots:['12:00','13:00'],guests:'up to 8',
   tags:['Music','Culture','Seasonal'],months:[8],priority:9},

  // ── SEPTEMBER ─────────────────────────────────────────────────────────
  {id:'sep1',name:'Frieze London 2026',type:'Culture',emoji:'🖼',
   tagline:'VIP preview · Regent\'s Park',
   desc:'VIP-day access to Frieze London — the world\'s most significant contemporary art fair. Gallery specialist briefing, champagne, and car to Regent\'s Park and back.',
   price:0,car:120,slots:['10:00','11:00'],guests:'up to 4',
   tags:['Art','Culture','Exclusive'],months:[9,10],priority:10},

  {id:'sep2',name:'London Fashion Week',type:'Lifestyle',emoji:'👗',
   tagline:'Front-row access · September',
   desc:"Front-row seats at a selection of London Fashion Week's most talked-about shows. Your stylist brief, car between venues, and post-show dinner at a Mayfair table we'll hold.",
   price:0,car:150,slots:['10:00','12:00','15:00'],guests:'up to 2',
   tags:['Fashion','Culture','Exclusive'],months:[2,9],priority:8},

  // ── OCTOBER ───────────────────────────────────────────────────────────
  {id:'oct1',name:"Christie's Autumn Sale",type:'Culture',emoji:'🏛',
   tagline:'VIP preview evening · King Street',
   desc:"Private evening access to Christie's Impressionist and Modern Art autumn auction preview. View the lots before anyone else, guided by a specialist. Car to King Street.",
   price:0,car:120,slots:['18:00','18:30'],guests:'up to 4',
   tags:['Art','Evening','Private'],months:[10],priority:9},

  {id:'oct2',name:'Bonfire Night River Thames',type:'Events',emoji:'🎆',
   tagline:'Private barge · fireworks · November 5',
   desc:'Watch the fireworks from a private hired barge on the Thames. Champagne, hot food, and the best view in London as the sky lights up above Vauxhall Bridge.',
   price:420,car:130,slots:['18:30','19:00'],guests:'up to 12',
   tags:['Seasonal','Evening','Exclusive'],months:[10,11],priority:8},

  // ── NOVEMBER ──────────────────────────────────────────────────────────
  {id:'nov1',name:'Christmas Lights Turn-On',type:'Events',emoji:'🎄',
   tagline:'Bond Street · Carnaby · Oxford Street',
   desc:'Be there for the iconic switching-on of the West End Christmas lights. ApexVIP arranges front-row standing with a private warm-up dinner beforehand and car throughout the evening.',
   price:0,car:120,slots:['17:00','17:30'],guests:'up to 4',
   tags:['Seasonal','Evening','Classic'],months:[11],priority:9},

  {id:'nov2',name:"Claridge's Christmas Tree",type:'Dining',emoji:'🌲',
   tagline:'Afternoon tea · festive setting',
   desc:"The annual unveiling of Claridge's Christmas tree — the most photographed in London. Festive afternoon tea in the Art Deco foyer, champagne, and your car waiting under the canopy.",
   price:195,car:120,slots:['14:00','15:30','16:30'],guests:'up to 4',
   tags:['Festive','Dining','Classic'],months:[11,12],priority:8},

  // ── DECEMBER ──────────────────────────────────────────────────────────
  {id:'dec1',name:'Royal Opera House: The Nutcracker',type:'Culture',emoji:'🩰',
   tagline:'Grand Tier boxes · Royal Ballet',
   desc:"The Royal Ballet's Nutcracker at the Royal Opera House — London's most magical Christmas tradition. Grand Tier box seats, champagne interval, car to Covent Garden.",
   price:380,car:130,slots:['18:30','19:00'],guests:'up to 4',
   tags:['Ballet','Festive','Classic'],months:[12],priority:10},

  {id:'dec2',name:"New Year's Eve River",type:'Events',emoji:'🎉',
   tagline:'Private venue · Thames fireworks',
   desc:"The best fireworks in the world, seen from a private venue above the Thames. Champagne, dinner, countdown. ApexVIP handles the car before and after — and the tickets.",
   price:980,car:150,slots:['19:00','20:00'],guests:'up to 4',
   tags:['NYE','Festive','Exclusive'],months:[12],priority:9},

  // ── YEAR-ROUND ────────────────────────────────────────────────────────
  {id:'yr1',name:'Ikoyi London',type:'Dining',emoji:'🍽',
   tagline:'Two Michelin stars · West African tasting',
   desc:"Jeremy Chan's extraordinary two Michelin-starred tasting menu — West African spices and the finest seasonal British produce in precise, beautiful courses. One of London's most coveted reservations.",
   price:340,car:120,slots:['18:30','19:00','20:30'],guests:'up to 4',
   tags:['Michelin','Tasting','Exclusive'],months:[1,2,3,4,5,6,7,8,9,10,11,12],priority:6},

  {id:'yr2',name:'The Ledbury',type:'Dining',emoji:'🥂',
   tagline:'Two Michelin stars · Notting Hill',
   desc:"Brett Graham's legendary restaurant in Notting Hill. The seasonal tasting menu with wine pairings by the sommelier. Among the most acclaimed dining rooms in Europe.",
   price:310,car:110,slots:['18:00','19:00','20:30'],guests:'up to 4',
   tags:['Michelin','Classic','Tasting'],months:[1,2,3,4,5,6,7,8,9,10,11,12],priority:6},

  {id:'yr3',name:"Annabel's",type:'Events',emoji:'✨',
   tagline:'Berkeley Square · members club',
   desc:"Priority access and a reserved table at Annabel's, Mayfair's most celebrated private members club. Live entertainment, exceptional cocktails, your driver waits in Berkeley Square.",
   price:220,car:120,slots:['19:30','20:00','21:30'],guests:'up to 4',
   tags:['Nightlife','Exclusive','Classic'],months:[1,2,3,4,5,6,7,8,9,10,11,12],priority:4},

  {id:'yr4',name:'Harrods Private Shopping',type:'Lifestyle',emoji:'🛍',
   tagline:'Before-hours · personal stylist',
   desc:'A dedicated personal stylist, champagne on arrival, and the store entirely to yourself before public opening. Harrods at its most exclusive — purchases delivered to your car.',
   price:0,car:180,slots:['08:00','08:30'],guests:'up to 2',
   tags:['Shopping','Morning','Private'],months:[1,2,3,4,5,6,7,8,9,10,11,12],priority:4},

  {id:'yr5',name:'Kensington Palace Tour',type:'Culture',emoji:'🏰',
   tagline:'Private morning · State Rooms & gardens',
   desc:'A private guided walk through the State Rooms and Kensington Gardens before the public arrives. Reserved breakfast in the Orangery, car collects from your door.',
   price:250,car:100,slots:['08:30','09:00'],guests:'up to 6',
   tags:['Culture','Morning','Private'],months:[4,5,6,7,8,9,10],priority:5},

  {id:'yr6',name:'Nobu London',type:'Dining',emoji:'🍣',
   tagline:"Chef's omakase · Park Lane",
   desc:"The chef's omakase at Nobu Park Lane. Twelve courses of Matsuhisa's celebrated Japanese-Peruvian cuisine with optional sake pairing. A chauffeur return included.",
   price:280,car:140,slots:['18:00','19:30','21:00'],guests:'up to 4',
   tags:['Dining','Omakase','Exclusive'],months:[1,2,3,4,5,6,7,8,9,10,11,12],priority:4},
];

// ── Selector logic ────────────────────────────────────────────────────────
function pick(date) {
  const m = date.getMonth() + 1; // 1-12

  // Score each experience: +10 if current month matches, +priority, prefer seasonal over year-round
  const scored = CALENDAR.map(x => {
    const inMonth = x.months.includes(m);
    // Also include next month's highlights so upcoming events appear
    const inNext  = x.months.includes(m === 12 ? 1 : m + 1);
    if (!inMonth && !inNext) return null;
    const score = (inMonth ? 10 : 3) + (x.priority || 5);
    return { ...x, _score: score };
  }).filter(Boolean);

  // Sort by score desc, pick top 8, deduplicate by id
  scored.sort((a, b) => b._score - a._score);
  const seen = new Set();
  const picked = [];
  for (const x of scored) {
    if (!seen.has(x.id)) { seen.add(x.id); picked.push(x); }
    if (picked.length === 8) break;
  }
  return picked;
}

// ── Serialise to JS literal ───────────────────────────────────────────────
function serialise(arr) {
  const lines = arr.map(x => {
    const tags  = JSON.stringify(x.tags);
    const slots = JSON.stringify(x.slots);
    const months= JSON.stringify(x.months);
    const desc  = x.desc.replace(/'/g, "\\'");
    const name  = x.name.replace(/'/g, "\\'");
    const tl    = x.tagline.replace(/'/g, "\\'");
    return `  {id:'${x.id}',name:'${name}',type:'${x.type}',emoji:'${x.emoji}',tagline:'${tl}',desc:'${desc}',price:${x.price},car:${x.car},slots:${slots},guests:'${x.guests}',tags:${tags},months:${months},priority:${x.priority||5}}`;
  });
  return `const EXPERIENCES = [\n${lines.join(',\n')},\n];`;
}

// ── Patch the HTML file ───────────────────────────────────────────────────
const htmlPath = path.join(__dirname, '..', 'apexvip-client.html');
let html = fs.readFileSync(htmlPath, 'utf8');

const picked     = pick(new Date());
const newBlock   = serialise(picked);
const replaced   = html.replace(/const EXPERIENCES = \[[\s\S]*?\];/, newBlock);

if (replaced === html) {
  console.error('ERROR: Could not find EXPERIENCES block to replace');
  process.exit(1);
}

fs.writeFileSync(htmlPath, replaced, 'utf8');

const month = new Date().toLocaleString('en-GB', { month: 'long', year: 'numeric' });
console.log(`✓ Updated EXPERIENCES for ${month} — ${picked.length} experiences written:`);
picked.forEach(x => console.log(`  • ${x.name} (${x.type})`));
