//! Runtime glyph rasterization — **currently disabled on Kindle**.
//!
//! Loading full `NotoSansSC-Regular.otf` (~8MB) via fontdue after login
//! consistently OOMs the device (launcher status 137) once the shelf path
//! calls `ensureChars`. A subset font (few hundred KB) is required before
//! re-enabling. Static UI Chinese still comes from the Inter+Noto *bake*
//! of source literals; dynamic titles may show tofu until then.

use std::sync::Mutex;

use anyhow::Result;
use pocketjs_core::Ui;

pub struct RuntimeFonts {
    warned: bool,
}

impl RuntimeFonts {
    pub fn new() -> Self {
        Self { warned: false }
    }

    pub fn ensure_chars(&mut self, _ui: &mut Ui, text: &str) -> usize {
        if text.is_empty() {
            return 0;
        }
        if !self.warned {
            self.warned = true;
            log::warn!(
                "runtime_font: ensureChars disabled (full Noto OOM on Kindle); \
                 dynamic CJK titles may be tofu until a subset font is shipped"
            );
        }
        0
    }
}

pub fn global_runtime_fonts() -> &'static Mutex<RuntimeFonts> {
    static CELL: std::sync::OnceLock<Mutex<RuntimeFonts>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| Mutex::new(RuntimeFonts::new()))
}

pub fn ensure_chars_on_ui(ui: &mut Ui, text: &str) -> Result<u32> {
    let mut guard = global_runtime_fonts()
        .lock()
        .map_err(|_| anyhow::anyhow!("runtime_font lock"))?;
    Ok(guard.ensure_chars(ui, text) as u32)
}
