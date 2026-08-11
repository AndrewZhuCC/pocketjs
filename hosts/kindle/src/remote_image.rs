//! Load a still image from a local path or http(s) URL, decode, and produce a
//! panel-sized Gray8 buffer for direct framebuffer blit.
//!
//! This is the foundation for the Suwayomi manga reader: pages are runtime
//! URLs, not build-time pak entries. Texture upload is capped at 512px in the
//! UI core; full-page comics therefore blit Gray8 straight to the panel.

use std::io::Read;
use std::path::Path;

use anyhow::{Context, Result, bail};
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageFormat};

/// Decoded page ready to write into the Kindle framebuffer pipeline.
#[derive(Debug, Clone)]
pub struct GrayPage {
    pub width: usize,
    pub height: usize,
    /// Row-major Gray8, length == width * height.
    pub pixels: Vec<u8>,
}

/// Fetch raw bytes from `source`:
/// - `http://` / `https://` → ureq GET
/// - anything else → filesystem path
pub fn load_bytes(source: &str) -> Result<Vec<u8>> {
    load_bytes_with_headers(source, None)
}

/// Like [`load_bytes`], optionally sending a raw `Cookie` header (Suwayomi
/// page URLs usually require the login session cookie).
pub fn load_bytes_with_headers(source: &str, cookie: Option<&str>) -> Result<Vec<u8>> {
    if source.starts_with("http://") || source.starts_with("https://") {
        let mut req = ureq::get(source).set("User-Agent", "PocketJS-Kindle-Manga/0.1");
        if let Some(c) = cookie.filter(|s| !s.is_empty()) {
            req = req.set("Cookie", c);
        }
        let response = req.call().with_context(|| format!("GET {source}"))?;
        let status = response.status();
        if !(200..300).contains(&status) {
            bail!("GET {source} returned HTTP {status}");
        }
        let mut body = Vec::new();
        response
            .into_reader()
            .take(40 * 1024 * 1024)
            .read_to_end(&mut body)
            .context("reading response body")?;
        if body.is_empty() {
            bail!("GET {source} returned an empty body");
        }
        Ok(body)
    } else {
        let path = Path::new(source);
        std::fs::read(path).with_context(|| format!("reading {}", path.display()))
    }
}

fn decode_image(bytes: &[u8]) -> Result<DynamicImage> {
    // Prefer format sniffing so Suwayomi proxy URLs without extensions work.
    let format = image::guess_format(bytes).ok();
    let img = match format {
        Some(fmt) => image::load_from_memory_with_format(bytes, fmt)
            .with_context(|| format!("decoding image as {fmt:?}"))?,
        None => image::load_from_memory(bytes).context("decoding image")?,
    };
    Ok(img)
}

/// Drop near-white margins common on manga scans (threshold 0..=255).
/// A row/col counts as "ink" only if enough non-white pixels exist (avoids
/// keeping huge empty margins that only have a speck of dust/noise).
fn trim_near_white_margins(img: &DynamicImage, white_ge: u8) -> DynamicImage {
    let gray = img.to_luma8();
    let (w, h) = gray.dimensions();
    if w < 8 || h < 8 {
        return img.clone();
    }
    let raw = gray.as_raw();
    // ≥1.5% of the row/col must be ink — kills sparse noise in margins.
    let row_ink_min = ((w as usize) * 15 / 1000).max(3);
    let col_ink_min = ((h as usize) * 15 / 1000).max(3);
    let row_has_ink = |y: u32| -> bool {
        let row = (y as usize) * w as usize;
        raw[row..row + w as usize]
            .iter()
            .filter(|&&p| p < white_ge)
            .count()
            >= row_ink_min
    };
    let col_has_ink = |x: u32| -> bool {
        let mut n = 0usize;
        for y in 0..h as usize {
            if raw[y * w as usize + x as usize] < white_ge {
                n += 1;
                if n >= col_ink_min {
                    return true;
                }
            }
        }
        false
    };
    let mut top = 0u32;
    while top < h && !row_has_ink(top) {
        top += 1;
    }
    let mut bot = h;
    while bot > top && !row_has_ink(bot - 1) {
        bot -= 1;
    }
    let mut left = 0u32;
    while left < w && !col_has_ink(left) {
        left += 1;
    }
    let mut right = w;
    while right > left && !col_has_ink(right - 1) {
        right -= 1;
    }
    // No pad — user wants edge-to-edge fill; panel borders can touch the screen.
    if right <= left + 8 || bot <= top + 8 {
        return img.clone();
    }
    log::info!(
        "remote_image: trim margins LTRB=({},{},{},{}) from {}x{}",
        left,
        top,
        w - right,
        h - bot,
        w,
        h
    );
    img.crop_imm(left, top, right - left, bot - top)
}

/// Fit `img` into the **content band** of the panel (letterbox on paper gray).
///
/// `chrome_top` / `chrome_bot` are in **panel pixels** (already × density).
/// The page is scaled to fit inside
/// `panel_w × (panel_h - chrome_top - chrome_bot)` and centered in that band.
/// Chrome strips stay paper gray so UI chrome can draw on top without covering
/// manga pixels (previously full-panel fit made top/bottom of the page look cropped).
pub fn fit_to_panel_gray8(
    img: &DynamicImage,
    panel_w: usize,
    panel_h: usize,
) -> Result<GrayPage> {
    // Default: no chrome reservation (tests / non-reader hosts).
    fit_to_panel_gray8_chrome(img, panel_w, panel_h, 0, 0)
}

pub fn fit_to_panel_gray8_chrome(
    img: &DynamicImage,
    panel_w: usize,
    panel_h: usize,
    chrome_top: usize,
    chrome_bot: usize,
) -> Result<GrayPage> {
    if panel_w == 0 || panel_h == 0 {
        bail!("invalid panel size {panel_w}x{panel_h}");
    }
    let (src_w, src_h) = img.dimensions();
    if src_w == 0 || src_h == 0 {
        bail!("decoded image has empty dimensions");
    }

    let top = chrome_top.min(panel_h);
    let bot = chrome_bot.min(panel_h.saturating_sub(top));
    let content_h = panel_h.saturating_sub(top + bot).max(1);
    let content_w = panel_w.max(1);

    // Trim near-white scan margins so cover-fill uses the inked content box
    // (avoids large empty gutters that look like letterboxing).
    let img = trim_near_white_margins(img, 245);

    // Fit-all (CSS object-fit: contain): entire page visible, no content crop.
    // Tall manga → may letterbox on the sides; never crop top/bottom of the page.
    // Letterbox is pure white (matches typical manga paper); avoid mid-gray which
    // looked like a fake UI chrome strip on Kindle.
    let (src_w, src_h) = img.dimensions();
    let scale =
        (content_w as f32 / src_w as f32).min(content_h as f32 / src_h as f32);
    let dst_w = ((src_w as f32 * scale).round() as u32).max(1);
    let dst_h = ((src_h as f32 * scale).round() as u32).max(1);
    let resized = img.resize(dst_w, dst_h, FilterType::Triangle);
    let gray = resized.to_luma8();
    let raw = gray.as_raw();
    let dw = dst_w as usize;
    let dh = dst_h as usize;

    const LETTERBOX: u8 = 0xff; // white side gutters
    let mut pixels = vec![LETTERBOX; panel_w * panel_h];
    let off_x = (content_w.saturating_sub(dw)) / 2;
    let off_y = top + (content_h.saturating_sub(dh)) / 2;
    for y in 0..dh {
        let src_row = y * dw;
        let dst_row = (off_y + y) * panel_w + off_x;
        let n = dw.min(panel_w.saturating_sub(off_x));
        pixels[dst_row..dst_row + n].copy_from_slice(&raw[src_row..src_row + n]);
    }
    log::info!(
        "remote_image: fit-contain {}x{} -> {}x{} letterbox at ({},{})",
        src_w,
        src_h,
        dw,
        dh,
        off_x,
        off_y
    );

    Ok(GrayPage {
        width: panel_w,
        height: panel_h,
        pixels,
    })
}

/// Load + decode + fit in one step.
pub fn load_page(source: &str, panel_w: usize, panel_h: usize) -> Result<GrayPage> {
    load_page_with_headers(source, panel_w, panel_h, None, 0, 0)
}

/// Load + decode + fit, forwarding an optional Cookie header for authenticated
/// Suwayomi page URLs. `chrome_top`/`chrome_bot` reserve reader UI strips (panel px).
pub fn load_page_with_headers(
    source: &str,
    panel_w: usize,
    panel_h: usize,
    cookie: Option<&str>,
    chrome_top: usize,
    chrome_bot: usize,
) -> Result<GrayPage> {
    let bytes = load_bytes_with_headers(source, cookie)?;
    let img = decode_image(&bytes)?;
    log::info!(
        "remote_image: loaded {} ({} bytes, {}x{}, format hint {:?}, chrome={}+{})",
        source,
        bytes.len(),
        img.width(),
        img.height(),
        image::guess_format(&bytes).ok().unwrap_or(ImageFormat::Jpeg),
        chrome_top,
        chrome_bot
    );
    fit_to_panel_gray8_chrome(&img, panel_w, panel_h, chrome_top, chrome_bot)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Luma};

    #[test]
    fn letterbox_preserves_panel_size() {
        let img: DynamicImage =
            ImageBuffer::from_fn(100, 200, |_, _| Luma([128u8])).into();
        let page = fit_to_panel_gray8(&img, 1236, 1648).unwrap();
        assert_eq!(page.width, 1236);
        assert_eq!(page.height, 1648);
        assert_eq!(page.pixels.len(), 1236 * 1648);
    }

    #[test]
    fn contain_shows_full_tall_page() {
        // Tall dark page on wider panel → fit height, side letterbox near-black.
        let img: DynamicImage =
            ImageBuffer::from_fn(100, 200, |_, _| Luma([20u8])).into();
        let page = fit_to_panel_gray8_chrome(&img, 1236, 1648, 0, 0).unwrap();
        assert_eq!(page.pixels.len(), 1236 * 1648);
        // Center column should be dark content (full height used).
        let mid_x = 1236 / 2;
        assert!(page.pixels[mid_x] < 50, "top-center content");
        assert!(page.pixels[(1647) * 1236 + mid_x] < 50, "bottom-center content");
        // Side gutters pure white letterbox.
        assert_eq!(page.pixels[0], 0xff, "side letterbox white");
    }
}
