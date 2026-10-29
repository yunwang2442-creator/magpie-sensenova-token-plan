#!/usr/bin/env bun
/**
 * 协议烟测：用真实账号给 Chat / Anthropic Messages / Responses 各发一个最小请求。
 *
 *   bun scripts/protocol-test.mjs
 *   bun scripts/protocol-test.mjs --account 3 --model deepseek-flash
 *   bun scripts/protocol-test.mjs --protocol anthropic
 *   bun scripts/protocol-test.mjs --json
 *
 * 只发 max_tokens=1，不打印 Key；429/403 是厂商答案，不是脚本失败。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { unseal } from "../lib/dpapi.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback = "") => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? String(argv[i + 1] ?? fallback) : fallback;
};
const asJson = argv.includes("--json");
const model = arg("model", "deepseek-flash");
const accountArg = Number(arg("account", "1"));
const protocolArg = arg("protocol", "all");
const protocols = protocolArg === "all" ? ["chat", "anthropic", "responses"] : [protocolArg];

const authPath = join(homedir(), ".config", "magpie", "plugin-auth.json");
const auth = JSON.parse(readFileSync(authPath, "utf8"));
const entries = Object.entries(auth).filter(([key]) => key.startsWith("sensenova"));
const picked = entries
  .map(([key, record], i) => ({ key, record, index: i + 1 }))
  .filter((x) => x.index === accountArg);

if (!picked.length) {
  console.error(`没有第 ${accountArg} 个 sensenova 账号`);
  process.exit(1);
}

const results = [];
for (const { record, index } of picked) {
  const apiKey = await unseal(record.apiKey ?? record.key ?? "");
  if (!apiKey) {
    results.push({ account: index, protocol: "-", status: 0, error: "没有 API Key" });
    continue;
  }
  for (const protocol of protocols) {
    const base = "https://token.sensenova.cn/v1";
    let url;
    let headers;
    let body;
    if (protocol === "chat") {
      url = `${base}/chat/completions`;
      headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
      body = { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, reasoning_effort: "none", stream: false };
    } else if (protocol === "anthropic") {
      url = `${base}/messages`;
      headers = { "x-api-key": apiKey, "anthropic-version": "2023-06-01", Accept: "application/json" };
      body = { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }], stream: false };
    } else if (protocol === "responses") {
      url = `${base}/responses`;
      headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
      body = { model, input: "hi", max_output_tokens: 1, stream: false };
    } else {
      results.push({ account: index, protocol, status: 0, error: "未知协议" });
      continue;
    }

    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      const text = await res.text();
      let error = "";
      try {
        const j = JSON.parse(text);
        error = j?.error?.message ?? j?.message ?? "";
      } catch {}
      results.push({ account: index, protocol, status: res.status, ms: Date.now() - t0, error: String(error).slice(0, 200) });
    } catch (e) {
      results.push({ account: index, protocol, status: 0, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 200) });
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ model, results }, null, 2));
} else {
  for (const r of results) {
    const ok = r.status >= 200 && r.status < 300;
    console.log(`${ok ? "✓" : "✗"} acct${r.account} ${r.protocol.padEnd(9)} HTTP ${r.status} ${r.ms ?? "-"}ms ${r.error}`);
  }
}
process.exit(results.some((r) => r.status === 0) ? 1 : 0);
