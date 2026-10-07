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

- Neon has to pop against darker walls. When a scene washes out, lower the light spill or the haze
  scatter before you touch the emissive levels.
- Windows are never flat paint up close. They show a room (parallax), curtains with folds or blinds, and a mix
  of warm, neutral and cool light, plus the odd tinted room. Far away they average out without sparkle.
- Distance gets darker, not brighter. The haze only glows where city light actually is; far away you see the
  city's lights through dark air, not a lit fog. Ground should never end at a visible edge.
- Far facades average to a low glow so towers read as dark masses scattered with light; up close every
  window is a room. Light lines on stacked plates go on the crown plate only, or the tower stripes white.
- Wet ground mirrors the city: screen-space reflections at high/ultra, the light volume and sky otherwise.
- All names, logos and glyphs are invented. No real brands, no game IP.

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
