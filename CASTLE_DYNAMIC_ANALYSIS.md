# Castle SDK：真实 Chrome 动态观测（v0.2）

> 实验目标：确定 SDK 实际读取的浏览器环境、调用顺序、可观察返回值，
> 并确认安装观测代理后，真实页面产生的 Token 仍然能被正常业务请求接受。

## v0.2 更新

- 将单项事件上限从 240 提高到 10,000，总上限提高到 30,000；上一轮约 4,625 次调用不应再因旧阈值被截断。
- `querySelector()` 记录 `found` / `resultTag`，`getComputedStyle()` 增加属性数量。
- Canvas DataURL、像素数据和测量文本增加 **采样哈希**；不导出图片、像素数组、原始文本。哈希并非密码学摘要，不保证绝对无碰撞。
- `watchSdk()` 幂等：重复代理同一个 SDK 不会继续堆叠包装器；每次调用获得独立 `callId`、耗时和结果类型。
- fetch/XHR 额外判断最新 Token 是否出现在 Header 或**可读取的字符串请求体**中，导出匹配的 `callId` 与字段路径，不导出任何 Token、Header 值、请求体、响应体。
- 对 `Request`、Blob、Stream 等非字符串请求体默认不进行读取，避免消费流或改变业务行为。`bodyTokenMatch=false` 不等于请求没有使用 Token。

## 1. 实验条件

- Windows 11 + 真实 Chrome，使用自己正常登录的页面和浏览器环境。
- 不使用 Playwright 自动启动浏览器；先用 DevTools `Sources > Snippets` 手动注入。
- `Network` 开启 **Preserve log**，必要时保持 DevTools 打开。
- 先做一轮 **无注入基线**：按页面正常操作一次，确认相应请求的 HTTP 状态、响应业务字段、页面结果。
- 针对登录等有副作用的请求，每次只通过正常 UI 发起一次；不要无条件重放 `PATCH` 请求。

## 2. 注入和采集

1. 打开目标页面，按 F12，进入 `Sources > Snippets`，新建 `castle-browser-observer-v0.2`。
2. 将 `castle-browser-observer.js` 的全部内容粘贴进去并运行（Ctrl+Enter）。
   - 如果同一页面已经运行 v0.1，先执行旧版的 `__castleObserver.download()`、`__castleObserver.stop()`，再运行新版。
3. 在控制台执行：

   ```js
   __castleObserver.status();
   __castleObserver.mark('before-normal-request');
   ```

4. 使用网页自己的按钮/流程触发 Token 生成及请求，不要在控制台自动重放或修改请求。
5. 操作结束后执行：

   ```js
   __castleObserver.mark('after-normal-request');
   __castleObserver.status().requests;

   // 只看 begin_login 的请求及本地关联结果
   __castleObserver.status().requests.filter(r => r.url.includes('/begin_login'));
   ```

6. **先完成业务请求，再执行主动环境快照**：

   ```js
   __castleObserver.snapshotEnvironment();
   __castleObserver.download();
   ```

   输出 `castle-browser-trace-*.jsonl`，包含 API 访问事件、调用栈摘要、请求方法/路径/状态、浏览器能力快照。
   默认不会导出 Token、Cookie、Authorization 值、请求体、响应体、URL 查询参数。

7. 采集结束后可执行 `__castleObserver.stop()`，恢复被覆盖的原始方法。

## 3. 如果能在断点处拿到 SDK 对象

本工具不会猜测动态模块的变量名。在 `Sources` 中定位 `createRequestToken()` 调用点，设置断点；
当断点暂停、控制台能访问到局部变量中的 SDK 实例时，可执行：

```js
__castleObserver.watchSdk(sdk); // 将 sdk 替换为暂停帧中真实的变量
```

随后继续运行。代理将捕获 `configure` / `createRequestToken` 的执行、Promise 结果、Token 长度，
并在**内存中**暂存少量新 Token，以对比它们是否出现在随后 fetch/XHR 的 Header 值中。
导出的 JSONL 只包含匹配到的 **Header 名称**，不含 Header 值或 Token 内容。

若 `watchSdk()` 返回 `{ok:false}`，请检查当前变量是否为真正的 SDK facade、方法是否位于只读属性上。
不要强行重写不可配置的属性。

对同一个实例重复调用时，v0.2 可能返回：

```js
{ok: true, patchedMethods: 0, alreadyPatchedMethods: 2}
```

这表示原来的代理仍有效，不需要重新包装。每次 `createRequestToken()` 将产生具有相同 `callId` 的
`SDK.createRequestToken.start`、`SDK.createRequestToken.resolved` 和 `SDK.token.resolved`（成功时）。

如果请求 body 是普通 JSON 字符串，匹配成功时请求记录可能具有以下形式（仅演示字段，不是真实结果）：

```js
{
  bodyKind: 'string',
  bodyTokenMatch: true,
  bodyTokenCallIds: [1],
  bodyFieldPaths: ['$.data.castleToken'],
  status: 200
}
```

`bodyTokenCallIds` 用于与 SDK 事件的 `callId` 对应。该机制只进行内存中的原文匹配；
如果站点对 Token 进行了编码、分片或转换，则可能无法匹配。没有匹配不能视为 Token 无效。

## 4. 如何判断 Token 仍然可用

对照 DevTools `Network` 中同一请求：

| 对照 | 要确认的证据 | 含义 |
| --- | --- | --- |
| A：不注入 | 原生流程正常，记录目标请求及业务结果 | 真实浏览器基线 |
| B：注入后 | 相同业务动作仍成功；HTTP 与响应业务字段正常 | 探针没有明显破坏 Token/请求 |
| B：`watchSdk()` 成功时 | `SDK.token.resolved` + `tokenHeaderNames` 或 `bodyTokenCallIds` 匹配 | 新 Token 与请求 Header/字符串请求体可关联 |
| 后续 C：Happy DOM | 仅在取得完整请求契约及授权测试场景后验证 | 判断模拟环境 Token 是否能被服务端接受 |

注意：**HTTP 2xx 不等于业务成功，也不自动证明服务端核验了 Token**。需要结合响应 JSON 的
`errors`、业务 `status`、页面状态变化等判断。
此外，匹配结果为空不代表 Token 未使用：它可能在不可读取的请求体、非 fetch/XHR 通道，
或者生成 Token 的调用早于 `watchSdk()` 安装。

## 5. 代码段的覆盖盲区

- Snippet 在**运行的那一刻**才对页面上下文生效；页面刷新后不会自动再次注入。
- 如果 Castle SDK 在首屏就完成了初始化，这份代码只能观察后续 API 访问，不能声称拿到了完整初始化调用链。
- 普通页面中的 `Worker`、跨源 iframe、Service Worker 与其他 JS realm 不一定被覆盖；以 Network 面板补充观察。
- Hook 本身会改变函数身份、耗时以及 `Function.prototype.toString()` 结果；尤其 v0.2 增加了事件与哈希计算，必须重新做 A/B 对照。
- `maxEvents`、`maxEventsPerApi` 仍然是有限值，应检查导出记录中的 `dropped` 是否为 0。
- CSS、Canvas、Navigator、DOM 观察结果可能包含浏览器指纹和使用习惯；分享 JSONL 前应检查其中的调用栈、选择器和属性值。
- `snapshotEnvironment()` 会主动创建 WebGL 上下文并读取环境，**只在验证业务请求后调用**。
- 如要观察首次加载，下一阶段使用 DevTools **Local Overrides** 将相同探针放在 SDK 之前，或在可控页面使用 CDP 的 preload 机制；不能简单地在 Snippet 后刷新页面。

## 6. 下一轮请提供的数据

1. 无注入（A）与注入后（B）的请求 HTTP 状态、脱敏业务响应/错误码。
2. `castle-browser-trace-*.jsonl`（上传前可再检查调用栈及路径中是否有个人信息）。
3. 若 `watchSdk` 无法安装：`createRequestToken` 所在调用点附近的代码片段、暂停时的局部变量名称，**不包含真实 Token / Cookie / 密码**。

有这些数据之后，才能将 API 采集列表与 Happy DOM 的调用结果逐项对齐，识别高价值差异，
并进入“早期初始化覆盖”与“模拟环境 Token 验证”阶段。

## 参考

- Chrome 官方文档：Snippets https://developer.chrome.com/docs/devtools/javascript/snippets
- Chrome 官方文档：Local Overrides https://developer.chrome.com/docs/devtools/overrides
- Chrome 官方文档：Network https://developer.chrome.com/docs/devtools/network/reference
