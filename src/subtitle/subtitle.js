import { YouTubeInitializer } from "./YouTubeCaptionProvider.js";
import {
  startIhavenotvProvider,
  initIhavenotvIframeListener,
} from "./ihavenotvProvider.js";
import { isMatch } from "../libs/utils.js";
import { DEFAULT_API_SETTING } from "../config/api.js";
import { DEFAULT_SUBTITLE_SETTING } from "../config/setting.js";
import { logger } from "../libs/log.js";
import { injectJs, INJECTOR } from "../injectors/index.js";

// 各视频平台对应的字幕初始化拦截器配置
const providers = [
  { pattern: "https://www.youtube.com", start: YouTubeInitializer, needInject: true },
  { pattern: "ihavenotv.com", start: startIhavenotvProvider, needInject: false },
];

/**
 * 运行双语字幕翻译服务的主入口。
 * 该函数根据当前网页的 href URL，匹配已注册的视频服务提供商列表。
 * 如果匹配成功，则执行底层的 XHR 拦截脚本注入（用于劫持平台字幕数据请求，如 YouTube 的 timedtext 接口），
 * 接着获取用户的字幕/翻译配置，并初始化启动对应平台的字幕翻译渲染引擎。
 *
 * @param {object} params - 引导参数对象
 * @param {string} params.href - 当前浏览器网页的完整链接 (document.location.href)
 * @param {object} params.setting - 全局用户配置选项，包括 subtitleSetting 和 transApis
 */
export function runSubtitle({ href, setting }) {
  try {
    // 获取字幕配置，若无则使用默认字幕配置
    const subtitleSetting = setting.subtitleSetting || DEFAULT_SUBTITLE_SETTING;

    // 如果用户在设置中关闭了视频双语字幕翻译功能，则不执行任何后续操作，直接返回
    if (!subtitleSetting.enabled) {
      return;
    }

    // 根据当前网页 URL (href) 查找是否有匹配的字幕服务提供商（例如匹配 YouTube 网址）
    const provider = providers.find((item) => isMatch(href, item.pattern));
    if (provider) {
      // 按需注入底层劫持脚本（YouTube 等需要 XHR 拦截的平台）
      if (provider.needInject) {
        const id = "kiss-translator-inject-subtitle-js";
        injectJs(INJECTOR.subtitle, id);
      }

      // 获取当前字幕翻译所关联的翻译 API 配置 (apiSetting)
      const transApis = setting.transApis || [];
      const apiSetting =
        transApis.find((api) => api.apiSlug === subtitleSetting.apiSlug) ||
        DEFAULT_API_SETTING;

      // 启动特定平台的字幕翻译与渲染引擎
      provider.start({
        ...subtitleSetting,
        apiSetting,
        transApis,
        prompts: setting.prompts,
        uiLang: setting.uiLang,
      });
    }
  } catch (err) {
    logger.error("start subtitle provider failed", err);
  }
}

/**
 * iframe 内的字幕数据监听初始化。
 * 在顶级 frame 的 runSubtitle 中检测到 ihavenotv.com 后，会通过 postMessage
 * 将字幕数据发送到 iframe。此函数在 iframe 中调用，负责接收数据并启动渲染。
 *
 * @param {object} setting - 全局用户配置
 */
export function initIframeSubtitleListener(setting) {
  const subtitleSetting = setting.subtitleSetting || DEFAULT_SUBTITLE_SETTING;
  if (!subtitleSetting.enabled) return;
  initIhavenotvIframeListener();
}
