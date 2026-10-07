// @ts-nocheck -- TSL node graphs are dynamically typed.
/**
 * Rain for a moving camera: a box of streaks that wraps around the camera in
 * world space (so it parallaxes correctly at flying speed), each streak a thin
 * quad stretched along the relative velocity of the drop and the camera.
 * Lit by the light volume, so rain glows where the neon is.
 */
import * as THREE from 'three/webgpu';
import { Fn, attribute, cameraPosition, float, fract, length, mix, normalize, positionGeometry, smoothstep, time, uniform, uv, vec3, vec4, cross, abs, max, oneMinus, positionWorld, mrt } from 'three/tsl';
import { U, fogAtten, lightAt } from './tsl';

const N = 24000;
const BOX = 140;

export class Rain {
  readonly mesh: THREE.Mesh;
  /** Camera velocity in m/s (world), used to slant the streaks. */
  readonly camVel = uniform(new THREE.Vector3());
  private readonly last = new THREE.Vector3();
  private hasLast = false;

  constructor() {
    const base = new THREE.PlaneGeometry(1, 1, 1, 1);
    base.translate(0, 0.5, 0);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute('position', base.getAttribute('position'));
    g.setAttribute('uv', base.getAttribute('uv'));
    const seeds = new Float32Array(N * 4);
    let s = 1234567;
    const rnd = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < N; i++) {
      seeds[i * 4] = rnd();
      seeds[i * 4 + 1] = rnd();
      seeds[i * 4 + 2] = rnd();
      seeds[i * 4 + 3] = rnd();
    }
    g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4));
    g.instanceCount = N;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

    const m = new THREE.MeshBasicNodeMaterial();
    m.name = 'rain';
    m.transparent = true;
    m.depthWrite = false;
    m.blending = THREE.AdditiveBlending;
    m.side = THREE.DoubleSide;
    m.fog = false;
    const camVel = this.camVel;
    const S = attribute('aSeed', 'vec4');
    const fall = 26.0;
    m.positionNode = Fn(() => {
      // drop centre, wrapped into a box around the camera
      const p0 = vec3(S.x, S.y, S.z).mul(BOX);
      const drift = vec3(time.mul(1.5), time.mul(-fall).mul(mix(0.85, 1.15, S.w)), time.mul(0.6));
      const rel = fract(p0.add(drift).sub(cameraPosition).div(BOX)).sub(0.5).mul(BOX);
      const center = cameraPosition.add(rel);
      // streak direction: drop velocity relative to the camera
      const v = vec3(1.5, -fall, 0.6).sub(camVel);
      const speed = length(v).max(0.001);
      const dir = v.div(speed);
      const len = mix(0.5, 1.2, S.w).mul(speed.div(fall)).clamp(0.4, 6.0);
      const toCam = normalize(cameraPosition.sub(center));
      const side = normalize(cross(dir, toCam)).mul(0.012).mul(length(rel).mul(0.02).add(1.0));
      const g = positionGeometry;
      return center.add(dir.mul(g.y.sub(0.5).mul(len))).add(side.mul(g.x.mul(2.0)));
    })();
    const c = Fn(() => {
      const q = uv();
      const along = smoothstep(0.0, 0.5, q.y).mul(oneMinus(smoothstep(0.5, 1.0, q.y)));
      const across = oneMinus(abs(q.x.sub(0.5)).mul(2.0));
      const wp = positionWorld;
      const d = length(wp.sub(cameraPosition));
      const near = smoothstep(2.0, 6.0, d).mul(oneMinus(smoothstep(BOX * 0.35, BOX * 0.5, d)));
      const base = vec3(0.5, 0.62, 0.9).mul(0.07).add(lightAt(wp).mul(0.6));
      return vec4(fogAtten(base.mul(along).mul(across).mul(near).mul(U.rain).mul(1.4), wp), 1.0);
    })();
    m.colorNode = vec4(0, 0, 0, 0);
    m.mrtNode = mrt({ output: vec4(0, 0, 0, 0), glow: c, velocity: vec4(0, 0, 0, 0) });
    this.mesh = new THREE.Mesh(g, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.name = 'rain';
    void max;
    void float;
  }

  update(camera: THREE.Camera, dt: number): void {
    const p = new THREE.Vector3();
    camera.getWorldPosition(p);
    if (this.hasLast && dt > 0) {
      const v = p.clone().sub(this.last).divideScalar(Math.max(dt, 1e-3));
      // a teleport or a stalled frame is not motion: drop it rather than smearing the drops
      if (v.length() > 220) v.set(0, 0, 0);
      this.camVel.value.lerp(v, Math.min(1, dt * 8));
    }
    this.last.copy(p);
    this.hasLast = true;
    this.mesh.visible = U.rain.value > 0.02;
  }
}
