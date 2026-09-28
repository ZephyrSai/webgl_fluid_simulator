# Fluid Studio (modern)

https://zephyrsai.github.io/webgl_fluid_simulator/

Modernized UI for the WebGL fluid simulation, now with full multitouch / Apple Pencil input, gestures and generative music. Works on desktop, tablets (iPad) and phones.

Built on Pavel Dobryakov's original WebGL Fluid Simulation (MIT).

## Run locally

- Run `python3 -m http.server 8000` from the repo root and visit `http://localhost:8000/`.
- The scripts are ES modules, so the page has to be served over http(s); opening `index.html` from disk won't load them.
- Everything is static: no build step, no dependencies and no audio files. All music is synthesized live with the Web Audio API.

## Playing

| Input | Fluid | Music |
| --- | --- | --- |
| Drag (any number of fingers, pen or mouse) | Paints velocity and dye; fast strokes stay continuous | Each finger/pen has its own voice: left→right is low→high, higher on screen is brighter. Movement plays tempo-synced notes, faster strokes play denser runs |
| Tap | Drops a splash of ink | Rings a bell tuned to the current chord |
| Hold still | Pulses and stirs under your finger on every beat | Sustains and swells the note |
| Pinch / spread (2+ fingers) | Pulls in / pushes out | Closes / opens a master filter with a whoosh |
| Twist (2+ fingers) | Spins a vortex | Plays a scale run up (counter-clockwise) or down |
| Three-finger tap | Color burst | Impact: crash, sub drop and chord stab |
| Apple Pencil / stylus | Pressure sets stroke size and ink; tilt widens it | Pressure sets loudness and brightness; tilt adds breath |

Left alone, the music rests on a quiet ambient bed. The intensity follows how fast you move: slow strokes bring a light beat and bassline, medium strokes the backbeat groove, fast strokes the full track (driving kick, arpeggios, 16th hats, stabs); extra fingers add a little more. Let go and it settles back within a few seconds. Every visit composes a new track: its own key, tempo, swing, drum and bass grooves, and arpeggio style, and the grooves keep evolving as you play. Choose the **Mood** (Adaptive, Ambient, Intense), **Scale** and **Volume** in the panel.

If heavy painting washes out to white too quickly for you, lower **Ink amount** in the panel.

Keyboard: `Space` burst · `P` pause · `F` fullscreen · `M` mute · `H` hide controls.

### iPad notes

- iPadOS reserves four- and five-finger swipes and pinches (Home, App Switcher). No web page can override them. To use all ten fingers, turn those gestures off in **Settings › Multitasking & Gestures**.
- The fullscreen button uses Safari's element fullscreen. On iPhone, which has no element fullscreen, or for a chrome-free experience, use **Share › Add to Home Screen**.
- Sound starts when you first lift a finger (browsers require a gesture). Where Safari supports the Audio Session API, it also plays with the silent switch on; on older iOS versions, flip the switch off to hear it.

## Performance notes

- Splats are drawn with additive blending, clipped (scissored) to the pixels they affect, instead of a full-screen read and ping-pong pass per splat. That's 5–12× cheaper per splat, which matters with ten fingers or bursts.
- The canvas pixel ratio is capped at 2. If frames stay slow, the render scale drops automatically; if lowering it doesn't help (e.g. iOS Low Power Mode), the drop is undone.
- Framebuffers are only reallocated when their size changes, and old textures are freed. Previously every resize or rotation leaked GPU memory.
- Nothing re-renders while paused and idle. The sunrays mask renders at a fraction of the dye resolution. Resizes are event-driven instead of measured every frame.
- Losing the WebGL context (common on iPad when backgrounded) reloads the page instead of freezing.
