# PocketJS Kindle host

This standalone Rust binary runs a PocketJS UI bundle on a jailbroken Kindle
Paperwhite 5 / Signature Edition (`kindle-pw5`, host ABI 5). The target contract
is 309×412 logical pixels at density 4. The host probes `/dev/fb0` at runtime
and accepts only the exact 1236×1648 raster (or its 1648×1236 rotated form);
it does not assume a stride, virtual offset, rotation, or pixel format. Some
MTK fbdev drivers report the controller's physical `rotate` value even though
`xres`/`yres` are already upright. Automatic rotation therefore uses that value
only when its orientation agrees with the probed visible raster.

## Build and test

The Kindle firmware uses ARMv7 hard-float. The musl build keeps the deployed
binary independent of the firmware's changing glibc:

```sh
rustup target add armv7-unknown-linux-musleabihf
cargo install cargo-zigbuild
cargo test --manifest-path hosts/kindle/Cargo.toml
CARGO_ZIGBUILD_PYTHON_PATH=/usr/bin/false \
CARGO_ZIGBUILD_ZIG_PATH="$HOME/.cargo/bin/zig" \
CLANG_PATH=/usr/bin/clang \
  cargo zigbuild \
  --manifest-path hosts/kindle/Cargo.toml \
  --release \
  --target armv7-unknown-linux-musleabihf
```

The ARM build enables `rquickjs`'s generated bindings because that crate does
not ship this exact musl triplet; a working libclang is therefore also required
(`brew install llvm`, and set `LIBCLANG_PATH` only if bindgen cannot find it).
The environment above forces cargo-zigbuild to use the pinned standalone Zig
installed by `kindle:setup` instead of an unrelated Python `ziglang` package,
and lets bindgen locate Clang without invoking Xcode discovery.

The deployable binary is:

```text
hosts/kindle/target/armv7-unknown-linux-musleabihf/release/pocketjs-kindle
```

`bun tools/kindle.ts build`, `deploy`, `probe`, and `dev` wrap these commands
and the SSH transport after `bun tools/kindle-bootstrap.ts` has provisioned
the attached Kindle.

## Runtime contract

The normal device launcher pauses one known Kindle GUI process (preferring
KPPMainApp and retaining `awesome` as a firmware fallback), exports
`POCKETJS_GUI_PAUSED=1`, starts the host with persistent stdout/stderr logging,
and restores the exact recorded process identity from a shell trap. The native
host independently takes `EVIOCGRAB` ownership of the discovered touchscreen
before declaring itself ready.

Before pausing the GUI, the launcher durably records the current
`com.lab126.powerd preventScreenSaver` value, sets it to `1`, and verifies the
read-back. Cleanup and guarded stop restore that exact value. PocketJS never
synthesizes a `powerButton` event: if powerd is already in `screenSaver` or
`suspended`, launch fails and asks the user to wake the Kindle physically.
Only the exact `active` state is accepted; unknown and transitional states fail
closed.

Do not start the binary directly while the Kindle GUI is active: two writers
racing on `/dev/fb0` can leave the display or framework in a bad state. The
host enforces this guard unless the dangerous `--allow-active-gui` override is
explicit.

```sh
pocketjs-kindle \
  --js /mnt/us/pocketjs-dev/current/app.js \
  --pak /mnt/us/pocketjs-dev/current/app.pak \
  --fbink /mnt/us/pocketjs-dev/bin/fbink
```

Those three paths are also the **defaults** when no flags/env are set, so a
bare `pocketjs-kindle` (or KUAL **Run Runtime**) works after a normal deploy.

The same paths can be set with `POCKET_JS`, `POCKET_PAK`, and
`POCKETJS_FBINK`. `SIGHUP` builds a new `Guest` and `UiSurface` at the next
60 Hz frame boundary; a bad or half-deployed bundle is rejected and the old
guest keeps running. `SIGINT` and `SIGTERM` exit cleanly.

While the runtime owns the screen it pauses the Kindle UI, so KUAL
**Stop Runtime** is unreachable. Hold the **bottom-left corner** of the panel
(~40×40 logical pixels) for about **1.5 seconds** to request a clean exit;
the launcher then resumes the UI.

The logical simulation always ticks at 60 Hz. Physical presentation is
independently capped by `--present-hz` (30 by default). Rendering is fused to
Gray8 before 16×16 tile comparison against the last frame actually written to
`/dev/fb0`; adjacent tile runs are merged, and only final-pixel changes reach
the framebuffer. A transient A→B→A between physical presents therefore causes
no write. Supported probed formats are:

- one-byte Gray8;
- little-endian RGB565;
- little-endian XRGB8888 or ARGB8888.

Every other layout fails with its reported bitfields instead of guessing.

## Shallow-refresh policy

The host calls an **external FBInk executable** only to submit refreshes:

1. first damage uses conservative, non-flashing `AUTO`;
2. continuous motion uses `DU` (or opt-in `A2`) at the physical present cap;
3. 200 ms of quiet triggers a flashing `GC16` cleanup of the accumulated motion region;
4. the configurable ghost budget triggers a full flashing `GC16` cleanup;
5. reload explicitly performs the same full cleanup.

`A2` is faster but discards grayscale quality. Start with the `DU` default and
enable `--motion-waveform A2` only for content designed for its black/white
trade-off. `--ghost-budget` defaults to 80 fast updates.

FBInk is GPLv3 software and is **not** a Rust dependency or linked library of
this MIT host. Bootstrap installs its existing CLI as a separate program; the
only boundary is process invocation (`fbink -s … -W …`) after the host writes
the framebuffer. Keep the FBInk binary, license, and corresponding source
offer from its distributor together when redistributing a device image.

## Probe, input, and calibration

Read-only host probing is allowed while the GUI is active:

```sh
pocketjs-kindle --probe
/mnt/us/pocketjs-dev/bin/fbink -e
```

The first command performs `FBIOGET_FSCREENINFO` and
`FBIOGET_VSCREENINFO`, validates geometry and format, and discovers capable
`/dev/input/event*` nodes. It does not issue a panel refresh.

Multitouch input uses the generic Linux evdev ABI: MT slots, tracking IDs,
position axes, and their probed min/max ranges. Physical coordinates are mapped
through the detected framebuffer rotation and then packed into PocketJS's
9-bit-per-axis touch wire. If a firmware exposes axes differently, calibrate
without patching the binary:

```sh
POCKETJS_TOUCH_SWAP_XY=1
POCKETJS_TOUCH_FLIP_X=1
POCKETJS_TOUCH_FLIP_Y=1
POCKETJS_ROTATION=auto  # or 0, 90, 180, 270
```

Only set the variables whose probe/touch test proves necessary.

## Logs and DevTools mailbox

The host sends timestamps, guest `console.*`, reload failures, framebuffer
metadata, and refresh decisions to stdout/stderr. The launcher redirects both
to `/mnt/us/pocketjs-dev/logs/runtime.log`.

`UiSurface` uses the standard PocketJS file mailbox when
`POCKETJS_DBG_DIR` points at a root containing:

```text
pocketjs-dbg/
  enable
  in.jsonl
  out.jsonl
```

The SSH development bridge tails and appends those files, so the existing
DevTools protocol does not need Kindle-specific JS or a network capability in
the guest. The mailbox is probed when a guest mounts; create `enable` before
launch or send `SIGHUP` after enabling it.

## Safety limits

- Use the dedicated key-only USB SSH service; do not bind it to Wi-Fi.
- Use the launcher so Kindle framework pause/resume is paired even on failure.
- Never copy framebuffer ioctl definitions from an i.MX Kindle to the PW5
  MediaTek stack. FBInk owns that model-specific boundary.
- A geometry or bitfield mismatch is a hard error. Add a newly measured device
  profile deliberately instead of widening the accepted write surface.
- Always do a high-quality cleanup after an A2/DU animation before returning
  control to the Kindle UI.
