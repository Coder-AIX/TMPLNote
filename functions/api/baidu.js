/**
 * Cloudflare Pages Function：/api/baidu
 *
 * 将浏览器的网盘请求转发到百度 OpenAPI，解决 CORS 与 User-Agent 限制。
 * 部署到 Cloudflare Pages 后自动生效；GitHub Pages 等纯静态部署可在
 * 设置页填写外部桥接地址（同逻辑的 Worker）。
 */
import { handleBridge } from '../_lib/bridge.js';

export const onRequest = ({ request }) => handleBridge(request);
