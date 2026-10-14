/**
 * provider.js — 把本地 wllama 推理引擎适配成 Vercel AI SDK 可用的语言模型
 *
 * 职责：
 * - 使用 @ai-sdk/openai-compatible 的 createOpenAICompatible 构造 provider，并通过
 *   自定义 fetch 把「AI SDK → OpenAI /chat/completions 请求」桥接到 aiEngine；
 * - OpenAI 兼容 provider 负责把 SDK 的 prompt / tools / 参数转成 OpenAI 风格请求体，
 *   并在响应侧把 OpenAI 流式 chunk 还原成 AI SDK 的流式 part，因此本文件只需：
 *     1. 解析请求体，抽取引擎参数（messages/tools/max_tokens/temperature/top_p/top_k/
 *        chat_template_kwargs）；
 *     2. 调用 engine.createChatCompletionStream，把每个原始 chunk 序列化成 SSE；
 *     3. 非流式路径（stream!=true）在内部聚合 chunk，拼成标准 ChatCompletion JSON。
 *
 * 惰性绑定：provider / 模型对象在创建时**不**缓存引擎的 _wllama 状态，custom fetch 只在
 * 收到请求时才读取 engine 当前实例，因此模型可随时 load / unload。
 *
 * 依据（已核对 node_modules 实际类型声明，勿凭记忆修改）：
 * - @ai-sdk/provider@4.0.27：语言模型最新规范为 `specificationVersion: 'v4'`
 *   （LanguageModelV4，doGenerate / doStream 均返回 PromiseLike）。AI SDK 的 LanguageModel
 *   类型为 `LanguageModelV4 | LanguageModelV3 | LanguageModelV2`，v4 可直接传入。
 * - @ai-sdk/openai-compatible@3.0.68：OpenAICompatibleProviderSettings 含 `fetch` 字段
 *   （类型为 typeof globalThis.fetch），provider 内部流式解析要求响应 body 为 SSE，
 *   且必须有带 finish_reason 的收尾 chunk（见下方兜底逻辑）。
 * - @wllama/wllama ChatCompletionChunk：{ id, object, created, model, choices[], usage? }。
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import aiEngine from './engine.js';

/** 逻辑 baseURL（custom fetch 会拦截，不会真正发起网络请求） */
const BASE_URL = 'http://wllama.local/v1';
/** 暴露给 AI SDK 的模型 id */
const MODEL_ID = 'wllama-local';
/** provider 名称（最终 model.provider 形如 'wllama.chat'） */
const PROVIDER_NAME = 'wllama';

/**
 * 解析 custom fetch 收到的请求体（OpenAI /chat/completions 的 JSON）。
 * body 正常为字符串；兼容 Uint8Array，异常时回退为空对象。
 * @param {RequestInit['body']} body
 * @returns {object}
 */
function parseJsonBody(body) {
    if (!body) return {};
    try {
        if (typeof body === 'string') return JSON.parse(body);
        // 少数运行环境可能以字节流形式传入
        return JSON.parse(new TextDecoder().decode(body));
    } catch {
        return {};
    }
}

/**
 * 从 OpenAI 风格请求体抽取引擎所需参数。
 * 仅透传外部显式提供且非空的字段，未提供的交给 wllama 自身默认值。
 * @param {object} request OpenAI 请求体
 * @returns {object} engine.createChatCompletionStream 的 params
 */
function buildEngineParams(request) {
    const params = { messages: Array.isArray(request.messages) ? request.messages : [] };
    if (Array.isArray(request.tools) && request.tools.length) params.tools = request.tools;
    if (request.max_tokens != null) params.max_tokens = request.max_tokens;
    if (request.temperature != null) params.temperature = request.temperature;
    if (request.top_p != null) params.top_p = request.top_p;
    // openai-compatible provider 会把 topK 标记为不支持并从请求体剔除；
    // 若调用方通过 providerOptions / transformRequestBody 塞入 top_k，这里一并透传。
    if (request.top_k != null) params.top_k = request.top_k;
    // 默认关闭思考链（与 engine.chat 行为一致），外部显式设置可覆盖
    params.chat_template_kwargs = {
        enable_thinking: false,
        ...(request.chat_template_kwargs || {}),
    };
    return params;
}

/** 构造一个 OpenAI 风格的响应标识 */
function makeResponseId(created) {
    return `chatcmpl-wllama-${created}`;
}

/**
 * 非流式路径：内部聚合流式 chunk，拼成标准 ChatCompletion JSON 后返回。
 * provider 的 doGenerate 会以 createJsonResponseHandler 解析该响应。
 * @param {import('./engine.js').AiEngine} engine
 * @param {object} request OpenAI 请求体
 * @param {AbortSignal} [signal]
 * @returns {Promise<Response>}
 */
async function aggregateResponse(engine, request, signal) {
    const params = buildEngineParams(request);
    const created = Math.floor(Date.now() / 1000);
    const responseId = makeResponseId(created);
    const modelId = request.model || MODEL_ID;

    let content = '';
    let reasoning = '';
    /** 工具调用按 index 聚合分片 */
    const toolAcc = new Map();
    let finishReason = null;
    let usage = null;

    await engine.createChatCompletionStream(
        params,
        (chunk) => {
            if (chunk?.usage) usage = chunk.usage;
            const choice = chunk?.choices?.[0];
            if (!choice) return;
            const delta = choice.delta || {};
            if (typeof delta.content === 'string') content += delta.content;
            const think = delta.reasoning_content ?? delta.reasoning;
            if (typeof think === 'string') reasoning += think;
            if (Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                    const idx = tc.index ?? 0;
                    const cur =
                        toolAcc.get(idx) ||
                        { id: '', type: 'function', function: { name: '', arguments: '' } };
                    if (tc.id && !cur.id) cur.id = tc.id;
                    // name 通常只出现一次，arguments 逐片拼接
                    if (tc.function?.name && !cur.function.name) cur.function.name = tc.function.name;
                    if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
                    toolAcc.set(idx, cur);
                }
            }
            if (choice.finish_reason != null) finishReason = choice.finish_reason;
        },
        signal
    );

    const message = { role: 'assistant', content: content || null };
    if (reasoning) message.reasoning_content = reasoning;
    const toolCalls = [...toolAcc.values()].filter((t) => t.function.name);
    if (toolCalls.length) {
        message.tool_calls = toolCalls.map((t, i) => ({
            id: t.id || `call_${i}`,
            type: 'function',
            function: { name: t.function.name, arguments: t.function.arguments || '' },
        }));
    }

    const completion = {
        id: responseId,
        object: 'chat.completion',
        created,
        model: modelId,
        choices: [
            {
                index: 0,
                message,
                finish_reason: finishReason ?? 'stop',
            },
        ],
        usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    return new Response(JSON.stringify(completion), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * 流式路径：把 wllama 原始 chunk 逐个序列化为 SSE 返回。
 * 结束时补 `data: [DONE]`；若引擎未给出带 finish_reason 的收尾 chunk，则补一个合成 chunk，
 * 否则 AI SDK 会以 "ended without a finish reason" 报错。
 * @param {import('./engine.js').AiEngine} engine
 * @param {object} request OpenAI 请求体
 * @param {AbortSignal} [signal]
 * @returns {Response}
 */
function streamResponse(engine, request, signal) {
    const params = buildEngineParams(request);
    const created = Math.floor(Date.now() / 1000);
    const responseId = makeResponseId(created);
    const modelId = request.model || MODEL_ID;
    const encoder = new TextEncoder();

    let sawFinish = false;
    let closed = false;

    const stream = new ReadableStream({
        async start(controller) {
            const send = (chunk) => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                } catch {
                    // 消费者已取消/流已关闭：停止写入
                    closed = true;
                }
            };

            try {
                await engine.createChatCompletionStream(
                    params,
                    (chunk) => {
                        if (chunk?.choices?.some((c) => c?.finish_reason != null)) sawFinish = true;
                        send(chunk);
                    },
                    signal
                );

                if (!sawFinish) {
                    send({
                        id: responseId,
                        object: 'chat.completion.chunk',
                        created,
                        model: modelId,
                        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                    });
                }
                if (!closed) {
                    try {
                        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    } catch {
                        /* 已关闭则忽略 */
                    }
                }
            } catch (error) {
                // 生成异常：以流错误结束，AI SDK 会转换成 error part
                try {
                    controller.error(error);
                } catch {
                    /* 已关闭则忽略 */
                }
                return;
            }
            try {
                controller.close();
            } catch {
                /* 已关闭则忽略 */
            }
        },
        cancel() {
            // 消费者取消（含 abort）：标记关闭，底层中止由 signal 负责
            closed = true;
        },
    });

    return new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
    });
}

/**
 * 构造绑定到指定引擎实例的 custom fetch。
 * 该函数只在收到请求时读取 engine 的当前状态，实现惰性绑定。
 * @param {import('./engine.js').AiEngine} engine
 * @returns {typeof globalThis.fetch}
 */
function createBridgeFetch(engine) {
    return async function bridgeFetch(_url, init = {}) {
        const request = parseJsonBody(init.body);
        const signal = init.signal || undefined;
        // 该请求是否属于流式调用：provider 在 doStream 时会把 stream 置为 true
        if (request.stream === true) {
            return streamResponse(engine, request, signal);
        }
        return aggregateResponse(engine, request, signal);
    };
}

/** 每个引擎实例缓存的模型对象（WeakMap，避免重复构造 provider） */
const modelCache = new WeakMap();

/**
 * 返回绑定到指定 engine 实例的 AI SDK LanguageModel。
 * 可直接传给 streamText / generateText。
 * @param {import('./engine.js').AiEngine} [engine] 目标引擎，缺省用默认单例 aiEngine
 * @returns {import('@ai-sdk/provider').LanguageModelV4} AI SDK 语言模型（specificationVersion 'v4'）
 */
export function createWllamaModel(engine) {
    const target = engine || aiEngine;
    const cached = modelCache.get(target);
    if (cached) return cached;

    const provider = createOpenAICompatible({
        name: PROVIDER_NAME,
        baseURL: BASE_URL,
        apiKey: 'local',
        // 请求流式 chunk 时携带 usage（wllama 若支持则透传，不支持则为 null）
        includeUsage: true,
        // 自定义 fetch 把请求桥接到本地引擎（惰性读取引擎状态）
        fetch: createBridgeFetch(target),
    });

    // provider(modelId) === provider.chatModel(modelId)，返回 LanguageModelV4
    const model = provider(MODEL_ID);
    modelCache.set(target, model);
    return model;
}

/** 已缓存的默认单例模型（避免 getWllamaModel 每次重建） */
let defaultModel = null;

/**
 * 使用默认单例 aiEngine 的便捷方法。
 * @returns {import('@ai-sdk/provider').LanguageModelV4}
 */
export function getWllamaModel() {
    if (!defaultModel) defaultModel = createWllamaModel(aiEngine);
    return defaultModel;
}

export default { createWllamaModel, getWllamaModel };
