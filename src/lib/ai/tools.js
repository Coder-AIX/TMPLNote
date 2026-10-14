/**
 * tools.js — AI 数据工具（IndexedDB 只读 + 写入授权网关）
 *
 * 只读工具：list_folders / search_notes / list_notes / get_note（本阶段全部可用）。
 * 写入工具：已注册 create_note（AI 新建笔记）；机制要求——凡 kind==='write' 的工具，
 *            执行前必须经 runTool 的授权分支 await requestAiPermission(...) 获得用户允许，
 *            否则拒绝执行。任何写能力都**只能**经受权的 runTool 触发，禁止绕过授权直接调用。
 * 上下文检索：buildContext 已改为**关键词加权检索**（抽取关键词后多词检索、按命中数与标题加权排序）。
 */
import { tool } from 'ai';
import { z } from 'zod';
import notesRepository from '../db/notes.js';
import foldersRepository from '../db/folders.js';
import { ROOT_ID } from '../db/schema.js';
import { requestAiPermission } from '../stores/aiPermission.js';

/** 粗略去除 HTML 标签并压缩空白（笔记正文可能是富文本） */
function toPlainText(html) {
    return String(html ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** 截断到 n 个字符，超出加省略号 */
function truncate(text, n) {
    const s = String(text ?? '');
    const max = Number(n) || 0;
    if (max <= 0 || s.length <= max) return s;
    return `${s.slice(0, max)}…`;
}

/** 将一条笔记映射为精简的检索结果结构 */
function toBrief(note) {
    return {
        id: note.id,
        title: note.title,
        folderId: String(note.folderId ?? ROOT_ID) || ROOT_ID,
        excerpt: truncate(toPlainText(note.content), 800),
        updatedAt: note.updatedAt
    };
}

/** 常见停用词/疑问词（命中时忽略，避免噪声） */
const STOPWORDS = new Set([
    '的', '了', '是', '我', '你', '他', '她', '它', '们', '这', '那',
    '这个', '那个', '什么', '怎么', '如何', '为什么', '请问', '请', '帮',
    '帮我', '一下', '以及', '和', '与', '或', '在', '有', '没有', '吗',
    '呢', '吧', '啊', '能', '可以', '会', '要', '想', '知道', '告诉',
    '查询', '搜索', '找', '看看', '关于', '我的', '一个', '一些', '多少',
    '哪', '哪些', '谁', '时候', '地方', '内容', '笔记', '记录', '里面'
]);

/**
 * 从问句中抽取检索关键词：按非字母数字分隔，中文额外生成 2-gram；过滤停用词。
 * @param {string} text
 * @param {number} [max]
 * @returns {string[]}
 */
function extractKeywords(text, max = 8) {
    const s = String(text ?? '').toLowerCase();
    const tokens = s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const out = [];
    const push = (w) => {
        if (!w || w.length < 2 || STOPWORDS.has(w) || out.includes(w)) return;
        out.push(w);
    };
    for (const t of tokens) {
        if (/\p{Script=Han}/u.test(t)) {
            push(t);
            for (let i = 0; i + 2 <= t.length; i++) push(t.slice(i, i + 2));
        } else {
            push(t);
        }
    }
    return out.slice(0, max);
}

/** 列出文件夹（扁平化）→ [{ id, name, parentId }] */
export async function listFolders() {
    const roots = await foldersRepository.tree();
    const out = [];
    const walk = (nodes) => {
        for (const node of nodes || []) {
            out.push({
                id: node.id,
                name: node.name,
                parentId: String(node.parentId ?? ROOT_ID) || ROOT_ID
            });
            if (node.children && node.children.length) walk(node.children);
        }
    };
    walk(roots);
    return out;
}

/** 关键词检索笔记 → [{ id, title, folderId, excerpt, updatedAt }] */
export async function searchNotes(keyword, limit = 5) {
    const kw = String(keyword ?? '').trim();
    if (!kw) return [];
    const rows = await notesRepository.list({ search: kw });
    const max = Number(limit) > 0 ? Number(limit) : 5;
    return rows.slice(0, max).map(toBrief);
}

/** 列出笔记（可按文件夹）→ [{ id, title, folderId, excerpt, updatedAt }] */
export async function listNotes({ folderId, limit = 20 } = {}) {
    // folderId 为 undefined 表示全部；'' 表示未分类；其它为指定文件夹，直接透传。
    const rows = await notesRepository.list({ folderId });
    const max = Number(limit) > 0 ? Number(limit) : 20;
    return rows.slice(0, max).map(toBrief);
}

/** 读取单条笔记全文 → { id, title, content, updatedAt }（正文转纯文本） */
export async function getNote(id) {
    if (!id) return null;
    const note = await notesRepository.get(id);
    if (!note) return null;
    return {
        id: note.id,
        title: note.title,
        content: toPlainText(note.content),
        updatedAt: note.updatedAt
    };
}

/**
 * 组装上下文片段文本（供 system 注入）。
 * 采用关键词抽取 + 多词加权检索：命中越多、标题命中权重越高者排前。
 *
 * 长度预算：用于控制注入到提示中的文本长度，避免片段过长挤占 n_ctx 导致工具定义被截断。
 * - maxCharsPerNote：单条笔记正文的最大字符数，超出则在字符层面截断并补「…」（只影响注入文本，不改数据库原笔记）。
 * - maxTotalChars：所有注入片段合计的最大字符数，累计达到上限后停止注入后续笔记。
 * - maxChars：旧参数，作为 total 预算的兼容别名；显式传入时优先于 maxTotalChars。
 *
 * 截断一律在「字符」层面进行（不按 token 估算），并在截断处补「…」，避免出现半截 JSON/代码。
 * 无关键词或无匹配时返回空串；函数不抛异常。
 *
 * @param {string} question 用户问句，用于抽取关键词
 * @param {{limit?:number, maxCharsPerNote?:number, maxTotalChars?:number, maxChars?:number}} [options]
 * @returns {Promise<string>} 拼接好的上下文片段文本（可能为空串）
 */
export async function buildContext(question, {
    limit = 5,
    maxCharsPerNote = 600,
    maxTotalChars = 2400,
    maxChars
} = {}) {
    const q = String(question ?? '').trim();
    if (!q) return '';
    const keywords = extractKeywords(q, 8);
    if (!keywords.length) return '';

    /** @type {Map<string, { note: object, score: number }>} */
    const scored = new Map();
    for (const kw of keywords) {
        const rows = await notesRepository.list({ search: kw });
        for (const note of rows) {
            const title = String(note.title ?? '').toLowerCase();
            const titleHit = title.includes(kw) ? 3 : 0;
            const prev = scored.get(note.id);
            if (prev) prev.score += 1 + titleHit;
            else scored.set(note.id, { note, score: 1 + titleHit });
        }
    }

    const top = [...scored.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, Number(limit) > 0 ? Number(limit) : 5)
        .map((x) => x.note);
    if (!top.length) return '';

    // 长度预算：单条上限 + 合计上限（旧参数 maxChars 作为合计预算的兼容别名）。
    const perNote = Number(maxCharsPerNote) > 0 ? Number(maxCharsPerNote) : 600;
    const totalCap = Number(maxChars) > 0
        ? Number(maxChars)
        : (Number(maxTotalChars) > 0 ? Number(maxTotalChars) : 2400);

    let text = '';
    for (const note of top) {
        if (text.length >= totalCap) break; // 已达合计上限，停止注入后续笔记
        const title = String(note.title ?? '').trim() || '（未命名）';
        // 单条正文按 maxCharsPerNote 在字符层面截断，超出补「…」。
        const body = truncate(toPlainText(note.content), perNote);
        const block = `【${title}】\n${body}\n\n`;
        const remain = totalCap - text.length;
        if (block.length > remain) {
            // 剩余预算不足以放下整块：按字符截断并补「…」后收尾。
            if (remain > 0) text += truncate(block, remain);
            break;
        }
        text += block;
    }
    return text.trim();
}

/**
 * 创建一条新笔记（写入工具）。
 * 注意：该函数只被 runTool 在获得用户授权后调用；不要在其他地方直接调用绕过授权。
 * @param {{title?:string, content:string, folderId?:string}} input
 * @returns {Promise<Object>} 新建的笔记
 */
export async function createNote({ title, content, folderId } = {}) {
    const t = String(title ?? '').trim() || 'AI 笔记';
    const c = String(content ?? '');
    return notesRepository.create({ title: t, content: c, ...(folderId !== undefined ? { folderId } : {}) });
}

/** 工具注册表（kind: 'read' | 'write'） */
export const TOOLS = [
    { name: 'list_folders', kind: 'read', description: '列出全部文件夹', parameters: { type: 'object', properties: {} }, run: () => listFolders() },
    { name: 'search_notes', kind: 'read', description: '按关键词检索笔记', parameters: { type: 'object', properties: { keyword: { type: 'string' }, limit: { type: 'number' } }, required: ['keyword'] }, run: ({ keyword, limit }) => searchNotes(keyword, limit ?? 5) },
    { name: 'list_notes', kind: 'read', description: '列出笔记（可按文件夹）', parameters: { type: 'object', properties: { folderId: { type: 'string' }, limit: { type: 'number' } } }, run: (args) => listNotes(args || {}) },
    { name: 'get_note', kind: 'read', description: '读取单条笔记全文', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, run: ({ id }) => getNote(id) },
    {
        name: 'create_note',
        kind: 'write',
        description: '创建一条新笔记',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: '笔记标题' },
                content: { type: 'string', description: '笔记正文' },
                folderId: { type: 'string', description: '目标文件夹 id（可省略）' }
            },
            required: ['content']
        },
        describe: (args) => `标题：${String(args?.title ?? '').trim() || '（未命名）'}；正文约 ${String(args?.content ?? '').length} 字`,
        run: (args) => createNote(args)
    }
];

/**
 * 执行工具。写入类工具（kind==='write'）**强制**先经用户授权：
 * 用户拒绝则返回 { denied: true }，不执行任何写操作。
 * @param {string} name
 * @param {object} [args]
 */
export async function runTool(name, args = {}) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`未知工具：${name}`);
    if (tool.kind === 'write') {
        const detail = typeof tool.describe === 'function'
            ? tool.describe(args)
            : `参数：${JSON.stringify(args)}`;
        const allowed = await requestAiPermission({ title: `AI 请求：${tool.description}`, detail });
        if (!allowed) return { denied: true };
    }
    return tool.run(args);
}

/**
 * AI SDK 原生工具集（供 agent.js 的 streamText({ tools }) 使用）。
 *
 * Why：AI SDK 7 的 tool() 要求 inputSchema（zod）+ execute，与自有 TOOLS 的
 * OpenAI 风格 parameters 不通用。这里为每个工具声明原生定义，但 execute **一律**
 * 转发给 runTool(name, args)——绝不直接调用数据函数——从而完整复用 runTool 内的
 * 写授权逻辑（kind==='write' 会先弹窗请求用户允许，拒绝则返回 { denied: true }）。
 * 注意：zod 校验后的对象可能带 undefined 字段，runTool / 数据函数已能容忍。
 */
export const AI_TOOLS = {
    list_folders: tool({
        description: '列出全部文件夹',
        inputSchema: z.object({}),
        execute: () => runTool('list_folders', {})
    }),
    search_notes: tool({
        description: '按关键词检索笔记',
        inputSchema: z.object({
            keyword: z.string().describe('检索关键词'),
            limit: z.number().optional().describe('返回条数上限，默认 5')
        }),
        execute: ({ keyword, limit }) => runTool('search_notes', { keyword, limit })
    }),
    list_notes: tool({
        description: '列出笔记（可按文件夹）',
        inputSchema: z.object({
            folderId: z.string().optional().describe('目标文件夹 id（省略则列出全部）'),
            limit: z.number().optional().describe('返回条数上限，默认 20')
        }),
        execute: ({ folderId, limit }) => runTool('list_notes', { folderId, limit })
    }),
    get_note: tool({
        description: '读取单条笔记全文',
        inputSchema: z.object({ id: z.string().describe('笔记 id') }),
        execute: ({ id }) => runTool('get_note', { id })
    }),
    // 写操作：runTool 内部会 await requestAiPermission(...)，用户拒绝则返回 { denied: true }。
    create_note: tool({
        description: '创建一条新笔记',
        inputSchema: z.object({
            title: z.string().optional().describe('笔记标题'),
            content: z.string().describe('笔记正文'),
            folderId: z.string().optional().describe('目标文件夹 id（可省略）')
        }),
        execute: ({ title, content, folderId }) => runTool('create_note', { title, content, folderId })
    })
};

export default { listFolders, searchNotes, listNotes, getNote, createNote, buildContext, TOOLS, runTool, AI_TOOLS };
