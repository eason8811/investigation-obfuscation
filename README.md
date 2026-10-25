# Castle SDK 可读化工具（Node.js + Babel）

适用于 **Webcrack 输出的 JavaScript**，默认只进行静态 AST 转换。不会运行待分析的 SDK。

## 1. 清理原来的 REstringer

在已有的 `investigation-obfuscation` 项目根目录（不是本工具包目录）中执行：

```powershell
pnpm list --depth 0
pnpm remove -D restringer flast
pnpm why isolated-vm
```

`isolated-vm` 通常只是 REstringer 的间接依赖，移除 REstringer 后应由 pnpm 自动清理；只有当它仍被列为**项目直接依赖**且确实不再需要时，才执行 `pnpm remove -D isolated-vm`。如果此前还全局安装过 REstringer，可先用 `pnpm list -g --depth 0` 确认，再按需运行 `pnpm remove -g restringer`。

原先人工分阶段生成的 `02-` 到 `11-` 文件属于分析成果，**建议保留**；不自动删除用户数据。`webcrack`、`@babel/parser`、`@babel/traverse` 保留。

添加两个 Babel 工具包：

```powershell
pnpm add -D @babel/generator@^8 @babel/types@^8
```

将本工具包的 `tools` 和 `tests` 中的文件复制到你的项目对应目录。**不要覆盖**原有的 `tools/webcrack-stage.mjs`。

## 2. 一次保守可读化

```powershell
node .\tools\readable-babel.mjs `
  --input .\deobfus\castle-webcrack.js `
  --output .\deobfus\12-babel-readable.js `
  --report .\deobfus\12-babel-report.json

node --check .\deobfus\12-babel-readable.js
```

默认可执行的变换：

1. 稳定原始值内联：绑定之后没有写入的字面量常量。
2. 无副作用的常量字面量表达式折叠（例如 `1 << 3`）。
3. `obj['method']` => `obj.method`（合法标识符时）。
4. 小型透明函数包装调用简化：函数体仅 `return`、每个参数使用恰好一次、入参都是无副作用的简单值、闭包绑定未变化。
5. 收集 `var RP; function CU(){ RP='fillRect' }` 一类候选，但是**默认不跨初始化函数替换**。

该方案使用 Babel 8（要求兼容版本的 Node.js；你目前的 Node 24.21.0 满足条件），生成的代码保留原文件中的 ESM 导入和导出。

不做的变换：自动删除变量/函数、调用字符串解码器、执行 `eval`、删除对 `$[...]` 的写入、有副作用的函数替换、改写原始输入。

## 3. 复核并批准跨初始化函数的常量

查看 `deobfus/12-babel-report.json` 中的 `initializerCandidates`。其中包括候选名称、单次赋值行号、赋值所在函数、引用次数。

在你确认对应初始化流程会在所有引用之前完成、不会发生重新赋值后，将名称加入 `tools/approved-init-constants.json`，例如：

```json
{"allow":["RP"]}
```

执行审核版：

```powershell
node .\tools\readable-babel.mjs `
  --input .\deobfus\castle-webcrack.js `
  --output .\deobfus\13-babel-reviewed.js `
  --report .\deobfus\13-babel-report.json `
  --allow-init-file .\tools\approved-init-constants.json
```

`--trust-single-write` 仅用于临时实验产物：会替换**所有**只出现一次静态赋值的候选，**不证明初始化顺序**。不要把这种输出当作与原始 SDK 行为等价。

```powershell
node .\tools\readable-babel.mjs `
  --input .\deobfus\castle-webcrack.js `
  --output .\deobfus\14-babel-experimental.js `
  --report .\deobfus\14-babel-report.json `
  --trust-single-write
```

在你提供的 1,332,738 字节 Webcrack 样本上，我们实测：

| 模式 | 常量引用替换 | 成员属性规范化 | 透明调用简化 | 耗时 |
| --- | ---: | ---: | ---: | ---: |
| 默认保守模式 | 5,117 | 6 | 约 2,380 | 约 3 秒 |
| 全部单次赋值（仅分析） | 64,484 + 5,265 | 3,617 | 约 2,374 | 约 2.8 秒 |

运行环境为工具作者的测试环境，不能当作你的 Windows 机器上的性能基准。实际替换次数也不代表对应数量的**独立**常量值。实验模式尤其需要人工验证语义。

## 4. 纯 Node 入口：故意暴露缺失浏览器环境的错误

`tools/run-castle-node.mjs` 只使用 Node ESM `import()`，**不安装 Playwright、不创建 `window`、`document`、`navigator` 或其他浏览器模拟对象**。这是为了逐步观察 SDK 的真实环境依赖。导入、配置和创建 Token 三个阶段都分别记录耗时，首个异常保留原始调用堆栈。

你上传的 `castle-webcrack.js` 仍保留以下依赖：

```javascript
import { t as e } from './rolldown-runtime-CzIIVv5t.js';
```

最好把**同一构建版本**的 `rolldown-runtime-CzIIVv5t.js` 放到可读化产物同目录（例如 `deobfus/rolldown-runtime-CzIIVv5t.js`）：

```powershell
node .\tools\run-castle-node.mjs `
  --sdk .\deobfus\12-babel-readable.js `
  --print-token
```

如果暂时拿不到原始 runtime，又不希望出现 `ERR_MODULE_NOT_FOUND`，可以**只为当前样本**实验性地复制一份简化 CommonJS 模块包装器：

```powershell
if (-not (Test-Path .\deobfus\rolldown-runtime-CzIIVv5t.js)) {
  Copy-Item .\tools\rolldown-runtime-compat.mjs `
    .\deobfus\rolldown-runtime-CzIIVv5t.js
}

node .\tools\run-castle-node.mjs `
  --sdk .\deobfus\12-babel-readable.js `
  --print-token
```

注意：兼容文件只处理观察到的 `t(factory)` 包装形式，**不能保证与原 Rolldown runtime 完全相同**，且不会模拟任何浏览器环境。

入口默认公开密钥：

```text
pk_AvRa79bHyJSYSQHnRpcVtzyxetSvFerx
```

实际调用逻辑：

```javascript
await sdk.configure({ pk });
const token = await sdk.createRequestToken();
```

默认只展示 Token 长度和前 24 个字符，传 `--print-token` 才展示完整 Token。如果 `configure()` 报错，但你只想诊断后续方法在缺失初始化状态下的行为，可传 `--continue-after-configure-error`；这种模式**不是正常的 SDK 调用流程**。

**注意**：原应用示例引用的是 `castle.umd-dATz00yt.js`，你提供的 Webcrack 产物来自另一个文件名 `castle.umd-DpX19jpb.js`。目前不能断言两者版本完全一致。即便公开 `pk`，也不代表 SDK 一定能在 Node 中初始化成功。SDK 可能进行实际网络请求，但本入口不会替它补齐环境。

## 5. 校验

```powershell
node --test .\tests\readable-babel.test.mjs
node .\tools\run-castle-node.mjs --sdk .\tests\fake-node-sdk.mjs
node --check .\deobfus\12-babel-readable.js
git -c core.autocrlf=false diff --no-index --stat .\deobfus\castle-webcrack.js .\deobfus\12-babel-readable.js
```

语法检查与 diff **不能**证明运行结果一致。对关键的 `$` 采集、`configure()` 和 `createRequestToken()` 仍应进行原始版与可读化版的对照测试。
