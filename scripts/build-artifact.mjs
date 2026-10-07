// Builds the game and folds it into one self-contained HTML fragment for publishing as a hosted page.
//   node scripts/build-artifact.mjs            -> dist-artifact/index.html (fragment: title, style, one module script)
//   node scripts/build-artifact.mjs --page     -> also writes dist-artifact/page.html (the same, wrapped in a full document, for local testing)
//
// The fragment has no doctype/html/head/body: the publisher wraps it. It loads two Google Fonts
// stylesheets (the only external host it uses; the HUD has system-monospace fallbacks) and nothing else.
import { build } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const out = path.join(root, 'dist-artifact');
const wantPage = process.argv.includes('--page');

await build({ root, logLevel: 'warn', build: { outDir: 'dist', emptyOutDir: true } });

const html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const scriptSrc = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];
if (!scriptSrc) throw new Error('no module script found in dist/index.html');
const rel = (p) => path.join(dist, p.replace(/^\.?\//, ''));
let js = fs.readFileSync(rel(scriptSrc), 'utf8');
// keep the inline script from ending early or opening an HTML comment
js = js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

const cssLinks = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
const css = cssLinks.map((h) => fs.readFileSync(rel(h), 'utf8')).join('\n');

const fragment = `<title>Neon Sprawl</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=Share+Tech+Mono&display=swap">
<style>
  /* Layout: one full-bleed canvas with a light HUD floating over it. One dark world, chosen on purpose. */
  :root {
    --bg: #05060a;
    --ink: #cfe9ff;
    --magenta: #ff5ea2;
    --cyan: #48e6ff;
    --amber: #ffb454;
    --display: 'Chakra Petch', 'Share Tech Mono', ui-monospace, Menlo, Consolas, monospace;
    --mono: 'Share Tech Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color-scheme: dark;
  }
  html, body { margin: 0; height: 100%; background: var(--bg); color: var(--ink); overflow: hidden; overscroll-behavior: none; -webkit-tap-highlight-color: transparent; }
${css}
</style>
<script type="module">
${js}
</script>
`;

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), fragment);

if (wantPage) {
  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif;background:#f6f5f2}[hidden]{display:none!important}</style>
</head>
<body>
${fragment}
</body>
</html>
`;
  fs.writeFileSync(path.join(out, 'page.html'), page);
}

const kb = (fs.statSync(path.join(out, 'index.html')).size / 1024).toFixed(0);
const head = fragment.slice(0, 8192);
if (!/<title>[^<]+<\/title>/.test(head)) throw new Error('title must be within the first 8 KB');
if (fragment.length > 15 * 1024 * 1024) throw new Error('fragment exceeds the size budget');
console.log(`wrote ${path.relative(root, path.join(out, 'index.html'))} (${kb} KB)${wantPage ? ' and page.html' : ''}`);
