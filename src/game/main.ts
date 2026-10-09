/**
 * Neon Sprawl entry point: renderer (WebGPU with WebGL2 fallback), city
 * generation and rebuilds, flight, chase camera, guided flight, UI and the
 * post pipeline.
 */
import * as THREE from 'three/webgpu';
import { FlightWorld, PROFILES, generateCity, resolveDials } from '../core';
import type { CitySpec, Dials } from '../core';
import { buildCityRender, type CityRender } from '../render/city';
import { createPost, type PostHandle } from '../render/post';
import { HoverCar } from '../render/car';
import { U } from '../render/tsl';
import { LLU } from '../render/locallights';
import { HOLO_T, freezeHolograms, holoHead } from '../render/spectacle';
import { Input } from './input';
import { Flight, type FlightControls } from './flight';
import { ChaseCam } from './camera';
import { Autopilot } from './autopilot';
import { Ui, PRESETS, type LiveSettings } from './ui';

declare global {
  interface Window {
    __ready?: boolean;
    __game?: unknown;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));

interface QualitySpec {
  ratio: number;
  traa: boolean;
  fogScale: number;
  fogSteps: number;
  detail: number;
  ssr: { steps: number; scale: number } | null;
  /** Local lights: reach from the camera (0 = off), street lights per cell, halos per frame. */
  local: { far: number; k: number; halos: number };
  /** Ambient occlusion: resolution scale and samples (null = off). */
  ao: { scale: number; samples: number } | null;
}
const QUALITY: Record<string, QualitySpec> = {
  low: { ratio: 0.75, traa: false, fogScale: 0.33, fogSteps: 8, detail: 260, ssr: null, local: { far: 0, k: 0, halos: 0 }, ao: null },
  medium: { ratio: 1, traa: true, fogScale: 0.5, fogSteps: 10, detail: 340, ssr: null, local: { far: 420, k: 6, halos: 16 }, ao: { scale: 0.5, samples: 8 } },
  high: { ratio: 1.25, traa: true, fogScale: 0.5, fogSteps: 14, detail: 420, ssr: { steps: 22, scale: 0.5 }, local: { far: 760, k: 12, halos: 40 }, ao: { scale: 0.5, samples: 12 } },
  ultra: { ratio: 2, traa: true, fogScale: 0.75, fogSteps: 18, detail: 600, ssr: { steps: 30, scale: 0.5 }, local: { far: 1000, k: 12, halos: 40 }, ao: { scale: 0.75, samples: 16 } },
};

/**
 * Haze extinction per metre at street level at the default haze dial. Thick enough that
 * the city recedes: about half the light of a tower 500 m away reaches the eye.
 */
const FOG_BASE = 0.0016;

async function main(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const still = q.has('still');
  if (q.has('screen')) U.screenScene.value = Number(q.get('screen'));
  // debug: scale the baked city light (?lightgain=0.3)
  if (q.has('lightgain')) U.lightGain.value = Number(q.get('lightgain'));
  // debug: flat white fill light to inspect materials (?fill=0.5)
  if (q.has('fill')) U.fill.value = Number(q.get('fill'));
  // freeze the giant holograms at a clock time (screenshots); still mode freezes them at 20 s by default
  if (q.has('holot') || still) freezeHolograms(Number(q.get('holot') ?? 20));
  let seed = q.get('seed') ?? 'sprawl';
  const preset = PRESETS.find((p) => p.name.toLowerCase().replace(/\s+/g, '-') === (q.get('preset') ?? ''));
  let dials: Dials = resolveDials({
    ...(preset?.dials ?? {}),
    ...(q.get('size') ? { size: Number(q.get('size')) } : {}),
    ...(q.get('alien') ? { alien: Number(q.get('alien')) } : {}),
    ...(q.get('world') === 'hive' ? { world: 'hive' as const } : {}),
  });

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block;outline:none;touch-action:none';
  document.body.appendChild(canvas);

  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, forceWebGL: q.has('gl'), reversedDepthBuffer: q.has('reverse'), powerPreference: 'high-performance' });
  renderer.toneMapping = q.get('tm') === 'agx' ? THREE.AgXToneMapping : THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = Number(q.get('exposure') ?? 1.0);
  await renderer.init();
  const backend = (renderer.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  let quality = q.get('q') ?? (backend === 'WebGPU' ? 'high' : 'medium');
  // ?noguard keeps the quality where it is (the frame-rate guard below lowers it when frames are slow)
  const noGuard = q.has('noguard');
  if (!QUALITY[quality]) quality = 'medium';

  const scene = new THREE.Scene();
  // lens: ?fov= sets the base vertical field of view (photo comps often want 30-45, i.e. a longer lens)
  const baseFov = Math.max(10, Math.min(100, Number(q.get('fov') ?? 66)));
  const camera = new THREE.PerspectiveCamera(baseFov, 1, 1.0, 14000);
  scene.add(camera);
  const resize = (): void => {
    const Q = QUALITY[quality]!;
    renderer.setPixelRatio(still ? 1 : Math.min(devicePixelRatio || 1, Q.ratio));
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / Math.max(1, innerHeight);
    camera.updateProjectionMatrix();
  };
  resize();
  addEventListener('resize', resize);

  const car = new HoverCar();
  scene.add(car.group);

  const live: LiveSettings = { fog: Number(q.get('fog') ?? 1), rain: q.has('dry') ? 0 : Number(q.get('rain') ?? 0.6), neon: Number(q.get('neon') ?? 1), traffic: 1, exposure: Number(q.get('exposure') ?? 1) };
  // the hive's air is a deep, tall murk: it thins out slowly with height, so every level
  // of the canyons sinks into it (scale height about 1.2 km instead of 220 m)
  let fogBase = FOG_BASE;
  const applyLive = (s: LiveSettings): void => {
    U.fogDensity.value = fogBase * s.fog;
    U.rain.value = s.rain;
    U.wet.value = Math.min(1, 0.35 + s.rain);
    U.neon.value = s.neon;
    renderer.toneMappingExposure = s.exposure;
    if (city) city.traffic.density = s.traffic;
  };

  let spec!: CitySpec;
  let city: CityRender | null = null;
  let world!: FlightWorld;
  let flight!: Flight;
  let chase!: ChaseCam;
  let autopilot!: Autopilot;
  let auto = q.has('auto');
  let attract = !still;
  let post: PostHandle;

  const input = new Input(canvas);
  // debug dials by short name: post-pass uniforms, the shared U uniforms, local lights
  const tunable = (k: string): { value: unknown } | null => {
    const alias: Record<string, string> = { localgain: 'gain', halo: 'haloGain', halog: 'haloG' };
    const key = alias[k] ?? k;
    const pu = post?.u as Record<string, { value: unknown }> | undefined;
    if (pu && pu[key]) return pu[key]!;
    if (key in LLU) return (LLU as Record<string, { value: unknown }>)[key]!;
    if (key in U) return (U as Record<string, { value: unknown }>)[key]!;
    return null;
  };
  const makePost = (): void => {
    const Q = QUALITY[quality]!;
    U.detailDist.value = Q.detail;
    // local lights by quality; with none (low) surfaces and haze fall back to the baked light alone
    LLU.near.value = Q.local.far > 0 ? Q.local.far * 0.68 : 0;
    LLU.far.value = Q.local.far > 0 ? Q.local.far : 1;
    LLU.kMax.value = Q.local.k;
    LLU.halos.value = Q.local.halos;
    const ssr = q.has('nossr') ? null : q.has('ssr') ? (Q.ssr ?? { steps: 22, scale: 0.5 }) : Q.ssr;
    const aoQ = q.has('noao') ? null : Q.ao;
    // free the old chain's render targets before building the new one
    (post as PostHandle | undefined)?.dispose();
    post = createPost(renderer, scene, camera, { traa: Q.traa && !q.has('notaa'), fogScale: Q.fogScale, fogSteps: Q.fogSteps, bloom: true, ssr, ao: aoQ });
    applyT();
  };
  // debug: ?t.halo=150&t.localgain=0.5 sets dials by name (see tunable); applied again
  // after every build, which sets the world's own haze and shafts
  const applyT = (): void => {
    for (const [k, v] of q) {
      if (!k.startsWith('t.')) continue;
      const u = tunable(k.slice(2));
      if (u) u.value = Number(v);
    }
  };

  const ui = new Ui(
    dials,
    seed,
    live,
    {
      onRegenerate: (s, d) => {
        seed = s;
        dials = d;
        void build();
      },
      onLive: applyLive,
      onQuality: (v) => {
        quality = v;
        resize();
        makePost();
        ui.toast('QUALITY ' + v.toUpperCase());
      },
      onTeleport: (x, z) => {
        flight.teleport(x, Math.max(80, world.heightAround(x, z, 30) + 30), z, flight.yaw, -0.1);
        auto = false;
      },
      onAutopilot: () => {
        auto = true;
        autopilot.start(flight);
      },
      onStart: () => {
        attract = false;
        ui.hideStart();
        input.requestLock();
      },
    },
    quality,
  );

  let building = false;
  async function build(): Promise<void> {
    if (building) return;
    building = true;
    ui.setBusy(true);
    await nextFrame();
    await nextFrame();
    const t0 = performance.now();
    spec = generateCity({ seed, dials }, () => performance.now());
    const hive = spec.dials.world === 'hive';
    fogBase = hive ? 0.0019 : FOG_BASE;
    U.fogFalloff.value = hive ? 0.0006 : 0.0045;
    // light from the upper levels comes down the hive's canyons in shafts
    U.shaft.value = hive ? 0.18 : 0;
    applyT();
    if (city) {
      scene.remove(city.root);
      city.dispose();
    }
    city = buildCityRender(spec);
    scene.add(city.root);
    world = new FlightWorld(spec.boxes);
    if (!flight) flight = new Flight(world);
    else flight.setWorld(world);
    flight.ceiling = Math.max(700, world.maxY + 200);
    flight.teleport(spec.spawn.x, spec.spawn.y, spec.spawn.z, spec.spawn.yaw, -0.04);
    if (!chase) {
      chase = new ChaseCam(camera, world);
      chase.baseFov = baseFov;
    }
    else chase.setWorld(world);
    autopilot = new Autopilot(spec, world);
    if (auto) autopilot.start(flight);
    ui.setSpec(spec);
    applyLive(ui.live);
    snapSky = true;
    // debug: ?hide=land,sea,wall,... hides meshes by name
    const hide = (q.get('hide') ?? '').split(',').filter(Boolean);
    if (hide.length) city.root.traverse((o) => {
      if (hide.some((h) => (h.endsWith('*') ? o.name.startsWith(h.slice(0, -1)) : o.name === h))) {
        o.visible = false;
        o.userData.forceHidden = true;
      }
    });
    console.info(
      `[city] seed=${seed} ${spec.stats.buildings} buildings, ${spec.stats.signs} signs, ${spec.stats.kits} kits; gen ${spec.stats.ms.toFixed(0)} ms, render build ${city.stats.buildMs.toFixed(0)} ms (bake ${city.stats.bakeMs.toFixed(0)} ms), ${city.stats.meshes} meshes, ${city.stats.instances} instances, ${city.stats.localLights} local lights, ${(city.stats.triangles / 1e6).toFixed(2)}M tris, ${city.lights.counts.lights} lights, ${city.lights.counts.cars} cars; total ${(performance.now() - t0).toFixed(0)} ms`,
    );
    ui.setBusy(false);
    building = false;
  }

  // ---- sky glow follows the districts around the camera (sodium over the docks,
  // magenta over the markets, cool white over the core)
  const skyTarget = { a: new THREE.Color(0.55, 0.07, 0.4), b: new THREE.Color(0.03, 0.3, 0.55), h: new THREE.Color(0.05, 0.025, 0.06) };
  let skyClock = 1;
  let snapSky = true;
  const camPos = new THREE.Vector3();
  const updateSky = (dt: number, snapNow = false): void => {
    const snap = snapNow || snapSky;
    snapSky = false;
    skyClock += dt;
    if (skyClock > 0.25 || snap) {
      skyClock = 0;
      camera.getWorldPosition(camPos);
      const acc = { a: [0, 0, 0], b: [0, 0, 0], h: [0, 0, 0], w: 0 };
      for (const [dx, dz, w] of [
        [0, 0, 3],
        [450, 0, 1],
        [-450, 0, 1],
        [0, 450, 1],
        [0, -450, 1],
        [900, 900, 0.5],
        [-900, 900, 0.5],
        [900, -900, 0.5],
        [-900, -900, 0.5],
      ] as const) {
        const d = spec.districts[districtUnder(spec, camPos.x + dx, camPos.z + dz)];
        if (!d) continue;
        const s = PROFILES[d.kind].sky;
        for (let c = 0; c < 3; c++) {
          acc.a[c]! += s.a[c]! * w;
          acc.b[c]! += s.b[c]! * w;
          acc.h[c]! += s.horizon[c]! * w;
        }
        acc.w += w;
      }
      if (acc.w > 0) {
        skyTarget.a.setRGB(acc.a[0]! / acc.w, acc.a[1]! / acc.w, acc.a[2]! / acc.w);
        skyTarget.b.setRGB(acc.b[0]! / acc.w, acc.b[1]! / acc.w, acc.b[2]! / acc.w);
        skyTarget.h.setRGB(acc.h[0]! / acc.w, acc.h[1]! / acc.w, acc.h[2]! / acc.w);
      }
    }
    const k = snap ? 1 : 1 - Math.exp(-dt * 0.7);
    (U.glowA.value as THREE.Color).lerp(skyTarget.a, k);
    (U.glowB.value as THREE.Color).lerp(skyTarget.b, k);
    (U.skyHorizon.value as THREE.Color).lerp(skyTarget.h, k);
  };

  makePost();
  await build();

  input.onEngage = () => {
    if (attract) {
      attract = false;
      ui.hideStart();
    }
  };
  input.onKey = (code) => {
    if (code === 'KeyF') {
      auto = !auto;
      if (auto) autopilot.start(flight);
      ui.toast(auto ? 'GUIDED FLIGHT' : 'MANUAL CONTROL');
    } else if (code === 'KeyT') {
      ui.live.rain = ui.live.rain > 0.05 ? 0 : 0.6;
      applyLive(ui.live);
      ui.toast(ui.live.rain > 0 ? 'RAIN ON' : 'RAIN OFF');
    } else if (code === 'KeyG') ui.toggleDeck();
    else if (code === 'KeyM') ui.toggleMap();
    else if (code === 'KeyH') ui.toggleHud();
    else if (code === 'KeyR') flight.teleport(spec.spawn.x, spec.spawn.y, spec.spawn.z, spec.spawn.yaw, -0.04);
    else if (code === 'KeyZ') {
      // lens: wide (66) -> normal (45) -> long (30) -> tele (20); a long lens stacks the skyline like the photo comps
      const lenses = [66, 45, 30, 20];
      const i = lenses.findIndex((f) => Math.abs(f - chase.baseFov) < 0.5);
      chase.baseFov = lenses[(i + 1) % lenses.length]!;
      ui.toast('LENS ' + Math.round(chase.baseFov) + '°');
    }
    else if (code.startsWith('Digit')) {
      const n = Number(code.slice(5)) - 1;
      const kinds = ['corporate', 'jpmarket', 'cnmarket', 'megablock', 'industrial', 'decayed', 'luxury'];
      const d = spec.districts.find((x) => x.kind === kinds[n]);
      if (d) {
        flight.teleport(d.x, Math.max(70, world.heightAround(d.x, d.z, 40) + 25), d.z, flight.yaw, -0.15);
        auto = false;
      }
    }
  };

  // ---- loop
  const controls: FlightControls = { x: 0, y: 0, z: 0, boost: false, lookX: 0, lookY: 0 };
  let last = performance.now();
  let fpsAcc = 0;
  let fpsN = 0;
  let fps = 60;
  let slowFor = 0;
  const bootAt = performance.now();
  let attractT = 0;
  const frame = (dt: number, raw: number): void => {
    if (city && !building) {
      const [lx, ly] = input.consumeLook();
      const [ax, ay, az] = input.axes();
      const wheel = input.consumeWheel();
      if (wheel) chase.zoom(wheel);
      if (attract) {
        // guided flight behind the title card
        attractT += dt;
        autopilot.drive(flight, dt, controls);
      } else if (auto) {
        if (input.activity && (ax !== 0 || ay !== 0 || az !== 0)) {
          auto = false;
          ui.toast('MANUAL CONTROL');
        }
        autopilot.drive(flight, dt, controls);
        controls.lookX = lx;
        controls.lookY = ly;
      } else {
        controls.x = ax;
        controls.y = ay;
        controls.z = az;
        controls.boost = input.boost;
        controls.lookX = lx;
        controls.lookY = ly;
      }
      input.activity = 0;
      if (!still) flight.update(dt, controls);
      // car transform
      car.group.position.set(flight.x, flight.y - 0.6, flight.z);
      car.group.rotation.set(-flight.visPitch, flight.yaw + Math.PI, flight.roll, 'YXZ');
      car.thrust.value = flight.throttleVis;
      car.brake.value = flight.braking;
      if (!still || !q.has('freecam')) chase.update(flight, dt);
      city.update(camera, dt);
      updateSky(dt);
      post.frame();
    }
    post.render();
    fpsAcc += raw;
    fpsN++;
    if (fpsAcc > 0.5) {
      fps = fpsN / fpsAcc;
      fpsAcc = 0;
      fpsN = 0;
      if (!still && !noGuard && quality !== 'low' && performance.now() - bootAt > 10000) {
        slowFor = fps < 22 ? slowFor + 0.5 : 0;
        if (slowFor >= 4) {
          slowFor = 0;
          quality = quality === 'ultra' ? 'high' : quality === 'high' ? 'medium' : 'low';
          resize();
          makePost();
          ui.toast('QUALITY ' + quality.toUpperCase(), 'lowered to keep the frame rate');
        }
      }
      if (city) {
        const info = renderer.info.render as unknown as { calls?: number; drawCalls?: number; triangles: number };
        ui.update({
          speed: flight.speed,
          alt: flight.y,
          x: flight.x,
          z: flight.z,
          yaw: flight.yaw,
          district: districtUnder(spec, flight.x, flight.z),
          use: useUnder(spec, flight.x, flight.z),
          autopilot: auto || attract,
          fps,
          draws: info.drawCalls ?? info.calls ?? 0,
          tris: info.triangles ?? 0,
          backend,
          seed,
          quality,
        });
      }
    }
  };

  // ---- screenshot / test API
  const setPose = (x: number, y: number, z: number, yaw: number, pitch = 0, camDist?: number): void => {
    flight.teleport(x, y, z, yaw, pitch);
    flight.vx = flight.vy = flight.vz = 0;
    if (camDist !== undefined) chase.distance = camDist;
    chase.setWorld(world);
  };
  const freeCam = (x: number, y: number, z: number, yaw: number, pitch: number): void => {
    if (Math.abs(camera.fov - baseFov) > 0.01) {
      camera.fov = baseFov;
      camera.updateProjectionMatrix();
    }
    camera.position.set(x, y, z);
    camera.rotation.set(pitch, yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
  };
  const api = {
    THREE,
    renderer,
    scene,
    camera,
    get spec() {
      return spec;
    },
    get city() {
      return city;
    },
    get flight() {
      return flight;
    },
    get post() {
      return post;
    },
    ui,
    backend,
    setPose,
    freeCam,
    car,
    /** Debug: force every LED screen to one scene (-1 runs the programmes). */
    screenScene(n: number): void {
      U.screenScene.value = n;
    },
    /**
     * Debug: set lighting and post dials by name (post uniforms, U.*, local lights;
     * see tunable). Returns the previous values so a caller can restore them.
     */
    tune(o: Record<string, number>): Record<string, number> {
      const prev: Record<string, number> = {};
      for (const [k, v] of Object.entries(o)) {
        const u = tunable(k);
        if (!u) continue;
        prev[k] = u.value as number;
        u.value = v;
      }
      return prev;
    },
    /** Position and heading of the i-th flyer of a kind (police, medevac, hauler, blimp). */
    flyerPose(kind: string, i: number): number[] | null {
      return city ? city.flyers.pose(kind as never, i) : null;
    },
    /** Head position and heading of hologram i at the current hologram clock. */
    holoHead(i: number): number[] | null {
      const h = spec?.spectacle.holos[i];
      return h ? holoHead(h, HOLO_T.value as number) : null;
    },
    async regenerate(s: string, d: Partial<Dials>) {
      seed = s;
      dials = resolveDials({ ...dials, ...d });
      await build();
    },
    async settle(n: number, ms = 30, freecamPose?: number[]) {
      car.group.visible = !freecamPose;
      snapSky = true;
      for (let i = 0; i < n; i++) {
        if (freecamPose) {
          car.group.visible = false;
          freeCam(freecamPose[0]!, freecamPose[1]!, freecamPose[2]!, freecamPose[3]!, freecamPose[4]!);
          city!.update(camera, 1 / 30);
          updateSky(1 / 30);
          post.frame();
          post.render();
        } else frame(1 / 30, 1 / 30);
        await sleep(ms);
      }
    },
    /**
     * Like settle, but the camera rides along with the i-th flyer of a kind:
     * `back` metres behind it, `side` to its left, `up` above, looking at it.
     */
    async settleFollow(n: number, ms: number, kind: string, i: number, back: number, side: number, up: number) {
      car.group.visible = false;
      snapSky = true;
      for (let k = 0; k < n; k++) {
        const p = city!.flyers.pose(kind as never, i);
        if (!p) return;
        const [x, y, z, yaw] = p as [number, number, number, number];
        const fx = Math.sin(yaw);
        const fz = Math.cos(yaw);
        // the craft's left (local +x) is (cos yaw, -sin yaw)
        const cx = x - fx * back + Math.cos(yaw) * side;
        const cz = z - fz * back - Math.sin(yaw) * side;
        const cy = y + up;
        freeCam(cx, cy, cz, Math.atan2(-(x - cx), -(z - cz)), Math.atan2(y - cy, Math.hypot(x - cx, z - cz)));
        city!.update(camera, 1 / 30);
        updateSky(1 / 30);
        post.frame();
        post.render();
        await sleep(ms);
      }
    },
    async capture(): Promise<string> {
      const v = renderer.getDrawingBufferSize(new THREE.Vector2());
      const rt = new THREE.RenderTarget(v.x, v.y, { type: THREE.UnsignedByteType, depthBuffer: false });
      renderer.setRenderTarget(rt);
      post.render();
      renderer.setRenderTarget(null);
      const buf = (await renderer.readRenderTargetPixelsAsync(rt, 0, 0, v.x, v.y)) as Uint8Array;
      const c = document.createElement('canvas');
      c.width = v.x;
      c.height = v.y;
      const ctx = c.getContext('2d')!;
      const img = ctx.createImageData(v.x, v.y);
      const flip = backend === 'WebGL2';
      for (let y = 0; y < v.y; y++) {
        const src = (flip ? v.y - 1 - y : y) * v.x * 4;
        img.data.set(buf.subarray(src, src + v.x * 4), y * v.x * 4);
      }
      ctx.putImageData(img, 0, 0);
      rt.dispose();
      return c.toDataURL('image/png');
    },
  };
  window.__game = api;

  if (still) {
    ui.hideStart();
    attract = false;
    if (q.has('nohud')) ui.toggleHud();
    await api.settle(backend === 'WebGPU' ? 30 : Number(q.get('warm') ?? 3), backend === 'WebGPU' ? 60 : 0);
    window.__ready = true;
    return;
  }

  if (backend === 'WebGPU') await api.settle(20, 50);
  renderer.setAnimationLoop((t) => {
    const now = t ?? performance.now();
    const raw = Math.max(1e-4, (now - last) / 1000);
    const dt = Math.min(0.05, raw);
    last = now;
    frame(dt, raw);
  });
  window.__ready = true;
}

function useUnder(spec: CitySpec, x: number, z: number): string {
  for (const b of spec.blocks) {
    const p = b.plate;
    if (x >= p.x0 - 8 && x <= p.x1 + 8 && z >= p.z0 - 8 && z <= p.z1 + 8) return b.use;
  }
  return '';
}

function districtUnder(spec: CitySpec, x: number, z: number): number {
  for (const sb of spec.superblocks) {
    const r = sb.rect;
    if (x >= r.x0 - 12 && x <= r.x1 + 12 && z >= r.z0 - 12 && z <= r.z1 + 12) return sb.land ? sb.district : -1;
  }
  return -1;
}

main().catch((e) => {
  console.error(e);
  const d = document.createElement('pre');
  d.style.cssText = 'position:fixed;left:12px;top:12px;right:12px;color:#ff8ab0;font:12px monospace;white-space:pre-wrap;z-index:9';
  d.textContent = 'Failed to start: ' + (e && e.stack ? e.stack : String(e));
  document.body.appendChild(d);
  window.__ready = true;
});
