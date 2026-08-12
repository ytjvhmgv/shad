#!/usr/bin/env node
/**
 * Batch parse saved Shodan HTML/text files and extract ip:port hosts.
 *
 * Usage:
 *   node parse-shodan-html.js "C:\path\to\saved-pages" -o hosts.csv
 *   node parse-shodan-html.js page1.html page2.html -o hosts.csv --txt hosts.txt
 *   node parse-shodan-html.js pages --default-port 4000
 *
 * This script only parses files you already have locally. It does not crawl Shodan.
 */

const fs = require("fs");
const path = require("path");

function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("-h") || args.includes("--help")) {
    printHelp();
    process.exit(args.length ? 0 : 1);
  }

  const inputs = [];
  let outCsv = "shodan-hosts.csv";
  let outTxt = "shodan-hosts.txt";
  let defaultPort = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-o" || a === "--out" || a === "--csv") {
      outCsv = args[++i];
    } else if (a === "--txt") {
      outTxt = args[++i];
    } else if (a === "--default-port") {
      defaultPort = normalizePort(args[++i]);
      if (!defaultPort) die("Invalid --default-port");
    } else {
      inputs.push(a);
    }
  }

  if (!inputs.length) die("No input files/directories");

  const files = uniquePreserveOrder(inputs.flatMap(collectFiles));
  if (!files.length) die("No .html/.htm/.txt files found");

  const allHosts = [];
  const perFile = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const parsed = extractHostsFromShodanHtml(text, { defaultPort });
    allHosts.push(...parsed.hosts);
    perFile.push({ file, count: parsed.hosts.length, debug: parsed.debug });
  }

  const hosts = uniquePreserveOrder(allHosts);
  fs.writeFileSync(outCsv, ["host", ...hosts].join("\n") + "\n", "utf8");
  fs.writeFileSync(outTxt, hosts.join("\n") + (hosts.length ? "\n" : ""), "utf8");

  console.log(`Parsed files: ${files.length}`);
  console.log(`Unique hosts: ${hosts.length}`);
  console.log(`CSV: ${path.resolve(outCsv)}`);
  console.log(`TXT: ${path.resolve(outTxt)}`);
  console.log("\nPer-file summary:");
  for (const x of perFile) {
    console.log(`- ${path.basename(x.file)}: ${x.count}`);
  }

  if (hosts.length) {
    console.log("\nFirst hosts:");
    console.log(hosts.slice(0, 20).join("\n"));
  }
}

function printHelp() {
  console.log(`Batch parse saved Shodan HTML/text files and extract ip:port.

Usage:
  node parse-shodan-html.js <file-or-dir...> [options]

Options:
  -o, --out, --csv <file>       Output CSV path, default shodan-hosts.csv
  --txt <file>                  Output TXT path, default shodan-hosts.txt
  --default-port <port>         Use when input only contains bare IPs

Examples:
  node parse-shodan-html.js saved-pages -o hosts.csv
  node parse-shodan-html.js page1.html page2.html --txt hosts.txt
  node parse-shodan-html.js "C:\\Users\\Lenovo\\Downloads" --default-port 4000
`);
}

function collectFiles(p) {
  const full = path.resolve(p);
  if (!fs.existsSync(full)) die(`Not found: ${p}`);
  const st = fs.statSync(full);
  if (st.isFile()) return [full];
  if (!st.isDirectory()) return [];

  const out = [];
  const stack = [full];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of fs.readdirSync(dir)) {
      const fp = path.join(dir, name);
      const s = fs.statSync(fp);
      if (s.isDirectory()) stack.push(fp);
      else if (/\.(html?|txt)$/i.test(name)) out.push(fp);
    }
  }
  return out;
}

function extractHostsFromShodanHtml(text, opts = {}) {
  const hosts = [];
  const debug = {
    direct_ip_port: 0,
    url_ip_port: 0,
    host_query_port: 0,
    json_ip_port: 0,
    data_attr_ip_port: 0,
    host_link_without_port: 0,
    default_port_used: 0,
  };

  const defaultPort = normalizePort(opts.defaultPort);
  const raw = String(text || "");
  const decoded = decodePossiblyEncodedText(raw);
  const haystacks = uniquePreserveOrder([
    raw,
    htmlEntityDecode(raw),
    decoded,
    htmlEntityDecode(decoded),
  ]);

  function add(ip, port, bucket) {
    ip = String(ip || "").trim();
    port = normalizePort(port);
    if (!isValidIpv4(ip) || !port) return;
    hosts.push(ip + ":" + port);
    if (bucket && debug[bucket] != null) debug[bucket] += 1;
  }

  function addMaybeDefault(ip) {
    ip = String(ip || "").trim();
    if (!isValidIpv4(ip)) return;
    debug.host_link_without_port += 1;
    if (defaultPort) {
      hosts.push(ip + ":" + defaultPort);
      debug.default_port_used += 1;
    }
  }

  for (const s of haystacks) {
    let m;

    // href="http://IP:PORT" / href="https://IP:PORT" / copied status bar URLs
    const urlRe = /(?:https?:)?\/\/((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})(?=[\/\?#'"\s<>)&]|$)/gi;
    while ((m = urlRe.exec(s)) !== null) add(m[1], m[2], "url_ip_port");

    const plainRe = /\b((?:\d{1,3}\.){3}\d{1,3}):(\d{1,5})\b/g;
    while ((m = plainRe.exec(s)) !== null) add(m[1], m[2], "direct_ip_port");

    const hostLinkRe = /\/host\/((?:\d{1,3}\.){3}\d{1,3})(?::(\d{1,5}))?(?:[^'"<\s>]*)?/gi;
    while ((m = hostLinkRe.exec(s)) !== null) {
      const chunk = m[0] || "";
      const qPort = (chunk.match(/[?&;](?:port|ports?)=(\d{1,5})/i) || [])[1];
      if (m[2] || qPort) add(m[1], m[2] || qPort, "host_query_port");
      else addMaybeDefault(m[1]);
    }

    const ipThenPortRe = /(?:ip|ip_str|host|hostname|addr|address)["'\s:=]+((?:\d{1,3}\.){3}\d{1,3})[\s\S]{0,160}?(?:port|ports?)["'\s:=]+(\d{1,5})/gi;
    while ((m = ipThenPortRe.exec(s)) !== null) add(m[1], m[2], "host_query_port");

    const portThenIpRe = /(?:port|ports?)["'\s:=]+(\d{1,5})[\s\S]{0,160}?(?:ip|ip_str|host|hostname|addr|address)["'\s:=]+((?:\d{1,3}\.){3}\d{1,3})/gi;
    while ((m = portThenIpRe.exec(s)) !== null) add(m[2], m[1], "host_query_port");

    const dataRe = /data-(?:ip|host|addr)=["']((?:\d{1,3}\.){3}\d{1,3})["'][^>]{0,300}?data-port=["'](\d{1,5})["']/gi;
    while ((m = dataRe.exec(s)) !== null) add(m[1], m[2], "data_attr_ip_port");

    const dataRe2 = /data-port=["'](\d{1,5})["'][^>]{0,300}?data-(?:ip|host|addr)=["']((?:\d{1,3}\.){3}\d{1,3})["']/gi;
    while ((m = dataRe2.exec(s)) !== null) add(m[2], m[1], "data_attr_ip_port");

    const jsonIpPortRe = /"ip_str"\s*:\s*"((?:\d{1,3}\.){3}\d{1,3})"[\s\S]{0,300}?"port"\s*:\s*(\d{1,5})/g;
    while ((m = jsonIpPortRe.exec(s)) !== null) add(m[1], m[2], "json_ip_port");

    const jsonPortIpRe = /"port"\s*:\s*(\d{1,5})[\s\S]{0,300}?"ip_str"\s*:\s*"((?:\d{1,3}\.){3}\d{1,3})"/g;
    while ((m = jsonPortIpRe.exec(s)) !== null) add(m[2], m[1], "json_ip_port");

    if (defaultPort) {
      const bareIpRe = /\b((?:\d{1,3}\.){3}\d{1,3})\b/g;
      while ((m = bareIpRe.exec(s)) !== null) {
        const next = s.slice(m.index + m[1].length, m.index + m[1].length + 6);
        if (/^:\d/.test(next)) continue;
        addMaybeDefault(m[1]);
      }
    }
  }

  const uniqueHosts = uniquePreserveOrder(hosts).filter((h) => {
    const [ip, port] = h.split(":");
    return isValidIpv4(ip) && Boolean(normalizePort(port));
  });

  debug.unique_hosts = uniqueHosts.length;
  return { hosts: uniqueHosts, debug };
}

function normalizePort(value) {
  if (value == null || value === "") return null;
  const n = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return String(n);
}

function isValidIpv4(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255);
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

function htmlEntityDecode(s) {
  return String(s || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function decodePossiblyEncodedText(s) {
  let out = String(s || "");
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(out);
      if (next === out) break;
      out = next;
    } catch {
      break;
    }
  }
  return out;
}

function die(msg) {
  console.error("Error:", msg);
  process.exit(1);
}

main();
