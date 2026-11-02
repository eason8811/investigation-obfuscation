# Investigation Obfuscation

基于 Node.js 的 JavaScript 反混淆与动态分析实验项目。

本项目主要研究经过压缩、混淆和复杂控制流转换的 JavaScript SDK，通过静态代码分析、AST 转换、浏览器环境模拟与运行时监控，逐步恢复代码的可读性，并验证其在 Node.js 环境中的实际执行行为。

目前重点研究两个对象：

- Castle SDK：浏览器环境检测、设备信息采集及 `createRequestToken()` 的执行机制。
- X Sign SDK：X Web 客户端请求签名模块的加载、初始化及签名数据生成过程。

项目定位为研究、调试与验证工具，并非生产环境 SDK 的完整替代实现。

## 1. 项目目标

现代 JavaScript 混淆技术不仅会压缩变量名称，还可能采用字符串编码、函数包装、控制流平坦化、VM Dispatch 等技术，使代码难以直接阅读和分析。

同时，许多浏览器 SDK 强依赖 DOM、Web API、浏览器状态及异步执行环境。即使成功恢复部分代码结构，也未必能够直接在 Node.js 中运行。

本项目尝试解决以下问题：

1. 如何利用 Babel AST 对 Webcrack 的输出进行进一步可读化。
2. 如何识别并简化字符串解码、透明函数包装与控制流派发逻辑。
3. 如何在 Node.js 中逐步定位 SDK 对浏览器环境的依赖。
4. 如何使用 Happy DOM 构建可观测、可扩展的浏览器模拟环境。
5. 如何记录 SDK 的关键 API 调用、异常、阶段耗时及中间数据。
6. 如何通过真实 Chrome 的运行结果，对 Node.js 中的模拟行为进行验证。
7. 如何保存 HTML、JavaScript 和执行日志，使动态分析具有可追溯性与可重复性。

项目遵循的基本原则是：

> 先理解实际执行过程，再根据证据补充运行环境；通过可重复实验验证模拟结果。

## 2. 当前功能

| 模块                      | 功能                                    | 状态         |
| ----------------------- | ------------------------------------- | ---------- |
| Webcrack                | JavaScript 初步反混淆与结构恢复                 | 已实现        |
| Babel 可读化               | 常量传播、表达式折叠、成员访问规范化                    | 已实现        |
| 函数包装简化                  | 识别并内联满足条件的透明函数调用                      | 已实现        |
| Dispatch 分析             | 静态及受限 VM 模式下的控制流派发简化                  | 实验性        |
| Castle Node Runner      | 在原生 Node.js 中导入、配置和调用 Castle SDK      | 已实现        |
| Castle Happy DOM Runner | 使用 Happy DOM 执行 Castle SDK 并监控浏览器 API | 已实现        |
| Sign SDK 自动发现           | 根据 HTML 追踪实际引用的 Sign SDK              | 已实现        |
| Sign SDK 执行             | 导入、初始化及调用签名函数                         | 已实现        |
| Web Animations 适配       | 模拟颜色、旋转及 Cubic Bézier 动画采样            | 已实现，覆盖特定场景 |
| DOM/API 监控              | 记录 DOM 操作、Web API 调用及异常               | 已实现        |
| 结构化日志                   | 将执行阶段和诊断数据保存为 JSONL                   | 已实现        |
| Chrome 对照               | 对动画计算及签名中间数据进行对照验证                    | 持续进行       |
| 完整浏览器兼容性                | 覆盖 SDK 所需的全部浏览器特性                     | 尚未完成       |
| 签名服务端有效性                | 验证生成结果能否通过目标服务端检查                     | 尚未完成完整验证   |

需要注意：SDK 能够执行并返回字符串，不代表其生成结果已经与真实浏览器完全一致。

## 3. 技术栈

| 技术                           | 用途                           |
| ---------------------------- | ---------------------------- |
| Node.js                      | JavaScript 执行、文件处理和诊断工具运行    |
| pnpm                         | 依赖管理                         |
| Webcrack                     | JavaScript 反混淆与初步代码恢复        |
| Babel                        | AST 解析、遍历、转换及代码生成            |
| Happy DOM                    | Node.js 浏览器 DOM 环境           |
| Happy DOM Global Registrator | 注册全局 `window`、`document` 等对象 |
| Canvas                       | Canvas 2D 绘图环境               |
| Node.js Crypto               | 哈希计算和加密 API 支持               |
| Node.js Test Runner          | 单元测试和回归验证                    |

仓库当前依赖版本包括：

- Webcrack `^2.16.0`
- Babel 8
- Happy DOM `^21.0.4`
- Canvas `^3.2.3`

推荐使用 Node.js 24.x。

仓库当前声明的包管理器版本为 pnpm 12.9.1。

## 4. 项目结构

```
investigation-obfuscation/
│
├── source/
│   ├── castle.umd-DpX19jpb.js
│   ├── rolldown-runtime-CzIIVv5t.js
│   └── sign.o-OkAHSEIP.js
│
├── deobfus/
│   ├── castle-webcrack.js
│   ├── castle-readable.js
│   ├── castle-readable-report.json
│   ├── rolldown-webcrack.js
│   ├── sign-webcrack.js
│   ├── sign-readable.js
│   ├── sign-readable-report.json
│   └── sign-manual.js
│
├── env/
│   ├── env-happydom.mjs
│   ├── env-animation.mjs
│   ├── env-monitor.mjs
│   ├── env-overrides.mjs
│   ├── env-trace.mjs
│   ├── env-completion.js
│   ├── env-performance.mjs
│   ├── env-plugins.mjs
│   └── env-localStorage.js
│
├── tools/
│   ├── webcrack-stage.mjs
│   ├── readable-babel.mjs
│   ├── approved-init-constants.json
│   ├── run-castle-node.mjs
│   ├── run-castle-happydom.mjs
│   └── run-sign-happydom.mjs
│
├── tests/
│   ├── env-animation.test.mjs
│   └── sign-sdk-discovery.test.mjs
│
├── data/                    # 运行时生成，默认不纳入版本管理
│   └── sign-snapshots/
│
├── logs/                    # 运行时生成，默认不纳入版本管理
│
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml
└── README.md
```

### 目录说明

| 目录                     | 作用                                   |
| ---------------------- | ------------------------------------ |
| `source/`              | 保留用于分析的原始 JavaScript 样本              |
| `deobfus/`             | 保存反混淆产物、可读化结果及分析报告                   |
| `env/`                 | 浏览器环境初始化、扩展、适配与监控                    |
| `tools/`               | 静态分析及 SDK 执行入口                       |
| `tests/`               | 自动化测试和回归验证                           |
| `data/sign-snapshots/` | 保存运行时获取的 HTML、入口 JS、中间 JS 及 Sign SDK |
| `logs/`                | 保存 JSONL 结构化诊断日志                     |

其中，`env-completion.js`、`env-performance.mjs`、`env-plugins.mjs` 等属于环境模拟研究模块；并非所有模块都会由当前 Happy DOM 入口直接加载。

## 5. 快速开始

### 5.1 克隆仓库

```
git clone https://github.com/eason8811/investigation-obfuscation.git

cd investigation-obfuscation
```

### 5.2 安装依赖

建议使用 Node.js 24.x。

```
node --version

pnpm --version
```

安装项目依赖：

```
pnpm install
```

如果包管理器提示某些依赖的构建脚本未获批准，应检查 `pnpm-workspace.yaml` 中的构建许可配置及本地安装日志。

项目使用 Canvas 原生依赖，不同操作系统可能需要相应的原生构建环境。

### 5.3 运行测试

当前仓库包含两组主要测试。

动画适配器测试：

```
node --test .\tests\env-animation.test.mjs
```

Sign SDK 资源发现测试：

```
node --test .\tests\sign-sdk-discovery.test.mjs
```

也可以通过 Node.js 内置测试运行器执行测试：

```
node --test
```

注意：当前 `package.json` 中的 `npm test` / `pnpm test` 脚本仍为占位命令，尚未配置为上述测试入口。

# 6. JavaScript 静态反混淆

静态分析分为两个主要阶段：

1. 使用 Webcrack 进行初步反混淆。
2. 使用 Babel AST 对输出结果进一步可读化。

## 6.1 Webcrack 阶段

运行：

```
node .\tools\webcrack-stage.mjs `
  .\source\castle.umd-DpX19jpb.js `
  .\deobfus\castle-rebuilt-webcrack.js
```

其中：

- 第一个参数为输入 JavaScript。
- 第二个参数为输出 JavaScript。

建议实验时使用新的输出文件名，避免覆盖仓库中已经保存的分析成果。

Webcrack 主要负责：

- 初步反混淆。
- JavaScript 代码展开。
- 部分控制流和表达式恢复。
- 生成适合进一步 AST 分析的代码。

Webcrack 的结果并不保证完全可读，因此项目增加了 Babel 可读化阶段。

## 6.2 Babel 可读化

基础用法：

```
node .\tools\readable-babel.mjs `
  --input .\deobfus\castle-rebuilt-webcrack.js `
  --output .\deobfus\castle-rebuilt-readable.js `
  --report .\deobfus\castle-rebuilt-report.json
```

主要功能包括：

- 稳定绑定的常量引用替换。
- 无副作用字面量表达式折叠。
- 合法成员属性访问规范化。
- 透明函数包装调用简化。
- 初始化阶段候选常量收集。
- 可选的 Dispatch 调用分析与简化。

分析结果会生成两个文件：

```
castle-rebuilt-readable.js
castle-rebuilt-report.json
```

前者是代码产物，后者包含转换统计和诊断信息。

### 6.3 Dispatch 分析

项目提供三种 Dispatch 模式：

| 模式    | 参数       | 说明                    |
| ----- | -------- | --------------------- |
| 关闭    | `off`    | 不进行 Dispatch 专项转换，默认值 |
| 静态    | `static` | 尝试通过静态分析解析派发调用        |
| 受限 VM | `vm`     | 在受控条件下求值派发选择器和分支条件    |

实验性 VM 模式：

```
node .\tools\readable-babel.mjs `
  --input .\deobfus\castle-webcrack.js `
  --output .\deobfus\castle-vm-readable.js `
  --report .\deobfus\castle-vm-report.json `
  --trust-single-write `
  --dispatch-mode vm `
  --dispatch-style auto
```

支持的主要参数：

| 参数                     | 说明                         |
| ---------------------- | -------------------------- |
| `--input`              | 输入文件                       |
| `--output`             | 输出文件                       |
| `--report`             | 分析报告路径                     |
| `--allow-init-file`    | 人工审核通过的初始化常量配置             |
| `--trust-single-write` | 实验性地信任单次写入常量               |
| `--dispatch-mode`      | `off`、`static` 或 `vm`      |
| `--dispatch-style`     | `auto`、`inline` 或 `helper` |
| `--max-dispatch-calls` | Dispatch 转换数量上限            |
| `--max-wrapper-calls`  | 透明函数调用转换数量上限               |

特别需要注意：

`--trust-single-write` 和 `--dispatch-mode vm` 均具有实验性质。

VM 模式不会执行整个 SDK，但会对符合条件的派发表达式进行求值。这并不构成针对恶意输入的安全隔离，也不能保证转换前后的代码完全等价。

对于复杂的闭包、动态初始化及环境相关表达式，仍然需要人工审查。

# 7. Castle SDK 动态分析

Castle SDK 研究主要围绕：

```
sdk.configure({ pk });

sdk.createRequestToken();
```

当前提供两种执行环境：

1. 原生 Node.js。
2. Node.js + Happy DOM。

## 7.1 原生 Node.js 执行

入口文件：

```
tools/run-castle-node.mjs
```

示例：

```
node .\tools\run-castle-node.mjs `
  --sdk .\deobfus\castle-readable.js
```

该入口不会主动构造浏览器环境。

主要目的是观察 SDK 在缺失浏览器 API 时的实际行为，以及明确哪些阶段依赖 `window`、`document`、`navigator` 等对象。

支持：

```
node .\tools\run-castle-node.mjs --help
```

常用参数：

| 参数                                 | 说明            |
| ---------------------------------- | ------------- |
| `--sdk`                            | 指定 SDK 文件     |
| `--pk`                             | 指定 Castle 公钥  |
| `--print-token`                    | 输出完整 Token    |
| `--continue-after-configure-error` | 配置失败后继续执行诊断流程 |
| `--help`                           | 查看帮助          |

如果可读化产物仍然导入：

```
import { t as e } from "./rolldown-runtime-CzIIVv5t.js";
```

则需要确保对应 Runtime 文件能够从可读化产物所在目录正确解析。

仓库的 `source/` 目录包含该版本的 Runtime 样本。

## 7.2 Happy DOM 执行

入口文件：

```
tools/run-castle-happydom.mjs
```

通过 Happy DOM 提供基础浏览器对象，并监控 SDK 在不同阶段的运行行为。

当前支持三种执行模式。

| 模式          | 功能                              |
| ----------- | ------------------------------- |
| `import`    | 仅导入 SDK                         |
| `configure` | 导入并执行 `configure()`             |
| `token`     | 导入、配置并调用 `createRequestToken()` |

### 导入测试

```
$env:CASTLE_MODE = "import"

node .\tools\run-castle-happydom.mjs
```

### 配置测试

```
$env:CASTLE_MODE = "configure"

node .\tools\run-castle-happydom.mjs
```

### Token 生成测试

```
$env:CASTLE_MODE = "token"

node .\tools\run-castle-happydom.mjs
```

常用环境变量：

| 环境变量                   | 默认值                          | 作用               |
| ---------------------- | ---------------------------- | ---------------- |
| `CASTLE_MODE`          | `import`                     | 执行模式             |
| `CASTLE_SDK_PATH`      | `deobfus/castle-readable.js` | SDK 文件路径         |
| `CASTLE_PUBLIC_KEY`    | 入口内置的测试公钥                    | Castle 公钥        |
| `CASTLE_ENABLE_IFRAME` | `0`                          | 是否启用 iframe 页面加载 |

在 Token 模式下，入口会记录生成结果的类型、长度和执行情况。

Token 长度、返回类型及是否抛出异常，仅能作为诊断信息，不能单独证明 Token 与真实浏览器一致。

# 8. X Sign SDK 动态分析

Sign SDK 是本项目当前重点研究的另一条执行链。

其研究内容主要包括：

- 当前 HTML 对应的 SDK 自动发现。
- Sign SDK 的动态导入与初始化。
- 请求签名函数调用。
- 浏览器 DOM 与验证数据依赖分析。
- Web Animations API 动画采样。
- `getComputedStyle()` 结果获取。
- SHA-256 输入及签名结果诊断。

入口文件：

```
tools/run-sign-happydom.mjs
```

## 8.1 SDK 自动发现

X Web 客户端使用带构建标识的 JavaScript 资源。

直接固定某个 `sign.o-*.js` 文件名可能导致 SDK 与当前 HTML 不匹配。

因此，项目实现了资源链自动发现：

```
https://x.com/
    │
    ▼
HTML
    │
    ▼
entry-client-logged-out-*.js
    │
    ▼
startup-dynamic-*.js
    │
    ▼
sign.o-*.js
```

自动发现过程中会：

1. 获取 HTML。
2. 提取当前 HTML 引用的入口 JavaScript。
3. 从入口 JavaScript 中解析 Startup 模块。
4. 从 Startup 模块中定位 Sign SDK。
5. 下载 SDK 并计算 SHA-256。
6. 保存用于后续分析的资源快照。

默认只处理符合预期的 X CDN 资源路径，并对发现结果进行校验。

自动下载 SDK 不等于自动执行 SDK。

## 8.2 执行模式

Sign Runner 支持以下模式：

| 模式           | 作用                        |
| ------------ | ------------------------- |
| `probe`      | 独立运行浏览器环境与动画探针            |
| `fetch`      | 获取 HTML、发现 SDK 并检查 DOM 结构 |
| `import`     | 导入 Sign SDK               |
| `initialize` | 执行 SDK 默认导出工厂函数           |
| `sign`       | 初始化后调用签名函数                |

默认模式为：

```
initialize
```

### 运行动画探针

```
$env:SIGN_MODE = "probe"

node .\tools\run-sign-happydom.mjs
```

该模式无需下载 HTML 或 SDK。

主要检查：

- Happy DOM 基础样式计算。
- `Element.animate()`。
- `Animation.currentTime`。
- `getComputedStyle()` 动画采样。
- 线性插值和自定义 Cubic Bézier 插值。

### 下载 HTML 和 SDK

```
$env:SIGN_MODE = "fetch"
$env:SIGN_SDK_SOURCE = "auto"

$env:SIGN_SAVE_HTML = "1"
$env:SIGN_SAVE_DISCOVERY_ASSETS = "1"

node .\tools\run-sign-happydom.mjs
```

资源会保存到：

```
data/sign-snapshots/
```

例如：

```
html-<sha256>.html
entry-<sha256>.js
startup-<sha256>.js
sdk-<sha256>.mjs
```

文件名使用内容 SHA-256，便于追踪资源版本并避免不同快照相互覆盖。

### 使用本地快照执行 SDK

建议在动态分析阶段优先使用已检查的本地 SDK。

```
$env:SIGN_MODE = "initialize"
$env:SIGN_SDK_SOURCE = "local"

$env:SIGN_HTML_PATH = "data/sign-snapshots/html-<sha256>.html"
$env:SIGN_SDK_PATH = "data/sign-snapshots/sdk-<sha256>.mjs"

node .\tools\run-sign-happydom.mjs
```

其中 `<sha256>` 应替换为实际文件名对应的哈希值。

### 执行签名函数

```
$env:SIGN_MODE = "sign"

$env:SIGN_SDK_SOURCE = "local"
$env:SIGN_HTML_PATH = "data/sign-snapshots/html-<sha256>.html"
$env:SIGN_SDK_PATH = "data/sign-snapshots/sdk-<sha256>.mjs"

$env:SIGN_INPUT = "jf"
$env:SIGN_METHOD = "PATCH"

node .\tools\run-sign-happydom.mjs
```

当前默认签名参数为：

```
signer("jf", "PATCH");
```

该参数组合对应已分析过的特定 Sign SDK 调用分支，不代表所有请求都使用相同参数。

## 8.3 Sign Runner 配置

### 资源相关

| 环境变量                         | 说明                            |
| ---------------------------- | ----------------------------- |
| `SIGN_MODE`                  | 执行模式                          |
| `SIGN_FETCH_URL`             | HTML 获取地址，默认 `https://x.com/` |
| `SIGN_HTML_PATH`             | 使用本地 HTML 文件                  |
| `SIGN_SDK_SOURCE`            | `auto`、`url` 或 `local`        |
| `SIGN_SDK_PATH`              | 本地 SDK 文件                     |
| `SIGN_SDK_FETCH_URL`         | 指定远程 SDK URL                  |
| `SIGN_SAVE_HTML`             | 保存 HTML 快照                    |
| `SIGN_SAVE_DISCOVERY_ASSETS` | 保存入口和 Startup JS              |
| `SIGN_EXPECTED_HTML_SHA256`  | 校验 HTML 指纹                    |
| `SIGN_EXPECTED_SDK_SHA256`   | 校验 SDK 指纹                     |

### 执行与监控相关

| 环境变量                              | 说明                 |
| --------------------------------- | ------------------ |
| `SIGN_INPUT`                      | 签名函数第一个参数          |
| `SIGN_METHOD`                     | 签名函数第二个参数          |
| `SIGN_STRICT_DOM`                 | 是否严格校验关键 DOM 结构    |
| `SIGN_ANIMATION_BRIDGE`           | 是否启用动画计算适配层        |
| `SIGN_ANIMATION_DETAILS`          | 是否记录动画关键帧详情        |
| `SIGN_MONITOR_ANIMATION`          | 是否启用动画与样式监控        |
| `SIGN_DEBUG_DIGEST`               | 是否记录 SHA-256 原始输入  |
| `SIGN_SHOW_RESULT`                | 是否输出完整签名           |
| `SIGN_TIMEOUT_MS`                 | 签名执行超时时间           |
| `SIGN_ALLOW_REMOTE_SDK_EXECUTION` | 是否明确允许执行新下载的远程 SDK |

默认情况下，下载的远程 SDK 不会在非本地模式下未经明确允许而执行。

若确实需要执行已确认可信的远程 SDK，可显式设置：

```
$env:SIGN_ALLOW_REMOTE_SDK_EXECUTION = "1"
```

建议先保存、审查并确认 SDK 来源及版本，再启用此选项。

# 9. Web Animations 环境适配

文件：

```
env/env-animation.mjs
```

Sign SDK 的部分计算依赖浏览器 Web Animations API。

其主要执行过程为：

```
const animation = element.animate(keyframes, options);

animation.pause();

animation.currentTime = time;

const style = window.getComputedStyle(element);
```

在实际测试中，Happy DOM 可以提供部分动画接口，但其计算样式不一定会反映当前动画时间点的颜色和 Transform。

因此，项目实现了一个针对特定场景的动画适配器。

## 9.1 当前支持的范围

- 两端关键帧插值。
- RGB 和十六进制颜色。
- `rotate(deg)`。
- 旋转矩阵转换。
- 线性插值。
- `cubic-bezier()`。
- 自定义 Easing 中超出 `[0, 1]` 的 Y 值。
- 基于 `Animation.currentTime` 的采样。
- 将采样后的 `color`、`transform` 提供给 `getComputedStyle()`。

适配器保留原计算样式对象的其他行为，仅对当前支持的动画属性进行补充。

它并不是完整的 CSS 排版引擎或 Web Animations API 实现。

## 9.2 Chrome 对照验证

项目使用真实 Chromium 环境采集动画样本，并与 Node.js 中的计算结果进行比较。

当前测试覆盖：

- 多个不同时间点的动画采样。
- Cubic Bézier 插值。
- RGB 颜色插值。
- 旋转矩阵计算。
- 对不支持的关键帧形式进行识别。

对应测试：

```
node --test .\tests\env-animation.test.mjs
```

对于实际 SDK，除比较原始计算样式外，还应比较 SDK 最终使用的数值编码结果。

这是因为不同浏览器或模拟实现可能存在浮点数格式差异，而 SDK 的后续计算可能会进行特定精度的舍入。

# 10. 浏览器环境与监控模块

项目将浏览器环境构建和运行时诊断拆分为多个模块。

| 文件                    | 主要职责                            |
| --------------------- | ------------------------------- |
| `env-happydom.mjs`    | 初始化 Happy DOM 和 Canvas          |
| `env-animation.mjs`   | 动画采样及计算样式适配                     |
| `env-monitor.mjs`     | 方法调用监控与统计                       |
| `env-overrides.mjs`   | 浏览器环境检查                         |
| `env-trace.mjs`       | JSONL 结构化日志                     |
| `env-performance.mjs` | Performance 相关接口模拟              |
| `env-plugins.mjs`     | Navigator Plugin/MIME Type 环境模拟 |
| `env-localStorage.js` | LocalStorage 相关实现               |
| `env-completion.js`   | 较早阶段的浏览器环境补充实验                  |

## 10.1 环境初始化原则

Happy DOM 注册后可能修改 Node.js 全局 Web API。

因此，在需要进行网络请求的执行链中，应关注原生 Node.js API 与浏览器模拟 API 的兼容问题。

Sign Runner 当前采用的主要执行顺序为：

```
获取 HTML
    │
    ▼
发现并下载 SDK
    │
    ▼
初始化 Happy DOM
    │
    ▼
注入 HTML
    │
    ▼
安装环境适配器及监控
    │
    ▼
导入 SDK
    │
    ▼
初始化 / 执行
```

其中，HTML 和 SDK 的网络获取安排在 Happy DOM 全局注册之前，以避免原生 `fetch` 与替换后的 Web API 类型发生冲突。

## 10.2 JSONL 结构化日志

SDK 执行时会生成 JSONL 日志。

默认输出目录：

```
logs/
```

例如：

```
logs/
├── castle-<timestamp>.jsonl
└── sign-<timestamp>.jsonl
```

日志主要记录：

- 执行阶段。
- 开始及结束时间。
- 阶段耗时。
- SDK 资源与文件哈希。
- DOM 结构检查结果。
- Web API 调用。
- 动画创建及采样。
- 关键异常。
- 返回值类型及长度。

JSONL 使用每行一个 JSON 对象的形式，便于按事件类型筛选并对比多次执行结果。

例如：

```
{
  type: "animation.bridge.sample",
  element: "DIV",
  currentTime: 190,
  duration: 4096,
  color: "rgb(135, 95, 61)",
  transform: "matrix(...)"
}
```

启用：

```
$env:SIGN_DEBUG_DIGEST = "1"
```

后，还可以记录 SHA-256 的输入字节及十六进制表示。

该功能仅建议在受控调试环境中使用。原始输入、完整签名及 HTML 快照可能包含与请求或会话相关的数据，不应直接公开。

# 11. 动态分析与验证方法

本项目不仅关注 SDK 能否执行，还关注模拟结果与真实浏览器之间的差异。

推荐采用分阶段验证方法。

## 11.1 分阶段执行

对于 Sign SDK，建议按照以下顺序：

```
fetch
  ↓
import
  ↓
initialize
  ↓
sign
```

在执行正式签名之前，可单独运行：

```
probe
```

检查动画环境。

这样可以将网络、SDK 加载、DOM 初始化和签名计算的问题分别定位。

## 11.2 固定分析输入

HTML 和 SDK 可能随时间变化。

直接比较两次独立网络请求的结果，可能因为动态验证数据不同而产生差异。

建议保留并固定：

- HTML 原始响应。
- 对应 SDK 文件。
- HTML SHA-256。
- SDK SHA-256。
- 签名调用参数。
- 关键 DOM 结构。
- 动画参数。
- 执行日志。

通过这些信息构建可重复的实验样本。

## 11.3 逐层比较中间结果

对于 Sign SDK，可按照以下顺序比较：

| 阶段        | 关键数据                        |
| --------- | --------------------------- |
| HTML      | HTML 哈希及验证元数据               |
| DOM       | SVG 数量、选择索引及 Path           |
| Animation | Keyframes、Duration、Easing   |
| Sampling  | CurrentTime、Color、Transform |
| Encoding  | 动画样式的数值编码结果                 |
| Digest    | SHA-256 原始输入                |
| Signature | 最终签名结果                      |

如果最终结果不同，应优先寻找最早产生差异的阶段，而不是直接修改最终编码逻辑。

## 11.4 时间相关数据

当前分析发现，Sign SDK 的部分签名输入包含基于时间计算的动态值。

其形式可以表示为：

```
const elapsedSeconds = Math.floor(
  Date.now() / 1000 - epochOffset
);
```

其中 `epochOffset` 来自当前 SDK 的内部常量。

因此，即使 HTML 和 SDK 完全相同，不同时间执行也可能生成不同的签名输入。

在跨环境对照中，应明确区分：

1. HTML/SDK 决定的稳定数据。
2. 浏览器动画计算得到的数据。
3. 随执行时间变化的动态数据。

必要时可对动态字段进行标准化比较，再分别验证其生成规则。

# 12. 测试与回归

当前自动化测试主要集中在以下两个部分。

### 动画适配

```
node --test .\tests\env-animation.test.mjs
```

验证动画关键帧解析、插值计算以及适配器行为。

### Sign SDK 自动发现

```
node --test .\tests\sign-sdk-discovery.test.mjs
```

验证：

- HTML 到 Entry 的引用解析。
- Entry 到 Startup 的引用解析。
- Startup 到 Sign SDK 的引用解析。
- 资源校验和快照生成逻辑。
- SDK 下载与 Happy DOM 注册的执行顺序。

相关测试使用模拟资源，不要求每次都访问真实网站。

建议在修改可读化逻辑、SDK 发现规则或环境适配器后运行对应测试。

对于尚未覆盖的真实 SDK 行为，仍需结合 Chrome 对照实验进行验证。

# 13. 已知限制

本项目仍处于持续研究和开发阶段。

### 13.1 静态可读化

Babel AST 转换可以改善代码可读性，但无法自动完整恢复：

- 原始变量和函数名称。
- 作者设计时的模块结构。
- 动态生成的运行时逻辑。
- 所有 VM 混淆控制流。
- 完整的业务语义。

部分转换需要结合运行时证据进行人工验证。

### 13.2 浏览器环境模拟

Happy DOM 并不等同于 Chromium。

当前环境不保证完整支持：

- 浏览器原生渲染和布局。
- 全部 CSS 动画及 Web Animations 行为。
- 所有 Canvas 和图形特性。
- 全部 Navigator、Performance 及设备接口。
- 浏览器安全上下文及权限模型。
- 原生 Web IDL 对象的内部行为。

因此，环境适配器采用按需补充策略。

### 13.3 SDK 执行结果

以下现象不能单独证明 SDK 已完全运行正确：

- `import()` 成功。
- `configure()` 成功。
- 签名函数未抛出异常。
- 返回值类型正确。
- Token 或签名长度接近真实浏览器。

对于关键结果，仍需要比较实际输入、中间计算结果及最终输出。

### 13.4 动态资源变化

X Web 客户端的 HTML、JavaScript 资源名称及内部逻辑可能发生变化。

当前自动发现规则基于已经观察到的资源结构，未来可能需要更新。

保存历史快照有助于定位不同版本之间的行为差异。

# 14. 安全与使用说明

本项目用于 JavaScript 程序分析、兼容性研究、调试和授权环境中的技术实验。

使用时请注意：

1. 仅分析有权获取和研究的代码及资源。
2. 不要将未经检查的远程 JavaScript 直接用于具有敏感权限的执行环境。
3. 启用详细日志之前，应确认可能记录的数据范围。
4. 不要将包含会话信息、请求签名、Cookie、Token 或其他敏感内容的日志直接提交到公共仓库。
5. 不应将模拟 SDK 的输出直接视为生产环境中可信的身份验证或安全凭据。
6. 使用第三方 SDK 及服务时，应遵守相应的许可、服务条款和适用法律。

项目中的第三方 JavaScript 样本用于研究和实验。其原始代码的权利归相应权利人所有。

本项目与 Castle 或 X 官方没有关联。