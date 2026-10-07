# Comps

A comp ("comparison") pass looks at reference images, works out how they get their look, and moves the
procedural city toward it. Each reference below lists what it does, how that is achieved, what Neon Sprawl
does about it now, and what is still missing. The look rules that came out of it are in `docs/ART_BIBLE.md`.

The build workspace cannot download images (image hosts are blocked there), so this pass worked from
published analyses and from well-known references. To compare pixel for pixel, put the reference images in
a local folder and shoot the matching views below.

## Comp views

```bash
# dev server on :5174 (npx vite --port 5174)
node scripts/shot.mjs --views harbour --extra "q=high&fov=28" --backend gpu --out shots/comp   # skyline across the water, long lens
node scripts/shot.mjs --views aerial,top --extra "q=high" --backend gpu --out shots/comp         # the city to the horizon; straight down
node scripts/shot.mjs --views s:cnmarket,s:jpmarket,strip --extra "q=high" --out shots/comp      # street canyons
node scripts/shot.mjs --views landmark,d:luxury,spawn --extra "q=high" --out shots/comp          # towers, an arterial, the first view
```

`?fov=` sets the lens (vertical degrees) and `Z` cycles it in the app (66, 45, 30, 20).

## References

### Chongqing at night (also Shanghai's riverfront and Hong Kong's harbour)

- **What you see.** Towers drawn in lines of light: LED strips on every floor slab and up the corners, in
  warm white, cool white or gold. The tallest ones near the water run a synchronised show, so the whole
  riverfront changes colour together. Bridges are outlined, the golden stilt houses of Hongyadong glow, and
  the river doubles everything. Buildings climb the hills in steps, and fog collects in the valleys.
- **How.** Contour lighting and media facades on the buildings themselves, coordinated across the skyline;
  photos are usually shot across the water with a long lens, which stacks the towers.
- **Now.** Tall towers carry LED media facades (`core/media.ts`, the facade shader): static outlines, and a
  city-wide show on the tallest waterfront towers (four scenes on one clock: bands climbing, a wave along
  the shore, a rainbow scroll, sparkle). Lines keep their light with distance. A lamp-lined promenade runs
  along the sea, the water reflects the skyline, and the `harbour` view with a 28° lens reproduces the
  photo.
- **Still missing.** Hills (the city is flat), bridges over the water, a river through the city, cable cars.

### Hong Kong streets and Ghost in the Shell (1995)

- **What you see.** Dense residential slabs with mixed warm and cool windows, AC units and cages; neon signs
  projecting over the street from both sides; humid, hazy air. Ghost in the Shell built its city from
  location photos of Kowloon (the Walled City among them). Its hazy billboards came from a camera lens that
  misted up in humid night air, and its backgrounds were painted in several layers that move separately.
- **How.** Layered signage at several depths, a lot of small light sources, and haze that glows around them.
- **Now.** The Red Gate Market and Megablocks districts, projecting framed signs and red lanterns, ground
  traffic in the street, haze that glows only where the signs are.
- **Still missing.** Canals, people, a lens-mist pass.

### Tokyo (Shinjuku, Kabukicho)

- **What you see.** Vertical sign stacks on every building, big screens, bright shop fronts at street level,
  strings of bulbs over side streets, taxis.
- **Now.** Lantern Market's vertical tenant stacks, blades and festoon bulbs (now small and warm), shop-front
  pools of light on the pavement, two-way traffic with head and tail lights. Walls take less spill, so the
  signs carry the street.

### Akira (1988)

- **What you see.** The film lives in the dark: crushed, inky blacks, light only from motivated sources
  (neon, street lamps, headlights), saturated red against cyan and green city lights, highlights that bloom
  softly. The production used 327 colours, 50 of them new, largely to make the night scenes work.
- **Now.** The grade no longer lifts or tints the blacks; lamps, beacons and traffic are light sources that
  stay visible as points to the horizon; arterials and highways carry streams of red and white.

### Night City (Cyberpunk 2077)

- **What you see.** Megabuildings, giant holograms and ad walls, streets filled with neon-lit haze, wet
  ground. The lighting team's stated rule is to keep clear visibility with dramatic contrast and gradients,
  "avoiding flooding/flattening the space with light", with a rhythm of busy and empty spaces.
- **Now.** Lower wall spill and darker distance give that contrast; holograms, ad walls and media facades
  carry the spectacle; the haze glows in the sign streets and stays dark elsewhere.

### Night photography in general

- Lights stay points at any distance and the air between them stays dark. Tall structures carry red
  aviation lights at the top (and at intervals on the tallest), steady or flashing. Long exposures turn
  traffic into ribbons of white and red. The sky over a city is dark with a dim band of light pollution low
  on the horizon.
- **Now.** `render/lights.ts`: lamps, the promenade, the sprawl's street lights (along its street grid),
  beacons on tall roofs, masts, stacks and cranes, and ground and flying traffic, all as sprites that never
  shrink under ~1 px and keep their flux. The sky is darker, with a thin, desaturated pollution band.

## Distance: why the haze piled up

A long ray through haze settles at the haze's ambient brightness (its in-scattered light), whatever is behind
it. That ambient was brighter than the dark walls of the city and the sky behind it was brighter still, so
every far thing converged toward a glowing murk, and the farther the brighter. The fix keeps the ambient
terms under the walls and the sky (about a fifth of what they were), keeps in-scatter only where the light
volume has light, dims and desaturates the horizon band, and carries the far city with point lights instead
of glow.

Median linear luminance (×1000) by distance from the camera, same views before and after (`aerial` and
`spawn` are 960×540 WebGL2 renders; measured from a depth pass of the same frame):

| View | 400–800 m | 800–1500 m | 1500–2500 m | 2500 m+ | sky |
| --- | --- | --- | --- | --- | --- |
| aerial, before | 1.2 | 3.0 | 5.7 | 5.6 | 16.7 |
| aerial, after | 3.0 | 7.3 | 1.5 | 1.2 | 2.9 |
| spawn, before | 12.8 | 6.2 | 7.8 | 6.2 | 8.7 |
| spawn, after | 9.3 | 2.2 | 2.1 | 1.1 | 1.8 |

Before, brightness rose with distance up to a sky about 14 times brighter than the city in front of it.
After, the lit core is the brightest band. Beyond it the city falls off into dark air, and the sky sits close
to the far ground.

## Sources

- [Chongqing: China's cyberpunk city](https://faroutmagazine.co.uk/chongqing-chinas-cyberpunk-city/), Far Out
- [Chongqing Yangtze River night tour](https://intotravelchina.com/en/attractions/chongqing_attraction/night_tour_of_the_yangtze_river.html), Into Travel China
- [Chongqing Nights](https://photocontest.smithsonianmag.com/photocontest/detail/chongqing-nights/), Smithsonian Magazine photo contest
- [Hongyadong and the Qiansimen Bridge at night](https://unsplash.com/photos/a-city-skyline-at-night-with-a-bridge-over-a-body-of-water-qJdcz9tI7KU), Unsplash
- [Akira cinematography analysis](https://colorculture.org/akira-cinematography-analysis/), Color Culture
- [How Akira's use of colour resulted in 50 new shades](https://slashfilm.com/807579/how-akiras-record-breaking-use-of-color-resulted-in-50-new-shades), /Film
- [Anime Architecture: How Ghost in the Shell was built](https://magazine.032c.com/magazine/anime-architecture-ghost-shell-built), 032c
- [How Cyberpunk 2077 lit up Night City (GDC 2022)](https://www.gamedeveloper.com/marketing/find-out-how-cyberpunk-2077-lit-up-night-city-in-this-gdc-2022-session), Game Developer
- [Art Direction Summit: Building Night City](https://gdcvault.com/play/1027571/Art-Direction-Summit-Building-Night), GDC Vault
- [Creating lighting and environments for Cyberpunk 2077](https://80.lv/articles/creating-lighting-and-environments-for-cyberpunk-2077/), 80.lv
- [Aviation obstruction lighting](https://en.wikipedia.org/wiki/Aviation_obstruction_lighting), Wikipedia
