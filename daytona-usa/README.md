# DAYTONA USA — Web Arcade Edition

A browser-based, pseudo-3D arcade racing game inspired by SEGA's **Daytona USA**
(1993). Built with plain HTML5 Canvas + JavaScript — no build step, no
dependencies. Just open it and drive.

![type: arcade racer](https://img.shields.io/badge/genre-arcade%20racer-ff3b3b)

## ▶ Play

Open `index.html` in any modern browser:

```bash
# from this folder
python3 -m http.server 8000
# then visit http://localhost:8000
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

- **Pseudo-3D road engine** — classic segment-projection technique with
  curves, hills, banked turns, rumble strips and lane markings.
- **3-lap races** against 5 AI opponents with live position tracking.
- **Three difficulty courses** — Beginner, Advanced, Expert — that change
  top speed, curve severity and rival pace.
- **Arcade HUD** — speedometer (km/h), gear indicator, lap counter, lap/best
  times, race position.
- **Daytona-style flourishes** — blue skies, the sun, parallax mountains,
  palm trees, grandstands with crowds, billboards, the START/FINISH gantry,
  checkered start line, screen shake, tyre smoke, and a "FAST LAP!" banner.
- **Procedural audio** — a WebAudio engine note that rises with RPM, plus
  collision and UI blips.
- Fully responsive; scales to any window or phone screen.

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
