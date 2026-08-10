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
    if source.starts_with("http://") || source.starts_with("https://") {
        let response = ureq::get(source)
            .set("User-Agent", "PocketJS-Kindle-Manga/0.1")
            .call()
            .with_context(|| format!("GET {source}"))?;
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

/// Fit `img` into `panel_w` x `panel_h` (letterbox on white/paper gray),
/// output Gray8 at exact panel size.
pub fn fit_to_panel_gray8(img: &DynamicImage, panel_w: usize, panel_h: usize) -> Result<GrayPage> {
    if panel_w == 0 || panel_h == 0 {
        bail!("invalid panel size {panel_w}x{panel_h}");
    }
    let (src_w, src_h) = img.dimensions();
    if src_w == 0 || src_h == 0 {
        bail!("decoded image has empty dimensions");
    }

    let scale = (panel_w as f32 / src_w as f32).min(panel_h as f32 / src_h as f32);
    let dst_w = ((src_w as f32 * scale).round() as u32).max(1);
    let dst_h = ((src_h as f32 * scale).round() as u32).max(1);

    let resized = img.resize(dst_w, dst_h, FilterType::Triangle);
    let gray = resized.to_luma8();

    // Paper-like background (light gray) for letterboxing on e-ink.
    let mut pixels = vec![0xf0u8; panel_w * panel_h];
    let off_x = (panel_w.saturating_sub(dst_w as usize)) / 2;
    let off_y = (panel_h.saturating_sub(dst_h as usize)) / 2;

    for y in 0..dst_h as usize {
        let src_row = y * dst_w as usize;
        let dst_row = (y + off_y) * panel_w + off_x;
        let row = &gray.as_raw()[src_row..src_row + dst_w as usize];
        pixels[dst_row..dst_row + dst_w as usize].copy_from_slice(row);
    }

    Ok(GrayPage {
        width: panel_w,
        height: panel_h,
        pixels,
    })
}

/// Load + decode + fit in one step.
pub fn load_page(source: &str, panel_w: usize, panel_h: usize) -> Result<GrayPage> {
    let bytes = load_bytes(source)?;
    let img = decode_image(&bytes)?;
    log::info!(
        "remote_image: loaded {} ({} bytes, {}x{}, format hint {:?})",
        source,
        bytes.len(),
        img.width(),
        img.height(),
        image::guess_format(&bytes).ok().unwrap_or(ImageFormat::Jpeg)
    );
    fit_to_panel_gray8(&img, panel_w, panel_h)
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
}
