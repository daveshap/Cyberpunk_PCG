/**
 * DOM overlay: start card, flight HUD, the zoning deck (style and culture
 * dials, city parameters, district mix, atmosphere), the district minimap,
 * stats and toasts.
 */
import type { CitySpec, Dials, DialsInput, DistrictKind, DistrictTune, LandUse } from '../core/types';
import { DISTRICT_KINDS, LAND_USES, TUNE_KEYS } from '../core/types';
import { DEFAULT_DIALS, NEUTRAL_TUNE, PROFILES, USE_INFO } from '../core/profiles';
import { metroAt } from '../core/transit';

const CSS = `
.ns-root{--mono:'Share Tech Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--display:'Chakra Petch','Share Tech Mono',ui-monospace,Menlo,monospace;--ink:#d6ecff;--dim:rgba(214,236,255,.6);--cyan:#48e6ff;--pink:#ff5ea2;--panel:rgba(6,8,16,.72);--line:rgba(72,230,255,.28);position:fixed;inset:0;pointer-events:none;font:12px/1.4 var(--mono);color:var(--ink);letter-spacing:.03em;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent}
.ns-root *{box-sizing:border-box}
.ns-hud{position:absolute;left:16px;top:14px;display:flex;flex-direction:column;gap:2px;text-shadow:0 0 10px rgba(0,0,0,.9)}
.ns-hud .brand{font:600 12px/1.2 var(--display);letter-spacing:.3em;color:var(--pink)}
.ns-hud .district{font:600 22px/1.15 var(--display);letter-spacing:.06em;margin-top:6px}
.ns-hud .kind{color:var(--dim);text-transform:uppercase;letter-spacing:.18em;font-size:11px}
.ns-hud .gauges{display:flex;gap:16px;margin-top:8px;font-variant-numeric:tabular-nums}
.ns-hud .gauges b{font:600 18px var(--display);color:var(--cyan)}
.ns-hud .gauges span{color:var(--dim);font-size:10px;letter-spacing:.2em;text-transform:uppercase}
.ns-hud .ap{margin-top:6px;color:var(--pink);letter-spacing:.2em;font-size:11px}
.ns-help{position:absolute;left:16px;bottom:14px;display:grid;grid-template-columns:auto auto;gap:1px 12px;opacity:.7;text-shadow:0 0 8px rgba(0,0,0,.9);font-size:11px}
.ns-help i{font-style:normal;color:var(--cyan)}
.ns-stats{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);font-size:10px;color:var(--dim);letter-spacing:.14em;text-transform:uppercase;font-variant-numeric:tabular-nums;text-shadow:0 0 6px #000;white-space:nowrap}
.ns-map{position:absolute;right:14px;bottom:14px;width:220px;pointer-events:auto;background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:6px;backdrop-filter:blur(6px)}
.ns-map canvas{width:100%;aspect-ratio:1;display:block;border-radius:2px;cursor:crosshair}
.ns-legend{display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;margin-top:6px;font-size:10px;color:var(--dim)}
.ns-legend span{display:flex;align-items:center;gap:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ns-legend em{width:8px;height:8px;border-radius:2px;flex:none}
.ns-deck{position:absolute;right:14px;top:14px;width:286px;max-height:calc(100% - 300px);min-height:120px;overflow:auto;pointer-events:auto;background:var(--panel);border:1px solid var(--line);border-radius:4px;backdrop-filter:blur(8px);box-shadow:0 0 24px rgba(72,230,255,.08)}
.ns-deck header{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-bottom:1px solid var(--line);font:600 12px var(--display);letter-spacing:.24em;color:var(--cyan);cursor:pointer;position:sticky;top:0;background:rgba(6,8,16,.92)}
.ns-deck header small{font:10px var(--mono);color:var(--dim);letter-spacing:.1em}
.ns-deck.closed .ns-body{display:none}
.ns-body{padding:6px 10px 10px;display:flex;flex-direction:column;gap:10px}
.ns-sec h4{margin:0 0 4px;font:600 10px var(--display);letter-spacing:.24em;color:var(--pink);text-transform:uppercase}
.ns-dial{display:grid;grid-template-columns:76px 1fr 34px;align-items:center;gap:6px;margin:3px 0}
.ns-dial label{color:var(--ink);font-size:11px;white-space:nowrap}
.ns-dial output{text-align:right;color:var(--cyan);font-variant-numeric:tabular-nums;font-size:11px}
.ns-dial .ends{grid-column:2;display:flex;justify-content:space-between;font-size:9px;color:var(--dim);margin-top:-3px;letter-spacing:.06em}
.ns-dial input[type=range]{width:100%;accent-color:#48e6ff;height:14px;margin:0}
.ns-row{display:flex;gap:6px;flex-wrap:wrap}
.ns-btn{pointer-events:auto;font:600 10px var(--display);letter-spacing:.16em;text-transform:uppercase;color:var(--ink);background:rgba(72,230,255,.08);border:1px solid var(--line);border-radius:3px;padding:6px 8px;cursor:pointer}
.ns-btn:hover,.ns-btn:focus-visible{border-color:var(--cyan);color:var(--cyan);outline:none}
.ns-btn.hot{border-color:var(--pink);color:var(--pink);box-shadow:0 0 12px rgba(255,94,162,.3)}
.ns-seed{display:flex;gap:6px}
.ns-seed input{flex:1;min-width:0;font:12px var(--mono);color:var(--ink);background:rgba(0,0,0,.4);border:1px solid var(--line);border-radius:3px;padding:5px 6px}
.ns-seed input:focus-visible{outline:1px solid var(--cyan)}
.ns-sel{font:11px var(--mono);color:var(--ink);background:rgba(0,0,0,.4);border:1px solid var(--line);border-radius:3px;padding:4px}
.ns-toast{position:absolute;left:50%;top:18%;transform:translateX(-50%);padding:8px 16px;background:rgba(6,8,16,.78);border:1px solid rgba(255,94,162,.5);border-radius:3px;opacity:0;transition:opacity .3s;font:600 13px var(--display);letter-spacing:.12em;text-align:center}
.ns-toast small{display:block;font:10px var(--mono);color:var(--dim);letter-spacing:.2em;text-transform:uppercase;margin-top:2px}
.ns-toast.on{opacity:1}
.ns-start{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at center,rgba(4,6,12,.2),rgba(4,6,12,.7));pointer-events:auto;cursor:pointer;transition:opacity .45s;touch-action:none}
.ns-start.off{opacity:0;pointer-events:none}
.ns-card{text-align:center;padding:26px 30px;background:rgba(4,6,12,.62);border:1px solid rgba(255,94,162,.4);border-radius:6px;backdrop-filter:blur(6px);box-shadow:0 0 40px rgba(255,60,140,.18);max-width:min(92vw,560px)}
.ns-card h1{margin:0 0 6px;font:700 clamp(22px,5vw,38px)/1.1 var(--display);letter-spacing:.3em;color:#fff;text-shadow:0 0 14px #ff3d8b,0 0 34px #ff3d8b}
.ns-card p{margin:2px 0 14px;color:var(--dim);letter-spacing:.12em;text-transform:uppercase;font-size:11px}
.ns-card .go{display:inline-block;margin:4px 6px 14px;padding:9px 18px;border:1px solid var(--cyan);color:var(--cyan);letter-spacing:.28em;border-radius:3px;text-shadow:0 0 10px var(--cyan);font:600 12px var(--display)}
.ns-card .keys{display:grid;grid-template-columns:auto auto auto auto;gap:3px 14px;justify-content:center;text-align:left;color:var(--dim);font-size:11px}
.ns-card .keys i{font-style:normal;color:var(--pink)}
.ns-touch{display:none;color:var(--dim);font-size:11px;margin-top:4px}
.ns-busy{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(3,4,8,.55);font:600 14px var(--display);letter-spacing:.3em;color:var(--cyan);opacity:0;pointer-events:none;transition:opacity .2s}
.ns-busy.on{opacity:1}
.ns-hidden{display:none!important}
@media (pointer:coarse){.ns-help,.ns-card .keys{display:none}.ns-touch{display:block}}
@media (max-width:760px){.ns-deck{width:min(272px,calc(100% - 28px));max-height:46%}.ns-map{width:150px}.ns-legend{display:none}.ns-help{display:none}.ns-hud .district{font-size:17px}.ns-stats{display:none}}
`;

export interface DialDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  left?: string;
  right?: string;
}

export const STYLE_DIALS: DialDef[] = [
  { key: 'grime', label: 'Grime', min: -1, max: 1, step: 0.05, left: 'pristine', right: 'rotting' },
  { key: 'edge', label: 'Edge', min: -1, max: 1, step: 0.05, left: 'soft', right: 'monolithic' },
  { key: 'flash', label: 'Flash', min: -1, max: 1, step: 0.05, left: 'dim', right: 'neon kitsch' },
  { key: 'luxury', label: 'Luxury', min: -1, max: 1, step: 0.05, left: 'cheap', right: 'gilded' },
];
export const CULTURE_DIALS: DialDef[] = [
  { key: 'east', label: 'Signs', min: -1, max: 1, step: 0.05, left: 'western', right: 'east asian' },
  { key: 'jpcn', label: 'Flavour', min: -1, max: 1, step: 0.05, left: 'japanese', right: 'chinese' },
];
export const CITY_DIALS: DialDef[] = [
  { key: 'density', label: 'Density', min: 0.6, max: 1.4, step: 0.05 },
  { key: 'height', label: 'Height', min: 0.5, max: 1.8, step: 0.05 },
  { key: 'size', label: 'Size km', min: 1.6, max: 3.6, step: 0.1 },
  { key: 'alien', label: 'Alien', min: 0, max: 1, step: 0.05, left: 'familiar', right: 'megastructures' },
];
/** Per-district-kind scalars (applied to the kind picked in the panel). */
export const TUNE_DIALS: DialDef[] = [
  { key: 'scale', label: 'Scale', min: -1, max: 1, step: 0.05, left: 'small', right: 'huge' },
  { key: 'budget', label: 'Budget', min: -1, max: 1, step: 0.05, left: 'broke', right: 'flush' },
  { key: 'decay', label: 'Decay', min: -1, max: 1, step: 0.05, left: 'kept', right: 'derelict' },
  { key: 'density', label: 'Density', min: -1, max: 1, step: 0.05, left: 'sparse', right: 'packed' },
  { key: 'neon', label: 'Neon', min: -1, max: 1, step: 0.05, left: 'dark', right: 'blazing' },
];
export const LIVE_DIALS: DialDef[] = [
  { key: 'fog', label: 'Haze', min: 0, max: 2.5, step: 0.05 },
  { key: 'rain', label: 'Rain', min: 0, max: 1, step: 0.05 },
  { key: 'neon', label: 'Neon', min: 0.2, max: 2.5, step: 0.05 },
  { key: 'traffic', label: 'Traffic', min: 0, max: 1, step: 0.05 },
  { key: 'exposure', label: 'Exposure', min: 0.4, max: 2.5, step: 0.05 },
];

export const PRESETS: { name: string; dials: DialsInput }[] = [
  { name: 'Default', dials: { grime: 0, edge: 0, flash: 0, luxury: 0, east: 0, jpcn: 0, density: 1, height: 1, alien: 0.5 } },
  {
    name: 'Boom town',
    dials: {
      grime: -0.3, edge: 0.2, flash: 0.3, luxury: 0.3, east: 0, jpcn: 0, density: 1.1, height: 1.2, alien: 0.8,
      uses: { commercial: 1.4, civic: 1.5, green: 1.4 },
      tune: { corporate: { scale: 0.6, budget: 0.7, neon: 0.4 }, megablock: { scale: 0.5, budget: 0.5 }, jpmarket: { budget: 0.5, neon: 0.6 }, luxury: { scale: 0.5, budget: 0.8 } },
    },
  },
  {
    name: 'Fallen glory',
    dials: {
      grime: 0.3, edge: 0.1, flash: -0.2, luxury: 0.2, east: 0, jpcn: 0, density: 1, height: 1.1, alien: 0.55,
      tune: { luxury: { decay: 0.85, budget: -0.5, neon: -0.4 }, corporate: { decay: 0.6, budget: -0.3, neon: -0.5 }, megablock: { decay: 0.4 } },
    },
  },
  {
    name: 'Night strip',
    dials: {
      grime: 0.1, edge: -0.2, flash: 0.5, luxury: 0, east: 0.5, jpcn: -0.2, density: 1.15, height: 0.95, alien: 0.4,
      uses: { nightlife: 2, commercial: 1.2, residential: 0.7 },
      tune: { jpmarket: { neon: 1, density: 0.6, scale: 0.2 }, cnmarket: { neon: 0.9, density: 0.7 }, decayed: { neon: 0.5 }, corporate: { neon: 0.6 } },
    },
  },
  {
    name: 'Vertical slum',
    dials: {
      grime: 0.55, edge: 0.2, flash: 0.25, luxury: -0.5, east: 0.4, jpcn: 0.5, density: 1.25, height: 1.2, alien: 0.7,
      uses: { residential: 1.6, green: 0.3 },
      tune: { megablock: { scale: 1, decay: 0.5, density: 0.6 }, cnmarket: { scale: 0.6, density: 0.9, decay: 0.4 }, decayed: { scale: 0.5, density: 0.6 }, luxury: { scale: -0.6 } },
    },
  },
  { name: 'Rain market', dials: { grime: 0.15, edge: -0.2, flash: 0.6, luxury: -0.1, east: 0.85, jpcn: -0.8, density: 1.2, height: 0.9, alien: 0.35 } },
  { name: 'Walled city', dials: { grime: 0.65, edge: -0.3, flash: 0.35, luxury: -0.6, east: 0.85, jpcn: 0.85, density: 1.4, height: 1.1, alien: 0.3 } },
  { name: 'Corporate', dials: { grime: -0.4, edge: 0.85, flash: -0.1, luxury: 0.35, east: -0.3, jpcn: 0, density: 1, height: 1.5, alien: 0.9 } },
  { name: 'Rust belt', dials: { grime: 0.9, edge: 0.3, flash: -0.5, luxury: -0.8, east: -0.6, jpcn: 0, density: 0.9, height: 0.8, alien: 0.2 } },
  { name: 'Gilded coast', dials: { grime: -0.8, edge: -0.2, flash: 0.2, luxury: 0.9, east: -0.2, jpcn: -0.3, density: 0.9, height: 1.2, alien: 0.6 } },
];

export interface LiveSettings {
  fog: number;
  rain: number;
  neon: number;
  traffic: number;
  exposure: number;
}

export interface UiCallbacks {
  onRegenerate: (seed: string, dials: Dials) => void;
  onLive: (s: LiveSettings) => void;
  onQuality: (q: string) => void;
  onTeleport: (x: number, z: number) => void;
  onAutopilot: () => void;
  onStart: () => void;
}

function cloneDials(d: Dials): Dials {
  const tune = {} as Dials['tune'];
  for (const k of DISTRICT_KINDS) tune[k] = { ...NEUTRAL_TUNE, ...(d.tune?.[k] ?? {}) };
  return { ...d, mix: { ...d.mix }, tune, uses: { ...d.uses } };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

export class Ui {
  readonly root: HTMLDivElement;
  private hud: HTMLDivElement;
  private districtEl: HTMLDivElement;
  private kindEl: HTMLDivElement;
  private speedEl: HTMLElement;
  private altEl: HTMLElement;
  private apEl: HTMLDivElement;
  private stats: HTMLDivElement;
  private toastEl: HTMLDivElement;
  private start: HTMLDivElement;
  private busy: HTMLDivElement;
  private deck: HTMLDivElement;
  private mapBox: HTMLDivElement;
  private mapCanvas: HTMLCanvasElement;
  private mapStatic: HTMLCanvasElement;
  private help: HTMLDivElement;
  private regenBtn!: HTMLButtonElement;
  private seedInput!: HTMLInputElement;
  private dials: Dials;
  private seed: string;
  readonly live: LiveSettings;
  private spec: CitySpec | null = null;
  private mapScale = 1;
  private mapOx = 0;
  private mapOz = 0;
  private toastTimer = 0;
  private regenTimer = 0;
  private lastDistrict = -2;
  private lastUse = '';
  private legend!: HTMLDivElement;
  private mapMode: 'districts' | 'uses' = 'districts';
  private inputs = new Map<string, HTMLInputElement>();
  private tuneKind: DistrictKind = 'corporate';
  private tuneSel!: HTMLSelectElement;
  hidden = false;

  constructor(
    dials: Dials,
    seed: string,
    live: LiveSettings,
    private readonly cb: UiCallbacks,
    quality: string,
  ) {
    this.dials = cloneDials(dials);
    this.seed = seed;
    this.live = { ...live };
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.root = el('div', 'ns-root');

    // ---- HUD
    this.hud = el('div', 'ns-hud');
    this.hud.append(el('div', 'brand', 'NEON SPRAWL'));
    this.districtEl = el('div', 'district', '&nbsp;');
    this.kindEl = el('div', 'kind', '&nbsp;');
    const gauges = el('div', 'gauges', '<div><b data-k="spd">0</b> <span>km/h</span></div><div><b data-k="alt">0</b> <span>m</span></div>');
    this.speedEl = gauges.querySelector('[data-k=spd]') as HTMLElement;
    this.altEl = gauges.querySelector('[data-k=alt]') as HTMLElement;
    this.apEl = el('div', 'ap', '');
    this.hud.append(this.districtEl, this.kindEl, gauges, this.apEl);

    // ---- help + stats
    this.help = el(
      'div',
      'ns-help',
      '<i>Mouse</i><span>steer (drag if not captured)</span><i>W / S</i><span>thrust / brake</span><i>A / D</i><span>strafe</span><i>Space / C</i><span>climb / dive</span><i>Shift</i><span>boost</span><i>F</i><span>guided flight</span><i>1-7</i><span>jump to district</span><i>T  G  M  H</i><span>rain, deck, map, hud</span><i>Wheel</i><span>camera distance</span><i>Z</i><span>lens</span>',
    );
    this.stats = el('div', 'ns-stats', '');

    // ---- minimap
    this.mapBox = el('div', 'ns-map');
    this.mapCanvas = document.createElement('canvas');
    this.mapCanvas.width = this.mapCanvas.height = 440;
    this.mapCanvas.title = 'Click to fly there';
    this.mapStatic = document.createElement('canvas');
    this.mapStatic.width = this.mapStatic.height = 440;
    this.legend = el('div', 'ns-legend');
    this.legend.title = 'Click to switch between districts and land use';
    this.legend.style.cursor = 'pointer';
    this.legend.addEventListener('click', () => {
      this.mapMode = this.mapMode === 'districts' ? 'uses' : 'districts';
      this.fillLegend();
      if (this.spec) this.setSpec(this.spec);
    });
    this.fillLegend();
    this.mapBox.append(this.mapCanvas, this.legend);
    this.mapCanvas.addEventListener('click', (e) => {
      const r = this.mapCanvas.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * this.mapCanvas.width;
      const pz = ((e.clientY - r.top) / r.height) * this.mapCanvas.height;
      this.cb.onTeleport((px - this.mapOx) / this.mapScale, (pz - this.mapOz) / this.mapScale);
    });

    // ---- zoning deck
    this.deck = el('div', 'ns-deck');
    const head = el('header', '', 'ZONING DECK <small>G</small>');
    head.addEventListener('click', () => this.deck.classList.toggle('closed'));
    const body = el('div', 'ns-body');
    this.deck.append(head, body);
    // phones start with the deck folded so it does not cover the HUD
    if (typeof matchMedia === 'function' && matchMedia('(max-width: 760px)').matches) this.deck.classList.add('closed');
    body.append(this.section('Style', STYLE_DIALS, true));
    body.append(this.section('Culture', CULTURE_DIALS, true));
    body.append(this.section('City', CITY_DIALS, true));
    // district mix
    const mixSec = el('div', 'ns-sec');
    mixSec.append(el('h4', '', 'District mix'));
    const SHORT: Record<DistrictKind, string> = { corporate: 'Core', jpmarket: 'Lantern', cnmarket: 'Red Gate', megablock: 'Megablock', industrial: 'Harbor', decayed: 'Ash Flats', luxury: 'Gilded' };
    for (const k of DISTRICT_KINDS) mixSec.append(this.dialRow({ key: 'mix.' + k, label: SHORT[k], min: 0, max: 2, step: 0.1 }, this.dials.mix[k], true, PROFILES[k].map));
    body.append(mixSec);
    // per-district tuning: pick a kind, move its scalars
    const tuneSec = el('div', 'ns-sec');
    tuneSec.append(el('h4', '', 'District tuning'));
    const trow = el('div', 'ns-row');
    this.tuneSel = el('select', 'ns-sel') as HTMLSelectElement;
    this.tuneSel.id = 'ns-tune-kind';
    this.tuneSel.setAttribute('aria-label', 'District kind to tune');
    this.tuneSel.style.flex = '1';
    for (const k of DISTRICT_KINDS) {
      const o = el('option', '', PROFILES[k].label) as HTMLOptionElement;
      o.value = k;
      this.tuneSel.append(o);
    }
    this.tuneSel.addEventListener('change', () => {
      this.tuneKind = this.tuneSel.value as DistrictKind;
      this.syncInputs();
    });
    const treset = el('button', 'ns-btn', 'Reset') as HTMLButtonElement;
    treset.type = 'button';
    treset.addEventListener('click', () => {
      this.dials.tune[this.tuneKind] = { ...NEUTRAL_TUNE };
      this.syncInputs();
      this.scheduleRegen(false);
    });
    trow.append(this.tuneSel, treset);
    tuneSec.append(trow);
    for (const d of TUNE_DIALS) tuneSec.append(this.dialRow({ ...d, key: 'tune.' + d.key }, this.dials.tune[this.tuneKind][d.key as keyof DistrictTune], true));
    body.append(tuneSec);
    // land-use mix (relative shares of each use, every district)
    const useSec = el('div', 'ns-sec');
    useSec.append(el('h4', '', 'Land use'));
    const USE_SHORT: Record<LandUse, string> = { residential: 'Homes', commercial: 'Commerce', nightlife: 'Nightlife', industrial: 'Industry', civic: 'Civic', green: 'Green' };
    for (const u of LAND_USES) useSec.append(this.dialRow({ key: 'uses.' + u, label: USE_SHORT[u], min: 0, max: 2, step: 0.1 }, this.dials.uses[u], true, USE_INFO[u].map));
    body.append(useSec);
    // presets + seed + regenerate
    const ps = el('div', 'ns-sec');
    ps.append(el('h4', '', 'Presets'));
    const prow = el('div', 'ns-row');
    for (const p of PRESETS) {
      const b = el('button', 'ns-btn', p.name) as HTMLButtonElement;
      b.type = 'button';
      b.addEventListener('click', () => {
        const { tune, uses, mix, ...rest } = p.dials;
        Object.assign(this.dials, rest);
        this.dials.mix = { ...DEFAULT_DIALS.mix, ...(mix ?? {}) };
        this.dials.uses = { ...DEFAULT_DIALS.uses, ...(uses ?? {}) };
        // a preset is a whole look: district tuning resets to neutral, then takes the preset's
        for (const k of DISTRICT_KINDS) this.dials.tune[k] = { ...NEUTRAL_TUNE, ...(tune?.[k] ?? {}) };
        this.syncInputs();
        this.scheduleRegen(true);
      });
      prow.append(b);
    }
    ps.append(prow);
    const seedRow = el('div', 'ns-seed');
    this.seedInput = el('input') as HTMLInputElement;
    this.seedInput.id = 'ns-seed';
    this.seedInput.value = seed;
    this.seedInput.setAttribute('aria-label', 'City seed');
    this.seedInput.addEventListener('change', () => {
      this.seed = this.seedInput.value.trim() || 'sprawl';
      this.scheduleRegen(true);
    });
    const dice = el('button', 'ns-btn', 'New seed') as HTMLButtonElement;
    dice.type = 'button';
    dice.addEventListener('click', () => {
      this.seed = 'city-' + Math.floor(Math.random() * 1e6).toString(36);
      this.seedInput.value = this.seed;
      this.scheduleRegen(true);
    });
    seedRow.append(this.seedInput, dice);
    ps.append(el('h4', '', 'Seed'), seedRow);
    this.regenBtn = el('button', 'ns-btn', 'Regenerate') as HTMLButtonElement;
    this.regenBtn.type = 'button';
    this.regenBtn.style.marginTop = '8px';
    this.regenBtn.addEventListener('click', () => this.scheduleRegen(true));
    ps.append(this.regenBtn);
    body.append(ps);
    // atmosphere (live)
    body.append(this.section('Atmosphere (live)', LIVE_DIALS, false));
    // quality
    const qs = el('div', 'ns-sec');
    qs.append(el('h4', '', 'Quality'));
    const sel = el('select', 'ns-sel') as HTMLSelectElement;
    sel.id = 'ns-quality';
    for (const q of ['low', 'medium', 'high', 'ultra']) {
      const o = el('option', '', q) as HTMLOptionElement;
      o.value = q;
      if (q === quality) o.selected = true;
      sel.append(o);
    }
    sel.addEventListener('change', () => this.cb.onQuality(sel.value));
    qs.append(sel);
    body.append(qs);

    // ---- toast, start, busy
    this.toastEl = el('div', 'ns-toast');
    this.start = el(
      'div',
      'ns-start',
      `<div class="ns-card"><h1>NEON SPRAWL</h1><p>a procedural city of seven districts, by air</p><div class="go">CLICK TO FLY</div><div class="go" data-k="ap">GUIDED FLIGHT</div>` +
        `<div class="keys"><i>Mouse</i><span>steer</span><i>W/S</i><span>thrust</span><i>A/D</i><span>strafe</span><i>Shift</i><span>boost</span><i>Space/C</i><span>up/down</span><i>F</i><span>autopilot</span></div>` +
        `<div class="ns-touch">left thumb flies · right thumb steers</div></div>`,
    );
    this.start.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t && t.dataset && t.dataset.k === 'ap') this.cb.onAutopilot();
      this.cb.onStart();
    });
    this.busy = el('div', 'ns-busy', 'GENERATING');
    this.root.append(this.hud, this.help, this.stats, this.mapBox, this.deck, this.toastEl, this.start, this.busy);
    document.body.appendChild(this.root);
  }

  private section(title: string, defs: DialDef[], structural: boolean): HTMLDivElement {
    const s = el('div', 'ns-sec');
    s.append(el('h4', '', title));
    for (const d of defs) {
      const v = structural ? ((this.dials as unknown as Record<string, number>)[d.key] ?? 0) : (this.live as unknown as Record<string, number>)[d.key] ?? 0;
      s.append(this.dialRow(d, v, structural));
    }
    return s;
  }

  private dialRow(d: DialDef, value: number, structural: boolean, swatch?: string): HTMLDivElement {
    const row = el('div', 'ns-dial');
    const id = 'ns-' + d.key.replace('.', '-');
    const lab = el('label', '', swatch ? `<span style="color:${swatch}">■</span> ${d.label}` : d.label) as HTMLLabelElement;
    lab.htmlFor = id;
    const inp = el('input') as HTMLInputElement;
    inp.type = 'range';
    inp.id = id;
    inp.min = String(d.min);
    inp.max = String(d.max);
    inp.step = String(d.step);
    inp.value = String(value);
    const out = el('output', '', value.toFixed(2));
    inp.addEventListener('input', () => {
      const v = Number(inp.value);
      out.textContent = v.toFixed(2);
      if (structural) {
        if (d.key.startsWith('mix.')) this.dials.mix[d.key.slice(4) as DistrictKind] = v;
        else if (d.key.startsWith('uses.')) this.dials.uses[d.key.slice(5) as LandUse] = v;
        else if (d.key.startsWith('tune.')) {
          this.dials.tune[this.tuneKind][d.key.slice(5) as keyof DistrictTune] = v;
          this.markTuned();
        } else (this.dials as unknown as Record<string, number>)[d.key] = v;
        this.scheduleRegen(false);
      } else {
        (this.live as unknown as Record<string, number>)[d.key] = v;
        this.cb.onLive(this.live);
      }
    });
    row.append(lab, inp, out);
    if (d.left || d.right) row.append(el('div', 'ends', `<span>${d.left ?? ''}</span><span>${d.right ?? ''}</span>`));
    this.inputs.set(d.key, inp);
    return row;
  }

  private syncInputs(): void {
    for (const [k, inp] of this.inputs) {
      let v: number | undefined;
      if (k.startsWith('mix.')) v = this.dials.mix[k.slice(4) as DistrictKind];
      else if (k.startsWith('uses.')) v = this.dials.uses[k.slice(5) as LandUse];
      else if (k.startsWith('tune.')) v = this.dials.tune[this.tuneKind][k.slice(5) as keyof DistrictTune];
      else if (k in this.dials) v = (this.dials as unknown as Record<string, number>)[k];
      else v = (this.live as unknown as Record<string, number>)[k];
      if (v === undefined) continue;
      inp.value = String(v);
      const out = inp.parentElement?.querySelector('output');
      if (out) out.textContent = v.toFixed(2);
    }
    this.markTuned();
  }

  /** Flag tuned kinds in the picker with a dot. */
  private markTuned(): void {
    if (!this.tuneSel) return;
    for (const o of Array.from(this.tuneSel.options)) {
      const t = this.dials.tune[o.value as DistrictKind];
      const tuned = TUNE_KEYS.some((k) => Math.abs(t[k]) > 1e-3);
      o.textContent = (tuned ? '• ' : '') + PROFILES[o.value as DistrictKind].label;
    }
  }

  private scheduleRegen(now: boolean): void {
    this.regenBtn.classList.add('hot');
    clearTimeout(this.regenTimer);
    this.regenTimer = window.setTimeout(
      () => {
        this.regenBtn.classList.remove('hot');
        this.cb.onRegenerate(this.seed, cloneDials(this.dials));
      },
      now ? 30 : 750,
    );
  }

  setBusy(on: boolean): void {
    this.busy.classList.toggle('on', on);
  }

  hideStart(): void {
    this.start.classList.add('off');
  }

  get startVisible(): boolean {
    return !this.start.classList.contains('off');
  }

  toggleDeck(): void {
    this.deck.classList.toggle('closed');
  }
  toggleMap(): void {
    this.mapBox.classList.toggle('ns-hidden');
  }
  toggleHud(): void {
    this.hidden = !this.hidden;
    for (const e of [this.hud, this.help, this.stats, this.mapBox, this.deck]) e.classList.toggle('ns-hidden', this.hidden);
  }

  toast(msg: string, sub = ''): void {
    this.toastEl.innerHTML = msg + (sub ? `<small>${sub}</small>` : '');
    this.toastEl.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('on'), 2200);
  }

  private fillLegend(): void {
    this.legend.innerHTML = '';
    if (this.mapMode === 'districts') for (const k of DISTRICT_KINDS) this.legend.append(el('span', '', `<em style="background:${PROFILES[k].map}"></em>${PROFILES[k].label}`));
    else for (const u of LAND_USES) this.legend.append(el('span', '', `<em style="background:${USE_INFO[u].map}"></em>${USE_INFO[u].label}`));
  }

  setSpec(spec: CitySpec): void {
    this.spec = spec;
    this.lastDistrict = -2;
    const c = this.mapStatic;
    const g = c.getContext('2d')!;
    const W = c.width;
    const b = spec.bounds;
    const ww = b.x1 - b.x0;
    const wd = b.z1 - b.z0;
    this.mapScale = (W - 12) / Math.max(ww, wd);
    this.mapOx = (W - ww * this.mapScale) / 2 - b.x0 * this.mapScale;
    this.mapOz = (W - wd * this.mapScale) / 2 - b.z0 * this.mapScale;
    const X = (x: number): number => x * this.mapScale + this.mapOx;
    const Z = (z: number): number => z * this.mapScale + this.mapOz;
    g.fillStyle = '#05070d';
    g.fillRect(0, 0, W, W);
    g.fillStyle = '#0a1a2a';
    g.fillRect(0, Z(b.z0), W, W);
    for (const sb of spec.superblocks) {
      if (!sb.land) continue;
      const d = spec.districts[sb.district];
      g.fillStyle = d ? PROFILES[d.kind].map : '#222';
      g.globalAlpha = 0.28;
      g.fillRect(X(sb.rect.x0), Z(sb.rect.z0), (sb.rect.x1 - sb.rect.x0) * this.mapScale, (sb.rect.z1 - sb.rect.z0) * this.mapScale);
    }
    g.globalAlpha = 1;
    if (this.mapMode === 'uses') {
      for (const blk of spec.blocks) {
        g.fillStyle = USE_INFO[blk.use].map;
        g.globalAlpha = 0.22;
        g.fillRect(X(blk.plate.x0), Z(blk.plate.z0), (blk.plate.x1 - blk.plate.x0) * this.mapScale, (blk.plate.z1 - blk.plate.z0) * this.mapScale);
      }
      g.globalAlpha = 1;
    }
    for (const bd of spec.buildings) {
      const d = spec.districts[bd.district];
      const t = Math.min(1, bd.height / 300);
      g.fillStyle = this.mapMode === 'uses' ? USE_INFO[bd.use].map : d ? PROFILES[d.kind].map : '#888';
      g.globalAlpha = 0.35 + 0.65 * t;
      g.fillRect(X(bd.rect.x0), Z(bd.rect.z0), Math.max(1, (bd.rect.x1 - bd.rect.x0) * this.mapScale), Math.max(1, (bd.rect.z1 - bd.rect.z0) * this.mapScale));
    }
    g.globalAlpha = 1;
    // metro loop and stations
    for (const m of spec.transit?.metro ?? []) {
      const c = `rgb(${Math.round(m.color[0] * 255)},${Math.round(m.color[1] * 255)},${Math.round(m.color[2] * 255)})`;
      g.strokeStyle = c;
      g.lineWidth = 3;
      g.globalAlpha = 0.85;
      g.beginPath();
      const steps = 160;
      for (let k = 0; k <= steps; k++) {
        const p = metroAt(m, (k / steps) * m.length);
        if (k === 0) g.moveTo(X(p.x), Z(p.z));
        else g.lineTo(X(p.x), Z(p.z));
      }
      g.stroke();
      g.globalAlpha = 1;
      for (const st of m.stations) {
        g.fillStyle = '#fff';
        g.beginPath();
        g.arc(X(st.x), Z(st.z), 4, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = c;
        g.lineWidth = 2;
        g.stroke();
      }
    }
    g.font = '600 11px ui-monospace, monospace';
    g.textAlign = 'center';
    for (const d of spec.districts) {
      g.fillStyle = 'rgba(0,0,0,.6)';
      g.fillText(d.name.toUpperCase(), X(d.x) + 1, Z(d.z) + 1);
      g.fillStyle = '#e8f6ff';
      g.fillText(d.name.toUpperCase(), X(d.x), Z(d.z));
    }
  }

  update(info: { speed: number; alt: number; x: number; z: number; yaw: number; district: number; use: string; autopilot: boolean; fps: number; draws: number; tris: number; backend: string; seed: string; quality: string }): void {
    if (!this.spec) return;
    if (info.district !== this.lastDistrict || info.use !== this.lastUse) {
      const changedDistrict = info.district !== this.lastDistrict;
      this.lastDistrict = info.district;
      this.lastUse = info.use;
      const d = this.spec.districts[info.district];
      const outside = !d && (info.x < this.spec.bounds.x0 || info.x > this.spec.bounds.x1 || info.z < this.spec.bounds.z0);
      this.districtEl.textContent = d ? d.name : outside ? 'The Sprawl' : 'Open water';
      const use = USE_INFO[info.use as LandUse];
      this.kindEl.innerHTML = d ? `${PROFILES[d.kind].label}${use ? ` · <span style="color:${use.map}">${use.label}</span>` : ''}` : outside ? 'Outskirts' : 'Harbour';
      if (d && changedDistrict && !this.startVisible) this.toast(d.name.toUpperCase(), PROFILES[d.kind].label);
    }
    this.speedEl.textContent = String(Math.round(info.speed * 3.6));
    this.altEl.textContent = String(Math.round(info.alt));
    this.apEl.textContent = info.autopilot ? 'GUIDED FLIGHT · F TO TAKE CONTROL' : '';
    this.stats.textContent = `${info.backend} · ${info.fps.toFixed(0)} fps · ${info.draws} draws · ${(info.tris / 1e6).toFixed(2)}M tris · ${info.quality} · seed ${info.seed}`;
    // minimap
    const g = this.mapCanvas.getContext('2d')!;
    g.drawImage(this.mapStatic, 0, 0);
    const px = info.x * this.mapScale + this.mapOx;
    const pz = info.z * this.mapScale + this.mapOz;
    g.save();
    g.translate(px, pz);
    g.rotate(-info.yaw);
    g.fillStyle = '#ffffff';
    g.shadowColor = '#48e6ff';
    g.shadowBlur = 10;
    g.beginPath();
    g.moveTo(0, -11);
    g.lineTo(7, 8);
    g.lineTo(0, 4);
    g.lineTo(-7, 8);
    g.closePath();
    g.fill();
    g.restore();
  }
}
