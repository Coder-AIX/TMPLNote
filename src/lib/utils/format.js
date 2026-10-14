/**
 * 通用格式化工具（纯函数，无外部依赖，兼容 SSR/构建环境）。
 */

const MINUTE_MS = 60 * 1000; // 1 分钟
const HOUR_MS = 60 * MINUTE_MS; // 1 小时
const DAY_MS = 24 * HOUR_MS; // 1 天

/**
 * 将时间戳格式化为相对时间字符串。
 *
 * 分档规则（diff = Date.now() - ts，单位毫秒）：
 * - diff < 0          → '刚刚'（未来时间按刚刚处理）
 * - diff < 1 分钟      → '刚刚'
 * - diff < 60 分钟     → `${分钟} 分钟前`（向下取整）
 * - diff < 24 小时     → `${小时} 小时前`
 * - diff < 48 小时     → '昨天'
 * - diff < 30 天       → `${天数} 天前`
 * - 其它               → 'YYYY-MM-DD'（本地时间，补零）
 *
 * @param {number|string|null|undefined} ts 毫秒时间戳（数字或可转数字的值）。
 * @returns {string} 相对时间字符串；无效输入返回空字符串。
 */
export function formatRelativeTime(ts) {
    // 无效输入：null / undefined / NaN / 非数字
    if (ts === null || ts === undefined) {
        return '';
    }
    if (typeof ts === 'string' && ts.trim() === '') {
        return '';
    }
    const value = Number(ts);
    if (!Number.isFinite(value)) {
        return '';
    }

    const diff = Date.now() - value;

    // 未来时间按「刚刚」处理
    if (diff < 0) {
        return '刚刚';
    }
    if (diff < MINUTE_MS) {
        return '刚刚';
    }
    if (diff < HOUR_MS) {
        return `${Math.floor(diff / MINUTE_MS)} 分钟前`;
    }
    if (diff < DAY_MS) {
        return `${Math.floor(diff / HOUR_MS)} 小时前`;
    }
    // 注意顺序：先判断「昨天」窗口（24–48 小时），再判断「N 天前」
    if (diff < 2 * DAY_MS) {
        return '昨天';
    }
    if (diff < 30 * DAY_MS) {
        return `${Math.floor(diff / DAY_MS)} 天前`;
    }

    // 其它：格式化为本地时间 YYYY-MM-DD
    const date = new Date(value);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * 将 HTML 转为纯文本摘要。
 *
 * 处理步骤：去除 HTML 标签 → 解码常见实体 → 折叠连续空白为单个空格 → 去首尾空白。
 * 若结果长度超过 maxLen，则截断到 maxLen 并追加省略号 '…'。
 *
 * @param {string} html HTML 字符串（可能含标签，也可能已是纯文本）。
 * @param {number} [maxLen=40] 摘要最大长度。
 * @returns {string} 纯文本摘要；非字符串输入返回空字符串。
 */
export function htmlToText(html, maxLen = 40) {
    // 非字符串输入按空字符串处理
    if (typeof html !== 'string') {
        return '';
    }

    // 1. 去除 HTML 标签
    let text = html.replace(/<[^>]*>/g, '');

    // 2. 解码常见实体（&amp; 最后解码，避免二次解码）
    text = text
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');

    // 3. 折叠连续空白（含换行）为单个空格，并去首尾空白
    text = text.replace(/\s+/g, ' ').trim();

    // 4. 超长截断并追加省略号
    if (text.length > maxLen) {
        return text.slice(0, maxLen) + '…';
    }
    return text;
}
