/**
 * 纯文本 → HTML 转换工具（用于导入 .txt）。
 *
 * 仅做纯字符串处理，不依赖任何 DOM 或其它模块，可在任意环境使用。
 * 与 htmlToText.js 的 `htmlToPlainText` 互为反向转换。
 */

/**
 * 对文本做 HTML 实体转义。
 *
 * 转义顺序很关键：必须先替换 `&`，否则后续生成的实体（如 `&lt;`）会被再次转义。
 * 依次处理 `&`、`<`、`>`、`"`。
 *
 * @param {string} value 待转义的原始文本。
 * @returns {string} 已转义的文本，可安全嵌入 HTML。
 */
function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * 纯文本 → HTML 段落（空行分段，段内单换行 <br>）。
 *
 * 处理规则：
 * - 非字符串输入按空字符串处理；
 * - 去除开头的 BOM（`\uFEFF`）；
 * - 归一化换行：`\r\n`、`\r` 统一为 `\n`；
 * - 按空行（`/\n\s*\n/`，允许空行含空白字符）切分段落；
 * - 每段内的单个 `\n` 转为 `<br>`，整段包裹为 `<p>…</p>`；
 * - 段落两端空白会被去除，空段（含末尾空段）被丢弃；
 * - 段落之间不产生任何多余空白，空输入返回 `''`。
 *
 * @param {string} text 待转换的纯文本。
 * @returns {string} HTML 段落字符串；非字符串或空输入返回空字符串。
 */
export function textToHtml(text) {
    // 非字符串输入按空字符串处理
    if (typeof text !== 'string') {
        return '';
    }

    // 去除 BOM，并归一化换行（\r\n / \r → \n）
    const normalized = text
        .replace(/^\uFEFF/, '')
        .replace(/\r\n?/g, '\n');

    // 按空行切分段落，去掉每段两端空白并丢弃空段（含末尾空段）
    const paragraphs = normalized
        .split(/\n\s*\n/)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph.length > 0);

    // 逐段转义、段内换行转 <br>，再包裹 <p>，段间无多余空白
    return paragraphs
        .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`)
        .join('');
}

export default textToHtml;
