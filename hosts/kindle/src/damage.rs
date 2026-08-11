//! Final-pixel damage tracking. Diffing happens after rasterization to Gray8,
//! so color changes that collapse to the same e-ink pixel do not cause a
//! redundant panel update.

use pocketjs_core::damage::{DamagePolicy, DamageRect, DamageTracker as DrawDamageTracker};
use pocketjs_core::{Ui, raster};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x: usize,
    pub y: usize,
    pub w: usize,
    pub h: usize,
}

impl Rect {
    pub fn right(self) -> usize {
        self.x + self.w
    }

    pub fn bottom(self) -> usize {
        self.y + self.h
    }

    pub fn union(self, other: Self) -> Self {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        let right = self.right().max(other.right());
        let bottom = self.bottom().max(other.bottom());
        Self {
            x,
            y,
            w: right - x,
            h: bottom - y,
        }
    }
}

pub const TILE: usize = 16;

pub struct DamageTracker {
    current: Vec<u8>,
    previous: Vec<u8>,
    width: usize,
    height: usize,
    density: u32,
    /// Physical tiles touched by DrawList damage since the last successful
    /// panel present. Keeping this cumulative lets A→B→A disappear before a
    /// slower e-ink present without scanning the untouched screen.
    candidates: Vec<bool>,
    draw: DrawDamageTracker,
    /// Last manga page underlay (panel-sized Gray8). Kept across frames so a
    /// full UI raster (which clears to black) cannot permanently wipe the page.
    underlay: Option<Vec<u8>>,
    /// "12/32" burned as near-black pixels (floats on art).
    progress_overlay: String,
    /// Re-stamp progress on next rasterize (text changed or page seeded).
    progress_dirty: bool,
}

impl DamageTracker {
    pub fn new(width: usize, height: usize, density: u32) -> Self {
        Self {
            current: vec![0; width * height],
            previous: vec![0; width * height],
            width,
            height,
            density,
            candidates: vec![false; width.div_ceil(TILE) * height.div_ceil(TILE)],
            draw: DrawDamageTracker::new(),
            underlay: None,
            progress_overlay: String::new(),
            progress_dirty: false,
        }
    }

    pub fn set_progress_overlay(&mut self, text: &str) {
        if self.progress_overlay == text {
            return;
        }
        self.progress_overlay.clear();
        self.progress_overlay.push_str(text);
        self.progress_dirty = true;
    }

    pub fn current(&self) -> &[u8] {
        &self.current
    }

    pub fn width(&self) -> usize {
        self.width
    }

    pub fn height(&self) -> usize {
        self.height
    }

    /// Seed the retained Gray8 frame with a full-panel underlay (manga page).
    /// Marks every tile dirty so the next present refreshes the whole panel.
    /// If `pixels` is `None`, fills paper-gray (cleared reader underlay).
    pub fn seed_underlay(&mut self, pixels: Option<&[u8]>) {
        match pixels {
            Some(src) if src.len() == self.current.len() => {
                self.underlay = Some(src.to_vec());
                self.current.copy_from_slice(src);
            }
            _ => {
                self.underlay = None;
                self.current.fill(0xf0);
            }
        }
        // Force a full diff against the previous presented frame.
        if self.previous.len() == self.current.len() {
            for (p, c) in self.previous.iter_mut().zip(self.current.iter()) {
                *p = c.wrapping_add(1);
            }
        }
        self.candidates.fill(true);
        self.progress_dirty = true;
        // Invalidate draw snapshot so next raster starts clean on top of underlay.
        self.draw = DrawDamageTracker::new();
    }

    /// Re-blit stored underlay into the content band, preserving top/bottom chrome.
    /// `chrome_top_logical` / `chrome_bot_logical` are in logical UI px.
    pub fn restore_underlay_content_band(
        &mut self,
        chrome_top_logical: usize,
        chrome_bot_logical: usize,
    ) {
        let Some(ref under) = self.underlay else {
            return;
        };
        if under.len() != self.current.len() {
            return;
        }
        let d = self.density as usize;
        let top = (chrome_top_logical * d).min(self.height);
        let bot_chrome = (chrome_bot_logical * d).min(self.height);
        let bot = self.height.saturating_sub(bot_chrome);
        if top >= bot {
            return;
        }
        for y in top..bot {
            let row = y * self.width;
            self.current[row..row + self.width]
                .copy_from_slice(&under[row..row + self.width]);
        }
        // Content band must present.
        let cols = self.width.div_ceil(TILE);
        for tile_y in top / TILE..bot.div_ceil(TILE) {
            for tile_x in 0..cols {
                self.candidates[tile_y * cols + tile_x] = true;
            }
        }
    }

    /// Incrementally repaint DrawList damage into the persistent Gray8 frame.
    ///
    /// With a manga underlay we must NOT full-copy the page every frame (2MB×60Hz
    /// starves the Kindle and the process gets killed before inject taps land).
    /// Steady frames are no-ops; only UI damage / progress changes recompose.
    pub fn rasterize(&mut self, ui: &Ui, words: &[u32]) {
        let has_underlay = self
            .underlay
            .as_ref()
            .is_some_and(|u| u.len() == self.current.len());

        match raster::render_scaled_gray8_incremental(
            ui,
            words,
            &mut self.current,
            self.density,
            &mut self.draw,
            DamagePolicy::default(),
        ) {
            Ok(plan) => {
                let regions = plan.regions();
                self.mark_candidates(regions);
                if has_underlay {
                    if !regions.is_empty() {
                        self.repair_and_composite_chrome(regions);
                    } else if self.progress_dirty {
                        self.restamp_progress_only();
                    }
                }
            }
            Err(error) => {
                log::warn!("kindle damage planner fell back to full raster: {error:?}");
                if has_underlay {
                    if let Some(ref under) = self.underlay {
                        self.current.copy_from_slice(under);
                    }
                    self.restamp_progress_only();
                    // Full UI redraw on top would need a side buffer; for manga
                    // reader the common path is incremental. Mark full dirty.
                    self.draw.invalidate();
                    self.candidates.fill(true);
                } else {
                raster::render_scaled_gray8(ui, words, &mut self.current, self.density);
                self.draw.invalidate();
                self.candidates.fill(true);
            }
            }
        }
    }

    /// After UI damage cleared holes to black: restore underlay in those
    /// regions, then keep structured bottom menu / top loading if present.
    fn repair_and_composite_chrome(&mut self, regions: &[DamageRect]) {
        let Some(under) = self.underlay.as_ref() else {
            return;
        };
        if under.len() != self.current.len() {
            return;
        }
        let d = self.density as usize;
        let w = self.width;
        let h = self.height;

        // 1) Restore page pixels wherever the engine left pure black clear.
        {
            let current = &mut self.current;
            for region in regions {
                let x0 = (region.x0.max(0) as usize * d).min(w);
                let y0 = (region.y0.max(0) as usize * d).min(h);
                let x1 = (region.x1.max(0) as usize * d).min(w);
                let y1 = (region.y1.max(0) as usize * d).min(h);
                for y in y0..y1 {
                    let row = y * w;
                    for x in x0..x1 {
                        let i = row + x;
                        if current[i] == 0 {
                            current[i] = under[i];
                        }
                    }
                }
            }
        }

        // 2) Structured 3-button menu? keep UI bottom band (already in current
        //    where non-zero); flat app-bg must not win — already restored above.
        let menu_h = (52 * d).min(h);
        let menu0 = h - menu_h;
        let third = w / 3;
        let band_mean = |x0: usize, x1: usize| -> f32 {
            let mut s = 0u64;
            let mut n = 0u64;
            for y in menu0..h {
                let row = y * w;
                for x in x0..x1.min(w) {
                    s += self.current[row + x] as u64;
                    n += 1;
                }
            }
            if n == 0 {
                0.0
            } else {
                s as f32 / n as f32
            }
        };
        let m0 = band_mean(0, third);
        let m1 = band_mean(third, third * 2);
        let m2 = band_mean(third * 2, w);
        let spread = (m0 - m1).abs().max((m1 - m2).abs()).max((m0 - m2).abs());
        let menu = spread > 8.0 && m0 > 30.0 && m1 > 30.0 && m2 > 30.0;
        if menu {
            // Re-stamp progress over menu so digits stay visible.
            self.restamp_progress_only();
        } else {
            // Ensure progress corner is page+digits (UI may have punched holes).
            self.restamp_progress_only();
        }
    }

    fn restamp_progress_only(&mut self) {
        let Some(under) = self.underlay.as_ref() else {
            self.progress_dirty = false;
            return;
        };
        if under.len() != self.current.len() || self.progress_overlay.is_empty() {
            self.progress_dirty = false;
            return;
        }
        let w = self.width;
        let h = self.height;
        // Restore a small bottom-left patch from clean underlay, then burn digits.
        let pw = 160usize.min(w);
        let ph = 48usize.min(h);
        for y in (h - ph)..h {
            let row = y * w;
            self.current[row..row + pw].copy_from_slice(&under[row..row + pw]);
        }
                crate::manga_surface::stamp_progress_black(
                    &mut self.current,
                    w,
                    h,
                    self.progress_overlay.as_str(),
                );
            let cols = self.width.div_ceil(TILE);
            for tile_y in (h - ph) / TILE..h.div_ceil(TILE) {
                for tile_x in 0..pw.div_ceil(TILE) {
                    let idx = tile_y * cols + tile_x;
                    if idx < self.candidates.len() {
                        self.candidates[idx] = true;
                    }
                }
            }
        self.progress_dirty = false;
    }

    fn mark_candidates(&mut self, regions: &[DamageRect]) {
        let density = self.density as usize;
        let cols = self.width.div_ceil(TILE);
        for region in regions {
            let x0 = (region.x0.max(0) as usize * density).min(self.width);
            let y0 = (region.y0.max(0) as usize * density).min(self.height);
            let x1 = (region.x1.max(0) as usize * density).min(self.width);
            let y1 = (region.y1.max(0) as usize * density).min(self.height);
            if x0 >= x1 || y0 >= y1 {
                continue;
            }
            for tile_y in y0 / TILE..y1.div_ceil(TILE) {
                for tile_x in x0 / TILE..x1.div_ceil(TILE) {
                    self.candidates[tile_y * cols + tile_x] = true;
                }
            }
        }
    }

    pub fn diff(&self) -> Vec<Rect> {
        tile_damage_candidates(
            &self.current,
            &self.previous,
            self.width,
            self.height,
            TILE,
            &self.candidates,
        )
    }

    pub fn latch(&mut self) {
        self.previous.copy_from_slice(&self.current);
        self.candidates.fill(false);
    }
}

/// Merge horizontal runs of dirty tiles, then extend equal runs vertically.
/// This preserves holes instead of turning all damage into one giant box.
#[cfg(test)]
pub fn tile_damage(
    current: &[u8],
    previous: &[u8],
    width: usize,
    height: usize,
    tile: usize,
) -> Vec<Rect> {
    let candidates = vec![true; width.div_ceil(tile) * height.div_ceil(tile)];
    tile_damage_candidates(current, previous, width, height, tile, &candidates)
}

fn tile_damage_candidates(
    current: &[u8],
    previous: &[u8],
    width: usize,
    height: usize,
    tile: usize,
    candidates: &[bool],
) -> Vec<Rect> {
    assert_eq!(current.len(), width * height);
    assert_eq!(previous.len(), current.len());
    assert!(tile > 0);

    let cols = width.div_ceil(tile);
    let rows = height.div_ceil(tile);
    assert_eq!(candidates.len(), cols * rows);
    let mut dirty = vec![false; cols * rows];
    for tile_y in 0..rows {
        for tile_x in 0..cols {
            let tile_index = tile_y * cols + tile_x;
            if !candidates[tile_index] {
                continue;
            }
            let x0 = tile_x * tile;
            let y0 = tile_y * tile;
            let x1 = (x0 + tile).min(width);
            let y1 = (y0 + tile).min(height);
            'pixels: for y in y0..y1 {
                for x in x0..x1 {
                    let index = y * width + x;
                    if current[index] != previous[index] {
                        dirty[tile_index] = true;
                        break 'pixels;
                    }
                }
            }
        }
    }

    coalesce_tiles(&dirty, width, height, tile)
}

fn coalesce_tiles(dirty: &[bool], width: usize, height: usize, tile: usize) -> Vec<Rect> {
    let cols = width.div_ceil(tile);
    let rows = height.div_ceil(tile);
    let mut rects: Vec<Rect> = Vec::new();
    for tile_y in 0..rows {
        let mut tile_x = 0;
        while tile_x < cols {
            if !dirty[tile_y * cols + tile_x] {
                tile_x += 1;
                continue;
            }
            let start = tile_x;
            while tile_x < cols && dirty[tile_y * cols + tile_x] {
                tile_x += 1;
            }
            let x = start * tile;
            let y = tile_y * tile;
            let run = Rect {
                x,
                y,
                w: ((tile_x * tile).min(width)) - x,
                h: tile.min(height - y),
            };
            if let Some(existing) = rects
                .iter_mut()
                .find(|r| r.x == run.x && r.w == run.w && r.bottom() == run.y)
            {
                existing.h += run.h;
            } else {
                rects.push(run);
            }
        }
    }
    rects
}

pub fn merge_all(rects: &[Rect]) -> Option<Rect> {
    rects.iter().copied().reduce(Rect::union)
}

#[cfg(test)]
mod tests {
    use super::*;
    use pocketjs_core::spec::draw_op;

    fn xy_word(x: i16, y: i16) -> u32 {
        x as u16 as u32 | ((y as u16 as u32) << 16)
    }

    fn wh_word(w: u16, h: u16) -> u32 {
        w as u32 | ((h as u32) << 16)
    }

    fn two_region_frame(left: u32, right: u32) -> Vec<u32> {
        vec![
            draw_op::RECT,
            xy_word(0, 0),
            wh_word(48, 16),
            0xffff_ffff,
            draw_op::RECT,
            xy_word(2, 2),
            wh_word(4, 4),
            left,
            draw_op::RECT,
            xy_word(34, 2),
            wh_word(4, 4),
            right,
        ]
    }

    #[test]
    fn final_pixel_equality_has_no_damage() {
        assert!(tile_damage(&[17; 64], &[17; 64], 8, 8, 4).is_empty());
    }

    #[test]
    fn adjacent_tiles_coalesce_but_holes_survive() {
        let mut current = vec![0; 8 * 8];
        let previous = current.clone();
        // Top two tiles become one 8x4 run; bottom-right is separate.
        current[0] = 1;
        current[7] = 1;
        current[7 * 8 + 7] = 1;
        assert_eq!(
            tile_damage(&current, &previous, 8, 8, 4),
            vec![
                Rect {
                    x: 0,
                    y: 0,
                    w: 8,
                    h: 4,
                },
                Rect {
                    x: 4,
                    y: 4,
                    w: 4,
                    h: 4,
                }
            ]
        );
    }

    #[test]
    fn identical_runs_merge_vertically() {
        let mut current = vec![0; 8 * 8];
        let previous = current.clone();
        current[0] = 1;
        current[6 * 8] = 1;
        assert_eq!(
            tile_damage(&current, &previous, 8, 8, 4),
            vec![Rect {
                x: 0,
                y: 0,
                w: 4,
                h: 8,
            }]
        );
    }

    #[test]
    fn baseline_advances_only_when_presented() {
        let mut tracker = DamageTracker::new(8, 8, 1);

        // A transient A -> B -> A between physical presents disappears when
        // final pixels return to the last-presented baseline.
        tracker.candidates.fill(true);
        tracker.current.fill(200);
        assert!(!tracker.diff().is_empty());
        tracker.current.fill(0);
        assert!(tracker.diff().is_empty());

        // A successful present explicitly advances the baseline.
        tracker.current.fill(77);
        tracker.latch();
        assert!(tracker.diff().is_empty());
        tracker.current[0] = 78;
        tracker.candidates.fill(true);
        assert!(!tracker.diff().is_empty());
    }

    #[test]
    fn candidate_tiles_limit_pixel_scans_without_losing_pending_damage() {
        let mut current = vec![0; 8 * 8];
        let previous = current.clone();
        current[1] = 1;
        current[7 * 8 + 7] = 1;
        let candidates = [true, false, false, false];
        assert_eq!(
            tile_damage_candidates(&current, &previous, 8, 8, 4, &candidates),
            vec![Rect {
                x: 0,
                y: 0,
                w: 4,
                h: 4,
            }]
        );
    }

    #[test]
    fn retained_raster_accumulates_until_latch_and_can_return_to_baseline() {
        let mut ui = Ui::new();
        ui.set_viewport(48.0, 16.0);
        let white = 0xffff_ffff;
        let black = 0xff00_0000;
        let a = two_region_frame(white, white);
        let b = two_region_frame(black, white);
        let c = two_region_frame(black, black);
        let mut tracker = DamageTracker::new(48, 16, 1);

        tracker.rasterize(&ui, &a);
        tracker.latch();

        tracker.rasterize(&ui, &b);
        assert_eq!(
            tracker.diff(),
            vec![Rect {
                x: 0,
                y: 0,
                w: 16,
                h: 16,
            }]
        );

        tracker.rasterize(&ui, &c);
        assert_eq!(
            tracker.diff(),
            vec![
                Rect {
                    x: 0,
                    y: 0,
                    w: 16,
                    h: 16,
                },
                Rect {
                    x: 32,
                    y: 0,
                    w: 16,
                    h: 16,
                },
            ]
        );
        let mut full = vec![0; 48 * 16];
        raster::render_scaled_gray8(&ui, &c, &mut full, 1);
        assert_eq!(tracker.current(), full);

        tracker.rasterize(&ui, &a);
        assert!(tracker.diff().is_empty());
        raster::render_scaled_gray8(&ui, &a, &mut full, 1);
        assert_eq!(tracker.current(), full);
    }
}
