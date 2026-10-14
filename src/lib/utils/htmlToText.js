/**
 * HTML → 纯文本转换工具（用于导出 .txt）。
 *
 * 与 format.js 的 `htmlToText`（单行摘要）区分：本模块导出 `htmlToPlainText`，
 * 会保留段落/块级元素之间的换行结构。仅在浏览器环境使用 DOMParser。
 */

/**
 * 需要在输出前后各补一个换行、以形成独立行的块级标签集合。
 */
const BLOCK_TAGS = new Set([
    'p',
    'div',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'li',
    'blockquote',
    'pre',
    'tr',
    'ul',
    'ol',
    'table',
    'section'
]);

/**
 * 将笔记 HTML 转换为纯文本，保留段落换行。
 *
 * 处理规则：
 * - 非字符串输入返回空字符串；
 * - 使用 `DOMParser` 解析后递归遍历 `doc.body`：
 *   - 块级标签（见 {@link BLOCK_TAGS}）在输出前后各补 `\n`，使块之间各自成行；
 *   - `<br>` 转为 `\n`；
 *   - `<img>` 转为 `[图片: ${src}]` 占位符；
 *   - 文本节点取其 `textContent`（自动解码实体）。
 * - 最终折叠连续 3 个及以上换行为 2 个、去除每行行尾空白、并整体 `trim()`。
 *
 * @param {string} html 笔记 HTML 字符串。
 * @returns {string} 保留段落换行的纯文本；非字符串输入返回空字符串。
 */
export function htmlToPlainText(html) {
    // 非字符串输入按空字符串处理
    if (typeof html !== 'string') {
        return '';
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');

    // 以文本片段数组拼接，最后统一 join
    const parts = [];

    /**
     * 递归遍历节点，把文本片段推入 parts。
     *
     * @param {Node} node 当前待处理节点。
     */
    function walk(node) {
        // 文本节点：直接取内容（textContent 已自动解码 HTML 实体）
        if (node.nodeType === 3) {
            parts.push(node.textContent || '');
            return;
        }
        // 仅处理元素节点
        if (node.nodeType !== 1) {
            return;
        }

        const tagName = node.tagName ? node.tagName.toLowerCase() : '';

        // 换行标签
        if (tagName === 'br') {
            parts.push('\n');
            return;
        }

        // 图片占位符
        if (tagName === 'img') {
            const src = node.getAttribute('src') || '';
            parts.push(`[图片: ${src}]`);
            return;
        }

        // 块级标签：前后各补换行，使块各自成行
        const isBlock = BLOCK_TAGS.has(tagName);
        if (isBlock) {
            parts.push('\n');
        }

        // 递归处理子节点
        const children = node.childNodes;
        for (let i = 0; i < children.length; i += 1) {
            walk(children[i]);
        }

        if (isBlock) {
            parts.push('\n');
        }
    }

    walk(doc.body);

    // 去除每行行尾空格/制表符
    let text = parts
        .join('')
        .split('\n')
        .map((line) => line.replace(/[ \t]+$/, ''))
        .join('\n');

    // 折叠连续 3 个及以上换行为 2 个
    text = text.replace(/\n{3,}/g, '\n\n');

    return text.trim();
}

export default htmlToPlainText;
