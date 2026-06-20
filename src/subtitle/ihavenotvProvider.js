import { logger } from "../libs/log.js";
import { BilingualSubtitleManager } from "./BilingualSubtitleManager.js";
import { DEFAULT_SUBTITLE_SETTING } from "../config/setting.js";
import { DEFAULT_API_SETTING } from "../config/api.js";
import { getDocInfo } from "../libs/docInfo.js";
import { getSettingWithDefault } from "../libs/storage.js";
import { browser } from "../libs/browser.js";

const MSG_SUBTITLE_DATA = "KISS_IHAVENOTV_SUBTITLE";
const MSG_IFRAME_READY = "KISS_IHAVENOTV_IFRAME_READY";

/**
 * 解析 SRT 字幕文本为 flatEvents 数组。
 * 标准 SRT 格式：
 *   序号
 *   00:00:15,849 --> 00:00:17,935
 *   字幕文本（可多行）
 *   （空行分隔）
 *
 * @param {string} srtText - SRT 文件完整文本
 * @returns {Array<{start: number, end: number, text: string}>} 时间单位为毫秒
 */
function parseSrt(srtText) {
  // 统一换行符为 \n，去除 BOM 头
  const cleanText = srtText
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  if (!cleanText) return [];

  const blocks = cleanText.split(/\n\n+/);
  const result = [];

  for (const block of blocks) {
    const lines = block.split("\n");
    // 找到包含 "-->" 的时间戳行
    const tsIdx = lines.findIndex((l) => l.includes("-->"));
    if (tsIdx === -1) continue;

    const [startStr, endStr] = lines[tsIdx].split("-->").map((s) => s.trim());
    const start = parseSrtTimestamp(startStr);
    const end = parseSrtTimestamp(endStr);
    // 时间戳行之后的所有行都是字幕文本
    const text = lines
      .slice(tsIdx + 1)
      .join("\n")
      .trim();

    if (text && start < end) {
      result.push({ start, end, text });
    }
  }

  return result;
}

/**
 * 将 SRT 时间戳转换为毫秒。
 * 支持格式: HH:MM:SS,mmm
 */
function parseSrtTimestamp(ts) {
  const parts = ts.split(":");
  if (parts.length !== 3) return 0;
  const [h, m, rest] = parts;
  const [s, ms] = rest.split(",");
  return (
    parseInt(h, 10) * 3600000 +
    parseInt(m, 10) * 60000 +
    parseInt(s, 10) * 1000 +
    parseInt(ms || "0", 10)
  );
}

/**
 * 获取页面上字幕下载链接的 URL。
 * 匹配 a[href*=".srt"] 或 a[title*="subtitle" i]
 */
function findSubtitleUrl() {
  const link =
    document.querySelector('a[href*=".srt"]') ||
    document.querySelector('a[title*="subtitle" i]') ||
    document.querySelector('a[title*="Subtitle"]');
  return link ? link.href : null;
}

/**
 * 将字幕数据发送到 iframe，带重试机制。
 * 由于 iframe 的 content script 可能晚于主页面加载完成，需要重试几次确保送达。
 */
function sendToIframe(data, maxRetries = 5) {
  let attempt = 0;
  const trySend = () => {
    const iframe = document.querySelector("iframe");
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage(data, "*");
    }
    attempt++;
    if (attempt < maxRetries) {
      setTimeout(trySend, 1000);
    }
  };
  trySend();
}

/**
 * 主页面逻辑：检测 SRT 链接 → fetch → 解析 → 发送到 iframe。
 * 在顶级 frame 中执行。
 */
export async function startIhavenotvProvider(setting) {
  const subtitleUrl = findSubtitleUrl();
  if (!subtitleUrl) {
    logger.info("ihavenotv: no subtitle link found on page");
    return;
  }

  logger.info("ihavenotv: found subtitle URL:", subtitleUrl);

  try {
    const resp = await fetch(subtitleUrl);
    if (!resp.ok) {
      logger.warn("ihavenotv: failed to fetch subtitle:", resp.status);
      return;
    }

    const srtText = await resp.text();
    const flatEvents = parseSrt(srtText);
    if (!flatEvents.length) {
      logger.warn("ihavenotv: parsed 0 subtitle events");
      return;
    }

    logger.info(`ihavenotv: parsed ${flatEvents.length} subtitle events`);

    const subtitleSetting = setting.subtitleSetting || DEFAULT_SUBTITLE_SETTING;

    // 只发送字幕数据和源语言，设置由 iframe 自己从 storage 读取（保证完整性和实时性）
    const msgData = {
      type: MSG_SUBTITLE_DATA,
      subtitles: flatEvents,
      fromLang: subtitleSetting.fromLang || "auto",
    };

    // 握手机制：监听 iframe 的 ready 信号，收到后立即发送
    window.addEventListener("message", (event) => {
      if (event.data?.type === MSG_IFRAME_READY) {
        const iframe = document.querySelector("iframe");
        if (iframe?.contentWindow) {
          iframe.contentWindow.postMessage(msgData, "*");
        }
      }
    });

    // 同时带重试发送，防止 ready 信号丢失
    sendToIframe(msgData);
  } catch (err) {
    logger.error("ihavenotv: subtitle processing failed:", err);
  }
}

/**
 * iframe 侧逻辑：监听主页面发来的字幕数据，创建 BilingualSubtitleManager。
 * 在 iframe frame 中执行。
 */
/**
 * 从 storage 读取完整的字幕设置（包含所有样式字段），与 API 配置合并。
 * 每次调用都重新读取，确保拿到最新值。
 */
async function getFullSubtitleSetting(fromLang) {
  const setting = await getSettingWithDefault();
  const subtitleSetting = setting.subtitleSetting || DEFAULT_SUBTITLE_SETTING;
  const transApis = setting.transApis || [];
  const apiSetting =
    transApis.find((api) => api.apiSlug === subtitleSetting.apiSlug) ||
    DEFAULT_API_SETTING;

  return {
    ...subtitleSetting,
    fromLang: fromLang || subtitleSetting.fromLang || "auto",
    apiSetting,
    transApis,
    prompts: setting.prompts,
    uiLang: setting.uiLang,
    docInfo: getDocInfo(),
  };
}

export function initIhavenotvIframeListener() {
  let managerInstance = null;

  // 通知主页面：iframe 已准备好接收字幕数据
  window.parent.postMessage({ type: MSG_IFRAME_READY }, "*");

  // 监听设置变更，重新读取 storage 并更新 manager
  if (browser?.storage?.onChanged) {
    browser.storage.onChanged.addListener(async (changes, area) => {
      if (area !== "local") return;
      for (const [key, change] of Object.entries(changes)) {
        if (key.includes("setting") && change.newValue?.subtitleSetting) {
          if (managerInstance) {
            const fullSetting = await getFullSubtitleSetting();
            managerInstance.updateSetting(fullSetting);
          }
        }
      }
    });
  }

  window.addEventListener("message", async (event) => {
    if (event.data?.type !== MSG_SUBTITLE_DATA) return;

    const { subtitles, fromLang } = event.data;
    if (!subtitles?.length) return;

    logger.info(`ihavenotv: received ${subtitles.length} subtitle events`);

    // 隐藏 Plyr 原生字幕
    injectHideNativeCaptionsStyle();

    // 等待 video 元素就绪
    waitForVideo(async (videoEl) => {
      // 切换 textTrack mode 为 showing
      for (let i = 0; i < videoEl.textTracks.length; i++) {
        videoEl.textTracks[i].mode = "showing";
      }

      // 销毁旧实例
      if (managerInstance) {
        managerInstance.destroy();
        managerInstance = null;
      }

      // 从 storage 读取完整设置（包含 windowStyle/originStyle/translationStyle 等）
      const fullSetting = await getFullSubtitleSetting(fromLang);

      managerInstance = new BilingualSubtitleManager({
        videoEl,
        formattedSubtitles: subtitles,
        setting: fullSetting,
      });
      managerInstance.start();
    });
  });
}

/**
 * 注入 CSS 隐藏 Plyr 原生字幕渲染层，避免与 BilingualSubtitleManager 冲突。
 */
function injectHideNativeCaptionsStyle() {
  if (document.getElementById("kiss-hide-plyr-captions")) return;
  const style = document.createElement("style");
  style.id = "kiss-hide-plyr-captions";
  style.textContent = ".plyr__captions { display: none !important; }";
  document.head.appendChild(style);
}

/**
 * 等待页面中的 <video> 元素出现。
 * Plyr 播放器可能延迟初始化，用 MutationObserver 轮询。
 */
function waitForVideo(callback) {
  const video = document.querySelector("video");
  if (video) return callback(video);

  const observer = new MutationObserver(() => {
    const video = document.querySelector("video");
    if (video) {
      observer.disconnect();
      callback(video);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}
