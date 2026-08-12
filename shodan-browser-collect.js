#!/usr/bin/env node
/**
 * Free-tier Shodan web collector with real login.
 * Logs into https://account.shodan.io/login, then scrapes free pages only (max 2).
 *
 * Usage:
 *   SHODAN_USERNAME=xxx SHODAN_PASSWORD=yyy node shodan-browser-collect.js \
 *     --query "http.favicon.hash:-1875761561" --countries US,JP --max-pages 2
 *
 * Auth (one of):
 *   SHODAN_USERNAME + SHODAN_PASSWORD   preferred, full login flow
 *   SHODAN_COOKIE                      already-logged-in Cookie header fallback
 *
 * Optional:
 *   HEADLESS=false
 *   SHODAN_CONTINUE_URL=https://www.shodan.io
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const DEFAULT_QUERY = "http.favicon.hash:-1875761561";
const LOGIN_URL = "https://account.shodan.io/login";
const FALLBACK_COUNTRIES = [
  "US", "CN", "DE", "HK", "SG", "JP", "KR", "GB", "FR", "NL",
  "RU", "IN", "CA", "AU", "BR", "TW", "IE", "SE", "IT", "ES",
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const query = args.query || process.env.SHODAN_QUERY || DEFAULT_QUERY;
  const maxPages = clampInt(args.maxPages || process.env.SHODAN_MAX_PAGES || 2, 1, 2);
  const delayMs = clampInt(args.delay || process.env.SHODAN_DELAY_MS || 2500, 500, 60000);
  const maxCountries = clampInt(args.maxCountries || process.env.SHODAN_MAX_COUNTRIES || 20, 1, 100);
  const outDir = args.outDir || process.env.SHODAN_OUT_DIR || "out";
  const headless = String(args.headless ?? process.env.HEADLESS ?? "true").toLowerCase() !== "false";
  const username = args.username || process.env.SHODAN_USERNAME || "";
  const password = args.password || process.env.SHODAN_PASSWORD || "";
  const cookie = args.cookie || process.env.SHODAN_COOKIE || "";
  const continueUrl = args.continueUrl || process.env.SHODAN_CONTINUE_URL || "https://www.shodan.io";
  const countries = parseCountries(
    args.countries || process.env.SHODAN_COUNTRIES || FALLBACK_COUNTRIES.join(",")
  ).slice(0, maxCountries);

  if (!countries.length) die("No valid countries. Example: --countries US,JP,SG");
  if (!username && !password && !cookie) {
    die("Need login credentials. Set SHODAN_USERNAME + SHODAN_PASSWORD (or SHODAN_COOKIE fallback).");
  }
  if ((username && !password) || (!username && password)) {
    die("Both SHODAN_USERNAME and SHODAN_PASSWORD are required for login.");
  }

  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Query: ${query}`);
  console.log(`Countries (${countries.length}): ${countries.join(",")}`);
  console.log(`Max free pages/country: ${maxPages}`);
  console.log(`Headless: ${headless}`);
  console.log(`Auth mode: ${username ? "username/password login" : "cookie only"}`);

  const browser = await chromium.launch({
    headless,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    locale: "en-US",
    viewport: { width: 1400, height: 900 },
  });

  // Mild stealth: hide webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  if (cookie) {
    await context.addCookies(cookieHeaderToPlaywrightCookies(cookie, ".shodan.io"));
    console.log("Injected SHODAN_COOKIE for .shodan.io");
  }

  const page = await context.newPage();
  const allHosts = [];
  const summary = [];
  let loginOk = false;

  try {
    if (username && password) {
      loginOk = await loginShodan(page, {
        username,
        password,
        continueUrl,
        outDir,
      });
      if (!loginOk) {
        await dumpDebug(page, outDir, "login-failed");
        die("Shodan login failed. Check username/password, captcha, or 2FA. See out/debug-login-failed.*");
      }
      // Persist session for inspection / reuse
      const statePath = path.join(outDir, "shodan-storage-state.json");
      await context.storageState({ path: statePath });
      console.log(`Saved storage state: ${statePath}`);
    } else {
      // Cookie-only path: verify session
      loginOk = await verifyLoggedIn(page, outDir);
      if (!loginOk) {
        await dumpDebug(page, outDir, "cookie-invalid");
        die("SHODAN_COOKIE does not look logged-in. Prefer SHODAN_USERNAME/PASSWORD login.");
      }
    }

    for (const country of countries) {
      for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
        const q = `${query} country:${country}`;
        const url = buildSearchUrl(q, pageNo);
        console.log(`\n>>> ${country} page ${pageNo}: ${url}`);

        let status = "ok";
        let hosts = [];
        let blocked = false;
        let title = "";

        try {
          const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
          await page.waitForTimeout(1500);
          title = await page.title().catch(() => "");
          const finalUrl = page.url();
          const html = await page.content();

          // If redirected to login mid-run, stop
          if (/account\.shodan\.io\/login/i.test(finalUrl) || /\/login/i.test(finalUrl) && !/search/i.test(finalUrl)) {
            status = "session_lost";
            console.warn("  session lost, redirected to login");
            await dumpDebug(page, outDir, `session-lost-${country}-p${pageNo}`);
            summary.push({ country, page: pageNo, hosts: 0, status, title });
            break;
          }

          blocked = looksBlocked(html, title, finalUrl, resp ? resp.status() : 0);
          if (blocked) {
            status = "blocked_or_captcha";
            console.warn(`  blocked/captcha (title=${title})`);
            await dumpDebug(page, outDir, `blocked-${country}-p${pageNo}`);
            summary.push({ country, page: pageNo, hosts: 0, status, title });
            break;
          }

          hosts = extractHostsFromHtml(html);
          const live = await page.$$eval('a[href*="://"]', (as) =>
            as
              .map((a) => a.getAttribute("href") || "")
              .filter((h) => /https?:\/\/(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}/i.test(h))
          );
          for (const href of live) {
            const m = href.match(/((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})/);
            if (m) hosts.push(`${m[1]}:${m[2]}`);
          }
          hosts = uniquePreserveOrder(hosts);
          allHosts.push(...hosts);
          console.log(`  hosts=${hosts.length} sample=${hosts.slice(0, 3).join(", ") || "-"}`);

          const hasNext = await page.locator('div.pagination a:has-text("Next"), a.button:has-text("Next")').count();
          summary.push({ country, page: pageNo, hosts: hosts.length, status, title });

          if (pageNo < maxPages && hasNext === 0) {
            console.log("  no Next button (end of free results for this query), stop country");
            break;
          }
        } catch (err) {
          status = "error";
          console.error(`  error: ${err.message}`);
          summary.push({ country, page: pageNo, hosts: 0, status, error: err.message });
          await dumpDebug(page, outDir, `error-${country}-p${pageNo}`).catch(() => {});
          break;
        }

        if (delayMs) await page.waitForTimeout(delayMs);
      }
    }
  } finally {
    await browser.close();
  }

  const unique = uniquePreserveOrder(allHosts);
  const outCsv = path.join(outDir, "hosts.csv");
  const outTxt = path.join(outDir, "hosts.txt");
  const outSummary = path.join(outDir, "browser-summary.json");

  fs.writeFileSync(outCsv, ["host", ...unique].join("\n") + "\n", "utf8");
  fs.writeFileSync(outTxt, unique.join("\n") + (unique.length ? "\n" : ""), "utf8");
  fs.writeFileSync(
    outSummary,
    JSON.stringify(
      {
        query,
        max_pages: maxPages,
        countries,
        login_ok: loginOk,
        auth_mode: username ? "password" : "cookie",
        unique_hosts: unique.length,
        note: "Logged-in free pages only (1-2). Not a paid pagination bypass.",
        rows: summary,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(`\nUnique hosts: ${unique.length}`);
  console.log(`CSV: ${outCsv}`);
  console.log(`TXT: ${outTxt}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `## Shodan browser collect (login + free pages)`,
      ``,
      `- Query: \`${query}\``,
      `- Auth: ${username ? "username/password" : "cookie"}`,
      `- Login: ${loginOk ? "ok" : "failed"}`,
      `- Countries: ${countries.length}`,
      `- Max pages/country: ${maxPages}`,
      `- Unique hosts: **${unique.length}**`,
      ``,
      `| Country | Page | Hosts | Status |`,
      `|---|---:|---:|---|`,
      ...summary.map(
        (r) =>
          `| ${r.country} | ${r.page} | ${r.hosts ?? 0} | ${r.status || ""}${r.error ? " " + String(r.error).replace(/\|/g, "/") : ""} |`
      ),
      ``,
    ];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"), "utf8");
  }

  if (!unique.length) {
    console.warn("No hosts collected. See out/debug-*.html/png and browser-summary.json.");
    process.exitCode = 2;
  }
}

async function loginShodan(page, { username, password, continueUrl, outDir }) {
  console.log(`\nLogging in via ${LOGIN_URL} ...`);

  // Prefer continue back to www.shodan.io after auth
  const loginWithContinue = new URL(LOGIN_URL);
  // page itself uses hidden continue field; we also set it after load

  const resp = await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(800);

  const title = await page.title().catch(() => "");
  const html = await page.content();
  if (looksBlocked(html, title, page.url(), resp ? resp.status() : 0)) {
    console.error("Login page blocked by captcha/cloudflare");
    await dumpDebug(page, outDir, "login-blocked");
    return false;
  }

  // Already logged in?
  if (await isLoggedInDom(page)) {
    console.log("Already logged in (session present).");
    return true;
  }

  const userInput = page.locator("#username, input[name='username']").first();
  const passInput = page.locator("#password, input[name='password']").first();
  await userInput.waitFor({ state: "visible", timeout: 20000 });
  await passInput.waitFor({ state: "visible", timeout: 20000 });

  await userInput.fill("");
  await userInput.type(username, { delay: 20 });
  await passInput.fill("");
  await passInput.type(password, { delay: 20 });

  // Ensure continue points to www search site
  await page.evaluate((url) => {
    const el = document.querySelector('input[name="continue"]');
    if (el) el.value = url;
  }, continueUrl);

  // Submit
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null),
    page.locator('input[type="submit"][value="Login"], button[type="submit"], input.button-primary').first().click(),
  ]);
  await page.waitForTimeout(1500);

  // Some flows stay on account.*; open www to materialize cookies
  const afterUrl = page.url();
  console.log(`Post-login URL: ${afterUrl}`);

  // Wrong password usually stays on /login with flash error
  const afterHtml = await page.content();
  const afterTitle = await page.title().catch(() => "");
  if (/invalid|incorrect|failed|error/i.test(afterHtml) && /login/i.test(afterUrl)) {
    const errText = await page.locator(".flash, .error, .alert, .notification").allTextContents().catch(() => []);
    console.error("Login rejected:", errText.join(" | ") || "still on login page");
    return false;
  }

  // Verify by hitting account root or www dashboard-ish page
  const ok = await verifyLoggedIn(page, outDir);
  if (!ok) {
    // One more attempt: visit account home
    await page.goto("https://account.shodan.io/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(800);
    if (await isLoggedInDom(page)) {
      console.log("Login OK (account home shows authenticated nav).");
      return true;
    }
    console.error(`Login verification failed. title=${afterTitle} url=${page.url()}`);
    return false;
  }

  console.log("Login OK.");
  return true;
}

async function verifyLoggedIn(page, outDir) {
  // Check account portal first
  await page.goto("https://account.shodan.io/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
  await page.waitForTimeout(800);
  if (await isLoggedInDom(page)) return true;

  // Fallback: www.shodan.io navbar
  await page.goto("https://www.shodan.io/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
  await page.waitForTimeout(800);
  if (await isLoggedInDom(page)) return true;

  await dumpDebug(page, outDir, "verify-login");
  return false;
}

async function isLoggedInDom(page) {
  const url = page.url();
  if (/account\.shodan\.io\/login/i.test(url)) return false;

  // Logged-in account pages usually show Logout / Billing / API keys etc.
  const markers = [
    'a[href="/logout"]',
    'a[href*="logout"]',
    'a[href="/billing"]',
    'text=Logout',
    'text=Log out',
    'text=API Key',
    'text=My Account',
    '.menu-item-account',
  ];
  for (const sel of markers) {
    try {
      if ((await page.locator(sel).count()) > 0) return true;
    } catch {
      // ignore
    }
  }

  // Negative: visible login form
  if ((await page.locator("#username, form[action='/login'] input[name='username']").count()) > 0) {
    return false;
  }

  // Cookie heuristic
  const cookies = await page.context().cookies();
  const names = new Set(cookies.map((c) => c.name.toLowerCase()));
  // common session-ish cookies; names may change, so only soft signal
  const soft = [...names].some((n) => /session|auth|polito|jwt|token|sid/.test(n));
  if (soft && !/\/login/i.test(url)) {
    // weak yes if not on login and has session cookie
    return true;
  }
  return false;
}

async function dumpDebug(page, outDir, tag) {
  const safe = String(tag).replace(/[^a-zA-Z0-9._-]+/g, "_");
  const shot = path.join(outDir, `debug-${safe}.png`);
  const htmlPath = path.join(outDir, `debug-${safe}.html`);
  try {
    await page.screenshot({ path: shot, fullPage: true });
  } catch {}
  try {
    fs.writeFileSync(htmlPath, await page.content(), "utf8");
  } catch {}
  try {
    fs.writeFileSync(
      path.join(outDir, `debug-${safe}-meta.json`),
      JSON.stringify({ url: page.url(), title: await page.title().catch(() => "") }, null, 2)
    );
  } catch {}
  console.log(`Debug saved: ${shot}`);
}

function buildSearchUrl(query, pageNo) {
  const u = new URL("https://www.shodan.io/search");
  u.searchParams.set("query", query);
  if (pageNo > 1) u.searchParams.set("page", String(pageNo));
  return u.toString();
}

function extractHostsFromHtml(html) {
  const hosts = [];
  const text = String(html || "");
  const urlRe = /https?:\/\/((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})(?=[\/\?#'"\s<>)&]|$)/gi;
  let m;
  while ((m = urlRe.exec(text)) !== null) {
    if (isValidIpv4(m[1]) && isValidPort(m[2])) hosts.push(`${m[1]}:${m[2]}`);
  }
  const plainRe = /\b((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})\b/g;
  while ((m = plainRe.exec(text)) !== null) {
    if (isValidIpv4(m[1]) && isValidPort(m[2])) hosts.push(`${m[1]}:${m[2]}`);
  }
  const hostPortRe = /\/host\/((?:\d{1,3}\.){3}\d{1,3})[^"'<\s>]*[?&]port=(\d{1,5})/gi;
  while ((m = hostPortRe.exec(text)) !== null) {
    if (isValidIpv4(m[1]) && isValidPort(m[2])) hosts.push(`${m[1]}:${m[2]}`);
  }
  return uniquePreserveOrder(hosts);
}

function looksBlocked(html, title, finalUrl, status) {
  const h = String(html || "").toLowerCase();
  const t = String(title || "").toLowerCase();
  const u = String(finalUrl || "").toLowerCase();
  if (status === 403 || status === 429) return true;
  if (u.includes("/captcha")) return true;
  if (t.includes("just a moment") || t.includes("attention required") || t.includes("access denied")) return true;
  if (h.includes("cf-browser-verification") || h.includes("cf-challenge") || h.includes("turnstile")) return true;
  return false;
}

function cookieHeaderToPlaywrightCookies(header, domain) {
  return String(header)
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq <= 0) return null;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (!name) return null;
      return { name, value, domain, path: "/", httpOnly: false, secure: true };
    })
    .filter(Boolean);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return out;
}

function parseCountries(s) {
  return uniquePreserveOrder(
    String(s || "")
      .toUpperCase()
      .replace(/COUNTRY:/g, " ")
      .split(/[^A-Z]+/)
      .map((x) => x.trim())
      .filter((x) => /^[A-Z]{2}$/.test(x))
  );
}

function uniquePreserveOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const s = String(x).trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function isValidIpv4(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
}

function isValidPort(p) {
  const n = Number.parseInt(String(p), 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function clampInt(v, min, max) {
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function die(msg) {
  console.error("Error:", msg);
  process.exit(1);
}

main().catch((err) => die(err.stack || err.message));