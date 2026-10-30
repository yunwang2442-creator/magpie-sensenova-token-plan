#!/usr/bin/env bun
/**
 * Token Plan Key 清理：列出每个 SenseNova 账号的 Key，保留最新 N 个，
 * 只删本机的 `magpie-<host>-*`，永远保护当前账号正在用的 Key。
 *
 *   bun scripts/key-gc.mjs                 # 预览（默认，不删）
 *   bun scripts/key-gc.mjs --keep 2        # 预览，保留最新 2 个
 *   bun scripts/key-gc.mjs --apply         # 真删
 *   bun scripts/key-gc.mjs --account 2     # 只看第 2 个账号
 *   bun scripts/key-gc.mjs --all-machines  # 连其他机器的 magpie-* 一起清（默认不动）
 *   bun scripts/key-gc.mjs --json          # 机器可读
 *
 * 安全边界：
 *   - 只处理 `plugin-auth.json` 里 provider 以 sensenova 开头的 OAuth 账号；
 *   - 只删 displayname 以 `magpie-<host>-` 开头的 Key（--all-machines 才放宽到所有 `magpie-*`）；
 *   - 当前账号正在用的 Key（按 Key 末 4 位匹配）永远保留；
 *   - 无 access token 的“仅 API Key”账号跳过；
 *   - 默认 dry-run，必须显式 --apply。
 *
 * 多机器：Key 名带 `magpie-<机器短标识>-`（插件登录时生成），默认只清本机的；
 * 其他机器的 Key 要用 --all-machines 显式确认才会进清理范围。
 */
import { readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import { unseal } from "../lib/dpapi.mjs";
import { deleteApiKey, keyFingerprint, listApiKeys } from "../lib/protocol.mjs";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const asJson = argv.includes("--json");
const allMachines = argv.includes("--all-machines");
const keepArg = argv.indexOf("--keep");
const keep = Math.max(1, Number(keepArg >= 0 ? argv[keepArg + 1] : 2) || 2);
const accountArg = argv.indexOf("--account");
const only = accountArg >= 0 ? String(argv[accountArg + 1] ?? "") : "";
const HOST_TAG = keyFingerprint(hostname()).slice(0, 4);

const authPath = process.env.MAGPIE_AUTH || join(homedir(), ".config", "magpie", "plugin-auth.json");
let auth;
try {
  auth = JSON.parse(readFileSync(authPath, "utf8"));
} catch (e) {
  console.error(`读不到 ${authPath}: ${e?.message ?? e}`);
  process.exit(1);
}

const entries = Object.entries(auth).filter(([key]) => key.startsWith("sensenova"));
if (!entries.length) {
  console.error("plugin-auth.json 里没有 sensenova 账号");
  process.exit(1);
}

const created = (value) => {
  if (!value) return 0;
  const n = Date.parse(String(value));
  return Number.isFinite(n) ? n : 0;
};
const when = (value) => {
  const n = created(value);
  return n ? new Date(n).toLocaleString("zh-CN", { hour12: false }) : "-";
};

const plans = [];
let failed = 0;

for (const [i, [key, record]] of entries.entries()) {
  const index = i + 1;
  const accountId = record.accountId || record.username || key;
  if (only && only !== String(index) && !String(accountId).includes(only) && !key.includes(only)) continue;

  let access = "";
  try {
    access = await unseal(record.access ?? "");
  } catch {
    /* 没登录态 */
  }
  if (!access) {
    plans.push({ index, accountId, skipped: "没有控制台令牌（仅 API Key 账号）" });
    if (!asJson) console.log(`\n[${index}] ${accountId} — 跳过：仅 API Key，没有控制台令牌`);
    continue;
  }

  let listed;
  try {
    listed = await listApiKeys(access, { pageSize: 20 });
  } catch (e) {
    failed++;
    plans.push({ index, accountId, skipped: `读取失败：${e?.message ?? e}` });
    if (!asJson) console.log(`\n[${index}] ${accountId} — 读取失败：${e?.message ?? e}`);
    continue;
  }

  const rows = (listed.api_keys ?? []).filter((k) => k && k.id);
  const keys = rows.slice().sort((a, b) => created(b.create_time) - created(a.create_time));
  let active = "";
  try {
    active = await unseal(record.apiKey ?? record.key ?? "");
  } catch {
    /* ignore */
  }
  const suffix = active.length >= 4 ? active.slice(-4) : "";
  const protectedIds = new Set(keys.filter((k) => suffix && String(k.api_key ?? "").endsWith(suffix)).map((k) => k.id));
  const keepIds = new Set([...keys.slice(0, keep).map((k) => k.id), ...protectedIds]);
  // 只清本机的 magpie-<host>-*；--all-machines 才放宽到所有 magpie-*。
  const prefix = allMachines ? "magpie-" : `magpie-${HOST_TAG}-`;
  const plan = {
    index,
    accountId,
    total: Number(listed.total_count ?? keys.length),
    keep: [],
    protect: [],
    remove: [],
  };

  for (const k of keys) {
    const row = { id: k.id, name: k.displayname ?? "", created: k.create_time ?? "" };
    if (protectedIds.has(k.id)) plan.protect.push(row);
    else if (keepIds.has(k.id)) plan.keep.push(row);
    else if (String(k.displayname ?? "").startsWith(prefix)) plan.remove.push(row);
    else plan.keep.push(row); // 手动创建的 Key 永不删；其他机器的 magpie-* 默认也不动
  }
  if (suffix && apply && protectedIds.size === 0 && !asJson) {
    console.log(`  ⚠️  正在用的 Key（末 4 位 ${suffix}）在列表里没有匹配到 api_key 字段，无法确认保护——本次跳过该账号。`);
    plans.push(plan);
    continue;
  }

  plans.push(plan);
  if (!asJson) {
    console.log(`\n[${index}] ${accountId} — ${plan.total} 个 Key，保留 ${keep} 个${apply ? "，执行删除" : "，预览"}`);
    for (const k of plan.protect) console.log(`  PROTECT  ${k.name}  ${when(k.created)}`);
    for (const k of plan.keep) console.log(`  KEEP     ${k.name}  ${when(k.created)}`);
    for (const k of plan.remove) console.log(`  ${apply ? "DELETE " : "DELETE?"}  ${k.name}  ${when(k.created)}`);
  }

  if (apply) {
    for (const k of plan.remove) {
      try {
        const ok = await deleteApiKey(access, k.id);
        if (!asJson) console.log(`  -> ${ok ? "已删除" : "已不存在"} ${k.name}`);
      } catch (e) {
        failed++;
        if (!asJson) console.log(`  -> 删除失败 ${k.name}: ${e?.message ?? e}`);
      }
    }
  }
}

if (asJson) console.log(JSON.stringify({ keep, apply, plans }, null, 2));
else if (!apply) {
  console.log("\n这是预览。确认清单后加 --apply 才会删除。");
  console.log("当前正在用的 Key 会按末 4 位保护；手动创建的 Key 不会被删。");
}
process.exit(failed ? 1 : 0);
