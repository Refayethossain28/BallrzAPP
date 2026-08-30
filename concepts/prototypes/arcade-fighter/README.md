# `arcade-fighter/` — STREET BRAWLERS '94

A **runnable, zero-build** arcade fighting game in a single self-contained HTML
file (same pattern as the other prototypes here). No install, no server, no
assets — every fighter, background and sound effect is generated procedurally
in-canvas at runtime.

> **On the brief.** This was requested as a "recreate Street Fighter II"
> exercise. Street Fighter II and its characters, sprites, music and art are
> Capcom's copyrighted property and are **not** reproduced here. Instead this is
> an *original* game in the same 1v1 arcade-fighter genre — original fighters,
> original art, original audio — implementing the classic mechanics that define
> the genre (which are not themselves copyrightable).

## How to run

Open the file directly in a browser:

```
concepts/prototypes/arcade-fighter/index.html
```

(Double-click, or `open <file>` on macOS / `xdg-open` on Linux. Works equally
well served from any static host.) Click or press a key once to enable sound.

## Controls

| | Move | Jump | Crouch | Punch | Kick | Special |
|--|--|--|--|--|--|--|
| **P1** | `A` / `D` | `W` | `S` | `J` | `K` | `L` |
| **P2** | `←` / `→` | `↑` | `↓` | `1` | `2` | `3` |

- **Block** by holding **away** from your opponent. Stand-block highs and
  jump-ins; **crouch-block** (hold down-back) lows.
- **Highs / lows / mids** — jump attacks are overheads (block standing),
  crouching kicks are lows (block crouching), normals are mid.
- **Special** — tap the special key (`L` / `3`).
- `Enter` confirms menus, `Esc` backs out, `M` on the title toggles
  **1P-vs-CPU** ↔ **1P-vs-2P**.

### On iPhone / touch devices

On a touch device the keyboard hints are replaced by an **on-screen gamepad**:
a movement cross (JUMP / DUCK / ◀ / ▶) bottom-left and **P / K / SP** buttons
bottom-right. **Tap the screen** to start or to play again, and a **MODE**
button appears on the title screen. Best experience: **rotate to landscape**,
then in Safari use **Share → Add to Home Screen** and launch from the icon for
a fullscreen, no-chrome arcade feel. (Tap once first to enable sound.)

## What's implemented

- **Title → character select → match** flow with an animated menu.
- **Roster of 4 original fighters**, each with distinct HP / walk-speed /
  jump / power stats and a signature special:
  - **BLAZE** — all-rounder, *Pyro Bolt* projectile.
  - **VOLT** — fast/floaty, *Arc Spark* projectile.
  - **BOULDER** — heavyweight, armored *Rock Rush* dash.
  - **MANTIS** — agile, *Rising Talon* anti-air uppercut.
- **Best-of-3 rounds**, round timer, KO and time-up win conditions, win pips.
- Full move set: light punch, kick, crouching variants, jumping attacks,
  three special archetypes (projectile / rising anti-air / armored rush).
- **Blocking** with high/low/mid mix-ups and chip damage; **hitstun**,
  **knockdown**, **hitstop** freeze-frames and **screen shake** for impact.
- **Projectiles** with collision against fighters and blocking.
- A simple **CPU AI**: approaches, zones with projectiles, jumps in, blocks
  reactively, and attacks in range.
- Procedural everything — vector fighters with animated limbs, a parallax
  arcade backdrop (sunset skyline + crowd silhouette), and a tiny WebAudio
  blip synth for SFX.

## Verification

The embedded script passes `node --check`, and the pure game logic was driven
headlessly (canvas/DOM/audio mocked) through complete matches:

- **vs-CPU**: title → select → fight → **K.O.** → `BLAZE WINS!` across multiple
  rounds, no runtime errors; all of `round / fight / roundend / matchend`
  scenes reached.
- **vs-2P + timeout**: versus mode starts both human fighters; with no input,
  every round correctly resolves as an equal-HP **draw** at time-up (no win
  awarded), so the match loops — the intended behavior.
