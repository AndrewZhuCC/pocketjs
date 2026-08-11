/**
 * Thin wrapper around globalThis.manga (Kindle host surface).
 * Feature-detects so sim/web builds still compile.
 */

export type MangaHost = {
  available: boolean;
  exit: () => void;
  loadPage: (url: string, cookie?: string) => number;
  prefetchPage?: (url: string, cookie?: string) => number;
  /** Burn "12/32" as black digits into page corner (no UI chrome). */
  setProgress?: (text: string) => void;
  jobStatus: (id: number) => string;
  clearPage: () => void;
  hasPage: () => number;
  httpStart?: (method: string, url: string, headersJson: string, body: string) => number;
  httpStatus?: (id: number) => string;
  httpTake?: (id: number) => string;
  readFile?: (rel: string) => string;
  writeFile?: (rel: string, text: string) => number;
};

export type HttpResult = {
  status: number;
  body: string;
  setCookie: string;
};

declare const globalThis: {
  manga?: MangaHost;
};

/** Pending HTTP promises resolved from onFrame poll. */
const pendingHttp = new Map<
  number,
  { resolve: (r: HttpResult) => void; reject: (e: Error) => void }
>();

export function getMangaHost(): MangaHost | null {
  const m = globalThis.manga;
  if (!m || !m.available) return null;
  return m;
}

export function requestExit(): boolean {
  const m = getMangaHost();
  if (!m) return false;
  m.exit();
  return true;
}

export function loadPage(url: string, cookie?: string): number | null {
  const m = getMangaHost();
  if (!m) return null;
  return m.loadPage(url, cookie);
}

/** Decode into host cache without changing the visible page. */
export function prefetchPage(url: string, cookie?: string): number | null {
  const m = getMangaHost();
  if (!m?.prefetchPage) return null;
  return m.prefetchPage(url, cookie);
}

/** Black page-number overlay burned into underlay corner. */
export function setProgressOverlay(text: string): void {
  getMangaHost()?.setProgress?.(text);
}

export function jobStatus(id: number): string {
  const m = getMangaHost();
  if (!m) return "error:no-host";
  return m.jobStatus(id);
}

export function clearPage(): void {
  getMangaHost()?.clearPage();
}

/** Call once per frame to settle httpStart promises. */
export function pollHttpJobs(): void {
  const m = getMangaHost();
  if (!m?.httpStatus || !m.httpTake || pendingHttp.size === 0) return;
  for (const [id, wait] of [...pendingHttp.entries()]) {
    const st = m.httpStatus(id);
    if (st === "pending") continue;
    pendingHttp.delete(id);
    if (st.startsWith("error:")) {
      wait.reject(new Error(st.slice("error:".length) || st));
      continue;
    }
    const raw = m.httpTake(id);
    if (!raw) {
      wait.reject(new Error("empty http result"));
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as HttpResult;
      wait.resolve({
        status: Number(parsed.status) || 0,
        body: String(parsed.body ?? ""),
        setCookie: String(parsed.setCookie ?? ""),
      });
    } catch (e) {
      wait.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

export function hostHttp(
  method: string,
  url: string,
  headers: Record<string, string>,
  body = "",
): Promise<HttpResult> {
  const m = getMangaHost();
  if (!m?.httpStart || !m.httpStatus || !m.httpTake) {
    return Promise.reject(new Error("manga.http 不可用（需新宿主）"));
  }
  const id = m.httpStart(method, url, JSON.stringify(headers), body);
  return new Promise<HttpResult>((resolve, reject) => {
    pendingHttp.set(id, { resolve, reject });
  });
}

export function readConfigFile(rel: string): string {
  return getMangaHost()?.readFile?.(rel) ?? "";
}

export function writeConfigFile(rel: string, text: string): boolean {
  return (getMangaHost()?.writeFile?.(rel, text) ?? 0) === 1;
}
