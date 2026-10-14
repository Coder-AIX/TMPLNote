/**
 * DOCX → HTML 转换工具（用于导入 Word 文件）。
 *
 * 借助 mammoth 将 `.docx` 字节解析为语义化 HTML；默认会提取文档内嵌图片，
 * 并以 data URI（dataURL）形式内联到 `<img src>`，便于导入后回填图片。
 *
 * 依赖说明：
 * - 使用 `mammoth@^1.13.0`。该库体积较大，故 **在函数内部动态 import**，避免进入首屏。
 * - mammoth 浏览器构建在解析图片时会自动输出 data URI，无需额外配置。
 * - 兼容浏览器 / 构建环境；输入可为 `Blob` / `ArrayBuffer` / `Uint8Array`。
 *
 * 模块不引入任何项目内其它文件，保持独立可测。
 */

/**
 * .docx 字节 → HTML（图片以 dataURL 内联）。
 *
 * 输入归一化规则：
 * - `Blob` → `await input.arrayBuffer()`；
 * - `ArrayBuffer` → 直接使用；
 * - `Uint8Array` → 取其精确切片（规避视图偏移，保证底层字节完整且无多余前缀）；
 * - 其它类型 → 抛出中文 Error。
 *
 * 解析失败（动态导入失败或 mammoth 转换异常）时，统一抛出中文 Error，
 * 并附上原始错误信息便于排查。
 *
 * @param {ArrayBuffer|Uint8Array|Blob} input `.docx` 文件字节。
 * @returns {Promise<{html: string, messages: Array}>} HTML 字符串与 mammoth 消息数组。
 */
export async function docxToHtml(input) {
    // mammoth 体积较大，函数内动态导入以避免进首屏
    let mammoth;
    try {
        const mod = await import('mammoth');
        mammoth = mod.default ?? mod;
    } catch (error) {
        throw wrapError(error);
    }

    // 归一化输入为 { arrayBuffer }
    const arrayBuffer = await normalizeInput(input);

    let result;
    try {
        result = await mammoth.convertToHtml({ arrayBuffer: arrayBuffer });
    } catch (error) {
        throw wrapError(error);
    }

    // 默认 mammoth 会将图片转为 data URI，符合图片回填需求
    return {
        html: result.value,
        messages: result.messages || []
    };
}

export default docxToHtml;

/**
 * 将多种输入类型归一化为 `ArrayBuffer`。
 *
 * - `Blob` → 调用其 `arrayBuffer()`；
 * - `ArrayBuffer` → 原样返回；
 * - `Uint8Array` → 精确切片，去除 `byteOffset`/`byteLength` 之外的多余字节；
 * - 其它类型 → 抛出中文 Error。
 *
 * @param {ArrayBuffer|Uint8Array|Blob} input 原始输入。
 * @returns {Promise<ArrayBuffer>} 归一化后的字节缓冲。
 * @throws {Error} 输入类型不受支持时抛出。
 */
async function normalizeInput(input) {
    // Blob：优先于其它判断（部分 Blob 实现亦为对象，需先识别）
    if (typeof Blob !== 'undefined' && input instanceof Blob) {
        return input.arrayBuffer();
    }

    // ArrayBuffer 视图（含 Uint8Array）需先于裸 ArrayBuffer 判断
    if (input instanceof Uint8Array) {
        return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    }

    if (input instanceof ArrayBuffer) {
        return input;
    }

    throw new Error('无法解析 Word 文件。（不支持的输入类型）');
}

/**
 * 将底层异常包装为统一的中文错误信息。
 *
 * 保留原始信息：存在 `error.message` 时以 `（原信息）` 形式附加，否则仅返回基础提示。
 *
 * @param {unknown} error 原始异常。
 * @returns {Error} 统一格式的中文错误。
 */
function wrapError(error) {
    const message = error && error.message ? String(error.message) : '';
    return new Error('无法解析 Word 文件。' + (message ? '（' + message + '）' : ''));
}
