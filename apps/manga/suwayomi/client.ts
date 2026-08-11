/**
 * Suwayomi GraphQL client (P0).
 * Ported/trimmed from venera-sources/sorayomi.js — library path first;
 * source browse queries are stubbed until host net+image lands.
 */

export type SuwayomiConfig = {
  baseUrl: string;
  /** raw Cookie header value, if any */
  cookie?: string;
};

export type MangaListItem = {
  id: number;
  title: string;
  thumbnailUrl: string;
  sourceId?: string;
  sourceName?: string;
  unreadCount?: number;
  inLibrary?: boolean;
};

export type ChapterItem = {
  id: number;
  name: string;
  sourceOrder: number;
  chapterNumber?: number;
  isRead: boolean;
  lastPageRead: number;
  pageCount: number;
};

export type SourceItem = {
  id: string;
  name: string;
  lang: string;
  isNsfw?: boolean;
};

const VALIDATE = `query VALIDATE_LOGIN { categories(first: 1) { totalCount } }`;

const CATEGORIES = `
query GET_CATEGORIES($first: Int!, $offset: Int!) {
  categories(first: $first, offset: $offset, order: [{ by: ORDER, byType: ASC }]) {
    nodes { id name default order mangas { totalCount } }
    totalCount
  }
}`;

const CATEGORY_MANGAS = `
query GET_CATEGORY_MANGAS($first: Int!, $offset: Int!, $categoryIds: [Int!]) {
  mangas(
    condition: { inLibrary: true, categoryIds: $categoryIds }
    first: $first
    offset: $offset
    order: [{ by: TITLE, byType: ASC }]
  ) {
    nodes {
      id title thumbnailUrl inLibrary sourceId unreadCount
      source { id displayName }
    }
    totalCount
  }
}`;

const MANGA_INFO = `
query GET_MANGA_INFO($id: Int!, $chapterFirst: Int!, $chapterOffset: Int!) {
  manga(id: $id) {
    id title thumbnailUrl author artist description genre status realUrl sourceId
    source { id displayName }
    firstUnreadChapter { id sourceOrder }
  }
  chapters(
    condition: { mangaId: $id }
    first: $chapterFirst
    offset: $chapterOffset
    order: [{ by: SOURCE_ORDER, byType: DESC }]
  ) {
    nodes {
      id name mangaId sourceOrder chapterNumber isRead lastPageRead pageCount
      scanlator isDownloaded
    }
    totalCount
  }
}`;

const FETCH_CHAPTERS = `
mutation GET_MANGA_CHAPTERS_FETCH($input: FetchChaptersInput!) {
  fetchChapters(input: $input) {
    chapters {
      id name mangaId sourceOrder chapterNumber isRead lastPageRead pageCount
    }
  }
}`;

const FETCH_PAGES = `
mutation GET_CHAPTER_PAGES_FETCH($input: FetchChapterPagesInput!) {
  fetchChapterPages(input: $input) {
    chapter { id pageCount }
    pages
  }
}`;

const UPDATE_CHAPTER = `
mutation UPDATE_CHAPTER_PROGRESS($input: UpdateChapterInput!) {
  updateChapter(input: $input) {
    chapter { id isRead lastPageRead }
  }
}`;

/** Installed sources only — no extension install/remove in P0. */
const SOURCES = `
query GET_SOURCES($first: Int!, $offset: Int!) {
  sources(
    first: $first
    offset: $offset
    order: [{ by: NAME, byType: ASC }]
  ) {
    nodes {
      id
      name
      lang
      iconUrl
      supportsLatest
      isNsfw
    }
    totalCount
    pageInfo { hasNextPage }
  }
}`;

/** Browse one installed source: POPULAR | LATEST | SEARCH */
const FETCH_SOURCE_MANGA = `
mutation FETCH_SOURCE_MANGA($input: FetchSourceMangaInput!) {
  fetchSourceManga(input: $input) {
    mangas {
      id
      title
      thumbnailUrl
      inLibrary
      sourceId
      author
      artist
      description
      status
    }
    hasNextPage
  }
}`;

const UPDATE_MANGA_LIBRARY = `
mutation UPDATE_MANGA_LIBRARY($input: UpdateMangaInput!) {
  updateManga(input: $input) {
    manga { id inLibrary }
  }
}`;

function absUrl(base: string, url: string): string {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  const b = base.replace(/\/$/, "");
  return `${b}${url.startsWith("/") ? url : `/${url}`}`;
}

export type HttpPost = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<{ status: number; body: string; setCookie?: string | string[] }>;

/**
 * Minimal client. `httpPost` must be provided by the host bridge once net
 * lands; until then unit tests / desktop can inject a stub.
 */
export class SuwayomiClient {
  constructor(
    private config: SuwayomiConfig,
    private httpPost: HttpPost,
  ) {}

  get baseUrl() {
    return this.config.baseUrl.replace(/\/$/, "");
  }

  get graphQlUrl() {
    return `${this.baseUrl}/api/graphql`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
    };
    if (this.config.cookie) {
      h.Cookie = this.config.cookie;
    }
    return h;
  }

  async graphql<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const res = await this.httpPost(
      this.graphQlUrl,
      this.headers(),
      JSON.stringify({ query, variables: variables ?? {} }),
    );
    if (res.setCookie) this.mergeCookies(res.setCookie);
    if (res.status === 401) {
      throw new Error("Unauthorized");
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status}`);
    }
    const json = JSON.parse(res.body) as {
      data?: T;
      errors?: { message?: string }[];
    };
    if (json.errors?.length) {
      throw new Error(json.errors[0]?.message || "GraphQL error");
    }
    if (!json.data) throw new Error("Empty GraphQL data");
    return json.data;
  }

  setCookie(cookie: string | undefined) {
    this.config.cookie = cookie;
  }

  get cookie() {
    return this.config.cookie;
  }

  /**
   * Form login against `/login.html` (Suwayomi / Tachidesk style).
   * Merges any Set-Cookie into `config.cookie` and validates with GraphQL.
   */
  async login(user: string, pass: string): Promise<void> {
    const loginUrl = `${this.baseUrl}/login.html`;
    // Warm-up GET (may set initial session cookie).
    try {
      const warm = await this.httpPost(
        loginUrl,
        { Referer: this.baseUrl, ...(this.config.cookie ? { Cookie: this.config.cookie } : {}) },
        "",
      );
      if (warm.setCookie?.length) {
        this.mergeCookies(warm.setCookie);
      }
    } catch {
      // continue — some setups skip the warm GET
    }

    const body = `user=${encodeURIComponent(user)}&pass=${encodeURIComponent(pass)}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      Referer: loginUrl,
    };
    if (this.config.cookie) headers.Cookie = this.config.cookie;

    const res = await this.httpPost(
      `${loginUrl}?redirect=${encodeURIComponent("/")}`,
      headers,
      body,
    );
    if (res.setCookie) this.mergeCookies(res.setCookie);
    if (/Invalid username or password/i.test(res.body)) {
      throw new Error("用户名或密码错误");
    }
    // Still looking at a login form usually means auth failed or cookie lost.
    if (/name=["']user["']/i.test(res.body) && /name=["']pass["']/i.test(res.body)) {
      throw new Error("登录未生效（仍返回登录页，检查账号或 Cookie）");
    }
    if (!this.config.cookie) {
      throw new Error("登录未返回 Cookie（host 需跟随重定向收集 Set-Cookie）");
    }
    const ok = await this.validateLogin();
    if (!ok) throw new Error("登录后 GraphQL 校验失败（会话无效）");
  }

  private mergeCookies(setCookie: string[] | string) {
    const incoming = Array.isArray(setCookie) ? setCookie : [setCookie];
    const map = new Map<string, string>();
    const absorb = (header: string) => {
      for (const part of header.split(";")) {
        const nv = part.trim();
        if (!nv || !nv.includes("=")) continue;
        // Only keep name=value tokens (skip Path=/ etc. already stripped by host,
        // but be defensive).
        if (/^(Path|Domain|Expires|Max-Age|Secure|HttpOnly|SameSite)=/i.test(nv)) continue;
        const eq = nv.indexOf("=");
        const name = nv.slice(0, eq).trim();
        const value = nv.slice(eq + 1).trim();
        if (name) map.set(name, value);
      }
    };
    if (this.config.cookie) absorb(this.config.cookie);
    for (const c of incoming) absorb(c);
    this.config.cookie = [...map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async validateLogin(): Promise<boolean> {
    try {
      const data = await this.graphql<{ categories: unknown }>(VALIDATE);
      return !!data.categories;
    } catch {
      return false;
    }
  }

  async listCategories() {
    const data = await this.graphql<{
      categories: {
        nodes: {
          id: number;
          name: string;
          order: number;
          default?: boolean;
          mangas?: { totalCount: number };
        }[];
      };
    }>(CATEGORIES, { first: 200, offset: 0 });
    return data.categories.nodes ?? [];
  }

  /** Library mangas without category filter (all in-library). */
  async listAllLibraryMangas(first = 50, offset = 0) {
    const data = await this.graphql<{
      mangas: { nodes: Record<string, unknown>[]; totalCount: number };
    }>(
      `query GET_ALL_LIBRARY($first: Int!, $offset: Int!) {
        mangas(
          condition: { inLibrary: true }
          first: $first
          offset: $offset
          order: [{ by: TITLE, byType: ASC }]
        ) {
          nodes {
            id title thumbnailUrl inLibrary sourceId unreadCount
            source { id displayName }
          }
          totalCount
        }
      }`,
      { first, offset },
    );
    return {
      totalCount: data.mangas.totalCount,
      items: (data.mangas.nodes ?? []).map((n) => this.mapManga(n)),
    };
  }

  async listLibraryMangas(categoryId: number, first = 50, offset = 0) {
    const data = await this.graphql<{
      mangas: { nodes: Record<string, unknown>[]; totalCount: number };
    }>(CATEGORY_MANGAS, {
      first,
      offset,
      categoryIds: [categoryId],
    });
    return {
      totalCount: data.mangas.totalCount,
      items: (data.mangas.nodes ?? []).map((n) => this.mapManga(n)),
    };
  }

  async getManga(id: number) {
    const data = await this.graphql<{
      manga: Record<string, unknown> | null;
      chapters: { nodes: Record<string, unknown>[]; totalCount: number };
    }>(MANGA_INFO, { id, chapterFirst: 1000, chapterOffset: 0 });
    return data;
  }

  async fetchChapters(mangaId: number) {
    const data = await this.graphql<{
      fetchChapters: { chapters: Record<string, unknown>[] };
    }>(FETCH_CHAPTERS, { input: { mangaId } });
    return data.fetchChapters.chapters ?? [];
  }

  async fetchChapterPages(chapterId: number): Promise<string[]> {
    const data = await this.graphql<{
      fetchChapterPages: { pages: string[]; chapter: { pageCount: number } };
    }>(FETCH_PAGES, { input: { chapterId } });
    return (data.fetchChapterPages.pages ?? []).map((u) => absUrl(this.baseUrl, u));
  }

  async updateProgress(chapterId: number, lastPageRead: number, isRead?: boolean) {
    const patch: Record<string, unknown> = { lastPageRead };
    if (isRead != null) patch.isRead = isRead;
    await this.graphql(UPDATE_CHAPTER, {
      input: { id: chapterId, patch },
    });
  }

  /** Installed sources only (server-side installed extensions). */
  async listSources(first = 100, offset = 0) {
    const data = await this.graphql<{
      sources: {
        nodes: SourceItem[];
        totalCount: number;
        pageInfo?: { hasNextPage?: boolean };
      };
    }>(SOURCES, { first, offset });
    return data.sources;
  }

  /**
   * Browse one source. `type`: POPULAR | LATEST | SEARCH.
   * LATEST requires source.supportsLatest.
   */
  async fetchSourceManga(opts: {
    sourceId: number | string;
    type: "POPULAR" | "LATEST" | "SEARCH";
    page: number;
    query?: string;
  }) {
    const data = await this.graphql<{
      fetchSourceManga: {
        mangas: Record<string, unknown>[];
        hasNextPage: boolean;
      };
    }>(FETCH_SOURCE_MANGA, {
      // Suwayomi source ids are Longs serialized as strings — must stay strings
      // in GraphQL variables (Number would overflow / type-reject as Long).
      input: {
        source: String(opts.sourceId),
        type: opts.type,
        page: opts.page,
        query: opts.query ?? null,
      },
    });
    return {
      hasNextPage: !!data.fetchSourceManga.hasNextPage,
      items: (data.fetchSourceManga.mangas ?? []).map((n) => this.mapManga(n)),
    };
  }

  async setInLibrary(mangaId: number, inLibrary: boolean) {
    const data = await this.graphql<{
      updateManga: { manga: { id: number; inLibrary: boolean } };
    }>(UPDATE_MANGA_LIBRARY, {
      input: { id: mangaId, patch: { inLibrary } },
    });
    return data.updateManga.manga;
  }

  private mapManga(node: Record<string, unknown>): MangaListItem {
    const source = node.source as { id?: string; displayName?: string } | undefined;
    return {
      id: Number(node.id),
      title: String(node.title ?? ""),
      thumbnailUrl: absUrl(this.baseUrl, String(node.thumbnailUrl ?? "")),
      sourceId: node.sourceId != null ? String(node.sourceId) : source?.id,
      sourceName: source?.displayName,
      unreadCount: node.unreadCount != null ? Number(node.unreadCount) : undefined,
      inLibrary: node.inLibrary != null ? !!node.inLibrary : undefined,
    };
  }
}

/** Queries/mutations exported for docs & probes. */
export const P0_OPERATIONS = {
  VALIDATE,
  CATEGORIES,
  CATEGORY_MANGAS,
  MANGA_INFO,
  FETCH_CHAPTERS,
  FETCH_PAGES,
  UPDATE_CHAPTER,
  SOURCES,
  FETCH_SOURCE_MANGA,
  UPDATE_MANGA_LIBRARY,
} as const;
