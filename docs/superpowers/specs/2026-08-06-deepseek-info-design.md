# Codex Quota 扩展增加 DeepSeek 调用信息

日期：2026-08-06
状态：已认可设计，待实现

## 目标

在现有 Codex 额度顶栏小组件（GNOME Shell 扩展）基础上，新增一个 DeepSeek
平台面板标签，展示余额、今日 token 用量、今日费用、今日调用次数，
并在下拉菜单中展示按模型的完整明细。Token 支持自动从 Chrome localStorage
读取，也支持在设置界面手动粘贴。

## 背景与已验证事实

DeepSeek 平台（platform.deepseek.com）的用量/余额页面背后是内部 API，
**不接受 API key 鉴权**，而是使用网页登录态 token（`userToken`），通过
`Authorization: Bearer <userToken>` 访问。已在真实环境验证：

| 数据 | 接口 | 返回示例 |
|---|---|---|
| 余额/总消费 | `GET /api/v0/users/get_user_summary` | 余额 ¥95.35、总消费 ¥24.65 |
| token 用量 | `GET /api/v0/usage/by_api_key/amount?start&end&tz` | 每 API key × 模型的每日请求数、PROMPT_CACHE_HIT/MISS_TOKEN、RESPONSE_TOKEN |
| 费用 | `GET /api/v0/usage/by_api_key/cost?start&end&tz` | 每 key × 模型的每日费用（字符串小数） |

请求要求（已验证，否则 429 被 WAF 拦截）：

- `Authorization: Bearer <userToken>`
- 浏览器指纹头：`x-client-bundle-id: com.deepseek.chat`、
  `x-client-platform: web`、`x-client-version: 1.0.0`、
  `x-client-locale: zh-CN`、`x-client-timezone-offset: 480`
- `User-Agent`（Chrome UA）、`Referer: https://platform.deepseek.com/usage`、
  `Origin: https://platform.deepseek.com`
- 时间参数必须对齐 UTC 零点（天粒度）：`start` = 某日 UTC 零点秒，
  `end` = `start` 后 N 天的 UTC 零点秒，`tz=0`。非对齐参数返回
  `biz_code:1, biz_msg:"INVALID_PARAM"`。

`userToken` 在 Chrome 中以明文存于 localStorage leveldb：

- 路径：`~/.config/google-chrome/<Profile>/Local Storage/leveldb/*.ldb|.log`
- 记录键：`_https://platform.deepseek.com\x00\x01userToken`
- 值：`{"value":"<token>","__version":"0"}`

Chrome localStorage 不加密（与 cookie 不同，cookie 才用 keyring 加密），
因此可直接字节扫描解析。当前用户 Chrome 中暂无有效 `userToken`
（登录态已失效），故设置界面手动粘贴是必经路径，自动读取为增强。

## 用户已确认的决策

1. 顶栏显示：余额、今日 token、今日费用、今日次数，全部展示。
2. 刷新频率：60 秒自动刷新，与 Codex 一致；另有手动刷新。
3. 菜单明细：余额（总/赠/充值）、按模型用量明细、更新时间，文本形式。
4. token 失效：顶栏显示 `DeepSeek !`，菜单提示到设置更新 token。
5. Chrome localStorage 解析：字节扫描的轻量实现（尽力而为，读不到回落手动）。
6. 方案 A+B 一次做齐（自动读 Chrome + 设置界面粘贴）。

## 架构与组件

### 新增文件

**`deepseek.js`** — 纯逻辑 + 网络层（可独立测试）：

- `extractUserTokenFromChrome()` → 扫描
  `~/.config/google-chrome/*/Local Storage/leveldb/*.ldb|.log`，
  搜索 `_https://platform.deepseek.com\x00\x01userToken` 记录，
  提取 `"value":"..."`，返回 token 或 `null`。
- `buildUsageRange(rangeDays = 1)` → 返回 `{startSec, endSec}`
  对齐 UTC 零点（end 为明日零点）。
- `normalizeSummary(payload)` → `{totalBalance, grantedBalance,
  toppedUpBalance, totalCost}`（按币种，本实现以 CNY 为主，多币种取首个）。
- `normalizeUsage(payload)` → 按模型聚合的
  `[{model, requests, tokens}]`，tokens = cacheHit + cacheMiss + response。
- `normalizeCost(payload)` → `[{model, cost}]`。
- `summarizeToday(usageData, costData)` → `{requests, tokens, cost}`。
- `fetchDeepseekData(token, range)` → 用 Gio 并发拉
  `get_user_summary` + usage amount + usage cost，返回
  `{summary, usage, cost}`；任一接口 token 失效抛 `TokenInvalidError`。
  （Gio 网络请求直接实现，复用现有 `_applyDesktopProxy` 代理逻辑。）

**`prefs.js`** — 扩展设置窗口（`ExtensionPreferences`）：

- 文本输入框粘贴/编辑 `userToken`。
- "从 Chrome 自动读取"按钮：调 `extractUserTokenFromChrome()` 填充输入框。
- 保存到 GSettings schema 的 `deepseek-token` key。

**`schemas/org.gnome.shell.extensions.codex-quota.gschema.xml`** — 新 schema：

- `deepseek-token`（string，默认 `''`）：DeepSeek 平台 userToken。
- 既有 Codex 设置若未来需要可扩展，当前仅此一个 key。

**`tests/test-deepseek.js`** — GJS 单元测试：

- `buildUsageRange` 时间对齐。
- `normalizeSummary` / `normalizeUsage` / `normalizeCost` / `summarizeToday`
  基于真实抓包样本的 fixtures。
- `extractUserTokenFromChrome` 用构造的临时 leveldb 字节样本。

### 修改文件

**`extension.js`**：

- 新增 `DeepSeekIndicator`（`PanelMenu.Button`），与 `CodexQuotaIndicator`
  并列，通过 `Main.panel.addToStatusArea` 添加到 Codex 右侧。
- 顶栏 label：`¥95.0 · 52次 · 18万t · ¥0.11`（缺数据项用 `--` 占位；
  全部无数据显示 `DeepSeek --`；token 无效显示 `DeepSeek !`）。
- 下拉菜单：
  - 状态行（余额总额 / 赠送 / 充值 / 总消费）
  - 各模型用量行（模型名：N次 · Mtoken · ¥x.xx）
  - 更新时间行
  - 分隔线 + 「立即刷新」「打开用量面板」
    （`https://platform.deepseek.com/usage`）+ 「设置」
  - token 无效时状态行显示提示「token 已失效，请在设置中更新」
- 逻辑：`_startServer` 处同时启动 DeepSeek 拉取；60s 定时刷新；
  `_applyDesktopProxy` 复用于 Gio HTTP。
- token 来源顺序：GSettings `deepseek-token` → 无则
  `extractUserTokenFromChrome()` → 仍无则显示提示状态。

**`metadata.json`**：加 `"settings-schema": "org.gnome.shell.extensions.codex-quota"`。

**`install.sh`**：复制 `deepseek.js`、`prefs.js`、schemas 目录，
并执行 `glib-compile-schemas`。

**`stylesheet.css`**：新增 DeepSeek 警告/失效配色类
（复用 `codex-quota-warning/critical` 或新增 `.deepseek-quota-*`）。

**`README.md`**：补充 DeepSeek 功能说明、token 获取方式、设置步骤。

## 数据流

```
启动/60s定时
   ↓
读取 token（GSettings → Chrome 扫描）
   ↓
buildUsageRange(今日 UTC 零点对齐)
   ↓
fetchDeepseekData() ──并行──► get_user_summary → normalizeSummary
                    │          usage/amount → normalizeUsage
                    └─Gio 代理   usage/cost   → normalizeCost
   ↓
summarizeToday() → {requests, tokens, cost}
   ↓
顶栏 label + 菜单明细 渲染
```

## 错误处理

- **token 失效**（401 或响应含 INVALID_TOKEN）：捕获为
  `TokenInvalidError`，顶栏 `DeepSeek !`（critical 色），菜单提示去设置更新。
- **WAF 429**：提示「请求被拦截」，延时重试（下个刷新周期）。
- **网络错误/超时**：显示「无法连接」，保持上次数据。
- **Chrome 解析失败/无 token**：顶栏显示 `DeepSeek --`，菜单提示
  「未配置 token，请在设置中粘贴或自动读取」。
- 任一子请求失败不影响其他子请求结果渲染。

## 测试计划

- `gjs -m tests/test-deepseek.js` 跑纯函数单测（构造样本 + 真实抓包 fixtures）。
- 现有 `tests/test-quota.js` 保持通过。
- 手动：安装后顶栏出现 DeepSeek 标签；设置粘贴 token 后 60s 内显示数据；
  无 token 时显示提示；Chrome 扫描路径用一个临时假 profile 验证。
- 日志检查：`journalctl --user -f -o cat /usr/bin/gnome-shell`。

## 限制与后续

- 目前只支持 Chrome/Chromium 系 localStorage 自动读取；Firefox 未做。
- 多币种场景先取 CNY（当前账号为 CNY）。
- 未来可扩展：Firefox 读取、token 有效期可视化、自定义刷新频率。
