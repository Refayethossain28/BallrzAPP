// Lifeline — emergency reference data.
// Guidance is aligned with widely published first-aid standards (ERC / Red Cross / NHS
// public guidance). It is an aid for untrained bystanders, not a substitute for
// professional training or emergency services.

export const GUIDES = [
  {
    id: "cpr-adult",
    title: "CPR — Adult",
    icon: "❤️",
    urgent: true,
    summary: "Hands-only CPR for an unresponsive adult who is not breathing normally.",
    callFirst: true,
    steps: [
      "Check for danger to yourself first. You cannot help if you become a casualty.",
      "Shake the person's shoulders and shout. If there is no response, shout for help.",
      "Call your local emergency number now, or tell a specific person to call. Put the phone on speaker.",
      "Tilt their head back gently and look, listen and feel for normal breathing for no more than 10 seconds. Gasping is NOT normal breathing.",
      "If they are not breathing normally, kneel beside them and place the heel of one hand on the centre of the chest, with your other hand on top, fingers interlocked.",
      "With straight arms, press hard and fast: push down 5–6 cm (about 2 inches), 100–120 times per minute — the beat of \"Stayin' Alive\".",
      "Let the chest come fully back up between compressions. Do not stop.",
      "If an AED (defibrillator) arrives, turn it on and follow its voice instructions. It will not shock someone who does not need it.",
      "Keep going until emergency responders take over, the person starts breathing normally, or you are physically unable to continue. Swap with another person every 2 minutes if you can."
    ]
  },
  {
    id: "cpr-child",
    title: "CPR — Child & Baby",
    icon: "🧒",
    urgent: true,
    summary: "CPR for children (1 year to puberty) and babies (under 1 year).",
    callFirst: true,
    steps: [
      "Check response: call their name, tap the sole of a baby's foot or a child's shoulder. If no response, shout for help.",
      "Open the airway: tilt the head back gently. For a baby, use a neutral position — do not over-tilt.",
      "Check breathing for no more than 10 seconds. If not breathing normally, act now.",
      "Give 5 gentle rescue breaths: seal your mouth over the child's mouth (mouth AND nose for a baby) and breathe steadily for about 1 second each, watching the chest rise.",
      "Give 30 chest compressions: push down one third of the chest depth, 100–120 per minute. Use one hand for a child, two fingers in the centre of the chest for a baby.",
      "Give 2 more rescue breaths, then continue cycles of 30 compressions and 2 breaths.",
      "If you are alone, do 1 minute of CPR BEFORE stopping to call the emergency number, then continue.",
      "Keep going until help takes over, the child starts breathing normally, or you cannot continue."
    ]
  },
  {
    id: "choking-adult",
    title: "Choking — Adult & Child",
    icon: "🫁",
    urgent: true,
    summary: "When someone cannot breathe, cough or speak because something is stuck.",
    callFirst: false,
    steps: [
      "Ask: \"Are you choking?\" If they can cough or speak, encourage them to keep coughing — do nothing else yet.",
      "If they cannot cough, speak or breathe: stand behind and slightly to the side of them. Support their chest with one hand and lean them well forward.",
      "Give up to 5 sharp back blows between the shoulder blades with the heel of your hand. Check after each one whether the object has cleared.",
      "If back blows fail, give up to 5 abdominal thrusts: stand behind them, put a clenched fist between the navel and the ribcage, grasp it with your other hand, and pull sharply inwards and upwards.",
      "Keep alternating 5 back blows and 5 abdominal thrusts.",
      "If the blockage has not cleared after 3 cycles, call the emergency number — keep alternating while you wait.",
      "If they become unresponsive, lower them to the ground and start CPR immediately.",
      "Anyone who received abdominal thrusts should be checked by a doctor afterwards, even if they seem fine."
    ]
  },
  {
    id: "choking-baby",
    title: "Choking — Baby (under 1)",
    icon: "👶",
    urgent: true,
    summary: "A baby who cannot cry, cough or breathe.",
    callFirst: false,
    steps: [
      "If the baby is coughing effectively, let them cough. Do not put your fingers in their mouth to search for the object.",
      "If the baby cannot cry, cough or breathe: lay them face down along your forearm, head lower than their bottom, supporting the head at the jaw.",
      "Give up to 5 firm back blows between the shoulder blades with the heel of your hand.",
      "Check the mouth. Remove any object you can SEE. Never sweep blindly.",
      "If not cleared: turn the baby face up along your arm, head low. Give up to 5 chest thrusts — push sharply with two fingers on the centre of the chest. Do NOT use abdominal thrusts on a baby.",
      "Keep alternating 5 back blows and 5 chest thrusts.",
      "If not cleared after 3 cycles, call the emergency number and continue while you wait.",
      "If the baby becomes unresponsive, start baby CPR immediately."
    ]
  },
  {
    id: "severe-bleeding",
    title: "Severe Bleeding",
    icon: "🩸",
    urgent: true,
    summary: "Blood that is spurting, pooling, or will not stop.",
    callFirst: true,
    steps: [
      "Call the emergency number, or tell someone specific to call.",
      "Put pressure directly on the wound with a clean cloth, dressing or clothing. Press hard and do not let go.",
      "If something is embedded in the wound, do NOT pull it out — press firmly around it instead.",
      "Help the person lie down. If the wound is on a limb and nothing is embedded, raising the limb can help.",
      "If blood soaks through, add more material on top — do not remove the soaked layer.",
      "Keep the person warm with a coat or blanket and keep talking to them.",
      "If a limb wound is life-threatening and pressure is not working, a tourniquet applied 5–7 cm above the wound (never on a joint) can save a life. Note the time it was applied.",
      "Watch for shock: pale, cold, sweaty skin, fast breathing, confusion. Keep them lying down and warm until help arrives."
    ]
  },
  {
    id: "recovery-position",
    title: "Recovery Position",
    icon: "🛌",
    urgent: false,
    summary: "For someone unresponsive but breathing normally.",
    callFirst: true,
    steps: [
      "Confirm they are breathing normally. If not, start CPR instead.",
      "Kneel beside them. Straighten their legs and place the arm nearest you at a right angle to their body, palm up.",
      "Bring their far arm across the chest and hold the back of their hand against the cheek nearest you.",
      "With your other hand, pull up the far knee so the foot is flat on the ground.",
      "Keeping their hand against their cheek, pull on the far knee to roll them towards you onto their side.",
      "Tilt the head back gently so the airway stays open. Adjust the top leg so hip and knee are bent at right angles.",
      "Call the emergency number if you haven't already.",
      "Check breathing regularly. If it stops, roll them onto their back and start CPR. If they must stay in the position more than 30 minutes, roll them to the other side."
    ]
  },
  {
    id: "heart-attack",
    title: "Heart Attack",
    icon: "💔",
    urgent: true,
    summary: "Chest pain or pressure, possibly spreading to arm, jaw or back; sweating; breathlessness.",
    callFirst: true,
    steps: [
      "Call the emergency number immediately. Do not drive them yourself unless there is no other way.",
      "Help them sit down and rest — on the floor, knees bent, head and shoulders supported is ideal.",
      "Loosen tight clothing.",
      "If they are not allergic to aspirin and it is available, have them slowly CHEW one adult aspirin (300 mg).",
      "If they have their own heart medication such as a GTN spray, help them take it.",
      "Keep them calm and still. Reassure them until help arrives.",
      "If they become unresponsive and stop breathing normally, start CPR immediately."
    ]
  },
  {
    id: "stroke",
    title: "Stroke — FAST",
    icon: "🧠",
    urgent: true,
    summary: "Think FAST: Face, Arms, Speech, Time. A stroke is always an emergency.",
    callFirst: true,
    steps: [
      "FACE: ask them to smile. Does one side of the face droop?",
      "ARMS: ask them to raise both arms. Does one drift downwards or fail to lift?",
      "SPEECH: ask them to repeat a simple sentence. Is it slurred, jumbled, or missing?",
      "TIME: if you see ANY of these signs, call the emergency number immediately — treatment works best in the first hours.",
      "Note the exact time symptoms started. Responders and doctors will ask.",
      "Keep them comfortable, ideally lying with head and shoulders slightly raised. Do not give food, drink or medicine.",
      "If they become unresponsive but are breathing, put them in the recovery position.",
      "Symptoms that pass quickly still mean an emergency call — a mini-stroke often precedes a major one."
    ]
  },
  {
    id: "burns",
    title: "Burns & Scalds",
    icon: "🔥",
    urgent: false,
    summary: "Heat, scald, electrical or chemical burns.",
    callFirst: false,
    steps: [
      "Stop the burning: move the person away from the source. For chemical burns, brush off dry chemical first and avoid touching it yourself.",
      "Cool the burn under cool RUNNING water for at least 20 minutes. This works even if started up to 3 hours after the burn. Never use ice, butter or creams.",
      "While cooling, gently remove jewellery and loose clothing near the burn — but do not pull off anything stuck to the skin.",
      "Keep the person warm overall (blanket around unburned areas) — cooling a large burn can cause hypothermia, especially in children.",
      "After cooling, cover the burn loosely with cling film laid lengthways, or a clean plastic bag on a hand or foot. Do not wrap tightly.",
      "Do not burst blisters.",
      "Call the emergency number for: burns to the face, hands, feet, genitals or airway; burns larger than the person's hand; deep, white or charred burns; all electrical and chemical burns; burns in babies and young children.",
      "For electrical burns, make sure the power source is OFF before touching the person."
    ]
  },
  {
    id: "seizure",
    title: "Seizure",
    icon: "⚡",
    urgent: false,
    summary: "Convulsions, stiffening, or loss of awareness.",
    callFirst: false,
    steps: [
      "Stay calm and start timing the seizure.",
      "Protect them from injury: move furniture and hard objects away. Cushion their head with something soft.",
      "Do NOT restrain them and do NOT put anything in their mouth. They cannot swallow their tongue.",
      "Loosen anything tight around the neck. Remove glasses.",
      "When the jerking stops, roll them into the recovery position and check breathing.",
      "Stay with them as they recover. They may be confused for a while — reassure them quietly.",
      "Call the emergency number if: the seizure lasts more than 5 minutes, a second seizure follows, it is their first ever seizure, they are injured, pregnant or diabetic, or they do not wake fully.",
      "Do not give food or drink until they are fully alert."
    ]
  },
  {
    id: "anaphylaxis",
    title: "Severe Allergic Reaction",
    icon: "🐝",
    urgent: true,
    summary: "Anaphylaxis: swelling of face or throat, difficulty breathing, rash, collapse.",
    callFirst: true,
    steps: [
      "Call the emergency number immediately and say it is anaphylaxis.",
      "If they carry an adrenaline auto-injector (EpiPen, Jext, Auvi-Q), use it NOW: press the tip firmly against the outer mid-thigh (through clothes is fine) and hold as directed, usually 3–10 seconds.",
      "Note the time the injector was used.",
      "Lie them flat and raise their legs. If breathing is difficult, let them sit up; if pregnant, lie them on their left side. Do NOT let them stand or walk, even if they feel better.",
      "Remove the trigger if possible — for example, a stinger (scrape it off sideways, don't squeeze).",
      "If there is no improvement after 5 minutes and a second injector is available, use it.",
      "If they become unresponsive and are not breathing normally, start CPR.",
      "They must go to hospital even if they recover — a second wave of reaction can occur hours later."
    ]
  },
  {
    id: "hypothermia",
    title: "Hypothermia",
    icon: "🥶",
    urgent: false,
    summary: "Dangerously low body temperature: shivering, slurred speech, drowsiness, confusion.",
    callFirst: false,
    steps: [
      "Get them somewhere warm and dry, or shelter them from wind and rain.",
      "Handle them gently and keep them horizontal if possible — rough movement can strain a cold heart.",
      "Remove wet clothing and wrap them in dry blankets or coats, covering the head but not the face.",
      "Warm them gradually with blankets and your own body heat. Do NOT use hot water bottles directly on skin, hot baths, or rub their limbs — rapid re-warming is dangerous.",
      "If they are fully alert, give warm, sweet drinks. Never give alcohol.",
      "Call the emergency number if they are confused, drowsy, have stopped shivering while still cold, or are a baby or elderly person.",
      "If they become unresponsive, check breathing for up to 10 seconds — a very cold body breathes slowly. If not breathing normally, start CPR."
    ]
  },
  {
    id: "heatstroke",
    title: "Heat Exhaustion & Heatstroke",
    icon: "🥵",
    urgent: false,
    summary: "Overheating: from heavy sweating and weakness to hot skin and confusion.",
    callFirst: false,
    steps: [
      "Move them to a cool, shaded place and have them lie down with legs slightly raised.",
      "Remove excess clothing.",
      "Cool them actively: spray or sponge with cool water and fan them. Cold packs in the armpits, on the neck and groin help.",
      "If they are fully alert, give sips of cool water or a sports drink.",
      "They should start to improve within 30 minutes of cooling.",
      "Call the emergency number if: they become confused, clumsy or agitated; their skin is hot and dry; they have a seizure; they lose consciousness; or they do not improve within 30 minutes. This is heatstroke — a life-threatening emergency.",
      "While waiting for help, keep cooling aggressively: the fastest safe cooling you can achieve saves lives. Immersion in cool water is best for young, healthy people.",
      "If they become unresponsive but breathe normally, use the recovery position and keep cooling."
    ]
  },
  {
    id: "poisoning",
    title: "Poisoning & Overdose",
    icon: "☠️",
    urgent: true,
    summary: "Swallowed chemicals, medicines, plants, or suspected overdose.",
    callFirst: true,
    steps: [
      "Call the emergency number or your local poison control centre immediately — even if there are no symptoms yet.",
      "Do NOT make them vomit, and do not give anything to eat or drink unless a professional tells you to.",
      "Find out what was taken, how much, and when. Keep the container, packet or a sample of the plant to show responders.",
      "If chemical is on skin or clothes, remove contaminated clothing (protect your own hands) and rinse skin with running water for 20 minutes.",
      "If chemical is in the eye, rinse the open eye continuously with gently running water for at least 15 minutes.",
      "If they are drowsy or unresponsive but breathing, put them in the recovery position and monitor their breathing constantly.",
      "If they stop breathing normally, start CPR. Use a face shield or cloth barrier if poison may be around the mouth.",
      "If an opioid overdose is suspected and naloxone (Narcan) is available, use it and still call emergency services."
    ]
  },
  {
    id: "fracture",
    title: "Broken Bones & Sprains",
    icon: "🦴",
    urgent: false,
    summary: "Suspected fracture, dislocation or bad sprain.",
    callFirst: false,
    steps: [
      "Keep the injured part still. Do NOT try to straighten it or push a protruding bone back in.",
      "Support the injury in the position found — with hands, cushions, rolled clothing, or a sling for an arm.",
      "Put a cold pack wrapped in cloth on the area for up to 20 minutes to limit swelling. Not directly on skin.",
      "If there is a wound over the break, cover it with a clean dressing and press around — not on — any protruding bone.",
      "Remove rings and watches near the injury before swelling starts.",
      "Call the emergency number for: a suspected broken leg, hip, pelvis, back or neck (do NOT move them); a bone through the skin; a limb that is cold, blue or numb below the injury.",
      "For a suspected broken arm, wrist or collarbone, you can usually take them to hospital yourself once the arm is supported.",
      "For sprains, remember RICE: Rest, Ice, Compression, Elevation — and get it checked if they cannot bear weight."
    ]
  },
  {
    id: "head-injury",
    title: "Head Injury",
    icon: "🤕",
    urgent: false,
    summary: "A blow to the head — from a bump to a serious injury.",
    callFirst: false,
    steps: [
      "Sit them down and hold a cold pack wrapped in cloth against the injury for up to 20 minutes.",
      "Treat any scalp wound with firm, direct pressure using a clean dressing.",
      "Watch them closely for the next 24–48 hours. Do not leave someone with a significant head injury alone for the first few hours.",
      "Call the emergency number NOW if they: were knocked out, are confused or drowsy, vomit more than once, have a seizure, have unequal pupils, have clear fluid or blood from the ear or nose, cannot remember events, or their condition worsens.",
      "Suspect a neck injury after falls from height, diving or vehicle crashes: keep the head still and do NOT move them unless they are in danger or stop breathing.",
      "If they become unresponsive but breathe normally, put them in the recovery position, keeping the head and neck aligned as you roll them.",
      "No alcohol, no sleeping tablets, and no driving until fully recovered.",
      "It is fine to let them sleep, but wake and check a child or an at-risk person a few times in the first hours."
    ]
  },
  {
    id: "drowning",
    title: "Drowning",
    icon: "🌊",
    urgent: true,
    summary: "Someone pulled from the water who is unresponsive or struggling.",
    callFirst: true,
    steps: [
      "Do not become a second casualty: reach or throw something that floats before you consider entering the water. Call the emergency number.",
      "Once out of the water, check response and breathing.",
      "If they are NOT breathing normally: give 5 rescue breaths first, then start CPR — 30 compressions, 2 breaths. Drowning CPR starts with breaths.",
      "If an AED arrives, dry the chest quickly before attaching the pads.",
      "If they are breathing, put them in the recovery position — they may vomit water.",
      "Remove wet clothing and cover them with anything warm and dry; hypothermia develops fast.",
      "EVERY drowning survivor needs medical assessment, even if they seem completely fine — lungs can deteriorate hours later.",
      "Keep them still and warm until help arrives."
    ]
  },
  {
    id: "nosebleed",
    title: "Nosebleed",
    icon: "👃",
    urgent: false,
    summary: "Bleeding from the nose.",
    callFirst: false,
    steps: [
      "Sit them down and lean them FORWARD — not back. Leaning back sends blood down the throat.",
      "Pinch the soft part of the nose, just below the bridge, firmly for 10–15 minutes without letting go to check.",
      "Have them breathe through the mouth and spit out any blood rather than swallowing it.",
      "A cold pack on the bridge of the nose can help.",
      "After 10–15 minutes, release. If still bleeding, pinch for another 10–15 minutes.",
      "Once stopped: no nose-blowing, picking, hot drinks or heavy lifting for several hours.",
      "Get urgent medical help if bleeding continues beyond 30 minutes, follows a head injury, is very heavy, or the person takes blood thinners.",
      "Frequent nosebleeds without obvious cause should be checked by a doctor."
    ]
  }
];

// Emergency numbers by country/region. "all" = single number for all services.
export const EMERGENCY_NUMBERS = [
  { region: "European Union (all members)", codes: ["EU"], all: "112" },
  { region: "United States", codes: ["US"], all: "911" },
  { region: "Canada", codes: ["CA"], all: "911" },
  { region: "United Kingdom", codes: ["GB"], all: "999 / 112" },
  { region: "Ireland", codes: ["IE"], all: "112 / 999" },
  { region: "Australia", codes: ["AU"], all: "000" },
  { region: "New Zealand", codes: ["NZ"], all: "111" },
  { region: "India", codes: ["IN"], all: "112" },
  { region: "Pakistan", codes: ["PK"], police: "15", ambulance: "1122", fire: "16" },
  { region: "Bangladesh", codes: ["BD"], all: "999" },
  { region: "Sri Lanka", codes: ["LK"], police: "119", ambulance: "1990", fire: "110" },
  { region: "Japan", codes: ["JP"], police: "110", ambulance: "119", fire: "119" },
  { region: "China", codes: ["CN"], police: "110", ambulance: "120", fire: "119" },
  { region: "South Korea", codes: ["KR"], police: "112", ambulance: "119", fire: "119" },
  { region: "Singapore", codes: ["SG"], police: "999", ambulance: "995", fire: "995" },
  { region: "Malaysia", codes: ["MY"], all: "999" },
  { region: "Indonesia", codes: ["ID"], all: "112" },
  { region: "Philippines", codes: ["PH"], all: "911" },
  { region: "Thailand", codes: ["TH"], police: "191", ambulance: "1669", fire: "199" },
  { region: "Vietnam", codes: ["VN"], police: "113", ambulance: "115", fire: "114" },
  { region: "United Arab Emirates", codes: ["AE"], police: "999", ambulance: "998", fire: "997" },
  { region: "Saudi Arabia", codes: ["SA"], all: "911" },
  { region: "Turkey", codes: ["TR"], all: "112" },
  { region: "Israel", codes: ["IL"], police: "100", ambulance: "101", fire: "102" },
  { region: "Egypt", codes: ["EG"], police: "122", ambulance: "123", fire: "180" },
  { region: "Nigeria", codes: ["NG"], all: "112" },
  { region: "Kenya", codes: ["KE"], all: "999 / 112" },
  { region: "Ghana", codes: ["GH"], police: "191", ambulance: "193", fire: "192" },
  { region: "South Africa", codes: ["ZA"], police: "10111", ambulance: "10177", fire: "10177" },
  { region: "Brazil", codes: ["BR"], police: "190", ambulance: "192", fire: "193" },
  { region: "Mexico", codes: ["MX"], all: "911" },
  { region: "Argentina", codes: ["AR"], all: "911" },
  { region: "Chile", codes: ["CL"], police: "133", ambulance: "131", fire: "132" },
  { region: "Colombia", codes: ["CO"], all: "123" },
  { region: "Peru", codes: ["PE"], police: "105", ambulance: "106", fire: "116" },
  { region: "Russia", codes: ["RU"], all: "112" },
  { region: "Ukraine", codes: ["UA"], all: "112" },
  { region: "Switzerland", codes: ["CH"], police: "117", ambulance: "144", fire: "118" },
  { region: "Norway", codes: ["NO"], police: "112", ambulance: "113", fire: "110" },
  { region: "Satellite / at sea (GMDSS)", codes: ["XX"], all: "VHF Ch 16 / 406 MHz EPIRB" }
];

export const CHECKLISTS = [
  {
    id: "go-bag",
    title: "72-Hour Go-Bag",
    icon: "🎒",
    blurb: "One bag per person, packed and ready by the door. Review it twice a year.",
    items: [
      "Water — 3 litres per person (plus purification tablets or a filter)",
      "High-energy food for 3 days that needs no cooking",
      "All regular medications (7-day supply) + copies of prescriptions",
      "First-aid kit",
      "Torch/flashlight + spare batteries (or hand-crank)",
      "Power bank for phones, fully charged, checked monthly",
      "Battery or wind-up radio",
      "Whistle (three blasts = distress signal)",
      "Copies of ID, insurance, and key documents in a waterproof bag",
      "Cash in small notes — cards fail when the power is out",
      "Warm layer, rain shell, sturdy shoes, spare socks and underwear",
      "Emergency blanket (foil type)",
      "Basic hygiene: soap, toothbrush, sanitary supplies, toilet paper",
      "Dust masks (N95/FFP2) and work gloves",
      "Multi-tool and duct tape",
      "Local paper map with meeting points marked",
      "Baby, pet, or mobility supplies your household needs",
      "List of key phone numbers ON PAPER"
    ]
  },
  {
    id: "home-kit",
    title: "Home Emergency Kit",
    icon: "🏠",
    blurb: "Supplies to shelter in place for up to two weeks.",
    items: [
      "Water — 4 litres per person per day for 14 days, or a safe way to purify",
      "Two weeks of non-perishable food your family actually eats",
      "Manual can opener",
      "Camping stove or safe way to cook without power (NEVER charcoal indoors)",
      "Full first-aid kit + first-aid handbook",
      "Fire extinguisher — checked yearly, everyone knows where it is",
      "Smoke alarms and carbon monoxide alarm — test monthly",
      "Torches and lanterns + plenty of batteries (avoid candles)",
      "Alternative heat source and warm sleeping bags",
      "Plastic sheeting and duct tape to seal windows or make repairs",
      "Bleach (unscented) — 4 drops per litre purifies water in an emergency",
      "Rubbish bags and ties for sanitation",
      "Spare glasses, hearing-aid batteries, and medical supplies",
      "Games, cards or books — morale is a supply too",
      "Know how to shut off your gas, water and electricity — tools taped near the valves"
    ]
  },
  {
    id: "family-plan",
    title: "Household Emergency Plan",
    icon: "📋",
    blurb: "Ten minutes of planning now beats an hour of panic later.",
    items: [
      "Agree TWO meeting points: one right outside the home, one outside the neighbourhood",
      "Choose an out-of-area contact everyone checks in with (long-distance calls often work when local ones fail)",
      "Everyone knows the local emergency number — including the children",
      "Everyone's key numbers are written on paper in wallets and school bags",
      "Know your area's actual risks (flood, quake, storm, wildfire) and official warning channels",
      "Sign up for local emergency alerts on every phone",
      "Learn evacuation routes from home, work and school — and one alternative each",
      "Plan for pets — most emergency shelters cannot take them",
      "Plan for relatives who need help: who fetches grandma?",
      "Practise a fire escape from every bedroom, at night, once a year",
      "Photograph or scan key documents; store copies far away or encrypted in the cloud",
      "Know your children's school emergency release policy",
      "Keep the car above half a tank in storm or fire season",
      "Check in on neighbours who live alone — you may be THEIR emergency plan"
    ]
  }
];

export const DISCLAIMER =
  "Lifeline is a quick-reference aid based on widely published first-aid guidance. " +
  "It is not medical advice, not a substitute for accredited first-aid training, " +
  "and never a reason to delay calling your local emergency number. " +
  "Consider taking a certified first-aid course — hands that have practised save lives.";
