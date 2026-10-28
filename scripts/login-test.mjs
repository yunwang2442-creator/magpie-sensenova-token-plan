/**
 * 独立登录自测（真实平台、可见窗口，不经过 magpie）：
 *
 *   bun scripts/login-test.mjs            # 只测登录 + 额度
 *   bun scripts/login-test.mjs sk-xxxxx   # 顺带验证 API Key 与模型清单
 *
 * 会弹出一个一次性浏览器窗口，请在其中完成 SenseNova 登录。
 * 只往屏幕打印脱敏信息（令牌前 8 位），不写任何文件。
 */

import { startLoginCapture } from "../lib/browser.mjs";
import { createPkce } from "../lib/pkce.mjs";
import { buildAuthorizeUrl, exchangeCode, fetchPoolUsage, probeApiKey, usernameFromTokens } from "../lib/protocol.mjs";
import { toUsage } from "../lib/quota.mjs";
import { createCatalog } from "../lib/models.mjs";

const apiKey = (process.argv[2] ?? "").trim();

const pkce = createPkce();
console.log("1/4 打开登录窗口——请在弹出的窗口里完成登录（密码 / 短信验证码均可）");
const session = await startLoginCapture({
  authorizeUrl: buildAuthorizeUrl(pkce),
  expectedState: pkce.state,
  timeoutMs: 8 * 60 * 1000,
  log: (m) => console.log(`     · ${m}`),
});

try {
  const { code } = await session.result;
  console.log(`2/4 已捕获授权码：${code.slice(0, 8)}…（SPA 没有机会消费它）`);

  const tokens = await exchangeCode({ code, verifier: pkce.verifier });
  const username = usernameFromTokens(tokens);
  console.log(
    `3/4 已换到令牌：access ${String(tokens.access_token ?? "").slice(0, 8)}… · ` +
      `refresh ${tokens.refresh_token ? "有" : "缺失！"} · expires_in ${tokens.expires_in ?? "?"}s · 账号 ${username || "(未识别)"}`,
  );

  const usage = toUsage(await fetchPoolUsage(tokens.access_token), { username });
  console.log(`4/4 额度：${usage.plan}${usage.balance ? ` · 活动积分 ${usage.balance}` : ""}`);
  for (const w of usage.windows) {
    console.log(`     ${w.name}：${w.display}（${w.used.toFixed(2)}%）${w.model ? ` [${w.model}]` : ""}`);
  }

  if (apiKey) {
    await probeApiKey(apiKey);
    const models = await createCatalog().load(apiKey);
    console.log(`\nAPI Key 可用，Token Plan 现有模型 ${models.length} 个：`);
    for (const m of models) console.log(`     ${m.id}`);
  } else {
    console.log("\n（想看模型清单：bun scripts/login-test.mjs sk-你的Key）");
  }
} finally {
  await session.close();
}
