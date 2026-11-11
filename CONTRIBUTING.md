# Contributing to HoloWindow

Thanks for helping make screens feel more like windows.

## Getting set up

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck  # must pass before you open a PR
npm run build
```

## Project layout

```
src/
  main.ts           wires everything together: renderer, scenes, head sources, HUD
  types.ts          shared types + world conventions (units are centimetres; screen is z = 0)
  render/           off-axis projection camera
  tracking/         head sources (webcam face tracker, mouse fallback)
  scenes/           room + photo scenes
  depth/            in-browser depth estimation for photo mode
  ui/               HUD (vanilla TS + CSS, no framework)
```

Read the conventions at the top of `src/types.ts` before touching geometry.

## Guidelines

- **Keep it local.** Nothing may send camera frames, images, or user data off the device. No analytics.
- **Keep it light.** No UI frameworks; think twice before adding a dependency.
- **Keep the UI out of the way.** The 3D view is the product.
- **Accessibility matters.** Real buttons, labels, visible focus, and respect `prefers-reduced-motion`.
- Small, focused PRs are easiest to review. Describe how you tested (browser, screen size, webcam).
- For visual changes, a short screen recording in the PR goes a long way.

## Reporting bugs

Use the bug report template and include your browser, OS, screen size, and any console errors.

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
