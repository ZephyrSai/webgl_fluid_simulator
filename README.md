# Fluid Studio (modern)

https://zephyrsai.github.io/webgl_fluid_simulator/

Modernized UI for the WebGL fluid simulation. Same shaders and behavior, wrapped in a streamlined control surface that works well on desktop and mobile.

Built on Pavel Dobryakov's original WebGL Fluid Simulation (MIT).

## Run locally

- Open `index.html` in a browser, or run `python -m http.server 8000` from the repo root and visit `http://localhost:8000/modern/`.
- Everything is static—no build step or external dependencies required.

## Controls

- Drag on the canvas to paint velocity/dye.
- Spacebar triggers a color burst; `P` toggles pause.
- Use the panel to adjust quality, diffusion, vorticity, bloom, transparency, and background color; buttons at the top cover snapshotting, bursts, reset, and hiding/showing the controls.
