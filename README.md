<div align="center">

<img src="public/favicon.svg" width="72" alt="" />

# HoloWindow

**Your screen is a window. Look through it.**

Webcam head tracking + off-axis projection turn any display into a window into a 3D space, right in your browser.

### [Try it live](https://ethanzhou.ca/holowindow/)

</div>

<!-- TODO: replace with a real capture (phone filming the screen while you move your head) -->
<p align="center"><img src="docs/demo.gif" width="720" alt="HoloWindow demo: the scene shifts in perspective as the viewer moves their head" /></p>

---

## How it works

A normal 3D renderer assumes your eye sits at a fixed point, dead centre in front of the screen. HoloWindow tracks where your head **actually** is and re-renders the scene from that point, every frame.

1. **Find your face.** MediaPipe Face Landmarker runs on your webcam feed, in the browser.
2. **Estimate how far away you are.** Human eyes are about 6.3 cm apart. The webcam sees them some number of pixels apart; with the camera's field of view that gives distance by similar triangles:

   ```
   distance ≈ (IPD_cm × image_width_px) / (2 × eye_gap_px × tan(FOV / 2))
   ```

   Where your face sits in the frame then gives x and y. Everything is in centimetres, relative to the centre of your screen.
3. **Off-axis projection.** The screen is treated as a fixed physical rectangle (that's why it asks for your screen size). The camera is put at your eye, and the view frustum is skewed so its edges always pass through the screen's corners:

   ```
                 virtual 3D box (z < 0)
         ┌───────────────────────────────┐
          \                             /
           \        what you see       /
            \                         /
     ────────[=========SCREEN========]────────  z = 0
               \                   /
                 \               /       the frustum is asymmetric:
                   \           /         its edges always pass through
                     \       /           the screen corners
                       \   /
                        (o)   your eye, tracked (x, y, z)
   ```

   Move your head left and the frustum skews right: you see more of the box's left wall, just like a real window. This is the generalized perspective projection (Kooima, 2008).
4. **Photo mode.** Drop in any image. [Depth Anything](https://github.com/DepthAnything/Depth-Anything-V2) estimates a depth map right in your browser, and the image becomes a displaced 3D relief behind the glass.

## Features

- **Five scenes**, picked from the dock:
  - **Room**: a neon grid-walled box with floating objects that sits *behind* your screen.
  - **Space**: a star field, nebula and ringed planet, with objects drifting out past the glass.
  - **Aquarium**: a fish tank behind your screen.
  - **Photo**: turn any photo into a 3D relief with in-browser monocular depth estimation.
  - **3D model**: drop in a `.glb` / `.gltf` and it sits on a turntable behind the glass.
- **Drag and drop anywhere**: images go to Photo mode, `.glb` / `.gltf` files to 3D model mode. Or use the Upload button.
- **Calibration wizard**: hold a credit card to the screen and resize an outline to match it; HoloWindow works out your physical screen size from that. No card? Enter the diagonal instead. A second, optional step checks the distance the tracker reads and helps you tune the webcam field of view.
- **Face or mouse**: webcam head tracking, or a mouse fallback when you don't want to use the camera.
- **Private**: no server, no uploads, no analytics.
- **Minimal UI**: a glassy control dock that hides itself after a few seconds.

### Keyboard shortcuts

| Key       | Action                         |
| --------- | ------------------------------ |
| `Space`   | Next scene                     |
| `1`–`5`   | Jump to a scene (Room … 3D model) |
| `H`       | Hide / show the controls       |
| `F`       | Fullscreen                     |
| `R`       | Recenter head position         |
| `Esc`     | Close settings / calibration   |

## Quick start

Requires Node 22+.

```bash
git clone https://github.com/ethanzhoucool/holowindow.git
cd holowindow
npm install
npm run dev
```

Open the printed URL (usually http://localhost:5173). Camera access needs a secure context: `localhost` is fine, otherwise use HTTPS.

```bash
npm run build      # production build into dist/
npm run preview    # serve the build locally
npm run typecheck
```

## Calibration tips

The illusion is only as good as the geometry. In order of impact:

1. **Set your screen size.** Open Settings → *Calibrate with a card…* and match the outline to any credit or ID card. Or pick a preset, or measure the lit area of the display with a ruler (width × height in cm).
2. **Go fullscreen** (`F`). Then the viewport is exactly the screen and nothing is offset by browser chrome.
3. **Sit 50–70 cm away**, roughly centred, and press `R` to recenter.
4. **Light your face.** A lamp in front of you beats a window behind you. Tracking gets jittery in the dark. Raise *Smoothing* if it shakes.
5. **Close one eye.** Your brain loses its stereo cue that the screen is flat, and the depth becomes startlingly real.
6. Still feels off? Step 2 of the calibration wizard shows the distance the tracker reads; adjust *Webcam field of view* (most laptop cameras are 55–75°) until it matches reality. *Motion gain* above 1× exaggerates the effect for demos.

## Privacy

Your camera feed never leaves your device. Face tracking and depth estimation both run locally in your browser. There is no backend. The only network requests are for the app itself and the model weights (face and depth models), which your browser caches. Images and models you drop in are processed in memory and never uploaded. Settings are stored in `localStorage`.

## Tech stack

- [Vite](https://vite.dev) + TypeScript, no UI framework
- [Three.js](https://threejs.org) for rendering
- [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) (Face Landmarker) for head tracking
- [Transformers.js](https://huggingface.co/docs/transformers.js) running [Depth Anything](https://github.com/DepthAnything/Depth-Anything-V2) for monocular depth
- GitHub Actions + GitHub Pages for deploys

## Roadmap

- [ ] More scenes (a tiny diorama city)
- [ ] Stereoscopic mode for anaglyph and side-by-side 3D displays, without WebXR
- [ ] Better depth for photos: inpainting the occluded regions behind foreground objects
- [ ] Desktop wallpaper mode via Electron or Wallpaper Engine
- [ ] Multi-monitor calibration

Ideas welcome; open an issue.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports with your browser, screen size and webcam are especially useful.

## Credits

- **Johnny Chung Lee**, whose [2007 Wii Remote head-tracking demo](https://www.youtube.com/watch?v=Jd3-eiid-Uw) showed everyone that a flat screen can be a window. This project is a webcam-only, browser-only homage.
- **Robert Kooima**, *Generalized Perspective Projection* (2008), the maths behind the off-axis frustum.
- [MediaPipe](https://github.com/google-ai-edge/mediapipe) by Google for face landmarks.
- [Depth Anything](https://github.com/DepthAnything/Depth-Anything-V2) for monocular depth estimation, and [Transformers.js](https://github.com/huggingface/transformers.js) for running it in the browser.
- [Three.js](https://github.com/mrdoob/three.js) and its contributors.

## License

[MIT](LICENSE) © 2026 Ethan Zhou
