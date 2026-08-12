# Shodan Host Collector (Cloudflare Worker)

按国家拆分 Shodan 查询，在免费额度「每个查询基本只能看第 1 页」的限制下，尽量收集更多 `ip:port`。

默认查询：

```text
http.favicon.hash:-1875761561
```

> **重要**
>
> - 本项目使用 **Shodan 官方 API**，需要你自己的 `SHODAN_API_KEY`。
> - 不提供/不鼓励用 Worker 去爬 `shodan.io` 网页来绕过会员翻页付费（违反 Shodan ToS，且 CF IP 很容易被拦）。
> - 收集到的 host 仅应用于授权的安全研究、资产清点或你有权测试的目标；不要未授权访问/滥用他人服务。

## 思路

免费账号通常对**同一个 query** 只能稳定拿到第 1 页（约 100 条）。  
把 query 拆成：

```text
http.favicon.hash:-1875761561 country:US
http.favicon.hash:-1875761561 country:DE
http.favicon.hash:-1875761561 country:CN
...
```

每个国家都是独立 query，因此各自都能拿第 1 页，覆盖率更高。  
国家列表优先从 Shodan `facets=country` 获取。

## 部署

```bash
cd shodan-host-collector

# 登录 Cloudflare（如未登录）
npx wrangler login

# 写入 Shodan API Key（推荐 secret，不要写进代码）
npx wrangler secret put SHODAN_API_KEY

# 本地调试可建 .dev.vars：
# SHODAN_API_KEY=xxxxxxxx

npx wrangler dev
npx wrangler deploy
```

API Key 在 Shodan 账户页获取：https://account.shodan.io/

## 使用

### 网页 UI

打开 Worker 根路径 `/`：

1. **拉取国家列表**
2. **按国家收集 hosts**（默认每国 1 页）
3. **下载 hosts.csv**（含 `host` 列，可直接丢进 `cloudflare-model-scanner`）

### API

#### 健康检查

```bash
curl "https://<worker>.workers.dev/health"
```

#### 国家列表

```bash
curl "https://<worker>.workers.dev/countries?query=http.favicon.hash:-1875761561"
```

#### 收集单国单页

```bash
curl "https://<worker>.workers.dev/collect?query=http.favicon.hash:-1875761561&country=US&page=1"
```

返回示例字段：

- `hosts`: `["1.2.3.4:4000", "5.6.7.8:443", ...]`
- `csv`: 带表头的 CSV 文本
- `shodan_total`: 该国匹配总数
- `next_page`: 若还有下一页（付费额度才有意义）

#### 一次最多 20 国（每国第 1 页）

```bash
curl "https://<worker>.workers.dev/collect?mode=all_first_pages&countries=US,DE,CN,SG,JP&query=http.favicon.hash:-1875761561"
```

#### 粘贴 HTML / 文本解析（不消耗 API）

如果你在浏览器里手动打开了某个国家的免费结果页，可以把页面 HTML 或文本贴进来：

```bash
curl -X POST "https://<worker>.workers.dev/parse-html" \
  -H "content-type: application/json" \
  -d "{\"html\":\"...(页面源码或含 ip:port 的文本)...\"}"
```

## 参数说明

| 参数 | 默认 | 说明 |
|---|---|---|
| `query` | `http.favicon.hash:-1875761561` | Shodan 查询 |
| `country` | 无 | ISO 国家码，如 `US` |
| `page` | `1` | 页码（每页最多 100 条） |
| `max_pages` | `1` | UI 里每国最多翻几页；免费建议保持 1 |
| `mode` | `page` | `page` / `all_first_pages` |
| `countries` | 无 | `all_first_pages` 时用，逗号分隔，最多 20 |
| `raw` | false | `true` 时附带精简 match 元数据 |
| `min_count` | 1 | `/countries` 过滤很小的国家 |

## 和 model-scanner 联动

1. 本 Worker 导出 `shodan-hosts.csv`（列名 `host`）
2. 打开 `cloudflare-model-scanner` 的 `/`
3. 上传 CSV，扫描 OpenAI 兼容的 `/v1/models`

## 限制与注意

- **Shodan 免费 API** 有查询次数/结果页限制；`page>1` 常会失败或要会员。
- **Cloudflare Worker** 单次请求有子请求数量限制；UI 已按国家分批，避免一次打爆。
- 某些 API key 拿不到 `facets`，此时会退回内置常见国家码列表（可能包含 0 结果国家）。
- 结果是公网暴露面情报，**不等于**可以未授权使用这些服务。

## 目录

```text
shodan-host-collector/
  worker.js
  wrangler.toml
  README.md
```

## GitHub Action：浏览器抓免费前 2 页

网页结果每页大约 **10 条**，未登录/免费账号通常只能看第 1 页，有时能到第 2 页。  
这个 Action 用 Playwright 打开 `shodan.io/search`，按国家拆查询，**最多翻 2 页**，提取结果里的 `ip:port`（来自外链如 `https://1.2.3.4:4000`）。

> 不做付费翻页绕过；`max_pages` 硬限制为 1–2。

### 文件

- `shodan-browser-collect.js` — 浏览器采集脚本
- `.github/workflows/shodan-browser-collect.yml` — GitHub Action
- `shodan-api-collect.js` — 官方 API 方案（更稳，需要 API Key）

### 配置

1. 把本目录推到 GitHub 仓库（或复制 workflow + 脚本到仓库根目录）
2. （强烈建议）在仓库 Secrets 加 `SHODAN_USERNAME / SHODAN_PASSWORD (or SHODAN_COOKIE)`  
   浏览器登录免费账号后，F12 → Network → 任意 shodan 请求 → 复制整段 `Cookie:`
3. Actions → **Shodan Browser Collect (free pages)** → Run workflow
4. 参数示例：
   - `query`: `http.favicon.hash:-1875761561`
   - `countries`: `US,JP,SG,DE,CN`
   - `max_pages`: `2`
5. 运行结束后下载 artifact：`hosts.csv` / `hosts.txt`

### 本地跑

```bash
cd shodan-host-collector
npm install
npx playwright install chromium

# 可选：导出 Cookie
# set SHODAN_USERNAME / SHODAN_PASSWORD (or SHODAN_COOKIE)=session=...; ...

node shodan-browser-collect.js \
  --query "http.favicon.hash:-1875761561" \
  --countries US,JP,SG \
  --max-pages 2 \
  --out-dir out
```

### 注意

- GitHub Actions 机房 IP 很容易被 Cloudflare/Shodan 拦；没有 `SHODAN_USERNAME / SHODAN_PASSWORD (or SHODAN_COOKIE)` 时可能 0 结果，artifact 里会有 `debug-*.html/png` 方便排查。
- 网页免费页覆盖远小于 API；想多拿结果请继续用「按国家拆 query」+ 官方 API。
- 结果仅用于授权测试/资产清点，不要未授权访问他人服务。


## 登录说明（必须）

浏览器抓取免费页需要登录：https://account.shodan.io/login

GitHub Secrets：

1. `SHODAN_USERNAME` — Shodan 用户名
2. `SHODAN_PASSWORD` — Shodan 密码
3. （可选）`SHODAN_COOKIE` — 额外 Cookie

脚本会：

1. 打开登录页
2. 填写 `#username` / `#password` 并提交
3. 校验是否出现 Logout / Billing 等已登录标记
4. 再按国家抓免费第 1–2 页，提取 `ip:port`

本地：

```bash
set SHODAN_USERNAME=your_user
set SHODAN_PASSWORD=your_pass
node shodan-browser-collect.js --countries US,JP --max-pages 2 --out-dir out
```
