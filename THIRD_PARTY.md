# Third-party notices

## three.js

[three.js](https://github.com/mrdoob/three.js) r186 (MIT), installed from npm and bundled into the
production build, including the TSL display add-ons used in the post chain (`TRAANode`, `BloomNode`,
`FilmNode`). Copyright (c) 2010-2026 three.js authors.

Some techniques were studied from three.js's own examples and re-implemented here: the volumetric
lighting with TRAA example (jittered raymarch resolved temporally), the custom fog scattering and
post-processing fog examples, and the procedural city generators in the r186 examples (interior mapping
behind window panes, building grammars). No example code or assets are copied.

## Threejs-Punk (ektogamat/threejs-conference)

Several rendering techniques were studied from, and re-implemented after, the MIT-licensed Threejs-Punk
demo: <https://github.com/ektogamat/threejs-conference>.

- Rain ripple normals in TSL: `src/render/tsl.ts` (`rainRipples`)
- Edge chromatic aberration as a post-process node: `src/render/chromatic.ts`
- The general shape of the neon-noir post chain (scene pass, bloom, film grain, grade): `src/render/post.ts`

```
MIT License

Copyright (c) 2026 Anderson Mancini and Sunag

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Only code techniques are covered by that licence. The demo's models, textures and other assets are not
used here, and nothing in this repository ships them.

## rocksdanister/rain

The raindrop ripple function follows the approach in [rocksdanister/rain](https://github.com/rocksdanister/rain),
which Threejs-Punk credits in turn. It is used as a reference for the technique.

## Fonts

The HUD loads Chakra Petch and Share Tech Mono from Google Fonts (SIL Open Font License 1.1) at runtime,
with system monospace fallbacks. No font files are bundled.

## Names and marks

District names, sign words, logos and glyphs are generated or invented for this project. The kana-like
and block glyph families are original shapes, not real writing systems, and no real brands or
game-franchise names appear in the product.
