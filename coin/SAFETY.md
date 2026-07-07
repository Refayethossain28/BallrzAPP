# Keep your TimeCoin safe

Plain-English guide to never losing your coins. Read this once — it takes five
minutes and it is the difference between money you keep and money that vanishes.

TimeCoin is **real money you control yourself**. That is its strength and its
responsibility: there is no bank, no support desk, and no "forgot password"
button. Whoever holds the key holds the coins. This page shows you how to make
sure that is always you.

---

## The one thing you must understand

Your coins are **not stored in the app**. They live on the shared blockchain.
What lives on your device is your **key** — the secret that proves the coins are
yours. Lose the key and you lose the coins; let someone copy the key and they
can take the coins. Everything below is about protecting that one secret.

Two different things can go wrong, and they have two different fixes:

| Risk | What it means | Your protection |
|------|---------------|-----------------|
| **Loss** | Your phone breaks, you clear your browser, you get a new laptop — and the key is gone with it. | A **backup**: your recovery phrase, a paper wallet, or a backup file. |
| **Theft** | Someone with access to your device (or malware) reads your key. | A **passphrase**: encrypts the key so it can't be read from storage. |

You want **both**. A passphrase with no backup means a forgotten passphrase
locks you out forever. A backup with no passphrase means a stolen laptop is a
stolen wallet. Do the two-minute setup below and you're covered against each.

---

## Two-minute setup (do this now)

1. **Write down your recovery phrase.** In the app: **🔑 Keys → 📜 Recovery
   phrase**. Copy all 33 words onto paper, *in order*. Store the paper somewhere
   safe — ideally two places (home and, say, a relative's house). Do **not**
   photograph it or put it in a chat or email; a screenshot in your camera roll
   is a key anyone who unlocks your phone can read.

2. **Save a backup file.** In the app: **🔒 Key security → Back up all
   wallets**. This downloads one encrypted `.blzwallet` file holding *every*
   wallet on the device. Keep a copy somewhere you won't lose — a USB stick, or
   emailed to yourself. It's encrypted, so it's useless to anyone without your
   backup passphrase.

3. **Add a passphrase.** In the app: **🔒 Key security → Protect keys with a
   passphrase**. Now your keys are encrypted on this device and you unlock with
   the passphrase each time. Pick something you'll remember — but the written
   phrase from step 1 is your safety net if you ever forget it.

That's it. The orange **"Back up your wallet"** banner disappears once you've
saved a backup, and you can stop worrying about losing your coins.

---

## Recovering after a lost or wiped device

You did the setup, then your phone died. Here's how you get everything back:

- **From your recovery phrase:** open TimeCoin on the new device → **Import
  wallet** → type the 33 words. Your balance reappears once the app syncs with
  the network.
- **From a backup file:** open TimeCoin → **🔒 Key security → Restore from
  file** → choose your `.blzwallet` file → enter its passphrase. Every wallet in
  the file comes back at once.

The coins were never really "gone" — they were always on the blockchain, waiting
for the key that proves they're yours.

---

## Everyday habits that keep you safe

- **Never share your private key or recovery phrase.** No genuine person, admin,
  or "support" will ever ask for it. Anyone who does is trying to rob you.
- **A payment link is safe to share; a key never is.** Your address (starts with
  `B…`) and payment QR are *meant* to be public — that's how people pay you.
- **Check the address before you send.** Payments are final and cannot be
  reversed. Confirm the first and last few characters match.
- **Use a device you trust.** Don't unlock a wallet holding real value on a
  shared or public computer.
- **Keep your big balance in a separate wallet.** Use a small everyday wallet
  for day-to-day favours and a backed-up "savings" wallet you rarely open.
- **Back up again after making a new wallet.** A backup only contains the
  wallets that existed when you saved it. Made a new one? Save a fresh backup.

---

## <a id="verify"></a>Check you're on the real app (integrity)

TimeCoin runs entirely in your browser, so it's only as trustworthy as the
page you loaded. A tampered copy on a lookalike site could try to steal keys.
Two simple checks:

1. **Use the real link.** Only open TimeCoin from the address you trust —
   ideally bookmark it. Be wary of links pushed to you out of the blue.
2. **Compare the code fingerprint.** In the app, **🔒 Key security** shows a
   **Code fingerprint** — a short hash of the exact code your browser loaded.
   Everyone running the same version sees the *same* fingerprint. If yours
   suddenly changes when you didn't update the app, or doesn't match what a
   friend on the same version sees, treat it as a warning sign and don't enter
   your keys until you've checked you're on the genuine site.

The fingerprint changes with every genuine release, so there is no single
permanent number — it's a way to spot *unexpected* changes and to confirm you
and the people you trade with are running identical code.

### Current release fingerprint

> **`f620-2cd7-4016-2208`**
>
> Full SHA-256: `f6202cd7401622082b9a818c20a439a4b64199c85644116435adaf3b58986f4c`

This is the fingerprint for the **current published version** of TimeCoin. Open
**🔒 Key security → Code fingerprint** in the app and check the short value
matches the one above. If it does, you're running the genuine, unmodified code.
If it doesn't — and you know you're on the current release — stop and don't enter
your keys.

This block is updated whenever a new version ships (the app's code changes, so
its fingerprint changes too). It's published here in the project's source, on a
channel separate from wherever you run the app, so a tampered copy of the app
can't fake it. You can regenerate it yourself from a checkout with:

```
cd coin && node -e 'const{readFileSync}=require("fs"),{createHash}=require("crypto");
const f=["index.html","engine.js","mutual.js","reputation.js","config.js","qr.js","wordlist.js","i18n.js"];
const j=f.map(n=>n+"\n"+readFileSync(n,"utf8")).join("\n");
const h=createHash("sha256").update(Buffer.from(j,"utf8")).digest("hex");
console.log(h.slice(0,4)+"-"+h.slice(4,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16));'
```

---

## What the app can and can't protect you from

**It protects the money itself well.** The cryptography is real: your key can't
be guessed, signatures can't be forged, and the ledger can't be counterfeited —
these are tested against published standards (see
[`SECURITY.md`](SECURITY.md)).

**It can't protect you from losing the key.** No system can invent a copy of a
secret you never wrote down. That's why the backup steps above matter more than
anything else.

**It can't undo a payment or a giveaway.** Sending coins, or handing someone your
key, is final. Treat your key like cash in your pocket.

For the full, honest technical security assessment — including the current
limitations of a small network — see [`SECURITY.md`](SECURITY.md). Nothing is
hidden.

---

*Short version: write down your 33 words, save a backup file, add a passphrase.
Do those three things and your coins are yours to keep.*
