#!/usr/bin/env bun
/**
 * 形状自检：以 magpie 的方式加载插件，检查 hook 契约，不联网、不登录。
 *
 *   bun scripts/check-shape.mjs
 *
 * 思路改编自 magpie-community/plugins 的 scripts/check.mjs（MIT，
 * Copyright (c) 2026 magpie-community contributors）；这里只检查本插件。
 */
import { SenseNovaPlugin } from "../index.mjs";

const problems = [];
const expect = (ok, message) => {
  if (!ok) problems.push(message);
};

const client = {
  app: { log: () => {} },
  auth: { set: async () => {} },
  tui: { showToast: async () => {} },
};

const plugin = await SenseNovaPlugin({ client, magpie: { option: () => undefined } }, {});

expect(typeof plugin.config === "function", "config hook");
expect(plugin.provider?.id === "sensenova", "provider.id");
expect(typeof plugin.provider?.models === "function", "provider.models hook");
expect(plugin.auth?.provider === "sensenova", "auth.provider");
expect(typeof plugin.auth?.loader === "function", "auth.loader");
expect(typeof plugin.auth?.usage === "function", "auth.usage");
expect(typeof plugin.auth?.refresh === "function", "auth.refresh");
expect(plugin.auth?.maxConcurrency === 1, "auth.maxConcurrency = 1");
expect(Array.isArray(plugin.auth?.methods) && plugin.auth.methods.length === 2, "auth.methods = 2");

for (const [i, method] of (plugin.auth?.methods ?? []).entries()) {
  expect(["oauth", "api"].includes(method.type), `method[${i}].type`);
  expect(typeof method.label === "string" && method.label.length > 0, `method[${i}].label`);
  if (method.type === "oauth") {
    expect(typeof method.authorize === "function", `method[${i}].authorize`);
    expect(method.prompts === undefined, `method[${i}] 浏览器登录不应有 prompts`);
  }
  if (method.type === "api") {
    expect(method.keyless === true, `method[${i}].keyless`);
    expect(typeof method.authorize === "function", `method[${i}].authorize`);
    expect(Array.isArray(method.prompts) && method.prompts.length > 0, `method[${i}].prompts`);
  }
}

const cfg = {};
await plugin.config(cfg);
const provider = cfg.provider?.sensenova;
expect(provider?.name === "SenseNova", "config provider.name");
expect(provider?.npm === "@ai-sdk/openai-compatible", "config provider.npm");
expect(typeof provider?.api === "string" && provider.api.startsWith("https://"), "config provider.api");
expect(provider?.models && Object.keys(provider.models).length === 5, "config 5 个聊天模型");
expect(provider?.models?.["sensenova-6.8-flash-lite"], "config 含 6.8 flash-lite");
expect(!provider?.models?.["sensenova-u1.5-lite"], "config 不含图像模型");
expect(!provider?.models?.["deepseek-v4.1-flash"], "config 不含 403 杂项");

const listed = await plugin.provider.models(provider, {});
expect(listed?.[Symbol.for("magpie.fellBack")] === true, "无 auth 时 provider.models 打 fellBack");
expect(Object.keys(listed ?? {}).length === 5, "无 auth 时仍声明 5 个模型");

if (problems.length) {
  console.error(`✗ ${problems.length} 个问题`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("✓ 插件形状正常：config / provider.models / auth(oauth+api) / loader / usage / refresh");
