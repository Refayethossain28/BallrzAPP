# DAYTONA USA — Web Arcade Edition

A browser-based arcade racing game inspired by SEGA's **Daytona USA**
(1993). Two renderers are included:

- **2D arcade** (`index.html`) — the authentic *pseudo-3D* segment-projection
  technique the real 1993 cabinet used. Zero dependencies, loads instantly,
  runs on anything.
- **3D polygon** (`3d/index.html`) — a true **WebGL / Three.js** rebuild for an
  arcade-faithful look: a polygonal Hornet and 39 numbered rivals on a real
  extruded 3D road that loops via a Catmull-Rom spline, with **steep banked
  corners**, hills, **textured asphalt** (lane markings baked in) and grass,
  **red/white guardrails**, **packed grandstands**, DAYTONA billboards, the 777
  start gantry, a **painted sky with sun and clouds**, a chase/hood camera that
  rolls with the banking, and **speed lines**. Three **themed courses** with
  their own palettes and set-pieces:
  - *Three-Seven Speedway* — alpine, pines, snow-capped peaks, a tunnel
  - *Dinosaur Canyon* — desert, rock spires, a roadside brontosaurus, a tunnel
  - *Sea-Side Street Galaxy* — palms and an ocean plane

  It uses a post-processing pipeline (**bloom**, **FXAA**, **filmic ACES tone
  mapping**, a subtle **vignette**), **real-time soft shadows**, and **clearcoat
  PBR car paint that reflects the sky** (environment-mapped). Graphics detail
  auto-scales down on phones (lighter bloom, no FXAA, simpler paint, smaller
  shadows). Three.js + the post-processing addons are vendored locally
  (`3d/vendor/`, resolved via an import map), so it needs no network.

  > Note: this is a *web/mobile* racer — it pushes fidelity within a browser's
  > limits, not literal console-grade graphics.

![type: arcade racer](https://img.shields.io/badge/genre-arcade%20racer-ff3b3b)

## ▶ Play

Open `index.html` in any modern browser (or `3d/index.html` for the 3D
version):

```bash
# from this folder
python3 -m http.server 8000
# then visit http://localhost:8000          (2D)
#         or http://localhost:8000/3d/       (3D)
```

or simply double-click `index.html`.

## 🎮 Controls

| Key | Action |
| --- | --- |
| `↑` / `W` | Accelerate |
| `↓` / `S` | Reverse |
| `←` `→` / `A` `D` | Steer |
| `SPACE` | Brake / handbrake |
| `P` / `ESC` | Pause |
| Enter / Space (menu) | Start race |

On-screen touch buttons appear automatically on touch devices.

## 🏁 Features

Recreates the look of Daytona's **Three-Seven Speedway** (Beginner course):

- **The Hornet #41** — the blue/red "Gallop" stock car with roll-cage bars,
  rendered from the chase camera just like the cabinet.
- **40-car field** — race a full pack of 39 rivals in varied liveries with
  live `POSITION x/40` tracking.
- **Pseudo-3D road engine** — the same segment-projection technique the real
  arcade board used: curves, hills, rumble kerbs, dashed lanes.
- **Arcade HUD** — `LAP x/8`, arcade lap timer (`0'10"68`), the big yellow
  **checkpoint countdown**, the **rainbow rev gauge** with needle + speed %,
  and the **TRAFFIC minimap**.
- **Checkpoint timer** — reach the line before the clock hits zero to extend
  it, or it's `TIME UP` (authentic arcade rule).
- **Three courses** — Three-Seven Speedway, Dinosaur Canyon, Sea-Side Street
  Galaxy — that change laps, top speed, curve severity and rival pace.
- **Alpine canyon scenery** — snow-capped peaks, guardrails, pines, rocky
  cliffs, the 777 slot-machine start gantry, screen shake and tyre smoke.
- **Procedural audio** — a WebAudio engine note that rises with RPM, plus
  collision and UI blips.
- **Procedural dance music** — a four-on-the-floor house/EDM track synthesised
  in real time: punchy kick, claps, open/closed hats, a **sidechain-pumped**
  bass, detuned supersaw chord stabs, a plucky arpeggio lead and a pad, with a
  delay send. It reacts to the race: a low-pass **filter opens up with your
  speed**, and the **final lap kicks into a higher-energy mix**. No audio files;
  press **M** to mute. Shared by both builds (`music.js`).
- **On-screen pause button** with **Resume / Restart / Exit** — works on touch,
  and the menus compress to fit landscape phone screens.
- Keyboard + on-screen touch controls; fully responsive (great on iPhone in
  landscape).

## How it works

The track is a list of `segments` stacked into the distance. Each segment is
projected from world space to screen space with a simple perspective camera,
then drawn back-to-front (painter's algorithm). Curves come from a horizontal
`curve` force accumulated per segment; hills come from per-segment world Y.
Opponent cars and roadside props ride along the same coordinate system.

See `game.js` for the fully commented engine.

## Credits

A non-commercial, fan-made homage to SEGA's **Daytona USA**. All code here is
original. "Daytona USA" and related marks are property of SEGA; this project is
not affiliated with or endorsed by SEGA.
