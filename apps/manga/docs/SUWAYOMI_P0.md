# Suwayomi P0 GraphQL 操作清单

**服务器**：`https://comic.anzhi.app`（可配置，不改服务端）  
**认证**：`POST {base}/login.html`（`user`/`pass` form-urlencoded）→ Cookie 会话  
**API**：`POST {base}/api/graphql`（`Content-Type: application/json`，带 Cookie）

原则：

- 只消费现有 GraphQL / 页面 URL  
- **只浏览已安装 sources**  
- **不做** extension 安装/卸载、下载队列 UI  

参考实现：`venera-sources/sorayomi.js`（书库路径）+ Suwayomi-Server `SourceQuery` / `SourceMutation`。

---

## A. 认证与书架（sorayomi 已有，直接迁）

| # | 名称 | 类型 | 用途 | 关键字段 |
|---|---|---|---|---|
| A1 | `VALIDATE_LOGIN` | query | 探活 / 校验登录 | `categories(first:1).totalCount` |
| A2 | `categories` | query | 书架分类 | `id name order mangas.totalCount` |
| A3 | `mangas` + `inLibrary` + `categoryIds` | query | 分类下书库列表 | `id title thumbnailUrl unreadCount source` |
| A4 | `mangas` + `filter` | query | 书库内搜索 title/author/genre | 同 A3 |
| A5 | `manga(id)` + `chapters` | query | 详情 + 章节 | 章节：`id name sourceOrder isRead lastPageRead pageCount` |
| A6 | `fetchChapters` | mutation | 章节为空时从源拉目录 | `input: { mangaId }` |
| A7 | `fetchChapterPages` | mutation | 页图 URL 列表 | `pages: [String!]!`（常相对路径，拼 baseUrl） |
| A8 | `updateChapter` | mutation | 阅读进度 | `patch: { lastPageRead, isRead? }` |

### A1–A8 示例（已写入 `suwayomi/client.ts`）

见仓库 `apps/manga/suwayomi/client.ts` 中 `P0_OPERATIONS`。

页面图请求：对 `pages[]` 做 `GET`，**必须带登录 Cookie**（与 sorayomi `onImageLoad` 一致）。

---

## B. Browse Source（P0 新增，仅已装源）

服务端 `sources` 返回的是**已对服务器可用的源**（由服务器侧已装 extension 提供）。客户端**不**调用 extension install。

| # | 名称 | 类型 | 用途 | 输入要点 |
|---|---|---|---|---|
| B1 | `sources` | query | 已装源列表 | `first/offset`；可选 `condition.isNsfw` / `contentWarning`（新版更推荐 contentWarning） |
| B2 | `source(id)` | query | 单源详情（可选） | `id: Long` |
| B3 | `fetchSourceManga` | mutation | Popular / Latest / Search | 见下 |
| B4 | `fetchManga` | mutation | 未入库条补全详情（若列表字段不足） | `input: { id }`（以服务器为准） |
| B5 | `updateManga` | mutation | 加入/移出书库 | `patch: { inLibrary: true/false }` |

### B1 `sources`（推荐查询）

```graphql
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
}
```

说明（SourceQuery.kt）：

- 需登录 `@RequireAuth`  
- 排序可用 `order: [{ by: NAME|ID|LANG, byType: ASC|DESC }]`  
- `isNsfw` 在新版本趋向 deprecated，映射 contentWarning；P0 可先用 `isNsfw` 过滤，不兼容再改  

### B3 `fetchSourceManga`

```graphql
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
}
```

`FetchSourceMangaInput`（SourceMutation.kt）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `source` | Long | 源 id |
| `type` | enum | `POPULAR` \| `LATEST` \| `SEARCH` |
| `page` | Int | 从 1 起 |
| `query` | String? | 仅 SEARCH |
| `filters` | FilterChange[]? | SEARCH 高级筛选，**P0 可先不做** |

- `LATEST`：若 `supportsLatest == false` 服务端会抛错 → UI 隐藏入口  
- 返回的 manga 会 **insertOrUpdate 到服务器 DB**，之后可用 `manga(id)` / 入库  

### B5 加入书库（典型）

```graphql
mutation UPDATE_MANGA_LIBRARY($input: UpdateMangaInput!) {
  updateManga(input: $input) {
    manga { id inLibrary }
  }
}
# variables 示例：
# { "input": { "id": 123, "patch": { "inLibrary": true } } }
```

（具体 input 名以你服务器 introspection 为准；WebUI 同系 mutation。）

---

## C. 明确不在 P0

| 操作 | 原因 |
|---|---|
| `installExtension` / `updateExtension` / `uninstallExtension` | 你定：Kindle 不管扩展 |
| 下载队列 / `enqueueChapterDownloads` 等 | 优先级后置 |
| Source 偏好 `updateSourcePreference` | 可后置 |
| Source meta set/delete | 可后置 |

---

## D. 客户端调用顺序（验收用）

**书架路径**

1. login → A1  
2. A2 categories → A3 某分类 mangas  
3. A5 详情+章节（必要时 A6）  
4. A7 pages → 带 Cookie 拉图  
5. 翻页时 A8 进度  

**Browse 路径**

1. login → B1 sources  
2. B3 POPULAR/LATEST/SEARCH（page=1,2,…）  
3. 点漫画 → A5 或 B4  
4. B5 `inLibrary: true`  
5. 之后同书架阅读路径  

---

## E. 与 PocketJS 的衔接

| 步骤 | 层 |
|---|---|
| A1–B5 JSON | **JS** `SuwayomiClient` |
| 页图 GET + 解码 Gray8 + 缓存 | **Rust host**（`--show-image` 探针 / 后续 surface） |
| 半屏点按、章末下一话、退出按钮 | **JS UI** |

---

## F. 文档状态

- 清单定稿：本文件  
- 代码：`apps/manga/suwayomi/client.ts`（A 组已实现 query 字符串；B 组 sources + fetchSourceManga 已补）  
- 实机探针：host `--show-image <url>`（需重编部署）  
