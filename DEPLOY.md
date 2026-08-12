# 部署到 GitHub Actions

本目录需要作为 **GitHub 仓库根目录** 推送（这样 `.github/workflows/` 才会生效）。

## 1. 创建仓库

1. 打开 https://github.com/new
2. 新建一个空仓库（不要勾选自动加 README，避免冲突）
3. 记住仓库地址，例如：`https://github.com/你的用户名/shodan-host-collector.git`

## 2. 本地推送（PowerShell）

在本机执行（把远程地址换成你的）：

```powershell
cd C:\Users\Lenovo\Desktop\codex-program\shodan-host-collector

git init
git add shodan-browser-collect.js shodan-api-collect.js parse-shodan-html.js package.json README.md .gitignore .github
git commit -m "Add Shodan free-page browser collector Action"
git branch -M main
git remote add origin https://github.com/你的用户名/shodan-host-collector.git
git push -u origin main
```

如果 `git add` 想全量推送也可以：

```powershell
git add .
git commit -m "Add Shodan host collector"
git push -u origin main
```

> 不要把密码写进任何文件。`.gitignore` 已忽略 `out/`、`node_modules/`、`.env`。

## 3. 配置 Secrets（必须）

打开仓库页面：

**Settings → Secrets and variables → Actions → New repository secret**

添加：

| Name | Value |
|---|---|
| `SHODAN_USERNAME` | 你的 Shodan 用户名 |
| `SHODAN_PASSWORD` | 你的 Shodan 密码（建议用改过的新密码） |

可选：

| Name | Value |
|---|---|
| `SHODAN_COOKIE` | 浏览器已登录 Cookie（备用） |

## 4. 开启并运行 Action

1. 打开仓库 **Actions** 页
2. 若提示 Enable workflows，点允许
3. 左侧选 **Shodan Browser Collect (login + free pages)**
4. 点右侧 **Run workflow**
5. 填写参数，例如：
   - `query`: `http.favicon.hash:-1875761561`
   - `countries`: `US,JP,SG,DE,CN`
   - `max_pages`: `2`
   - `max_countries`: `10`
6. 点绿色 **Run workflow**

## 5. 下载结果

1. 进入这次 run 详情
2. 等 job 结束（约几分钟到十几分钟）
3. 页面底部 **Artifacts** 下载 `shodan-browser-hosts-<run_id>`
4. 解压得到：
   - `hosts.csv` / `hosts.txt` → `ip:port` 列表
   - `browser-summary.json` → 每国每页统计
   - 若失败：`debug-*.html/png` 可看登录/拦截原因

## 6. 常见问题

### Actions 里找不到 workflow
- 确认 `.github/workflows/shodan-browser-collect.yml` 在**仓库根目录**下
- 确认已 push 到 `main`/`master`
- 打开 Actions 是否被禁用

### 登录失败 / 0 结果
- Secrets 名称必须完全一致：`SHODAN_USERNAME`、`SHODAN_PASSWORD`
- GitHub 机房 IP 可能被 Cloudflare 拦，看 artifact 里的 `debug-login-*.png`
- 可先本机跑通：
  ```powershell
  $env:SHODAN_USERNAME="..."
  $env:SHODAN_PASSWORD="..."
  $env:HEADLESS="false"
  node shodan-browser-collect.js --countries US --max-pages 1 --out-dir out
  ```

### 只想用 API、不登录网页
另有 workflow：`Shodan Host Collect`  
Secrets 改用 `SHODAN_API_KEY`（https://account.shodan.io/）

## 需要的核心文件

```text
shodan-host-collector/
  .github/workflows/shodan-browser-collect.yml
  shodan-browser-collect.js
  package.json
  .gitignore
```