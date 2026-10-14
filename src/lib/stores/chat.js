/**
 * chat.js — 对话会话 store（P4：对话状态与生成循环）
 *
 * 职责：
 * - 持有「本地 GGUF + WebGPU 对话」功能的会话状态，供对话页订阅；
 * - 编排一次完整对话：追加用户消息 → 组装 prompt → 调 Agent 流式生成 → 增量渲染 → 落库；
 * - 会话元数据（摘要列表）与消息正文分离：列表走 sessions，正文走 messages；
 * - 维护 thinking（思考中）状态供对话页显示：已收到推理增量但尚无可见文本时置真，出现可见文本或生成结束即置假。
 *
 * 说明：工具调用循环已交由 AI SDK Agent（../ai/agent.js 的 runAgent）处理——
 *   runAgent 内部使用 streamText + 原生工具集（AI_TOOLS）自动完成「模型 → 工具 → 回灌 → 模型」
 *   的多轮循环，本文件只负责会话状态与消息流（组装消息、流式渲染、落库、标题、中止）。
 *
 * 数据流 / 状态流转：
 *   载入列表  loadSessions()      → sessions.set(仓储 list()，按 updatedAt 倒序)
 *   新建会话  newSession()        → 仓储 create → currentId → messages=[] → 刷新列表
 *   打开会话  openSession(id)     → 仓储 get    → currentId → messages=会话消息
 *   删除会话  removeSession(id)   → 仓储 remove → 若为当前则清空 → 刷新列表
 *   发送消息  sendMessage(text)   → 校验 → 确保会话 → 追加 user → 组装 prompt
 *                                 → 插入 assistant 占位 → runAgent 流式 onToken 增量渲染
 *                                 → 用完整文本收尾并 appendMessage 落库 → 首轮写标题
 *   中止生成  abortGeneration()   → controller.abort()，保留已生成内容
 *
 * 生成流程要点：
 * - prompt 组装为「system + 历史消息 + 本轮 user」，system 置于最前，仅取 role/content；
 * - 生成期间 generating=true，结束（含异常 / 中止）后 finally 置 false 并清空 controller；
 * - 被主动中止时视为正常结束，不写 chatError，保留已生成的增量内容；
 * - 首轮对话以用户文本截断为会话标题；每轮结束后刷新摘要列表。
 *
 * 说明：发送前按设置（aiUseNotesContext）检索本地笔记并注入 system；检索为只读，
 * 仅读取，不写库；检索异常被捕获，降级为无上下文，不影响正常对话。
 */
import { writable, get } from 'svelte/store';
import chatRepository from '../db/chats.js';
import { ai } from './ai.js';
import { buildContext, AI_TOOLS } from '../ai/tools.js';
import { runAgent } from '../ai/agent.js';
import { settings } from './settings.js';

/**
 * system 提示（中性助手人设；P5 会在此追加本地笔记上下文）
 * 末尾 `/no_think` 为 Qwen 系关闭思考链的软开关：与引擎 `enable_thinking:false` 叠加构成「双保险」，
 * 彻底关闭思考链以避免首 token 延迟过高（思考链未完全关闭时会先产出大量推理增量而迟迟无可见文本）。
 */
const SYSTEM_PROMPT = '你是 TMPLNote 的本地 AI 助手，回答简洁、准确、有帮助。 /no_think';

/** 会话摘要列表（不含 messages） */
export const sessions = writable([]);
/** 当前会话消息 [{ id, role, content, createdAt }] */
export const messages = writable([]);
/** 当前会话 id（null 表示无） */
export const currentId = writable(null);
/** 是否正在生成 */
export const generating = writable(false);
/** 本次生成是否正在思考（已收到 reasoning 增量但尚无可见文本），供对话页显示「思考中…」 */
export const thinking = writable(false);
/** 错误信息 */
export const chatError = writable('');

/** 当前生成的 AbortController（用于中止） */
let controller = null;

/** 流式 token 缓冲区（按帧合并，避免逐 token 重渲染） */
let tokenBuffer = '';
/** 是否已排队一次帧刷新 */
let flushScheduled = false;

/** 把缓冲区内容合并到当前最后一条 assistant 消息 */
function flushTokenBuffer() {
    flushScheduled = false;
    if (!tokenBuffer) return;
    const chunk = tokenBuffer;
    tokenBuffer = '';
    messages.update((list) => {
        const next = [...list];
        const last = next[next.length - 1];
        if (last && last.role === 'assistant') {
            next[next.length - 1] = { ...last, content: last.content + chunk };
        }
        return next;
    });
}

/** 追加 token 到缓冲区，并按帧调度一次刷新 */
function pushToken(t) {
    // 一旦出现可见文本，即认为已脱离「思考中」状态
    thinking.set(false);
    tokenBuffer += t;
    if (flushScheduled) return;
    flushScheduled = true;
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(flushTokenBuffer);
    } else {
        setTimeout(flushTokenBuffer, 60);
    }
}

/** 收到推理（思考链）增量：首次收到时标记为「思考中」，供对话页显示 */
function onReasoningDelta() {
    thinking.set(true);
}

/** 生成唯一 id（优先 crypto.randomUUID，回退时间戳 + 随机串） */
function createId() {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') {
        return c.randomUUID();
    }
    return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 设置指定 id 消息的内容（不变式更新） */
function setMessageContent(id, content) {
    messages.update((list) => list.map((m) => (m.id === id ? { ...m, content } : m)));
}

/** 读取指定 id 消息的当前内容 */
function getLastMessageContent(id) {
    return get(messages).find((m) => m.id === id)?.content ?? '';
}

/** 载入会话摘要列表（按 updatedAt 倒序，不含 messages） */
export async function loadSessions() {
    sessions.set(await chatRepository.list());
}

/** 新建会话并设为当前（可把新会话置顶：其 updatedAt 最新，刷新后位于列表首位） */
export async function newSession() {
    const session = await chatRepository.create();
    currentId.set(session.id);
    messages.set([]);
    await loadSessions();
    return session;
}

/** 打开会话（含 messages） */
export async function openSession(id) {
    if (!id) return;
    const session = await chatRepository.get(id);
    if (!session) return;
    currentId.set(session.id);
    messages.set(session.messages ?? []);
    return session;
}

/** 删除会话（若删除的是当前会话则清空 currentId / messages） */
export async function removeSession(id) {
    if (!id) return;
    await chatRepository.remove(id);
    if (get(currentId) === id) {
        currentId.set(null);
        messages.set([]);
    }
    await loadSessions();
}

/**
 * 发送消息：
 * 1) 校验（非空文本、模型就绪，否则写 chatError 并返回）；
 * 2) 若无当前会话则先创建；
 * 3) 追加用户消息（本地 + 持久化 appendMessage）；
 * 4) 组装 prompt messages（system 置最前，仅取 role/content）；
 * 5) 插入一条空的 assistant 占位消息；
 * 6) runAgent 流式：onToken 增量更新最后一条 assistant 消息（工具循环由 Agent 内部处理）；
 * 7) 完成后用完整文本收尾并 appendMessage 落库；首轮以用户文本截断为标题并 save；
 * 8) generating 全程标记；异常写 chatError（被中止时保留已生成内容，不报错）。
 * @param {string} text 用户输入
 */
export async function sendMessage(text) {
    // 1) 文本校验
    const content = String(text ?? '').trim();
    if (!content) return;

    // 1) 就绪校验：模型须已载入
    if (get(ai)?.state !== 'ready') {
        chatError.set('模型尚未载入，请先在设置中载入模型');
        return;
    }

    chatError.set('');

    // 2) 保证有当前会话
    let sessionId = get(currentId);
    if (!sessionId) {
        const session = await chatRepository.create();
        sessionId = session.id;
        currentId.set(sessionId);
        messages.set([]);
    }

    // 记录是否首轮（用于生成后写标题）：以追加用户消息前的消息数为准
    const isFirstTurn = get(messages).length === 0;

    // 3) 追加用户消息（本地 + 持久化）
    const userMsg = { id: createId(), role: 'user', content, createdAt: Date.now() };
    messages.update((list) => [...list, userMsg]);
    await chatRepository.appendMessage(sessionId, userMsg);

    // 4) 组装 prompt：先确定 system 内容（按需追加本地笔记片段），再拼历史（仅取 role/content）
    //    注意：此处从 store 读取，已包含刚追加的用户消息，即本轮 user
    // 是否注入本地笔记上下文（设置 aiUseNotesContext）；检索只读，异常不影响对话
    let systemContent = SYSTEM_PROMPT;
    if (get(settings)?.aiUseNotesContext) {
        try {
            const context = await buildContext(content, { limit: 3 });
            if (context) systemContent += `\n\n可参考以下本地笔记片段：\n${context}`;
        } catch (_) {
            /* 检索失败不影响对话，降级为无上下文 */
        }
    }

    const history = get(messages).map((m) => ({ role: m.role, content: m.content }));
    const convo = [{ role: 'system', content: systemContent }, ...history];

    // 5) 插入 assistant 占位消息（流式期间原地增量填充）
    //    生成开始前重置 token 缓冲与调度状态，避免上一轮残留
    tokenBuffer = '';
    flushScheduled = false;

    const assistantId = createId();
    messages.update((list) => [
        ...list,
        { id: assistantId, role: 'assistant', content: '', createdAt: Date.now() }
    ]);

    // 6) 交由 AI SDK Agent 处理：runAgent 内部完成「模型 → 工具 → 回灌 → 模型」的多轮工具循环
    //    （工具集 AI_TOOLS 已内含写授权），本文件仅消费可见文本增量与最终结果
    thinking.set(false);
    generating.set(true);
    chatError.set('');
    controller = new AbortController();

    try {
        const { text: answer, reasoning, toolCalls } = await runAgent({
            messages: convo,
            tools: AI_TOOLS,
            onToken: pushToken,
            onReasoning: onReasoningDelta,
            signal: controller.signal,
            params: { maxTokens: 768 }
        });
        flushTokenBuffer();

        const finalAnswer = String(answer ?? '').trim();
        if (finalAnswer) {
            // 有最终回答：以完整文本覆盖占位消息（含流式期间可能残留）
            setMessageContent(assistantId, finalAnswer);
        } else {
            // 兜底：无文字回复时按是否有工具调用给出提示
            const hadToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
            setMessageContent(assistantId, hadToolCalls ? '（已执行操作，但模型未给出文字回复）' : '（未能生成回复）');
        }
    } catch (e) {
        if (e?.name === 'AbortError' || controller?.signal.aborted) {
            // 保留已生成内容
        } else {
            chatError.set(e?.message || String(e));
        }
    } finally {
        tokenBuffer = '';
        flushScheduled = false;
        generating.set(false);
        thinking.set(false);
        controller = null;
    }

    // 7) 收尾：以占位消息当前内容为准（含中止时已生成内容）
    const finalText = String(getLastMessageContent(assistantId) ?? '');

    // 7) 落库 assistant 消息
    await chatRepository.appendMessage(sessionId, {
        id: assistantId,
        role: 'assistant',
        content: finalText,
        createdAt: Date.now()
    });

    // 8) 首轮：以用户文本截断（20 字）作为会话标题
    if (isFirstTurn) {
        const sess = await chatRepository.get(sessionId);
        if (sess) {
            sess.title = content.slice(0, 20);
            await chatRepository.save(sess);
        }
    }

    // 8) 刷新摘要列表（updatedAt 变化，排序可能调整）
    await loadSessions();
}

/** 中止当前生成（保留已生成内容，不报错） */
export function abortGeneration() {
    controller?.abort();
    thinking.set(false);
}

export default {
    sessions,
    messages,
    currentId,
    generating,
    thinking,
    chatError,
    loadSessions,
    newSession,
    openSession,
    removeSession,
    sendMessage,
    abortGeneration
};
