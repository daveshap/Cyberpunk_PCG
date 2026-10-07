# Art bible

The city has to pass two tests: it reads as **one high-fidelity night city**, and every district reads as
**itself**. That holds from 400 m up and from the pavement.

## Style axes (the dials)

The four style dials follow the four visual eras the cyberpunk genre borrows from:

| Dial | Era | Pushes toward |
| --- | --- | --- |
| Grime | Entropism | dirt streaks, rust, dead and faulty neon, boarded windows, clutter, dark lamps |
| Edge | Neomilitarism | monoliths, panel and slit facades, matte black, cold white and red light |
| Flash | Kitsch | sign density, screens and holograms, saturated pinks, cyans and yellows |
| Luxury | Neokitsch | stone and gold trims, curves and chamfers, roof gardens, warm light, pools |

The dials are **biases**, not overrides. Each district keeps its own base values from `PROFILES` and the
dial moves them toward 0 or 1, so the whole city can lean one way and the districts still differ.

## Cognitive alienation (the alien dial)

A plain grid of boxes reads as New York with neon. The genre's cities feel built by something else: masses
too big, too sloped or too unsupported for the street under them. The alien dial (0–1) sets how much of the
city goes to megastructures:

- **Landmark**: one superblock at the core holds a stepped glass pyramid, 350–620 m, with one accent colour on
  its ridge lines and terrace bands, an apex lantern and a light pillar. A giant koi hologram circles it.
- **Whole-block megastructures** (corporate and megablock districts mostly): pyramids, ziggurats, obelisks,
  cantilever stacks, twisting towers, sky discs, flared heads, arches and slabs on stilts.
- **Undersides are lit**: overhangs get dark coffered soffits with a light line and downlights, so the mass
  reads from the street at night.
- **Skybridges** knit tall neighbours together across local streets (never over arterials, which carry the
  air lanes and the metro).

## Per-district scalars

Each district kind also has scale, budget, decay, density and neon (−1…1). Together with the style axes
they span a possibility space. For example, Gilded Shore can be small and derelict (budget −, decay +) or vast
and pristine (scale +, budget +). Decay can bring ruins into any district, and budget buys glass, screens,
parks and lit windows.

## Districts

| District | Massing | Facades | Signage | Light / air |
| --- | --- | --- | --- | --- |
| Corporate Core | towers, monoliths, needles, podiums; 110–360 m with spikes | glass curtain walls, panel slits, crown strips | logos on crowns, LED walls, plaza holograms | cool white and cyan, blue haze, searchlights |
| Lantern Market | narrow shophouses and midrises, 10–42 m | punched windows, balconies | vertical tenant stacks, neon blades, festoon bulbs | magenta and cyan, violet haze |
| Red Gate Market | dense midrises, alleys | balconies, cages, raw concrete | big projecting framed signs, red lanterns | red and gold, rust haze |
| Megablocks | slabs 80–230 m, skybridges, arcologies | balconies, grids | screens on the ends, a few roof signs | amber windows, teal smog |
| Harbor Works | sheds 8–24 m, tank farms, stacks | corrugated metal | company letters | sodium orange, thick brown haze, crane lights |
| Ash Flats | ruins and bare frames, shacks | raw concrete, boarded windows | sparse, often dead | barrel fires, olive dust |
| Gilded Shore | villas, spires | stone and gold, tall windows | almost none | warm gold, clear air, pools and parks |

## Land use (inside every district)

- **Homes**: warm windows, curtains, balconies, laundry lines, planters, few signs, warm lamps.
- **Commerce**: shopfronts on every street side, offices above with cooler light.
- **Nightlife**: low-rise, dark walls, 2–3× signage, marquees and blades, festoon bulbs over the street, pink and violet lamps. One strip per district.
- **Industry**: sheds and tanks borrowed from the harbor tables, sodium lamps, yards.
- **Civic**: podium halls kept lit, plazas, municipal screens.
- **Green**: parks and pocket plazas, trees, path lamps, ponds.

## Rendering rules

These came out of the comp pass (`docs/COMPS.md`): real night photos of Chongqing, Hong Kong and Tokyo, and
the night cities of Akira, Ghost in the Shell and Night City all agree on them.

- **The frame lives in the dark.** Blacks stay black (no lifted, tinted shadows); most of the frame is near
  black and the light comes from sources: windows, signs, lamps, screens, traffic. Neon has to pop against
  darker walls. When a scene washes out, lower the light spill or the haze scatter before you touch the
  emissive levels.
- **Walls are lit by what is near them, not washed.** The light volume is coarse (13 m), so its spill on walls
  is low and knee'd, and rough surfaces do not mirror it at grazing angles. Streets keep their full response
  to the fine ground map: pools of lamp and shop light are what draw the grid from the air.
- **Distance gets darker, not brighter.** A long ray through haze settles at the haze's ambient brightness, so
  that ambient must stay under the dark walls and the night sky; the haze only glows where city light
  actually is. The sky is dark with a thin, dim, desaturated band of light pollution low on the horizon.
  Far away you see the city's lights through dark air, not a lit fog. Ground never ends at a visible edge.
- **Lights stay points.** Anything the eye sees as a point (street and highway lamps, the promenade, the
  sprawl's street lights, aviation beacons on towers, masts, stacks and cranes, head and tail lights) is a
  sprite that never shrinks under ~1 px and keeps its light as it does, so a far street is a string of fine
  points, a far district a dense carpet, and the air between stays dark.
- **Traffic is light.** Two-way streams on arterials, highways and the sprawl's through roads: white heads
  toward you, red tails away. From above they trace the grid; from the street they move.
- Windows are never flat paint up close. They show a room (parallax), curtains with folds or blinds, and a mix
  of warm, neutral and cool light, plus the odd tinted room. When single windows merge, a floor becomes a
  ribbon of light (lit and dark runs, the ceiling brighter than the desks); only when floors merge too does
  the facade fall to a dim average with faint bands. Never a flat glow.
- **LED lines.** Tall towers, more of them on the waterfront, carry LED lines on their floor slabs and
  corners: warm, cool or gold outlines, and a city-wide light show on the tallest, which all run the same
  scenes on one clock so the skyline moves together. Light lines on stacked plates otherwise go on the crown
  plate only, or the tower stripes white.
- Wet ground mirrors the city: screen-space reflections at high/ultra, the light volume and sky otherwise.
- **Lens.** Flying uses a wide lens (66°); the skyline across the water reads best on a long one (28–30°),
  which stacks the towers the way the photos do. `Z` cycles the lens, `?fov=` sets it.
- All names, logos and glyphs are invented. No real brands, no game IP.

## Materials

A surface that is one colour with a little noise reads as a PS2 game. Real surfaces are a substrate with a
history: water runs down from every ledge, dirt splashes up the foot of a wall, paint fades on the sunny
side and wears off edges, rust bleeds from every fixing, people stick posters where they walk. Night City
builds its surfaces the same way, as tiling materials stacked through masks. Here every layer is
procedural (`render/surface.ts`, `render/wallmat.ts`).

- **Substrate first, per style and per building.** Grid, shop and balcony walls are glazed mosaic tile
  (pastel or the building's colour, with a darker floor band on some), painted render, or brick. Raw walls
  are cast concrete with formwork panels or boards, tie holes, bugholes and lift lines. Panels have joints,
  fixings and a tone and bow each. Metal is corrugated sheet with laps and fixings. Lux is stone: marble,
  travertine or granite, polished or honed. Curtain walls have spandrel glass and capped mullions.
- **Weathering follows water, sun and people.** Streaks start under sills (strongest at the sill ends)
  and at the roof edge and thin out as they run down. The foot of a wall is damp and splashed, with a salt
  tide line on porous walls. Corners are dirtier. Paint fades on south faces and higher up. Rust starts at
  the foot of metal sheets, along the laps and under fixings. Cracks start at window corners. Moss grows
  along the wet streaks, not in blobs. Posters and graffiti stay at street level on grounded walls. Patches
  are fresher than the wall round them.
- **Subtle, and scaled by grime.** Every amount scales with the facade's grime; a clean district still
  weathers a little. Overdone weathering is the usual failure: blotches and camouflage read worse than a
  flat wall.
- **Nothing sparkles.** Every pattern fades to its average once it is finer than about two pixels (joints
  keep their average coverage, noise octaves fade to their mean, per-tile tones and tilts fade out).
- **Light reveals the material.** Relief is shaded against the most likely night light (from the street
  below on walls, toward the nearest lamp pool on the ground), the ground's light pools also light the foot
  of walls, and lit windows light their reveals and the wall round them. Do not raise the general wall
  spill to show materials; the dark walls are what makes the neon pop.
- **Windows** have frames (aluminium, white or dark; a meeting rail on sliding windows, a transom on some,
  mullions across shop fronts), dirty glass and a slightly different tilt per pane, so reflections break up
  pane by pane. Boarded windows are weathered plywood; shutters are painted or bare, rusty at the foot,
  and tagged in grimy blocks.
- **Ground**: asphalt grain, sealed and open cracks, utility cuts, oil in the lane centres, polished wheel
  paths, a gritty wet gutter, grates and manholes, worn markings; pavers with stains, gum, cracks and
  sunken ones, tactile pads at the corners, kerb stones (painted along some blocks).
- **Roofs**: membrane, gravel, pavers or a pale coating, with dirt along the parapet, ponding rings,
  drains, moss and soot.
- Posters are invented layouts (blocks and bars, no words); graffiti letters are random Latin letters
  from the sign atlas. No real tags, brands or names.

## Spectacle

- **Giant holograms** are projections, not solids: a faint fill, a hot fresnel rim, a construction grid,
  scanline bands in world height, shimmer and the odd glitch band. Species are generic animals and
  folklore (koi, serpent, jellyfish, manta), never a character or a mascot.
- **Light pillars** stand on the three tallest crowns and the landmark: a hot core with a soft falloff, fading
  into the cloud.
- **Ad walls** are building-sized LED screens high on tall towers: posters of huge invented glyphs (kana-like or
  block), a koi pond, a product spin. Street screens keep their smaller ad loops.
- **Rooftop holograms**: projected glyph columns or emblems over market and strip roofs.

## Flyers

- **Ad airships** drift on wide loops lifted over the roofs, with LED flanks, nav lights and a floodlight.
- **Police** units are dark with a pale stripe and a red and blue light bar (a steady glow and double
  flashes). They patrol the arterials between the car bands and ring street incidents with searchlights.
- **Medevac** flyers are pale with a teal band and teal and white strobes. No crosses, stars of life or other
  protected emblems, and no names from any franchise.
- **Haulers** are long dark cargo craft with amber markers on the low bands.
