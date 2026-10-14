/**
 * HTML → Markdown 转换工具（用于导出 .md 文件）。
 *
 * 基于 turndown 与 turndown-plugin-gfm：支持标题（ATX）、分割线、无序列表、
 * 围栏代码块、GitHub 风格表格/任务列表/删除线；并保留 <u>/<mark>/<sub>/<sup>
 * 等内联标签为原始 HTML。图片默认转换为 `![](src)` 形式。
 *
 * 模块级复用同一个 TurndownService 实例（单例），避免重复初始化开销。
 */
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

/**
 * 单例 TurndownService 实例。
 *
 * 配置说明：
 * - headingStyle: 'atx'    标题用 `#` 前缀（如 `## 标题`）。
 * - hr: '---'              分割线输出为 `---`。
 * - bulletListMarker: '-'  无序列表标记使用 `-`。
 * - codeBlockStyle: 'fenced'  代码块使用 ``` 围栏。
 * - emDelimiter: '*'       强调（斜体）使用 `*`。
 * - 启用 GFM 插件以获得表格、任务列表、删除线支持。
 * - 保留 u / mark / sub / sup 内联标签为 HTML。
 *
 * @type {TurndownService}
 */
const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*'
});

// 启用 GitHub 风格 Markdown（表格 / 任务列表 / 删除线）
service.use(gfm);

// 保留这些内联标签为原始 HTML（Markdown 无对应语法）
service.keep(['u', 'mark', 'sub', 'sup']);

/**
 * 将笔记 HTML 转换为 Markdown 字符串。
 *
 * 非字符串输入按空字符串处理并返回 ''。转换过程用 try/catch 包裹，
 * 出现异常时回退为原始 HTML（若为字符串），避免整体导出失败。
 *
 * @param {string} html 待转换的 HTML 字符串。
 * @returns {string} 转换后的 Markdown；非字符串输入返回 ''；转换异常时返回原 HTML 或 ''。
 */
export function htmlToMarkdown(html) {
    // 非字符串输入按空字符串处理
    if (typeof html !== 'string') {
        return '';
    }

    try {
        return service.turndown(html);
    } catch (error) {
        // 转换失败时回退为原始 HTML，避免导出整体失败
        console.error('[htmlToMarkdown] 转换失败，回退为原始 HTML：', error);
        return html || '';
    }
}

export default htmlToMarkdown;
