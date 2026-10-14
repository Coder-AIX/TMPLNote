/**
 * Markdown → HTML 转换工具（用于导入 .md 文件 / ZIP 内的 md 文件）。
 *
 * 基于 marked 将 Markdown 解析为 HTML；随后用 DOMParser 做后处理：
 * - 将 markdown 中的相对路径图片（如 `./img/a.png`）回填为 dataURL；
 * - 安全清洗：移除 <script>、所有 `on*` 事件属性、以及 `javascript:` 链接。
 *
 * 模块内不依赖项目其它模块，可在浏览器环境直接使用（依赖 DOMParser）。
 */
import { marked } from 'marked';

/**
 * 判断给定值是否为可用于图片替换的 Map。
 *
 * @param {*} value 待判断的值。
 * @returns {boolean} 是 Map 实例返回 true。
 */
function isImageMap(value) {
    return typeof Map !== 'undefined' && value instanceof Map;
}

/**
 * 对解析得到的 HTML 文档做后处理：图片回填与安全清洗。
 *
 * @param {Document} doc DOMParser 解析出的 HTML 文档对象。
 * @param {Map<string, string>|undefined} images 图片映射表，key 为 md 中的
 * 相对路径，value 为 dataURL；缺省或非 Map 时跳过图片替换。
 */
function postProcess(doc, images) {
    // 图片回填：src 命中映射表时替换为 dataURL
    if (isImageMap(images)) {
        const imgs = doc.querySelectorAll('img');
        imgs.forEach((img) => {
            const src = img.getAttribute('src');
            if (src && images.has(src)) {
                img.setAttribute('src', images.get(src));
            }
        });
    }

    // 安全清洗 1：移除所有 <script> 节点
    doc.querySelectorAll('script').forEach((node) => node.remove());

    // 安全清洗 2：遍历所有元素，移除 on* 事件属性并处理 javascript: 协议
    doc.querySelectorAll('*').forEach((el) => {
        // 收集需要移除的属性名，避免边遍历边修改属性集合
        const toRemove = [];
        for (const attr of Array.from(el.attributes)) {
            const name = attr.name.toLowerCase();
            if (name.startsWith('on')) {
                toRemove.push(attr.name);
                continue;
            }
            // href / src 为 javascript: 协议时置空
            if ((name === 'href' || name === 'src')) {
                const value = (attr.value || '').replace(/\s/g, '').toLowerCase();
                if (value.startsWith('javascript:')) {
                    el.setAttribute(attr.name, '');
                }
            }
        }
        toRemove.forEach((name) => el.removeAttribute(name));
    });
}

/**
 * Markdown → HTML。
 *
 * 将 Markdown 文本解析为 HTML，并在浏览器环境用 DOMParser 做后处理：
 * - 依据 images 映射将图片 src 回填为 dataURL；
 * - 清洗掉 <script>、on* 事件属性与 javascript: 链接；
 * - 返回 body 的 innerHTML。
 *
 * 非字符串输入的 md 按空字符串处理；转换或后处理异常时返回 ''，不抛出。
 *
 * @param {string} md 待转换的 Markdown 文本。
 * @param {{images?: Map<string, string>}} [options] 选项；images 的 key 为 md
 * 中图片的相对路径，value 为对应的 dataURL。
 * @returns {string} 清洗后的 HTML。
 */
export function markdownToHtml(md, { images } = {}) {
    // 非字符串输入按空字符串处理
    const source = typeof md === 'string' ? md : '';

    let html;
    try {
        // 转换：GFM 语法 + 换行即 <br>
        html = marked.parse(source, { gfm: true, breaks: true });
    } catch (error) {
        console.error('[markdownToHtml] Markdown 解析失败：', error);
        return '';
    }

    try {
        // 浏览器环境：用 DOMParser 做后处理
        const doc = new DOMParser().parseFromString(html, 'text/html');
        postProcess(doc, images);
        return doc.body.innerHTML;
    } catch (error) {
        // 后处理失败时回退为原始转换结果，避免整体导入失败
        console.error('[markdownToHtml] 后处理失败，回退为原始 HTML：', error);
        return typeof html === 'string' ? html : '';
    }
}

export default markdownToHtml;
