# Sign / Castle HappyDOM 诊断入口：哈希资源自动发现升级

本压缩包是 **`investigation-obfuscation` 项目的增量替换文件**，不是独立项目。

## 替换文件

| 文件 | 用途 |
| --- | --- |
| `tools/run-sign-happydom.mjs` | Sign 诊断入口：支持仅哈希命名的 Startup/SDK 发现，以及依赖图下载 |
| `tools/run-castle-happydom.mjs` | Castle 诊断入口：发现当前部署的 SDK、公钥和依赖；保留 import/configure/token 模式 |
| `tools/sdk-resource-utils.mjs` | 两个入口共用的资源发现、模块引用解析和依赖持久化工具（**必须同目录安装**） |
| `tests/sdk-resource-discovery.test.mjs` | 完全离线的发现与依赖图回归测试 |

将 `tools/` 中三个文件放回原仓库的 `tools/` 或 `scripts/`（两入口与辅助文件始终同级），保留原有 `env/` 目录、监控与动画适配文件。测试文件可放回仓库的 `tests/`。

## 最小验证（Windows PowerShell）

先仅下载和分析，不执行远端 SDK：

```powershell
$env:SIGN_MODE = 'fetch'
$env:SIGN_SDK_SOURCE = 'auto'
node tools/run-sign-happydom.mjs

$env:CASTLE_MODE = 'fetch'
$env:CASTLE_SDK_SOURCE = 'auto'
node tools/run-castle-happydom.mjs
```

成功时应出现 `sdk.discovery.chain`、`sdk.graph.ready` 和 SDK 文件路径；Castle 还会报告 `publicKeyFound: true`（**不打印公钥本身**）。

确认远端源码可信后，才允许在 Node 进程中动态执行：

```powershell
$env:SIGN_MODE = 'sign'
$env:SIGN_ALLOW_REMOTE_SDK_EXECUTION = '1'
node tools/run-sign-happydom.mjs

$env:CASTLE_MODE = 'token'
$env:CASTLE_ALLOW_REMOTE_SDK_EXECUTION = '1'
$env:CASTLE_ENABLE_IFRAME = '1'
node tools/run-castle-happydom.mjs
```

以上两个 SDK 运行需要原项目的 HappyDOM、canvas 环境补丁、监控文件等依赖。若是以 `scripts/` 为目录安装，请相应把命令前缀改成 `scripts/`。

## 资源发现方式

1. 从当前 HTML 中定位仍有稳定语义名的 `entry-client-logged-out-*.js`。
2. 解析 Entry **静态 ESM import**，不把 Vite preload 字符串表当作直接依赖。
3. 通过代码特征确定哈希 Startup 模块：
   - Sign：`jf.x.com`、`.jf.x.com`、`PATCH` 分支；从签名工厂的动态 import 提取 SDK URL。
   - Castle：`responsive_web_castle_sdk_enabled`、`responsive_web_castle_public_key`、`configure({pk:...})`；从调用链确定 SDK，从 Startup 静态依赖确定配套公钥。
4. 下载 SDK 及其静态 import、re-export、**字面量动态 import** 引用的同目录 JS 模块；保留 `B644W4is.js`、`cnfsMYm8.js` 一类哈希名称。
5. 每次建立独立的 ESM 目录，写入 `package.json` (`"type":"module"`)，避免依赖路径不匹配与缓存重复使用。

远端范围限制为 `https://abs.twimg.com/x-web/x-web/` 的 Entry 和 `assets/*.js`；SDK 依赖图最多 **64 个模块 / 50 MiB**，每个资源最多 **10 MiB**。发现存在多个符合代码特征的候选时会失败并要求人工核对。

## 常用兼容选项

| 选项 | 说明 |
| --- | --- |
| `SIGN_SDK_SOURCE=auto\|url\|local` | 默认 `auto`；`url`/`local` 用于人工对照 |
| `CASTLE_SDK_SOURCE=auto\|url\|local` | 默认 `auto`；原手动运行设置 `local` |
| `SIGN_SDK_FETCH_URL` / `CASTLE_SDK_FETCH_URL` | `url` 模式指定 CDN 哈希 JS |
| `SIGN_SDK_PATH` / `CASTLE_SDK_PATH` | `local` 模式指定本地 SDK 文件 |
| `CASTLE_PUBLIC_KEY` | Castle `auto` 时允许覆盖已发现公钥；`url` 模式必需 |
| `CASTLE_ENABLE_IFRAME=0` | Castle 默认开启 iframe 页面加载，可按需关闭；其他外部脚本/CSS/图片仍禁用 |
| `SIGN_SAVE_DISCOVERY_ASSETS=1` / `CASTLE_SAVE_DISCOVERY_ASSETS=1` | 留存 Entry/Startup 源码用于人工校验 |
| `SIGN_SAVE_HTML=1` / `CASTLE_SAVE_HTML=1` | 留存 HTML；文件可能包含与会话相关的信息，不应公开提交 |
| `SIGN_EXPECTED_SDK_SHA256` / `CASTLE_EXPECTED_SDK_SHA256` | 可锁定 SDK 指纹；不配套时拒绝使用 |
| `CASTLE_HTML_PATH` / `SIGN_HTML_PATH` | 本地 HTML 模式，用于固定版本调试 |

Castle 的 `CASTLE_MODE=import|configure|token` 和 Sign 的 `SIGN_MODE=probe|fetch|import|initialize|sign` 仍可使用。两个入口均只有在显式开启 `*_ALLOW_REMOTE_SDK_EXECUTION=1` 后才执行下载的远端 JS；本地 SDK 不受此开关约束。

## 离线回归测试

在仓库根目录运行：

```powershell
node --test tests/sdk-resource-discovery.test.mjs
node --check tools/run-sign-happydom.mjs
node --check tools/run-castle-happydom.mjs
```

测试使用模拟的哈希模块，不访问真实站点。验证包含：Sign/Castle 内容识别、Castle 配套公钥、ESM 相对依赖保存、preload 表排除、非法 URL/路径拒绝。

## 已知边界

- 发现依赖于当前可观察的调用结构；若站点进一步改变代码分支或把动态导入参数改为运行期表达式，需要重新分析。
- 无法静态解析的 `import(variable)` 只产生诊断事件，不会猜测其 URL。
- 辅助文件会优先使用已安装的 `es-module-lexer`；未安装时使用内置的保守词法扫描逻辑，因此不会强制新增 npm 依赖。
- 当前交付经过语法检查与离线测试，但 **未在真实 x.com CDN 上联调**，完整运行结果仍需在你的本地环境验证。
