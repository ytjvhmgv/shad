#!/usr/bin/env node
/**
 * Free-tier Shodan browser collector (deep facet split)
 *
 * country
 *   -> city facet
 *     -> port facet
 *       -> org facet
 *         -> search page 1..2  => host:port
 *
 * Limits keep free-page scraping practical.
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
  const delayMs = clampInt(args.delay || process.env.SHODAN_DELAY_MS || 2000, 300, 60000);
  const maxCountries = clampInt(args.maxCountries || process.env.SHODAN_MAX_COUNTRIES || 10, 1, 100);
  const maxCities = clampInt(args.maxCities || process.env.SHODAN_MAX_CITIES || 15, 0, 200);
  const maxPorts = clampInt(args.maxPorts || process.env.SHODAN_MAX_PORTS || 8, 0, 100);
  const maxOrgs = clampInt(args.maxOrgs || process.env.SHODAN_MAX_ORGS || 8, 0, 100);
  // If current bucket result count <= threshold, do NOT go deeper; paginate here.
  const splitThreshold = clampInt(args.splitThreshold || process.env.SHODAN_SPLIT_THRESHOLD || 20, 1, 1000);
  const outDir = args.outDir || process.env.SHODAN_OUT_DIR || "out";
  const headless = String(args.headless ?? process.env.HEADLESS ?? "true").toLowerCase() !== "false";
  const username = String(args.username || process.env.SHODAN_USERNAME || "").trim();
  const password = String(args.password || process.env.SHODAN_PASSWORD || "");
  const cookie = args.cookie || process.env.SHODAN_COOKIE || "";
  const continueUrl = args.continueUrl || process.env.SHODAN_CONTINUE_URL || "https://www.shodan.io";
  const proxyUrl = args.proxy || process.env.PROXY_URL || process.env.SHODAN_PROXY || "";
  const cfWaitMs = clampInt(args.cfWait || process.env.CF_WAIT_MS || 45000, 0, 180000);
  // deep=true: country->city->port->org ; city-only if false
  const deep = String(args.deep ?? process.env.SHODAN_DEEP ?? "true").toLowerCase() !== "false";
  const byCity = String(args.byCity ?? process.env.SHODAN_BY_CITY ?? "true").toLowerCase() !== "false";

  const countries = parseCountries(
    args.countries || process.env.SHODAN_COUNTRIES || FALLBACK_COUNTRIES.join(",")
  ).slice(0, maxCountries);

  if (!countries.length) die("No valid countries");
  if (!username && !password && !cookie) die("Need SHODAN_USERNAME+PASSWORD or SHODAN_COOKIE");
  if ((username && !password) || (!username && password)) die("Need both username and password");

  fs.mkdirSync(outDir, { recursive: true });
  const proxy = parseProxy(proxyUrl);

  console.log("Query:", query);
  console.log("Countries:", countries.join(","));
  console.log("Deep facet chain:", deep ? "country -> city -> port -> org -> pages" : (byCity ? "country -> city -> pages" : "country -> pages"));
  console.log("Split only when count > " + splitThreshold + " (count <= threshold => paginate here)");
  console.log("Limits: cities/country=" + maxCities + " ports/city=" + maxPorts + " orgs/port=" + maxOrgs + " pages=" + maxPages);
  console.log("Proxy:", proxy ? redactProxy(proxyUrl) : "(none)");

  const launchOpts = {
    headless,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
  };
  if (proxy) launchOpts.proxy = proxy;

  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    locale: "en-US",
    viewport: { width: 1400, height: 900 },
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  if (cookie) await context.addCookies(cookieHeaderToPlaywrightCookies(cookie, ".shodan.io"));

  const page = await context.newPage();
  const allHosts = [];
  const summary = [];
  const tree = [];
  let loginOk = false;
  let stopAll = false;

  try {
    if (username && password) {
      loginOk = await loginShodan(page, { username, password, continueUrl, outDir, cfWaitMs });
      if (!loginOk) {
        await dumpDebug(page, outDir, "login-failed");
        die("Login failed");
      }
      await context.storageState({ path: path.join(outDir, "shodan-storage-state.json") });
    } else {
      loginOk = await verifyLoggedIn(page, outDir, cfWaitMs);
      if (!loginOk) die("Cookie session invalid");
    }

    // Helper: scrape free pages for a concrete query bucket
    async function scrapeBucket(parts, meta) {
      for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
        if (stopAll) return;
        const q = buildQuery(query, parts);
        const url = buildSearchUrl(q, pageNo);
        const label = [parts.country, parts.city, parts.port ? ("p" + parts.port) : null, parts.org]
          .filter(Boolean)
          .join("/");
        console.log("\n>>> " + label + " page " + pageNo + (meta && meta.reason ? " [" + meta.reason + "]" : ""));
        console.log("    " + url);
        try {
          const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
          await waitForCloudflare(page, cfWaitMs);
          const title = await page.title().catch(() => "");
          const finalUrl = page.url();
          const html = await page.content();

          if (/account\.shodan\.io\/login/i.test(finalUrl)) {
            summary.push({ ...parts, page: pageNo, hosts: 0, status: "session_lost", title, reason: meta && meta.reason });
            await dumpDebug(page, outDir, "session-lost");
            stopAll = true;
            return;
          }
          if (looksBlocked(html, title, finalUrl, resp ? resp.status() : 0)) {
            summary.push({ ...parts, page: pageNo, hosts: 0, status: "blocked", title, reason: meta && meta.reason });
            await dumpDebug(page, outDir, "blocked-" + safeTag(label) + "-p" + pageNo);
            return;
          }

          let hosts = extractHostsFromHtml(html);
          const live = await page
            .$$eval('a[href*="://"]', (as) =>
              as
                .map((a) => a.getAttribute("href") || "")
                .filter((h) => /https?:\/\/(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}/i.test(h))
            )
            .catch(() => []);
          for (const href of live) {
            const m = href.match(/((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})/);
            if (m) hosts.push(m[1] + ":" + m[2]);
          }
          hosts = uniquePreserveOrder(hosts);
          allHosts.push(...hosts);
          console.log("    hosts=" + hosts.length + " sample=" + (hosts.slice(0, 3).join(", ") || "-"));

          const hasNext = await page
            .locator('div.pagination a:has-text("Next"), a.button:has-text("Next")')
            .count();
          summary.push({
            ...parts,
            page: pageNo,
            hosts: hosts.length,
            status: "ok",
            title,
            reason: meta && meta.reason,
            count: meta && meta.count,
          });
          if (pageNo < maxPages && hasNext === 0) return;
        } catch (err) {
          console.error("    error:", err.message);
          summary.push({ ...parts, page: pageNo, hosts: 0, status: "error", error: err.message, reason: meta && meta.reason });
          await dumpDebug(page, outDir, "error-" + safeTag(label) + "-p" + pageNo).catch(() => {});
          return;
        }
        if (delayMs) await page.waitForTimeout(delayMs);
      }
    }

    function shouldSplit(count) {
      // unknown count => allow split attempt (facet may still help)
      if (count == null || count === "") return true;
      const n = Number(count);
      if (!Number.isFinite(n)) return true;
      return n > splitThreshold;
    }

    for (const country of countries) {
      if (stopAll) break;
      const countryNode = { country, decision: null, cities: [] };
      tree.push(countryNode);

      // Country level: we usually don't know exact total; use city facet when deep/byCity.
      // If city facet fails/empty, paginate at country level.
      if (!(byCity || deep) || maxCities <= 0) {
        countryNode.decision = "paginate-country (city split disabled)";
        await scrapeBucket({ country, city: null, port: null, org: null }, { reason: countryNode.decision });
        continue;
      }

      console.log("\n=== " + country + " city facet ===");
      const cities = await fetchFacetValues(page, {
        query,
        country,
        city: null,
        port: null,
        facet: "city",
        limit: maxCities,
        outDir,
        cfWaitMs,
        delayMs,
      });

      if (!cities.length) {
        countryNode.decision = "paginate-country (no city facet)";
        await scrapeBucket({ country, city: null, port: null, org: null }, { reason: countryNode.decision });
        continue;
      }

      // Optional: if ALL city counts sum < threshold, still iterate cities but each may paginate early.
      console.log(
        "  cities:",
        cities
          .slice(0, 10)
          .map((c) => c.name + "(" + (c.count != null ? c.count : "?") + ")")
          .join(", ")
      );

      for (const cityObj of cities) {
        if (stopAll) break;
        const city = cityObj.name;
        const cityCount = cityObj.count;
        const cityNode = { city, count: cityCount, decision: null, ports: [] };
        countryNode.cities.push(cityNode);

        if (!shouldSplit(cityCount) || !deep) {
          cityNode.decision =
            !deep ? "paginate-city (deep=false)" : "paginate-city (count<=" + splitThreshold + ")";
          console.log("  -> " + country + "/" + city + " " + cityNode.decision + " count=" + cityCount);
          await scrapeBucket(
            { country, city, port: null, org: null },
            { reason: cityNode.decision, count: cityCount }
          );
          continue;
        }

        // city large enough -> port facet
        if (maxPorts <= 0) {
          cityNode.decision = "paginate-city (maxPorts=0)";
          await scrapeBucket({ country, city, port: null, org: null }, { reason: cityNode.decision, count: cityCount });
          continue;
        }

        console.log("\n--- " + country + "/" + city + " port facet (city count=" + cityCount + ") ---");
        const ports = await fetchFacetValues(page, {
          query,
          country,
          city,
          port: null,
          facet: "port",
          limit: maxPorts,
          outDir,
          cfWaitMs,
          delayMs,
        });

        if (!ports.length) {
          cityNode.decision = "paginate-city (no port facet)";
          await scrapeBucket({ country, city, port: null, org: null }, { reason: cityNode.decision, count: cityCount });
          continue;
        }

        console.log(
          "  ports:",
          ports.map((p) => p.name + "(" + (p.count != null ? p.count : "?") + ")").join(", ")
        );

        for (const portObj of ports) {
          if (stopAll) break;
          const port = portObj.name;
          const portCount = portObj.count;
          const portNode = { port, count: portCount, decision: null, orgs: [] };
          cityNode.ports.push(portNode);

          if (!shouldSplit(portCount)) {
            portNode.decision = "paginate-port (count<=" + splitThreshold + ")";
            console.log("  -> " + country + "/" + city + "/p" + port + " " + portNode.decision + " count=" + portCount);
            await scrapeBucket(
              { country, city, port, org: null },
              { reason: portNode.decision, count: portCount }
            );
            continue;
          }

          if (maxOrgs <= 0) {
            portNode.decision = "paginate-port (maxOrgs=0)";
            await scrapeBucket({ country, city, port, org: null }, { reason: portNode.decision, count: portCount });
            continue;
          }

          console.log(
            "\n... " + country + "/" + city + "/port:" + port + " org facet (port count=" + portCount + ") ..."
          );
          const orgs = await fetchFacetValues(page, {
            query,
            country,
            city,
            port,
            facet: "org",
            limit: maxOrgs,
            outDir,
            cfWaitMs,
            delayMs,
          });

          if (!orgs.length) {
            portNode.decision = "paginate-port (no org facet)";
            await scrapeBucket({ country, city, port, org: null }, { reason: portNode.decision, count: portCount });
            continue;
          }

          console.log(
            "  orgs:",
            orgs
              .slice(0, 8)
              .map((o) => o.name + "(" + (o.count != null ? o.count : "?") + ")")
              .join(" | ")
          );

          for (const orgObj of orgs) {
            if (stopAll) break;
            const org = orgObj.name;
            const orgCount = orgObj.count;
            // org is leaf level: always paginate (no deeper facet)
            const decision =
              orgCount != null && orgCount <= splitThreshold
                ? "paginate-org (leaf, count<=" + splitThreshold + ")"
                : "paginate-org (leaf)";
            portNode.orgs.push({ org, count: orgCount, decision });
            console.log("  -> org=" + org + " " + decision + " count=" + orgCount);
            await scrapeBucket(
              { country, city, port, org },
              { reason: decision, count: orgCount }
            );
          }
        }
      }
    }

  } finally {
    await browser.close();
  }

  const unique = uniquePreserveOrder(allHosts);
  fs.writeFileSync(path.join(outDir, "hosts.csv"), ["host", ...unique].join("\n") + "\n", "utf8");
  fs.writeFileSync(path.join(outDir, "hosts.txt"), unique.join("\n") + (unique.length ? "\n" : ""), "utf8");
  fs.writeFileSync(path.join(outDir, "facet-tree.json"), JSON.stringify({ query, deep, limits: { maxCountries, maxCities, maxPorts, maxOrgs, maxPages, splitThreshold }, tree }, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(outDir, "browser-summary.json"), JSON.stringify({
    query, deep, login_ok: loginOk, proxy: proxy ? redactProxy(proxyUrl) : null,
    unique_hosts: unique.length, rows: summary,
  }, null, 2) + "\n", "utf8");

  console.log("\nUnique hosts:", unique.length);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      "## Shodan deep facet collect",
      "",
      "- Query: `" + query + "`",
      "- Chain: country → city → port → org → pages",
      "- Unique hosts: **" + unique.length + "**",
      "",
      "| Country | City | Port | Org | Page | Hosts | Status | Reason |",
      "|---|---|---|---|---:|---:|---|---|",
      ...summary.slice(0, 300).map((r) =>
        "| " + [r.country, r.city||"-", r.port||"-", (r.org||"-").toString().replace(/\|/g,"/").slice(0,40), r.page, r.hosts||0, r.status||"", (r.reason||"").toString().replace(/\|/g,"/").slice(0,40)].join(" | ") + " |"
      ),
      "",
    ];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"), "utf8");
  }
  if (!unique.length) process.exitCode = 2;
}

async function fetchFacetValues(page, opts) {
  const { query, country, city, port, facet, limit, outDir, cfWaitMs, delayMs } = opts;
  const facetUrl = buildFacetUrl(query, { country, city, port }, facet);
  console.log("  facet url:", facetUrl);
  try {
    const resp = await page.goto(facetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForCloudflare(page, cfWaitMs);
    const title = await page.title().catch(() => "");
    const html = await page.content();
    if (looksBlocked(html, title, page.url(), resp ? resp.status() : 0)) {
      console.warn("  facet blocked:", facet);
      await dumpDebug(page, outDir, "facet-blocked-" + safeTag([country, city, port, facet].filter(Boolean).join("-")));
      return [];
    }
    let values = extractFacetValuesFromHtml(html, facet);
    if (!values.length) {
      // live DOM fallback
      const hrefs = await page.$$eval("a[href*='search']", (as) => as.map((a) => a.getAttribute("href") || "")).catch(() => []);
      values = extractFacetValuesFromHtml(hrefs.join("\n"), facet);
    }
    values = values.slice(0, limit);
    const tag = [country, city, port ? "p"+port : null, facet].filter(Boolean).join("-");
    fs.writeFileSync(path.join(outDir, "facet-" + safeTag(tag) + ".json"), JSON.stringify({ url: facetUrl, facet, values }, null, 2) + "\n");
    if (delayMs) await page.waitForTimeout(Math.min(delayMs, 1500));
    return values;
  } catch (err) {
    console.error("  facet error:", err.message);
    return [];
  }
}

function extractFacetValuesFromHtml(html, facet) {
  const text = String(html || "");
  const values = [];
  const seen = new Set();

  function add(name, count) {
    name = String(name || "").trim();
    if (!name) return;
    // decode
    try { name = decodeURIComponent(name.replace(/\+/g, " ")); } catch { name = name.replace(/\+/g, " "); }
    name = name.replace(/&amp;/g, "&").replace(/&quot;/g, '"').trim();
    if (facet === "port") {
      if (!/^\d{1,5}$/.test(name)) return;
      if (Number(name) < 1 || Number(name) > 65535) return;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    values.push({ name, count: count == null ? null : Number(String(count).replace(/,/g, "")) || null });
  }

  // Pattern A: standard Shodan facets-card
  // <a href="/search?query=...+port%3A443"...><strong>443</strong></a> ... <div class="value">188</div>
  const cardRe = /href="(?:\[)?(\/search\?query=[^"\]]+)(?:\]\([^)]+\))?"[^>]*>[\s\S]*?<strong>([^<]*)<\/strong>[\s\S]{0,260}?<div class="value">\s*([\d,]+)\s*<\/div>/gi;
  let m;
  while ((m = cardRe.exec(text)) !== null) {
    const href = m[1];
    const strong = m[2];
    const count = m[3];
    if (facet === "port") {
      const pm = href.match(/port%3A(\d{1,5})/i) || href.match(/[?+&]port:(\d{1,5})/i) || strong.match(/^(\d{1,5})$/);
      if (pm) add(pm[1], count);
    } else if (facet === "org") {
      const om = href.match(/org%3A%22([^%"]+)%22/i) || href.match(/org:"([^"]+)"/i);
      add(om ? om[1] : strong, count);
    } else if (facet === "city") {
      const cm = href.match(/city%3A%22([^%"]+)%22/i) || href.match(/city:"([^"]+)"/i);
      add(cm ? cm[1] : strong, count);
    } else {
      add(strong, count);
    }
  }

  // Pattern B: bare encoded tokens
  if (!values.length) {
    if (facet === "port") {
      const re = /port%3A(\d{1,5})/gi;
      while ((m = re.exec(text)) !== null) add(m[1], null);
    } else if (facet === "org") {
      const re = /org%3A%22([^%"]+)%22/gi;
      while ((m = re.exec(text)) !== null) add(m[1], null);
    } else if (facet === "city") {
      const re = /city%3A%22([^%"]+)%22/gi;
      while ((m = re.exec(text)) !== null) add(m[1], null);
    }
  }

  values.sort((a, b) => (b.count || 0) - (a.count || 0));
  return values;
}

function buildQuery(base, parts) {
  let q = String(base || "").trim();
  if (parts.country) q += ' country:"' + parts.country + '"';
  if (parts.city) q += ' city:"' + parts.city + '"';
  if (parts.port) q += " port:" + parts.port;
  if (parts.org) q += ' org:"' + parts.org + '"';
  return q.replace(/\s+/g, " ").trim();
}

function buildSearchUrl(query, pageNo) {
  const u = new URL("https://www.shodan.io/search");
  u.searchParams.set("query", query);
  if (pageNo > 1) u.searchParams.set("page", String(pageNo));
  return u.toString();
}

function buildFacetUrl(baseQuery, parts, facet) {
  const q = buildQuery(baseQuery, parts || {});
  const u = new URL("https://www.shodan.io/search/facet");
  u.searchParams.set("query", q);
  u.searchParams.set("facet", facet);
  return u.toString();
}

function extractHostsFromHtml(html) {
  const hosts = [];
  const text = String(html || "");
  let m;
  const urlRe = /https?:\/\/((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})(?=[\/?#'"\s<>)&]|$)/gi;
  while ((m = urlRe.exec(text)) !== null) {
    if (isValidIpv4(m[1]) && isValidPort(m[2])) hosts.push(m[1] + ":" + m[2]);
  }
  const plainRe = /\b((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})\b/g;
  while ((m = plainRe.exec(text)) !== null) {
    if (isValidIpv4(m[1]) && isValidPort(m[2])) hosts.push(m[1] + ":" + m[2]);
  }
  return uniquePreserveOrder(hosts);
}

async function loginShodan(page, { username, password, continueUrl, outDir, cfWaitMs }) {
  console.log("\nLogging in via", LOGIN_URL);
  const resp = await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  const passedCf = await waitForCloudflare(page, cfWaitMs || 45000);
  const title = await page.title().catch(() => "");
  const html = await page.content();
  if (!passedCf || looksBlocked(html, title, page.url(), resp ? resp.status() : 0)) {
    await dumpDebug(page, outDir, "login-blocked");
    return false;
  }
  if (await isLoggedInDom(page)) return true;
  const userInput = page.locator("#username, input[name='username']").first();
  const passInput = page.locator("#password, input[name='password']").first();
  await userInput.waitFor({ state: "visible", timeout: 20000 });
  await passInput.waitFor({ state: "visible", timeout: 20000 });
  await userInput.fill(username);
  await passInput.fill(password);
  await page.evaluate((url) => {
    const el = document.querySelector('input[name="continue"]');
    if (el) el.value = url;
  }, continueUrl);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => null),
    page.locator('input[type="submit"][value="Login"], button[type="submit"], input.button-primary').first().click(),
  ]);
  await waitForCloudflare(page, cfWaitMs);
  await page.waitForTimeout(800);
  console.log("Post-login URL:", page.url());
  const after = await page.content();
  if (/invalid username or password/i.test(after)) {
    console.error("Login rejected: Invalid username or password");
    return false;
  }
  if (await verifyLoggedIn(page, outDir, cfWaitMs)) return true;
  await page.goto("https://account.shodan.io/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
  await waitForCloudflare(page, Math.min(cfWaitMs || 20000, 20000));
  return await isLoggedInDom(page);
}

async function verifyLoggedIn(page, outDir, cfWaitMs) {
  await page.goto("https://account.shodan.io/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
  await waitForCloudflare(page, Math.min(cfWaitMs || 20000, 30000));
  if (await isLoggedInDom(page)) return true;
  await page.goto("https://www.shodan.io/", { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
  await waitForCloudflare(page, Math.min(cfWaitMs || 20000, 30000));
  if (await isLoggedInDom(page)) return true;
  await dumpDebug(page, outDir, "verify-login");
  return false;
}

async function waitForCloudflare(page, timeoutMs) {
  const budget = Math.max(0, Number(timeoutMs) || 0);
  if (!budget) return true;
  const start = Date.now();
  while (Date.now() - start < budget) {
    const title = (await page.title().catch(() => "")).toLowerCase();
    const html = await page.content().catch(() => "");
    const blocked =
      title.includes("just a moment") ||
      title.includes("attention required") ||
      /performing security verification/i.test(html) ||
      /cf-browser-verification|cf-challenge|challenge-platform/i.test(html);
    if (!blocked) {
      const useful =
        (await page.locator("#username, .result-container, .facets-card, a[href*='logout'], .name strong").count().catch(() => 0)) > 0 ||
        (html.length > 1500 && !/Enable JavaScript and cookies to continue/i.test(html));
      if (useful) return true;
    }
    await page.waitForTimeout(1500);
  }
  const title = await page.title().catch(() => "");
  return !/just a moment|attention required/i.test(title);
}

async function isLoggedInDom(page) {
  if (/account\.shodan\.io\/login/i.test(page.url())) return false;
  for (const sel of ['a[href="/logout"]', 'a[href*="logout"]', 'a[href="/billing"]', "text=Logout", "text=API Key"]) {
    try { if ((await page.locator(sel).count()) > 0) return true; } catch {}
  }
  if ((await page.locator("#username, form[action='/login'] input[name='username']").count()) > 0) return false;
  const cookies = await page.context().cookies();
  return cookies.some((c) => /session|auth|token|sid/i.test(c.name)) && !/\/login/i.test(page.url());
}

async function dumpDebug(page, outDir, tag) {
  const safe = safeTag(tag);
  try { await page.screenshot({ path: path.join(outDir, "debug-" + safe + ".png"), fullPage: true }); } catch {}
  try { fs.writeFileSync(path.join(outDir, "debug-" + safe + ".html"), await page.content(), "utf8"); } catch {}
  try {
    fs.writeFileSync(path.join(outDir, "debug-" + safe + "-meta.json"), JSON.stringify({ url: page.url(), title: await page.title().catch(() => "") }, null, 2));
  } catch {}
}

function safeTag(tag) {
  return String(tag || "x").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 100);
}

function looksBlocked(html, title, finalUrl, status) {
  const h = String(html || "").toLowerCase();
  const t = String(title || "").toLowerCase();
  if (status === 403 || status === 429) return true;
  if (t.includes("just a moment") || t.includes("attention required") || t.includes("access denied")) return true;
  if (h.includes("performing security verification") || h.includes("cf-challenge") || h.includes("turnstile")) return true;
  if (h.includes("challenge-platform") && t.includes("just a moment")) return true;
  return false;
}

function parseProxy(raw) {
  const str = String(raw || "").trim();
  if (!str) return null;
  let urlStr = str;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(str)) {
    const parts = str.split(":");
    if (parts.length === 2) urlStr = "socks5://" + parts[0] + ":" + parts[1];
    else if (parts.length >= 4) {
      urlStr = "socks5://" + encodeURIComponent(parts[2]) + ":" + encodeURIComponent(parts.slice(3).join(":")) + "@" + parts[0] + ":" + parts[1];
    } else throw new Error("bad PROXY_URL");
  }
  const u = new URL(urlStr);
  const protocol = u.protocol.replace(":", "").toLowerCase();
  const serverProtocol = protocol === "socks5h" ? "socks5" : protocol;
  const defPort = serverProtocol.startsWith("socks") ? "1080" : "8080";
  const out = { server: serverProtocol + "://" + u.hostname + ":" + (u.port || defPort) };
  if (u.username) out.username = decodeURIComponent(u.username);
  if (u.password) out.password = decodeURIComponent(u.password);
  return out;
}
function redactProxy(raw) {
  try { const p = parseProxy(raw); return p.username ? p.server + " (auth=yes)" : p.server; } catch { return "(set)"; }
}
function cookieHeaderToPlaywrightCookies(header, domain) {
  return String(header).split(";").map((p) => p.trim()).filter(Boolean).map((part) => {
    const eq = part.indexOf("="); if (eq <= 0) return null;
    return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim(), domain, path: "/", secure: true };
  }).filter((x) => x && x.name);
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
  return uniquePreserveOrder(String(s || "").toUpperCase().replace(/COUNTRY:/g, " ").split(/[^A-Z]+/).map((x) => x.trim()).filter((x) => /^[A-Z]{2}$/.test(x)));
}
function uniquePreserveOrder(arr) {
  const seen = new Set(); const out = [];
  for (const x of arr) { const s = String(x).trim(); if (!s || seen.has(s)) continue; seen.add(s); out.push(s); }
  return out;
}
function isValidIpv4(ip) {
  const parts = String(ip).split(".");
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
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
function die(msg) { console.error("Error:", msg); process.exit(1); }

main().catch((e) => die(e.stack || e.message));
