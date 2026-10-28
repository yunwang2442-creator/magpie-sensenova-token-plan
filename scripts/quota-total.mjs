#!/usr/bin/env bun
/**
 * 跨账号额度合计：读 `magpie quota --json`，只取 sensenova，按窗口名求和。
 *
 *   bun scripts/quota-total.mjs
 *   bun scripts/quota-total.mjs --json
 *
 * 不写文件、不碰凭据；只是把官方 Usage 页不做的“5 个账号合计”打出来。
 * 页面目前做不了：magpie 的 PageReads 只有 usage:summary / providers:list。
 */
import { spawnSync } from "node:child_process";

const bin = process.env.MAGPIE_BIN || "magpie";
const asJson = process.argv.includes("--json");

const run = spawnSync(bin, ["quota", "--json"], {
  encoding: "utf8",
  shell: process.platform === "win32",
  maxBuffer: 16 * 1024 * 1024,
});
if (run.error) {
  console.error(`跑不起来 ${bin}: ${run.error.message}`);
  process.exit(1);
}
if (run.status !== 0) {
  console.error(`${bin} quota --json 失败（exit ${run.status}）`);
  if (run.stderr) console.error(run.stderr.trim().slice(0, 800));
  process.exit(run.status || 1);
}

let rows;
try {
  rows = JSON.parse(run.stdout);
} catch {
  console.error("magpie quota --json 不是合法 JSON");
  process.exit(1);
}

const subs = (Array.isArray(rows) ? rows : []).filter((r) => r?.provider === "sensenova");
if (!subs.length) {
  console.error("没有找到 sensenova 账号；先确认 magpie quota 能看到它。");
  process.exit(1);
}

const at = (value) => {
  if (typeof value === "number") return new Date(value < 1e11 ? value * 1000 : value);
  const t = Date.parse(String(value ?? ""));
  return Number.isFinite(t) ? new Date(t) : null;
};

const totals = new Map();
for (const sub of subs) {
  for (const w of sub.windows ?? []) {
    const name = String(w.name ?? "?");
    const row = totals.get(name) ?? { name, amount: 0, limit: 0, accounts: 0, resets: [] };
    row.amount += Number(w.amount) || 0;
    row.limit += Number(w.limit) || 0;
    row.accounts += 1;
    const reset = at(w.resetsAt);
    if (reset) row.resets.push(reset);
    totals.set(name, row);
  }
}

const out = [...totals.values()]
  .map((row) => {
    const used = row.limit > 0 ? (row.amount / row.limit) * 100 : 0;
    const earliest = row.resets.length ? new Date(Math.min(...row.resets.map((d) => d.getTime()))) : null;
    return {
      name: row.name,
      accounts: row.accounts,
      used: row.amount,
      limit: row.limit,
      remaining: Math.max(0, row.limit - row.amount),
      usedPercent: used,
      resetsAt: earliest ? earliest.toISOString() : null,
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

if (asJson) {
  console.log(JSON.stringify({ provider: "sensenova", accounts: subs.length, windows: out }, null, 2));
  process.exit(0);
}

const n = (v) => Number(v).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
console.log(`SenseNova · ${subs.length} 个账号 · ${out.length} 个窗口\n`);
for (const row of out) {
  const when = row.resetsAt ? new Date(row.resetsAt).toLocaleString("zh-CN", { hour12: false }) : "-";
  console.log(
    `${row.name}\n  已用 ${n(row.used)} / ${n(row.limit)} · 剩余 ${n(row.remaining)} · ${row.usedPercent.toFixed(2)}% · 最早重置 ${when}`,
  );
}
