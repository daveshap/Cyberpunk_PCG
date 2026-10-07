# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this is

A seeded, procedurally generated cyberpunk city with zoned districts, nested land use, megastructures, an
elevated metro, giant holograms, airships and police flyers, and a flyable hover car. Three.js r186
(WebGPURenderer with a WebGL2 fallback, TSL node materials), Vite, Vitest, TypeScript. No asset files:
geometry, textures and lighting are all generated.

## Commands

- `npm test` runs vitest (determinism, district layout, tiers inside blocks, no buildings on roads, dials,
  per-district tuning, megastructures and the landmark, holograms and pillars, flyer routes clear of towers,
  outskirts and their street grid, media facades, flight fuzz, guided-flight tour). Keep it green.
- `npx tsc --noEmit -p tsconfig.json` typechecks everything (render files are `@ts-nocheck` TSL graphs).
- `npm run dev` serves on :5173. `node scripts/shot.mjs --views spawn,aerial,d:corporate,s:jpmarket,strip,res,park,metro,skyline --backend gl|gpu --out shots/x --extra "size=2&q=high"`
  takes headless screenshots against a running dev server (the script's base URL is :5174; start Vite with
  `--port 5174` or edit the script). `--dom 1 --hud 1` captures the page with the UI. More views:
  `landmark`, `a:<archetype>` (the tallest of an archetype), `holo:<i>`, `mega:<i>` (an ad wall), `rholo:<i>`
  (a rooftop hologram), `incident:<i>`, `fly:<kind>:<i>[:back:side:up]` (rides along with a flyer), and any view
  with `@screen=N` appended forces every LED screen to scene N. `harbour` looks at the waterfront skyline from
  the water; pair it with `--extra "fov=28"` (the lens) for the photo comp. See `docs/COMPS.md`. Material
  close-ups: `wall:<style>` (24 m), `close:<style>` (7 m, low on the wall; styles glass, panel, grid, shop,
  balcony, metal, raw, lux), `kerb`, `roofs:<district kind>`; add `--extra "fill=0.5"` for a flat white fill
  light, and `--perf N` to print the ms per frame of each view.
- `node scripts/wgsl-check.mjs` captures every WGSL module the app compiles and flags values read outside the
  `if` branch that computed them (see the TSL gotchas). Run it after touching a material with `If()`.
- `npm run artifact` writes one self-contained HTML fragment to `dist-artifact/index.html` (`--page` also
  writes a full test page).

## Architecture rules

1. `src/core` is pure: no `Math.random`, clocks, DOM or three.js. Randomness comes from forked `Rng`
   streams keyed by **stable identities** (`street.key`, `block.key`, `lot.key`), never by array indices, so
   editing one district never reshuffles another. Add a test when you add a generator stage.
2. `generateCity()` returns plain JSON (`CitySpec`). The renderer reads it and never writes back. Besides the
   city fabric it carries `spectacle` (giant holograms, light pillars) and `flyers` (routes and incidents).
   `Building.archetype` is what was actually built: a builder that hands a small lot to another grammar
   records the swap (`swap()` in `core/massing.ts`).
3. Coordinates: metres, +x east, +y up, +z south (the sea is south). Footprints are convex and
   counter-clockwise; the outward edge normal is `(dz, -dx) / len`. Yaw: forward is `(-sin yaw, -cos yaw)`.
   Kit rotation maps local +z to `(sin θ, cos θ)`.
4. Data flow per district: `PROFILES[kind]` (attribute table) → `styleFor(kind, dials)` (global style dials +
   `dials.tune[kind]`) → `District.style` / `District.tune` → every stage reads those. Land use (`Block.use`,
   `Lot.use`, `Building.use`) is assigned in `core/landuse.ts` between streets and lots.
5. Rendering is chunked (480 m; outskirts 1440 m) with one mesh per (chunk, material category), built with
   `MeshBuilder`. Small repeated things are instanced kits (`KitBatch`, 16 floats per instance). Moving
   instances (traffic, trains) keep the previous pose in `iP` for TRAA motion vectors.
6. Point lights are sprites (`render/lights.ts`): camera-facing quads in the glow layer that never shrink
   under ~1 px and dim by the area they were enlarged by (flux kept, a little extra for glare), so far lamps,
   beacons and traffic stay points instead of aliasing away. Ground traffic runs on the GPU from per-car lane
   data (start, direction, length, speed, phase) on the `SPRITE.t` clock; car bodies use the kit material with
   a lane position node. Lights that also exist as kit geometry fade their sprite up close.
7. Media facades: `core/media.ts` marks tall tiers `facade.media = 'outline' | 'show'` (keyed by building seed);
   the renderer passes it in `aF4.w` and the facade shader draws the LED lines. Show towers all run one clock.
8. Materials are procedural layers (`render/surface.ts`: noise with analytic derivatives, filtered fbm,
   cellular noise, joints and bonds that keep their average coverage below a pixel, streaks, graffiti
   letters, `shadeN` for relief). Facade walls are built in `render/wallmat.ts` (a substrate per style,
   then weathering). Take `fwidth` at the top of a material and pass the pixel footprint (`mpp`, metres
   per pixel) down; every pattern fades to its average before it can alias. Keep weathering scaled by the
   facade's grime and subtle.
9. City light is baked on the CPU into a **2D atlas of 32 height layers** (`TEX.vol`, sampled by
   `volSample` in `render/tsl.ts`), a 1024² ground map and a district zone map. Do not use 3D textures: they
   fail to upload on some WebGPU implementations (the page renders black).

## TSL gotchas

- Never use JS operators on nodes; use `.add .sub .mul .div`.
- Expressions are emitted where first used. A value read after a later `.assign()` must be pinned with
  `.toVar()` first (this once zeroed the whole haze).
- The same rule bites across `If()` branches: a shared expression first used inside one branch is assigned
  only there, and the other branches (and code after the `If`) read it unset. That once blanked most LED
  screen scenes and froze every distant window to one colour. Assign anything the branches share before the
  `If` with `pin(value, type)` from `render/tsl.ts`, and run `scripts/wgsl-check.mjs`.
- Take derivatives (`fwidth`, `dFdx`) before an `If()` and pin them: WGSL only allows them in uniform
  control flow, and a branch on an attribute is not uniform.
- `select()` evaluates both branches; `If()` makes real branches. `Loop` + `Break` work on both backends.
- Opaque node materials get alpha forced to 1. Ground and water carry their reflection weight in alpha via
  `keepAlpha()` (One/Zero blending), which the SSR pass reads as `k = 1 - alpha`.
- Two-sided lit materials must flip the normal with `faceDirection`, or back faces turn into mirrors.
- Glow layers (neon, halos, beams, rain, steam, holograms, pillars, searchlights) write only to the `glow` MRT
  target with zero output and velocity, additive, no depth write.
- Giant holograms move entirely in the vertex shader on their own clock (`HOLO_T` in `render/spectacle.ts`,
  frozen with `?holot=` and in still mode); `holoHead()` is the CPU mirror for framing shots. Flyers move on
  the CPU (`render/flyers.ts`) with the previous pose in `iP` like the traffic.

## Look rules

See `docs/ART_BIBLE.md` (including its Materials section) and the comp notes in `docs/COMPS.md`. In short: each district must read as itself from the air and from the street
(fog tint, sky glow, palette, massing, signage density and type). Neon should pop against darker walls, so
when a scene washes out, lower light spill before you raise anything else. Distance gets darker, never
brighter: the haze's ambient terms must stay under the dark walls and the night sky. Keep names, logos and glyphs
original: no real brands and no game IP.
