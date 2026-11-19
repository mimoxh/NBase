# 安卓应用（WebView 外壳）

2026-11-19 用户确认：先做安卓 WebView 外壳，在 `android/` 新建 Kotlin 工程，不新增 npm 依赖，不改服务端；首次启动填写服务器地址，之后可在设置里修改；只用 HTTPS（本机回环地址的 HTTP 仅用于 `adb reverse` 调试）。外壳只加载自部署的 NBase 网页，没有离线能力，内容与权限全部以服务端为准。

## 目录与模块

| 路径 | 职责 |
| --- | --- |
| `android/app/src/main/java/app/nbase/android/ServerAddress.kt` | 把输入规范成 origin（小写主机、省略默认端口、拒绝路径/查询/用户信息）。规则与服务端 `publicOriginConfig` 一致：只有 `localhost`、`127.0.0.1` 可用 HTTP；不写协议时默认 `https://`，回环地址默认 `http://`。服务端还允许 `[::1]`，外壳不支持 |
| `ServerStore.kt` | 用 SharedPreferences 保存 origin，读取时重新校验 |
| `HealthProbe.kt` | 保存前请求 `/api/health`：8 秒超时，不跟随重定向，响应限 16 KB，按 contracts 的健康契约核对；证书错误与 HTTPS 握手失败分别提示 |
| `SetupActivity.kt` | 服务器地址页（首次启动、错误页的“更改服务器”、桌面图标长按的“更改服务器地址”快捷方式）。从快捷方式进入时任务已被清空，返回键会重新打开已保存的服务器 |
| `MainActivity.kt` | WebView 宿主：设置、Cookie 持久化、导航限制、文件选择、下载、弹窗、权限、证书错误、渲染进程崩溃重建、返回键、打印 |
| `NavigationPolicy.kt` | 只有已保存的 origin 在应用内打开；主框架的其他 http/https/mailto/tel 链接交给系统浏览器，子框架和其他协议一律拦截 |
| `WebBridge.kt` + `assets/nbase-bridge.js` | 用 androidx.webkit 的 `WebMessageListener` 与 `DocumentStartJavaScript`，只对已保存的 origin 注入。负责下载、打印、主题色和文件夹选择的拦截 |
| `SystemBars.kt` | edge-to-edge，按系统栏、刘海和输入法的 insets 留出内边距；窗口背景跟随网页 `--nb-bg` |
| `FileNames.kt`、`CssColor.kt`、`PickedFiles.kt` | 下载文件名清理、CSS 颜色解析、文件选择结果的问题分类 |
| `android/e2e/` | 模拟器手动验收脚本（`helper.ps1` 点按与截图，`cdp.mjs` 通过 DevTools 在网页里执行表达式），截图写到 `android/build/e2e/`，不入库 |

## 网络与会话

- `network_security_config.xml` 禁止明文，只对 `localhost` / `127.0.0.1` 放行；信任系统 CA 与用户安装的 CA，自签名证书须先把签发它的 CA 装到手机。WebView 遇到证书错误一律取消，不提供“继续访问”。
- 服务端 `NBASE_PUBLIC_ORIGIN` 必须与设置页显示的地址完全一致，否则登录后写请求会因 Origin 校验失败。
- Cookie 由 WebView 的 CookieManager 保存（`HttpOnly; SameSite=Strict` 照常生效），暂停时 `flush()`；关闭第三方 Cookie。`allowBackup=false`，数据提取规则排除全部内容，会话不进入云备份或设备迁移。
- User-Agent 末尾追加 `NBaseAndroid/<版本>`，网页目前没有据此分支。

## 网页能力在外壳中的处理

| 网页行为 | 外壳处理 |
| --- | --- |
| `a[download]` 的 blob/data/同源下载（Markdown、ZIP、Word、HTML、CSV、附件） | 桥接脚本读取 Blob，按 384 KB 分块 base64 发给原生端，经 MediaStore 写入“下载/NBase”（写入期间 `IS_PENDING`，结束时核对字节数，失败删除半成品）。同源 HTTP 下载走 `DownloadListener` 后同样处理 |
| `window.print()`（“打印或存为 PDF”） | WebView 不支持网页打印，改为调用系统打印服务（`createPrintDocumentAdapter`），可存为 PDF |
| `window.open` / `target=_blank` | 临时 WebView 只取第一个地址，按导航规则在应用内打开或交给浏览器 |
| `<input type=file>` | 系统文件选择器，支持多选；取消后网页可再次选择。只把可读取的文件交给网页，选择器没有返回文件或文件不可读时提示原因（见下文 HyperOS 一节） |
| `webkitdirectory`（导入 Markdown 文件夹） | WebView 会把它当作普通多选（实测 WebView 133 报告 `MODE_OPEN_MULTIPLE`），选出的文件没有相对路径，网页会全部跳过。桥接脚本拦截点按、`click()` 与 `showPicker()`，提示到电脑浏览器导入；原生端对 `MODE_OPEN_FOLDER` 也作同样提示 |
| 返回键 / 返回手势 | 依次关闭：页面里的菜单、列表框或非原生对话框（派发 Escape）；最上层的原生 `<dialog>`（派发可取消的 `cancel` 事件，未被取消再 `close()`）；手机布局下打开的导航抽屉（点击 `.nb-scrim`）。200 ms 后核对浮层确实消失，否则按普通返回处理：有历史则后退，没有则把应用移到后台（不结束，在途保存可以完成）。网页切换页面不写浏览历史，所以打开页面后按返回会直接回到桌面 |
| 主题 | 桥接脚本把 `--nb-bg` 发给原生端，系统栏颜色和图标深浅随之切换 |
| 网页权限请求（摄像头、麦克风等）、地理位置 | 一律拒绝 |
| 浏览器通知（日历提醒） | WebView 没有 `Notification`，网页的提醒运行器退回页内提示；应用不在前台时不会提醒 |

返回键脚本依赖网页的 `dialog[open]`、`role="menu"`/`"listbox"`/`"dialog"`、`aria-modal` 和 `.nb-scrim`。改动这些结构时须同步 `MainActivity.CLOSE_OVERLAY_SCRIPT`。下载拦截依赖网页用 `a[download]` 触发下载。

## 已知限制

- 不支持导入文件夹，需在电脑浏览器中导入。
- 日历的 Google OAuth 授权会在系统浏览器中打开，浏览器里没有 NBase 会话和绑定 Cookie，预计无法完成（未实测）。OAuth 连接请在电脑浏览器中完成。
- 没有推送通知、离线缓存或分享到 NBase 的入口。
- 发布包未签名：`assembleRelease` 产出 `app-release-unsigned.apk`，签名密钥与分发方式未决定。
- 只在 Android 16 模拟器上验收；Android 10～12 的旧返回键路径（`onBackPressed`）只经编译和 lint 检查。

## 小米澎湃 OS（HyperOS）

2026-11-19 检索了 HyperOS 上 WebView 应用的已知问题（开源项目 issue、小米开发者文档、社区帖），据此做了两处改动，其余写入下面的注意事项。均未在小米真机上验证。

| 问题与来源 | 处理 |
| --- | --- |
| 深色模式下系统对应用做算法反色，已适配深色的应用须关闭（[小米深色模式适配说明](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1595)） | 主题设 `android:forceDarkAllowed=false`。网页自己按 `prefers-color-scheme` 切换深色，系统不应再反色 |
| 选完文件页面没有反应：选择器返回的条目没有 URI，或返回的 `content://` 没有授予读取权限，WebView 静默丢弃（[agentus#30](https://github.com/agentus-org/agentus/issues/30)，MIX Fold 4） | 结果只交给网页可读取的 URI：从 `ClipData` 与 `data` 收集并丢掉空项，对 `content://` 用元数据查询（不会触发云端文件下载）检查读取权限。选择成功却没有文件、全部不可读、部分不可读时分别提示改用“文件管理”。取消选择不提示 |
| 用 `Intent.createChooser` 包装后进不了相册（[dsh-mobile#205](https://github.com/saya-ch/dsh-mobile/issues/205)） | 外壳本来就不包装，直接启动 `FileChooserParams.createIntent()`；未改用系统照片选择器 |
| HyperOS 3 上 DownloadManager 下载失败（[revanced-manager#3412](https://github.com/ReVanced/revanced-manager/issues/3412)） | 不受影响：下载经桥接写入 MediaStore，不用 DownloadManager |

使用注意（写给部署者）：

- 自签名 CA：先用 Chrome 或系统“文件管理”把 `.crt`/`.pem` 存到手机（小米浏览器可能拦截证书下载），再到“设置 → 更多设置 → 系统安全 → 加密与凭据 → 安装证书 → CA 证书”安装。装在“用户凭据/VPN 和应用”下的证书不会被外壳信任。
- 安装 APK 时可能出现“未经安全检测”“未经小米审核”等提示，选择继续安装。release 包未签名，任何系统都无法安装，真机测试用 debug 包。
- 系统会较快回收后台应用，切回时页面重新加载；登录状态由 Cookie 保留，未保存的编辑以网页的草稿恢复为准。
## 构建

工具链安装在用户目录，不改系统设置：JDK Temurin 21.0.13+9（`%USERPROFILE%\.nbase-toolchain\jdk-21.0.13+9`）；Android SDK 位于 `%LOCALAPPDATA%\Android\Sdk`，包含 cmdline-tools 23、platform-tools 37.0.1、platforms;android-36、build-tools;36.0.0，模拟器另需 emulator 37.2.13 与 `system-images;android-36;google_apis;x86_64`。Gradle 由 wrapper 下载 9.9.1（已校验 SHA-256）。

```powershell
$env:JAVA_HOME = "$env:USERPROFILE\.nbase-toolchain\jdk-21.0.13+9"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
cd android
.\gradlew.bat testDebugUnitTest assembleDebug lintDebug assembleRelease --console=plain
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`（可调试 WebView）与 `release/app-release-unsigned.apk`（开启代码与资源压缩）。lint 设为有错误即失败；保留的警告是 targetSdk 36（OldTargetApi）、compileSdk 37 与 androidx.core 1.19.1 可用（GradleDependency，1.19.1 需要 compileSdk 37）、MergeRootFrame。

本机网络问题：这台电脑上 Java 连接 `repo.maven.apache.org` 时 TLS 握手会被中断，需要在构建前设置 `$env:JAVA_TOOL_OPTIONS = '-Djdk.tls.namedGroups=x25519,secp256r1,secp384r1'`。这只是本机环境的绕过办法，没有写进项目配置。

## 本机调试

服务端只监听回环地址，模拟器通过 `adb reverse tcp:4330 tcp:4330` 访问电脑上的 `http://127.0.0.1:4330`，`NBASE_PUBLIC_ORIGIN` 设为同一地址。debug 包开启 WebView 调试，`android/e2e/helper.ps1` 的 `Connect-Cdp` 把 `webview_devtools_remote_<pid>` 转发到 9222。`adb shell input text` 一次输入较长字符串会丢字符，脚本按 4 个字符分段输入；输入中文需要真实输入法。

## 真机实测（小米澎湃 OS 等）

准备：电脑与手机在同一局域网；NBase 以 HTTPS 提供服务，证书由公认 CA 或已装到手机的私有 CA 签发，`NBASE_PUBLIC_ORIGIN` 与手机里填写的地址完全一致；安装 `app-debug.apk`（手机打开“开发者选项 → USB 调试”后可用 `adb install -r`，也可直接拷到手机安装）。连上 USB 时，电脑 Chrome 打开 `chrome://inspect` 可调试应用里的网页。

| 项目 | 操作 | 期望 |
| --- | --- | --- |
| 证书 | 首次启动填写地址 | 能连接；未装 CA 时提示证书校验失败 |
| 登录与会话 | 登录，从最近任务划掉应用后重开 | 仍为登录状态 |
| 上传（文件管理） | 编辑器“添加图片或附件”，在选择器里选“文件管理”，单选与多选各一次 | 图片插入并显示“已保存”，没有额外提示 |
| 上传（相册与其他来源） | 同上，改从相册、“最近”、网盘等入口选 | 能插入；若插不进，应出现“没有读取所选文件的权限…”或“文件选择器没有返回文件…”提示，记下所用入口 |
| 取消选择 | 打开选择器后返回 | 无提示，可再次打开 |
| 深色模式 | 系统深色开、关各一次；在“设置 → 显示 → 深色模式”的应用列表里，NBase 开关打开和关闭各试一次 | 网页随系统切换，颜色与电脑浏览器深色主题一致，没有反色或发灰 |
| 下载 | 下载 `.md`、Word、ZIP、附件 | 文件出现在“文件管理 → 下载 → NBase”，能打开 |
| 打印 | “打印或存为 PDF” | 出现系统打印界面，可存为 PDF |
| 返回手势 | 打开对话框、菜单、抽屉后用侧滑返回 | 逐层关闭；没有浮层时应用回到后台 |
| 后台回收 | 打开编辑器输入文字，切到其他应用几分钟后回来 | 仍登录；如页面重载，已保存内容不丢 |
| 中文输入 | 用系统输入法输入中文，含联想与删除 | 组字正常，保存后内容正确 |
| 外链 | 点正文中的外部链接 | 在浏览器打开 |

请同时记录机型、HyperOS 版本、“开发者选项 → WebView 实现”中的版本号，异常时截图。
