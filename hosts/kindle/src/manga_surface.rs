//! `globalThis.manga` surface for the Suwayomi reader host path.
//!
//! - `exit()` — product exit
//! - `loadPage(url, cookie?)` / `jobStatus` / `clearPage` / `hasPage` — page underlay
//! - `httpStart(method, url, headersJson, body)` / `httpStatus` / `httpTake` — GraphQL & login
//! - `readFile(path)` / `writeFile(path, text)` — small config under pocketjs-dev root
//!
//! All network work is off the 60Hz thread.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use anyhow::{Context, Result, bail};
use pocket_mod::Guest;
use pocket_mod::qjs::function::Opt;
use pocket_mod::qjs::Function;

use crate::remote_image::{self, GrayPage};

#[derive(Debug, Clone)]
enum JobState {
    Pending,
    Ready,
    Error(String),
}

#[derive(Debug, Clone)]
struct HttpResult {
    status: u16,
    body: String,
    /// Combined Cookie header value assembled from Set-Cookie (name=value pairs).
    set_cookie: String,
}

struct Shared {
    terminate: Arc<AtomicBool>,
    page: Mutex<Option<GrayPage>>,
    /// Unstamped page (no progress digits); used to re-burn overlay text.
    page_clean: Mutex<Option<GrayPage>>,
    page_dirty: AtomicBool,
    /// "12/32" burned as black pixels into the underlay corner (no UI chrome).
    progress_text: Mutex<String>,
    /// URL → decoded page; capped to keep RAM in check (prefetch ±1).
    page_cache: Mutex<HashMap<String, GrayPage>>,
    /// Serialize WebP decode — parallel decodes OOM the Kindle (status 137).
    decode_lock: Mutex<()>,
    next_job: AtomicU32,
    jobs: Mutex<HashMap<u32, JobState>>,
    http_results: Mutex<HashMap<u32, HttpResult>>,
    /// Text waiting for runtime font injection (drained on host tick).
    ensure_chars: Mutex<String>,
    panel_w: usize,
    panel_h: usize,
    /// Sandbox root for readFile/writeFile (…/pocketjs-dev).
    data_root: PathBuf,
}

/// current + next (+ optional prev). Each GrayPage ≈ 2MB.
const PAGE_CACHE_MAX: usize = 3;

/// Clone-cheap handle mounted into the guest and held by the host loop.
#[derive(Clone)]
pub struct MangaSurface {
    inner: Arc<Shared>,
}

impl MangaSurface {
    pub fn new(terminate: Arc<AtomicBool>, panel_w: usize, panel_h: usize) -> Self {
        let data_root = std::env::var_os("POCKETJS_DEV_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/mnt/us/pocketjs-dev"));
        Self {
            inner: Arc::new(Shared {
                terminate,
                page: Mutex::new(None),
                page_clean: Mutex::new(None),
                page_dirty: AtomicBool::new(false),
                progress_text: Mutex::new(String::new()),
                page_cache: Mutex::new(HashMap::new()),
                decode_lock: Mutex::new(()),
                next_job: AtomicU32::new(1),
                jobs: Mutex::new(HashMap::new()),
                http_results: Mutex::new(HashMap::new()),
                ensure_chars: Mutex::new(String::new()),
                panel_w,
                panel_h,
                data_root,
            }),
        }
    }

    pub fn mount(&self, guest: &Guest) -> Result<()> {
        let surface = self.clone();
        guest.mount("manga", move |_ctx, ns| {
            let s_exit = surface.clone();
            ns.set(
                "exit",
                Function::new(ns.ctx().clone(), move || {
                    log::info!("manga.exit(): product exit requested");
                    s_exit.inner.terminate.store(true, Ordering::Relaxed);
                })?,
            )?;

            let s_load = surface.clone();
            ns.set(
                "loadPage",
                Function::new(
                    ns.ctx().clone(),
                    move |url: String, cookie: Opt<String>| -> i32 {
                        let cookie = cookie.0.filter(|c| !c.is_empty());
                        s_load.start_load(url, cookie, true)
                    },
                )?,
            )?;

            // Prefetch into cache without changing the visible underlay.
            let s_pf = surface.clone();
            ns.set(
                "prefetchPage",
                Function::new(
                    ns.ctx().clone(),
                    move |url: String, cookie: Opt<String>| -> i32 {
                        let cookie = cookie.0.filter(|c| !c.is_empty());
                        s_pf.start_load(url, cookie, false)
                    },
                )?,
            )?;

            let s_status = surface.clone();
            ns.set(
                "jobStatus",
                Function::new(ns.ctx().clone(), move |id: i32| -> String {
                    s_status.job_status(id as u32)
                })?,
            )?;

            let s_clear = surface.clone();
            ns.set(
                "clearPage",
                Function::new(ns.ctx().clone(), move || {
                    s_clear.clear_page();
                })?,
            )?;

            // Burn "12/32" as black digits into the page corner (floats on art).
            let s_prog = surface.clone();
            ns.set(
                "setProgress",
                Function::new(ns.ctx().clone(), move |text: String| {
                    s_prog.set_progress(text);
                })?,
            )?;

            let s_has = surface.clone();
            ns.set(
                "hasPage",
                Function::new(ns.ctx().clone(), move || -> i32 {
                    if s_has
                        .inner
                        .page
                        .lock()
                        .map(|g| g.is_some())
                        .unwrap_or(false)
                    {
                        1
                    } else {
                        0
                    }
                })?,
            )?;

            // HTTP: async request for GraphQL / form login.
            let s_http = surface.clone();
            ns.set(
                "httpStart",
                Function::new(
                    ns.ctx().clone(),
                    move |method: String, url: String, headers_json: String, body: String| -> i32 {
                        s_http.start_http(method, url, headers_json, body)
                    },
                )?,
            )?;

            let s_hs = surface.clone();
            ns.set(
                "httpStatus",
                Function::new(ns.ctx().clone(), move |id: i32| -> String {
                    s_hs.job_status(id as u32)
                })?,
            )?;

            let s_ht = surface.clone();
            ns.set(
                "httpTake",
                Function::new(ns.ctx().clone(), move |id: i32| -> String {
                    s_ht.take_http(id as u32)
                })?,
            )?;

            let s_rf = surface.clone();
            ns.set(
                "readFile",
                Function::new(ns.ctx().clone(), move |rel: String| -> String {
                    s_rf.read_file(&rel).unwrap_or_default()
                })?,
            )?;

            let s_wf = surface.clone();
            ns.set(
                "writeFile",
                Function::new(ns.ctx().clone(), move |rel: String, text: String| -> i32 {
                    match s_wf.write_file(&rel, &text) {
                        Ok(()) => 1,
                        Err(e) => {
                            log::warn!("manga.writeFile({rel}): {e:#}");
                            0
                        }
                    }
                })?,
            )?;

            // Queue characters for host-side fontdue injection into font atlases.
            let s_ec = surface.clone();
            ns.set(
                "ensureChars",
                Function::new(ns.ctx().clone(), move |text: String| {
                    if text.is_empty() {
                        return;
                    }
                    if let Ok(mut buf) = s_ec.inner.ensure_chars.lock() {
                        buf.push_str(&text);
                    }
                })?,
            )?;

            ns.set("available", true)?;
            Ok(())
        })
    }

    /// Drain queued characters for runtime font injection (one host tick).
    pub fn take_ensure_chars(&self) -> Option<String> {
        let mut buf = self.inner.ensure_chars.lock().ok()?;
        if buf.is_empty() {
            return None;
        }
        Some(std::mem::take(&mut *buf))
    }

    fn start_load(&self, url: String, cookie: Option<String>, show: bool) -> i32 {
        let id = self.inner.next_job.fetch_add(1, Ordering::Relaxed);

        // Cache hit: optional instant display.
        if let Ok(cache) = self.inner.page_cache.lock() {
            if let Some(page) = cache.get(&url) {
                if show {
                    self.install_shown_page(page.clone());
                }
                if let Ok(mut jobs) = self.inner.jobs.lock() {
                    jobs.insert(id, JobState::Ready);
                }
                log::info!("manga.page#{id}: cache hit show={show} {url}");
                return id as i32;
            }
        }

        {
            let mut jobs = self.inner.jobs.lock().expect("jobs lock");
            jobs.insert(id, JobState::Pending);
        }
        let shared = self.inner.clone();
        let panel_w = self.inner.panel_w;
        let panel_h = self.inner.panel_h;
        let _ = thread::Builder::new()
            .name(format!("manga-page-{id}"))
            .spawn(move || {
                // One decode at a time — parallel WebP+Gray8 OOMs PW5.
                let _decode_gate = shared.decode_lock.lock();
                // Re-check cache after waiting (another job may have filled it).
                if let Ok(cache) = shared.page_cache.lock() {
                    if let Some(page) = cache.get(&url) {
                        let clone = page.clone();
                        drop(cache);
                        if show {
                            // install via temporary surface handle
                            let tmp = MangaSurface {
                                inner: shared.clone(),
                            };
                            tmp.install_shown_page(clone);
                        }
                        if let Ok(mut jobs) = shared.jobs.lock() {
                            jobs.insert(id, JobState::Ready);
                        }
                        log::info!("manga.page#{id}: cache hit after wait show={show} {url}");
                        return;
                    }
                }
                // Cover-fill full panel; chrome is a transient overlay.
                let result = remote_image::load_page_with_headers(
                    &url,
                    panel_w,
                    panel_h,
                    cookie.as_deref(),
                    0,
                    0,
                );
                match result {
                    Ok(page) => {
                        log::info!(
                            "manga.page#{id}: ready show={show} {}x{} {url}",
                            page.width,
                            page.height
                        );
                        if let Ok(mut cache) = shared.page_cache.lock() {
                            cache.insert(url.clone(), page.clone());
                            while cache.len() > PAGE_CACHE_MAX {
                                // Drop an arbitrary old entry (not current url).
                                let victim = cache
                                    .keys()
                                    .find(|k| *k != &url)
                                    .cloned();
                                if let Some(k) = victim {
                                    cache.remove(&k);
                                } else {
                                    break;
                                }
                            }
                        }
                        if show {
                            let tmp = MangaSurface {
                                inner: shared.clone(),
                            };
                            tmp.install_shown_page(page);
                        }
                        if let Ok(mut jobs) = shared.jobs.lock() {
                            jobs.insert(id, JobState::Ready);
                        }
                    }
                    Err(err) => {
                        let msg = format!("{err:#}");
                        log::error!("manga.page#{id}: {msg}");
                        if let Ok(mut jobs) = shared.jobs.lock() {
                            jobs.insert(id, JobState::Error(msg));
                        }
                    }
                }
            });
        id as i32
    }

    /// Install a clean decoded page as the visible underlay, burning progress text.
    fn install_shown_page(&self, clean: GrayPage) {
        // Keep clean (no digits); damage compositor burns progress each frame.
        if let Ok(mut slot) = self.inner.page_clean.lock() {
            *slot = Some(clean.clone());
        }
        if let Ok(mut slot) = self.inner.page.lock() {
            *slot = Some(clean);
        }
        self.inner.page_dirty.store(true, Ordering::SeqCst);
    }

    fn set_progress(&self, text: String) {
        if let Ok(mut slot) = self.inner.progress_text.lock() {
            if *slot == text {
                return;
            }
            *slot = text;
        }
        // Do NOT flip page_dirty here — that re-seeds full underlay every call
        // and combined with full-panel candidates starved the present loop.
        // Digits are burned each frame in damage.composite from progress_text.
    }

    fn clear_page(&self) {
        if let Ok(mut slot) = self.inner.page.lock() {
            *slot = None;
        }
        if let Ok(mut slot) = self.inner.page_clean.lock() {
            *slot = None;
        }
        self.inner.page_dirty.store(true, Ordering::SeqCst);
    }

    fn start_http(&self, method: String, url: String, headers_json: String, body: String) -> i32 {
        let id = self.inner.next_job.fetch_add(1, Ordering::Relaxed);
        {
            let mut jobs = self.inner.jobs.lock().expect("jobs lock");
            jobs.insert(id, JobState::Pending);
        }
        let shared = self.inner.clone();
        let _ = thread::Builder::new()
            .name(format!("manga-http-{id}"))
            .spawn(move || {
                let result = perform_http(&method, &url, &headers_json, &body);
                match result {
                    Ok(res) => {
                        log::info!(
                            "manga.http#{id}: {} {} -> {} ({} bytes)",
                            method,
                            url,
                            res.status,
                            res.body.len()
                        );
                        if let Ok(mut map) = shared.http_results.lock() {
                            map.insert(id, res);
                        }
                        if let Ok(mut jobs) = shared.jobs.lock() {
                            jobs.insert(id, JobState::Ready);
                        }
                    }
                    Err(err) => {
                        let msg = format!("{err:#}");
                        log::error!("manga.http#{id}: {msg}");
                        if let Ok(mut jobs) = shared.jobs.lock() {
                            jobs.insert(id, JobState::Error(msg));
                        }
                    }
                }
            });
        id as i32
    }

    fn job_status(&self, id: u32) -> String {
        let jobs = match self.inner.jobs.lock() {
            Ok(g) => g,
            Err(_) => return "error:lock".into(),
        };
        match jobs.get(&id) {
            Some(JobState::Pending) => "pending".into(),
            Some(JobState::Ready) => "ready".into(),
            Some(JobState::Error(e)) => format!("error:{e}"),
            None => "error:unknown-job".into(),
        }
    }

    fn take_http(&self, id: u32) -> String {
        let res = match self.inner.http_results.lock() {
            Ok(mut map) => map.remove(&id),
            Err(_) => None,
        };
        // Also drop job state.
        if let Ok(mut jobs) = self.inner.jobs.lock() {
            jobs.remove(&id);
        }
        match res {
            Some(r) => {
                // Manual JSON to avoid pulling serde_json into the host.
                let body_esc = json_escape(&r.body);
                let cookie_esc = json_escape(&r.set_cookie);
                format!(
                    "{{\"status\":{},\"body\":\"{}\",\"setCookie\":\"{}\"}}",
                    r.status, body_esc, cookie_esc
                )
            }
            None => String::new(),
        }
    }

    /// If the underlay changed, return the new page (`Some(None)` = cleared).
    pub fn take_page_dirty(&self) -> Option<Option<GrayPage>> {
        if !self.inner.page_dirty.swap(false, Ordering::SeqCst) {
            return None;
        }
        let page = self.inner.page.lock().ok()?.clone();
        Some(page)
    }

    /// Current "12/32" overlay text for the damage compositor.
    pub fn progress_text(&self) -> String {
        self.inner
            .progress_text
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default()
    }

    fn resolve_data_path(&self, rel: &str) -> Result<PathBuf> {
        let rel = rel.trim_start_matches('/');
        if rel.is_empty() || rel.contains('\0') {
            bail!("empty path");
        }
        let mut out = self.inner.data_root.clone();
        for comp in Path::new(rel).components() {
            match comp {
                Component::Normal(s) => out.push(s),
                Component::CurDir => {}
                _ => bail!("path escapes sandbox: {rel}"),
            }
        }
        // Ensure still under root after normalize.
        let root = self
            .inner
            .data_root
            .canonicalize()
            .unwrap_or_else(|_| self.inner.data_root.clone());
        // parent may not exist yet for write — check prefix on logical path.
        let logical = out.to_string_lossy();
        let root_s = root.to_string_lossy();
        if !logical.starts_with(root_s.as_ref())
            && !out.starts_with(&self.inner.data_root)
        {
            bail!("path escapes sandbox: {rel}");
        }
        Ok(out)
    }

    fn read_file(&self, rel: &str) -> Result<String> {
        let path = self.resolve_data_path(rel)?;
        let text = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        // Cap config size.
        if text.len() > 256 * 1024 {
            bail!("file too large");
        }
        Ok(text)
    }

    fn write_file(&self, rel: &str, text: &str) -> Result<()> {
        if text.len() > 256 * 1024 {
            bail!("payload too large");
        }
        let path = self.resolve_data_path(rel)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        std::fs::write(&path, text).with_context(|| format!("writing {}", path.display()))?;
        Ok(())
    }
}

fn perform_http(
    method: &str,
    url: &str,
    headers_json: &str,
    body: &str,
) -> Result<HttpResult> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        bail!("only http(s) URLs allowed");
    }

    // redirects(0): Suwayomi login often 302-sets session cookies on the
    // intermediate response. Auto-follow would drop those Set-Cookie headers.
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(std::time::Duration::from_secs(30))
        .build();

    let headers = parse_headers_json(headers_json);
    let mut cookie_jar: HashMap<String, String> = HashMap::new();
    for (k, v) in &headers {
        if k.eq_ignore_ascii_case("cookie") {
            absorb_cookie_pairs(&mut cookie_jar, v);
        }
    }

    let mut method = method.to_uppercase();
    let mut url = url.to_string();
    let mut body = body.to_string();
    let mut final_status: u16 = 0;
    let mut final_body = String::new();

    for hop in 0..8u32 {
        let mut req = match method.as_str() {
            "GET" => agent.get(&url),
            "POST" => agent.post(&url),
            "PUT" => agent.put(&url),
            other => bail!("unsupported method {other}"),
        };
        req = req.set("User-Agent", "PocketJS-Kindle-Manga/0.1");
        for (k, v) in &headers {
            if k.eq_ignore_ascii_case("cookie") {
                continue;
            }
            req = req.set(k, v);
        }
        let jar_hdr = jar_header(&cookie_jar);
        if !jar_hdr.is_empty() {
            req = req.set("Cookie", &jar_hdr);
        }

        let result = if method == "GET" || body.is_empty() {
            req.call()
        } else {
            req.send_string(&body)
        };

        match result {
            Ok(resp) => {
                // 2xx (with redirects disabled, success is terminal).
                absorb_set_cookie_headers(&mut cookie_jar, &resp);
                final_status = resp.status();
                resp.into_reader()
                    .take(8 * 1024 * 1024)
                    .read_to_string(&mut final_body)
                    .context("reading response body")?;
                break;
            }
            Err(ureq::Error::Status(code, resp)) => {
                absorb_set_cookie_headers(&mut cookie_jar, &resp);
                if (300..400).contains(&code) {
                    let loc = resp
                        .header("Location")
                        .or_else(|| resp.header("location"))
                        .map(|s| s.to_string());
                    // Drain body so connection can reuse.
                    let mut sink = Vec::new();
                    let _ = resp.into_reader().take(1024 * 1024).read_to_end(&mut sink);
                    let Some(loc) = loc else {
                        bail!("redirect {code} without Location on {url}");
                    };
                    url = resolve_redirect(&url, &loc);
                    // RFC: 303 always GET; 302/301 for POST commonly become GET in browsers.
                    if method == "POST" || code == 303 {
                        method = "GET".into();
                        body.clear();
                    }
                    log::info!(
                        "manga.http: hop {hop} redirect {code} -> {url} (cookies={})",
                        cookie_jar.len()
                    );
                    continue;
                }
                final_status = code as u16;
                resp.into_reader()
                    .take(8 * 1024 * 1024)
                    .read_to_string(&mut final_body)
                    .context("reading error body")?;
                break;
            }
            Err(e) => {
                return Err(e).with_context(|| format!("{method} {url}"));
            }
        }
    }

    if final_status == 0 {
        bail!("http gave up after redirects on {url}");
    }

    log::info!(
        "manga.http done: {final_status}, body={}B, cookie_names={}",
        final_body.len(),
        cookie_jar.keys().cloned().collect::<Vec<_>>().join(",")
    );

    Ok(HttpResult {
        status: final_status,
        body: final_body,
        // Return the full jar so JS can persist the session.
        set_cookie: jar_header(&cookie_jar),
    })
}

fn absorb_set_cookie_headers(jar: &mut HashMap<String, String>, resp: &ureq::Response) {
    for val in resp.all("Set-Cookie").into_iter().chain(resp.all("set-cookie")) {
        let nv = val.split(';').next().unwrap_or(val).trim();
        if let Some((n, v)) = nv.split_once('=') {
            let n = n.trim();
            if !n.is_empty() {
                jar.insert(n.to_string(), v.trim().to_string());
            }
        }
    }
}

fn absorb_cookie_pairs(jar: &mut HashMap<String, String>, header: &str) {
    for part in header.split(';') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((n, v)) = part.split_once('=') {
            let n = n.trim();
            if n.is_empty()
                || n.eq_ignore_ascii_case("Path")
                || n.eq_ignore_ascii_case("Domain")
                || n.eq_ignore_ascii_case("Expires")
                || n.eq_ignore_ascii_case("Max-Age")
                || n.eq_ignore_ascii_case("Secure")
                || n.eq_ignore_ascii_case("HttpOnly")
                || n.eq_ignore_ascii_case("SameSite")
            {
                continue;
            }
            jar.insert(n.to_string(), v.trim().to_string());
        }
    }
}

fn jar_header(jar: &HashMap<String, String>) -> String {
    jar.iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("; ")
}

fn resolve_redirect(current: &str, location: &str) -> String {
    if location.starts_with("http://") || location.starts_with("https://") {
        return location.to_string();
    }
    if location.starts_with('/') {
        // scheme://host[:port]/path → keep origin
        if let Some(scheme_end) = current.find("://") {
            let after = &current[scheme_end + 3..];
            let origin_end = after
                .find('/')
                .map(|i| scheme_end + 3 + i)
                .unwrap_or(current.len());
            return format!("{}{}", &current[..origin_end], location);
        }
    }
    // Relative redirect: replace last path segment.
    if let Some(i) = current.rfind('/') {
        return format!("{}{}", &current[..=i], location);
    }
    location.to_string()
}

fn parse_headers_json(s: &str) -> Vec<(String, String)> {
    // Expect a flat {"Key":"Value",...} object. Tiny hand parser — no serde.
    let mut out = Vec::new();
    let s = s.trim();
    if !s.starts_with('{') {
        return out;
    }
    let inner = s.trim_start_matches('{').trim_end_matches('}');
    for part in split_json_pairs(inner) {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((k, v)) = part.split_once(':') {
            let k = unquote(k.trim());
            let v = unquote(v.trim());
            if !k.is_empty() {
                out.push((k, v));
            }
        }
    }
    out
}

fn split_json_pairs(s: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    let mut in_str = false;
    let mut escape = false;
    for c in s.chars() {
        if escape {
            cur.push(c);
            escape = false;
            continue;
        }
        match c {
            '\\' if in_str => {
                cur.push(c);
                escape = true;
            }
            '"' => {
                cur.push(c);
                in_str = !in_str;
            }
            ',' if !in_str => {
                parts.push(std::mem::take(&mut cur));
            }
            _ => cur.push(c),
        }
    }
    if !cur.trim().is_empty() {
        parts.push(cur);
    }
    parts
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    if s.len() >= 2 && s.starts_with('"') && s.ends_with('"') {
        let inner = &s[1..s.len() - 1];
        json_unescape(inner)
    } else {
        s.to_string()
    }
}

fn json_unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') => out.push('\n'),
                Some('r') => out.push('\r'),
                Some('t') => out.push('\t'),
                Some('"' ) => out.push('"'),
                Some('\\') => out.push('\\'),
                Some('u') => {
                    let mut hex = String::new();
                    for _ in 0..4 {
                        if let Some(h) = chars.next() {
                            hex.push(h);
                        }
                    }
                    if let Ok(v) = u32::from_str_radix(&hex, 16) {
                        if let Some(ch) = char::from_u32(v) {
                            out.push(ch);
                        }
                    }
                }
                Some(other) => out.push(other),
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// 5×7 digit glyphs (bit rows, MSB left). Chars: 0-9 and '/'.
fn glyph5x7(ch: char) -> Option<[u8; 7]> {
    Some(match ch {
        '0' => [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
        '1' => [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
        '2' => [0b01110, 0b10001, 0b00001, 0b00110, 0b01000, 0b10000, 0b11111],
        '3' => [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
        '4' => [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
        '5' => [0b11111, 0b10000, 0b10000, 0b11110, 0b00001, 0b00001, 0b11110],
        '6' => [0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
        '7' => [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
        '8' => [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
        '9' => [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110],
        '/' => [0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b10000, 0b10000],
        _ => return None,
    })
}

/// Burn black progress text into the bottom-left of a Gray8 page (scale 3x).
pub fn stamp_progress_black(pixels: &mut [u8], w: usize, h: usize, text: &str) {
    const SCALE: usize = 3;
    const MARGIN: usize = 4;
    let chars: Vec<[u8; 7]> = text.chars().filter_map(glyph5x7).collect();
    if chars.is_empty() || w < 16 || h < 16 {
        return;
    }
    let gw = 5 * SCALE + SCALE; // glyph width + gap
    let gh = 7 * SCALE;
    let total_w = chars.len() * gw;
    let x0 = MARGIN;
    let y0 = h.saturating_sub(MARGIN + gh);
    if x0 + total_w > w || y0 + gh > h {
        return;
    }
    for (ci, g) in chars.iter().enumerate() {
        let cx = x0 + ci * gw;
        for row in 0..7 {
            let bits = g[row];
            for col in 0..5 {
                if bits & (0b10000 >> col) == 0 {
                    continue;
                }
                for dy in 0..SCALE {
                    for dx in 0..SCALE {
                        let x = cx + col * SCALE + dx;
                        let y = y0 + row * SCALE + dy;
                        if x < w && y < h {
                            // Near-black so it reads on light and dark art.
                            pixels[y * w + x] = 0x10;
                        }
                    }
                }
            }
        }
    }
}
