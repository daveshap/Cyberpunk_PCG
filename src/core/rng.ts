/**
 * Deterministic, seedable random utilities.
 *
 * Rule for this folder: nothing under src/core may call Math.random or read the
 * clock. Every random decision flows from a forked Rng so that the same seed
 * always produces the same city, on any machine, in any order of generation.
 */

/** FNV-1a 32-bit string hash. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** lowbias32 integer mixer (good avalanche, fast). */
export function mix32(x: number): number {
  x = x >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Hash of a seed and two integer coordinates, uint32. */
export function hash2i(seed: number, x: number, y: number): number {
  let h = (seed >>> 0) ^ Math.imul(x | 0, 0x27d4eb2d);
  h = mix32(h) ^ Math.imul(y | 0, 0x165667b1);
  return mix32(h);
}

/** Hash of a seed and two integer coordinates mapped to [0, 1). */
export function hash01(seed: number, x: number, y: number): number {
  return hash2i(seed, x, y) / 4294967296;
}

/** Smooth 2D value noise in [0, 1]. */
export function noise2(seed: number, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash01(seed, xi, yi);
  const b = hash01(seed, xi + 1, yi);
  const c = hash01(seed, xi, yi + 1);
  const d = hash01(seed, xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Fractal value noise, normalised to [0, 1]. */
export function fbm2(seed: number, x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  let amp = 1;
  let sum = 0;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2(seed + i * 101, fx, fy);
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return sum / norm;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export function seedToNumber(seed: string | number): number {
  if (typeof seed === 'string') return hashString(seed);
  return mix32(Math.floor(seed) >>> 0);
}

/**
 * mulberry32 stream with an immutable base seed. `fork(label)` derives an
 * independent stream from the base seed and a label only (never from consumed
 * state), so adding or removing draws in one stage never perturbs another.
 */
export class Rng {
  readonly seed: number;
  private state: number;

  constructor(seed: string | number) {
    this.seed = seedToNumber(seed);
    this.state = mix32(this.seed ^ 0x9e3779b9);
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [a, b). */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Integer in [a, b] inclusive. */
  intRange(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  sign(): 1 | -1 {
    return this.next() < 0.5 ? -1 : 1;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Pick by weight. `weights` need not be normalised. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (let i = 0; i < items.length; i++) total += weights[i] ?? 0;
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i] ?? 0;
      if (r < 0) return items[i] as T;
    }
    return items[items.length - 1] as T;
  }

  /** Approximately normal, mean 0, sd about 0.29 * 2 (sum of three uniforms). */
  gauss(): number {
    return (this.next() + this.next() + this.next() - 1.5) / 1.5;
  }

  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  }

  fork(label: string | number): Rng {
    const l = typeof label === 'number' ? mix32(label >>> 0) : hashString(label);
    return new Rng(mix32((this.seed ^ Math.imul(l, 0x9e3779b1)) >>> 0));
  }
}
