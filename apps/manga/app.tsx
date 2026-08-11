import { createSignal, For, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { touches } from "@pocketjs/framework/input";
import {
  clearPage,
  getMangaHost,
  hostHttp,
  jobStatus,
  loadPage,
  pollHttpJobs,
  prefetchPage,
  readConfigFile,
  requestExit,
  setProgressOverlay,
  writeConfigFile,
} from "./host.ts";
import {
  SuwayomiClient,
  type ChapterItem,
  type MangaListItem,
  type SourceItem,
} from "./suwayomi/client.ts";

/**
 * Manga app (Kindle 309×412) — Suwayomi bookshelf + reader.
 * Credentials: /mnt/us/pocketjs-dev/manga-config.json
 *   { "baseUrl","user","pass","cookie"? }
 */

type Screen = "boot" | "login" | "shelf" | "detail" | "reader" | "settings" | "browse";

type Config = {
  baseUrl: string;
  user: string;
  pass: string;
  cookie?: string;
  /** When true, tap left = next page (manga-style). Default true. */
  tapLeftIsNext?: boolean;
};

const CONFIG_PATH = "manga-config.json";
const DEFAULT_BASE = "https://comic.anzhi.app";

// Layout bands (logical px) — UI and hitTest share these.
const W = 309;
const H = 412;
const HEADER_H = 40;
const SUB_H = 40;
const BOTTOM_H = 48;
const LIST_TOP = HEADER_H + SUB_H; // 80
const LIST_BOT = H - BOTTOM_H; // 364
const ITEM_H = 40;
const COL = Math.floor(W / 3); // 103

function makeClient(cfg: Config): SuwayomiClient {
  return new SuwayomiClient(
    { baseUrl: cfg.baseUrl || DEFAULT_BASE, cookie: cfg.cookie },
    async (url, headers, body) => {
      const method = body ? "POST" : "GET";
      const res = await hostHttp(method, url, headers, body);
      return {
        status: res.status,
        body: res.body,
        setCookie: res.setCookie || undefined,
      };
    },
  );
}

export default function MangaApp() {
  const [screen, setScreen] = createSignal<Screen>("boot");
  const [status, setStatus] = createSignal("启动中…");
  const [cfg, setCfg] = createSignal<Config>({
    baseUrl: DEFAULT_BASE,
    user: "",
    pass: "",
  });
  const [client, setClient] = createSignal<SuwayomiClient | null>(null);

  const [categories, setCategories] = createSignal<
    { id: number; name: string; total?: number; isDefault?: boolean }[]
  >([]);
  const [catIndex, setCatIndex] = createSignal(0);
  const [mangas, setMangas] = createSignal<MangaListItem[]>([]);
  const [mangaIndex, setMangaIndex] = createSignal(0);

  const [detailTitle, setDetailTitle] = createSignal("");
  const [chapters, setChapters] = createSignal<ChapterItem[]>([]);
  const [chapterIndex, setChapterIndex] = createSignal(0);
  const [currentMangaId, setCurrentMangaId] = createSignal(0);

  const [pages, setPages] = createSignal<string[]>([]);
  const [pageIndex, setPageIndex] = createSignal(0);
  const [pageJob, setPageJob] = createSignal<number | null>(null);
  const [chapterId, setChapterId] = createSignal(0);

  const [press, setPress] = createSignal<{ id: string; since: number } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [bootDone, setBootDone] = createSignal(false);
  const [sources, setSources] = createSignal<SourceItem[]>([]);
  const [browsePage, setBrowsePage] = createSignal(0);

  // Reader chrome visibility
  const [chromeVisible, setChromeVisible] = createSignal(false);
  // Tap left side is "next" (true = right is next, false = left is next)
  const [tapLeftIsNext, setTapLeftIsNext] = createSignal(true);
  // Bottom bar exit armed
  const [exitArmed, setExitArmed] = createSignal(false);
  const [exitArmedAt, setExitArmedAt] = createSignal(0);

  // ---- boot: load config + try session ----
  onFrame(() => {
    if (bootDone()) return;
    setBootDone(true);
    void (async () => {
      if (!getMangaHost()?.httpStart) {
        setStatus("需要新宿主（manga.http）— 请部署最新 pocketjs-kindle");
        setScreen("settings");
        return;
      }
      let raw = readConfigFile(CONFIG_PATH);
      let c: Config = { baseUrl: DEFAULT_BASE, user: "", pass: "" };
      if (raw) {
        try {
          c = { ...c, ...(JSON.parse(raw) as Config) };
        } catch {
          setStatus("manga-config.json 解析失败");
        }
      }
      setCfg(c);
      if (typeof c.tapLeftIsNext === "boolean") setTapLeftIsNext(c.tapLeftIsNext);
      const cl = makeClient(c);
      setClient(cl);
      setStatus("检查登录…");
      try {
        if (c.cookie && (await cl.validateLogin())) {
          setStatus("已登录");
          await loadShelf(cl);
          return;
        }
        if (c.user && c.pass) {
          setStatus("登录中…");
          await cl.login(c.user, c.pass);
          persist(cl, c);
          setStatus("登录成功");
          await loadShelf(cl);
          return;
        }
        setScreen("login");
        setStatus(
          raw
            ? "config 缺 user/pass，请补全后点重试"
            : "无 manga-config.json，请写入后点重试",
        );
      } catch (e) {
        // Keep the real error — do not overwrite with a generic hint.
        setScreen("login");
        setStatus(`失败: ${errMsg(e)}`);
      }
    })();
  });

  function persist(cl: SuwayomiClient, c: Config) {
    const next = { ...c, cookie: cl.cookie };
    setCfg(next);
    writeConfigFile(CONFIG_PATH, JSON.stringify(next));
  }



  async function loadShelf(cl: SuwayomiClient) {
    setBusy(true);
    setStatus("加载书架…");
    try {
      const cats = await cl.listCategories();
      const mapped = cats.map((x) => ({
        id: Number(x.id),
        name: String(x.name),
        total: x.mangas?.totalCount,
        isDefault: !!(x as { default?: boolean }).default,
      }));
      setCategories(mapped);
      if (!mapped.length) {
        // No categories — fall back to whole library.
        const { items, totalCount } = await cl.listAllLibraryMangas(80, 0);
        setMangas(items);
        setMangaIndex(0);
        setStatus(items.length ? `全部 ${totalCount}部` : "书架为空");
        setScreen("shelf");
        return;
      }
      // Prefer default non-empty, else first non-empty, else index 0.
      // (Suwayomi often has an empty id=0 category first by ORDER.)
      let idx = mapped.findIndex((c) => c.isDefault && (c.total ?? 0) > 0);
      if (idx < 0) idx = mapped.findIndex((c) => (c.total ?? 0) > 0);
      if (idx < 0) idx = 0;
      setCatIndex(idx);
      const pick = mapped[idx];
      await loadCategory(cl, pick.id);
      setScreen("shelf");
    } catch (e) {
      setStatus(`书架失败: ${errMsg(e)}`);
      setScreen("login");
    } finally {
      setBusy(false);
    }
  }

  async function loadCategory(cl: SuwayomiClient, categoryId: number) {
    let { items, totalCount } = await cl.listLibraryMangas(categoryId, 80, 0);
    // Empty category result with known total>0 is unexpected; try unfiltered once.
    const catMeta = categories().find((c) => c.id === categoryId);
    if (!items.length && (catMeta?.total ?? 0) > 0) {
      const all = await cl.listAllLibraryMangas(80, 0);
      items = all.items;
      totalCount = all.totalCount;
    }
    setMangas(items);
    setMangaIndex(0);
    setStatus(`${items.length}/${totalCount}部`);
  }

  async function openManga(item: MangaListItem) {
    const cl = client();
    if (!cl || busy()) return;
    setBusy(true);
    setStatus(`打开 ${item.title}…`);
    try {
      setCurrentMangaId(item.id);
      setDetailTitle(item.title);
      let data = await cl.getManga(item.id);
      let nodes = data.chapters?.nodes ?? [];
      if (!nodes.length) {
        setStatus("拉取章节目录…");
        await cl.fetchChapters(item.id);
        data = await cl.getManga(item.id);
        nodes = data.chapters?.nodes ?? [];
      }
      const list: ChapterItem[] = nodes.map((n) => ({
        id: Number(n.id),
        name: String(n.name ?? ""),
        sourceOrder: Number(n.sourceOrder ?? 0),
        chapterNumber: n.chapterNumber != null ? Number(n.chapterNumber) : undefined,
        isRead: !!n.isRead,
        lastPageRead: Number(n.lastPageRead ?? 0),
        pageCount: Number(n.pageCount ?? 0),
      }));
      // API returns DESC sourceOrder; keep as-is for newest-first list.
      setChapters(list);
      setChapterIndex(0);
      setScreen("detail");
      setStatus(`${list.length}话`);
    } catch (e) {
      setStatus(`详情失败: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function loadSources() {
    const cl = client();
    if (!cl || busy()) return;
    setBusy(true);
    setStatus("加载已装源…");
    try {
      const res = await cl.listSources(80, 0);
      const nodes = res.nodes ?? [];
      setSources(nodes);
      setBrowsePage(0);
      setScreen("browse");
      setStatus(`${nodes.length}源`);
    } catch (e) {
      setStatus(`源列表失败: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function openSourceAt(index: number) {
    const cl = client();
    const source = sources()[index];
    if (!cl || !source || busy()) return;
    setBusy(true);
    setStatus(`热门 ${source.name}…`);
    try {
      const res = await cl.fetchSourceManga({
        sourceId: source.id,
        type: "POPULAR",
        page: 1,
      });
      const items = res.items ?? [];
      setMangas(items);
      setMangaIndex(0);
      // Reuse shelf list UI for browse results (cat switcher still works as no-op label).
      setCategories([
        {
          id: -1,
          name: `源:${source.name}`.slice(0, 24),
          total: items.length,
        },
      ]);
      setCatIndex(0);
      setScreen("shelf");
      setStatus(items.length ? `源热门 ${items.length}部` : "该源热门为空/失败");
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // Common Suwayomi extension failures — keep status actionable.
      if (/flaresolverr|cloudflare|cf_clearance|403/i.test(raw)) {
        setStatus(`${source.name}: 源站防护(CF)，换源`);
      } else if (/Exception while fetching|IOException/i.test(raw)) {
        setStatus(`${source.name}: 源拉取失败，换源`);
      } else {
        setStatus(`源加载失败: ${errMsg(e)}`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function openChapter(ch: ChapterItem, startPage?: number) {
    const cl = client();
    if (!cl || busy()) return;
    setBusy(true);
    setStatus(`加载 ${ch.name}…`);
    try {
      const urls = await cl.fetchChapterPages(ch.id);
      if (!urls.length) throw new Error("无页面");
      setPages(urls);
      setChapterId(ch.id);
      const p = Math.max(0, Math.min(urls.length - 1, startPage ?? ch.lastPageRead ?? 0));
      setPageIndex(p);
      setChromeVisible(false);
      setScreen("reader");
      showPageAt(p, urls, cl.cookie);
    } catch (e) {
      setStatus(`章节失败: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  function showPageAt(index: number, urls = pages(), cookie = client()?.cookie) {
    const url = urls[index];
    if (!url) return;
    const total = urls.length;
    // Black digits burned into page pixels (floats on art, no reserved bar).
    setProgressOverlay(`${index + 1}/${total || "?"}`);
    setStatus(`加载 ${index + 1}/${total}…`);
    const j = loadPage(url, cookie);
    if (j == null) {
      setStatus("loadPage 不可用");
      return;
    }
    setPageJob(j);
    // Prefetch NEXT page now (serial decode). Starts while you still read current.
    if (index + 1 < total) prefetchPage(urls[index + 1], cookie);
  }

  async function turnPage(delta: number) {
    if (busy()) return;
    const urls = pages();
    if (!urls.length) return;
    let next = pageIndex() + delta;
    if (next >= 0 && next < urls.length) {
      setPageIndex(next);
      showPageAt(next);
      const cl = client();
      const cid = chapterId();
      if (cl && cid) {
        void cl
          .updateProgress(cid, next, next >= urls.length - 1)
          .catch((e) => setStatus(`进度同步失败: ${errMsg(e)}`));
      }
      return;
    }
    if (next >= urls.length) {
      const list = chapters();
      const idx = list.findIndex((c) => c.id === chapterId());
      const ni = idx + 1;
      if (ni >= 0 && ni < list.length) {
        setStatus(`章末 → 下一话「${list[ni].name}」`);
        setChapterIndex(ni);
        await openChapter(list[ni], 0);
      } else {
        setStatus("已经是本书最后一话");
      }
      return;
    }
    if (next < 0) {
      const list = chapters();
      const idx = list.findIndex((c) => c.id === chapterId());
      const pi = idx - 1;
      if (pi >= 0) {
        setStatus(`← 上一话「${list[pi].name}」`);
        setChapterIndex(pi);
        const ch = list[pi];
        await openChapter(ch, Math.max(0, (ch.pageCount || 1) - 1));
      } else {
        setStatus("已经是第一话");
      }
    }
  }

  // frame: http poll + page job + input
  onFrame(() => {
    pollHttpJobs();

    const pj = pageJob();
    if (pj != null) {
      const st = jobStatus(pj);
      if (st !== "pending") {
        setPageJob(null);
        if (st === "ready") {
          setProgressOverlay(`${pageIndex() + 1}/${pages().length || "?"}`);
          setStatus(`${pageIndex() + 1}/${pages().length}`);
        } else if (st.startsWith("error:")) {
          setStatus(`页加载失败: ${st.slice(6)}`);
        } else {
          setStatus(st);
        }
      }
    }

    const t = touches()[0];
    const now = Date.now();
    if (!t) {
      const p = press();
      if (p && now - p.since < 900) handleTap(p.id);
      setPress(null);
      return;
    }
    const id = hitTest(t.x, t.y, screen(), {
      chrome: chromeVisible(),
      leftIsNext: tapLeftIsNext(),
    });
    if (!id) {
      setPress(null);
      return;
    }
    const p = press();
    if (!p || p.id !== id) setPress({ id, since: now });
  });

  function handleTap(id: string) {
    if (busy() && id !== "exit") return;
    if (id === "exit") {
      const now = Date.now();
      if (!exitArmed() || now - exitArmedAt() > 2500) {
        setExitArmed(true);
        setExitArmedAt(now);
        setStatus("再点一次右下角「退出」确认离开");
        return;
      }
      setStatus("正在退出…");
      requestExit();
      return;
    }
    // Any other tap cancels exit arming.
    if (exitArmed()) setExitArmed(false);
    if (id === "nav-shelf") {
      clearPage();
      const cl = client();
      if (cl) {
        void loadShelf(cl);
      } else {
        setScreen("shelf");
      }
      return;
    }
    if (id === "nav-sources") {
      clearPage();
      void loadSources();
      return;
    }
    if (id === "nav-settings") {
      clearPage();
      setScreen("settings");
      return;
    }
    if (id === "retry-login") {
      void (async () => {
        const c = cfg();
        const cl = makeClient(c);
        setClient(cl);
        setBusy(true);
        setStatus("登录中…");
        try {
          if (!c.user || !c.pass) throw new Error("config 缺 user/pass");
          await cl.login(c.user, c.pass);
          persist(cl, c);
          await loadShelf(cl);
        } catch (e) {
          setStatus(`登录失败: ${errMsg(e)}`);
          setScreen("login");
        } finally {
          setBusy(false);
        }
      })();
      return;
    }
    if (id === "reload-config") {
      setBootDone(false);
      setScreen("boot");
      setStatus("重读配置…");
      return;
    }
    if (id === "open-browse") {
      void loadSources();
      return;
    }
    if (id === "src-up") {
      setBrowsePage((i) => Math.max(0, i - 1));
      return;
    }
    if (id === "src-down") {
      setBrowsePage((i) => Math.min(sources().length - 1, i + 1));
      return;
    }
    if (id === "src-open") {
      void openSourceAt(browsePage());
      return;
    }
    if (id === "cat-prev") {
      const cats = categories();
      if (!cats.length) return;
      const i = (catIndex() - 1 + cats.length) % cats.length;
      setCatIndex(i);
      const cl = client();
      if (cl) void loadCategory(cl, cats[i].id).catch((e) => setStatus(errMsg(e)));
      return;
    }
    if (id === "cat-next") {
      const cats = categories();
      if (!cats.length) return;
      const i = (catIndex() + 1) % cats.length;
      setCatIndex(i);
      const cl = client();
      if (cl) void loadCategory(cl, cats[i].id).catch((e) => setStatus(errMsg(e)));
      return;
    }
    if (id === "manga-up") {
      setMangaIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (id === "manga-down") {
      setMangaIndex((i) => Math.min(mangas().length - 1, i + 1));
      return;
    }
    if (id === "manga-open") {
      const item = mangas()[mangaIndex()];
      if (item) void openManga(item);
      return;
    }
    if (id === "ch-up") {
      setChapterIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (id === "ch-down") {
      setChapterIndex((i) => Math.min(chapters().length - 1, i + 1));
      return;
    }
    if (id === "ch-open") {
      const ch = chapters()[chapterIndex()];
      if (ch) void openChapter(ch);
      return;
    }
    if (id === "detail-back") {
      setScreen("shelf");
      return;
    }
    if (id === "reader-show-chrome") {
      setChromeVisible(true);
      return;
    }
    if (id === "reader-hide-chrome") {
      setChromeVisible(false);
      // Re-blit current page so chrome damage clear does not leave a black bar.
      showPageAt(pageIndex());
      return;
    }
    if (id === "reader-prev") {
      setChromeVisible(false);
      void turnPage(-1);
      return;
    }
    if (id === "reader-next") {
      setChromeVisible(false);
      void turnPage(1);
      return;
    }
    if (id === "reader-back") {
      setChromeVisible(false);
      clearPage();
      setScreen("detail");
      return;
    }
    if (id === "reader-toggle-direction") {
      const next = !tapLeftIsNext();
      setTapLeftIsNext(next);
      // Persist into config
      const c = cfg();
      const saved = { ...c, tapLeftIsNext: next };
      setCfg(saved);
      writeConfigFile(CONFIG_PATH, JSON.stringify(saved));
      return;
    }
  }

  const cat = () => categories()[catIndex()];
  const manga = () => mangas()[mangaIndex()];
  const chapter = () => chapters()[chapterIndex()];

  // Visible window of list items around selection
  function windowed<T>(list: T[], index: number, span = 5): { item: T; i: number }[] {
    if (!list.length) return [];
    const half = Math.floor(span / 2);
    let start = Math.max(0, index - half);
    let end = Math.min(list.length, start + span);
    start = Math.max(0, end - span);
    const out: { item: T; i: number }[] = [];
    for (let i = start; i < end; i++) out.push({ item: list[i], i });
    return out;
  }

  return (
    <View
      debugName="MangaApp"
      class="relative w-full h-full flex-col"
      // Reader must NOT keep shelf bgColor — uncleared #f2efe6 was being
      // mis-detected as a bottom "menu" band and painted over the page.
      style={
        screen() === "reader"
          ? { bgColor: "#00000000" }
          : { bgColor: "#f2efe6" }
      }
    >
      <Show when={screen() !== "reader"}>
        <View
          class="flex-row items-center justify-between px-3"
          style={{ height: HEADER_H, bgColor: "#e8e4da" }}
        >
          <Text class="text-sm font-bold" style={{ textColor: "#111" }}>
            漫画
          </Text>
          <Text class="text-xs" style={{ textColor: "#555" }}>
            {status()}
          </Text>
        </View>
      </Show>

      <Show when={screen() === "boot" || screen() === "login"}>
        <View class="flex-1 px-3 pt-3 flex-col gap-2">
          <Text class="text-sm font-bold" style={{ textColor: "#222" }}>
            登录
          </Text>
          <Text class="text-xs" style={{ textColor: "#666" }}>
            服务器 {cfg().baseUrl.replace(/^https?:\/\//, "")}
          </Text>
          <Text class="text-xs" style={{ textColor: "#666" }}>
            账号 {cfg().user || "（未配置）"} · 配置 manga-config.json
          </Text>
          <View
            class="items-center justify-center border-[2]"
            style={{ bgColor: "#ddd6c8", borderColor: "#333", height: 52 }}
          >
            <Text class="text-sm font-bold" style={{ textColor: "#111" }}>
              重试登录
            </Text>
          </View>
          <View
            class="items-center justify-center border-[1]"
            style={{ bgColor: "#ebe7dd", borderColor: "#999", height: 44 }}
          >
            <Text class="text-xs font-bold" style={{ textColor: "#333" }}>
              重读配置
            </Text>
          </View>
          <Text class="text-xs" style={{ textColor: "#888" }}>
            若提示网络不可用：Kindle 需连 Wi-Fi（仅 USB 网不够）
          </Text>
        </View>
      </Show>

      <Show when={screen() === "shelf"}>
        <View class="flex-1 flex-col" style={{ bgColor: "#f4f1ea" }}>
          {/* Category switcher: two equal absolute halves */}
          <View class="relative w-full" style={{ height: SUB_H, bgColor: "#d9d3c6" }}>
            <View
              class="absolute items-center justify-center"
              style={{
                insetL: 0,
                insetT: 0,
                width: Math.floor(W / 2),
                height: SUB_H,
                bgColor: "#d0cbbd",
              }}
            >
              <Text class="text-xs font-bold" style={{ textColor: "#222", paddingT: 12 }}>
                ← 上分类
              </Text>
            </View>
            <View
              class="absolute items-center justify-center"
              style={{
                insetL: Math.floor(W / 2),
                insetT: 0,
                width: Math.ceil(W / 2),
                height: SUB_H,
                bgColor: "#cfc8b8",
              }}
            >
              <Text class="text-xs font-bold" style={{ textColor: "#222", paddingT: 12 }}>
                下分类 →
              </Text>
            </View>
          </View>
          <View class="px-3 justify-center" style={{ height: 28, bgColor: "#efeae0" }}>
            <Text class="text-xs font-bold" style={{ textColor: "#333" }}>
              {cat()?.name ?? "-"}
              {cat()?.total != null ? ` · ${cat()!.total}` : ""}
              {` · ${mangas().length}显示`}
            </Text>
          </View>
          <Show when={mangas().length === 0}>
            <View class="px-3 pt-4">
              <Text class="text-xs" style={{ textColor: "#666" }}>
                此分类无漫画，点「下分类」切换
              </Text>
            </View>
          </Show>
          <For each={windowed(mangas(), mangaIndex(), 6)}>
            {(row) => (
              <View
                class="px-3 justify-center"
                style={{
                  height: ITEM_H,
                  bgColor: row.i === mangaIndex() ? "#d8d0c0" : "#f4f1ea",
                }}
              >
                <Text class="text-xs" style={{ textColor: row.i === mangaIndex() ? "#000" : "#333" }}>
                  {row.i === mangaIndex() ? "> " : "  "}
                  {`#${row.item.id} `}
                  {row.item.title}
                  {row.item.unreadCount ? ` (${row.item.unreadCount})` : ""}
                </Text>
              </View>
            )}
          </For>
        </View>
      </Show>

      <Show when={screen() === "detail"}>
        <View class="flex-1 px-2 pt-2 flex-col gap-1">
          <Text class="text-sm font-bold px-1" style={{ textColor: "#222" }}>
            {detailTitle()}
          </Text>
          <For each={windowed(chapters(), chapterIndex(), 7)}>
            {(row) => (
              <View
                class="px-2 py-1 border-[1]"
                style={{
                  bgColor: row.i === chapterIndex() ? "#d4cfc3" : "#ebe7dd",
                  borderColor: row.i === chapterIndex() ? "#333" : "#b8b2a7",
                }}
              >
                <Text class="text-xs" style={{ textColor: row.item.isRead ? "#888" : "#222" }}>
                  {row.i === chapterIndex() ? "› " : "  "}
                  {row.item.name}
                </Text>
              </View>
            )}
          </For>
        </View>
      </Show>

      <Show when={screen() === "reader"}>
        {/*
          Default: full-bleed page underlay, no chrome.
          - left/right thirds: turn page (direction from tapLeftIsNext)
          - center: toggle chrome menu
          Tiny progress always bottom-left; loading pill when pageJob pending.
        */}
        <View class="relative w-full h-full">
          {/*
            Progress is host-stamped black digits on the underlay (setProgress).
            No UI pill — manga fills edge-to-edge; digits float on the art.
          */}
          {/* Loading banner only while decoding (disappears on ready) */}
          <Show when={pageJob() != null}>
            <View
              class="absolute items-center justify-center"
              style={{
                insetL: Math.floor((W - 100) / 2),
                insetT: 12,
                width: 100,
                height: 24,
                bgColor: "#333333",
              }}
            >
              <Text class="text-xs font-bold" style={{ textColor: "#fff" }}>
                加载中…
              </Text>
            </View>
          </Show>

          {/* Chrome menu — only after center tap */}
          <Show when={chromeVisible()}>
            <View
              class="absolute"
              style={{
                insetL: 0,
                insetT: H - 52,
                width: W,
                height: 52,
                bgColor: "#e8e4da",
              }}
            >
              <View
                class="absolute items-center justify-center"
                style={{
                  insetL: 0,
                  insetT: 0,
                  width: COL,
                  height: 52,
                  bgColor: "#d9d3c6",
                }}
              >
                <Text class="text-xs font-bold" style={{ textColor: "#222", paddingT: 16 }}>
                  目录
                </Text>
              </View>
              <View
                class="absolute items-center justify-center"
                style={{
                  insetL: COL,
                  insetT: 0,
                  width: COL,
                  height: 52,
                  bgColor: "#cfc8b8",
                }}
              >
                <Text class="text-xs font-bold" style={{ textColor: "#222", paddingT: 16 }}>
                  {tapLeftIsNext() ? "左=下页" : "左=上页"}
                </Text>
              </View>
              <View
                class="absolute items-center justify-center"
                style={{
                  insetL: COL * 2,
                  insetT: 0,
                  width: W - COL * 2,
                  height: 52,
                  bgColor: "#d0cbbd",
                }}
              >
                <Text class="text-xs font-bold" style={{ textColor: "#222", paddingT: 16 }}>
                  收起
                </Text>
              </View>
            </View>
          </Show>
        </View>
      </Show>

      <Show when={screen() === "settings"}>
        <View class="flex-1 px-3 pt-3 flex-col gap-2">
          <Text class="text-sm font-bold" style={{ textColor: "#222" }}>
            设置
          </Text>
          <Text class="text-xs" style={{ textColor: "#666" }}>
            服务器 {cfg().baseUrl}
          </Text>
          <Text class="text-xs" style={{ textColor: "#666" }}>
            账号 {cfg().user || "（未配置）"}
          </Text>
          <Text class="text-xs" style={{ textColor: "#666" }}>
            host {getMangaHost() ? "ok" : "missing"} · cookie{" "}
            {cfg().cookie ? "有" : "无"}
          </Text>
          <View
            class="items-center justify-center border-[1]"
            style={{ bgColor: "#ddd8ce", borderColor: "#aaa", height: 44 }}
          >
            <Text class="text-xs font-bold" style={{ textColor: "#222" }}>
              已装源（或底栏「源」）
            </Text>
          </View>
          <View
            class="items-center justify-center border-[1]"
            style={{ bgColor: "#ebe7dd", borderColor: "#999", height: 44 }}
          >
            <Text class="text-xs font-bold" style={{ textColor: "#222" }}>
              重读配置并登录
            </Text>
          </View>
          <View
            class="items-center justify-center border-[1]"
            style={{ bgColor: "#d0b8b0", borderColor: "#833", height: 44 }}
          >
            <Text class="text-xs font-bold" style={{ textColor: "#5a1a1a" }}>
              退出（点两次）
            </Text>
          </View>
        </View>
      </Show>

      <Show when={screen() === "browse"}>
        <View class="flex-1 flex-col" style={{ bgColor: "#f4f1ea" }}>
          <View class="px-3 justify-center" style={{ height: 28, bgColor: "#efeae0" }}>
            <Text class="text-xs font-bold" style={{ textColor: "#333" }}>
              已装源 · {sources().length}
            </Text>
          </View>
          <Show when={sources().length === 0}>
            <View class="px-3 pt-4">
              <Text class="text-xs" style={{ textColor: "#666" }}>
                无已装源（或未加载）
              </Text>
            </View>
          </Show>
          <For each={windowed(sources(), browsePage(), 7)}>
            {(row) => (
              <View
                class="px-3 justify-center"
                style={{
                  height: ITEM_H,
                  bgColor: row.i === browsePage() ? "#d8d0c0" : "#f4f1ea",
                }}
              >
                <Text class="text-xs" style={{ textColor: row.i === browsePage() ? "#000" : "#333" }}>
                  {row.i === browsePage() ? "> " : "  "}
                  {`#${row.item.id} ${row.item.name} (${row.item.lang})`}
                </Text>
              </View>
            )}
          </For>
        </View>
      </Show>

      <Show when={screen() !== "reader"}>
        {/* Bottom: 书架 | 源 | 设置 — exit lives in settings (double-tap 退出) */}
        <View class="relative w-full" style={{ height: BOTTOM_H, bgColor: "#d8d2c4" }}>
          <View
            class="absolute items-center justify-center"
            style={{
              insetL: 0,
              insetT: 0,
              width: COL,
              height: BOTTOM_H,
              bgColor: screen() === "shelf" || screen() === "detail" ? "#c4bba8" : "#d8d2c4",
            }}
          >
            <Text class="text-xs font-bold" style={{ textColor: "#111", paddingT: 16 }}>
              书架
            </Text>
          </View>
          <View
            class="absolute items-center justify-center"
            style={{
              insetL: COL,
              insetT: 0,
              width: COL,
              height: BOTTOM_H,
              bgColor: screen() === "browse" ? "#c4bba8" : "#d8d2c4",
            }}
          >
            <Text class="text-xs font-bold" style={{ textColor: "#111", paddingT: 16 }}>
              源
            </Text>
          </View>
          <View
            class="absolute items-center justify-center"
            style={{
              insetL: COL * 2,
              insetT: 0,
              width: W - COL * 2,
              height: BOTTOM_H,
              bgColor: screen() === "settings" ? "#c4bba8" : "#d8d2c4",
            }}
          >
            <Text class="text-xs font-bold" style={{ textColor: "#111", paddingT: 16 }}>
              设置
            </Text>
          </View>
        </View>
      </Show>
    </View>
  );
}

function errMsg(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  // Kindle often loses Wi-Fi DNS while USBNetwork is up — keep status short.
  if (/Dns Failed|lookup address|Try again|Network is unreachable/i.test(s)) {
    return "网络不可用(DNS) — 请开 Wi-Fi 后点重试";
  }
  if (/Unauthorized|会话无效|登录未生效/i.test(s)) {
    return "登录失败 — 检查账号密码";
  }
  if (/loadPage|http 不可用/i.test(s)) {
    return "宿主能力不足 — 需更新 pocketjs-kindle";
  }
  // Truncate monster ureq messages for the 309px header.
  if (s.length > 36) return s.slice(0, 34) + "…";
  return s;
}

function hitTest(
  x: number,
  y: number,
  screen: Screen,
  opts?: { chrome?: boolean; leftIsNext?: boolean },
): string | null {
  if (screen === "reader") {
    const chrome = !!opts?.chrome;
    const leftIsNext = opts?.leftIsNext !== false; // default true
    // Chrome menu bar hit zones (bottom)
    if (chrome && y >= H - 52) {
      if (x < COL) return "reader-back";
      if (x < COL * 2) return "reader-toggle-direction";
      return "reader-hide-chrome";
    }
    // Center third → show/hide chrome
    if (x >= W / 3 && x < (W * 2) / 3) {
      return chrome ? "reader-hide-chrome" : "reader-show-chrome";
    }
    // Left / right page turn (honors direction setting)
    if (x < W / 3) {
      return leftIsNext ? "reader-next" : "reader-prev";
    }
    return leftIsNext ? "reader-prev" : "reader-next";
  }

  // Bottom nav — 书架 | 源 | 设置
  if (y >= LIST_BOT) {
    if (x < COL) return "nav-shelf";
    if (x < COL * 2) return "nav-sources";
    return "nav-settings";
  }

  if (screen === "login" || screen === "boot") {
    // Big buttons under compact header (HEADER_H≈40)
    if (y >= 100 && y < 160) return "retry-login";
    if (y >= 160 && y < 210) return "reload-config";
    return null;
  }

  if (screen === "settings") {
    // 已装源 / 重读 / 退出(双击)
    if (y >= 150 && y < 200) return "open-browse";
    if (y >= 200 && y < 250) return "reload-config";
    if (y >= 250 && y < 310) return "exit";
    return null;
  }

  if (screen === "browse") {
    const listY0 = HEADER_H + 28;
    if (y >= listY0 && y < LIST_BOT) {
      const rel = (y - listY0) / (LIST_BOT - listY0);
      if (rel < 0.33) return "src-up";
      if (rel > 0.66) return "src-down";
      return "src-open";
    }
    return null;
  }

  if (screen === "shelf") {
    // Category bar sits right under header
    if (y >= HEADER_H && y < HEADER_H + SUB_H) {
      return x < W / 2 ? "cat-prev" : "cat-next";
    }
    // Name strip ~28px then list
    const listY0 = HEADER_H + SUB_H + 28;
    if (y >= listY0 && y < LIST_BOT) {
      const rel = (y - listY0) / (LIST_BOT - listY0);
      if (rel < 0.33) return "manga-up";
      if (rel > 0.66) return "manga-down";
      return "manga-open";
    }
    return null;
  }

  if (screen === "detail") {
    if (y >= HEADER_H && y < HEADER_H + 36) return "detail-back";
    if (y >= HEADER_H + 36 && y < LIST_BOT) {
      const top = HEADER_H + 36;
      const rel = (y - top) / (LIST_BOT - top);
      if (rel < 0.33) return "ch-up";
      if (rel > 0.66) return "ch-down";
      return "ch-open";
    }
    return null;
  }

  return null;
}
