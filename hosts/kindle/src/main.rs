//! PocketJS UI runtime for jailbroken Kindle devices.

mod damage;
mod framebuffer;
mod geometry;
mod input;
mod refresh;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use damage::{DamageTracker, Rect};
use framebuffer::Framebuffer;
use geometry::{Geometry, Rotation, compatible_reported_rotation};
use input::Input;
use pocket_mod::Guest;
use pocket_ui_surface::UiSurface;
use pocketjs_core::spec;
use refresh::{FbInk, RefreshPolicy, Waveform};
use signal_hook::consts::signal::{SIGHUP, SIGINT, SIGTERM};

const HOST_ID: &str = "kindle-pw5";
const HOST_ABI: u32 = 5;
const LOGICAL_W: usize = 309;
const LOGICAL_H: usize = 412;
const DENSITY: usize = 4;
const LOGIC_TICK: Duration = Duration::from_nanos(16_666_667);
const MAX_CATCHUP_TICKS: usize = 4;

#[derive(Debug)]
struct Args {
    js: PathBuf,
    pak: PathBuf,
    framebuffer: PathBuf,
    fbink: PathBuf,
    present_hz: u32,
    motion_waveform: Waveform,
    ghost_budget: u32,
    rotation: Option<Rotation>,
    probe: bool,
    allow_active_gui: bool,
}

impl Args {
    fn parse() -> Result<Self> {
        let mut args = Self {
            // Prefer the content-addressed deploy layout so bare launches from KUAL
            // (no --js/--pak) still find the guest after a normal deploy.
            js: env_path("POCKET_JS")
                .unwrap_or_else(|| "/mnt/us/pocketjs-dev/current/app.js".into()),
            pak: env_path("POCKET_PAK")
                .unwrap_or_else(|| "/mnt/us/pocketjs-dev/current/app.pak".into()),
            framebuffer: env_path("POCKETJS_FRAMEBUFFER").unwrap_or_else(|| "/dev/fb0".into()),
            fbink: env_path("POCKETJS_FBINK")
                .unwrap_or_else(|| "/mnt/us/pocketjs-dev/bin/fbink".into()),
            present_hz: env_parse("POCKETJS_PRESENT_HZ")?.unwrap_or(30),
            motion_waveform: Waveform::parse_motion(
                &std::env::var("POCKETJS_MOTION_WAVEFORM").unwrap_or_else(|_| "DU".into()),
            )?,
            ghost_budget: env_parse("POCKETJS_GHOST_BUDGET")?.unwrap_or(80),
            rotation: Rotation::parse(
                &std::env::var("POCKETJS_ROTATION").unwrap_or_else(|_| "auto".into()),
            )?,
            probe: false,
            allow_active_gui: false,
        };

        let words = std::env::args().skip(1).collect::<Vec<_>>();
        let mut index = 0;
        while index < words.len() {
            let word = &words[index];
            let value = |index: &mut usize| -> Result<&str> {
                *index += 1;
                words
                    .get(*index)
                    .map(String::as_str)
                    .ok_or_else(|| anyhow::anyhow!("{word} requires a value"))
            };
            match word.as_str() {
                "--js" => args.js = value(&mut index)?.into(),
                "--pak" => args.pak = value(&mut index)?.into(),
                "--framebuffer" => args.framebuffer = value(&mut index)?.into(),
                "--fbink" => args.fbink = value(&mut index)?.into(),
                "--present-hz" => {
                    args.present_hz = value(&mut index)?
                        .parse()
                        .context("--present-hz must be an integer")?
                }
                "--motion-waveform" => {
                    args.motion_waveform = Waveform::parse_motion(value(&mut index)?)?
                }
                "--ghost-budget" => {
                    args.ghost_budget = value(&mut index)?
                        .parse()
                        .context("--ghost-budget must be an integer")?
                }
                "--rotation" => args.rotation = Rotation::parse(value(&mut index)?)?,
                "--probe" => args.probe = true,
                "--allow-active-gui" => args.allow_active_gui = true,
                "-h" | "--help" => {
                    print_help();
                    std::process::exit(0);
                }
                _ => bail!("unknown argument {word:?}; use --help"),
            }
            index += 1;
        }
        Ok(args)
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from)
}

fn env_parse<T>(name: &str) -> Result<Option<T>>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    std::env::var(name)
        .ok()
        .map(|value| {
            value
                .parse()
                .map_err(|error| anyhow::anyhow!("{name}={value:?}: {error}"))
        })
        .transpose()
}

fn print_help() {
    println!(
        "\
PocketJS Kindle host

Usage:
  pocketjs-kindle [options]
  pocketjs-kindle --probe [options]

Defaults (overridable by flags or env):
  --js   /mnt/us/pocketjs-dev/current/app.js   (POCKET_JS)
  --pak  /mnt/us/pocketjs-dev/current/app.pak  (POCKET_PAK)
  --fbink /mnt/us/pocketjs-dev/bin/fbink       (POCKETJS_FBINK)

Options:
  --framebuffer PATH       Linux framebuffer (default /dev/fb0)
  --fbink PATH             external FBInk CLI
  --present-hz N           physical refresh cap, 1..60 (default 30)
  --motion-waveform DU|A2  fast shallow-refresh waveform (default DU)
  --ghost-budget N         fast updates before a full GC16 cleanup
  --rotation auto|0|90|180|270
  --allow-active-gui       explicit unsafe override of the GUI-pause guard

SIGHUP reloads JS/pak at the next 60Hz frame boundary. SIGINT/SIGTERM exit.
While running, hold the bottom-left corner (~40x40 logical px) for ~1.5s to
exit cleanly — the Kindle UI is paused so KUAL Stop Runtime is unreachable.

The matching environment variables are POCKET_JS, POCKET_PAK,
POCKETJS_FRAMEBUFFER, POCKETJS_FBINK, POCKETJS_PRESENT_HZ,
POCKETJS_MOTION_WAVEFORM, POCKETJS_GHOST_BUDGET, and POCKETJS_ROTATION."
    );
}

/// Logical-space corner used as an always-on exit affordance. Runtime pauses
/// the Kindle UI, so Stop Runtime in KUAL is not reachable without this.
const EXIT_CORNER_W: u32 = 40;
const EXIT_CORNER_H: u32 = 40;
const EXIT_HOLD: Duration = Duration::from_millis(1500);

fn touch_xy(packed: u32) -> (u32, u32) {
    let x = packed & 0x1ff;
    let y = (packed >> 9) & 0x1ff;
    (x, y)
}

fn in_exit_corner(packed: u32) -> bool {
    let (x, y) = touch_xy(packed);
    x < EXIT_CORNER_W && y + EXIT_CORNER_H >= LOGICAL_H as u32
}

/// True when a single contact is held inside the exit corner.
fn exit_hold_active(touches: &[u32]) -> bool {
    touches.len() == 1 && in_exit_corner(touches[0])
}

struct AppRuntime {
    guest: Guest,
    surface: UiSurface,
    damage: DamageTracker,
}

impl AppRuntime {
    fn load(args: &Args, geometry: &Geometry) -> Result<Self> {
        let pak = std::fs::read(&args.pak)
            .with_context(|| format!("reading pak {}", args.pak.display()))?;
        let js = std::fs::read_to_string(&args.js)
            .with_context(|| format!("reading bundle {}", args.js.display()))?;

        let surface = UiSurface::new_with_density(
            (geometry.logical_w as f32, geometry.logical_h as f32),
            geometry.density as u32,
        );
        surface.set_identity(HOST_ID, HOST_ABI);
        surface.feed_pak(&pak);
        let guest = Guest::new().context("creating PocketJS guest")?;
        surface.mount(&guest).context("mounting UI surface")?;
        guest.eval("app", &js).context("evaluating app bundle")?;
        if !guest.has_frame() {
            bail!(
                "{} installed no global frame(); was it built for {HOST_ID}?",
                args.js.display()
            );
        }
        Ok(Self {
            guest,
            surface,
            damage: DamageTracker::new(
                geometry.render_w,
                geometry.render_h,
                geometry.density as u32,
            ),
        })
    }

    fn tick(&mut self, touches: &[u32]) -> Result<Vec<Rect>> {
        self.guest
            .frame_with_touches(0, spec::ANALOG_CENTER, touches)
            .context("PocketJS guest frame")?;
        self.surface.tick();
        let damage = &mut self.damage;
        self.surface.with_ui(|ui| {
            let words = ui.draw().words.clone();
            damage.rasterize(ui, &words);
        });
        let dirty = self.damage.diff();
        Ok(dirty)
    }
}

fn main() -> Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();
    let args = Args::parse()?;

    let mut framebuffer = Framebuffer::open(&args.framebuffer)?;
    let info = framebuffer.info().clone();
    log::info!(
        "kindle framebuffer: {} {}x{} virtual {}x{} +{},{} stride={} rotate={} {:?}",
        info.id,
        info.width,
        info.height,
        info.virtual_width,
        info.virtual_height,
        info.x_offset,
        info.y_offset,
        info.line_length,
        info.rotate,
        info.format
    );
    let render_w = LOGICAL_W * DENSITY;
    let render_h = LOGICAL_H * DENSITY;
    let requested_rotation = match args.rotation {
        Some(rotation) => Some(rotation),
        None => {
            let compatible = compatible_reported_rotation(
                info.rotate,
                render_w,
                render_h,
                info.width,
                info.height,
            )?;
            if compatible.is_none() {
                log::warn!(
                    "framebuffer rotate={} is incompatible with visible {}x{}; \
                     treating it as controller-applied and deriving orientation \
                     from the exact render dimensions",
                    info.rotate,
                    info.width,
                    info.height
                );
            }
            compatible
        }
    };
    let geometry = Geometry::exact(
        LOGICAL_W,
        LOGICAL_H,
        DENSITY,
        info.width,
        info.height,
        requested_rotation,
    )?;
    log::info!(
        "kindle geometry: {}x{} @{}x -> {}x{} {:?}",
        LOGICAL_W,
        LOGICAL_H,
        DENSITY,
        info.width,
        info.height,
        geometry.rotation
    );

    let mut input = Input::discover()?;
    log::info!("kindle input: {} touch device(s)", input.device_count());
    if args.probe {
        println!(
            "PocketJS Kindle probe OK: fb={} {}x{} {:?}, rotation={:?}, touch_devices={}",
            info.id,
            info.width,
            info.height,
            info.format,
            geometry.rotation,
            input.device_count()
        );
        return Ok(());
    }

    let gui_paused = std::env::var("POCKETJS_GUI_PAUSED")
        .is_ok_and(|value| matches!(value.as_str(), "1" | "true" | "yes"));
    if !gui_paused && !args.allow_active_gui {
        bail!(
            "refusing to write /dev/fb0 while the Kindle GUI may be active; \
             launch through the PocketJS device wrapper (POCKETJS_GUI_PAUSED=1), \
             or pass --allow-active-gui only if you have stopped it yourself"
        );
    }

    // The Amazon UI may still have the touchscreen open while its renderer is
    // paused. Own the selected evdev node exclusively so one tap cannot be
    // delivered to both runtimes. Device::drop explicitly releases the grab.
    input
        .grab_selected()
        .context("claiming the Kindle touchscreen")?;

    let mut fbink = FbInk::new(&args.fbink)?;
    log::info!("kindle refresh helper: {}", fbink.path().display());
    let mut refresh = RefreshPolicy::new(
        info.width,
        info.height,
        args.present_hz,
        args.motion_waveform,
        args.ghost_budget,
    )?;
    let mut runtime = AppRuntime::load(&args, &geometry)?;

    let reload = Arc::new(AtomicBool::new(false));
    let terminate = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(SIGHUP, reload.clone()).context("registering SIGHUP")?;
    signal_hook::flag::register(SIGINT, terminate.clone()).context("registering SIGINT")?;
    signal_hook::flag::register(SIGTERM, terminate.clone()).context("registering SIGTERM")?;

    log::info!(
        "kindle runtime ready: logic=60Hz, present={}Hz, motion={:?}, pid={}",
        args.present_hz,
        args.motion_waveform,
        std::process::id()
    );
    if let Some(root) = std::env::var_os("POCKETJS_DBG_DIR") {
        log::info!(
            "kindle DevTools mailbox root: {}",
            PathBuf::from(root).display()
        );
    }

    let started = Instant::now();
    let mut next_tick = Instant::now();
    let mut pending = Vec::<Rect>::new();
    let mut first_frame = true;
    let mut force_refresh = false;
    let mut exit_hold_since: Option<Instant> = None;

    while !terminate.load(Ordering::Relaxed) {
        if reload.swap(false, Ordering::AcqRel) {
            // This point is between guest turns. Keep the old realm alive if
            // a deploy is incomplete or the new bundle throws during boot.
            match AppRuntime::load(&args, &geometry) {
                Ok(next) => {
                    runtime = next;
                    pending.clear();
                    first_frame = true;
                    force_refresh = true;
                    log::info!("kindle reload: new guest installed at frame boundary");
                }
                Err(error) => {
                    log::error!("kindle reload rejected; keeping previous guest: {error:#}");
                }
            }
        }

        let mut catchup = 0;
        while Instant::now() >= next_tick && catchup < MAX_CATCHUP_TICKS {
            let touches = input.poll_touches(&geometry)?;
            if exit_hold_active(&touches) {
                let since = exit_hold_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= EXIT_HOLD {
                    log::info!(
                        "kindle exit hold: bottom-left corner held {:?}; requesting clean exit",
                        EXIT_HOLD
                    );
                    terminate.store(true, Ordering::Relaxed);
                    break;
                }
            } else {
                exit_hold_since = None;
            }
            // Diff against the last frame actually copied to /dev/fb0, not
            // against the preceding 60Hz simulation frame. This bounds damage
            // while FBInk is busy and lets A -> B -> A disappear before a
            // slower physical present.
            pending = runtime.tick(&touches)?;
            next_tick += LOGIC_TICK;
            catchup += 1;
        }
        if catchup > 0 && first_frame {
            pending = vec![Rect {
                x: 0,
                y: 0,
                w: geometry.render_w,
                h: geometry.render_h,
            }];
            first_frame = false;
        }
        if catchup == MAX_CATCHUP_TICKS && Instant::now() >= next_tick {
            log::warn!("kindle runtime missed >{MAX_CATCHUP_TICKS} logic ticks; dropping catch-up");
            next_tick = Instant::now() + LOGIC_TICK;
        }

        if fbink.ready()? {
            let elapsed = started.elapsed();
            if !pending.is_empty() {
                let panel_damage = pending
                    .iter()
                    .copied()
                    .map(|rect| geometry.render_rect_to_panel(rect))
                    .collect::<Vec<_>>();
                if let Some(request) = refresh.on_damage(elapsed, &panel_damage, force_refresh) {
                    framebuffer.write_rects(
                        runtime.damage.current(),
                        geometry.render_w,
                        &pending,
                        &geometry,
                    )?;
                    runtime.damage.latch();
                    pending.clear();
                    force_refresh = false;
                    fbink.submit(request)?;
                }
            } else if let Some(request) = refresh.on_idle(elapsed) {
                fbink.submit(request)?;
            }
        }

        let now = Instant::now();
        if next_tick > now {
            std::thread::sleep(next_tick - now);
        }
    }

    fbink
        .finish()
        .context("finishing the final Kindle display refresh")?;
    log::info!("kindle runtime exiting cleanly");
    Ok(())
}
