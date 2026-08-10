#!/usr/bin/env bun

/**
 * Prepare a jailbroken modern Kindle for PocketJS development while it is
 * mounted as USB Mass Storage. Third-party binaries are downloaded into the
 * shared Pocket Stack cache, verified, and copied to the device; none belong
 * in this repository.
 *
 * Target profile: Kindle Paperwhite 5, firmware 5.19.2, armhf.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";

const REPOSITORY_ROOT = new URL("..", import.meta.url).pathname;
const MANAGED_MARKER = "Managed by PocketJS Kindle bootstrap.";
const AUTHORIZED_KEYS_BEGIN = "# BEGIN POCKETJS KINDLE BOOTSTRAP KEY";
const AUTHORIZED_KEYS_END = "# END POCKETJS KINDLE BOOTSTRAP KEY";
const MINIMUM_RECOMMENDED_FREE_BYTES = 220 * 1024 * 1024;

export const KINDLE_USB_NETWORK = {
  hostIp: "192.168.15.201",
  kindleIp: "192.168.15.244",
  netmask: "255.255.255.0",
  interface: "usb0",
} as const;

export const KINDLE_BOOTSTRAP_ASSETS = {
  peki: {
    name: "PEKI",
    version: "1.0.0",
    sourceRevision: "v1.0.0",
    url: "https://github.com/KindleModding/PEKI/releases/download/v1.0.0/PEKI.zip",
    sha256: "617571e81c96809f34dff0b710db8aebbda03dcfbfef4322ab51d20e09175034",
    archiveMember: "KUAL.sh",
    memberSha256: "1e86c0aac4e99d03e627ec8b410a9d9badf0bd6f701b89dc4adf5fb7c5cb33a0",
    cacheName: "PEKI-v1.0.0.zip",
  },
  mrpi: {
    name: "KHF MRPI",
    version: "1.7.N-r19303-khf",
    sourceRevision: "2f80493fffe97e7d01f415ba838cb8e42b42c189",
    url:
      "https://media.githubusercontent.com/media/KindleModding/kindlemodding.github.io/" +
      "2f80493fffe97e7d01f415ba838cb8e42b42c189/content/jailbreaking/post-jailbreak/" +
      "installing-kual-mrpi/kual-mrinstaller-khf.zip",
    sha256: "9974dfc2d1e7687b3fc74d68f6b5aeab2428f22d83ab82e6d600a0384c607d09",
    installerMember: "extensions/MRInstaller/bin/mrinstaller.sh",
    installerSha256: "005480387e88383a020782a419628995a77f692c727739de1ab8f63e656c1479",
    cacheName: "kual-mrinstaller-1.7.N-r19303-khf.zip",
  },
  koreader: {
    name: "KOReader KPM kindlehf",
    version: "2026.3.3",
    sourceRevision: "4076e8ae59c2e0cda34f80e1db8573a3580737cf",
    url:
      "https://media.githubusercontent.com/media/KindleModding/repo/" +
      "4076e8ae59c2e0cda34f80e1db8573a3580737cf/packages/koreader/artifacts/" +
      "koreader_2026.3.3_kindlehf.kpkg",
    sha256: "e4e79bd77ff8118302dc150352c7bb2c51e9f8974aa0f7c3458ebcbf946090ec",
    cacheName: "koreader-2026.3.3-kindlehf.kpkg",
    members: {
      fbink: {
        path: "koreader/fbink",
        sha256: "7045ed4243100eb1832463d501d6bc7addf44c5c52093a9f4a4f7512ac09d6dd",
      },
      dropbear: {
        path: "koreader/dropbear",
        sha256: "89a6ce03d354c59b1f9dcff37baf166b6728d05c6041e6ec8ec46c05f86394c6",
      },
    },
  },
} as const;

export interface KindleBootstrapOptions {
  readonly volume?: string;
  readonly cacheDirectory?: string;
  readonly sshKey?: string;
  readonly sshPort: number;
  readonly dryRun: boolean;
}

export interface PreparedMrpiEntry {
  readonly path: string;
  readonly directory: boolean;
  readonly data?: Uint8Array;
  readonly mode: number;
}

export interface PreparedKindlePayload {
  readonly kual: Uint8Array;
  readonly mrpiEntries: readonly PreparedMrpiEntry[];
  readonly fbink: Uint8Array;
  readonly dropbear: Uint8Array;
  readonly publicKey: string;
}

export interface StageSummary {
  readonly installed: readonly string[];
  readonly updated: readonly string[];
  readonly unchanged: readonly string[];
}

type FilePolicy = "identical-only" | "managed-text" | "managed-receipt" | "authorized-keys";
type PlannedAction = "installed" | "updated" | "unchanged";

interface FilePlan {
  readonly destination: string;
  readonly data: Uint8Array;
  readonly mode: number;
  readonly policy: FilePolicy;
  readonly label: string;
  readonly action: PlannedAction;
}

interface DirectoryPlan {
  readonly destination: string;
  readonly label: string;
  readonly action: "installed" | "unchanged";
  readonly appleDoublePolicy: "managed" | "shared";
}

interface ReceiptManagedFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

function usageText(): string {
  return [
    "usage: bun tools/kindle-bootstrap.ts [options]",
    "",
    "Prepare a jailbroken Kindle Paperwhite 5 (firmware 5.19.2, armhf) while",
    "its USB Mass Storage volume is mounted.",
    "",
    "options:",
    "  --volume <path>       Kindle volume root (auto-detected when unambiguous)",
    "  --ssh-key <path>      Dedicated private key (default: ~/.ssh/pocketjs-kindle-ed25519)",
    "  --port <port>         Dropbear SSH port (default: 2222)",
    "  --cache <path>        Download cache (default: <pocket-stack-cache>/kindle)",
    "  --dry-run             Validate the volume and print the plan without writing/downloading",
    "  -h, --help            Show this help",
  ].join("\n");
}

function optionValue(
  argv: readonly string[],
  index: number,
  flag: string,
): { value: string; next: number } {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return { value, next: index + 1 };
}

export function parseKindleBootstrapArgs(argv: readonly string[]): KindleBootstrapOptions {
  let volume: string | undefined;
  let cacheDirectory: string | undefined;
  let sshKey: string | undefined;
  let sshPort = 2222;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usageText());
      process.exit(0);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--volume") {
      const parsed = optionValue(argv, index, arg);
      volume = parsed.value;
      index = parsed.next;
    } else if (arg.startsWith("--volume=")) {
      volume = arg.slice("--volume=".length);
    } else if (arg === "--cache") {
      const parsed = optionValue(argv, index, arg);
      cacheDirectory = parsed.value;
      index = parsed.next;
    } else if (arg.startsWith("--cache=")) {
      cacheDirectory = arg.slice("--cache=".length);
    } else if (arg === "--ssh-key") {
      const parsed = optionValue(argv, index, arg);
      sshKey = parsed.value;
      index = parsed.next;
    } else if (arg.startsWith("--ssh-key=")) {
      sshKey = arg.slice("--ssh-key=".length);
    } else if (arg === "--port") {
      const parsed = optionValue(argv, index, arg);
      sshPort = parseSshPort(parsed.value);
      index = parsed.next;
    } else if (arg.startsWith("--port=")) {
      sshPort = parseSshPort(arg.slice("--port=".length));
    } else {
      throw new Error(`unknown argument: ${arg}\n\n${usageText()}`);
    }
  }

  if (volume !== undefined && volume.trim() === "") throw new Error("--volume cannot be empty");
  if (cacheDirectory !== undefined && cacheDirectory.trim() === "") {
    throw new Error("--cache cannot be empty");
  }
  if (sshKey !== undefined && sshKey.trim() === "") throw new Error("--ssh-key cannot be empty");
  if (sshKey?.endsWith(".pub")) throw new Error("--ssh-key expects the private key path, not .pub");
  return { volume, cacheDirectory, sshKey, sshPort, dryRun };
}

function parseSshPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("--port must be an integer between 1024 and 65535");
  }
  return port;
}

function defaultCacheRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.POCKET_STACK_CACHE_DIR?.trim()) {
    return join(resolve(env.POCKET_STACK_CACHE_DIR.trim()), "kindle");
  }
  const cacheHome = env.XDG_CACHE_HOME?.trim()
    ? resolve(env.XDG_CACHE_HOME.trim())
    : join(homedir(), ".cache");
  return join(cacheHome, "pocket-stack", "kindle");
}

function volumeCandidates(): string[] {
  const username = userInfo().username;
  const parents = [
    "/Volumes",
    join("/media", username),
    join("/run/media", username),
  ];
  const candidates: string[] = [];
  for (const parent of parents) {
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent)) {
      const candidate = join(parent, entry);
      try {
        if (lstatSync(candidate).isDirectory() && existsSync(join(candidate, "documents"))) {
          candidates.push(realpathSync(candidate));
        }
      } catch {
        // A volume may disappear while USB state changes; ignore that candidate.
      }
    }
  }
  return [...new Set(candidates)].sort();
}

export function resolveKindleVolume(explicit?: string): string {
  if (explicit) return validateKindleVolume(resolve(explicit));
  const candidates = volumeCandidates();
  if (candidates.length === 0) {
    throw new Error("no mounted Kindle volume found; pass --volume /Volumes/<name>");
  }
  if (candidates.length > 1) {
    throw new Error(
      `multiple possible Kindle volumes found; pass --volume explicitly:\n` +
        candidates.map((path) => `  ${path}`).join("\n"),
    );
  }
  return validateKindleVolume(candidates[0]);
}

export function validateKindleVolume(volume: string): string {
  if (!existsSync(volume)) throw new Error(`Kindle volume does not exist: ${volume}`);
  const resolved = realpathSync(volume);
  const rootStat = lstatSync(resolved);
  if (!rootStat.isDirectory()) throw new Error(`Kindle volume is not a directory: ${resolved}`);
  const documents = join(resolved, "documents");
  if (!existsSync(documents) || !lstatSync(documents).isDirectory()) {
    throw new Error(
      `refusing ${resolved}: expected an existing Kindle documents/ directory`,
    );
  }
  if (lstatSync(documents).isSymbolicLink()) {
    throw new Error(`refusing symbolic Kindle documents directory: ${documents}`);
  }
  return resolved;
}

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function assertDigest(label: string, data: Uint8Array, expected: string): void {
  const actual = sha256(data);
  if (actual !== expected) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expected}, got ${actual}`);
  }
}

function requireCommand(name: string): string {
  const command = Bun.which(name);
  if (!command) throw new Error(`required host command is missing: ${name}`);
  return command;
}

function commandBytes(command: readonly string[]): Uint8Array {
  const result = Bun.spawnSync({
    cmd: [...command],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      COPYFILE_DISABLE: "1",
      COPY_EXTENDED_ATTRIBUTES_DISABLE: "1",
    },
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    throw new Error(
      `${command.map((part) => JSON.stringify(part)).join(" ")} failed` +
        (stderr ? `: ${stderr}` : ""),
    );
  }
  return new Uint8Array(result.stdout);
}

function commandText(command: readonly string[]): string {
  return new TextDecoder().decode(commandBytes(command));
}

async function downloadVerified(
  cacheDirectory: string,
  asset: { readonly name: string; readonly url: string; readonly sha256: string; readonly cacheName: string },
): Promise<string> {
  mkdirSync(cacheDirectory, { recursive: true });
  const destination = join(cacheDirectory, `${asset.sha256}-${asset.cacheName}`);
  if (existsSync(destination) && await sha256File(destination) === asset.sha256) {
    console.log(`  · ${asset.name}: verified cache`);
    return destination;
  }

  const temporary = `${destination}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    const curl = requireCommand("curl");
    console.log(`  ↓ ${asset.name}: ${asset.url}`);
    const child = Bun.spawn({
      cmd: [curl, "--fail", "--location", "--retry", "3", "--output", temporary, asset.url],
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    if (await child.exited !== 0) throw new Error(`${asset.name} download failed`);
    const actual = await sha256File(temporary);
    if (actual !== asset.sha256) {
      throw new Error(
        `${asset.name} SHA-256 mismatch: expected ${asset.sha256}, got ${actual}`,
      );
    }
    if (existsSync(destination)) unlinkSync(destination);
    renameSync(temporary, destination);
    return destination;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function safeArchiveMemberPath(member: string): string {
  if (!member || member.includes("\0") || member.includes("\\")) {
    throw new Error(`unsafe archive member: ${JSON.stringify(member)}`);
  }
  if (member.split("/").includes("..")) {
    throw new Error(`unsafe archive traversal member: ${member}`);
  }
  if (isAbsolute(member) || member.startsWith("/")) {
    throw new Error(`unsafe absolute archive member: ${member}`);
  }
  const normalized = posix.normalize(member.replace(/\/+$/, ""));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`unsafe archive traversal member: ${member}`);
  }
  return normalized;
}

function isAppleMetadata(member: string): boolean {
  const parts = member.split("/");
  const name = parts.at(-1) ?? "";
  return parts.includes("__MACOSX") || name === ".DS_Store" || name.startsWith("._");
}

function mrpiMode(path: string): number {
  return path === "extensions/MRInstaller/bin/mrinstaller.sh" ||
      path === "extensions/MRInstaller/config.xml" ||
      path === "extensions/MRInstaller/menu.json" ||
      path === "extensions/MRInstaller/data/icons.py"
    ? 0o755
    : 0o644;
}

function validateArmhfElf(label: string, data: Uint8Array): void {
  if (
    data.length < 20 ||
    data[0] !== 0x7f ||
    data[1] !== 0x45 ||
    data[2] !== 0x4c ||
    data[3] !== 0x46 ||
    data[4] !== 1 ||
    data[5] !== 1 ||
    data[18] !== 40 ||
    data[19] !== 0
  ) {
    throw new Error(`${label} is not a 32-bit little-endian ARM ELF`);
  }
}

async function prepareDownloadedPayload(
  cacheDirectory: string,
  publicKey: string,
): Promise<PreparedKindlePayload> {
  const unzip = requireCommand("unzip");
  const tar = requireCommand("tar");
  const [pekiArchive, mrpiArchive, koreaderPackage] = await Promise.all([
    downloadVerified(cacheDirectory, KINDLE_BOOTSTRAP_ASSETS.peki),
    downloadVerified(cacheDirectory, KINDLE_BOOTSTRAP_ASSETS.mrpi),
    downloadVerified(cacheDirectory, KINDLE_BOOTSTRAP_ASSETS.koreader),
  ]);

  const kual = commandBytes([
    unzip,
    "-p",
    pekiArchive,
    KINDLE_BOOTSTRAP_ASSETS.peki.archiveMember,
  ]);
  assertDigest(
    `PEKI ${KINDLE_BOOTSTRAP_ASSETS.peki.archiveMember}`,
    kual,
    KINDLE_BOOTSTRAP_ASSETS.peki.memberSha256,
  );

  const names = commandText([unzip, "-Z1", mrpiArchive])
    .split(/\r?\n/)
    .filter(Boolean);
  const mrpiEntries: PreparedMrpiEntry[] = [];
  for (const archiveName of names) {
    const path = safeArchiveMemberPath(archiveName);
    if (isAppleMetadata(path)) continue;
    if (
      path !== "extensions" &&
      !path.startsWith("extensions/") &&
      path !== "mrpackages" &&
      !path.startsWith("mrpackages/")
    ) {
      continue;
    }
    const directory = archiveName.endsWith("/");
    mrpiEntries.push({
      path,
      directory,
      data: directory ? undefined : commandBytes([unzip, "-p", mrpiArchive, archiveName]),
      mode: directory ? 0o755 : mrpiMode(path),
    });
  }
  const mrInstaller = mrpiEntries.find(
    (entry) => entry.path === KINDLE_BOOTSTRAP_ASSETS.mrpi.installerMember,
  );
  if (!mrInstaller?.data) {
    throw new Error(`MRPI archive is missing ${KINDLE_BOOTSTRAP_ASSETS.mrpi.installerMember}`);
  }
  assertDigest(
    "KHF MRPI installer",
    mrInstaller.data,
    KINDLE_BOOTSTRAP_ASSETS.mrpi.installerSha256,
  );

  const fbink = commandBytes([
    tar,
    "-xOzf",
    koreaderPackage,
    KINDLE_BOOTSTRAP_ASSETS.koreader.members.fbink.path,
  ]);
  const dropbear = commandBytes([
    tar,
    "-xOzf",
    koreaderPackage,
    KINDLE_BOOTSTRAP_ASSETS.koreader.members.dropbear.path,
  ]);
  assertDigest("KOReader kindlehf fbink", fbink, KINDLE_BOOTSTRAP_ASSETS.koreader.members.fbink.sha256);
  assertDigest(
    "KOReader kindlehf dropbear",
    dropbear,
    KINDLE_BOOTSTRAP_ASSETS.koreader.members.dropbear.sha256,
  );
  validateArmhfElf("KOReader kindlehf fbink", fbink);
  validateArmhfElf("KOReader kindlehf dropbear", dropbear);

  return { kual, mrpiEntries, fbink, dropbear, publicKey };
}

function normalizePublicKey(value: string): string {
  const lines = value.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) throw new Error("SSH public key must contain exactly one key");
  const fields = lines[0].trim().split(/\s+/);
  if (!["ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256"].includes(fields[0]) || !fields[1]) {
    throw new Error("unsupported or malformed SSH public key");
  }
  if (lines[0].includes("PRIVATE KEY")) throw new Error("refusing an SSH private key");
  return `${lines[0].trim()}\n`;
}

function publicKeyIdentity(value: string): string {
  return normalizePublicKey(value).trim().split(/\s+/).slice(0, 2).join(" ");
}

export function ensureDedicatedSshKey(privateKeyPath: string): string {
  const keyPath = resolve(privateKeyPath);
  const publicPath = `${keyPath}.pub`;
  const sshKeygen = requireCommand("ssh-keygen");

  if (!existsSync(keyPath)) {
    if (existsSync(publicPath)) {
      throw new Error(`refusing orphaned public key without private key: ${publicPath}`);
    }
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    const result = Bun.spawnSync({
      cmd: [
        sshKeygen,
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "pocketjs-kindle",
        "-f",
        keyPath,
      ],
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      throw new Error(`ssh-keygen failed: ${result.stderr.toString().trim()}`);
    }
    console.log(`  ✓ generated dedicated SSH key: ${keyPath}`);
  }

  const privateStat = lstatSync(keyPath);
  if (!privateStat.isFile() || privateStat.isSymbolicLink()) {
    throw new Error(`refusing non-regular SSH private key: ${keyPath}`);
  }
  chmodSync(keyPath, 0o600);
  const derived = normalizePublicKey(commandText([sshKeygen, "-y", "-f", keyPath]));
  if (existsSync(publicPath)) {
    const publicStat = lstatSync(publicPath);
    if (!publicStat.isFile() || publicStat.isSymbolicLink()) {
      throw new Error(`refusing non-regular SSH public key: ${publicPath}`);
    }
    const existing = normalizePublicKey(readFileSync(publicPath, "utf8"));
    if (publicKeyIdentity(existing) !== publicKeyIdentity(derived)) {
      throw new Error(`SSH public key does not match its private key: ${publicPath}`);
    }
    return existing;
  }

  writeFileSync(publicPath, derived, { mode: 0o644, flag: "wx" });
  return derived;
}

function pathInside(boundary: string, destination: string): string {
  const rel = relative(boundary, destination);
  if (!rel || rel === "." || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
    if (!rel || rel === ".") return destination;
    throw new Error(`refusing path outside Kindle volume: ${destination}`);
  }
  return destination;
}

function validateExistingAncestors(boundary: string, destination: string): void {
  pathInside(boundary, destination);
  const rel = relative(boundary, destination);
  let current = boundary;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) continue;
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`refusing symbolic path on Kindle volume: ${current}`);
    if (current !== destination && !stat.isDirectory()) {
      throw new Error(`expected a directory on Kindle volume: ${current}`);
    }
  }
}

function ensureDirectory(boundary: string, destination: string): void {
  validateExistingAncestors(boundary, destination);
  const rel = relative(boundary, destination);
  let current = boundary;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`refusing non-directory path on Kindle volume: ${current}`);
      }
    } else {
      mkdirSync(current, { mode: 0o755 });
    }
  }
}

function existingManagedReceipt(data: Uint8Array): boolean {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(data)) as { managedBy?: unknown };
    return parsed.managedBy === "pocketjs-kindle-bootstrap";
  } catch {
    return false;
  }
}

function planFile(
  volume: string,
  destination: string,
  data: Uint8Array | string,
  mode: number,
  policy: FilePolicy,
  label: string,
): FilePlan {
  validateExistingAncestors(volume, destination);
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  if (!existsSync(destination)) {
    return { destination, data: bytes, mode, policy, label, action: "installed" };
  }
  const stat = lstatSync(destination);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`refusing to replace non-regular file: ${destination}`);
  }
  const existing = readFileSync(destination);
  if (existing.equals(Buffer.from(bytes))) {
    return { destination, data: bytes, mode, policy, label, action: "unchanged" };
  }
  if (policy === "identical-only") {
    throw new Error(
      `refusing to overwrite an existing different ${label}: ${destination}`,
    );
  }
  if (
    policy === "managed-text" &&
    !new TextDecoder().decode(existing.subarray(0, 1024)).includes(MANAGED_MARKER)
  ) {
    throw new Error(`refusing to overwrite an unmanaged ${label}: ${destination}`);
  }
  if (policy === "managed-receipt" && !existingManagedReceipt(existing)) {
    throw new Error(`refusing to overwrite an unmanaged ${label}: ${destination}`);
  }
  if (
    policy === "authorized-keys" &&
    !new TextDecoder().decode(bytes).includes(AUTHORIZED_KEYS_BEGIN)
  ) {
    throw new Error(`refusing malformed managed authorized_keys content: ${destination}`);
  }
  return { destination, data: bytes, mode, policy, label, action: "updated" };
}

function planDirectory(
  volume: string,
  destination: string,
  label: string,
  appleDoublePolicy: DirectoryPlan["appleDoublePolicy"],
): DirectoryPlan {
  validateExistingAncestors(volume, destination);
  if (!existsSync(destination)) {
    return { destination, label, action: "installed", appleDoublePolicy };
  }
  const stat = lstatSync(destination);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`refusing non-directory ${label}: ${destination}`);
  }
  return { destination, label, action: "unchanged", appleDoublePolicy };
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!["EBADF", "EINVAL", "EISDIR", "ENOTSUP"].includes(code ?? "")) throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function appleDoubleSidecars(
  volume: string,
  destinations: readonly string[],
): string[] {
  return [
    ...new Set(
      destinations.map((destination) =>
        pathInside(volume, join(dirname(destination), `._${basename(destination)}`)),
      ),
    ),
  ].sort();
}

function readExactly(descriptor: number, target: Buffer, position: number): number {
  let total = 0;
  while (total < target.byteLength) {
    const count = readSync(
      descriptor,
      target,
      total,
      target.byteLength - total,
      position + total,
    );
    if (count === 0) break;
    total += count;
  }
  return total;
}

interface FileIdentity {
  readonly device: number;
  readonly inode: number;
}

function inspectManagedAppleDouble(sidecar: string): FileIdentity | undefined {
  let pathStat: ReturnType<typeof lstatSync>;
  try {
    pathStat = lstatSync(sidecar);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
    throw new Error(`refusing non-regular managed AppleDouble path: ${sidecar}`);
  }

  const descriptor = openSync(sidecar, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedStat = fstatSync(descriptor);
    if (
      !openedStat.isFile() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino
    ) {
      throw new Error(`managed AppleDouble identity changed while opening: ${sidecar}`);
    }

    const header = Buffer.alloc(26);
    if (readExactly(descriptor, header, 0) !== header.byteLength) {
      throw new Error(`refusing truncated AppleDouble collision at managed metadata path: ${sidecar}`);
    }
    const magic = header.readUInt32BE(0);
    const version = header.readUInt32BE(4);
    const entryCount = header.readUInt16BE(24);
    if (
      magic !== 0x00051607 ||
      ![0x00010000, 0x00020000].includes(version) ||
      entryCount === 0
    ) {
      throw new Error(`refusing non-AppleDouble collision at managed metadata path: ${sidecar}`);
    }

    const table = Buffer.alloc(entryCount * 12);
    const dataOffset = header.byteLength + table.byteLength;
    if (
      dataOffset > openedStat.size ||
      readExactly(descriptor, table, header.byteLength) !== table.byteLength
    ) {
      throw new Error(`refusing invalid AppleDouble table at managed metadata path: ${sidecar}`);
    }
    for (let index = 0; index < entryCount; index += 1) {
      const offset = table.readUInt32BE(index * 12 + 4);
      const length = table.readUInt32BE(index * 12 + 8);
      if (offset < dataOffset || offset > openedStat.size || length > openedStat.size - offset) {
        throw new Error(`refusing invalid AppleDouble entry at managed metadata path: ${sidecar}`);
      }
    }

    return { device: openedStat.dev, inode: openedStat.ino };
  } finally {
    closeSync(descriptor);
  }
}

function validateManagedAppleDoubleFiles(
  volume: string,
  destinations: readonly string[],
): void {
  for (const sidecar of appleDoubleSidecars(volume, destinations)) {
    validateExistingAncestors(volume, sidecar);
    inspectManagedAppleDouble(sidecar);
  }
}

function removeManagedAppleDoubleFiles(
  volume: string,
  destinations: readonly string[],
): void {
  const parentDirectories = new Set<string>();

  for (const sidecar of appleDoubleSidecars(volume, destinations)) {
    validateExistingAncestors(volume, sidecar);
    const identity = inspectManagedAppleDouble(sidecar);
    if (!identity) continue;
    const current = lstatSync(sidecar);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== identity.device ||
      current.ino !== identity.inode
    ) {
      throw new Error(`managed AppleDouble identity changed before removal: ${sidecar}`);
    }

    unlinkSync(sidecar);
    parentDirectories.add(dirname(sidecar));
  }

  for (const directory of parentDirectories) syncDirectory(directory);
}

function writePlannedFile(volume: string, plan: FilePlan): void {
  ensureDirectory(volume, dirname(plan.destination));
  if (plan.action !== "unchanged") {
    const temporary = join(
      dirname(plan.destination),
      `.${basename(plan.destination)}.pocketjs-${process.pid}-${Math.random().toString(16).slice(2)}`,
    );
    validateManagedAppleDoubleFiles(volume, [temporary]);
    let descriptor: number | undefined;
    let temporaryCreated = false;
    let temporaryIdentity: FileIdentity | undefined;
    let operationError: unknown;
    try {
      descriptor = openSync(temporary, "wx", plan.mode);
      temporaryCreated = true;
      const stat = fstatSync(descriptor);
      temporaryIdentity = { device: stat.dev, inode: stat.ino };
      writeFileSync(descriptor, plan.data);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, plan.destination);
      temporaryCreated = false;
    } catch (error) {
      operationError = error;
    }

    let cleanupError: unknown;
    try {
      if (descriptor !== undefined) closeSync(descriptor);
      if (temporaryCreated) {
        const current = lstatSync(temporary);
        if (
          !temporaryIdentity ||
          !current.isFile() ||
          current.isSymbolicLink() ||
          current.dev !== temporaryIdentity.device ||
          current.ino !== temporaryIdentity.inode
        ) {
          throw new Error(`temporary managed file identity changed before cleanup: ${temporary}`);
        }
        unlinkSync(temporary);
      }
      if (temporaryIdentity !== undefined) {
        removeManagedAppleDoubleFiles(volume, [temporary]);
      }
    } catch (error) {
      cleanupError = error;
    }
    if (operationError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [operationError, cleanupError],
        `managed file write and cleanup both failed: ${plan.destination}`,
      );
    }
    if (operationError !== undefined) throw operationError;
    if (cleanupError !== undefined) throw cleanupError;
    syncDirectory(dirname(plan.destination));
  }
  try {
    chmodSync(plan.destination, plan.mode);
  } catch {
    // FAT-backed USB volumes may ignore Unix modes. The device invokes scripts
    // through `sh`; Kindle's /mnt/us mount supplies executable binary access.
  }
}

function managedFilesForReceipt(volume: string, plans: readonly FilePlan[]): ReceiptManagedFile[] {
  return plans
    .map((plan) => ({
      path: relative(volume, plan.destination).split(sep).join(posix.sep),
      bytes: plan.data.byteLength,
      sha256: sha256(plan.data),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function verifyManagedFiles(plans: readonly FilePlan[]): void {
  for (const plan of plans) {
    const actual = readFileSync(plan.destination);
    if (!actual.equals(Buffer.from(plan.data))) {
      throw new Error(`managed file verification failed before receipt commit: ${plan.destination}`);
    }
  }
}

function mergeAuthorizedKey(existing: string, publicKey: string): string {
  const normalizedKey = normalizePublicKey(publicKey).trim();
  const block = `${AUTHORIZED_KEYS_BEGIN}\n${normalizedKey}\n${AUTHORIZED_KEYS_END}`;
  const begin = existing.indexOf(AUTHORIZED_KEYS_BEGIN);
  const end = existing.indexOf(AUTHORIZED_KEYS_END);
  if ((begin === -1) !== (end === -1) || (begin !== -1 && end < begin)) {
    throw new Error("authorized_keys contains an incomplete PocketJS managed block");
  }
  if (begin !== -1) {
    const after = end + AUTHORIZED_KEYS_END.length;
    const merged = `${existing.slice(0, begin)}${block}${existing.slice(after)}`;
    return `${merged.trimEnd()}\n`;
  }
  const prefix = existing.trimEnd();
  return `${prefix ? `${prefix}\n\n` : ""}${block}\n`;
}

function readTemplate(repositoryRoot: string, name: string, sshPort: number): string {
  const path = join(repositoryRoot, "hosts", "kindle", "device", name);
  if (!existsSync(path)) throw new Error(`missing Kindle device template: ${path}`);
  const source = readFileSync(path, "utf8");
  if (!source.includes(MANAGED_MARKER)) {
    throw new Error(`Kindle device template is missing its managed marker: ${path}`);
  }
  return source
    .replaceAll("@@SSH_PORT@@", String(sshPort))
    .replaceAll("@@HOST_USB_IP@@", KINDLE_USB_NETWORK.hostIp)
    .replaceAll("@@KINDLE_USB_IP@@", KINDLE_USB_NETWORK.kindleIp);
}

function receiptFor(
  payload: PreparedKindlePayload,
  sshPort: number,
  managedFiles: readonly ReceiptManagedFile[],
): string {
  return JSON.stringify({
    managedBy: "pocketjs-kindle-bootstrap",
    schemaVersion: 2,
    profile: {
      device: "Kindle Paperwhite 5",
      firmware: "5.19.2",
      abi: "armhf",
    },
    ssh: {
      port: sshPort,
      publicKeySha256: sha256(normalizePublicKey(payload.publicKey)),
      transport: {
        interface: KINDLE_USB_NETWORK.interface,
        hostIp: KINDLE_USB_NETWORK.hostIp,
        kindleIp: KINDLE_USB_NETWORK.kindleIp,
        netmask: KINDLE_USB_NETWORK.netmask,
        wifiListening: false,
      },
    },
    assets: {
      peki: {
        version: KINDLE_BOOTSTRAP_ASSETS.peki.version,
        sourceRevision: KINDLE_BOOTSTRAP_ASSETS.peki.sourceRevision,
        url: KINDLE_BOOTSTRAP_ASSETS.peki.url,
        sha256: KINDLE_BOOTSTRAP_ASSETS.peki.sha256,
        extractedSha256: sha256(payload.kual),
      },
      mrpi: {
        version: KINDLE_BOOTSTRAP_ASSETS.mrpi.version,
        sourceRevision: KINDLE_BOOTSTRAP_ASSETS.mrpi.sourceRevision,
        url: KINDLE_BOOTSTRAP_ASSETS.mrpi.url,
        sha256: KINDLE_BOOTSTRAP_ASSETS.mrpi.sha256,
      },
      koreaderKpm: {
        version: KINDLE_BOOTSTRAP_ASSETS.koreader.version,
        sourceRevision: KINDLE_BOOTSTRAP_ASSETS.koreader.sourceRevision,
        url: KINDLE_BOOTSTRAP_ASSETS.koreader.url,
        sha256: KINDLE_BOOTSTRAP_ASSETS.koreader.sha256,
        extracted: {
          fbink: sha256(payload.fbink),
          dropbear: sha256(payload.dropbear),
        },
      },
    },
    managedFiles,
  }, null, 2) + "\n";
}

function deviceReadme(sshPort: number): string {
  return [
    `# ${MANAGED_MARKER}`,
    "",
    "PocketJS Kindle development profile",
    "====================================",
    "",
    "Target: Kindle Paperwhite 5, firmware 5.19.2, armhf",
    "",
    "From the Kindle library, run:",
    "  PocketJS-Dev-Start.sh       start key-only Dropbear SSH",
    "  PocketJS-Dev-Stop.sh        locally stop runtime/SSH and safely restore USB",
    "  PocketJS-Dev-Diagnose.sh    write logs/diagnostics.txt",
    "  PocketJS-Dev-Start-USBNet.sh switch only the USB gadget to network",
    "  PocketJS-Dev-Stop-USBNet.sh  restore the USB mode recorded at start",
    "  PocketJS-Dev-Run-Runtime.sh   pause Kindle UI and run bin/pocketjs-kindle",
    "  PocketJS-Dev-Stop-Runtime.sh  stop runtime and restore only UI processes it paused",
    "",
    `macOS USB address: ${KINDLE_USB_NETWORK.hostIp}/${KINDLE_USB_NETWORK.netmask}`,
    `Kindle USB address: ${KINDLE_USB_NETWORK.kindleIp}`,
    `Host connection: ssh -p ${sshPort} -i <private-key> root@${KINDLE_USB_NETWORK.kindleIp}`,
    "Dropbear is bound to usb0 and the Kindle USB address; it never listens on Wi-Fi.",
    "USB gadget changes use the firmware's built-in volumd/LIPC interface; no",
    "third-party USBNetwork daemon, password login, or Wi-Fi SSH is installed.",
    "Stop USB SSH must be launched locally; it refuses export while any process",
    "still uses PocketJS files under /mnt/us.",
    "",
    "fbink and dropbear were extracted from the pinned KindleModding KOReader",
    "KPM package. Provenance and hashes are in .pocketjs-bootstrap.json.",
    "",
  ].join("\n");
}

export function stageKindleVolume(
  rawVolume: string,
  payload: PreparedKindlePayload,
  options: { readonly sshPort?: number; readonly repositoryRoot?: string } = {},
): StageSummary {
  const volume = validateKindleVolume(rawVolume);
  const sshPort = options.sshPort ?? 2222;
  parseSshPort(String(sshPort));
  const repositoryRoot = options.repositoryRoot ?? REPOSITORY_ROOT;
  const devRoot = join(volume, "pocketjs-dev");
  const documents = join(volume, "documents");

  const normalizedPublicKey = normalizePublicKey(payload.publicKey);
  const authorizedKeysPath = join(devRoot, "settings", "SSH", "authorized_keys");
  const existingAuthorizedKeys = existsSync(authorizedKeysPath)
    ? readFileSync(authorizedKeysPath, "utf8")
    : "";
  const mergedAuthorizedKeys = mergeAuthorizedKey(existingAuthorizedKeys, normalizedPublicKey);

  const directoryPlans: DirectoryPlan[] = [
    planDirectory(volume, devRoot, "PocketJS development directory", "managed"),
    planDirectory(volume, join(devRoot, "bin"), "PocketJS bin directory", "managed"),
    planDirectory(volume, join(devRoot, "logs"), "PocketJS logs directory", "managed"),
    planDirectory(volume, join(devRoot, "run"), "PocketJS run directory", "managed"),
    planDirectory(volume, join(devRoot, "settings"), "PocketJS settings directory", "managed"),
    planDirectory(
      volume,
      join(devRoot, "settings", "SSH"),
      "PocketJS SSH settings directory",
      "managed",
    ),
    planDirectory(volume, join(volume, "extensions"), "Kindle extension directory", "shared"),
    planDirectory(
      volume,
      join(volume, "extensions", "PocketJS"),
      "PocketJS KUAL extension directory",
      "managed",
    ),
    planDirectory(
      volume,
      join(volume, "extensions", "PocketJS", "bin"),
      "PocketJS KUAL extension bin directory",
      "managed",
    ),
  ];

  const filePlans: FilePlan[] = [
    planFile(
      volume,
      join(documents, "KUAL.sh"),
      payload.kual,
      0o755,
      "identical-only",
      "PEKI KUAL.sh",
    ),
    planFile(
      volume,
      join(volume, "extensions", "PocketJS", "menu.json"),
      readTemplate(repositoryRoot, "kual-menu.json", sshPort),
      0o644,
      "managed-text",
      "PocketJS KUAL menu",
    ),
    // KUALBooklet discovers extensions via config.xml; menu.json alone is ignored.
    planFile(
      volume,
      join(volume, "extensions", "PocketJS", "config.xml"),
      readTemplate(repositoryRoot, "config.xml", sshPort),
      0o644,
      "managed-text",
      "PocketJS KUAL extension descriptor",
    ),
    planFile(
      volume,
      join(volume, "extensions", "PocketJS", "bin", "pocketjs.sh"),
      readTemplate(repositoryRoot, "kual-pocketjs.sh", sshPort),
      0o755,
      "managed-text",
      "PocketJS KUAL dispatcher",
    ),
    // Prefer a preinstalled USBNetwork/NiLuJe fbink on the volume when present.
    // The KOReader kindlehf build needs ld-linux-armhf.so.3 which some 5.16.x
    // firmwares do not ship; the USBNetwork binary is the one that already runs.
    planFile(
      volume,
      join(devRoot, "bin", "fbink"),
      existsSync(join(volume, "usbnet", "bin", "fbink"))
        ? readFileSync(join(volume, "usbnet", "bin", "fbink"))
        : payload.fbink,
      0o755,
      "identical-only",
      existsSync(join(volume, "usbnet", "bin", "fbink"))
        ? "usbnet fbink (preferred for firmwares without ld-linux-armhf)"
        : "kindlehf fbink",
    ),
    planFile(
      volume,
      join(devRoot, "bin", "dropbear"),
      payload.dropbear,
      0o755,
      "identical-only",
      "kindlehf dropbear",
    ),
    planFile(
      volume,
      join(devRoot, "start-ssh.sh"),
      readTemplate(repositoryRoot, "start-ssh.sh", sshPort),
      0o755,
      "managed-text",
      "PocketJS start script",
    ),
    planFile(
      volume,
      join(devRoot, "stop-ssh.sh"),
      readTemplate(repositoryRoot, "stop-ssh.sh", sshPort),
      0o755,
      "managed-text",
      "PocketJS stop script",
    ),
    planFile(
      volume,
      join(devRoot, "diagnose.sh"),
      readTemplate(repositoryRoot, "diagnose.sh", sshPort),
      0o755,
      "managed-text",
      "PocketJS diagnostics script",
    ),
    planFile(
      volume,
      join(devRoot, "usbnet-start.sh"),
      readTemplate(repositoryRoot, "usbnet-start.sh", sshPort),
      0o755,
      "managed-text",
      "PocketJS USBNetwork start script",
    ),
    planFile(
      volume,
      join(devRoot, "usb-mode.sh"),
      readTemplate(repositoryRoot, "usb-mode.sh", sshPort),
      0o755,
      "managed-text",
      "PocketJS firmware USB mode adapter",
    ),
    planFile(
      volume,
      join(devRoot, "usbnet-stop.sh"),
      readTemplate(repositoryRoot, "usbnet-stop.sh", sshPort),
      0o755,
      "managed-text",
      "PocketJS USBNetwork stop script",
    ),
    planFile(
      volume,
      join(devRoot, "run-runtime.sh"),
      readTemplate(repositoryRoot, "run-runtime.sh", sshPort),
      0o755,
      "managed-text",
      "PocketJS runtime launcher",
    ),
    planFile(
      volume,
      join(devRoot, "stop-runtime.sh"),
      readTemplate(repositoryRoot, "stop-runtime.sh", sshPort),
      0o755,
      "managed-text",
      "PocketJS runtime stop script",
    ),
    planFile(
      volume,
      join(documents, "PocketJS-Dev-Start.sh"),
      readTemplate(repositoryRoot, "documents-start.sh", sshPort),
      0o755,
      "managed-text",
      "PocketJS start scriptlet",
    ),
    planFile(
      volume,
      join(documents, "PocketJS-Dev-Stop.sh"),
      readTemplate(repositoryRoot, "documents-stop.sh", sshPort),
      0o755,
      "managed-text",
      "PocketJS stop scriptlet",
    ),
    planFile(
      volume,
      join(documents, "PocketJS-Dev-Diagnose.sh"),
      readTemplate(repositoryRoot, "documents-diagnose.sh", sshPort),
      0o755,
      "managed-text",
      "PocketJS diagnostics scriptlet",
    ),
    planFile(
      volume,
      join(documents, "PocketJS-Dev-Start-USBNet.sh"),
      readTemplate(repositoryRoot, "documents-start-usbnet.sh", sshPort),
      0o755,
      "managed-text",
      "PocketJS USBNetwork start scriptlet",
    ),
    planFile(
      volume,
      join(documents, "PocketJS-Dev-Stop-USBNet.sh"),
      readTemplate(repositoryRoot, "documents-stop-usbnet.sh", sshPort),
      0o755,
      "managed-text",
      "PocketJS USBNetwork stop scriptlet",
    ),
    planFile(
      volume,
      join(documents, "PocketJS-Dev-Run-Runtime.sh"),
      readTemplate(repositoryRoot, "documents-run-runtime.sh", sshPort),
      0o755,
      "managed-text",
      "PocketJS runtime launcher scriptlet",
    ),
    planFile(
      volume,
      join(documents, "PocketJS-Dev-Stop-Runtime.sh"),
      readTemplate(repositoryRoot, "documents-stop-runtime.sh", sshPort),
      0o755,
      "managed-text",
      "PocketJS runtime stop scriptlet",
    ),
    planFile(
      volume,
      authorizedKeysPath,
      mergedAuthorizedKeys,
      0o600,
      "authorized-keys",
      "PocketJS authorized_keys",
    ),
    planFile(
      volume,
      join(devRoot, "README.txt"),
      deviceReadme(sshPort),
      0o644,
      "managed-text",
      "PocketJS device README",
    ),
  ];

  const seenMrpiPaths = new Set<string>();
  for (const entry of payload.mrpiEntries) {
    const path = safeArchiveMemberPath(entry.path);
    if (
      path !== "extensions" &&
      !path.startsWith("extensions/") &&
      path !== "mrpackages" &&
      !path.startsWith("mrpackages/")
    ) {
      throw new Error(`refusing non-MRPI payload entry: ${entry.path}`);
    }
    if (isAppleMetadata(path)) continue;
    if (seenMrpiPaths.has(path)) throw new Error(`duplicate MRPI payload entry: ${path}`);
    seenMrpiPaths.add(path);
    const destination = join(volume, ...path.split("/"));
    if (entry.directory) {
      directoryPlans.push(
        planDirectory(
          volume,
          destination,
          `MRPI directory ${path}`,
          path === "extensions" || path === "mrpackages" ? "shared" : "managed",
        ),
      );
    } else {
      if (!entry.data) throw new Error(`MRPI file entry has no data: ${path}`);
      filePlans.push(
        planFile(volume, destination, entry.data, entry.mode, "identical-only", `MRPI file ${path}`),
      );
    }
  }
  if (!seenMrpiPaths.has("mrpackages")) {
    directoryPlans.push(
      planDirectory(
        volume,
        join(volume, "mrpackages"),
        "MRPI package directory",
        "shared",
      ),
    );
  }

  const receiptPath = join(devRoot, ".pocketjs-bootstrap.json");
  let receiptPlan = planFile(
    volume,
    receiptPath,
    receiptFor(payload, sshPort, managedFilesForReceipt(volume, filePlans)),
    0o644,
    "managed-receipt",
    "PocketJS bootstrap receipt",
  );
  const appleDoubleManagedDestinations = [
    ...directoryPlans
      .filter((plan) => plan.appleDoublePolicy === "managed")
      .map((plan) => plan.destination),
    ...filePlans.map((plan) => plan.destination),
    receiptPlan.destination,
  ];

  // Preflight above resolves every conflict before the first write. Only exact
  // PocketJS/MRPI targets are touched; unrelated files on the volume survive.
  validateManagedAppleDoubleFiles(volume, appleDoubleManagedDestinations);
  for (const plan of directoryPlans) ensureDirectory(volume, plan.destination);
  const managedFilesChanged = filePlans.some((plan) => plan.action !== "unchanged");
  if (managedFilesChanged && existsSync(receiptPath)) {
    // The receipt is the transaction's commit marker. Remove the old commit
    // before changing its covered files so an interrupted update cannot retain
    // a receipt for a mixed old/new payload.
    unlinkSync(receiptPath);
    syncDirectory(dirname(receiptPath));
    if (receiptPlan.action === "unchanged") {
      receiptPlan = { ...receiptPlan, action: "updated" };
    }
  }

  for (const plan of filePlans) writePlannedFile(volume, plan);
  removeManagedAppleDoubleFiles(
    volume,
    appleDoubleManagedDestinations.filter((destination) => destination !== receiptPlan.destination),
  );
  verifyManagedFiles(filePlans);
  // Each covered file has been written, synced, and verified. Atomically publish
  // the new receipt last; an interrupted transaction therefore has no receipt.
  writePlannedFile(volume, receiptPlan);
  // macOS synthesizes AppleDouble `._*` files while writing/chmodding FAT
  // volumes. Remove only sidecars corresponding to this exact managed plan,
  // and only after validating their AppleDouble magic. Unrelated metadata and
  // user files are never swept by name or directory.
  removeManagedAppleDoubleFiles(volume, [receiptPlan.destination]);
  verifyManagedFiles([receiptPlan]);

  const installed: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];
  for (const plan of [...directoryPlans, ...filePlans, receiptPlan]) {
    const label = relative(volume, plan.destination);
    if (plan.action === "installed") installed.push(label);
    else if (plan.action === "updated") updated.push(label);
    else unchanged.push(label);
  }
  return { installed, updated, unchanged };
}

function printDryRun(volume: string, options: KindleBootstrapOptions, keyPath: string): void {
  console.log("PocketJS Kindle bootstrap (dry run)");
  console.log(`  target: Kindle Paperwhite 5 / firmware 5.19.2 / armhf`);
  console.log(`  volume: ${volume}`);
  console.log(`  SSH: key-only, port ${options.sshPort}`);
  console.log(
    `  USB network: host ${KINDLE_USB_NETWORK.hostIp} → Kindle ${KINDLE_USB_NETWORK.kindleIp}`,
  );
  console.log(`  private key: ${keyPath}${existsSync(keyPath) ? " (exists)" : " (would generate)"}`);
  console.log("  assets (would download/verify):");
  for (const asset of [
    KINDLE_BOOTSTRAP_ASSETS.peki,
    KINDLE_BOOTSTRAP_ASSETS.mrpi,
    KINDLE_BOOTSTRAP_ASSETS.koreader,
  ]) {
    console.log(`    ${asset.name} ${asset.version} sha256:${asset.sha256}`);
  }
  console.log("  writes:");
  console.log("    documents/KUAL.sh + PocketJS SSH/USBNetwork/runtime/diagnostics scriptlets");
  console.log("    extensions/MRInstaller + mrpackages");
  console.log("    pocketjs-dev/{bin,settings,logs,run} and bootstrap receipt");
  console.log("  no files, keys, caches, or downloads were changed");
}

function warnFreeSpace(volume: string): void {
  try {
    const stat = statfsSync(volume);
    const free = Number(stat.bavail) * Number(stat.bsize);
    if (free < MINIMUM_RECOMMENDED_FREE_BYTES) {
      console.warn(
        `warning: only ${Math.floor(free / 1024 / 1024)} MiB free; ` +
          "KindleModding recommends at least 220 MiB for KUAL + MRPI",
      );
    }
  } catch {
    // Free-space reporting differs across removable filesystem drivers.
  }
}

async function main(): Promise<void> {
  const options = parseKindleBootstrapArgs(Bun.argv.slice(2));
  const volume = resolveKindleVolume(options.volume);
  const keyPath = resolve(options.sshKey ?? join(homedir(), ".ssh", "pocketjs-kindle-ed25519"));
  if (options.dryRun) {
    printDryRun(volume, options, keyPath);
    return;
  }

  warnFreeSpace(volume);
  console.log("PocketJS Kindle bootstrap");
  console.log(`  volume: ${volume}`);
  console.log(`  profile: PW5 / firmware 5.19.2 / armhf`);

  console.log("SSH identity:");
  const publicKey = ensureDedicatedSshKey(keyPath);
  console.log(`  · public key sha256:${sha256(publicKey)}`);

  console.log("verified upstream assets:");
  const cacheDirectory = resolve(options.cacheDirectory ?? defaultCacheRoot());
  const payload = await prepareDownloadedPayload(cacheDirectory, publicKey);

  console.log("USB staging:");
  const summary = stageKindleVolume(volume, payload, { sshPort: options.sshPort });
  console.log(`  ✓ installed ${summary.installed.length}, updated ${summary.updated.length}, unchanged ${summary.unchanged.length}`);

  console.log("\nKindle USB stage ready.");
  console.log("  1. Eject the Kindle cleanly, then unplug USB.");
  console.log("  2. Open documents/KUAL.sh once to install/launch PEKI KUAL.");
  console.log("  3. Run PocketJS-Dev-Start.sh from the library.");
  console.log("  4. If needed, run PocketJS-Dev-Diagnose.sh and reconnect USB for the report.");
  console.log(
    `  5. Configure the macOS USB interface as ${KINDLE_USB_NETWORK.hostIp} ` +
      `netmask ${KINDLE_USB_NETWORK.netmask}.`,
  );
  console.log(
    `  6. Connect: ssh -p ${options.sshPort} -i ${keyPath} ` +
      `root@${KINDLE_USB_NETWORK.kindleIp}`,
  );
  console.log("  Keep Airplane mode enabled whenever you temporarily free OTA-blocking storage.");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`PocketJS Kindle bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
