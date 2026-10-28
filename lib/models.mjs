/**
 * 模型目录：Token Plan 的聊天模型清单。
 *
 * 事实来源分两层：
 *   1. 官网文档（platform.sensenova.cn/docs）给出「哪些模型能聊天、输入输出是什么」；
 *   2. 活的 `GET /v1/models` 给出当前部署的上下文、输出上限、价格与能力字段。
 *
 * 两者不一致时，**能力以文档为准、上限以接口为准**。原因很具体：
 *   - `/v1/models` 对 `deepseek-flash` 只写 text，但官网明确它支持图片和视频（视频仅 Chat）；
 *   - `/v1/models` 对 `kimi-k3` 只写 text，但官网说它有原生视觉能力；
 *   - `/v1/models` 还会多出 `deepseek-v4.1-flash` 这种实际 403 的杂项。
 *
 * 所以内置清单不是“兜底占位”，而是目录的骨架；接口只用来覆盖上限/价格/描述。
 */

export const NPM = "@ai-sdk/openai-compatible";
export const DEFAULT_BASE_URL = "https://token.sensenova.cn/v1";

const DEFAULT_CONTEXT = 1_048_576;
const DEFAULT_OUTPUT = 65_536;

/** 官网模型表里能走 Chat Completions 的模型。 */
export const CHAT_MODELS = [
  {
    id: "sensenova-6.8-flash-lite",
    name: "SenseNova 6.8 Flash Lite",
    contextLength: 262_144,
    maxCompletionTokens: 65_536,
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
    description:
      "SenseNova 6.8 Flash-Lite is a lightweight multimodal agent model designed for real-world workflows, supporting text conversation and image input understanding.",
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    contextLength: 1_048_576,
    maxCompletionTokens: 65_536,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
    description:
      "DeepSeek V4 Flash is a high-performance conversational model by DeepSeek, supporting thinking/non-thinking modes, 1M context window, and tool calling.",
  },
  {
    id: "deepseek-flash",
    name: "DeepSeek V4.1 Flash",
    contextLength: 1_048_576,
    maxCompletionTokens: 65_536,
    // 官网：文本、图片、视频；视频仅 Chat Completions。
    inputModalities: ["text", "image", "video"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
    description:
      "DeepSeek V4.1 Flash is a high-performance conversational model by DeepSeek, supporting thinking/non-thinking modes, 1M context window, image/video input (video on Chat), and tool calling.",
  },
  {
    id: "glm-5.2",
    name: "GLM-5.2",
    contextLength: 1_048_576,
    maxCompletionTokens: 131_072,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
    description:
      "GLM-5.2 is the flagship model for the era of long-horizon tasks, with a 1M context window and thinking/non-thinking modes.",
  },
  {
    id: "kimi-k3",
    name: "Kimi K3",
    contextLength: 1_048_576,
    maxCompletionTokens: 65_536,
    // 官网：原生视觉能力；/v1/models 只写 text，以文档为准。
    inputModalities: ["text", "image"],
    outputModalities: ["text"],
    supportsTools: true,
    reasoning: true,
    description:
      "Kimi K3 is a high-performance native multimodal agent model by Kimi, with visual understanding, a 1M context window, and tool calling.",
  },
];

/** 图像生成模型：不进入 Chat 目录（magpie 的 chat provider 不服务 /v1/images/*）。 */
export const IMAGE_MODELS = [
  {
    id: "sensenova-u1.5-lite",
    name: "SenseNova U1.5 Lite",
    inputModalities: ["text", "image"],
    outputModalities: ["image"],
  },
  {
    id: "sensenova-u1.5-fast",
    name: "SenseNova U1.5 Fast",
    inputModalities: ["text", "image"],
    outputModalities: ["image"],
  },
];

/** `/v1/models` 里会冒出来、但不属于 Token Plan 的 id。 */
export const STRAY_MODEL_IDS = ["deepseek-v4.1-flash"];

/** 兜底清单（登录前 / 拉取失败时）。也叫“骨架清单”。 */
export const FALLBACK_MODELS = CHAT_MODELS;

const positive = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : undefined);
const unique = (xs) => [...new Set(xs)];

const known = (id) => CHAT_MODELS.find((m) => m.id === id);
const imageModel = (id) => IMAGE_MODELS.find((m) => m.id === id);

/** 归一化一条模型记录（兼容 snake_case / camelCase 两种拼写）。 */
export function normalizeModel(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = text(raw.id) ?? text(raw.model_id) ?? text(raw.model);
  if (!id) return null;
  const curated = known(id);
  const image = imageModel(id);

  const liveInput = list(raw.input_modalities ?? raw.inputModalities);
  const liveOutput = list(raw.output_modalities ?? raw.outputModalities);
  const features = list(raw.supported_features ?? raw.supportedFeatures) ?? [];

  // 能力取“文档 ∪ 接口”：文档补上接口漏掉的图片/视频，接口补上文档没写的新能力。
  const inputModalities = unique([...(curated?.inputModalities ?? image?.inputModalities ?? []), ...(liveInput ?? [])]);
  const outputModalities = unique([...(curated?.outputModalities ?? image?.outputModalities ?? []), ...(liveOutput ?? [])]);

  const supportsTools =
    features.includes("tools") ||
    raw.supports_tools === true ||
    raw.supportsTool === true ||
    raw.tool_call === true ||
    curated?.supportsTools === true;

  const reasoning =
    features.includes("reasoning") || raw.reasoning === true || raw.supports_reasoning === true || curated?.reasoning === true;

  const created = positive(raw.created);
  return {
    id,
    name: curated?.name ?? image?.name ?? text(raw.name) ?? text(raw.model_name) ?? id,
    contextLength:
      positive(raw.context_length ?? raw.contextLength ?? raw.max_context_tokens) ??
      curated?.contextLength ??
      DEFAULT_CONTEXT,
    maxCompletionTokens:
      positive(
        raw.max_output_length ??
          raw.max_output_tokens ??
          raw.maxCompletionTokens ??
          raw.max_completion_tokens ??
          raw.max_output_tokens,
      ) ??
      curated?.maxCompletionTokens ??
      DEFAULT_OUTPUT,
    inputModalities: inputModalities.length ? inputModalities : ["text"],
    outputModalities: outputModalities.length ? outputModalities : ["text"],
    supportsTools,
    reasoning,
    description: text(raw.description) ?? curated?.description ?? "",
    released: created ? new Date(created * 1000).toISOString().slice(0, 10) : "",
  };
}

/** 从各式信封里取出模型数组（{data:[…]} / {models:[…]} / 裸数组）。 */
export function extractModels(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
  return rows.map(normalizeModel).filter(Boolean);
}

/** 只保留能走 Chat Completions 的模型：有文本输出、不是图像模型、不是杂项 id。 */
export function isChatModel(m) {
  if (!m || typeof m !== "object") return false;
  if (STRAY_MODEL_IDS.includes(m.id)) return false;
  const outputs = m.outputModalities ?? ["text"];
  return outputs.includes("text");
}

export function chatModels(models) {
  return (models ?? []).filter(isChatModel);
}

/** 拉一次、缓存一段时间的模型目录；失败时会抛出，由调用方决定兜底。 */
export function createCatalog({ baseURL = DEFAULT_BASE_URL, timeoutMs = 15_000, refreshMs = 6 * 3600_000, fetchImpl } = {}) {
  const root = baseURL.replace(/\/+$/, "");
  const doFetch = fetchImpl ?? fetch;
  let cached = null;
  let fetchedAt = 0;

  return {
    baseURL: root,
    /** 最近一次成功列表（没有则 null）。 */
    peek: () => cached,
    async load(apiKey) {
      if (!apiKey) throw new Error("没有 API Key");
      if (cached && Date.now() - fetchedAt < refreshMs) return cached;
      const res = await doFetch(`${root}/models`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`GET /models → HTTP ${res.status}`);
      const models = extractModels(await res.json());
      if (models.length) {
        cached = models;
        fetchedAt = Date.now();
      }
      return models;
    },
  };
}

/* ------------------------------------------------------- magpie 对象形状 */

const hasNonTextInput = (m) => (m.inputModalities ?? []).some((modality) => modality !== "text");

function modalityFlags(modalities) {
  const l = list(modalities) ?? ["text"];
  return {
    text: l.includes("text"),
    image: l.includes("image"),
    audio: l.includes("audio"),
    video: l.includes("video"),
    pdf: l.includes("pdf"),
  };
}

/** 推理档位：官网原生 none / low / high / max；medium 由厂商映射到 high。 */
function variantsOf(m) {
  if (m.reasoning !== true) return {};
  return Object.fromEntries(["none", "low", "high", "max"].map((level) => [level, {}]));
}

/** 按 wire 协议裁掉视频：只有 Chat Completions 支持视频。 */
function inputsFor(m, video) {
  const inputs = m.inputModalities ?? ["text"];
  return video === false ? inputs.filter((x) => x !== "video") : inputs;
}

/** `config` 里声明一条模型。 */
export function toConfigModel(m, { video = true } = {}) {
  const inputs = inputsFor(m, video);
  const out = {
    name: m.name,
    reasoning: m.reasoning === true,
    tool_call: m.supportsTools === true,
    attachment: hasNonTextInput({ inputModalities: inputs }),
    modalities: { input: inputs, output: m.outputModalities },
    limit: { context: m.contextLength, output: m.maxCompletionTokens },
  };
  const variants = variantsOf(m);
  if (Object.keys(variants).length) out.variants = variants;
  return out;
}

/** `provider.models` 返回的一条模型。 */
export function toProviderModel(m, providerID, { baseURL = DEFAULT_BASE_URL, npm = NPM, video = true } = {}) {
  const inputs = inputsFor(m, video);
  return {
    id: m.id,
    providerID,
    name: m.name,
    api: { id: m.id, url: baseURL.replace(/\/+$/, ""), npm },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.contextLength, output: m.maxCompletionTokens },
    capabilities: {
      temperature: true,
      reasoning: m.reasoning === true,
      attachment: hasNonTextInput({ inputModalities: inputs }),
      toolcall: m.supportsTools === true,
      input: modalityFlags(inputs),
      output: modalityFlags(m.outputModalities),
      interleaved: false,
    },
    release_date: m.released ?? "",
    variants: variantsOf(m),
  };
}

/**
 * 给“用回了兜底清单”的返回打标记：magpie 据此在界面上说明
 * "这是插件自己的缺省清单，不是这家现在给你的清单"。
 */
export function fellBack(map) {
  const out = { ...map };
  out[Symbol.for("magpie.fellBack")] = true;
  return out;
}
