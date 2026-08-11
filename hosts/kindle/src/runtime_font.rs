//! Lazy host-side glyph rasterization for font-atlas cmap misses.
//!
//! The core owns the fixed-budget cross-slot LRU. This module keeps one regular
//! outline face resident, rasterizes only requested codepoints, and synthesizes
//! bold coverage without loading a second CJK face.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use ab_glyph::{Font, FontVec, PxScale, ScaleFont, point};
use anyhow::{Context, Result};
use pocketjs_core::Ui;

const SLOT_PX: [u16; 7] = [12, 14, 16, 18, 20, 24, 36];
const FONT_CANDIDATES: &[&str] = &[
    "/usr/java/lib/fonts/STHeitiMedium.ttf",
    "/mnt/us/koreader/fonts/noto/NotoSansCJKsc-Regular.otf",
    "/mnt/us/koreader/fonts/NotoSansCJKsc-Regular.otf",
    "/mnt/us/extensions/koreader/fonts/noto/NotoSansCJKsc-Regular.otf",
    "/mnt/us/extensions/koreader/fonts/NotoSansCJKsc-Regular.otf",
    "/mnt/us/pocketjs-dev/fonts/NotoSansSC-Regular.otf",
    "assets/fonts/NotoSansSC-Regular.otf",
    "../../assets/fonts/NotoSansSC-Regular.otf",
];

struct LoadedFace {
    font: FontVec,
    path: PathBuf,
}

pub struct RuntimeFonts {
    face: Option<LoadedFace>,
    load_attempted: bool,
}

#[derive(Clone, Copy)]
struct SlotSpec {
    logical_px: u16,
    cell_w: u32,
    cell_h: u32,
    baseline: u32,
    density: u8,
    bold: bool,
}

impl RuntimeFonts {
    pub fn new() -> Self {
        Self {
            face: None,
            load_attempted: false,
        }
    }

    fn candidate_paths() -> Vec<PathBuf> {
        let mut paths = Vec::with_capacity(FONT_CANDIDATES.len() + 1);
        if let Some(path) = env::var_os("POCKETJS_CJK_FONT") {
            paths.push(PathBuf::from(path));
        }
        paths.extend(FONT_CANDIDATES.iter().map(PathBuf::from));
        paths
    }

    fn load_face(path: &Path) -> Result<LoadedFace> {
        let bytes =
            fs::read(path).with_context(|| format!("read runtime font {}", path.display()))?;
        let font = FontVec::try_from_vec(bytes)
            .map_err(|error| anyhow::anyhow!("parse runtime font {}: {error:?}", path.display()))?;
        Ok(LoadedFace {
            font,
            path: path.to_path_buf(),
        })
    }

    fn ensure_face(&mut self) -> Option<&LoadedFace> {
        if self.face.is_some() {
            return self.face.as_ref();
        }
        if self.load_attempted {
            return None;
        }
        self.load_attempted = true;

        let mut failures = Vec::new();
        for path in Self::candidate_paths() {
            if !path.is_file() {
                continue;
            }
            match Self::load_face(&path) {
                Ok(face) => {
                    log::info!("runtime_font: loaded lazy face {}", face.path.display());
                    self.face = Some(face);
                    return self.face.as_ref();
                }
                Err(error) => failures.push(error.to_string()),
            }
        }

        if failures.is_empty() {
            log::warn!(
                "runtime_font: no CJK font found; set POCKETJS_CJK_FONT or install STHeiti/KOReader Noto"
            );
        } else {
            log::warn!(
                "runtime_font: could not load a CJK face: {}",
                failures.join("; ")
            );
        }
        None
    }

    fn slot_spec(ui: &Ui, slot: u8) -> Option<SlotSpec> {
        let atlas = ui.font_atlas(slot)?;
        let logical_px = SLOT_PX
            .get((slot as usize) % SLOT_PX.len())
            .copied()
            .unwrap_or(atlas.cell_h.min(u16::MAX as u32) as u16);
        Some(SlotSpec {
            logical_px,
            cell_w: atlas.cell_w,
            cell_h: atlas.cell_h,
            baseline: atlas.baseline,
            density: atlas.raster_density,
            bold: atlas.flags & pocketjs_core::spec::font_atlas::FLAG_BOLD != 0,
        })
    }

    fn rasterize_cell(
        face: &LoadedFace,
        spec: SlotSpec,
        codepoint: u32,
    ) -> Option<(u8, u8, Vec<u8>)> {
        let ch = char::from_u32(codepoint)?;
        let glyph_id = face.font.glyph_id(ch);
        if glyph_id.0 == 0 {
            return None;
        }

        let density = spec.density.max(1) as usize;
        let physical_w = spec.cell_w as usize * density;
        let physical_h = spec.cell_h as usize * density;
        let physical_px = spec.logical_px as f32 * density as f32;
        let scale = PxScale::from(physical_px);
        let scaled = face.font.as_scaled(scale);
        let advance = (scaled.h_advance(glyph_id) / density as f32)
            .round()
            .clamp(0.0, u8::MAX as f32) as u8;
        let mut cell = vec![0u8; physical_w.saturating_mul(physical_h)];
        let mut xoff = 0u8;

        let glyph = glyph_id
            .with_scale_and_position(scale, point(0.0, spec.baseline as f32 * density as f32));
        if let Some(outlined) = face.font.outline_glyph(glyph) {
            let bounds = outlined.px_bounds();
            xoff = ((-bounds.min.x).max(0.0) / density as f32)
                .ceil()
                .clamp(0.0, u8::MAX as f32) as u8;
            let origin_x = bounds.min.x.floor() as i32 + xoff as i32 * density as i32;
            let origin_y = bounds.min.y.floor() as i32;
            outlined.draw(|x, y, coverage| {
                let dx = origin_x + x as i32;
                let dy = origin_y + y as i32;
                if dx < 0 || dy < 0 || dx >= physical_w as i32 || dy >= physical_h as i32 {
                    return;
                }
                cell[dy as usize * physical_w + dx as usize] =
                    (coverage * 255.0).round().clamp(0.0, 255.0) as u8;
            });
        }

        if spec.bold {
            embolden_horizontal(&mut cell, physical_w, physical_h);
        }
        Some((advance, xoff, cell))
    }

    pub fn resolve_missing(&mut self, ui: &mut Ui, requests: &[(u8, u32)]) -> u32 {
        if requests.is_empty() {
            return 0;
        }
        let Some(face) = self.ensure_face() else {
            return 0;
        };

        let mut inserted = 0u32;
        for &(slot, codepoint) in requests {
            if ui.font_has_glyph(slot, codepoint) {
                continue;
            }
            let Some(spec) = Self::slot_spec(ui, slot) else {
                continue;
            };
            let Some((advance, xoff, bitmap)) = Self::rasterize_cell(face, spec, codepoint) else {
                continue;
            };
            if ui.ensure_font_glyph(slot, codepoint, advance, xoff, &bitmap) {
                inserted = inserted.saturating_add(1);
            }
        }
        inserted
    }
}

fn embolden_horizontal(bitmap: &mut [u8], width: usize, height: usize) {
    if width < 2 || height == 0 {
        return;
    }
    for y in 0..height {
        let row = &mut bitmap[y * width..(y + 1) * width];
        for x in (1..width).rev() {
            row[x] = row[x].max(row[x - 1]);
        }
    }
}

pub fn global_runtime_fonts() -> &'static Mutex<RuntimeFonts> {
    static CELL: std::sync::OnceLock<Mutex<RuntimeFonts>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(RuntimeFonts::new()))
}

pub fn resolve_missing_on_ui(ui: &mut Ui, requests: &[(u8, u32)]) -> Result<u32> {
    let mut guard = global_runtime_fonts()
        .lock()
        .map_err(|_| anyhow::anyhow!("runtime_font lock poisoned"))?;
    Ok(guard.resolve_missing(ui, requests))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_atlas(slot: u8, bold: bool) -> Vec<u8> {
        const CELL_W: usize = 16;
        const CELL_H: usize = 20;
        const DENSITY: usize = 4;
        let cell_bytes = CELL_W * CELL_H * DENSITY * DENSITY;
        let mut out = vec![0u8; pocketjs_core::spec::font_atlas::HEADER_SIZE + 8 + cell_bytes];
        out[0..4].copy_from_slice(&pocketjs_core::spec::font_atlas::MAGIC.to_le_bytes());
        out[4..6].copy_from_slice(&pocketjs_core::spec::font_atlas::VERSION.to_le_bytes());
        out[6..8].copy_from_slice(&1u16.to_le_bytes());
        out[8] = CELL_W as u8;
        out[9] = CELL_H as u8;
        out[10] = 15;
        out[11] = CELL_H as u8;
        out[12] = slot;
        out[13] = if bold {
            pocketjs_core::spec::font_atlas::FLAG_BOLD
        } else {
            0
        };
        out[14] = DENSITY as u8;
        let cmap = pocketjs_core::spec::font_atlas::HEADER_SIZE;
        out[cmap..cmap + 4].copy_from_slice(&0xfffdu32.to_le_bytes());
        out[cmap + 4..cmap + 6].copy_from_slice(&0u16.to_le_bytes());
        out[cmap + 6] = 9;
        out
    }

    #[test]
    fn noto_outline_fills_the_core_fixed_cell() {
        let path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../assets/fonts/NotoSansSC-Regular.otf");
        let face = RuntimeFonts::load_face(&path).expect("load test CJK font");
        let mut runtime = RuntimeFonts {
            face: Some(face),
            load_attempted: true,
        };
        let mut ui = Ui::new_with_raster_density(4);
        assert!(ui.load_font_atlas(&empty_atlas(2, false)));

        assert_eq!(runtime.resolve_missing(&mut ui, &[(2, '中' as u32)]), 1);
        assert!(ui.font_has_glyph(2, '中' as u32));
        assert_eq!(ui.runtime_glyph_memory_bytes(), 16 * 20 * 4 * 4);
        let atlas = ui.font_atlas(2).expect("slot 2 atlas");
        let gid = atlas.lookup_entry('中' as u32).expect("runtime cmap").gid;
        assert!(atlas.glyph_rows(gid).iter().any(|sample| *sample != 0));
    }
}
