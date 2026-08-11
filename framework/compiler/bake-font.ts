// framework/compiler/bake-font.ts — bakes Inter into FONT ATLAS blobs (spec.ts format).
//
// One blob per font slot (a (weight, px) pair — slot table pinned in
// framework/compiler/tailwind.ts, sizes 12/14/16/18/20/24/36, regular + bold [R]).
// Charset = codepoints collected from the AST scan + ASCII 32..126 ALWAYS +
// an extraChars option [R]. Codepoints the font does not map are simply left
// out — the core resolves cmap misses to gid 0 (tofu) at runtime.
//
// Rasterization: opentype.js outlines, flattened to polylines, scanline
// **non-zero winding** fill with horizontally-biased supersampling into 8-bit
// coverage cells. (Even-odd punches wrong holes in many CJK outlines; Latin
// Inter contours stay correct under non-zero.) Atlas v3 keeps cell/line/cmap
// metrics in LOGICAL px while baking the bitmap at `rasterDensity` samples per
// logical px. A Vita density-2 build can therefore draw sharp 2x coverage
// without changing PSP-compatible layout.
//
// Mixed scripts: optional CJK companion fonts (Noto Sans SC). ASCII/Latin stay
// on Inter so English is not "split" by a CJK-primary face; Han + CJK punct
// resolve from the companion.
// Cells are tight in logical space: cellW = max inked logical width over the
// slot's glyphs; their coverage cells are exactly cellW*density by
// cellH*density. Proportional advances (font units * px/upm, rounded) live in
// the cmap entries. Glyphs with ink LEFT of the pen origin (negative left side
// bearing: î ï ĥ ǰ) are shifted right at bake and carry the LOGICAL shift in
// cmap byte +7 (xoff) so no ink is clipped; renderers place the cell at penX -
// xoff. gid 0 is a drawn hollow "tofu" box and is also mapped from U+FFFD so it
// has a discoverable advance.

import { parse as parseFont, type Font, type Path } from "opentype.js";
import {
  FONT_CMAP_ENTRY_SIZE,
  FONT_FLAG_BOLD,
  FONT_HEADER_SIZE,
  FONT_MAGIC,
  FONT_VERSION,
  MAX_FONT_SLOTS,
} from "../../contracts/spec/spec.ts";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { fontSlotInfo } from "./tailwind.ts";

const FONTS_DIR = resolve(fileURLToPath(new URL("../../assets/fonts/", import.meta.url)));
export const DEFAULT_REGULAR = join(FONTS_DIR, "Inter-Regular.ttf");
export const DEFAULT_BOLD = join(FONTS_DIR, "Inter-Bold.ttf");

export interface BakedAtlas {
  slot: number;
  px: number;
  bold: boolean;
  rasterDensity: number;
  bytes: Uint8Array;
  glyphCount: number;
  /** Logical cell dimensions; coverage dimensions are these times rasterDensity. */
  cellW: number;
  cellH: number;
  coverageW: number;
  coverageH: number;
}

export interface BakeOptions {
  /** Codepoints collected by the pass-1 AST scan. */
  codepoints: Iterable<number>;
  /** Slots to bake (indices per framework/compiler/tailwind.ts fontSlotFor). */
  slots: number[];
  /** Extra characters to force into every atlas [R]. */
  extraChars?: string;
  /** Raster samples per logical pixel. Defaults to 1. */
  rasterDensity?: number;
  /** Reserve at least one em of cell width for host-injected fullwidth glyphs. */
  reserveEmCell?: boolean;
  /** Primary face (Inter by default) — Latin / general. */
  regularTtf?: string;
  boldTtf?: string;
  /**
   * Optional CJK companion faces (e.g. Noto Sans SC). When set, Han + CJK
   * punctuation/fullwidth codepoints resolve here; everything else stays on
   * the primary face so mixed Chinese/English UIs keep Inter Latin metrics.
   */
  cjkRegularTtf?: string;
  cjkBoldTtf?: string;
}

/** Codepoints that should prefer a CJK companion face when one is configured. */
export function isCjkCodepoint(cp: number): boolean {
  return (
    (cp >= 0x2e80 && cp <= 0x2fff) || // radicals + ideographic description
    (cp >= 0x3000 && cp <= 0x30ff) || // CJK punctuation + kana
    (cp >= 0x3100 && cp <= 0x31ef) || // bopomofo + CJK strokes
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables/jamo
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xff00 && cp <= 0xffef) || // half/fullwidth forms
    (cp >= 0x20000 && cp <= 0x323af) // CJK extensions B through H
  );
}

// ---------------------------------------------------------------------------
// Outline -> coverage cell rasterizer
// ---------------------------------------------------------------------------

type Pt = { x: number; y: number };
type Contour = Pt[];

const CURVE_STEPS = 8;

/** Flatten an opentype path (already in y-down px space) into closed contours. */
function flatten(path: Path, curveSteps = CURVE_STEPS): Contour[] {
  const contours: Contour[] = [];
  let cur: Contour = [];
  let sx = 0;
  let sy = 0;
  let cx = 0;
  let cy = 0;
  const close = () => {
    if (cur.length > 1) contours.push(cur);
    cur = [];
  };
  for (const cmd of path.commands) {
    switch (cmd.type) {
      case "M":
        close();
        sx = cx = cmd.x;
        sy = cy = cmd.y;
        cur.push({ x: cx, y: cy });
        break;
      case "L":
        cx = cmd.x;
        cy = cmd.y;
        cur.push({ x: cx, y: cy });
        break;
      case "Q":
        for (let i = 1; i <= curveSteps; i++) {
          const t = i / curveSteps;
          const u = 1 - t;
          cur.push({
            x: u * u * cx + 2 * u * t * cmd.x1 + t * t * cmd.x,
            y: u * u * cy + 2 * u * t * cmd.y1 + t * t * cmd.y,
          });
        }
        cx = cmd.x;
        cy = cmd.y;
        break;
      case "C":
        for (let i = 1; i <= curveSteps; i++) {
          const t = i / curveSteps;
          const u = 1 - t;
          cur.push({
            x: u * u * u * cx + 3 * u * u * t * cmd.x1 + 3 * u * t * t * cmd.x2 + t * t * t * cmd.x,
            y: u * u * u * cy + 3 * u * u * t * cmd.y1 + 3 * u * t * t * cmd.y2 + t * t * t * cmd.y,
          });
        }
        cx = cmd.x;
        cy = cmd.y;
        break;
      case "Z":
        cur.push({ x: sx, y: sy });
        cx = sx;
        cy = sy;
        close();
        break;
    }
  }
  close();
  return contours;
}

const SS_X = 9; // horizontal subpixel samples per pixel
const SS_Y = 3; // vertical samples per pixel

type Crossing = { x: number; dir: number };

/**
 * Rasterize contours into a grayscale coverage cell. Horizontal sampling is
 * intentionally denser than vertical sampling so thin glyph stems can land on
 * subpixel boundaries without collapsing to a hard 1-bit edge.
 *
 * Fill rule is **non-zero winding** (not even-odd): CJK outlines from Noto and
 * similar faces often self-overlap in ways even-odd turns into broken strokes
 * or wrong holes; correctly oriented Latin contours remain filled the same.
 */
function rasterize(contours: Contour[], cellW: number, cellH: number): Uint8Array {
  const out = new Uint8Array(cellH * cellW);
  if (contours.length === 0) return out;
  const sw = cellW * SS_X;
  const samplesPerPixel = SS_X * SS_Y;
  const counts = new Uint16Array(cellW); // covered subsamples per pixel column, one row at a time
  const crossings: Crossing[] = [];
  for (let row = 0; row < cellH; row++) {
    counts.fill(0);
    for (let sub = 0; sub < SS_Y; sub++) {
      const y = row + (sub + 0.5) / SS_Y;
      crossings.length = 0;
      for (const c of contours) {
        for (let i = 0; i < c.length - 1; i++) {
          const p0 = c[i];
          const p1 = c[i + 1];
          // Strict inequality on one end avoids double-counting shared vertices.
          if (p0.y <= y && p1.y > y) {
            crossings.push({
              x: p0.x + ((y - p0.y) * (p1.x - p0.x)) / (p1.y - p0.y),
              dir: 1,
            });
          } else if (p1.y <= y && p0.y > y) {
            crossings.push({
              x: p0.x + ((y - p0.y) * (p1.x - p0.x)) / (p1.y - p0.y),
              dir: -1,
            });
          }
        }
      }
      if (crossings.length < 2) continue;
      crossings.sort((a, b) => a.x - b.x || a.dir - b.dir);
      let wind = 0;
      for (let k = 0; k + 1 < crossings.length; k++) {
        const x0 = crossings[k].x;
        wind += crossings[k].dir;
        const x1 = crossings[k + 1].x;
        if (wind === 0 || x1 <= x0) continue;
        let s0 = Math.ceil(x0 * SS_X - 0.5);
        let s1 = Math.floor(x1 * SS_X - 0.5);
        if (s0 < 0) s0 = 0;
        if (s1 >= sw) s1 = sw - 1;
        for (let s = s0; s <= s1; s++) {
          const center = (s + 0.5) / SS_X;
          if (center >= x0 && center < x1) counts[(s / SS_X) | 0]++;
        }
      }
    }
    for (let x = 0; x < cellW; x++) {
      out[row * cellW + x] = Math.round((counts[x] * 255) / samplesPerPixel);
    }
  }
  return out;
}

/** Hollow tofu box coverage cell for gid 0. Returns [coverage rows, logical advance]. */
function tofu(
  cellW: number,
  cellH: number,
  baseline: number,
  px: number,
  rasterDensity: number,
): [Uint8Array, number] {
  const coverageW = cellW * rasterDensity;
  const coverageH = cellH * rasterDensity;
  const out = new Uint8Array(coverageH * coverageW);
  const w = Math.max(4, Math.min(cellW, Math.round(px * 0.55)));
  const h = Math.max(5, Math.round(px * 0.7));
  const y1 = Math.min(coverageH - 1, baseline * rasterDensity - 1);
  const y0 = Math.max(0, y1 - h * rasterDensity + 1);
  const x0 = 0;
  const x1 = w * rasterDensity - 1;
  const set = (x: number, y: number) => {
    out[y * coverageW + x] = 255;
  };
  for (let inset = 0; inset < rasterDensity; inset++) {
    for (let x = x0 + inset; x <= x1 - inset; x++) {
      set(x, y0 + inset);
      set(x, y1 - inset);
    }
    for (let y = y0 + inset; y <= y1 - inset; y++) {
      set(x0 + inset, y);
      set(x1 - inset, y);
    }
  }
  return [out, Math.min(255, w + 2)];
}

// ---------------------------------------------------------------------------
// Atlas baking
// ---------------------------------------------------------------------------

async function loadFont(path: string): Promise<Font> {
  const buf = await Bun.file(path).arrayBuffer();
  return parseFont(buf);
}

const TOFU_CODEPOINT = 0xfffd; // U+FFFD replacement char maps to gid 0

function checkedRasterDensity(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 255) {
    throw new RangeError(`PocketJS bake-font: rasterDensity must be an integer from 1 through 255, got ${value}`);
  }
  return value;
}

/** Bake one slot's atlas blob (see spec.ts FONT ATLAS format). */
export function bakeSlot(
  font: Font,
  slot: number,
  px: number,
  bold: boolean,
  chars: number[],
  rasterDensity = 1,
  cjkFont?: Font | null,
  reserveEmCell = false,
): BakedAtlas {
  rasterDensity = checkedRasterDensity(rasterDensity);
  // Line metrics always come from the primary (Latin) face so mixed-script
  // lines share one baseline/line-height with Inter-era apps.
  const upm = font.unitsPerEm;
  const scale = px / upm;
  const ascent = font.ascender * scale;
  const descent = -font.descender * scale; // positive px below baseline
  const baseline = Math.round(ascent);
  const cellH = Math.min(255, Math.max(1, baseline + Math.ceil(descent)));
  const hhea = (font.tables as Record<string, any>).hhea;
  const lineGap: number = (hhea?.lineGap ?? 0) * scale;
  const lineHeight = Math.min(255, Math.round(ascent + descent + lineGap));

  // resolve glyphs first (skips codepoints the font doesn't map)
  interface G {
    cp: number;
    contours: Contour[];
    advance: number;
    maxX: number;
    /** Left-side-bearing shift (see spec.ts cmap byte +7): glyphs with ink
     *  LEFT of the pen origin (negative LSB — î ï ĥ ǰ accents) are shifted
     *  right by this many px so the cell holds all their ink; renderers place
     *  the cell at penX - xoff. */
    xoff: number;
  }
  const glyphs: G[] = [];
  for (const cp of chars) {
    if (cp === TOFU_CODEPOINT) continue; // reserved for gid 0
    const ch = String.fromCodePoint(cp);
    const preferCjk = !!cjkFont && isCjkCodepoint(cp);
    const primary = preferCjk ? cjkFont! : font;
    let gi = primary.charToGlyphIndex(ch);
    let src = primary;
    // Fall back across faces so a missing punct in one still bakes.
    if (gi <= 0 && preferCjk) {
      gi = font.charToGlyphIndex(ch);
      src = font;
    } else if (gi <= 0 && cjkFont) {
      gi = cjkFont.charToGlyphIndex(ch);
      src = cjkFont;
    }
    if (gi <= 0) continue;
    const glyph = src.glyphs.get(gi);
    const srcScale = px / src.unitsPerEm;
    const advance = Math.max(
      0,
      Math.min(255, Math.round((glyph.advanceWidth ?? 0) * srcScale)),
    );
    // Same logical baseline + px size for both faces; denser curves for CJK.
    const path = glyph.getPath(0, baseline, px);
    const curveSteps = preferCjk || src !== font
      ? CURVE_STEPS * 2
      : CURVE_STEPS;
    // Keep every metric byte-for-byte equivalent to the density-1 bake. The
    // higher-density contour gets more curve subdivisions, then is scaled into
    // raster space only after logical bounds/xoff have been resolved.
    const metricContours = flatten(path, curveSteps);
    let minX = 0;
    let maxX = 0;
    for (const c of metricContours) {
      for (const p of c) {
        if (p.x > maxX) maxX = p.x;
        if (p.x < minX) minX = p.x;
      }
    }
    const xoff = Math.min(255, Math.ceil(Math.max(0, -minX)));
    maxX += xoff;
    const contours = rasterDensity === 1
      ? metricContours
      : flatten(path, curveSteps * rasterDensity);
    for (const c of contours) {
      for (const p of c) {
        p.x = (p.x + xoff) * rasterDensity;
        p.y *= rasterDensity;
      }
    }
    glyphs.push({ cp, contours, advance, maxX, xoff });
  }

  const tofuW = Math.max(4, Math.round(px * 0.55));
  // Runtime providers rasterize into the same fixed-size cell. Kindle's
  // ASCII-only bake therefore reserves one logical em for fullwidth CJK ink.
  let cellW = reserveEmCell ? Math.max(tofuW, Math.ceil(px)) : tofuW;
  for (const g of glyphs) cellW = Math.max(cellW, Math.ceil(g.maxX));
  cellW = Math.min(255, Math.max(1, cellW));

  // gid 0 = tofu; gid k+1 = k-th glyph (chars arrive sorted ascending)
  const glyphCount = glyphs.length + 1;
  if (glyphCount > 0xffff) throw new Error("PocketJS bake-font: too many glyphs");
  const coverageW = cellW * rasterDensity;
  const coverageH = cellH * rasterDensity;
  const coverageBytes = glyphCount * coverageH * coverageW;
  if (!Number.isSafeInteger(coverageBytes)) {
    throw new RangeError("PocketJS bake-font: atlas coverage is too large");
  }
  const size = FONT_HEADER_SIZE + glyphCount * FONT_CMAP_ENTRY_SIZE + coverageBytes;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);

  dv.setUint32(0, FONT_MAGIC, true);
  dv.setUint16(4, FONT_VERSION, true);
  dv.setUint16(6, glyphCount, true);
  out[8] = cellW;
  out[9] = cellH;
  out[10] = baseline;
  out[11] = lineHeight;
  out[12] = slot;
  out[13] = bold ? FONT_FLAG_BOLD : 0;
  out[14] = rasterDensity;
  // 15 reserved

  // cmap sorted ascending by codepoint (glyphs are sorted; tofu's U+FFFD
  // entry is spliced into position).
  const entries: Array<{ cp: number; gid: number; advance: number; xoff: number }> = glyphs.map(
    (g, i) => ({
      cp: g.cp,
      gid: i + 1,
      advance: g.advance,
      xoff: g.xoff,
    }),
  );
  const [tofuCoverage, tofuAdvance] = tofu(cellW, cellH, baseline, px, rasterDensity);
  entries.push({ cp: TOFU_CODEPOINT, gid: 0, advance: tofuAdvance, xoff: 0 });
  entries.sort((a, b) => a.cp - b.cp);
  let o = FONT_HEADER_SIZE;
  for (const e of entries) {
    dv.setUint32(o, e.cp, true);
    dv.setUint16(o + 4, e.gid, true);
    out[o + 6] = e.advance;
    out[o + 7] = e.xoff; // left-side-bearing shift (spec.ts cmap byte +7)
    o += FONT_CMAP_ENTRY_SIZE;
  }

  // coverage region, indexed by gid
  const coverageOff = FONT_HEADER_SIZE + glyphCount * FONT_CMAP_ENTRY_SIZE;
  const cellBytes = coverageH * coverageW;
  out.set(tofuCoverage, coverageOff); // gid 0
  glyphs.forEach((g, i) => {
    out.set(rasterize(g.contours, coverageW, coverageH), coverageOff + (i + 1) * cellBytes);
  });

  return {
    slot,
    px,
    bold,
    rasterDensity,
    bytes: out,
    glyphCount,
    cellW,
    cellH,
    coverageW,
    coverageH,
  };
}

/** Bake every requested slot. Charset = collected + ASCII 32..126 + extraChars. */
export async function bakeAtlases(opts: BakeOptions): Promise<BakedAtlas[]> {
  const rasterDensity = checkedRasterDensity(opts.rasterDensity ?? 1);
  const cps = new Set<number>();
  for (let c = 32; c <= 126; c++) cps.add(c); // ASCII always [R]
  for (const cp of opts.codepoints) if (cp >= 32 && cp !== 127) cps.add(cp);
  for (const ch of opts.extraChars ?? "") {
    const cp = ch.codePointAt(0)!;
    if (cp >= 32 && cp !== 127) cps.add(cp);
  }
  const chars = [...cps].sort((a, b) => a - b);
  const needsCjk = chars.some(isCjkCodepoint);

  const fonts: Record<"regular" | "bold", Font | null> = { regular: null, bold: null };
  const cjkFonts: Record<"regular" | "bold", Font | null> = { regular: null, bold: null };
  const results: BakedAtlas[] = [];
  for (const slot of [...opts.slots].sort((a, b) => a - b)) {
    if (slot < 0 || slot >= MAX_FONT_SLOTS) {
      throw new Error(`PocketJS bake-font: slot ${slot} out of range (0..${MAX_FONT_SLOTS - 1})`);
    }
    const { px, bold } = fontSlotInfo(slot);
    const key = bold ? "bold" : "regular";
    fonts[key] ??= await loadFont(
      bold ? (opts.boldTtf ?? DEFAULT_BOLD) : (opts.regularTtf ?? DEFAULT_REGULAR),
    );
    let cjk: Font | null = null;
    if (needsCjk) {
      const cjkPath = bold
        ? (opts.cjkBoldTtf ?? opts.cjkRegularTtf)
        : opts.cjkRegularTtf;
      if (cjkPath) {
        const cjkKey = bold && opts.cjkBoldTtf ? "bold" : "regular";
        cjkFonts[cjkKey] ??= await loadFont(cjkPath);
        cjk = cjkFonts[cjkKey];
      }
    }
    results.push(
      bakeSlot(fonts[key]!, slot, px, bold, chars, rasterDensity, cjk, opts.reserveEmCell),
    );
  }
  return results;
}
