const fs = require("fs");
const path = require("path");

/**
 * Collect hosts from Shodan official API using country split.
 * Requires SHODAN_API_KEY.
 *
 * Usage:
 *   node shodan-api-collect.js --query "http.favicon.hash:-1875761561" --countries US,JP,SG --pages 1 --out hosts.csv
 *   node shodan-api-collect.js --auto-countries --min-count 1 --max-countries 40 --pages 1
 */

const DEFAULT_QUERY = "http.favicon.hash:-1875761561";

// Fallback when facets are unavailable on free keys.
const FALLBACK_COUNTRIES = [
  "US", "CN", "DE", "HK", "SG", "JP", "KR", "GB", "FR", "NL",
  "RU", "IN", "CA", "AU", "BR", "TW", "IE", "SE", "CH", "IT",
  "ES", "PL", "FI", "NO", "DK", "BE", "AT", "CZ", "PT", "IL",
  "AE", "SA", "TR", "ID", "TH", "VN", "MY", "PH", "MX", "ZA",
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = process.env.SHODAN_API_KEY || args.key;
  if (!apiKey) die("Missing SHODAN_API_KEY env or --key");

  const query = args.query || process.env.SHODAN_QUERY || DEFAULT_QUERY;
  const pages = clampInt(args.pages || process.env.SHODAN_PAGES || 1, 1, 20);
  const delayMs = clampInt(args.delay || process.env.SHODAN_DELAY_MS || 1200, 0, 60000);
  const minCount = clampInt(args.minCount || process.env.SHODAN_MIN_COUNT || 1, 1, 1000000);
  const maxCountries = clampInt(args.maxCountries || process.env.SHODAN_MAX_COUNTRIES || 50, 1, 250);
  const outDir = args.outDir || process.env.SHODAN_OUT_DIR || ".";
  const outCsv = path.join(outDir, args.out || "hosts.csv");
  const outTxt = path.join(outDir, args.txt || "hosts.txt");
  const outSummary = path.join(outDir, args.summary || "shodan-api-summary.json");
  const outCountries = path.join(outDir, "countries.json");

  fs.mkdirSync(outDir, { recursive: true });

  let countries;
  if (args.autoCountries || String(process.env.SHODAN_AUTO_COUNTRIES || "").toLowerCase() === "true") {
    console.log("Resolving countries via Shodan facets...");
    countries = await resolveCountries(apiKey, query, minCount, maxCountries);
  } else {
    countries = parseCountries(
      args.countries || process.env.SHODAN_COUNTRIES || FALLBACK_COUNTRIES.join(",")
    ).slice(0, maxCountries);
  }

  if (!countries.length) die("No countries to query");

  fs.writeFileSync(
    outCountries,
    JSON.stringify({ query, min_count: minCount, countries }, null, 2) + "\n",
    "utf8"
  );

  console.log(`Query: ${query}`);
  console.log(`Countries (${countries.length}): ${countries.join(",")}`);
  console.log(`Pages/country: ${pages}`);
  console.log(`Delay ms: ${delayMs}`);

  const hosts = [];
  const summary = [];

  for (const country of countries) {
    for (let page = 1; page <= pages; page++) {
      const q = `${query} country:${country}`;
      const url = new URL("https://api.shodan.io/shodan/host/search");
      url.searchParams.set("key", apiKey);
      url.searchParams.set("query", q);
      url.searchParams.set("page", String(page));

      try {
        const data = await fetchJson(url);
        const matches = Array.isArray(data.matches) ? data.matches : [];
        const pageHosts = [];
        for (const m of matches) {
          if (m.ip_str && m.port != null) {
            const h = `${m.ip_str}:${m.port}`;
            hosts.push(h);
            pageHosts.push(h);
          }
        }
        const row = {
          country,
          page,
          total: data.total ?? null,
          returned: matches.length,
          hosts: pageHosts.length,
        };
        summary.push(row);
        console.log(
          `${country} page ${page}: returned=${matches.length} hosts=${pageHosts.length} total=${data.total ?? "?"}`
        );
        if (!matches.length) break;
        if (data.total != null && page * 100 >= data.total) break;
      } catch (err) {
        summary.push({ country, page, error: err.message });
        console.error(`${country} page ${page}: ${err.message}`);
        // Free keys often fail on page > 1; keep going to next country.
        break;
      }

      if (delayMs) await sleep(delayMs);
    }
  }

  const unique = uniquePreserveOrder(hosts);
  fs.writeFileSync(outCsv, ["host", ...unique].join("\n") + "\n", "utf8");
  fs.writeFileSync(outTxt, unique.join("\n") + (unique.length ? "\n" : ""), "utf8");
  fs.writeFileSync(
    outSummary,
    JSON.stringify(
      {
        query,
        pages_per_country: pages,
        countries,
        unique_hosts: unique.length,
        rows: summary,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(`Unique hosts: ${unique.length}`);
  console.log(`CSV: ${outCsv}`);
  console.log(`TXT: ${outTxt}`);
  console.log(`Summary: ${outSummary}`);

  // GitHub Actions job summary helper
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `## Shodan collect`,
      ``,
      `- Query: \`${query}\``,
      `- Countries: ${countries.length}`,
      `- Pages/country: ${pages}`,
      `- Unique hosts: **${unique.length}**`,
      ``,
      `| Country | Page | Returned | Hosts | Total | Error |`,
      `|---|---:|---:|---:|---:|---|`,
      ...summary.map((r) =>
        `| ${r.country} | ${r.page} | ${r.returned ?? ""} | ${r.hosts ?? ""} | ${r.total ?? ""} | ${r.error ? String(r.error).replace(/\|/g, "/") : ""} |`
      ),
      ``,
    ];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"), "utf8");
  }
}

async function resolveCountries(apiKey, query, minCount, maxCountries) {
  const url = new URL("https://api.shodan.io/shodan/host/search");
  url.searchParams.set("key", apiKey);
  url.searchParams.set("query", query);
  url.searchParams.set("facets", "country");
  url.searchParams.set("page", "1");

  try {
    const data = await fetchJson(url);
    const facet = (data.facets && data.facets.country) || [];
    const fromFacet = facet
      .map((x) => ({ code: String(x.value || "").toUpperCase(), count: Number(x.count) || 0 }))
      .filter((x) => /^[A-Z]{2}$/.test(x.code) && x.count >= minCount)
      .sort((a, b) => b.count - a.count)
      .slice(0, maxCountries)
      .map((x) => x.code);

    if (fromFacet.length) {
      console.log(`Facet countries: ${fromFacet.join(",")}`);
      return fromFacet;
    }
    console.warn("No country facets returned; falling back to built-in list.");
  } catch (err) {
    console.warn(`Facet lookup failed (${err.message}); falling back to built-in list.`);
  }
  return FALLBACK_COUNTRIES.slice(0, maxCountries);
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "shodan-host-collector/1.0 (+github-actions)",
    },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON HTTP ${res.status}: ${text.slice(0, 180).replace(/\s+/g, " ")}`);
  }
  if (!res.ok || data.error) {
    throw new Error(String(data.error || data.message || `HTTP ${res.status}`));
  }
  return data;
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

function clampInt(v, min, max) {
  const n = Number.parseInt(String(v), 10);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function die(msg) {
  console.error("Error:", msg);
  process.exit(1);
}

main().catch((err) => die(err.stack || err.message));
