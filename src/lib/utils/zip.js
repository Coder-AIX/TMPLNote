/**
 * ZIP 打包 / 解包工具（导出、导入共用）。
 *
 * 基于 fflate 的同步 API 封装：写入时生成 ZIP Blob，读取时还原为条目数组。
 * 本模块为纯工具，不依赖项目内其它文件，兼容浏览器与 Node 18+ 环境。
 */
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

/**
 * 将单个条目数据归一化为 Uint8Array。
 *
 * - `Uint8Array` 原样返回（避免多余拷贝）。
 * - `string` 使用 `strToU8` 编码为 UTF-8 字节。
 * - 其它类型（如 `ArrayBuffer`、数字数组）尝试包装为 `Uint8Array`。
 *
 * @param {Uint8Array|string|ArrayBuffer|ArrayLike<number>} data 条目数据。
 * @returns {Uint8Array} 归一化后的字节数据。
 */
function normalizeBytes(data) {
    if (data instanceof Uint8Array) {
        return data;
    }
    if (typeof data === 'string') {
        return strToU8(data);
    }
    // 兜底：ArrayBuffer 或数字数组等
    return new Uint8Array(data);
}

/**
 * 生成 ZIP 压缩包。
 *
 * 将 `files` 数组转为 fflate 需要的 `{ [path]: Uint8Array }` 映射后调用
 * `zipSync` 得到字节，再包装为 `application/zip` 类型的 Blob 返回。
 * 若存在重复 path，后者覆盖前者（正常情况下不会发生）。
 *
 * @param {Array<{path:string, data:Uint8Array|string}>} files 待打包条目列表。
 * @returns {Blob} 类型为 `application/zip` 的压缩包 Blob。
 */
export function createZipBlob(files) {
    const tree = {};
    const list = Array.isArray(files) ? files : [];
    for (const file of list) {
        if (!file || typeof file.path !== 'string' || file.path === '') {
            // 跳过非法条目（无路径无法在 ZIP 中定位）
            continue;
        }
        // 重复 path 时后者覆盖前者
        tree[file.path] = normalizeBytes(file.data);
    }
    const bytes = zipSync(tree);
    return new Blob([bytes], { type: 'application/zip' });
}

/**
 * 将多种输入形式统一为 `Uint8Array`。
 *
 * @param {ArrayBuffer|Uint8Array|Blob} input ZIP 数据来源。
 * @returns {Promise<Uint8Array>} ZIP 原始字节。
 */
async function toUint8Array(input) {
    if (input instanceof Uint8Array) {
        return input;
    }
    if (typeof Blob !== 'undefined' && input instanceof Blob) {
        // Blob → ArrayBuffer
        return new Uint8Array(await input.arrayBuffer());
    }
    // ArrayBuffer 或其它可被 Uint8Array 包装的对象
    return new Uint8Array(input);
}

/**
 * 修正可能出现的文件名乱码。
 *
 * fflate 在解包时通常已按 UTF-8 正确处理文件名；但若 ZIP 未置 UTF-8 标志位，
 * 个别工具的键名可能被当作 Latin-1 还原，导致中文变成乱码。此处在检测到
 * 类似「UTF-8 字节被按单字节解码」的情形时，尝试用 `strToU8` 还原原始字节后
 * 再以 UTF-8 重新解码，并保留 `decodeURIComponent` 作为二次兜底。
 *
 * @param {string} path 解包得到的原始键名。
 * @returns {string} 修正后的文件名。
 */
function fixFilename(path) {
    if (typeof path !== 'string' || path === '') {
        return path;
    }
    // 纯 ASCII 名称无需处理
    // eslint-disable-next-line no-control-regex
    if (/^[\x00-\x7F]*$/.test(path)) {
        return path;
    }
    try {
        // 将所有码点按单字节还原为 UTF-8 原始字节，再以 UTF-8 解码
        const raw = new Uint8Array(path.length);
        for (let i = 0; i < path.length; i += 1) {
            const code = path.charCodeAt(i);
            if (code > 0xff) {
                // 已包含多字节字符，说明本身就是正确的 UTF-8 字符串
                return path;
            }
            raw[i] = code;
        }
        const decoded = strFromU8(raw);
        // 解码结果更短且未产生替换字符时视为修正成功
        if (decoded && !decoded.includes('\uFFFD') && decoded.length < path.length) {
            return decoded;
        }
    } catch {
        // 忽略，走下方兜底
    }
    try {
        return decodeURIComponent(escape(path));
    } catch {
        return path;
    }
}

/**
 * 读取 ZIP 条目（保序）。
 *
 * 支持 `Blob` / `ArrayBuffer` / `Uint8Array` 三种输入。解包后会过滤目录占位
 * 条目（以 `/` 结尾或路径为空），并保证中文文件名正确还原。
 *
 * @param {ArrayBuffer|Uint8Array|Blob} input ZIP 数据来源。
 * @returns {Promise<Array<{path:string, bytes:Uint8Array}>>} 条目列表，保持 ZIP 内顺序。
 * @throws {Error} 解包失败时抛出中文错误。
 */
export async function readZipEntries(input) {
    const bytes = await toUint8Array(input);
    let unzipped;
    try {
        // unzipSync 返回 { [path]: Uint8Array }，键顺序与 ZIP 内条目顺序一致
        unzipped = unzipSync(bytes);
    } catch (err) {
        const detail = err && err.message ? `（${err.message}）` : '';
        throw new Error(`无法解析 ZIP 文件。${detail}`);
    }
    return Object.entries(unzipped)
        .filter(([rawPath]) => {
            const path = fixFilename(rawPath);
            return path !== '' && !path.endsWith('/');
        })
        .map(([rawPath, entryBytes]) => ({
            path: fixFilename(rawPath),
            bytes: entryBytes
        }));
}

export default { createZipBlob, readZipEntries };
