//! Font atlas registry + text measurement + inline-run layout.
//!
//! Parses font-atlas blobs (spec.ts "FONT ATLAS binary format", constants in
//! spec::font_atlas) into a MAX_FONT_SLOTS registry. cmap lookups binary
//! search (entries are sorted ascending by codepoint); a miss resolves to
//! gid 0 (the tofu box) and bumps the per-core miss counter.
//!
//! v1 line model (documented limitation): NO automatic word wrap — a run
//! breaks only on explicit '\n'. Measurement is the max line width (sum of
//! advances + tracking per glyph) by lines x line height.

use alloc::boxed::Box;
use alloc::vec::Vec;
use core::cell::{Cell, RefCell};

/// Default global budget for host-rasterized glyph coverage (4 MiB).
pub const DEFAULT_RUNTIME_GLYPH_BUDGET_BYTES: usize = 4 * 1024 * 1024;

use crate::spec;

#[inline]
fn rd_u16(b: &[u8], off: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*b.get(off)?, *b.get(off + 1)?]))
}

#[inline]
fn rd_u32(b: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_le_bytes([
        *b.get(off)?,
        *b.get(off + 1)?,
        *b.get(off + 2)?,
        *b.get(off + 3)?,
    ]))
}

/// One cmap entry (sorted ascending by codepoint in the blob).
#[derive(Clone, Copy, Debug)]
pub struct CmapEntry {
    pub codepoint: u32,
    pub gid: u16,
    /// Logical px advance; independent of atlas raster density.
    pub advance: u8,
    /// Left-side-bearing shift (cmap byte +7): logical px the outline was shifted
    /// RIGHT at bake so negative-LSB ink stays inside the cell. The cell is
    /// placed at penX - xoff when drawing.
    pub xoff: u8,
}

struct RuntimeGlyph {
    codepoint: Option<u32>,
    last_used: Cell<u64>,
    bitmap: Option<Box<[u8]>>,
}

/// One parsed font atlas (a (family-weight, px) bake bound to a slot).
pub struct Atlas {
    /// Logical cell dimensions. Coverage dimensions are these times
    /// `raster_density`.
    pub cell_w: u32,
    pub cell_h: u32,
    /// Logical px from cell top to the baseline.
    pub baseline: u32,
    /// Default logical line advance in px.
    pub line_height: u32,
    /// Raster samples per logical pixel (v2 atlases resolve to 1).
    pub raster_density: u8,
    pub slot: u8,
    pub flags: u8,
    /// Addressable gid count. Static gids occupy the prefix; runtime gids are
    /// stable slots after it and may be inactive/reused after LRU eviction.
    pub glyph_count: u16,
    static_glyph_count: u16,
    cmap: Vec<CmapEntry>,
    /// Immutable bake-time coverage cells only. Runtime cells live in
    /// `runtime_glyphs`, so the static atlas bytes never move or change.
    pub bitmap: Vec<u8>,
    runtime_glyphs: Vec<RuntimeGlyph>,
    /// Returned for inactive/reclaimed runtime gids (one transparent cell).
    zero_cell: Box<[u8]>,
}

impl Atlas {
    /// Parse a font-atlas blob (copies the bytes it keeps). `None` on bad
    /// magic/version/slot or truncation.
    pub fn parse(bytes: &[u8]) -> Option<Atlas> {
        use spec::font_atlas as fa;
        if rd_u32(bytes, 0)? != fa::MAGIC {
            return None;
        }
        let version = rd_u16(bytes, 4)?;
        // Atlas v2 used bytes 14..15 as reserved and had one coverage sample
        // per logical pixel. Keep loading it so old packs remain usable.
        let raster_density = if version == 2 {
            1
        } else if version == fa::VERSION {
            let density = *bytes.get(14)?;
            if density == 0 {
                return None;
            }
            density
        } else {
            return None;
        };
        let glyph_count = rd_u16(bytes, 6)?;
        let cell_w = *bytes.get(8)? as u32;
        let cell_h = *bytes.get(9)? as u32;
        let baseline = *bytes.get(10)? as u32;
        let line_height = *bytes.get(11)? as u32;
        let slot = *bytes.get(12)?;
        let flags = *bytes.get(13)?;
        if slot as usize >= spec::MAX_FONT_SLOTS || glyph_count == 0 || cell_w == 0 || cell_h == 0 {
            return None;
        }
        let cmap_off = fa::HEADER_SIZE;
        let bitmap_off = (glyph_count as usize)
            .checked_mul(fa::CMAP_ENTRY_SIZE)?
            .checked_add(cmap_off)?;
        let coverage_w = (cell_w as usize).checked_mul(raster_density as usize)?;
        let coverage_h = (cell_h as usize).checked_mul(raster_density as usize)?;
        let bitmap_len = (glyph_count as usize)
            .checked_mul(coverage_h)?
            .checked_mul(coverage_w)?;
        let bitmap_end = bitmap_off.checked_add(bitmap_len)?;
        if bytes.len() < bitmap_end {
            return None;
        }
        let mut cmap = Vec::with_capacity(glyph_count as usize);
        for i in 0..glyph_count as usize {
            let o = cmap_off + i * fa::CMAP_ENTRY_SIZE;
            let gid = rd_u16(bytes, o + 4)?;
            if gid >= glyph_count {
                return None;
            }
            cmap.push(CmapEntry {
                codepoint: rd_u32(bytes, o)?,
                gid,
                advance: *bytes.get(o + 6)?,
                xoff: *bytes.get(o + 7)?,
            });
        }
        let mut bitmap = Vec::with_capacity(bitmap_len);
        bitmap.extend_from_slice(&bytes[bitmap_off..bitmap_end]);
        Some(Atlas {
            cell_w,
            cell_h,
            baseline,
            line_height,
            raster_density,
            slot,
            flags,
            glyph_count,
            static_glyph_count: glyph_count,
            cmap,
            bitmap,
            runtime_glyphs: Vec::new(),
            zero_cell: alloc::vec![0u8; coverage_h * coverage_w].into_boxed_slice(),
        })
    }

    /// Binary-search the cmap. `None` = unmapped codepoint (caller decides
    /// whether that bumps the miss counter).
    pub fn lookup(&self, codepoint: u32) -> Option<(u16, u8)> {
        self.lookup_entry(codepoint).map(|e| (e.gid, e.advance))
    }

    /// Full cmap entry for a codepoint (gid + advance + xoff).
    pub fn lookup_entry(&self, codepoint: u32) -> Option<&CmapEntry> {
        self.cmap
            .binary_search_by(|e| e.codepoint.cmp(&codepoint))
            .ok()
            .map(|i| &self.cmap[i])
    }

    #[inline]
    pub fn bytes_per_row(&self) -> usize {
        self.coverage_width() as usize
    }

    #[inline]
    pub fn coverage_width(&self) -> u32 {
        self.cell_w * self.raster_density as u32
    }

    #[inline]
    pub fn coverage_height(&self) -> u32 {
        self.cell_h * self.raster_density as u32
    }

    /// The density-scaled coverage bytes of one glyph (top row first).
    /// Inactive/reclaimed runtime gids (and out-of-range gids) resolve to one
    /// transparent fixed-size cell so stale DrawList words remain safe.
    pub fn glyph_rows(&self, gid: u16) -> &[u8] {
        let per_glyph = self.coverage_height() as usize * self.bytes_per_row();
        if gid < self.static_glyph_count {
            let start = gid as usize * per_glyph;
            return &self.bitmap[start..start + per_glyph];
        }
        let Some(runtime) = self
            .runtime_glyphs
            .get((gid - self.static_glyph_count) as usize)
        else {
            return &self.zero_cell;
        };
        runtime.bitmap.as_deref().unwrap_or(&self.zero_cell)
    }

    #[inline]
    fn runtime_bytes(&self) -> usize {
        self.runtime_glyphs
            .iter()
            .filter_map(|glyph| glyph.bitmap.as_ref())
            .map(|bitmap| bitmap.len())
            .sum()
    }

    #[inline]
    fn touch_runtime_gid(&self, gid: u16, tick: u64) {
        if gid < self.static_glyph_count {
            return;
        }
        if let Some(glyph) = self
            .runtime_glyphs
            .get((gid - self.static_glyph_count) as usize)
        {
            if glyph.codepoint.is_some() {
                glyph.last_used.set(tick);
            }
        }
    }

    fn lru_runtime_gid(&self) -> Option<(u16, u64)> {
        self.runtime_glyphs
            .iter()
            .enumerate()
            .filter(|(_, glyph)| glyph.codepoint.is_some())
            .min_by_key(|(_, glyph)| glyph.last_used.get())
            .map(|(index, glyph)| {
                (
                    self.static_glyph_count + index as u16,
                    glyph.last_used.get(),
                )
            })
    }

    /// Reclaim one active runtime gid. Its cmap mapping and coverage allocation
    /// are removed, while the gid remains addressable as a transparent cell.
    fn evict_runtime_gid(&mut self, gid: u16) -> usize {
        if gid < self.static_glyph_count {
            return 0;
        }
        let Some(glyph) = self
            .runtime_glyphs
            .get_mut((gid - self.static_glyph_count) as usize)
        else {
            return 0;
        };
        let Some(codepoint) = glyph.codepoint.take() else {
            return 0;
        };
        if let Ok(index) = self
            .cmap
            .binary_search_by(|entry| entry.codepoint.cmp(&codepoint))
        {
            self.cmap.remove(index);
        }
        glyph.last_used.set(0);
        glyph.bitmap.take().map_or(0, |bitmap| bitmap.len())
    }

    fn insert_runtime_glyph_at(
        &mut self,
        codepoint: u32,
        advance: u8,
        xoff: u8,
        coverage: &[u8],
        tick: u64,
    ) -> Option<u16> {
        if let Some(entry) = self.lookup_entry(codepoint) {
            self.touch_runtime_gid(entry.gid, tick);
            return Some(entry.gid);
        }
        let per_glyph = self.coverage_height() as usize * self.bytes_per_row();
        if coverage.len() != per_glyph {
            return None;
        }
        let (gid, runtime_index) = if let Some(index) = self
            .runtime_glyphs
            .iter()
            .position(|glyph| glyph.codepoint.is_none())
        {
            (self.static_glyph_count + index as u16, index)
        } else {
            if self.glyph_count == u16::MAX {
                return None;
            }
            let gid = self.glyph_count;
            self.glyph_count = self.glyph_count.checked_add(1)?;
            self.runtime_glyphs.push(RuntimeGlyph {
                codepoint: None,
                last_used: Cell::new(0),
                bitmap: None,
            });
            (gid, self.runtime_glyphs.len() - 1)
        };
        let glyph = &mut self.runtime_glyphs[runtime_index];
        glyph.codepoint = Some(codepoint);
        glyph.last_used.set(tick);
        glyph.bitmap = Some(coverage.into());
        let entry = CmapEntry {
            codepoint,
            gid,
            advance,
            xoff,
        };
        let index = self.cmap.partition_point(|entry| entry.codepoint < codepoint);
        self.cmap.insert(index, entry);
        Some(gid)
    }

    /// Insert a runtime-rasterized glyph into this atlas. Core users should
    /// normally go through [`crate::Ui::ensure_font_glyph`], which enforces the
    /// global runtime budget and LRU. This direct helper preserves the existing
    /// Atlas API and reuses any already-reclaimed gid.
    pub fn insert_runtime_glyph(
        &mut self,
        codepoint: u32,
        advance: u8,
        xoff: u8,
        coverage: &[u8],
    ) -> Option<u16> {
        self.insert_runtime_glyph_at(codepoint, advance, xoff, coverage, 1)
    }

    /// Average one logical pixel's density×density coverage samples. This is
    /// the reference reduction for logical-resolution software/CPU fallback
    /// renderers; density 1 returns the original byte exactly.
    pub fn logical_coverage(&self, gid: u16, x: u32, y: u32) -> u8 {
        if gid >= self.glyph_count || x >= self.cell_w || y >= self.cell_h {
            return 0;
        }
        let density = self.raster_density as usize;
        let rows = self.glyph_rows(gid);
        let bpr = self.bytes_per_row();
        let x0 = x as usize * density;
        let y0 = y as usize * density;
        let mut sum = 0u32;
        for sample_y in 0..density {
            let row = (y0 + sample_y) * bpr;
            for sample_x in 0..density {
                sum += rows[row + x0 + sample_x] as u32;
            }
        }
        let samples = (density * density) as u32;
        ((sum + samples / 2) / samples) as u8
    }
}

/// A placed glyph from inline-run layout: cell top-left relative to the box
/// origin.
#[derive(Clone, Copy, Debug)]
pub struct GlyphPos {
    pub gid: u16,
    pub x: f32,
    pub y: f32,
}

/// The per-core atlas registry.
pub struct Fonts {
    slots: [Option<Atlas>; spec::MAX_FONT_SLOTS],
    /// cmap-miss counter (Cell: measurement is `&self` per the pinned `Ui`
    /// signature but a miss must still count).
    pub misses: Cell<u32>,
    /// Deduplicated host work queue. Layout/measurement are `&self`, so misses
    /// use interior mutability; `take_missing_glyphs` drains it explicitly.
    missing: RefCell<Vec<(u8, u32)>>,
    runtime_budget_bytes: usize,
    runtime_bytes: usize,
    /// Monotonic LRU clock, touched by actual text glyph lookup.
    runtime_clock: Cell<u64>,
}

pub(crate) struct RuntimeGlyphUpdate {
    pub gid: u16,
    pub changed: bool,
    pub evicted: bool,
}

impl Default for Fonts {
    fn default() -> Self {
        Self::new()
    }
}

impl Fonts {
    pub fn new() -> Fonts {
        Fonts {
            slots: Default::default(),
            misses: Cell::new(0),
            missing: RefCell::new(Vec::new()),
            runtime_budget_bytes: DEFAULT_RUNTIME_GLYPH_BUDGET_BYTES,
            runtime_bytes: 0,
            runtime_clock: Cell::new(0),
        }
    }

    /// Parse + register an atlas at the slot in its header.
    pub fn load(&mut self, bytes: &[u8]) -> bool {
        match Atlas::parse(bytes) {
            Some(atlas) => {
                let slot = atlas.slot as usize;
                if let Some(previous) = self.slots[slot].as_ref() {
                    self.runtime_bytes = self.runtime_bytes.saturating_sub(previous.runtime_bytes());
                }
                self.slots[slot] = Some(atlas);
                // A replacement atlas invalidates stale requests for this slot;
                // still-missing codepoints will enqueue again on their next lookup.
                self.missing
                    .get_mut()
                    .retain(|(missing_slot, _)| *missing_slot as usize != slot);
                true
            }
            None => false,
        }
    }

    #[inline]
    pub fn atlas(&self, slot: u8) -> Option<&Atlas> {
        self.slots.get(slot as usize)?.as_ref()
    }

    #[inline]
    pub fn atlas_mut(&mut self, slot: u8) -> Option<&mut Atlas> {
        self.slots.get_mut(slot as usize)?.as_mut()
    }

    #[inline]
    fn next_runtime_tick(&self) -> u64 {
        let tick = self.runtime_clock.get().wrapping_add(1).max(1);
        self.runtime_clock.set(tick);
        tick
    }

    fn touch_runtime_glyph(&self, atlas: &Atlas, gid: u16) {
        if gid >= atlas.static_glyph_count {
            atlas.touch_runtime_gid(gid, self.next_runtime_tick());
        }
    }

    fn record_missing(&self, slot: u8, codepoint: u32) {
        let mut missing = self.missing.borrow_mut();
        if !missing.contains(&(slot, codepoint)) {
            missing.push((slot, codepoint));
        }
    }

    fn remove_missing(&mut self, slot: u8, codepoint: u32) {
        self.missing
            .get_mut()
            .retain(|request| *request != (slot, codepoint));
    }

    fn lru_runtime_glyph(&self) -> Option<(u8, u16)> {
        self.slots
            .iter()
            .enumerate()
            .filter_map(|(slot, atlas)| {
                let (gid, tick) = atlas.as_ref()?.lru_runtime_gid()?;
                Some((tick, slot as u8, gid))
            })
            .min_by_key(|(tick, _, _)| *tick)
            .map(|(_, slot, gid)| (slot, gid))
    }

    fn evict_lru_runtime_glyph(&mut self) -> bool {
        let Some((slot, gid)) = self.lru_runtime_glyph() else {
            return false;
        };
        let freed = self
            .atlas_mut(slot)
            .map_or(0, |atlas| atlas.evict_runtime_gid(gid));
        self.runtime_bytes = self.runtime_bytes.saturating_sub(freed);
        freed != 0
    }

    pub fn runtime_budget_bytes(&self) -> usize {
        self.runtime_budget_bytes
    }

    pub fn runtime_bytes(&self) -> usize {
        self.runtime_bytes
    }

    /// Set the global runtime coverage budget. Returns true when lowering it
    /// evicted at least one glyph.
    pub fn set_runtime_budget_bytes(&mut self, bytes: usize) -> bool {
        self.runtime_budget_bytes = bytes;
        let mut evicted = false;
        while self.runtime_bytes > self.runtime_budget_bytes {
            if !self.evict_lru_runtime_glyph() {
                break;
            }
            evicted = true;
        }
        evicted
    }

    /// Drain the deduplicated `(font slot, Unicode codepoint)` host work queue.
    pub fn take_missing_glyphs(&self) -> Vec<(u8, u32)> {
        core::mem::take(&mut *self.missing.borrow_mut())
    }

    pub(crate) fn ensure_runtime_glyph(
        &mut self,
        slot: u8,
        codepoint: u32,
        advance: u8,
        xoff: u8,
        coverage: &[u8],
    ) -> Option<RuntimeGlyphUpdate> {
        let atlas = self.atlas(slot)?;
        if let Some(entry) = atlas.lookup_entry(codepoint) {
            let gid = entry.gid;
            self.touch_runtime_glyph(atlas, gid);
            self.remove_missing(slot, codepoint);
            return Some(RuntimeGlyphUpdate {
                gid,
                changed: false,
                evicted: false,
            });
        }
        let per_glyph = atlas.coverage_height() as usize * atlas.bytes_per_row();
        if coverage.len() != per_glyph
            || per_glyph > self.runtime_budget_bytes
            || (atlas.runtime_glyphs.iter().all(|glyph| glyph.codepoint.is_some())
                && atlas.glyph_count == u16::MAX)
        {
            return None;
        }

        let mut evicted = false;
        while self.runtime_bytes.saturating_add(per_glyph) > self.runtime_budget_bytes {
            if !self.evict_lru_runtime_glyph() {
                return None;
            }
            evicted = true;
        }
        let tick = self.next_runtime_tick();
        let gid = self
            .atlas_mut(slot)?
            .insert_runtime_glyph_at(codepoint, advance, xoff, coverage, tick)?;
        self.runtime_bytes += per_glyph;
        self.remove_missing(slot, codepoint);
        Some(RuntimeGlyphUpdate {
            gid,
            changed: true,
            evicted,
        })
    }

    /// See [`Atlas::insert_runtime_glyph`]. This compatibility helper now goes
    /// through the global budgeted LRU.
    pub fn insert_runtime_glyph(
        &mut self,
        slot: u8,
        codepoint: u32,
        advance: u8,
        xoff: u8,
        coverage: &[u8],
    ) -> Option<u16> {
        self.ensure_runtime_glyph(slot, codepoint, advance, xoff, coverage)
            .map(|update| update.gid)
    }

    /// (gid, advance, xoff) for a codepoint; a miss resolves to gid 0 (tofu,
    /// cell width advance), bumps the miss counter, and queues deduplicated host
    /// raster work. Runtime hits update the global LRU at actual lookup time.
    fn glyph(&self, atlas: &Atlas, cp: u32) -> (u16, f32, f32) {
        match atlas.lookup_entry(cp) {
            Some(entry) => {
                self.touch_runtime_glyph(atlas, entry.gid);
                (entry.gid, entry.advance as f32, entry.xoff as f32)
            }
            None => {
                self.misses.set(self.misses.get().wrapping_add(1));
                self.record_missing(atlas.slot, cp);
                (0, atlas.cell_w as f32, 0.0)
            }
        }
    }

    /// Measure a run: (max line width, line count x line height). Empty text
    /// or an unregistered slot measures (0, 0).
    pub fn measure_run(&self, text: &str, slot: u8, tracking: f32, line_h_override: f32) -> (f32, f32) {
        let Some(atlas) = self.atlas(slot) else { return (0.0, 0.0) };
        if text.is_empty() {
            return (0.0, 0.0);
        }
        let lh = if line_h_override.is_nan() {
            atlas.line_height as f32
        } else {
            line_h_override
        };
        let mut max_w = 0.0f32;
        let mut line_w = 0.0f32;
        let mut lines = 1u32;
        for ch in text.chars() {
            if ch == '\n' {
                max_w = max_w.max(line_w);
                line_w = 0.0;
                lines += 1;
                continue;
            }
            let (_, adv, _) = self.glyph(atlas, ch as u32);
            line_w += adv + tracking;
        }
        max_w = max_w.max(line_w);
        (max_w, lines as f32 * lh)
    }

    /// Inline-run layout: place every glyph (cell top-left, relative to the
    /// box origin) honoring text-align within `box_w` and per-line vertical
    /// centering of the glyph cell inside the line box.
    pub fn layout_run(
        &self,
        text: &str,
        slot: u8,
        tracking: f32,
        line_h_override: f32,
        align: u8,
        box_w: f32,
        out: &mut Vec<GlyphPos>,
    ) {
        let Some(atlas) = self.atlas(slot) else { return };
        if text.is_empty() {
            return;
        }
        let lh = if line_h_override.is_nan() {
            atlas.line_height as f32
        } else {
            line_h_override
        };
        let cell_h = atlas.cell_h as f32;
        let mut line_top = 0.0f32;
        for line in text.split('\n') {
            // Single glyph pass per line (so cmap misses count once): place
            // at pen-from-0, then shift the whole line by the align offset.
            let line_start = out.len();
            let mut pen = 0.0f32;
            let y = line_top + (lh - cell_h) * 0.5;
            for ch in line.chars() {
                let (gid, adv, xoff) = self.glyph(atlas, ch as u32);
                // The cell holds the outline shifted right by xoff (negative
                // LSB accents) — place it at pen - xoff so ink lands at pen.
                out.push(GlyphPos { gid, x: pen - xoff, y });
                pen += adv + tracking;
            }
            let offset = match align {
                a if a == spec::TextAlign::Center as u8 => (box_w - pen) * 0.5,
                a if a == spec::TextAlign::Right as u8 => box_w - pen,
                _ => 0.0,
            };
            if offset != 0.0 {
                for g in &mut out[line_start..] {
                    g.x += offset;
                }
            }
            line_top += lh;
        }
    }
}
