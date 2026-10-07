/**
 * Invented business names for signage. Deliberately generic and made-up:
 * no real brands, no names from any existing game or film.
 */
import type { Rng } from './rng';

const SYL = [
  'KO', 'RA', 'MI', 'NE', 'VO', 'ZE', 'LU', 'KI', 'SO', 'HA', 'NO', 'TA', 'YU', 'RI', 'DE', 'MO',
  'SU', 'KA', 'VE', 'ZA', 'TO', 'RU', 'MA', 'SE', 'NA', 'PI', 'DO', 'BI', 'GU', 'FE',
];
const HEAD = ['NEO', 'HEX', 'APEX', 'ZEN', 'KURO', 'SORA', 'VOLT', 'ORBIT', 'PIXEL', 'NOVA', 'ECHO', 'ONYX', 'TETRA', 'AURA', 'DELTA', 'OMNI'];
const TAIL = [
  'BAR', 'INN', 'MART', 'TECH', 'LABS', 'HOTEL', 'CAFE', 'CLUB', 'NOODLE', 'RAMEN', 'ARCADE', 'PHARMA',
  'OPTICS', 'MOTORS', 'DINER', 'CLINIC', 'SYNTH', 'GENE', 'DATA', 'LIQUOR', 'PAWN', 'VAPE', 'INK',
  'NET', 'CORP', '24H', 'BIO', 'SHOP', 'SUSHI', 'GRILL', 'LOUNGE', 'REPAIR', 'COMMS', 'POWER',
];
const SHORT = ['OPEN', '24H', 'BAR', 'HOTEL', 'RAMEN', 'CLUB', 'DINER', 'LIQUOR', 'ARCADE', 'PAWN', 'NOODLE', 'CAFE', 'TATTOO', 'CLINIC'];

export function brandName(rng: Rng): string {
  const r = rng.next();
  if (r < 0.35) return SYL[rng.int(SYL.length)] + SYL[rng.int(SYL.length)] + (rng.chance(0.4) ? SYL[rng.int(SYL.length)] : '');
  if (r < 0.6) return (rng.pick(HEAD) as string) + (rng.chance(0.3) ? '-' + rng.intRange(1, 99) : '');
  return (rng.pick(HEAD) as string);
}

/** A one-line shop sign, at most about 12 characters. */
export function shopName(rng: Rng): string {
  const r = rng.next();
  if (r < 0.22) return rng.pick(SHORT) as string;
  if (r < 0.62) {
    const b = brandName(rng);
    const t = rng.pick(TAIL) as string;
    return b.length + t.length <= 11 ? b + ' ' + t : t.length <= 6 ? t : b;
  }
  return brandName(rng);
}

/** A short word for vertical blade signs, 3 to 6 characters. */
export function bladeWord(rng: Rng): string {
  const r = rng.next();
  if (r < 0.5) {
    const s = (rng.pick(SYL) as string) + (rng.pick(SYL) as string);
    return s;
  }
  const w = rng.pick(['BAR', 'HOTEL', 'CLUB', 'RAMEN', 'SUSHI', 'LIQUOR', 'ARCADE', 'PAWN', 'CAFE', 'NOODLE', 'INN', 'SPA', 'VAPE', 'DINER']) as string;
  return w.length > 6 ? w.slice(0, 6) : w;
}

/** Big rooftop lettering: short and punchy. */
export function roofWord(rng: Rng): string {
  const r = rng.next();
  if (r < 0.5) return brandName(rng).slice(0, 8);
  return rng.pick(['NEO', 'HEX', 'ZEN', 'KURO', 'NOVA', 'ONYX', 'VOLT', 'OMNI', 'AURA', 'APEX', 'ECHO', 'DELTA', 'TETRA']) as string;
}
