//! Host-side command injection for agent iteration.
//!
//! While the runtime holds an exclusive grab on the touchscreen, external
//! `sendevent` is unreliable. Instead we poll a tiny command file:
//!
//!   /mnt/us/pocketjs-dev/run/cmd
//!
//! Lines (processed once then deleted):
//!   tap X Y          — panel/render px (0..render_w-1, 0..render_h-1)
//!   tap-logical X Y  — logical UI px (0..308, 0..411)
//!   shot             — dump current gray frame to run/shot.pgm
//!
//! Tap is synthesized as a few frames of contact then release, fed into the
//! same packed-touch path the real digitizer uses.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::geometry::Geometry;

const TOUCH_ID_MASK: u32 = 0xff;
const DOWN_FRAMES: u32 = 4;
const UP_FRAMES: u32 = 2;

#[derive(Debug, Default)]
enum Phase {
    #[default]
    Idle,
    Down {
        packed: u32,
        left: u32,
    },
    Up {
        left: u32,
    },
}

pub struct Injector {
    cmd_path: PathBuf,
    shot_path: PathBuf,
    phase: Phase,
    /// Request a framebuffer dump after the next present.
    pub want_shot: bool,
    last_log: Option<Instant>,
}

impl Injector {
    pub fn new() -> Self {
        let root = std::env::var_os("POCKETJS_DEV_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/mnt/us/pocketjs-dev"));
        let run = root.join("run");
        let _ = fs::create_dir_all(&run);
        Self {
            cmd_path: run.join("cmd"),
            shot_path: run.join("shot.pgm"),
            phase: Phase::Idle,
            want_shot: false,
            last_log: None,
        }
    }

    pub fn shot_path(&self) -> &Path {
        &self.shot_path
    }

    /// Call once per logic tick. Returns synthetic touches to use *instead of*
    /// (or merged over) real digitizer samples when active.
    pub fn tick(&mut self, geometry: &Geometry) -> Option<Vec<u32>> {
        if matches!(self.phase, Phase::Idle) {
            self.poll_cmd_file(geometry);
        }
        match self.phase {
            Phase::Idle => None,
            Phase::Down { packed, left } => {
                let left = left.saturating_sub(1);
                if left == 0 {
                    self.phase = Phase::Up { left: UP_FRAMES };
                } else {
                    self.phase = Phase::Down { packed, left };
                }
                Some(vec![packed])
            }
            Phase::Up { left } => {
                let left = left.saturating_sub(1);
                if left == 0 {
                    self.phase = Phase::Idle;
                } else {
                    self.phase = Phase::Up { left };
                }
                Some(Vec::new()) // finger up
            }
        }
    }

    fn poll_cmd_file(&mut self, geometry: &Geometry) {
        let Ok(text) = fs::read_to_string(&self.cmd_path) else {
            return;
        };
        let _ = fs::remove_file(&self.cmd_path);
        for raw in text.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let parts: Vec<&str> = line.split_whitespace().collect();
            match parts.as_slice() {
                ["shot"] | ["screenshot"] => {
                    self.want_shot = true;
                    log::info!("inject: shot requested → {}", self.shot_path.display());
                }
                ["tap", xs, ys] => {
                    if let (Ok(x), Ok(y)) = (xs.parse::<u32>(), ys.parse::<u32>()) {
                        self.start_tap_render(x, y, geometry);
                    }
                }
                ["tap-logical", xs, ys] | ["tapl", xs, ys] => {
                    if let (Ok(lx), Ok(ly)) = (xs.parse::<u32>(), ys.parse::<u32>()) {
                        let x = lx.saturating_mul(geometry.density as u32);
                        let y = ly.saturating_mul(geometry.density as u32);
                        self.start_tap_render(x, y, geometry);
                    }
                }
                other => {
                    log::warn!("inject: unknown command {other:?}");
                }
            }
        }
    }

    fn start_tap_render(&mut self, rx: u32, ry: u32, geometry: &Geometry) {
        // Convert render px → logical for the packed touch ABI (9 bits/axis).
        let dens = geometry.density.max(1) as u32;
        let lx = (rx / dens).min(geometry.logical_w.saturating_sub(1) as u32);
        let ly = (ry / dens).min(geometry.logical_h.saturating_sub(1) as u32);
        let packed = pack_touch(1, lx, ly);
        log::info!("inject: tap logical=({lx},{ly}) render=({rx},{ry}) pack={packed:#x}");
        self.phase = Phase::Down {
            packed,
            left: DOWN_FRAMES,
        };
        self.last_log = Some(Instant::now());
    }
}

/// Same packing as framework/src/touch.ts / Guest::frame_with_touches.
fn pack_touch(id: u32, x: u32, y: u32) -> u32 {
    ((id & TOUCH_ID_MASK) << 18) | ((y & 0x1ff) << 9) | (x & 0x1ff)
}

/// Write a binary PGM (P5) gray image from a tightly packed Gray8 buffer.
pub fn write_pgm(path: &Path, w: usize, h: usize, pixels: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    if pixels.len() < w * h {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "pixel buffer too small",
        ));
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut f = fs::File::create(path)?;
    write!(f, "P5\n{w} {h}\n255\n")?;
    f.write_all(&pixels[..w * h])?;
    Ok(())
}

#[allow(dead_code)]
pub fn cooldown_ok(last: Option<Instant>, min: Duration) -> bool {
    last.map(|t| t.elapsed() >= min).unwrap_or(true)
}
