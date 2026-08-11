use std::collections::VecDeque;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use ab_glyph::{Font, FontVec, PxScale, ScaleFont, point};

const CACHE_BUDGET: usize = 4 * 1024 * 1024;

struct CachedGlyph {
    _codepoint: u32,
    _width: usize,
    _height: usize,
    _left: f32,
    _top: f32,
    _advance: f32,
    bitmap: Vec<u8>,
}

fn rss_kib() -> Option<u64> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    status.lines().find_map(|line| {
        let rest = line.strip_prefix("VmRSS:")?;
        rest.split_whitespace().next()?.parse().ok()
    })
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let font_path = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/usr/java/lib/fonts/STHeitiMedium.ttf"));
    let requested: usize = args.next().and_then(|s| s.parse().ok()).unwrap_or(1_000);
    let pixel_size: f32 = args.next().and_then(|s| s.parse().ok()).unwrap_or(64.0);

    println!(
        "font_probe start font={} requested={} px={} budget={} rss_kib={:?}",
        font_path.display(),
        requested,
        pixel_size,
        CACHE_BUDGET,
        rss_kib()
    );

    let font_bytes = fs::read(&font_path)?;
    let font = FontVec::try_from_vec(font_bytes)?;
    let scale = PxScale::from(pixel_size);
    let scaled = font.as_scaled(scale);
    let baseline = scaled.ascent();

    let mut cache = VecDeque::<CachedGlyph>::new();
    let mut cache_bytes = 0usize;
    let mut rendered = 0usize;
    let mut misses = 0usize;

    for offset in 0..requested {
        let cp = 0x4e00u32 + offset as u32;
        let Some(ch) = char::from_u32(cp) else {
            continue;
        };
        let glyph_id = font.glyph_id(ch);
        if glyph_id.0 == 0 {
            misses += 1;
            continue;
        }
        let glyph = glyph_id.with_scale_and_position(scale, point(0.0, baseline));
        let Some(outlined) = font.outline_glyph(glyph) else {
            misses += 1;
            continue;
        };
        let bounds = outlined.px_bounds();
        let width = bounds.width().ceil().max(0.0) as usize;
        let height = bounds.height().ceil().max(0.0) as usize;
        let mut bitmap = vec![0u8; width.saturating_mul(height)];
        outlined.draw(|x, y, coverage| {
            let index = y as usize * width + x as usize;
            if let Some(pixel) = bitmap.get_mut(index) {
                *pixel = (coverage * 255.0).round().clamp(0.0, 255.0) as u8;
            }
        });

        cache_bytes += bitmap.len();
        cache.push_back(CachedGlyph {
            _codepoint: cp,
            _width: width,
            _height: height,
            _left: bounds.min.x,
            _top: bounds.min.y,
            _advance: scaled.h_advance(glyph_id),
            bitmap,
        });
        rendered += 1;

        while cache_bytes > CACHE_BUDGET {
            if let Some(old) = cache.pop_front() {
                cache_bytes = cache_bytes.saturating_sub(old.bitmap.len());
            } else {
                break;
            }
        }

        if rendered % 100 == 0 {
            println!(
                "font_probe progress rendered={} cached={} cache_bytes={} rss_kib={:?}",
                rendered,
                cache.len(),
                cache_bytes,
                rss_kib()
            );
        }
    }

    println!(
        "font_probe done rendered={} misses={} cached={} cache_bytes={} rss_kib={:?}",
        rendered,
        misses,
        cache.len(),
        cache_bytes,
        rss_kib()
    );
    thread::sleep(Duration::from_secs(5));
    Ok(())
}
