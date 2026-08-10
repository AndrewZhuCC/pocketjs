import { createSignal, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { touches } from "@pocketjs/framework/input";

/**
 * Manga app shell (Kindle 309×412).
 * Phase B UI: login/shelf placeholders. Real net+image host ops come next.
 * Exit is a real button (product path); host corner-hold remains emergency only.
 */

type Screen = "home" | "settings";

export default function MangaApp() {
  const [screen, setScreen] = createSignal<Screen>("home");
  const [server] = createSignal("https://comic.anzhi.app");
  const [status, setStatus] = createSignal("就绪 — 等待 host 网络图能力");
  const [exitArmed, setExitArmed] = createSignal(false);

  // Bottom bar hit targets (logical px). Re-check each frame; no DOM events.
  onFrame(() => {
    const t = touches()[0];
    if (!t) {
      setExitArmed(false);
      return;
    }
    // Exit button region: bottom strip right half roughly
    if (screen() === "home" || screen() === "settings") {
      if (t.y >= 370 && t.x >= 160) {
        if (!exitArmed()) {
          setExitArmed(true);
          setStatus("长按退出区…（正式版将调用 host.exit）");
        }
      }
    }
    // Nav: bottom-left = home, mid = settings
    if (t.y >= 370 && t.x < 100) setScreen("home");
    if (t.y >= 370 && t.x >= 100 && t.x < 160) setScreen("settings");
  });

  return (
    <View
      debugName="MangaApp"
      class="relative w-full h-full flex-col"
      style={{ bgColor: "#f2efe6" }}
    >
      <View class="px-3 pt-3 pb-2 flex-col gap-1">
        <Text class="text-xl font-bold" style={{ textColor: "#161616" }}>
          漫画
        </Text>
        <Text class="text-xs" style={{ textColor: "#666" }}>
          Suwayomi · {server()}
        </Text>
      </View>

      <View class="mx-3 h-[1]" style={{ bgColor: "#ccc7bb" }} />

      <Show when={screen() === "home"}>
        <View class="flex-1 px-3 pt-3 flex-col gap-2">
          <Text class="text-sm font-bold" style={{ textColor: "#222" }}>
            书架
          </Text>
          <Text class="text-xs" style={{ textColor: "#666" }}>
            登录、分类、书库列表将接 SuwayomiClient。
          </Text>
          <Text class="text-xs" style={{ textColor: "#666" }}>
            Browse Source（仅已装源）在 host 拉图探针通过后做。
          </Text>
          <View
            class="mt-3 px-3 py-2 border-[1]"
            style={{ bgColor: "#ebe7dd", borderColor: "#b8b2a7" }}
          >
            <Text class="text-xs" style={{ textColor: "#333" }}>
              {status()}
            </Text>
          </View>
        </View>
      </Show>

      <Show when={screen() === "settings"}>
        <View class="flex-1 px-3 pt-3 flex-col gap-2">
          <Text class="text-sm font-bold" style={{ textColor: "#222" }}>
            设置
          </Text>
          <Text class="text-xs" style={{ textColor: "#666" }}>
            服务器、账号、翻页方向（默认半屏点按）、缓存上限。
          </Text>
          <Text class="text-xs" style={{ textColor: "#666" }}>
            不做 Extension 管理 / 下载队列（P0）。
          </Text>
        </View>
      </Show>

      {/* Bottom chrome */}
      <View
        class="flex-row items-center justify-between px-2 py-2 border-t-[1]"
        style={{ bgColor: "#e8e4da", borderColor: "#b8b2a7", height: 42 }}
      >
        <Text class="text-xs font-bold" style={{ textColor: screen() === "home" ? "#000" : "#888" }}>
          书架
        </Text>
        <Text
          class="text-xs font-bold"
          style={{ textColor: screen() === "settings" ? "#000" : "#888" }}
        >
          设置
        </Text>
        <Text class="text-xs font-bold" style={{ textColor: "#8b1a1a" }}>
          退出
        </Text>
      </View>
    </View>
  );
}
