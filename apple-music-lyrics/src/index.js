import {
  LayoutAlignAnchor,
  LyricPlayer,
} from "@applemusic-like-lyrics/core";
import amllCoreCss from "@applemusic-like-lyrics/core/style.css";

const STORAGE_KEY = "apple-music-lyrics-settings";

const DEFAULT_SETTINGS = {
  enabled: true,
  hideNativeLyrics: true,
  enableBlur: true,
  enableScale: true,
  enableSpring: true,
  alignPosition: 48,
  fadeWidth: 50,
};

let state = null;
let effectDispose = null;
let settingsDispose = null;
let styleDispose = null;
let settingsStyleDispose = null;
let saveTimer = 0;

const mountedHosts = new Set();

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, Number(value) || 0));

const normalizeSettings = (value) => {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...DEFAULT_SETTINGS,
    ...source,
    enabled: source.enabled ?? DEFAULT_SETTINGS.enabled,
    hideNativeLyrics:
      source.hideNativeLyrics ?? DEFAULT_SETTINGS.hideNativeLyrics,
    enableBlur: source.enableBlur ?? DEFAULT_SETTINGS.enableBlur,
    enableScale: source.enableScale ?? DEFAULT_SETTINGS.enableScale,
    enableSpring: source.enableSpring ?? DEFAULT_SETTINGS.enableSpring,
    alignPosition: clamp(
      source.alignPosition ?? DEFAULT_SETTINGS.alignPosition,
      25,
      70,
    ),
    fadeWidth: clamp(source.fadeWidth ?? DEFAULT_SETTINGS.fadeWidth, 10, 120),
  };
};

const scheduleSave = (ctx) => {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    if (!state) return;
    void ctx.storage.set(STORAGE_KEY, normalizeSettings(state.settings));
  }, 240);
};

const getLineStartMs = (line) => {
  const firstChar = line?.characters?.[0];
  if (Number.isFinite(firstChar?.startTime)) return firstChar.startTime;
  return Math.round((Number(line?.time) || 0) * 1000);
};

const getLineEndMs = (line, nextLine) => {
  const chars = Array.isArray(line?.characters) ? line.characters : [];
  const lastChar = chars[chars.length - 1];
  if (Number.isFinite(lastChar?.endTime) && lastChar.endTime > getLineStartMs(line)) {
    return lastChar.endTime;
  }

  const nextStart = getLineStartMs(nextLine);
  if (Number.isFinite(nextStart) && nextStart > getLineStartMs(line)) {
    return Math.max(getLineStartMs(line) + 500, nextStart - 80);
  }

  return getLineStartMs(line) + 4200;
};

const normalizeWordText = (value) => String(value ?? "").replace(/\s+/g, " ");

const createFallbackWords = (text, startTime, endTime) => {
  const content = normalizeWordText(text).trim();
  if (!content) return [];
  return [{ word: content, startTime, endTime }];
};

const convertEchoLinesToAmll = (lines) =>
  (Array.isArray(lines) ? lines : [])
    .map((line, index, sourceLines) => {
      const startTime = getLineStartMs(line);
      const endTime = Math.max(startTime + 300, getLineEndMs(line, sourceLines[index + 1]));
      const rawChars = Array.isArray(line?.characters) ? line.characters : [];
      const timedChars = rawChars
        .map((char) => ({
          word: normalizeWordText(char?.text),
          startTime: Number(char?.startTime),
          endTime: Number(char?.endTime),
        }))
        .filter(
          (word) =>
            word.word &&
            Number.isFinite(word.startTime) &&
            Number.isFinite(word.endTime) &&
            word.endTime > word.startTime,
        );

      return {
        words: timedChars.length
          ? timedChars
          : createFallbackWords(line?.text, startTime, endTime),
        translatedLyric: String(line?.translated || ""),
        romanLyric: String(line?.romanized || ""),
        startTime,
        endTime,
        isBG: false,
        isDuet: false,
      };
    })
    .filter((line) => line.words.length > 0);

const createLinesSignature = (lines) =>
  (Array.isArray(lines) ? lines : [])
    .map((line) => {
      const chars = Array.isArray(line?.characters) ? line.characters : [];
      const first = chars[0];
      const last = chars[chars.length - 1];
      return [
        getLineStartMs(line),
        Number(first?.startTime) || 0,
        Number(last?.endTime) || 0,
        String(line?.text || ""),
        String(line?.translated || ""),
        String(line?.romanized || ""),
        chars.length,
      ].join(":");
    })
    .join("\n");

const applyPlayerOptions = (entry, snapshot, forceRelayout = false) => {
  if (!state) return;
  const settings = state.settings;
  const reducedMotion = Boolean(snapshot?.reducedMotion);

  entry.host.root.dataset.echoAmllEnabled =
    settings.enabled && snapshot?.hasLyrics ? "true" : "false";
  entry.host.root.dataset.echoAmllHideNative =
    settings.enabled && settings.hideNativeLyrics && snapshot?.hasLyrics
      ? "true"
      : "false";

  entry.player.setEnableBlur(settings.enableBlur && !reducedMotion);
  entry.player.setEnableScale(settings.enableScale && !reducedMotion);
  entry.player.setEnableSpring(settings.enableSpring && !reducedMotion);
  entry.player.setWordFadeWidth(Math.max(0.1, settings.fadeWidth / 100));
  entry.player.setAlignAnchor(LayoutAlignAnchor.Center);
  entry.player.setAlignPosition(settings.alignPosition / 100);

  if (forceRelayout && typeof entry.player.calcLayout === "function") {
    void entry.player.calcLayout(false, true);
  }
};

const syncLines = (entry, snapshot, force = false) => {
  const signature = createLinesSignature(snapshot?.lines);
  if (!force && signature === entry.linesSignature) return;

  entry.linesSignature = signature;
  const lines = convertEchoLinesToAmll(snapshot?.lines);
  entry.player.setLyricLines(lines, Math.max(0, Number(snapshot?.timelineMs) || 0));
  entry.lastTimelineMs = Number.NaN;
  applyPlayerOptions(entry, snapshot, true);
};

const runFrame = (entry, time) => {
  if (!mountedHosts.has(entry)) return;

  if (!entry.lastFrameTime) entry.lastFrameTime = time;
  const deltaMs = Math.min(80, Math.max(0, time - entry.lastFrameTime));
  entry.lastFrameTime = time;

  const snapshot = entry.host.getSnapshot();
  entry.snapshot = snapshot;
  syncLines(entry, snapshot);
  applyPlayerOptions(entry, snapshot);

  const settings = state?.settings ?? DEFAULT_SETTINGS;
  const enabled = settings.enabled && snapshot?.hasLyrics;
  const timelineMs = Math.max(0, Number(snapshot?.timelineMs) || 0);
  const expectedTimeline =
    Number.isFinite(entry.lastTimelineMs)
      ? entry.lastTimelineMs + deltaMs * Math.max(0.1, Number(snapshot?.playbackRate) || 1)
      : timelineMs;
  const isSeek = Math.abs(timelineMs - expectedTimeline) > 700;

  if (entry.lastPlaying !== snapshot?.isPlaying) {
    entry.lastPlaying = snapshot?.isPlaying;
    if (snapshot?.isPlaying) entry.player.resume?.();
    else entry.player.pause?.();
  }

  if (enabled) {
    entry.player.setCurrentTime(timelineMs, isSeek);
    entry.player.update(deltaMs);
    entry.lastTimelineMs = timelineMs;
  }

  entry.frameId = window.requestAnimationFrame((nextTime) =>
    runFrame(entry, nextTime),
  );
};

const mountAmllPageLyrics = (host) => {
  const container = document.createElement("div");
  container.className = "echo-amll-player-shell";
  container.setAttribute("aria-hidden", "true");
  host.overlay.appendChild(container);

  const player = new LyricPlayer(container);
  const entry = {
    host,
    player,
    container,
    snapshot: host.getSnapshot(),
    linesSignature: "",
    frameId: 0,
    lastFrameTime: 0,
    lastTimelineMs: Number.NaN,
    lastPlaying: undefined,
    unsubscribe: null,
  };

  mountedHosts.add(entry);
  applyPlayerOptions(entry, entry.snapshot, true);
  syncLines(entry, entry.snapshot, true);

  entry.unsubscribe = host.subscribe((snapshot) => {
    entry.snapshot = snapshot;
    syncLines(entry, snapshot);
    applyPlayerOptions(entry, snapshot);
  });
  entry.frameId = window.requestAnimationFrame((time) => runFrame(entry, time));

  return () => {
    mountedHosts.delete(entry);
    entry.unsubscribe?.();
    if (entry.frameId) window.cancelAnimationFrame(entry.frameId);
    entry.host.root.removeAttribute("data-echo-amll-enabled");
    entry.host.root.removeAttribute("data-echo-amll-hide-native");
    entry.player.dispose?.();
    entry.container.remove();
  };
};

const AMLL_PLUGIN_CSS = `
.echo-amll-page[data-echo-amll-hide-native="true"] [data-echo-lyric-scroller="page"] {
  opacity: 0;
}

.echo-amll-page [data-echo-lyric-effect-overlay] {
  pointer-events: none;
}

.echo-amll-player-shell {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  opacity: 0;
  transition: opacity 0.18s ease;
  pointer-events: none;
}

.echo-amll-page[data-echo-amll-enabled="true"] .echo-amll-player-shell {
  opacity: 1;
}

.echo-amll-player-shell .amll-lyric-player {
  --amll-lp-color: color-mix(in srgb, var(--color-text-main, #fff) 88%, #fff);
  --amll-lp-bg-color: transparent;
  --amll-lp-hover-bg-color: transparent;
  --amll-lp-font-size: clamp(28px, 4.8vh, 54px);
  --amll-lp-line-width-aspect: 0.86;
  --amll-lp-line-padding-x: 0.35em;
  --amll-lp-bg-line-scale: 0.74;
  mix-blend-mode: normal;
  text-shadow: 0 12px 36px rgba(0, 0, 0, 0.18);
}
`;

const SETTINGS_CSS = `
.echo-amll-settings {
  display: grid;
  gap: 14px;
  color: var(--color-text-main);
}

.echo-amll-settings-row {
  display: grid;
  gap: 7px;
}

.echo-amll-settings-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.echo-amll-settings-title {
  font-size: 13px;
  font-weight: 760;
}

.echo-amll-settings-hint {
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.45;
}

.echo-amll-settings-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
`;

const refreshMountedHosts = () => {
  for (const entry of mountedHosts) {
    const snapshot = entry.host.getSnapshot();
    entry.snapshot = snapshot;
    syncLines(entry, snapshot, true);
    applyPlayerOptions(entry, snapshot, true);
  }
};

const updateSettings = (ctx, patch) => {
  if (!state) return;
  state.settings = normalizeSettings({ ...state.settings, ...patch });
  refreshMountedHosts();
  scheduleSave(ctx);
};

const createSettingsComponent = (ctx) =>
  ctx.vue.defineComponent({
    name: "AppleMusicLikeLyricsSettings",
    setup() {
      const { defineAsyncComponent, h } = ctx.vue;
      const Button = defineAsyncComponent(ctx.ui.components.Button);
      const Slider = defineAsyncComponent(ctx.ui.components.Slider);
      const Switch = defineAsyncComponent(ctx.ui.components.Switch);

      const slider = (label, key, min, max, hint, formatter = (value) => String(value)) =>
        h("div", { class: "echo-amll-settings-row" }, [
          h("div", { class: "echo-amll-settings-line" }, [
            h("span", { class: "echo-amll-settings-title" }, label),
            h("span", { class: "echo-amll-settings-hint" }, formatter(state.settings[key])),
          ]),
          h(Slider, {
            modelValue: state.settings[key],
            min,
            max,
            step: 1,
            "onUpdate:modelValue": (value) =>
              updateSettings(ctx, { [key]: Number(value) }),
          }),
          hint ? h("div", { class: "echo-amll-settings-hint" }, hint) : null,
        ]);

      const toggle = (label, key, hint) =>
        h("div", { class: "echo-amll-settings-row" }, [
          h("label", { class: "echo-amll-settings-line" }, [
            h("span", { class: "echo-amll-settings-title" }, label),
            h(Switch, {
              modelValue: Boolean(state.settings[key]),
              "onUpdate:modelValue": (value) =>
                updateSettings(ctx, { [key]: Boolean(value) }),
            }),
          ]),
          hint ? h("div", { class: "echo-amll-settings-hint" }, hint) : null,
        ]);

      return () =>
        h("div", { class: "echo-amll-settings" }, [
          toggle("启用 AMLL", "enabled", "只替换页面歌词的视觉渲染，关闭后回到原生歌词。"),
          toggle("隐藏原生歌词", "hideNativeLyrics", "保留原生歌词作为兜底，但视觉上显示 AMLL。"),
          toggle("歌词模糊", "enableBlur", "开启 AMLL 的远离焦点行模糊效果。"),
          toggle("歌词缩放", "enableScale", "开启当前行聚焦缩放。"),
          toggle("弹簧动画", "enableSpring", "开启 AMLL 的弹簧滚动和行切换动画。"),
          slider(
            "对齐位置",
            "alignPosition",
            25,
            70,
            "当前歌词行在页面高度中的位置。",
            (value) => `${value}%`,
          ),
          slider(
            "逐字渐变",
            "fadeWidth",
            10,
            120,
            "控制逐字高亮边缘的柔和宽度。",
            (value) => `${(value / 100).toFixed(2)}x`,
          ),
          h("div", { class: "echo-amll-settings-actions" }, [
            h(
              Button,
              {
                variant: "outline",
                size: "xs",
                onClick: () => updateSettings(ctx, DEFAULT_SETTINGS),
              },
              { default: () => "恢复默认" },
            ),
          ]),
        ]);
    },
  });

export async function activate(ctx) {
  state = ctx.vue.reactive({
    settings: normalizeSettings(await ctx.storage.get(STORAGE_KEY)),
  });

  styleDispose = ctx.css.inject(`${amllCoreCss}\n${AMLL_PLUGIN_CSS}`, {
    id: "apple-music-lyrics-amll",
  });
  settingsStyleDispose = ctx.css.inject(SETTINGS_CSS, {
    id: "apple-music-lyrics-settings",
  });

  settingsDispose = ctx.ui.settings.define({
    title: "Apple Music-like 歌词",
    description: "使用 AMLL core 渲染页面歌词。",
    component: createSettingsComponent(ctx),
  });

  effectDispose = ctx.lyricEffects.register({
    id: "apple-music-like-lyrics-page",
    title: "Apple Music-like 页面歌词",
    scope: "page",
    layer: "decorator",
    order: 80,
    className: "echo-amll-page",
    mount: mountAmllPageLyrics,
  });
}

export function deactivate() {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = 0;
  effectDispose?.();
  settingsDispose?.();
  settingsStyleDispose?.();
  styleDispose?.();
  effectDispose = null;
  settingsDispose = null;
  settingsStyleDispose = null;
  styleDispose = null;
  state = null;
  mountedHosts.clear();
}
