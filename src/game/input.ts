/**
 * Keyboard, mouse and touch input. Mouse look uses pointer lock when allowed
 * and falls back to click-drag (sandboxed frames refuse the lock). Touch: left
 * thumb flies (stick), right thumb steers.
 */
export class Input {
  readonly keys = new Set<string>();
  private lookX = 0;
  private lookY = 0;
  private wheel = 0;
  locked = false;
  dragging = false;
  private touchMove: { id: number; x0: number; y0: number; x: number; y: number } | null = null;
  private touchLook: { id: number; x: number; y: number } | null = null;
  /** Called once per key press (not on repeats). */
  onKey: ((code: string) => void) | null = null;
  /** Called on the first user gesture on the canvas. */
  onEngage: (() => void) | null = null;
  /** Any manual flight input this frame (used to take over from autopilot). */
  activity = 0;
  engaged = false;

  constructor(private readonly el: HTMLElement) {
    addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      if (e.code === 'Tab' || e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
      if (!this.keys.has(e.code)) this.onKey?.(e.code);
      this.keys.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
    });
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this.engage();
      this.requestLock();
      this.dragging = true;
    });
    addEventListener('mouseup', () => (this.dragging = false));
    addEventListener('mousemove', (e) => {
      if (this.locked || this.dragging) {
        this.lookX += e.movementX;
        this.lookY += e.movementY;
      }
    });
    el.addEventListener(
      'wheel',
      (e) => {
        this.wheel += Math.sign(e.deltaY);
        e.preventDefault();
      },
      { passive: false },
    );
    el.addEventListener('touchstart', (e) => this.touchStart(e), { passive: false });
    el.addEventListener('touchmove', (e) => this.touchMoved(e), { passive: false });
    el.addEventListener('touchend', (e) => this.touchEnd(e), { passive: false });
    el.addEventListener('touchcancel', (e) => this.touchEnd(e), { passive: false });
  }

  requestLock(): void {
    if (this.locked) return;
    try {
      const r = (this.el as HTMLCanvasElement).requestPointerLock?.() as unknown as Promise<void> | undefined;
      r?.catch?.(() => undefined);
    } catch {
      /* sandboxed: drag to steer instead */
    }
  }

  private engage(): void {
    if (!this.engaged) {
      this.engaged = true;
      this.onEngage?.();
    }
  }

  private touchStart(e: TouchEvent): void {
    e.preventDefault();
    this.engage();
    for (const t of Array.from(e.changedTouches)) {
      if (t.clientX < innerWidth * 0.42 && !this.touchMove) this.touchMove = { id: t.identifier, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY };
      else if (!this.touchLook) this.touchLook = { id: t.identifier, x: t.clientX, y: t.clientY };
    }
  }

  private touchMoved(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (this.touchMove && t.identifier === this.touchMove.id) {
        this.touchMove.x = t.clientX;
        this.touchMove.y = t.clientY;
      } else if (this.touchLook && t.identifier === this.touchLook.id) {
        this.lookX += (t.clientX - this.touchLook.x) * 1.4;
        this.lookY += (t.clientY - this.touchLook.y) * 1.4;
        this.touchLook.x = t.clientX;
        this.touchLook.y = t.clientY;
      }
    }
  }

  private touchEnd(e: TouchEvent): void {
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (this.touchMove && t.identifier === this.touchMove.id) this.touchMove = null;
      if (this.touchLook && t.identifier === this.touchLook.id) this.touchLook = null;
    }
  }

  consumeLook(): [number, number] {
    const r: [number, number] = [this.lookX, this.lookY];
    if (r[0] !== 0 || r[1] !== 0) this.activity = 1;
    this.lookX = 0;
    this.lookY = 0;
    return r;
  }

  consumeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  private has(...codes: string[]): boolean {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  /** Flight axes: x strafe right, y forward throttle, z climb. Each -1..1. */
  axes(): [number, number, number] {
    let x = 0;
    let y = 0;
    let z = 0;
    if (this.has('KeyW', 'ArrowUp')) y += 1;
    if (this.has('KeyS', 'ArrowDown')) y -= 1;
    if (this.has('KeyD', 'ArrowRight')) x += 1;
    if (this.has('KeyA', 'ArrowLeft')) x -= 1;
    if (this.has('Space', 'KeyE')) z += 1;
    if (this.has('KeyC', 'KeyQ')) z -= 1;
    if (this.touchMove) {
      const dx = (this.touchMove.x - this.touchMove.x0) / 60;
      const dy = (this.touchMove.y - this.touchMove.y0) / 60;
      x += Math.max(-1, Math.min(1, dx));
      y -= Math.max(-1, Math.min(1, dy));
    }
    if (x !== 0 || y !== 0 || z !== 0) this.activity = 1;
    return [Math.max(-1, Math.min(1, x)), Math.max(-1, Math.min(1, y)), z];
  }

  get boost(): boolean {
    return this.has('ShiftLeft', 'ShiftRight');
  }
}
