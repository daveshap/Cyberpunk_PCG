// Headless screenshots of the running app (vite dev server must be up).
//   node scripts/shot.mjs --views spawn,aerial,d:corporate --backend gl --out shots/a
// Views: spawn (chase camera), aerial, skyline, top, s:<district kind> (street level inside it),
// d:<district kind> (above and outside a district, looking at it), strip, res, park, metro, landmark,
// a:<archetype>, holo:<i>, mega:<i>, rholo:<i>, incident:<i>, fly:<kind>:<i>[:back:side:up], and pose
// (with --pose "x,y,z,yaw,pitch"), harbour (from the water at the waterfront skyline), and material close-ups:
// wall:<style>, close:<style> (facade styles glass, panel, grid, shop, balcony, metal, raw, lux), kerb, roofs:<district kind>.
// Append @screen=N to a view to force the LED screens to scene N, or @name=value&... to set lighting dials for
// that shot (main.ts tune(): post uniforms such as halo, scatter, bloomStrength; U.* such as fogDensity; local lights
// such as localgain, halos and kMax; near=0&far=1 turns the local lights off). Add --extra "fill=0.5" for a flat
// white fill light.
// Flags: --w --h --seed --extra "k=v&..." --frames N --url --backend gl|gpu --dom 1 --hud 1 --perf N (ms per frame,
// posed views only; timings drift between runs, so compare views timed in the same run)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
// playwright from the project if installed, else from a global install (PLAYWRIGHT_DIR or npm's global root)
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  const dir = process.env.PLAYWRIGHT_DIR ?? '/home/claude/.npm-global/lib/node_modules/';
  ({ chromium } = createRequire(dir.endsWith('/') ? dir : dir + '/')('playwright'));
}

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const base = opt('url', 'http://localhost:5174/');
const W = Number(opt('w', 1280));
const H = Number(opt('h', 720));
const backend = opt('backend', 'gl');
const outDir = opt('out', 'shots');
const views = String(opt('views', 'spawn')).split(',').filter(Boolean);
const frames = Number(opt('frames', backend === 'gpu' ? 10 : 4));
fs.mkdirSync(outDir, { recursive: true });

const q = new URLSearchParams();
q.set('still', '1');
q.set('nohud', '1');
if (backend === 'gl') q.set('gl', '1');
if (opt('seed')) q.set('seed', String(opt('seed')));
if (opt('extra')) for (const [k, v] of new URLSearchParams(String(opt('extra')))) q.set(k, v);
if (opt('hud')) q.delete('nohud');

const flags = ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--disable-vulkan-surface', '--use-webgpu-adapter=swiftshader', '--disable-gpu-sandbox'];
const browser = await chromium.launch({ headless: true, args: flags });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const logs = [];
if (backend === 'gpu') {
  await page.addInitScript(() => {
    const orig = GPUTexture.prototype.createView;
    GPUTexture.prototype.createView = function (d) {
      if (d && typeof d.swizzle === 'string') {
        d = { ...d };
        delete d.swizzle;
      }
      if (this.dimension === '3d' && d && d.dimension && d.dimension !== '3d') console.error('[view-debug] 3d texture view as ' + d.dimension + ' ' + this.width + 'x' + this.height + 'x' + this.depthOrArrayLayers + ' ' + new Error().stack.split('\n').slice(1, 6).join(' | '));
      return orig.call(this, d);
    };
    const req = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (desc) {
      const dev = await req.call(this, desc);
      dev.addEventListener('uncapturederror', (e) => console.error('[gpu-error] ' + (e.error && e.error.message)));
      return dev;
    };
  });
}
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning' || t === 'info' || t === 'log') logs.push(`[${t}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
const t0 = Date.now();
await page.goto(base + '?' + q.toString(), { waitUntil: 'load' });
try {
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 600000 });
} catch (e) {
  logs.push('[shot] timeout waiting for __ready');
}
console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const poses = await page.evaluate(() => {
  const g = window.__game;
  if (!g || !g.spec) return null;
  const s = g.spec;
  const out = {};
  const b = s.bounds;
  out.aerial = [b.x0 + (b.x1 - b.x0) * 0.15, 420, b.z1 + 200, -0.62, -0.32];
  out.skyline = [b.x0 - 300, 120, (b.z0 + b.z1) / 2, -Math.PI / 2, 0.03];
  out.top = [(b.x0 + b.x1) / 2, 1500, (b.z0 + b.z1) / 2 + 900, 0, -1.0];
  // harbour: out on the water looking north at the waterfront skyline (the classic
  // night skyline photo across a river or harbour); aimed at the tallest tower near the shore
  {
    const cz = (x) => s.coast.z[Math.max(0, Math.min(s.coast.z.length - 1, Math.round((x - s.coast.x0) / s.coast.step)))];
    const front = s.buildings.filter((q) => { const x = (q.rect.x0 + q.rect.x1) / 2; const z = (q.rect.z0 + q.rect.z1) / 2; return cz(x) - z > 0 && cz(x) - z < 700; });
    const tallest = front.sort((p, q) => q.height - p.height)[0];
    const hx = tallest ? (tallest.rect.x0 + tallest.rect.x1) / 2 : (b.x0 + b.x1) / 2;
    out.harbour = [hx, 22, cz(hx) + 900, 0, 0.1];
  }
  const world = g.flight && g.flight.world;
  const hAround = (x, z, r) => (world && world.heightAround ? world.heightAround(x, z, r) : 60);
  for (const d of s.districts) {
    const key = 'd:' + d.kind;
    if (out[key]) continue;
    // stand ~240 m from the district centre on the side with the lowest buildings,
    // above the local roofs, and look back at the centre
    const cx = d.x;
    const cz = d.z;
    let best = null;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2 + 0.4;
      const px = cx + Math.cos(a) * 240;
      const pz = cz + Math.sin(a) * 240;
      const h = hAround(px, pz, 40);
      if (!best || h < best.h) best = { px, pz, h };
    }
    const y = Math.max(70, best.h + 25);
    const yaw = Math.atan2(-(cx - best.px), -(cz - best.pz));
    const hc = hAround(cx, cz, 80);
    const pitch = Math.atan2(Math.max(20, hc * 0.5) - y, 240);
    out[key] = [best.px, y, best.pz, yaw, Math.max(-0.5, Math.min(0.1, pitch))];
  }
  // street level: on a street inside each district, looking along it
  for (const st of s.streets) {
    if (st.kind === 'highway') continue;
    const d = s.districts[st.district];
    if (!d) continue;
    const key = 's:' + d.kind;
    const len = st.hi - st.lo;
    if (len < 140) continue;
    if (out[key] && out[key].len >= len && st.kind !== 'local') continue;
    if (out[key] && out[key].local && st.kind !== 'local') continue;
    const along = st.lo + 25;
    const off = -(st.road / 2) + 2.5;
    const x = st.axis === 'x' ? along : st.pos + off;
    const z = st.axis === 'x' ? st.pos + off : along;
    const yaw = st.axis === 'x' ? -Math.PI / 2 : Math.PI;
    const pose = [x, 7, z, yaw, 0.06];
    pose.len = len;
    pose.local = st.kind === 'local';
    out[key] = pose;
  }
  // metro: beside the first station, looking at it
  const m = s.transit && s.transit.metro[0];
  if (m && m.stations.length && world) {
    // a free spot with a clear view of a station
    let pose = null;
    for (const st of m.stations) {
      for (const lat of [55, 80, 110, -55, -80, -110]) {
        for (const lon of [-40, 0, 40]) {
          for (const dy of [6, 14, 24]) {
            const px = st.axis === 'x' ? st.x + lon : st.x + lat;
            const pz = st.axis === 'x' ? st.z + lat : st.z + lon;
            const p = { x: px, y: m.y + dy, z: pz };
            if (world.blocked(p, 6)) continue;
            const dx = st.x - px;
            const dz = st.z - pz;
            const dd = Math.hypot(dx, dz);
            const hit = world.raycast(p, dx / dd, (m.y + 3 - p.y) / dd, dz / dd, dd - 12);
            if (hit !== null && hit !== undefined && hit < dd - 14) continue;
            pose = [px, p.y, pz, Math.atan2(-dx, -dz), Math.atan2(m.y + 2 - p.y, dd)];
            break;
          }
          if (pose) break;
        }
        if (pose) break;
      }
      if (pose) break;
    }
    if (pose) out.metro = pose;
  }
  // a nightlife strip at street level, a residential street, a park from above
  const strip = s.streets.find((x) => x.use === 'nightlife' && x.hi - x.lo > 100);
  const streetPose = (st) => {
    const along = st.lo + 20;
    const off = -(st.road / 2) + 2.2;
    return st.axis === 'x' ? [along, 6.5, st.pos + off, -Math.PI / 2, 0.08] : [st.pos + off, 6.5, along, Math.PI, 0.08];
  };
  if (strip) out.strip = streetPose(strip);
  const resBlock = s.blocks.find((b) => b.use === 'residential' && s.districts[b.district] && (s.districts[b.district].kind === 'cnmarket' || s.districts[b.district].kind === 'jpmarket'));
  if (resBlock) {
    const st = s.streets.find((x) => x.kind === 'local' && x.district === resBlock.district && (x.axis === 'x' ? Math.abs(x.pos - resBlock.plate.z0) < x.road || Math.abs(x.pos - resBlock.plate.z1) < x.road : Math.abs(x.pos - resBlock.plate.x0) < x.road || Math.abs(x.pos - resBlock.plate.x1) < x.road));
    if (st) out.res = streetPose(st);
  }
  const park = s.blocks.filter((b) => b.open === 'park').sort((a, b) => (b.rect.x1 - b.rect.x0) * (b.rect.z1 - b.rect.z0) - (a.rect.x1 - a.rect.x0) * (a.rect.z1 - a.rect.z0))[0];
  if (park) {
    const cx = (park.rect.x0 + park.rect.x1) / 2;
    const cz = (park.rect.z0 + park.rect.z1) / 2;
    out.park = [cx - 60, 38, cz + 60, Math.atan2(-60, 60), -0.42];
  }
  // megastructures: a:<archetype> frames the tallest building of that archetype
  // ('landmark' is the tallest pyramid) from the least occluded side
  const frame = (b, dist, lift) => {
    const cx = (b.rect.x0 + b.rect.x1) / 2;
    const cz = (b.rect.z0 + b.rect.z1) / 2;
    const ty = b.height * 0.5;
    // first free spot with a clear line of sight to the building's middle
    for (const dk of [1, 1.4, 1.9]) {
      for (const lk of [1, 1.5, 2.2]) {
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2 + 0.3;
          const d = dist * dk;
          const p = { x: cx + Math.cos(a) * d, y: Math.max(40, b.height * lift * lk), z: cz + Math.sin(a) * d };
          if (world && world.blocked && world.blocked(p, 8)) continue;
          const dx = cx - p.x;
          const dy = ty - p.y;
          const dz = cz - p.z;
          const dd = Math.hypot(dx, dy, dz);
          const hit = world && world.raycast ? world.raycast(p, dx / dd, dy / dd, dz / dd, dd) : null;
          const reach = Math.hypot(b.rect.x1 - b.rect.x0, b.rect.z1 - b.rect.z0) / 2 + 4;
          if (hit !== null && hit !== undefined && hit < dd - reach) continue;
          return [p.x, p.y, p.z, Math.atan2(-dx, -dz), Math.max(-0.8, Math.min(0.4, Math.atan2(dy, Math.hypot(dx, dz))))];
        }
      }
    }
    return [cx + dist, b.height * lift, cz, Math.PI / 2, 0];
  };
  const byArch = {};
  for (const b of s.buildings) if (!byArch[b.archetype] || b.height > byArch[b.archetype].height) byArch[b.archetype] = b;
  if (byArch.pyramid) out.landmark = frame(byArch.pyramid, byArch.pyramid.height * 1.6, 0.55);
  for (const [a, b] of Object.entries(byArch)) out['a:' + a] = frame(b, Math.max(90, b.height * 1.25), 0.5);
  // mega:<i> faces the i-th building-sized ad wall; rholo:<i> the i-th rooftop hologram
  const megas = s.signs.filter((x) => x.kind === 'screen' && x.program === 1);
  megas.forEach((x, i) => {
    const D = Math.max(x.w, x.h) * 1.3;
    const px = x.x + x.nx * D;
    const pz = x.z + x.nz * D;
    out['mega:' + i] = [px, x.y, pz, Math.atan2(x.nx, x.nz), 0];
  });
  const rh = s.signs.filter((x) => x.kind === 'holo' && x.arm > 2 && x.arm < 2.5);
  rh.forEach((x, i) => {
    const D = Math.max(x.w, x.h) * 2.2;
    const px = x.x + x.nx * D;
    const pz = x.z + x.nz * D;
    out['rholo:' + i] = [px, x.y + 4, pz, Math.atan2(x.nx, x.nz), -0.08];
  });
  // incident:<i> looks at a police ring over a street from outside it
  if (s.flyers) {
    s.flyers.incidents.forEach((inc, i) => {
      const D = inc.radius * 3.2;
      const px = inc.x + D * 0.7;
      const pz = inc.z + D * 0.7;
      const py = inc.y + 18;
      out['incident:' + i] = [px, py, pz, Math.atan2(-(inc.x - px), -(inc.z - pz)), Math.atan2(inc.y * 0.4 - py, D)];
    });
  }
  // holo:<i> looks at giant hologram i from its side (the hologram clock is frozen in still mode)
  if (g.holoHead && s.spectacle) {
    s.spectacle.holos.forEach((h, i) => {
      const hd = g.holoHead(i);
      if (!hd) return;
      const [hx, hy, hz, dx, dz] = hd;
      const back = h.kind === 'jelly' ? 0 : h.size * 0.4;
      const cx = hx - dx * back;
      const cz = hz - dz * back;
      const cy = h.kind === 'jelly' ? hy - h.size * 0.6 : hy;
      const D = h.kind === 'jelly' ? h.size * 3.2 : h.kind === 'serpent' ? h.size * 0.75 : h.size * 1.5;
      const px = cx + dz * D;
      const pz = cz - dx * D;
      const py = cy + D * 0.22;
      out['holo:' + i] = [px, py, pz, Math.atan2(-(cx - px), -(cz - pz)), Math.atan2(cy - py, D)];
    });
  }
  // material close-ups: wall:<style> faces a long wall of that facade style from ~24 m,
  // close:<style> from ~7 m low on the wall, kerb looks down a sidewalk and kerb, and
  // roofs:<kind> looks down over the roofs of a district from ~70 m above them
  const wallView = (style, D, yOf, skip = 0) => {
    let seen = 0;
    for (const b of s.buildings) {
      for (const t of b.tiers) {
        if (t.facade.style !== style || t.top || t.y1 - t.y0 < 8) continue;
        const n = t.poly.length;
        for (let i = 0; i < n; i++) {
          const a = t.poly[i];
          const q = t.poly[(i + 1) % n];
          const dx = q[0] - a[0];
          const dz = q[1] - a[1];
          const len = Math.hypot(dx, dz);
          if (len < 14) continue;
          const nx = dz / len;
          const nz = -dx / len;
          const mx = (a[0] + q[0]) / 2;
          const mz = (a[1] + q[1]) / 2;
          const y = Math.min(t.y1 - 2, Math.max(t.y0 + 1.7, yOf(t)));
          const p = { x: mx + nx * D, y, z: mz + nz * D };
          if (world && world.blocked && world.blocked(p, 1.5)) continue;
          const hit = world && world.raycast ? world.raycast(p, -nx, 0, -nz, D + 3) : null;
          if (hit !== null && hit !== undefined && hit < D - 1.5) continue;
          if (seen++ < skip) continue;
          return [p.x, p.y, p.z, Math.atan2(nx, nz), 0];
        }
      }
    }
    return null;
  };
  for (const st of ['glass', 'panel', 'grid', 'shop', 'balcony', 'metal', 'raw', 'lux']) {
    const w = wallView(st, 24, (t) => t.y0 + Math.min(16, (t.y1 - t.y0) * 0.45));
    if (w) out['wall:' + st] = w;
    const c = wallView(st, 7, (t) => t.y0 + 3.2, 1);
    if (c) out['close:' + st] = c;
  }
  {
    const st = s.streets.find((x) => x.kind === 'local' && x.hi - x.lo > 120 && s.districts[x.district] && s.districts[x.district].kind === 'cnmarket') ?? s.streets.find((x) => x.kind === 'local' && x.hi - x.lo > 120);
    if (st) {
      const along = st.lo + 30;
      const off = -(st.road / 2) - 1.6;
      out.kerb = st.axis === 'x' ? [along, 1.8, st.pos + off, -Math.PI / 2 - 0.3, -0.36] : [st.pos + off, 1.8, along, Math.PI + 0.3, -0.36];
    }
  }
  for (const d of s.districts) {
    const key = 'roofs:' + d.kind;
    if (out[key]) continue;
    const h = hAround(d.x, d.z, 120);
    const px = d.x + 110;
    const pz = d.z + 110;
    const y = Math.max(60, h + 70);
    out[key] = [px, y, pz, Math.atan2(-(d.x - px), -(d.z - pz)), -0.62];
  }
  for (const k of Object.keys(out)) out[k] = Array.from(out[k]);
  return out;
});
if (!poses) console.log('no __game; page logs follow');
const custom = opt('pose');
if (custom && poses) poses.pose = String(custom).split(',').map(Number);

for (const raw of views) {
  // view@screen=N forces the LED screens to scene N; view@halo=150&localgain=0.5 sets
  // lighting dials by name for this shot only (main.ts tune())
  const [v, extra] = raw.split('@');
  const ex = new URLSearchParams(extra ?? '');
  const scr = ex.has('screen') ? Number(ex.get('screen')) : -1;
  ex.delete('screen');
  await page.evaluate((n) => window.__game && window.__game.screenScene && window.__game.screenScene(n), scr);
  const dials = Object.fromEntries([...ex].map(([k, x]) => [k, Number(x)]));
  const restore = await page.evaluate((o) => (window.__game && window.__game.tune ? window.__game.tune(o) : {}), dials);
  const file = path.join(outDir, `${raw.replace(/:/g, '-').replace('@', '_').replace(/=/g, '').replace(/&/g, '_')}.png`);
  if (v.startsWith('fly:')) {
    // fly:<kind>:<i>[:back:side:up] rides along with a flyer
    const [, kind, idx, back, side, up] = v.split(':');
    const dflt = { police: [16, 9, 4], medevac: [20, 11, 5], hauler: [34, 16, 7], blimp: [150, 110, 30] }[kind] ?? [20, 10, 5];
    await page.evaluate(
      ([n, ms, kind, i, b, sd, u]) => window.__game.settleFollow(n, ms, kind, i, b, sd, u),
      [frames, backend === 'gpu' ? 80 : 0, kind, Number(idx ?? 0), Number(back ?? dflt[0]), Number(side ?? dflt[1]), Number(up ?? dflt[2])],
    );
  } else if (v === 'spawn') {
    await page.evaluate(([n]) => window.__game.settle(n, window.__game.backend === 'WebGPU' ? 80 : 0), [frames]);
  } else {
    if (!poses || !poses[v]) {
      console.log('unknown view', v);
      continue;
    }
    await page.evaluate(([p, n]) => window.__game.settle(n, window.__game.backend === 'WebGPU' ? 80 : 0, p), [poses[v], frames]);
    if (opt('perf')) {
      // rough shader cost: ms per frame over N frames, synced by reading the frame back
      const ms = await page.evaluate(async ([p, n]) => {
        const g = window.__game;
        await g.capture();
        const t0 = performance.now();
        await g.settle(n, 0, p);
        await g.capture();
        return (performance.now() - t0) / n;
      }, [poses[v], Number(opt('perf'))]);
      console.log('perf', raw, ms.toFixed(1), 'ms/frame');
    }
  }
  if (opt('dom')) {
    // page screenshot (includes the HUD and the zoning deck)
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.screenshot({ path: file });
  } else {
    const url = await page.evaluate(() => window.__game.capture());
    fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  }
  await page.evaluate((o) => window.__game && window.__game.tune && window.__game.tune(o), restore);
  console.log('wrote', file);
}
fs.writeFileSync(path.join(outDir, 'log.txt'), logs.join('\n'));
const seen = new Set();
const uniq = logs.filter((l) => (seen.has(l) ? false : seen.add(l)));
console.log(uniq.slice(0, Number(opt('log', 40))).join('\n'));
await browser.close();
