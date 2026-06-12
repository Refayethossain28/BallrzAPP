# DAYTONA USA — Web Arcade Edition

A browser-based arcade racing game inspired by SEGA's **Daytona USA**
(1993). Two renderers are included:

- **2D arcade** (`index.html`) — the authentic *pseudo-3D* segment-projection
  technique the real 1993 cabinet used. Zero dependencies, loads instantly,
  runs on anything.
- **3D polygon** (`3d/index.html`) — a true **WebGL / Three.js** rebuild for an
  arcade-faithful look: a polygonal Hornet and rivals on a real extruded 3D road
  that loops via a Catmull-Rom spline, with **banked corners**, hills,
  **red/white guardrails**, **packed grandstands**, DAYTONA billboards, the 777
  start gantry, a **painted sky with sun and clouds**, snowy mountains, a
  chase/hood camera that rolls with the banking, **speed lines**, and the same
  arcade HUD. Three.js is vendored locally (`3d/vendor/`), so it needs no
  network.

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
- **Procedural music** — an upbeat arcade-rock loop synthesised in real time
  (drums, bass, chord pads and an arpeggiated lead) with a driving "race" mode
  and a mellow "menu" mode. No audio files; press **M** to mute. Shared by both
  the 2D and 3D builds (`music.js`).
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
