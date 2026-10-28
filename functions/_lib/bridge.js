/**
 * bridge.js — 百度网盘 OpenAPI 同源桥接核心
 *
 * 用途：
 * - Cloudflare Pages Function 与本地 Vite 开发中间件共用；
 * - 浏览器不能直连百度（无 CORS、下载需特定 UA），由本层代为转发。
 *
 * 安全约束：
 * - 只允许 HTTPS 且域名为百度网盘 / PCS / baidupcs.com；
 * - access_token 由请求头 X-Baidu-Token 传入，仅拼接到上游 URL，不记录、不持久化；
 * - 不透传 Cookie / Origin / Referer 等浏览器头；
 * - 响应禁止缓存。
 */

/** 允许访问的精确域名 */
const ALLOWED_HOSTS = new Set(['pan.baidu.com', 'pcs.baidu.com', 'd.pcs.baidu.com']);

/** 允许访问的域名后缀（dlink 可能落在不同 CDN 域名） */
const ALLOWED_SUFFIXES = ['.baidupcs.com'];

/** token 最大长度（防御异常输入） */
const MAX_TOKEN_LENGTH = 4096;

/** target URL 最大长度 */
const MAX_TARGET_LENGTH = 8192;

/** 单次转发的最大请求体（分片上传 4 MB，留足余量） */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** 通用响应头：跨域 + 禁止缓存 */
function baseHeaders(contentType = 'application/json; charset=UTF-8') {
    return {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'X-Baidu-Token, Content-Type',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Disposition, Content-Type',
        'Access-Control-Max-Age': '86400',
        'Cross-Origin-Resource-Policy': 'cross-origin'
    };
}

/** 返回 JSON 错误 */
function jsonError(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: baseHeaders()
    });
}

/** 判断目标 URL 是否属于允许的百度域名 */
export function isAllowedTarget(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (ALLOWED_HOSTS.has(host)) return true;
    return ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * 处理桥接请求。
 *
 * URL 约定：`<bridge>?target=<完整百度 URL>`
 * 鉴权：请求头 `X-Baidu-Token: <access_token>`
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function handleBridge(request) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: baseHeaders() });
    }

    if (request.method !== 'GET' && request.method !== 'POST') {
        return jsonError('不支持的请求方法。', 405);
    }

    const requestUrl = new URL(request.url);
    const target = requestUrl.searchParams.get('target') || '';
    const token = String(request.headers.get('x-baidu-token') || '').trim();

    if (!target || target.length > MAX_TARGET_LENGTH) {
        return jsonError('缺少有效的 target 参数。', 400);
    }
    if (!token || token.length > MAX_TOKEN_LENGTH) {
        return jsonError('缺少有效的 access_token。', 401);
    }
    if (!isAllowedTarget(target)) {
        return jsonError('目标地址不在允许的百度网盘域名内。', 403);
    }

    let targetUrl;
    try {
        targetUrl = new URL(target);
        targetUrl.searchParams.set('access_token', token);
    } catch {
        return jsonError('target 参数不是有效的 URL。', 400);
    }

    const upstreamHeaders = new Headers();
    upstreamHeaders.set('User-Agent', 'pan.baidu.com');
    const contentType = request.headers.get('content-type');
    if (contentType) upstreamHeaders.set('Content-Type', contentType);
    upstreamHeaders.set('Accept', 'application/json, application/octet-stream, */*');

    /** @type {RequestInit} */
    const init = {
        method: request.method,
        headers: upstreamHeaders,
        redirect: 'follow'
    };

    if (request.method === 'POST') {
        let body;
        try {
            body = await request.arrayBuffer();
        } catch {
            return jsonError('读取上传请求体失败。', 400);
        }
        if (body.byteLength > MAX_BODY_BYTES) {
            return jsonError('上传请求体过大。', 413);
        }
        // 百度上传接口拒绝 Transfer-Encoding: chunked；传入 ArrayBuffer 后
        // 运行时会自动带上固定的 Content-Length。
        init.body = body;
    }

    let upstream;
    try {
        upstream = await fetch(targetUrl.toString(), init);
    } catch {
        return jsonError('无法连接百度网盘服务，请稍后重试。', 502);
    }

    const headers = baseHeaders(
        upstream.headers.get('content-type') || 'application/octet-stream'
    );

    // 仅透传必要的下载相关头，避免暴露 Set-Cookie 等。
    // 响应不转发 Content-Length：上游可能压缩传输，运行时自动解压后长度不再匹配。
    const disposition = upstream.headers.get('content-disposition');
    if (disposition) headers['Content-Disposition'] = disposition;

    return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers
    });
}

export default handleBridge;
