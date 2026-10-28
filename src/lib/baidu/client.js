/**
 * client.js — 百度网盘 OpenAPI 客户端（经同源桥接层）
 *
 * 背景：
 * - 百度网盘 OpenAPI 不返回 CORS 头，浏览器无法直连读取响应；
 * - 下载 dlink 强制要求 User-Agent: pan.baidu.com，浏览器无法设置。
 *
 * 因此本模块统一请求同源桥接地址（默认 /api/baidu），由桥接层：
 * 1. 校验目标域名是否属于百度；
 * 2. 从 X-Baidu-Token 头读取 access_token 并拼到目标 URL；
 * 3. 设置 User-Agent: pan.baidu.com。
 *
 * 本模块不依赖 Svelte / stores，方便复用与测试。
 */
import SparkMD5 from 'spark-md5';

/** 网盘 API 域名 */
const PAN_HOST = 'https://pan.baidu.com';

/** PCS 上传域名（分片上传） */
const PCS_HOST = 'https://d.pcs.baidu.com';

/** 官方分片大小：4 MB */
const UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024;

/** 默认桥接地址 */
export const DEFAULT_BRIDGE_URL = '/api/baidu';

/** 单次上传 / 下载的存档大小上限（50 MB） */
export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

/** 存档扩展名 */
const ARCHIVE_EXTENSION = '.tmplenc';

/**
 * 百度业务错误码 → 中文提示。
 * 未收录的错误码会回退为通用提示，并保留百度原始 errmsg。
 */
const ERROR_MESSAGES = {
    '-10': '网盘容量不足，无法创建云端文件。',
    '-7': '应用目录不存在或当前 token 无权限访问。',
    '-6': 'access_token 无效或已过期，请重新获取并粘贴。',
    '-9': '应用目录不存在或当前 token 无权限访问。',
    '111': 'access_token 已过期，请重新获取并粘贴。',
    '31023': '请求参数错误。',
    '31024': '当前应用未开通上传权限。',
    '31034': '当前应用无权限访问该接口。',
    '31045': 'access_token 校验未通过，请重新获取并粘贴。',
    '31061': '云端已存在同名文件。',
    '31064': '上传路径无效，文件必须位于 /apps/{应用名} 目录。',
    '31066': '应用目录不存在或当前 token 无权限访问。',
    '31090': '云端文件不存在。',
    '31211': '上传请求缺少固定长度，请确认桥接服务已更新。',
    '31212': '百度网盘上传服务暂不可用，请稍后重试；若持续出现请检查应用上传权限。',
    '31299': '分片大小不符合百度网盘要求。',
    '31326': '下载被防盗链拦截，请确认桥接服务已设置 User-Agent。',
    '31360': '下载链接已过期，请重试。',
    '31363': '分片缺失，请重试上传。',
    '31364': '分片大小不符合百度网盘要求。',
    '20011': '路径不在应用可访问范围内（/apps/{应用名}）。',
    '20017': 'access_token 无效或已过期，请重新获取并粘贴。'
};

/** 构造带业务码的中文错误 */
function createBaiduError(errno, detail = '') {
    const key = String(errno);
    const base = ERROR_MESSAGES[key] || `百度网盘接口错误（${key}）`;
    const message = detail ? `${base.replace(/[。.]$/, '')}（${detail}）` : base;
    const error = new Error(message);
    const numeric = Number(errno);
    error.code = Number.isFinite(numeric) ? numeric : errno;
    return error;
}

/** 拼接触发桥接的 URL */
function withTarget(bridgeUrl, target) {
    const base = String(bridgeUrl || DEFAULT_BRIDGE_URL).trim() || DEFAULT_BRIDGE_URL;
    if (/^https?:\/\//i.test(base)) {
        // 绝对地址：校验协议，避免误填 javascript: 等
        const parsed = new URL(base);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error('桥接地址必须是 HTTP(S) 地址。');
        }
    } else if (!base.startsWith('/')) {
        throw new Error('桥接地址应为 /api/baidu 或完整的 HTTP(S) 地址。');
    }
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}target=${encodeURIComponent(target)}`;
}

/**
 * 通过桥接层请求百度接口。
 *
 * @param {string} target 百度目标 URL（不需要带 access_token）。
 * @param {object} options
 * @param {string} options.token access_token。
 * @param {string} [options.bridgeUrl='/api/baidu'] 桥接地址。
 * @param {string} [options.method='GET'] HTTP 方法。
 * @param {BodyInit} [options.body] 请求体。
 * @param {HeadersInit} [options.headers] 额外请求头。
 * @returns {Promise<Response>}
 */
async function bridgeFetch(target, { token, bridgeUrl, method = 'GET', body, headers } = {}) {
    const accessToken = String(token || '').trim();
    if (!accessToken) {
        throw new Error('请先配置百度网盘 access_token。');
    }

    const requestHeaders = new Headers();
    requestHeaders.set('X-Baidu-Token', accessToken);
    if (headers) {
        new Headers(headers).forEach((value, key) => requestHeaders.set(key, value));
    }

    let response;
    try {
        response = await fetch(withTarget(bridgeUrl, target), {
            method,
            headers: requestHeaders,
            body,
            cache: 'no-store'
        });
    } catch {
        throw new Error(
            '无法连接百度网盘桥接服务。请确认已部署 Cloudflare Pages Function，或在设置中填写可用的桥接地址。'
        );
    }

    return response;
}

/** 解析 JSON 文本；失败返回 null */
function tryParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/** 读取并校验百度 JSON 响应 */
async function requestJson(target, options) {
    const response = await bridgeFetch(target, options);
    const text = await response.text();
    const data = tryParseJson(text);

    if (!response.ok) {
        if (data && typeof data.error === 'string') {
            const error = new Error(data.error);
            error.status = response.status;
            throw error;
        }
        const rawErrno = data ? Number(data.errno ?? data.error_code) : NaN;
        if (Number.isFinite(rawErrno) && rawErrno !== 0) {
            throw createBaiduError(
                rawErrno,
                String(data.errmsg || data.show_msg || data.error_msg || '')
            );
        }
        const contentType = String(response.headers.get('content-type') || '');
        if (contentType.includes('text/html') || text.trimStart().startsWith('<')) {
            const error = new Error(
                '桥接服务未正确部署（返回了网页而不是接口数据）。请检查 /api/baidu 或设置中的桥接地址。'
            );
            error.status = response.status;
            throw error;
        }
        const error = new Error(`百度网盘服务返回 HTTP ${response.status}。`);
        error.status = response.status;
        throw error;
    }

    if (!data || typeof data !== 'object') {
        const contentType = String(response.headers.get('content-type') || '');
        if (contentType.includes('text/html') || text.trimStart().startsWith('<')) {
            throw new Error(
                '桥接服务未正确部署（返回了网页而不是接口数据）。请检查 /api/baidu 或设置中的桥接地址。'
            );
        }
        throw new Error('百度网盘返回了无法解析的响应。');
    }

    const rawErrno = data.errno !== undefined ? data.errno : data.error_code;
    const errno = Number(rawErrno ?? 0);

    if (Number.isFinite(errno) && errno !== 0) {
        let detail = String(data.errmsg || data.show_msg || data.error_msg || '');
        if (!ERROR_MESSAGES[String(errno)] && data.request_id) {
            detail = `${detail}${detail ? '，' : ''}request_id=${data.request_id}`;
        }
        throw createBaiduError(errno, detail);
    }

    return data;
}

/**
 * 规范化应用目录：必须以 /apps/{应用名} 开头，允许其下多级子目录。
 *
 * @param {string} value 用户输入。
 * @returns {string} 规范化后的绝对路径。
 */
export function normalizeAppPath(value) {
    let path = String(value || '').trim();
    if (!path) path = '/apps/TMPLNote';
    if (!path.startsWith('/')) path = `/${path}`;
    path = path.replace(/\/{2,}/g, '/');
    if (path.length > 1) path = path.replace(/\/+$/, '');
    if (!/^\/apps\/[^/]+(?:\/[^/]+)*$/i.test(path)) {
        throw new Error('应用目录必须位于 /apps/{应用名} 下，例如 /apps/TMPLNote。');
    }
    return path;
}

/** 拼接云端路径 */
export function joinCloudPath(dir, filename) {
    const base = String(dir || '').replace(/\/+$/, '');
    const name = String(filename || '').replace(/^\/+/, '');
    return `${base}/${name}`;
}

/**
 * 校验存档大小。
 *
 * @param {number} bytes 字节数。
 * @param {string} [label='存档'] 提示用的名称。
 */
export function assertArchiveSize(bytes, label = '存档') {
    if (bytes > MAX_ARCHIVE_BYTES) {
        throw new Error(
            `${label}超过 ${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)} MB，暂不支持上传或下载。`
        );
    }
}

/**
 * 验证 access_token（获取用户信息）。
 *
 * @param {{token: string, bridgeUrl?: string}} options
 * @returns {Promise<{baidu_name?: string, netdisk_name?: string, uk?: number|string, vip_type?: number}>}
 */
export async function verifyToken({ token, bridgeUrl }) {
    const data = await requestJson(`${PAN_HOST}/rest/2.0/xpan/nas?method=uinfo`, {
        token,
        bridgeUrl
    });
    return data;
}

/**
 * 列出应用目录下的加密存档（仅 .tmplenc，按修改时间倒序）。
 *
 * @param {{token: string, bridgeUrl?: string, appPath: string}} options
 * @returns {Promise<Array<{fsId: string, path: string, name: string, size: number, mtime: number}>>}
 */
export async function listArchives({ token, bridgeUrl, appPath }) {
    const dir = normalizeAppPath(appPath);
    const params = new URLSearchParams({
        method: 'list',
        dir,
        order: 'time',
        desc: '1',
        start: '0',
        limit: '1000',
        web: '1'
    });

    const data = await requestJson(`${PAN_HOST}/rest/2.0/xpan/file?${params.toString()}`, {
        token,
        bridgeUrl
    });

    const list = Array.isArray(data.list) ? data.list : [];
    return list
        .filter((item) => {
            if (!item || item.isdir) return false;
            const name = String(item.server_filename || item.path || '');
            return name.toLowerCase().endsWith(ARCHIVE_EXTENSION);
        })
        .map((item) => ({
            fsId: String(item.fs_id ?? ''),
            path: String(item.path || ''),
            name: String(item.server_filename || String(item.path || '').split('/').pop() || ''),
            size: Number(item.size) || 0,
            mtime: Number(item.server_mtime || item.local_mtime) || 0
        }))
        .sort((a, b) => b.mtime - a.mtime);
}

/**
 * 获取文件的 dlink 下载地址。
 *
 * @param {{token: string, bridgeUrl?: string, fsId: string}} options
 * @returns {Promise<string>}
 */
export async function getDownloadLink({ token, bridgeUrl, fsId }) {
    const id = Number(fsId);
    if (!Number.isFinite(id)) {
        throw new Error('云端文件标识无效。');
    }
    const params = new URLSearchParams({
        method: 'filemetas',
        dlink: '1',
        fsids: JSON.stringify([id])
    });

    const data = await requestJson(
        `${PAN_HOST}/rest/2.0/xpan/multimedia?${params.toString()}`,
        { token, bridgeUrl }
    );

    const first = Array.isArray(data.list) ? data.list[0] : null;
    const dlink = first && typeof first.dlink === 'string' ? first.dlink : '';
    if (!dlink) {
        throw new Error('未能获取云端存档的下载地址。');
    }
    return dlink;
}

/**
 * 下载存档（经桥接层，由桥接层设置 User-Agent）。
 *
 * @param {{token: string, bridgeUrl?: string, dlink: string}} options
 * @returns {Promise<Uint8Array>}
 */
export async function downloadArchive({ token, bridgeUrl, dlink }) {
    const response = await bridgeFetch(dlink, { token, bridgeUrl });
    if (!response.ok) {
        const text = await response.text();
        const data = tryParseJson(text);
        const errno = data ? Number(data.errno ?? data.error_code) : 0;
        if (Number.isFinite(errno) && errno !== 0) {
            throw createBaiduError(errno, data.errmsg || data.show_msg || '');
        }
        throw new Error(`下载存档失败（HTTP ${response.status}）。`);
    }

    const contentType = String(response.headers.get('content-type') || '');
    const buffer = new Uint8Array(await response.arrayBuffer());

    if (contentType.includes('text/html') || buffer[0] === 0x3c) {
        throw new Error(
            '桥接服务未正确部署（返回了网页而不是文件）。请检查 /api/baidu 或设置中的桥接地址。'
        );
    }

    // dlink 失效时百度可能返回 200 + JSON 错误体
    const firstChar = buffer.length > 0 ? String.fromCharCode(buffer[0]) : '';
    if (firstChar === '{' && buffer.byteLength < 8192) {
        const data = tryParseJson(new TextDecoder().decode(buffer));
        const errno = data ? Number(data.errno ?? data.error_code) : 0;
        if (Number.isFinite(errno) && errno !== 0) {
            throw createBaiduError(errno, data.errmsg || data.show_msg || '');
        }
    }

    assertArchiveSize(buffer.byteLength, '存档');
    return buffer;
}

/**
 * 计算字节的 32 位小写 MD5。
 *
 * @param {Uint8Array} bytes 待计算字节。
 * @returns {string}
 */
function md5Hex(bytes) {
    const buffer =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
            ? bytes.buffer
            : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return SparkMD5.ArrayBuffer.hash(buffer);
}

/**
 * 归一化预上传返回的分片序号列表。
 *
 * - 数组：只上传其中的序号；
 * - JSON 字符串：解析后同上；
 * - 缺失或空字符串：上传全部分片。
 *
 * @param {unknown} value precreate 返回的 block_list。
 * @param {number} total 分片总数。
 * @returns {number[]}
 */
function normalizeBlockIndexes(value, total) {
    let list = value;
    if (typeof list === 'string') {
        const text = list.trim();
        if (!text) return Array.from({ length: total }, (_, index) => index);
        try {
            list = JSON.parse(text);
        } catch {
            list = null;
        }
    }

    if (!Array.isArray(list)) {
        return Array.from({ length: total }, (_, index) => index);
    }

    const seen = new Set();
    const result = [];
    for (const item of list) {
        const index = Number(item);
        if (!Number.isInteger(index) || index < 0 || index >= total || seen.has(index)) continue;
        seen.add(index);
        result.push(index);
    }
    return result;
}

/** 判断错误是否值得重试 */
function isRetryableError(error) {
    const code = Number(error?.code);
    if (code === 31212 || code === 31363) return true;
    const status = Number(error?.status);
    if (status >= 500) return true;
    return typeof error?.message === 'string' && /HTTP 5\d\d|无法连接|网络|timeout/i.test(error.message);
}

/** 带退避的重试 */
async function withRetry(task, attempts = 2) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            return await task(attempt);
        } catch (error) {
            lastError = error;
            if (attempt >= attempts - 1 || !isRetryableError(error)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
    }
    throw lastError;
}

/**
 * 上传加密存档。
 *
 * 采用百度网盘官方推荐的「预上传 → 分片上传 → 创建文件」流程：
 * - 4 MB 分片，先计算每片 MD5；
 * - precreate 返回秒传标记（return_type=2）时直接完成；
 * - 只上传 precreate 返回的缺失分片；
 * - create 使用服务端返回的分片 MD5，rtype=1 冲突时重命名以保留历史。
 *
 * @param {{
 *   token: string,
 *   bridgeUrl?: string,
 *   appPath: string,
 *   filename: string,
 *   blob: Blob,
 *   onProgress?: (progress: {phase: 'precreate'|'upload'|'create'|'done', completed: number, total: number}) => void
 * }} options
 * @returns {Promise<object>} 百度 create 接口响应。
 */
export async function uploadArchive({
    token,
    bridgeUrl,
    appPath,
    filename,
    blob,
    onProgress
}) {
    assertArchiveSize(blob.size, '存档');
    const dir = normalizeAppPath(appPath);
    const name = String(filename || '').trim();
    if (!name || name.includes('/') || name.includes('\\')) {
        throw new Error('存档文件名无效。');
    }
    const path = joinCloudPath(dir, name);

    const buffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const size = bytes.byteLength;
    const totalChunks = Math.max(1, Math.ceil(size / UPLOAD_CHUNK_SIZE));

    const md5List = [];
    for (let index = 0; index < totalChunks; index += 1) {
        const start = index * UPLOAD_CHUNK_SIZE;
        const end = Math.min(start + UPLOAD_CHUNK_SIZE, size);
        md5List.push(md5Hex(bytes.subarray(start, end)));
    }

    onProgress?.({ phase: 'precreate', completed: 0, total: totalChunks });

    const precreate = await withRetry(
        () =>
            requestJson(`${PAN_HOST}/rest/2.0/xpan/file?method=precreate`, {
                token,
                bridgeUrl,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
                },
                body: new URLSearchParams({
                    path,
                    size: String(size),
                    isdir: '0',
                    autoinit: '1',
                    block_list: JSON.stringify(md5List),
                    rtype: '1'
                })
            }),
        2
    );

    // 秒传：云端已有相同文件，无需上传分片
    if (Number(precreate.return_type) === 2) {
        onProgress?.({ phase: 'done', completed: totalChunks, total: totalChunks });
        return precreate;
    }

    const uploadId = String(precreate.uploadid || '');
    if (!uploadId) {
        throw new Error('预上传未返回 uploadid，无法继续上传。');
    }

    const missing = normalizeBlockIndexes(precreate.block_list, totalChunks);
    const uploadedMd5List = [...md5List];
    let completed = 0;

    for (const index of missing) {
        const start = index * UPLOAD_CHUNK_SIZE;
        const end = Math.min(start + UPLOAD_CHUNK_SIZE, size);
        const form = new FormData();
        form.append('file', blob.slice(start, end, 'application/octet-stream'), 'chunk');

        const params = new URLSearchParams({
            method: 'upload',
            type: 'tmpfile',
            path,
            uploadid: uploadId,
            partseq: String(index)
        });

        const result = await withRetry(
            () =>
                requestJson(`${PCS_HOST}/rest/2.0/pcs/superfile2?${params.toString()}`, {
                    token,
                    bridgeUrl,
                    method: 'POST',
                    body: form
                }),
            3
        );

        if (result && typeof result.md5 === 'string' && result.md5) {
            uploadedMd5List[index] = result.md5;
        }
        completed += 1;
        onProgress?.({ phase: 'upload', completed, total: missing.length });
    }

    onProgress?.({ phase: 'create', completed: missing.length, total: missing.length });

    const created = await withRetry(
        () =>
            requestJson(`${PAN_HOST}/rest/2.0/xpan/file?method=create`, {
                token,
                bridgeUrl,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
                },
                body: new URLSearchParams({
                    path,
                    size: String(size),
                    isdir: '0',
                    uploadid: uploadId,
                    block_list: JSON.stringify(uploadedMd5List),
                    rtype: '1'
                })
            }),
        2
    );

    onProgress?.({ phase: 'done', completed: missing.length, total: missing.length });
    return created;
}

/**
 * 删除云端存档。
 *
 * @param {{token: string, bridgeUrl?: string, path: string}} options
 * @returns {Promise<object>} 百度响应。
 */
export async function deleteArchive({ token, bridgeUrl, path }) {
    const target = String(path || '').trim();
    if (!target) {
        throw new Error('缺少要删除的云端文件路径。');
    }
    const body = new URLSearchParams({ filelist: JSON.stringify([target]) });

    return requestJson(`${PAN_HOST}/rest/2.0/xpan/file?method=delete&async=0`, {
        token,
        bridgeUrl,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body
    });
}

export default {
    DEFAULT_BRIDGE_URL,
    MAX_ARCHIVE_BYTES,
    normalizeAppPath,
    joinCloudPath,
    assertArchiveSize,
    verifyToken,
    listArchives,
    getDownloadLink,
    downloadArchive,
    uploadArchive,
    deleteArchive
};
