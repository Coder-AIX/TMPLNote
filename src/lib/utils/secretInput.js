/**
 * secretInput.js — 「密码输入」的跨浏览器方案
 *
 * 目的：不使用 type="password"，避免浏览器密码管理器弹出「保存密码 / 自动填充」提示。
 * 掩码依赖 CSS `-webkit-text-security`（Chromium / WebKit 支持）；
 * 不支持时（Firefox）回退为 type="password"，以保证密码不被明文显示。
 */

export const SUPPORTS_TEXT_SECURITY =
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('-webkit-text-security', 'disc');

/** 掩码行内样式：需要隐藏且支持该属性时返回，否则返回空串 */
export function maskStyle(visible) {
    return SUPPORTS_TEXT_SECURITY && !visible ? '-webkit-text-security: disc;' : '';
}

/** input 的 type：支持掩码时恒为 'text'；否则隐藏时回退 'password' */
export function secretInputType(visible) {
    if (SUPPORTS_TEXT_SECURITY) return 'text';
    return visible ? 'text' : 'password';
}
