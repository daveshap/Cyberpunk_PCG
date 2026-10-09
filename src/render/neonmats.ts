// @ts-nocheck -- TSL node graphs are dynamically typed.
/**
 * Emissive and translucent materials. Everything blended goes to the `glow`
 * render target (with zero colour and zero velocity in the others), so the
 * post fog never dims a sign by the depth of whatever sits behind it; each
 * layer applies the analytic fog itself.
 *
 *  tube     neon tubes and frames: capsule distance fields on padded quads
 *  halo     broad soft glow behind signs
 *  glyph    neon letters from the glyph atlas (one quad per glyph)
 *  ink      dark letters on lightboxes (alpha-tested, opaque)
 *  screen   animated LED walls and billboards (opaque)
 *  holo     hologram ads floating over plazas
 *  steam    rising plumes
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  abs,
  attribute,
  cameraPosition,
  clamp,
  dot,
  exp,
  float,
  floor,
  fract,
  fwidth,
  length,
  max,
  min,
  mix,
  mrt,
  mx_fractal_noise_float,
  normalWorld,
  normalize,
  oneMinus,
  positionWorld,
  pow,
  select,
  sin,
  smoothstep,
  step,
  texture,
  time,
  uv,
  vec2,
  vec3,
  vec4,
  Discard,
  If,
  cos,
  sqrt,
} from 'three/tsl';

const vnoise2 = (p) => vnoise(p);
import { U, flicker, fogAtten, hash11, hash12, lightAt, shade, vnoise } from './tsl';
import { ATLAS, glyphAtlas } from './glyphatlas';

/** Route a blended material's colour to the glow target only. */
function glowOnly(m: THREE.NodeMaterial, c): void {
  m.colorNode = vec4(0, 0, 0, 0);
  m.mrtNode = mrt({ output: vec4(0, 0, 0, 0), glow: c, velocity: vec4(0, 0, 0, 0) });
}

function additive(m: THREE.MeshBasicNodeMaterial): void {
  m.fog = false;
  m.transparent = true;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  m.blending = THREE.AdditiveBlending;
}

/** Distance from the fragment to the capsule axis (aT = along, across, length). */
function capsuleDistance() {
  const T = attribute('aT', 'vec3');
  const dx = T.x.sub(clamp(T.x, float(0), T.z));
  return length(vec2(dx, T.y));
}

export function makeTubeMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'neon-tube';
  additive(m);
  const c = Fn(() => {
    const W = attribute('aW', 'vec4'); // core radius, glow gain, phase, mode
    const C = attribute('aCol', 'vec3');
    const T = attribute('aT', 'vec3');
    const d = capsuleDistance();
    const r = W.x;
    const aa = fwidth(d).mul(0.9);
    const core = oneMinus(smoothstep(r.sub(aa), r.add(aa), d));
    const energy = clamp(r.div(max(aa.mul(1.4), r)), 0.25, 1.0);
    const hot = oneMinus(smoothstep(r.mul(0.05), r.mul(0.62), d)).mul(core);
    const gl = exp(pow(d.div(r.mul(2.4)), 2.0).mul(-2.5)).mul(oneMinus(smoothstep(r.mul(4.5), r.mul(6.0), d)));
    const lum = dot(C, vec3(0.3, 0.55, 0.15));
    const coreCol = mix(C, vec3(lum.add(0.6)), hot.mul(0.55));
    // mode 5: marquee chase dots along the tube
    const chase = select(W.w.greaterThan(4.5), step(0.5, fract(T.x.div(0.32).sub(time.mul(3.0)))), float(1.0));
    const f = flicker(W.z, select(W.w.greaterThan(4.5), float(0), W.w)).mul(chase);
    const rgb = coreCol.mul(core.mul(1.5).mul(energy)).add(C.mul(gl.mul(W.y))).mul(f).mul(U.neon);
    return vec4(fogAtten(rgb, positionWorld), 1.0);
  })();
  glowOnly(m, c);
  return m;
}

export function makeHaloMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'neon-halo';
  additive(m);
  const c = Fn(() => {
    const W = attribute('aW', 'vec4'); // glow radius, gain, phase, mode
    const C = attribute('aCol', 'vec3');
    const d = capsuleDistance();
    const x = d.div(W.x);
    const g = exp(x.mul(x).mul(-2.2)).mul(oneMinus(smoothstep(1.15, 1.6, x)));
    const rgb = C.mul(g).mul(W.y).mul(flicker(W.z, W.w)).mul(U.neon);
    return vec4(fogAtten(rgb, positionWorld), 1.0);
  })();
  glowOnly(m, c);
  return m;
}

/** Atlas lookup: distance to the glyph strokes in glyph units. */
function glyphDistance(atlas) {
  const G = attribute('aGl', 'vec4'); // cell, mode, phase, radius
  const cell = G.x;
  const cu = cell.mod(ATLAS.cells);
  const cv = floor(cell.div(ATLAS.cells));
  const q = uv().clamp(0.004, 0.996);
  const auv = vec2(cu.add(q.x), cv.add(q.y)).div(ATLAS.cells);
  return texture(atlas, auv).r.mul(ATLAS.dmax);
}

export function makeGlyphMaterial(): THREE.MeshBasicNodeMaterial {
  const atlas = glyphAtlas();
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'neon-glyph';
  additive(m);
  const c = Fn(() => {
    const G = attribute('aGl', 'vec4');
    const C = attribute('aCol', 'vec3');
    const d = glyphDistance(atlas);
    const r = G.w;
    // the distance field is in glyph units; screen-space antialias from its derivative
    const aa = fwidth(d).mul(0.9).max(0.002);
    const core = oneMinus(smoothstep(r.sub(aa), r.add(aa), d));
    const energy = clamp(r.div(max(aa.mul(1.6), r)), 0.25, 1.0);
    const hot = oneMinus(smoothstep(r.mul(0.05), r.mul(0.6), d)).mul(core);
    const gl = exp(pow(d.div(r.mul(2.6)), 2.0).mul(-2.4)).mul(oneMinus(smoothstep(r.mul(5.0), r.mul(7.5), d)));
    const lum = dot(C, vec3(0.3, 0.55, 0.15));
    const coreCol = mix(C, vec3(lum.add(0.6)), hot.mul(0.5));
    const f = flicker(G.z, G.y);
    const rgb = coreCol.mul(core.mul(1.4).mul(energy)).add(C.mul(gl).mul(0.5)).mul(f).mul(U.neon);
    return vec4(fogAtten(rgb, positionWorld), 1.0);
  })();
  glowOnly(m, c);
  return m;
}

/** Dark letters printed on backlit lightbox panels. */
export function makeInkMaterial(): THREE.MeshBasicNodeMaterial {
  const atlas = glyphAtlas();
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'glyph-ink';
  m.fog = false;
  m.side = THREE.DoubleSide;
  m.colorNode = Fn(() => {
    const G = attribute('aGl', 'vec4');
    const C = attribute('aCol', 'vec3');
    const d = glyphDistance(atlas);
    const r = G.w.mul(1.35);
    If(d.greaterThan(r), () => {
      Discard();
    });
    // ink is a deep version of the sign colour, faintly lit by the panel behind
    const ink = C.mul(0.045).add(vec3(0.004));
    return vec4(ink, 1.0);
  })();
  return m;
}

/**
 * Glyph stroke coverage from the atlas: cell id (0..255), position inside the
 * cell (0..1, the glyph sits centred in its 5 x 5 cell) and stroke radius in
 * glyph units.
 */
function atlasStroke(atlas, id, f, radius, soft) {
  const cu = id.mod(ATLAS.cells);
  const cv = floor(id.div(ATLAS.cells));
  const q = f.clamp(0.02, 0.98);
  const d = texture(atlas, vec2(cu.add(q.x), cv.add(q.y)).div(ATLAS.cells)).level(0).r.mul(ATLAS.dmax);
  return smoothstep(radius.add(soft), radius.sub(soft), d);
}

/** Atlas cell of glyph k in family fam (0 latin letters, 1 kana-like, 2 block). */
function familyCell(fam, k) {
  const latin = floor(k.mul(26.0));
  const kana = float(64).add(floor(k.mul(96.0)));
  const block = float(160).add(floor(k.mul(96.0)));
  return select(fam.lessThan(0.5), latin, select(fam.lessThan(1.5), kana, block));
}

/**
 * Animated LED wall / billboard. aBB = (seed, program, aspect, glyph family);
 * aCol/aCol2 colours. Program 0 cycles street ads (equaliser, sun over a grid,
 * glitch mosaic, stripes with a ticker, a blinking eye, a glyph poster);
 * program 1 is a building-sized ad wall (glyph poster, koi pond, product spin,
 * sun over a grid, stripes). Scenes cut over with a short glitch.
 */
export function makeScreenMaterial(): THREE.MeshBasicNodeMaterial {
  const atlas = glyphAtlas();
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'led-screen';
  m.fog = false;
  m.colorNode = Fn(() => {
    const B = attribute('aBB', 'vec4');
    const c1 = attribute('aCol', 'vec3');
    const c2 = attribute('aCol2', 'vec3');
    const seed = B.x;
    const prog = B.y;
    const aspect = B.z;
    const fam = B.w;
    const mega = step(0.5, prog);
    // Everything the scene branches share is assigned here, before the branches:
    // TSL emits a shared expression where it is first used, and a value first
    // computed inside one branch would be unset in the others.
    // LED pitch: street screens ~54 rows, building walls ~150
    const rows = mix(float(54.0), float(150.0), mega);
    const res = vec2(0).toVar();
    res.assign(vec2(aspect.mul(rows), rows));
    const q = vec2(0).toVar();
    q.assign(uv().mul(res));
    const cell = vec2(0).toVar();
    cell.assign(floor(q));
    const fr = vec2(0).toVar();
    fr.assign(fract(q));
    const aa = fwidth(q.x).add(fwidth(q.y));
    const dot0 = smoothstep(0.05, 0.24, fr.x).mul(smoothstep(0.05, 0.24, fr.y)).mul(oneMinus(smoothstep(0.76, 0.95, fr.x))).mul(oneMinus(smoothstep(0.76, 0.95, fr.y)));
    const pix = float(0).toVar();
    pix.assign(mix(dot0, float(0.62), smoothstep(0.35, 1.0, aa)));
    const g = vec2(0).toVar();
    g.assign(cell.add(0.5).div(res));
    const t = time;
    // scene clock: street screens cycle 6 scenes, ad walls 5
    const count = mix(float(6.0), float(5.0), mega);
    const cyc = fract(t.mul(mix(float(0.033), float(0.022), mega)).add(seed)).mul(count);
    const k = floor(cyc);
    const megaScene = select(k.lessThan(0.5), float(5), select(k.lessThan(1.5), float(6), select(k.lessThan(2.5), float(7), select(k.lessThan(3.5), float(1), float(3)))));
    const forced = step(-0.5, U.screenScene);
    const sid = select(forced.greaterThan(0.5), U.screenScene, select(mega.greaterThan(0.5), megaScene, k));
    const cut = step(0.965, fract(cyc)).mul(oneMinus(forced));
    const col = vec3(0).toVar();
    const wa = float(0).toVar(); // x in units of screen height
    wa.assign(g.x.mul(aspect));

    If(cut.greaterThan(0.5).or(sid.greaterThan(1.5).and(sid.lessThan(2.5))), () => {
      // glitch mosaic (also the cut between scenes)
      const blk = floor(cell.div(vec2(7.0, 4.0)));
      const nz = hash12(blk.add(vec2(floor(t.mul(3.0)).mul(7.3), seed.mul(19.0))));
      col.assign(mix(c1, c2, hash12(blk.add(3.7))).mul(step(0.58, nz)).mul(float(0.5).add(nz.mul(1.5))));
    })
      .ElseIf(sid.lessThan(0.5), () => {
        // equaliser
        const bx = floor(wa.mul(6.0));
        const hb = hash11(bx.add(seed.mul(31.0)));
        const level = float(0.5).add(sin(t.mul(mix(1.2, 3.4, hb)).add(hb.mul(30.0))).mul(0.42));
        col.assign(mix(c1, c2, g.y).mul(step(g.y, level).mul(step(0.12, fract(wa.mul(6.0))))).mul(1.3).add(c1.mul(0.05)));
      })
      .ElseIf(sid.lessThan(1.5), () => {
        // sun over a perspective grid
        const pp = g.sub(vec2(0.5, 0.56)).mul(vec2(aspect, 1.0));
        const disc = oneMinus(smoothstep(0.31, 0.33, length(pp))).mul(step(0.26, g.y));
        const cuts = select(g.y.lessThan(0.56), step(mix(0.15, 0.7, smoothstep(0.56, 0.25, g.y)), fract(g.y.mul(26.0).sub(t.mul(0.6)))), float(1.0));
        const gy = float(0.26).sub(g.y);
        const gf = fract(float(0.05).div(max(gy, float(0.012))).sub(t.mul(0.3)));
        const persp = step(0.0, gy).mul(oneMinus(smoothstep(0.0, 0.09, min(gf, oneMinus(gf))))).mul(smoothstep(0.0, 0.05, gy));
        col.assign(mix(c1, c2, clamp(g.y.mul(1.4).sub(0.1), 0.0, 1.0)).mul(disc.mul(cuts)).mul(1.5).add(c2.mul(persp).mul(0.9)).add(c1.mul(0.04)));
      })
      .ElseIf(sid.lessThan(3.5), () => {
        // diagonal stripes with a ticker band
        const sd = fract(wa.add(g.y.mul(0.7)).sub(t.mul(0.22)).mul(3.0));
        const band = step(0.07, g.y).mul(step(g.y, 0.2));
        const letters = step(0.38, hash12(vec2(floor(wa.mul(30.0).sub(t.mul(5.0))), floor(g.y.mul(54.0)))));
        col.assign(mix(c1, c2, g.x).mul(step(0.5, sd)).mul(oneMinus(band)).mul(0.9).add(c2.mul(band).mul(letters).mul(1.6)));
      })
      .ElseIf(sid.lessThan(4.5), () => {
        // a big eye, blinking
        const e = g.sub(0.5).mul(vec2(aspect, 1.0));
        const eye = smoothstep(0.42, 0.4, length(e.mul(vec2(0.6, 1.8)))).mul(step(0.08, fract(t.mul(0.25).add(seed))));
        const iris = smoothstep(0.16, 0.14, length(e.sub(vec2(sin(t.mul(0.7)).mul(0.12), 0))));
        col.assign(mix(c2.mul(0.08), mix(c1, vec3(1.0), 0.3), eye).mul(oneMinus(iris.mul(eye).mul(0.85))).add(c2.mul(iris.mul(eye)).mul(0.4)));
      })
      .ElseIf(sid.lessThan(5.5), () => {
        // glyph poster: columns of huge glyphs drifting up, a bright headline glyph, a ticker
        const portrait = step(aspect, 1.0);
        const cols = mix(float(4.0), float(2.0), portrait);
        const gx = g.x.mul(cols);
        const ci = floor(gx);
        const cellH = aspect.div(cols); // a square glyph cell as a share of the height
        const drift = t.mul(0.04).mul(ci.mul(0.35).add(1.0)).add(seed.mul(10.0));
        const gy = g.y.div(cellH).add(drift);
        const ri = floor(gy);
        const kk = hash12(vec2(ci.add(seed.mul(13.0)), ri));
        const id = familyCell(fam, kk);
        const stroke = atlasStroke(atlas, id, vec2(fract(gx), fract(gy)), float(0.34), float(0.08));
        const hot = step(0.82, hash12(vec2(ri, ci.add(7.0)))).mul(sin(t.mul(2.0).add(ri)).mul(0.5).add(0.5));
        const bg = mix(c2.mul(0.18), c1.mul(0.02), g.y).mul(oneMinus(step(0.1, g.y)).mul(-0.5).add(1.0));
        const ink = mix(c1, vec3(1.0), hot.mul(0.6)).mul(1.5);
        // ticker strip along the bottom
        const tick = step(g.y, 0.08);
        const tg = familyCell(fam, hash12(vec2(floor(wa.mul(12.0).sub(t.mul(2.5))), seed)));
        const tickS = atlasStroke(atlas, tg, vec2(fract(wa.mul(12.0).sub(t.mul(2.5))), g.y.div(0.08)), float(0.4), float(0.1));
        col.assign(mix(bg.add(ink.mul(stroke)), c2.mul(0.15).add(c2.mul(tickS).mul(1.4)), tick));
      })
      .ElseIf(sid.lessThan(6.5), () => {
        // koi pond: dark water, caustics, five koi circling
        const p = g.sub(0.5).mul(vec2(aspect, 1.0));
        const caus = vnoise2(p.mul(7.0).add(vec2(t.mul(0.2), t.mul(-0.15))));
        const water = mix(vec3(0.004, 0.02, 0.03), c2.mul(0.12), smoothstep(0.55, 0.9, caus));
        const fish = float(0).toVar();
        const spot = float(0).toVar();
        const span = min(aspect, float(1.0));
        for (let i = 0; i < 5; i++) {
          const a = t.mul(0.18 + i * 0.05).mul(i % 2 === 0 ? 1 : -1).add(seed.mul(6.28)).add(i * 1.7);
          const rr = float(0.12 + i * 0.06).mul(span);
          const c = vec2(cos(a), sin(a)).mul(rr);
          const dir = vec2(sin(a).negate(), cos(a)).mul(i % 2 === 0 ? 1 : -1);
          const lp = p.sub(c);
          const lx = dot(lp, dir);
          const ly = dot(lp, vec2(dir.y.negate(), dir.x));
          const L = float(0.15 + (i % 3) * 0.03);
          const bend = ly.sub(sin(lx.div(L).mul(5.0).sub(t.mul(4.0))).mul(L.mul(0.08)));
          const body = smoothstep(1.0, 0.8, length(vec2(lx.div(L), bend.div(L.mul(0.32)))));
          const tl = lx.add(L).negate().div(L); // 0 at the tail root, growing behind it
          const tail = step(0.0, tl).mul(step(tl, 0.55)).mul(step(abs(bend), tl.mul(L).mul(0.55).add(L.mul(0.05))));
          fish.assign(max(fish, max(body, tail.mul(0.8))));
          spot.assign(max(spot, body.mul(step(0.5, vnoise2(lp.div(L).mul(3.0).add(float(i * 3.1)))))));
        }
        const ripple = smoothstep(0.02, 0.0, abs(fract(length(p).mul(5.0).sub(t.mul(0.3))).sub(0.5))).mul(0.05);
        // koi colours, whatever the building's palette: white with orange-red patches
        const koiC = mix(vec3(1.0, 0.96, 0.9), vec3(1.0, 0.32, 0.08), spot);
        col.assign(water.add(c1.mul(ripple)).add(koiC.mul(fish).mul(1.3)));
      })
      .Else(() => {
        // product spin: a can turning in a radial burst, a price block below
        const p = g.sub(vec2(0.5, 0.55)).mul(vec2(aspect, 1.0));
        const ang = p.y.div(max(length(p), float(1e-3)));
        const burst = step(0.5, fract(ang.mul(3.0).add(t.mul(0.15)))).mul(0.25).add(0.1);
        const can = step(abs(p.x), float(0.16)).mul(step(abs(p.y), float(0.3)));
        const xs = p.x.div(0.16);
        const shade0 = sqrt(max(float(0.0), oneMinus(xs.mul(xs))));
        const spin = fract(xs.mul(0.3).add(t.mul(0.12)));
        const label = step(0.35, spin).mul(step(spin, 0.75));
        const spec = smoothstep(0.08, 0.0, abs(xs.add(0.45))).mul(0.8);
        const canC = mix(c1, c2, label).mul(shade0).add(vec3(spec));
        const price = step(0.06, g.y).mul(step(g.y, 0.16)).mul(step(0.2, g.x)).mul(step(g.x, 0.8));
        col.assign(mix(c2.mul(burst), canC.mul(1.3), can).add(c1.mul(price).mul(1.2)));
      });
    const out = col.mul(pix.mul(0.9).add(0.1)).mul(float(0.92).add(sin(t.mul(60.0).add(seed.mul(9.0))).mul(0.03))).add(vec3(0.004, 0.005, 0.008));
    return vec4(out.mul(1.25).mul(U.neon), 1.0);
  })();
  return m;
}

/**
 * Hologram billboard: additive, scanlined. aBB = (seed, program, aspect, glyph
 * family). Program 0 a slow rotating emblem, program 1 a column of glyphs.
 */
export function makeHoloMaterial(): THREE.MeshBasicNodeMaterial {
  const atlas = glyphAtlas();
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'holo';
  additive(m);
  const c = Fn(() => {
    const B = attribute('aBB', 'vec4');
    const c1 = attribute('aCol', 'vec3');
    const c2 = attribute('aCol2', 'vec3');
    const q = uv();
    // shared by both programmes: assigned before the branch (see the screen material)
    const p = vec2(0).toVar();
    p.assign(q.sub(0.5).mul(vec2(B.z, 1.0)));
    const t = float(0).toVar();
    t.assign(time.add(B.x.mul(50.0)));
    const shape = float(0).toVar();
    If(B.y.lessThan(0.5), () => {
      const r = length(p);
      const ring = smoothstep(0.02, 0.0, abs(r.sub(0.3).sub(sin(t.mul(0.8)).mul(0.02))));
      const ang = p.y.div(r.max(1e-3));
      const petals = smoothstep(0.1, 0.0, abs(fract(ang.mul(3.0).add(t.mul(0.2))).sub(0.5)).sub(0.25)).mul(step(r, 0.28)).mul(step(0.08, r));
      const fig = smoothstep(0.46, 0.0, abs(p.x).add(abs(p.y.sub(0.1)).mul(0.6))).mul(0.4);
      shape.assign(ring.mul(1.4).add(petals).add(fig));
    }).Else(() => {
      // a column of glyphs: square cells stacked up the projection, one lit at a time
      const n = max(floor(float(1.0).div(max(B.z, float(0.05)))), float(1.0));
      const gy = q.y.mul(n);
      const ri = floor(gy);
      const id = familyCell(B.w, hash12(vec2(ri, B.x.mul(91.0))));
      const s = atlasStroke(atlas, id, vec2(q.x, fract(gy)), float(0.3), float(0.1));
      const pulse = smoothstep(0.7, 1.0, sin(t.mul(1.5).sub(ri.mul(0.8))).mul(0.5).add(0.5));
      shape.assign(s.mul(pulse.mul(0.8).add(0.6)).add(smoothstep(0.06, 0.0, min(q.x, oneMinus(q.x))).mul(0.5)));
    });
    const scan = float(0.7).add(sin(q.y.mul(220.0).sub(t.mul(4.0))).mul(0.3));
    const edge = smoothstep(0.5, 0.42, max(abs(q.x.sub(0.5)), abs(q.y.sub(0.5))));
    const glitch = step(0.96, hash11(floor(t.mul(8.0)))).mul(0.6);
    const rgb = mix(c1, c2, q.y).mul(shape).mul(scan).mul(edge).mul(oneMinus(glitch)).mul(0.9).mul(U.neon);
    return vec4(fogAtten(rgb, positionWorld), 1.0);
  })();
  glowOnly(m, c);
  return m;
}

/** Steam plume (aS = phase, height, base radius, top radius; uv.y up the plume). */
export function makeSteamMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'steam';
  additive(m);
  const c = Fn(() => {
    const S = attribute('aS', 'vec4');
    const wp = positionWorld;
    const n = normalize(normalWorld);
    const V = normalize(cameraPosition.sub(wp));
    const facing = abs(dot(n, V));
    const v = uv().y;
    const t = time;
    const q = vec3(wp.x.mul(0.45).add(S.x.mul(53.0)), wp.y.mul(0.32).sub(t.mul(0.8)), wp.z.mul(0.45).add(S.x.mul(29.0)));
    const nz = mx_fractal_noise_float(q, 3, 2.0, 0.5).mul(0.55).add(0.5);
    const shape = smoothstep(0.0, 0.08, v).mul(oneMinus(smoothstep(0.42, 1.0, v)));
    const burst = sin(t.mul(0.7).add(S.x.mul(40.0))).mul(0.35).add(0.65);
    const dens = smoothstep(0.34, 0.82, nz.add(oneMinus(v).mul(0.25))).mul(shape).mul(pow(facing, 1.1)).mul(burst);
    const scatter = lightAt(wp).mul(2.2).add(vec3(U.skyHorizon).mul(1.2));
    return vec4(fogAtten(scatter.mul(dens).mul(0.85), wp), 1.0);
  })();
  glowOnly(m, c);
  return m;
}

/** Light cones under street lamps and searchlight beams (aB = intensity, softness, seed, _). */
export function makeBeamMaterial(): THREE.MeshBasicNodeMaterial {
  const m = new THREE.MeshBasicNodeMaterial();
  m.name = 'beam';
  additive(m);
  const c = Fn(() => {
    const B = attribute('aB', 'vec4');
    const C = attribute('aCol', 'vec3');
    const wp = positionWorld;
    const n = normalize(normalWorld);
    const V = normalize(cameraPosition.sub(wp));
    const facing = pow(abs(dot(n, V)), 2.4);
    const v = uv().y; // 0 at the source, 1 at the far end
    const along = pow(oneMinus(v), 2.2);
    const dust = mx_fractal_noise_float(wp.mul(0.12).add(vec3(0, time.mul(-0.4), 0)), 2, 2.0, 0.5).mul(0.35).add(0.75);
    const rgb = C.mul(B.x).mul(facing).mul(along).mul(dust).mul(U.fogDensity.mul(500.0)).mul(U.neon);
    return vec4(fogAtten(rgb, wp), 1.0);
  })();
  glowOnly(m, c);
  return m;
}

void shade;
void hash12;
