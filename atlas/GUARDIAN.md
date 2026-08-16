# 🛡 Atlas Guardian — crash detection with automatic help

Every satnav shows the road ahead. Guardian cares about what happens if you
don't arrive.

## What it does

1. While you navigate (and Guardian is **On** in ⚙️ Settings → 🛡 Guardian),
   Atlas watches the phone's motion sensors for a **crash signature**: a
   violent impact (≈4g+) followed by stillness. Potholes spike but the drive
   carries on — they don't trigger. The detection is a pure engine function
   (`crashSignature` in `engine.js`) with unit tests.
2. On a hit, Atlas asks **out loud**: *"Possible crash detected. Are you OK?"*
   A red 30-second countdown fills the screen with two huge controls:
   **✋ I'm OK — stand down** and **📞 Call emergency services (112)**.
3. One tap on I'm OK and Guardian stands down silently. Nothing was sent.
4. If the countdown runs out:
   - a **live location link** goes up on screen (the convoy watch-link
     machinery — a convoy starts automatically so the link shows you moving),
   - the **dashcam seals its current footage** as a saved clip (evidence,
     with telemetry and the overview map already burned in),
   - if an emergency contact is configured, Atlas writes an alert document
     and a Cloud Function **emails them** your position, an OpenStreetMap
     link, and the live watch link.

## Privacy

- Detection runs entirely on the phone. No motion data ever leaves it.
- Nothing is sent anywhere until the countdown expires — an "I'm OK" tap
  leaves zero trace.
- The `atlas_guardian` Firestore collection is **write-only for clients**
  (rules-enforced): an alert can be created exactly once, never read back,
  never edited. It contains only what the email needs: your chosen name,
  the contact email you entered, one position, the watch link, a timestamp.

## Setup (owner)

Guardian's on-screen half (countdown, live link, 112 button, clip sealing)
works with **zero setup**. The automatic email needs the Firebase project
pieces you already use for Pro fulfilment:

```sh
firebase deploy --only firestore:rules      # adds the atlas_guardian rules
firebase deploy --only functions:atlasGuardianAlert
firebase functions:secrets:set SENDGRID_API_KEY   # already set if Pro emails work
```

## Try it safely

⚙️ Settings → 🛡 Guardian → **Try it**. The full flow runs — voice, countdown,
escalation screen — but marked as a test: no email is sent.

## Honest limits

- A phone in a cradle detects impacts well; one loose in a bag is noisier.
  The 4g threshold + stillness rule is deliberately conservative — Guardian
  would rather miss a fender-bender than cry wolf on a pothole.
- iOS asks permission for motion sensors the first time you switch
  Guardian on (Apple requires a tap — that's the toggle).
- Emergency-services dialling uses 112, which works across the EU/UK and on
  GSM networks in most of the world.
