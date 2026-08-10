# Suwayomi P0 GraphQL（Kindle 漫画 app）

服务器：`https://comic.anzhi.app`（可配置）  
原则：**不改服务端**；只浏览**已安装** sources；不做 extension / 下载队列管理。

Endpoint：`POST {base}/api/graphql`  
登录：`{base}/login.html`（form `user`/`pass`，cookie 会话）

## 已覆盖（可从 sorayomi.js 迁移）

| 操作 | 类型 | 用途 |
|---|---|---|
| `categories` | query | 书架分类 |
| `mangas` (inLibrary) | query | 分类下书库 / 书库搜索 |
| `manga(id)` | query | 详情 |
| `chapters(mangaId)` | query | 章节列表 |
| `fetchChapters` | mutation | 空章节时从源拉目录 |
| `fetchChapterPages` | mutation | 得到页图 URL 列表 |
| `updateChapter` | mutation | 同步 `lastPageRead` / `isRead` |

## P0 新增（Browse Source）

| 操作 | 用途 | 备注 |
|---|---|---|
| `sources`（已装） | Source 列表 | 过滤 `isNsfw` 可后做 |
| Source 内 popular / latest | 浏览 | 对应 WebUI「Browse」 |
| Source 内 search | 源内搜索 | |
| 漫画详情（源侧未入库） | 点进结果 | 可能先 `fetchManga` |
| `updateManga` inLibrary | 加入/移出书库 | 字段以服务器 schema 为准 |

**不做（P0）：** `extensions` install/uninstall、下载队列、全局 extension repo 管理。

## 页面图

`fetchChapterPages` → `pages: [url, …]`（多为服务器相对路径，需拼 `baseUrl`）。  
请求图时带登录 Cookie（与 sorayomi `onImageLoad` 相同）。

## 阅读器交互（产品已定）

- 左右半屏点按翻页  
- 章末再点「下一页侧」→ 自动下一话第 1 页  
- 正式 **退出** 按钮（非 demo 角长按；角长按仅 host 兜底）  
