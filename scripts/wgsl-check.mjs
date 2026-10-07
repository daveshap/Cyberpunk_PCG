// Captures every WGSL module the app compiles (WebGPU backend, headless) and
// checks each fragment shader for a TSL pitfall: a shared expression that TSL
// emitted inside one `if` branch and that another branch, or code after the
// `if`, then reads unset. Fix those by pinning the value before the branch
// (`pin()` in src/render/tsl.ts). Needs the dev server on :5174.
//   node scripts/wgsl-check.mjs [--url http://localhost:5174/] [--dump dir]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

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
  return i < 0 ? def : args[i + 1];
};
const url = opt('url', 'http://localhost:5174/');
const dump = opt('dump', null);

const flags = ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--disable-vulkan-surface', '--use-webgpu-adapter=swiftshader', '--disable-gpu-sandbox'];
const browser = await chromium.launch({ headless: true, args: flags });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.addInitScript(() => {
  const view = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function (d) {
    if (d && typeof d.swizzle === 'string') {
      d = { ...d };
      delete d.swizzle;
    }
    return view.call(this, d);
  };
  window.__wgsl = [];
  const csm = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (desc) {
    window.__wgsl.push(desc.code);
    return csm.call(this, desc);
  };
});
await page.goto(url + '?still=1&nohud=1&size=1.6', { waitUntil: 'load' });
await page.waitForFunction(() => window.__ready === true, null, { timeout: 600000 });
await page.evaluate(() => window.__game.settle(3, 50));
const modules = await page.evaluate(() => window.__wgsl);
await browser.close();
if (dump) {
  fs.mkdirSync(dump, { recursive: true });
  modules.forEach((c, i) => fs.writeFileSync(path.join(dump, `m${String(i).padStart(3, '0')}.wgsl`), c));
}

/** Variables read where none of their assignments dominate the read. */
function check(src) {
  const at = src.indexOf('fn main(');
  if (at < 0) return [];
  const lines = src.slice(at).split('\n');
  const stack = [{ id: 0, loop: false, guarded: false }];
  let next = 0;
  const assigned = new Map();
  const issues = new Map();
  const pathOf = () => stack.map((b) => b.id);
  const covers = (v, p) => {
    const ps = assigned.get(v) ?? [];
    if (ps.some((a) => a.every((x, i) => p[i] === x))) return true;
    // if/else: assigned in two sibling blocks under a common parent
    for (let i = 0; i < ps.length; i++)
      for (let j = i + 1; j < ps.length; j++) {
        const a = ps[i];
        const b = ps[j];
        let k = 0;
        while (k < Math.min(a.length, b.length) && a[k] === b[k]) k++;
        const parent = a.slice(0, k);
        if (a.length > k && b.length > k && parent.every((x, n) => p[n] === x)) return true;
      }
    return false;
  };
  for (const line of lines) {
    const s = line.trim();
    const m = /^\s*(nodeVar\d+)(\.\w+)?\s*=\s*(.*);/.exec(line);
    const rhs = m ? m[3] : s;
    for (const v of new Set(rhs.match(/(?<![A-Za-z_])nodeVar\d+/g) ?? [])) {
      if (!assigned.has(v)) continue;
      if (!covers(v, pathOf()) && !issues.has(v)) issues.set(v, s.slice(0, 120));
    }
    if (m) {
      // an assignment at the top of a loop body (before any branch or break) runs on every pass
      const top = stack[stack.length - 1];
      const p = pathOf();
      assigned.set(m[1], [...(assigned.get(m[1]) ?? []), top.loop && !top.guarded ? p.slice(0, -1) : p]);
    }
    if (/^if\s*\(|^break/.test(s)) stack[stack.length - 1].guarded = true;
    for (const ch of s) {
      if (ch === '{') stack.push({ id: ++next, loop: /^for\s*\(|^loop\b|^while\b/.test(s), guarded: false });
      else if (ch === '}') stack.pop();
    }
  }
  return [...issues.entries()];
}

let bad = 0;
modules.forEach((code, i) => {
  if (!code.includes('@fragment')) return;
  const issues = check(code);
  if (issues.length === 0) return;
  bad++;
  console.log(`module ${i}: ${issues.length} value(s) read outside the branch that set them`);
  for (const [v, line] of issues.slice(0, 6)) console.log(`  ${v}: ${line}`);
});
console.log(`${modules.length} modules, ${bad} with branch-local reads`);
process.exit(bad ? 1 : 0);
