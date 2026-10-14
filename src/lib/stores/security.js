/**
 * security.js — 访问锁（加密开关）状态与密码校验
 *
 * 密码不明文存储：使用 WebCrypto PBKDF2(SHA-256) 派生哈希，随机盐一并存入 settings。
 */
import { writable, derived, get } from 'svelte/store';
import { settings, settingsReady, updateSetting } from './settings.js';

/** 默认迭代次数（与 DEFAULT_SETTINGS.passwordIterations 保持一致） */
export const PBKDF2_ITERATIONS = 100000;

/** 是否处于锁定态 */
export const locked = writable(false);

/** 是否已启用加密（来自设置） */
export const encryptionEnabled = derived(settings, ($settings) =>
    Boolean($settings.encryptionEnabled)
);

/* —— Base64 <-> Uint8Array —— */
function bytesToBase64(bytes) {
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}
function base64ToBytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
}
function randomSalt(length = 16) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytesToBase64(bytes);
}

/** 派生密码哈希（Base64） */
async function deriveHash(password, saltBase64, iterations) {
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        'PBKDF2',
        false,
        ['deriveBits']
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: base64ToBytes(saltBase64), iterations, hash: 'SHA-256' },
        keyMaterial,
        256
    );
    return bytesToBase64(new Uint8Array(bits));
}

/** 校验密码是否正确 */
export async function verifyPassword(password) {
    const current = get(settings);
    if (!current.passwordHash || !current.passwordSalt) return false;
    const hash = await deriveHash(
        password,
        current.passwordSalt,
        Number(current.passwordIterations) || PBKDF2_ITERATIONS
    );
    return hash === current.passwordHash;
}

/** 启用加密：设置密码（同时立即解锁当前会话） */
export async function enableEncryption(password) {
    const salt = randomSalt();
    const hash = await deriveHash(password, salt, PBKDF2_ITERATIONS);
    await updateSetting('passwordSalt', salt);
    await updateSetting('passwordHash', hash);
    await updateSetting('passwordIterations', PBKDF2_ITERATIONS);
    await updateSetting('encryptionEnabled', true);
    locked.set(false);
}

/** 关闭加密：清除凭据（当前会话已解锁，不再二次校验） */
export async function disableEncryption() {
    await updateSetting('passwordHash', '');
    await updateSetting('passwordSalt', '');
    await updateSetting('encryptionEnabled', false);
    locked.set(false);
}

/** 解锁：密码正确则解除锁定 */
export async function unlock(password) {
    const ok = await verifyPassword(password);
    if (ok) locked.set(false);
    return ok;
}

/** 立即锁定 */
export function lock() {
    locked.set(true);
}

/** 应用启动时调用：等待设置加载完成后，按加密开关决定初始锁定态 */
export async function initLock() {
    await settingsReady;
    locked.set(Boolean(get(settings).encryptionEnabled));
}
