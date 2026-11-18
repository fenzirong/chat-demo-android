# Chat Demo · Android 原生外壳

把 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 这个纯静态 Web 应用封装成一个可以直接安装的 Android 应用（APK）。

上游项目本身没有后端、也没有原生代码，全部逻辑都在浏览器里跑，所以这里的做法是**原生 Android 外壳 + 内置离线站点**：

- 用 `WebView` 承载页面，页面资源随 APK 一起打包（`assets/www/`），**完全离线启动**，不依赖任何 CDN 或本地服务器。
- 通过 `WebViewAssetLoader` 把资源映射到 `https://appassets.androidplatform.net/assets/www/`，页面因此处于**安全上下文（secure context）**，`localStorage`、`IndexedDB`、`getUserMedia`（语音输入）、`navigator.clipboard` 等能力都能正常使用。
- 原生侧补齐 WebView 默认缺失的能力：文件选择（附件上传）、麦克风权限、外部链接跳转、下载保存、返回键导航。

## 下载

| 版本 | 文件 | 说明 |
| --- | --- | --- |
| v0.1.1 | [app-release.apk](https://github.com/fenzirong/chat-demo-android/releases/download/v0.1.1/app-release.apk) | 正式签名，日常使用装这个 |
| v0.1.1 | [app-debug.apk](https://github.com/fenzirong/chat-demo-android/releases/download/v0.1.1/app-debug.apk) | 调试版，包名带 `.debug` 后缀，可与正式版共存 |

Release 页面：<https://github.com/fenzirong/chat-demo-android/releases>

固定下载地址（永远指向最新 Release）：
`https://github.com/fenzirong/chat-demo-android/releases/latest/download/app-release.apk`

安装要求：Android 7.0（API 24）及以上。安装后打开应用 → 设置 → 接口，选择服务商并填入 API Key 即可开始对话。

## 第三方 API 支持

设置 → **接口** 里可以切换服务商，不再绑定 DeepSeek 官方：

| 预设 | 协议 | 默认地址 | 说明 |
| --- | --- | --- | --- |
| DeepSeek 官方 | Anthropic Messages | `https://api.deepseek.com/anthropic/v1` | 全部能力：联网搜索、附件、语音、自动标题 |
| CommandCode | Anthropic Messages | `https://api.commandcode.ai/v1` | 基础对话 + 深度思考 |
| OpenAI | Chat Completions | `https://api.openai.com/v1` | 基础对话 |
| 自定义（Anthropic 兼容） | Anthropic Messages | 自填 | 基础对话 + 深度思考 |
| 自定义（OpenAI 兼容） | Chat Completions | 自填 | 基础对话 |

可配置项：接口地址（含版本段，如 `/v1`）、模型 id、鉴权方式（`Authorization: Bearer` 或 `x-api-key`）、是否发送 `anthropic-version` 头。填好后点「测试连接」会先 `GET /models` 校验，服务商不支持该接口时自动退回一次最小请求。

实现要点：

- `src/services/providers.ts` 把「协议」和「能力」拆开：协议决定报文格式，能力决定是否发送 DeepSeek 私有字段（`safety_check`、`title`、`latest_reminder` 角色、`deepseek_web_search` 工具、Files API）。
- `src/services/api/openai.ts` 负责 OpenAI 协议的请求转换与流式翻译，把 `data: {...}` 增量还原成内部事件，上层渲染、分支、续写逻辑完全复用。
- 第三方 Anthropic 兼容服务会自动补 `max_tokens`，深度思考改用 `budget_tokens` 写法。
- API Key 按服务商分别保存，切换服务商不会互相覆盖。
- 服务端不提供自动标题时，用提问首行兜底生成标题。

已知限制：

- 第三方服务商不支持联网搜索、附件上传、语音输入与朗读，界面上对应入口会置灰。
- 接口必须允许跨域（CORS）访问，且必须是 HTTPS（APK 关闭了明文流量）。CommandCode 的 CORS 只放行 `Content-Type` / `Authorization`，所以预设里不发送 `anthropic-version` 头。
- 附件在第三方服务商下不会进入请求，历史里带附件的会话切过去后只发送文本。

## 目录结构

```
android/
├── app/
│   ├── build.gradle                     # 应用模块（compileSdk 34 / minSdk 24）
│   └── src/main/
│       ├── AndroidManifest.xml
│       ├── java/com/deepseek/chatdemo/MainActivity.java
│       ├── res/                         # 主题、图标（矢量自适应图标）
│       └── assets/www/                  # 构建时由 dist/ 拷入，不提交
├── keystore/chatdemo.jks                # 演示用固定签名
├── gradle/wrapper/                      # Gradle 8.2.1
└── settings.gradle / build.gradle
.github/workflows/android.yml            # GitHub Actions：构建并上传 APK
```

## 本地构建

前置：JDK 17、Android SDK（platform 34 + build-tools 34.0.0）、Node.js 22 + pnpm。

```sh
# 1. 构建前端静态资源
pnpm install --frozen-lockfile
pnpm build

# 2. 拷进 Android 工程
rm -rf android/app/src/main/assets/www
mkdir -p android/app/src/main/assets/www
cp -a dist/. android/app/src/main/assets/www/

# 3. 编译 APK
cd android
echo "sdk.dir=$ANDROID_HOME" > local.properties
./gradlew assembleRelease
```

产物：`android/app/build/outputs/apk/release/app-release.apk`

也可以直接用脚本：`./scripts/build-apk.sh`（会自动完成上面三步）。

## GitHub Actions 打包

`.github/workflows/android.yml` 在 push 到 `main`、打 `v*` 标签或手动触发时运行：

1. `pnpm install` + `pnpm build` 生成 `dist/`
2. 把 `dist/` 拷进 `android/app/src/main/assets/www/`
3. 安装 Android SDK 34，`./gradlew assembleRelease assembleDebug`
4. 上传 `chat-demo-android-apk` 构建产物（Artifact）
5. 如果是 `v*` 标签，额外创建 GitHub Release 并附上 APK

版本号取自 `package.json` 的 `version`，`versionCode` 取自 Actions 的 `run_number`，保证每次构建都能覆盖安装升级。

## 签名

`android/keystore/chatdemo.jks` 是**演示用**的固定签名（storePassword / keyPassword / alias 均为 `chatdemo`），提交进仓库只是为了让 CI 每次产出的 APK 签名一致、可以互相覆盖安装。

如果要正式发布，请换成自己的 keystore，并把口令放到 GitHub Secrets 里，通过 `-PstoreFile/-PstorePassword/...` 或环境变量注入，不要继续用这个公开的演示密钥。

## 原生能力对照

| 页面能力 | Android 侧实现 |
| --- | --- |
| 附件上传（图片/文件） | `WebChromeClient.onShowFileChooser` → 系统文件选择器，支持多选 |
| 语音输入 | `onPermissionRequest` + 运行时 `RECORD_AUDIO` 授权 |
| 引用链接 / `window.open` | `onCreateWindow` + `shouldOverrideUrlLoading` → 系统浏览器 |
| 导出历史（blob 下载） | 注入脚本拦截 `<a download>`，`fetch(blob)` → base64 → `AndroidBridge.saveBase64` 写入下载目录 |
| 普通 http(s) 下载 | `DownloadListener` → `DownloadManager` |
| 返回键 | 优先 `WebView.goBack()`，到首页再退出 |
| 深色模式 | `values-night` 主题 + 页面自身主题跟随系统 |

## 已知限制

- 这是 WebView 外壳，不是用 Kotlin/Compose 重写的原生 UI；页面渲染依赖系统 WebView（Android 7.0+ 一般都已更新到较新版本）。
- 语音朗读（TTS）走页面内的 Web Speech / 服务端接口，行为与浏览器一致。
- 应用只允许 HTTPS 请求（`usesCleartextTraffic=false`），自定义 API 地址必须是 https。
- 首次启动需要联网并填入 DeepSeek API Key（设置页），之后对话数据保存在本机 WebView 存储中。
