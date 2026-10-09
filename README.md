# Neon Sprawl

A procedurally generated cyberpunk city you fly through in a hover car. Everything is made from code and
shaders: no meshes, textures or other assets are loaded. Three.js r186 runs it with the WebGPU renderer
(WebGL2 fallback) and TSL node materials.

Over the street grid sit megastructures (whole-block pyramids, ziggurats, cantilevered stacks, twisting
towers, sky discs, arches, slabs on stilts, skybridges) and shaped towers that are not boxes: lathed eggs
under a diagrid, faceted tapers that fold into triangles, twisting towers, leaning and bowed slabs, lumpy
accreted stacks, bundled tubes, decks carried across rows of slabs, and hulks with whole buildings bolted to
their flanks. Pipes, ducts, hung rooms, capsules, catwalks, lift shafts and masts are bolted onto the walls
and roofs, and onto the cars. Building-sized holograms (a koi ringing the landmark pyramid, serpents,
jellyfish, mantas), columns of light on the tallest crowns, building-sized ad walls and the official traffic
(ad airships, police patrols, medevac flyers and cargo haulers) fill the air.

A second world, **the hive**, is a city-planet: towers a kilometre or more tall packed over narrow canyons,
bridges and decks crossing them at every height, traffic stacked up the canyons, no coast, no sky to speak of
and no edge (see **The hive** below).

The night itself is tuned against reference photos and films (see `docs/COMPS.md`). The sky and the air go
dark with distance. Lamps, aviation beacons and the head and tail lights of the street and air traffic stay
points of light out to the horizon. Tall towers carry LED media facades, and the tallest on the waterfront
run one synchronised light show.

Every surface is procedural too, and weathered the way real ones are (see **Materials** below): mosaic
tile, render, brick, cast concrete, cladding, corrugated metal and stone walls with streaks under every
sill, damp at the foot, rust, cracks, posters and graffiti; membrane, gravel and paver roofs; asphalt with
cracks, cuts, oil and gutters; worn pavers and kerbs.

Every sign, street lamp, fire and festoon string also lights the walls, pavement and cars round it in its own
colour, and the humid air glows round it (see **Light and air** below). The haze is thick enough that the city
fades with distance: near streets are lit by the signs in them, and far towers sink into dark air.

The city is built the way Unreal's PCG / City Sample builds one: a **zone graph** decides where each
district goes, and each district's **attribute table** drives everything downstream. That covers street
grids, lots, building archetypes, facades, signage, clutter, light, fog and the sky glow. A second,
nested layer of **land use** varies the blocks inside each district. Global **style dials** bias the whole
city, and **per-district scalars** bias one district kind.

## Run it

```bash
npm install
npm run dev            # http://localhost:5173
npm test               # generator, megastructures, shaped towers, the hive, media facades, holograms, flyer routes, collision, flight
npm run artifact       # one self-contained HTML file in dist-artifact/
```

Chrome or Edge 113+ (WebGPU) gives the full look. Firefox and Safari use the WebGL2 path, which is the
same city with screen-space reflections off by default.

## Controls

| Input | Action |
| --- | --- |
| Mouse | steer (click to capture the pointer; drag works too) |
| W / S | thrust / brake |
| A / D | strafe |
| Space or E / C or Q | climb / dive |
| Shift | boost |
| F | guided flight (a tour along the avenues) |
| 1–7 | jump to a district |
| T · G · M · H | rain · zoning deck · map · HUD |
| R | back to the start |
| Z | lens: 66° → 45° → 30° → 20° (a long lens stacks the skyline like the photo comps) |
| Wheel | camera distance |
| Map click | fly there. Click the legend to switch the map between districts and land use. |

## The districts

| Kind | Name | Character |
| --- | --- | --- |
| corporate | Corporate Core | glass and panel towers, crowns and logos, plazas, searchlights, cool light |
| jpmarket | Lantern Market | 2–8 floor shophouses, vertical sign stacks, wires, festoon bulbs, magenta haze |
| cnmarket | Red Gate Market | dense midrises, projecting framed signs, window cages, red lanterns |
| megablock | Megablocks | slab housing with skybridges and screens, teal smog |
| industrial | Harbor Works | sawtooth sheds, tank farms, stacks, container yards, cranes, sodium haze |
| decayed | Ash Flats | ruins and bare frames, shacks, rubble lots, barrel fires, dusty air |
| luxury | Gilded Shore | villas with roof gardens and pools, spires, parks, warm light |

Each district carries its own fog tint and density, and the sky glow over the camera blends the palettes
of the districts around it. The haze gets darker with distance, not brighter: far away you see the
city's lights, not a lit fog.

## Megastructures and shaped towers

The **Alien** dial (City section) sets how much of the city is megastructure. Whole blocks (and at alien ≥ 0.2
a whole superblock for the landmark) are kept as single lots and given to one of nine grammars:

| Archetype | Shape |
| --- | --- |
| pyramid | stepped glass pyramid with terraces and an apex lantern; the landmark is 350–620 m |
| ziggurat | arcology with battered (sloped) walls and garden terraces over a plumb shop storey |
| taper | obelisk on a podium |
| cantilever | boxes shoved off-centre, each overhanging the one below with a lit underside |
| twist | square floor plates each turned a few degrees from the last |
| disc | a slim core holding one or two sky discs with lit undersides |
| flare | a stalk flaring into a wide head |
| arch | two legs bridged by a mass across the top |
| stilts | a slab lifted on pylons over a glass lobby |

Skybridges join tall neighbours across local streets. Sloped walls keep their windows and corner light
lines on the slope; overhangs get soffits with downlights.

Shaped towers (`src/core/forms.ts`) follow the families of complex tall buildings (rotors, twisters, anglers
and sliders, carvers), on original designs, in the corporate core, the megablocks, the markets and the
Gilded Shore:

| Archetype | Shape |
| --- | --- |
| egg | a lathed shell: round or squircle plan, bulging a third of the way up, closing over in a rounded top under a glass lantern, glazed with a diagrid or spandrel bands |
| prism | an n-gon base whose corners fold in as it rises to a smaller n-gon turned half a side round, so every wall is a pair of tall triangles; a spire on top |
| helix | a rounded triangle, square or squircle twisting (and tapering, sometimes pinched at the waist) as it climbs |
| lean | a slab whose axis leans out over its lot, or bows out and back |
| stack | boxes piled off-centre, some turned, each overhanging the one below in its own material |
| bundle | a bundle of square tubes of different heights, each with its own crown |
| skyship | a row of slabs carrying one long hull across their tops, its pointed bow cantilevered past the last slab |
| hulk | a plain core with whole buildings bolted to its flanks at every height, each its own size, material and age |

A curved shell is one surface: its walls are shaded smooth, and its windows, structure and light lines run on
round the curve and up through the joins instead of restarting on every facet. Structure can be drawn over a
facade: a **diagrid** of diagonal members (lit on bright towers), vertical **ribs**, spandrel **bands** that join
each floor's windows into a ribbon, or a giant cross-braced **megaframe**. Ordinary towers step back unevenly
too, on one or two sides, so their crowns sit off-centre.

**Bolted-on detail** (`src/core/greebles.ts`): risers and pipe runs up and along the walls, ducts under the
slabs, rooms hung off the facade on brackets in spreading clusters, capsules on the accreted blocks, catwalks,
lift shafts and service cores up the outside of tall towers, and shacks, lattice masts and dishes on the
roofs. How much a building carries follows its grime, its culture and its archetype (accreted blocks the
most, glass and luxury towers almost none), and it grows with the building, so a kilometre tower's pipes are
pipes at its scale. The hover cars carry theirs too: a power pack strapped to one flank, a primer patch
panel, a conduit, a lashed crate, a whip antenna and a spotlight on the player's car; a roof pod, a slung
tank and a rack on the traffic.

## The hive

The **World** buttons at the top of the zoning deck (or `?world=hive`) switch to the hive, a city-planet on the
same districts and dials:

- **Kilometre towers**: every block is one megastructure, a few hundred metres to 3 km tall (a corporate
  core of folded spires, eggs, helixes and bundles; megablocks of hulks, stacks and slabs; lumpy markets),
  on a landmark pyramid over a kilometre high. Windows stay a storey tall, so the walls read at their true
  scale, and fewer of them are lit.
- **Canyons**: the arterials and the streets between blocks are slots between the towers. Traffic runs on
  twelve levels up them, police, medevac, haulers and airships between the car levels, and enclosed bridges
  and wide decks cross every canyon again and again on the way up, kept between the traffic levels.
- **No edge**: no coast and no sea; the sprawl closes round the city on every side with towers of 250 m to
  1.8 km.
- **Air**: the haze thins out over about 1.7 km of height instead of 220 m, so every level of the canyons
  sinks into it. Light from the upper levels comes down slantwise through the gaps between the towers, so the
  air near the tops glows and the depths stay dark, cut into shafts by the towers and bridges.

Start low in a canyon, about 240 m up with the towers climbing out of sight (`R`), then dive into the depths or
climb out over the crowns.

## Spectacle and traffic

- **Giant holograms**: building-sized koi, serpents, jellyfish and mantas on slow circuits fitted to the
  skyline, animated entirely in the vertex shader (a swimming wave, fins, pulsing bells, tentacles).
- **Light pillars** on the three tallest crowns and the landmark apex.
- **Ad walls**: building-sized LED screens high on tall towers playing posters of huge invented glyphs,
  a koi pond and a product spin; projected glyph holograms over rooftops in the markets and on the strips.
- **Flyers**: ad airships with LED flanks and floodlights over the skyline, police units with red and blue
  light bars patrolling the arterials and ringing street incidents with searchlights, teal and white medevac
  flyers, and cargo haulers on the low bands.
- **Media facades**: LED lines on the floor slabs and corners of tall towers, more of them on the
  waterfront. Most are steady warm, cool or gold outlines; the tallest join a city-wide show of four
  scenes on one clock (bands climbing, a wave along the shore, a rainbow scroll, sparkle).
- **City lights**: street and highway lamps, a promenade along the sea, the sprawl's street grid, red
  aviation beacons on towers, masts, stacks and cranes, and two-way ground traffic on the arterials,
  highways and the sprawl's through roads, all drawn as point lights that stay visible to the horizon.
  The hover cars in the air lanes carry head and tail lights too.

## Materials

There are no texture files: every surface is a stack of procedural layers, the way Night City's
"multilayered" materials stack tiling surfaces through masks, with the weathering where water, sun and hands
put it (`src/render/surface.ts`, `src/render/wallmat.ts`).

- **Walls**: per facade style and building, small glazed mosaic tiles, painted render with a stucco grain
  that peels where it stays wet, brick, cast concrete (formwork panels or boards, tie holes, bugholes, lift
  lines), cladding panels with joints and fixings, corrugated sheet with laps and rust, polished or honed
  stone. Then streaks from every sill (strongest at the ends) and from the roof edge, air conditioner
  drips, damp and splash at the foot with a salt tide line, dirty corners, sun fade on the south side,
  patch repairs, cracks from window corners, moss along the wet streaks, and posters and graffiti
  (letters from the sign atlas) at street level in grimy blocks. Windows get frames, lit reveals, dirty
  glass and a slightly different tilt per pane, so reflections break up pane by pane.
- **Roofs**: bitumen membrane with lapped seams and patches, gravel ballast, pavers or a pale coating;
  dirt along the parapet, dry rings where water ponds (puddles in the rain), drains, moss and soot.
- **Ground**: asphalt grain, a crack network sealed with tar in places, utility cuts, oil down the lane
  centres, polished wheel paths, a gutter that collects grit and water, grates and manhole covers, worn and
  chipped markings; pavers with stains, gum, cracks and sunken ones, tactile pads at the corners, kerb
  stones; cast-concrete lots with joints and oil; a seawall with tide bands and rust runs.
- **Kits and vehicles**: paint worn off the edges, rust blooming from edges and feet, streaks down the
  sides, dust on top, galvanised metal, leaf clumps on trees; the hover car has panel gaps, a pinstripe,
  road grime and rain beads; flyers have panel lines and grime.

Detail finer than about two pixels fades to its average, so nothing sparkles from the air. At night the
materials show where light falls: relief is shaded against the likely light (the street below for walls,
the nearest lamp for the ground), street light pools light the foot of walls, and lit windows light their
reveals and the wall round them. `?fill=0.5` adds a flat white fill light to inspect materials.

## Light and air

- **Local lights**: every sign is an area light, and street lamps, barrel fires and festoon strings are point
  lights: about 35,000 in a default city. A sign's light comes from the nearest point on its panel, lifted off
  the wall a little like neon on a board. The lights fall off with distance (a windowed inverse square), light
  walls, pavement, kits, props and cars in their own colour, and flicker with their sign. A sign lights only the
  street side of the wall it hangs on, so it never shines through its own building. Each pixel finds its lights
  in a world grid baked with the city (`src/render/locallights.ts`): every 10 m cell lists the 12 street-level
  lights and 4 high ones (ad walls, rooftop signs) that put the most light there. Past about 700 m the baked light
  volume takes over.
- **Halos**: each frame the 40 lights that matter most to the view glow in the air round them. Single scattering
  from a light has a closed form along a view ray, so the haze pass works out each light's glow exactly, up to
  the surface the ray hits and only on the street side of the light's wall. A light you look toward glows more
  (forward scattering), and rain thickens the glow. Ad walls get a soft glow round the whole panel, and the bloom
  has a soft knee, so bright signs carry a halo of glare.
- **Distance**: the haze is thicker (extinction about 0.0016 per metre at street level, thinning over about 220 m
  of height) and its ambient stays dark. A tower 500 m away keeps about half its light, so the city fades into
  dark air with distance instead of standing crisp to the horizon. Near the camera the coarse light volume only
  adds a little bounce light, so walls are bright next to their lights and dark away from them.
- **Ambient occlusion**: ground-truth AO from the depth buffer darkens creases, setbacks, the foot of every
  wall and everything bolted onto one, so stacked and cluttered forms read as solid. It darkens the light that
  falls on surfaces, not what glows (windows, signs and screens keep their light). Off on `low`, half
  resolution on `medium` and `high`.
- **Light shafts** (the hive): a height map of everything standing tells the haze whether a point in the air
  sees the sky; light from above is cut by the towers and bridges into shafts.
- **Quality**: `high` and `ultra` use all of it. `medium` (the WebGL2 default) takes the 6 most important lights
  per cell within about 420 m and 16 halos; `low` turns local lights and halos off and lights the city from the
  baked light alone. The frame-rate guard steps down through these levels on a slow machine.

## Dials

**Style** (whole city; each axis is one of the genre's visual eras, see `docs/ART_BIBLE.md`)

- *Grime*: pristine ↔ rotting (dirt, dead lights, clutter)
- *Edge*: soft ↔ monolithic (matte slabs, cold light)
- *Flash*: dim ↔ neon kitsch (sign density, screens, saturated colour)
- *Luxury*: cheap ↔ gilded (gold, stone, gardens, warm light)

**Culture**: Western ↔ East Asian signage and clutter, and Japanese ↔ Chinese within that.

**World**: the coastal city or the hive.

**City**: density, height, size (km), alien (familiar ↔ megastructures).

**District mix**: how much of the city each district kind takes.

**District tuning**: pick a district kind and set its own scalars (−1…1):

- *Scale*: building height and volume (footprints, lots, blocks)
- *Budget*: wealth and build quality (glass and screens or raw concrete, upkeep, lit windows, greenery)
- *Decay*: dirt, damage and dereliction (ruins and shacks appear, dead signs and lamps, rubble lots)
- *Density*: how packed (street spacing, lot size, clutter)
- *Neon*: how many signs and how bright

**Land use**: the share of homes, commerce, nightlife, industry, civic and green across all districts.

**Atmosphere (live, no rebuild)**: haze, rain, neon, traffic, exposure. **Quality**: low, medium, high, ultra
(high and ultra add screen-space reflections). A governor steps quality down if the frame rate stays low.

Presets: Default (the coastal city), Hive, Boom town, Fallen glory, Night strip, Vertical slum, Rain market,
Walled city, Corporate, Rust belt, Gilded coast. The other presets keep the current world.

## URL parameters

`seed`, `preset` (e.g. `night-strip`), `world=hive`, `size`, `alien`, `q` (`low|medium|high|ultra`), `fov` (lens, vertical degrees), `gl` (force WebGL2),
`ssr` / `nossr`, `noao`, `auto` (start in guided flight), `fog`, `rain`, `neon`, `exposure`, `dry`, `tm=agx`, and for
screenshots and debugging: `still`, `nohud`, `notaa`, `debug=fog|depth`, `hdbg=tmax|zone|light`,
`hide=name,prefix*`, `holot` (freeze the holograms at a clock time), `screen=N` (force every LED screen to one
scene), `lightgain` (scale the baked city light), `fill` (a flat white fill light to inspect materials), and
`t.<dial>=value` to set a lighting dial by name (`t.halo` for the glow's strength, `t.halos` for how many lights
glow, `t.localgain`, `t.fogDensity`, `t.aoStrength`, `t.shaft` for the light shafts, `t.bloomStrength`...).
`hdbg=sky` shows where the air sees the sky.

## How it is built

```
generateCity(seed, dials)                      src/core (pure, deterministic, tested)
  zoning      arterial grid, coast, district sites grown over the superblock graph, border blending
  streets     per-district local grids and alleys, junctions, block plates
  land use    nested zones: noise patches by share, one nightlife strip per district, civic and parks
  lots        recursive splits sized by district and tuning; whole blocks kept for megastructures
  massing     31 archetype grammars -> convex tiers (sloped tiers carry a top polygon, overhangs a soffit,
              shells join tiers into one surface); shaped towers in forms.ts; the hive's own table
  skybridges  enclosed bridges between tall neighbours across local streets (the hive: across every canyon)
  media       LED outlines and the waterfront light show on tall towers
  dressing    signs by culture and use, ad walls, rooftop holograms, AC units, laundry, lamps, emitters
  greebles    bolted-on pipes, ducts, hung rooms, capsules, catwalks, lift shafts, roof shacks and masts
  spectacle   giant hologram circuits fitted to the skyline, light pillars
  transit     elevated metro loop with stations, subway kiosks
  traffic     air lanes and highway decks; airship, police, medevac and hauler routes, police incidents
  outskirts   a ring of plain blocks and its street grid to the horizon (the hive: megatowers all round)
  collision   boxes for the flight
        |
        v  CitySpec (plain JSON)
buildCityRender(spec)                          src/render
  merged geometry per 480 m chunk and material, instanced kits, signs as glyph quads and SDF tubes,
  a baked light atlas (32 height layers) + ground light map + district zone map,
  one facade shader (parallax windows into raymarched rooms, LOD to averages, sloped and folded walls,
  smooth shells with windows running round them, diagrids, ribs, bands and megaframes),
  procedural surfaces: per-style wall substrates and weathering, roofs, asphalt and pavers, worn kits,
  local lights (signs, lamps, fires and festoons from a world grid) on every lit surface,
  vertex-animated holograms and light pillars, instanced flyers and searchlight cones,
  point-light sprites (lamps, beacons, GPU-animated ground traffic) that keep their light with distance,
  post: ambient occlusion (GTAO), volumetric haze (raymarched, district-tinted, analytic far tail,
  closed-form halos round the lights that matter most to the view, light shafts from a height map),
  screen-space reflections,
  neon glow layer, TRAA, bloom, grade, chromatic edge, vignette, grain
```

## PCG in one paragraph

"PCG" (procedural content generation) is the common name in games, and Unreal's framework is literally
called PCG. The pattern used here is the one its city tools use. A coarse **zone graph** (here, superblocks
grown from district seeds) carries **attribute sets**. Every later stage reads those attributes instead of
hard-coding a look: street spacing, lot frontage, archetype weights, sign density, palettes, fog. Each stage
also samples with a seeded random stream keyed by a stable identity (a block's or lot's key), so changing
one district does not reshuffle the rest of the city.

## License

MIT. See `LICENSE` and `THIRD_PARTY.md`.
