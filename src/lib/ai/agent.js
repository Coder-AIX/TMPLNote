/**
 * agent.js — Agent 运行入口（基于 Vercel AI SDK 7 的 streamText）
 *
 * 职责：
 * - 用 AI SDK 7 的 `streamText` 封装「一次对话（支持多轮工具调用）」，把模型增量文本通过
 *   onToken 回吐，同时捕获工具调用 / 工具结果事件，并返回最终完整文本与工具调用记录。
 * - 模型来自 provider.js 的 getWllamaModel()，其返回 LanguageModelV4，可直接作为 streamText 的 model。
 *
 * 阶段说明：
 * - Phase 1：纯文本流式（仅消费 textStream）。
 * - Phase 2（本文件现状）：**接入 AI SDK 原生工具循环**——传入 `tools`（tools.js 的 AI_TOOLS）
 *   并使用 `stopWhen: stepCountIs(maxSteps)` 开启多步 tool loop，以替代 stores/chat.js 中
 *   原先手写的 MAX_TOOL_ROUNDS 循环。改为遍历 `result.fullStream` 同时捕获文本增量与工具事件。
 * - Phase 3（本次新增）：**捕获推理（reasoning）增量**——Qwen3.5 等混合思考模型若思考链未完全关闭，
 *   会先产出 `reasoning-*` 增量而暂不产出可见文本；上层只消费 text-delta 时会长时间无输出、形似「卡死」。
 *   故新增可选回调 `onReasoning`，在 fullStream 中累加并回吐 `reasoning-delta` 的文本，并在返回值中
 *   额外暴露累计推理文本 `reasoning`（可能为空串），供 UI 显示「思考中…」。既有文本/工具/中止/错误逻辑不变。
 *
 * ── 依据（已核对 node_modules/ai@7.0.140 的类型声明与 dist 实现，勿凭记忆修改）──
 * 1. streamText 参数（见 dist/index.d.ts：LanguageModelCallOptions & RequestOptions & Prompt）：
 *    - 消息：`messages: ModelMessage[]`（与 `prompt` 互斥）。ModelMessage 形如
 *      { role: 'system'|'user'|'assistant'|'tool', content: string | parts[] }，字符串 content 可直接传。
 *    - 但 system 消息默认**不允许**出现在 messages 中：dist 实现 standardizePrompt 的
 *      `allowSystemInMessages` 默认为 false，含 system 消息会抛 InvalidPromptError
 *      （"System messages are not allowed in the prompt or messages fields..."），
 *      因此要直接透传「含 system 的对话数组」，必须显式传 `allowSystemInMessages: true`。
 *    - 采样参数：最大 token 名为 `maxOutputTokens`（AI SDK 7 已不再使用 maxTokens），温度为 `temperature`。
 *    - 中止信号：`abortSignal`（定义在 RequestOptions 中）。
 *    - 工具集：`tools: ToolSet`，键为工具名、值为 `tool({ description, inputSchema, execute })` 的返回值
 *      （见 @ai-sdk/provider-utils：ToolSet = Record<string, Tool>）。tools.js 的 AI_TOOLS 正是该结构。
 *    - 停止条件：`stopWhen`。**关键**：dist 中 `streamText({ ..., stopWhen = isStepCount(1) })`——
 *      v5+ 默认只跑 1 步，模型发出一次工具调用后即停止，不会继续生成最终回答。必须显式传入
 *      `stopWhen: stepCountIs(maxSteps)`（`stepCountIs` 为 `isStepCount` 的导出别名）才能启用多轮工具循环。
 * 2. streamText 返回结果（StreamTextResult）：
 *    - `fullStream: AsyncIterableStream<TextStreamPart>`：包含全部事件（文本、工具调用/结果、错误等）。
 *      注：类型声明中 `stream` 为同义的新名，`fullStream` 标注 `@deprecated`，但二者类型与实现完全一致；
 *      本文件按要求使用 `fullStream`。仅会「中断流」的致命错误（如网络错误）会被抛出，其余以 part 形式产出。
 *    - `textStream: AsyncIterableStream<string>`：仅产出 text-delta 增量（dist 的 toTextStream 只取 part.text），
 *      既不携带工具事件也不携带错误 part，故本文件改用 fullStream 自行累加。
 *    - `text: PromiseLike<string>`：最终完整文本；但流被中止时该 promise 会 reject，故不依赖它。
 * 3. fullStream 中各类 part 的确切字段（见 dist/index.d.ts 的 TextStreamPart 联合类型）：
 *    - text-delta：`{ type, id, providerMetadata?, text: string }` —— 取 `.text`。
 *    - reasoning-delta：`{ type:'reasoning-delta', id, providerMetadata?, text: string }`（TextStreamReasoningDeltaPart）—— 取 `.text`。
 *      注：**fullStream 中该 part 的文本字段名为 `text`（与 text-delta 一致），并非 `delta`**。`delta` 仅出现在
 *      UIMessageChunk 的 reasoning-delta（面向 UI 消息流的另一套 chunk 结构）中，勿混淆。dist 实现
 *      createLanguageModelV4StreamPartToLanguageModelStreamPartTransform 对 reasoning-delta 明确 enqueue
 *      `{ type:'reasoning-delta', id, text: chunk.delta, ... }`（见 index.js），与本类型声明一致。
 *    - reasoning-start / reasoning-end / reasoning-file：推理段落的首尾与附属文件 part，本阶段不消费（在 default 中忽略）。
 *    - tool-call ：`{ type:'tool-call', toolCallId, toolName, input, dynamic?, ... }`。
 *    - tool-result：`{ type:'tool-result', toolCallId, toolName, input, output, preliminary?, ... }`。
 *    - tool-error ：`{ type:'tool-error', toolCallId, toolName, input, error, ... }`（工具 execute 抛错时产出）。
 *    - error      ：`{ type:'error', error: unknown }`（致命/模型流错误）。
 *    - abort      ：`{ type:'abort', reason? }`（外部中止时收尾）。
 *    - finish     ：`{ type:'finish', finishReason, rawFinishReason, totalUsage }`。
 * 4. 工具执行失败的行为（dist 实现 executeToolCall）：`execute` 抛错会被 SDK **捕获**，产出 `tool-error`
 *    part（不 rethrow），并以 errorMode 'text' 把错误文本作为 tool message **回灌给模型**，
 *    随后只要本次所有工具调用都拿到结果/错误，循环会继续（仍受 stopWhen 约束）。即：工具出错不终止循环，
 *    error part 才代表致命流错误。
 */
import { streamText, stepCountIs } from 'ai';
import { getWllamaModel } from './provider.js';

/** 本阶段允许透传的消息角色（纯文本对话，不含 tool） */
const ALLOWED_ROLES = new Set(['system', 'user', 'assistant']);

/**
 * 把入参消息最小规范化成 AI SDK 7 的 ModelMessage[]。
 * - 仅保留 role 合法且 content 为字符串的项（过滤异常项以增强健壮性）；
 * - ModelMessage 支持字符串 content，故直接使用，无需拆成 parts。
 * @param {Array<{role?: string, content?: unknown}>|undefined} messages
 * @returns {Array<{role: string, content: string}>}
 */
function normalizeMessages(messages) {
    if (!Array.isArray(messages)) return [];
    const out = [];
    for (const msg of messages) {
        if (!msg || typeof msg !== 'object') continue;
        const { role, content } = msg;
        if (!ALLOWED_ROLES.has(role)) continue;
        if (typeof content !== 'string') continue;
        out.push({ role, content });
    }
    return out;
}

/**
 * 把外部采样参数（{ maxTokens?, temperature? }）映射为 AI SDK 7 的参数名。
 * 依据 LanguageModelCallOptions：最大 token 为 maxOutputTokens（非 maxTokens），temperature 同名。
 * @param {{maxTokens?: number, temperature?: number}} [params]
 * @returns {{maxOutputTokens?: number, temperature?: number}}
 */
function mapParams(params) {
    const out = {};
    if (!params) return out;
    if (params.maxTokens != null) out.maxOutputTokens = params.maxTokens;
    if (params.temperature != null) out.temperature = params.temperature;
    return out;
}

/**
 * 运行一次对话（支持多轮工具调用），流式回吐文本增量。
 * @param {object} opts
 * @param {Array<{role:string, content:string}>} opts.messages  对话消息（含 system / 历史 / 本轮 user）
 * @param {object} [opts.tools] AI SDK ToolSet（来自 tools.js 的 AI_TOOLS）；不传则为纯文本模式
 * @param {(delta:string)=>void} [opts.onToken] 可见文本增量回调
 * @param {(delta:string)=>void} [opts.onReasoning] 推理（思考链）增量回调；混合思考模型在产出可见文本前会先走这里
 * @param {(call:{name:string,args:unknown})=>void} [opts.onToolCall] 每次工具调用回调（可选）
 * @param {(result:{name:string,result:unknown})=>void} [opts.onToolResult] 每次工具完成回调（可选，含出错时）
 * @param {AbortSignal} [opts.signal] 外部中止信号
 * @param {object} [opts.params] 采样参数可选覆盖：{ maxTokens?, temperature? }
 * @param {number} [opts.maxSteps=5] 工具循环最大步数（透传给 stopWhen: stepCountIs）
 * @returns {Promise<{text:string, reasoning:string, toolCalls:Array<{name:string,args:unknown,result:unknown}>}>}
 */
export async function runAgent({
    messages,
    tools,
    onToken,
    onReasoning,
    onToolCall,
    onToolResult,
    signal,
    params,
    maxSteps = 5,
} = {}) {
    const normalized = normalizeMessages(messages);
    if (normalized.length === 0) {
        throw new Error('runAgent: messages 不能为空（需至少一条 role 合法且 content 为字符串的消息）');
    }

    // 仅在提供了非空工具集时才传 tools（纯文本模式不传），避免空对象触发工具分支。
    const hasTools =
        !!tools && typeof tools === 'object' && Object.keys(tools).length > 0;
    // 步数下限保证为 1：stepCountIs(0) 在语义上无意义。
    const steps = Number(maxSteps) > 0 ? Number(maxSteps) : 5;

    // 构造 streamText 参数：
    // - messages 与 prompt 互斥，这里只用 messages；
    // - 含 system 消息必须显式 allowSystemInMessages（AI SDK 7 默认 false）；
    // - 采样参数经 mapParams 映射为 maxOutputTokens / temperature；
    // - 显式 stopWhen 覆盖默认的 stepCountIs(1)，否则一次工具调用后不会继续生成最终回答。
    const result = streamText({
        model: getWllamaModel(),
        messages: normalized,
        allowSystemInMessages: true,
        abortSignal: signal,
        ...mapParams(params),
        ...(hasTools ? { tools } : {}),
        stopWhen: stepCountIs(steps),
    });

    let full = '';
    /** @type {string} 累计推理（思考链）文本；混合思考模型在产出可见文本前会先累加这里，可能为空串 */
    let reasoning = '';
    /** @type {Array<{name:string, args:unknown, result:unknown}>} 工具调用记录（按调用顺序） */
    const toolCalls = [];
    /** toolCallId → 对应记录，用于把 tool-result / tool-error 回填到 tool-call */
    const recordByCallId = new Map();
    /** 致命流错误（非中止）；循环结束后据实抛出，与 Phase 1 的「非中止异常向上抛」保持一致 */
    let streamError;

    const emit = (fn, payload) => {
        if (typeof fn === 'function') fn(payload);
    };
    /** 按 toolCallId 找回调用记录；若找不到（如仅出现 provider 侧结果）则补建一条并保序。 */
    const findOrCreateRecord = (part) => {
        let record = part.toolCallId ? recordByCallId.get(part.toolCallId) : undefined;
        if (!record) {
            record = { name: part.toolName, args: part.input, result: undefined };
            toolCalls.push(record);
            if (part.toolCallId) recordByCallId.set(part.toolCallId, record);
        }
        return record;
    };

    try {
        // 遍历 fullStream：同时捕获文本增量、推理增量、工具调用/结果与错误（fullStream 保留 text-delta）。
        for await (const part of result.fullStream) {
            switch (part.type) {
                case 'text-delta': {
                    // v7 中文本增量字段名为 text（非 textDelta）。
                    full += part.text;
                    emit(onToken, part.text);
                    break;
                }
                case 'reasoning-delta': {
                    // 推理（思考链）增量：字段名同为 text（非 delta，delta 属 UIMessageChunk）。
                    // 仅累计并回调，不并入可见文本 full；供 UI 显示「思考中…」。
                    reasoning += part.text;
                    emit(onReasoning, part.text);
                    break;
                }
                case 'tool-call': {
                    const record = { name: part.toolName, args: part.input, result: undefined };
                    toolCalls.push(record);
                    if (part.toolCallId) recordByCallId.set(part.toolCallId, record);
                    emit(onToolCall, { name: part.toolName, args: part.input });
                    break;
                }
                case 'tool-result': {
                    const record = findOrCreateRecord(part);
                    record.result = part.output;
                    emit(onToolResult, { name: part.toolName, result: part.output });
                    break;
                }
                case 'tool-error': {
                    // 工具 execute 抛错：SDK 不终止循环，而是回灌给模型；这里记录并回调（视作一次「完成」）。
                    const record = findOrCreateRecord(part);
                    record.result = part.error;
                    emit(onToolResult, { name: part.toolName, result: part.error });
                    break;
                }
                case 'error': {
                    // 致命流错误：中止时静默，其它情况记录待循环结束后抛出。
                    if (!(signal?.aborted || part.error?.name === 'AbortError')) {
                        streamError = streamError ?? part.error;
                    }
                    break;
                }
                case 'abort': {
                    // 外部中止：SDK 以 abort part 收尾，正常退回已累积内容（由下方 signal?.aborted 兜底）。
                    break;
                }
                default:
                    // finish / finish-step / reasoning-start / reasoning-end / reasoning-file /
                    // tool-input-* 等本阶段不消费（推理增量 reasoning-delta 已在上方单独处理）。
                    break;
            }
        }
    } catch (error) {
        // 中止属于正常结束：返回已累积文本与工具记录，不向上抛（由上层决定后续处理）。
        if (signal?.aborted || error?.name === 'AbortError') {
            return { text: full, reasoning, toolCalls };
        }
        // 其它异常：交给上层处理。
        throw error;
    }

    // 循环中通过 error part 暴露的非中止错误：据实抛出（与 Phase 1 行为一致）。
    if (streamError) throw streamError;

    return { text: full, reasoning, toolCalls };
}

export default { runAgent };
