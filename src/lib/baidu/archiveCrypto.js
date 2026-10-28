/**
 * archiveCrypto.js — 云端存档的口令加密 / 解密（WebCrypto）
 *
 * 设计要点：
 * - 纯工具模块：只依赖标准 WebCrypto / TextEncoder / TextDecoder，不接触 UI 与存储。
 * - 上传前必须在本地完成加密；口令不保存、不缓存。
 * - 使用 PBKDF2-SHA-256 派生 256 位密钥，AES-GCM 加密并认证。
 * - 文件头包含算法参数，后续可平滑升级迭代次数。
 *
 * 文件格式（大端）：
 *   magic       8B   "TMPLENC1"
 *   version     1B   1
 *   iterations  4B   PBKDF2 迭代次数
 *   salt        16B  随机盐
 *   iv          12B  随机 IV
 *   ciphertext  ...  AES-GCM-256 密文（含 16B 认证标签）
 */

/** 文件头魔数（8 字节） */
const MAGIC = new Uint8Array([0x54, 0x4d, 0x50, 0x4c, 0x45, 0x4e, 0x43, 0x31]); // TMPLENC1

/** 当前加密格式版本 */
export const ARCHIVE_VERSION = 1;

/** PBKDF2 迭代次数 */
export const ARCHIVE_ITERATIONS = 310000;

/** 口令最短长度 */
export const MIN_PASSWORD_LENGTH = 8;

/** 存档文件扩展名 */
export const ARCHIVE_EXTENSION = '.tmplenc';

/** 盐长度（字节） */
const SALT_BYTES = 16;

/** IV 长度（字节，AES-GCM 推荐 12） */
const IV_BYTES = 12;

/** 固定头长度 = magic + version + iterations + salt + iv */
const HEADER_BYTES = MAGIC.length + 1 + 4 + SALT_BYTES + IV_BYTES;

/** 是否具备 WebCrypto（https / localhost 下可用） */
function subtleCrypto() {
    const c = globalThis.crypto;
    if (!c || !c.subtle) {
        throw new Error('当前环境不支持 WebCrypto，无法加密存档。请使用 HTTPS 或 localhost 访问。');
    }
    return c;
}

/** 校验口令 */
export function assertPassword(password) {
    const text = typeof password === 'string' ? password : '';
    if (text.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`口令至少需要 ${MIN_PASSWORD_LENGTH} 位。`);
    }
    return text;
}

/** 生成指定长度的随机字节 */
function randomBytes(length) {
    const bytes = new Uint8Array(length);
    subtleCrypto().getRandomValues(bytes);
    return bytes;
}

/** 写入 32 位无符号整数（大端） */
function writeUint32(target, offset, value) {
    target[offset] = (value >>> 24) & 0xff;
    target[offset + 1] = (value >>> 16) & 0xff;
    target[offset + 2] = (value >>> 8) & 0xff;
    target[offset + 3] = value & 0xff;
}

/** 读取 32 位无符号整数（大端） */
function readUint32(source, offset) {
    return (
        ((source[offset] << 24) |
            (source[offset + 1] << 16) |
            (source[offset + 2] << 8) |
            source[offset + 3]) >>>
        0
    );
}

/** 拼接多个字节数组 */
function concatBytes(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

/** 判断字节数组是否以魔数开头 */
function hasMagic(bytes) {
    if (bytes.length < MAGIC.length) return false;
    for (let i = 0; i < MAGIC.length; i += 1) {
        if (bytes[i] !== MAGIC[i]) return false;
    }
    return true;
}

/** PBKDF2 派生 AES-GCM 密钥 */
async function deriveKey(password, salt, iterations) {
    const crypto = subtleCrypto();
    const encoder = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(password),
        'PBKDF2',
        false,
        ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt,
            iterations,
            hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * 加密存档明文。
 *
 * @param {string} text 完整备份 JSON 文本。
 * @param {string} password 用户口令（至少 8 位）。
 * @returns {Promise<Uint8Array>} 加密后的存档字节。
 */
export async function encryptArchive(text, password) {
    if (typeof text !== 'string' || text.length === 0) {
        throw new Error('没有可加密的存档内容。');
    }
    const secret = assertPassword(password);
    const crypto = subtleCrypto();

    const salt = randomBytes(SALT_BYTES);
    const iv = randomBytes(IV_BYTES);
    const iterations = ARCHIVE_ITERATIONS;

    const header = new Uint8Array(HEADER_BYTES);
    header.set(MAGIC, 0);
    header[MAGIC.length] = ARCHIVE_VERSION;
    writeUint32(header, MAGIC.length + 1, iterations);
    header.set(salt, MAGIC.length + 1 + 4);
    header.set(iv, MAGIC.length + 1 + 4 + SALT_BYTES);

    const key = await deriveKey(secret, salt, iterations);
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
            {
                name: 'AES-GCM',
                iv,
                additionalData: header
            },
            key,
            new TextEncoder().encode(text)
        )
    );

    return concatBytes([header, ciphertext]);
}

/**
 * 解密存档。
 *
 * @param {Uint8Array|ArrayBuffer} input 存档字节。
 * @param {string} password 用户口令。
 * @returns {Promise<string>} 解密后的备份 JSON 文本。
 */
export async function decryptArchive(input, password) {
    const secret = assertPassword(password);
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);

    if (bytes.length <= HEADER_BYTES) {
        throw new Error('存档文件不完整或格式不正确。');
    }
    if (!hasMagic(bytes)) {
        throw new Error('这不是 TMPLNote 加密存档。');
    }

    const version = bytes[MAGIC.length];
    if (version !== ARCHIVE_VERSION) {
        throw new Error(`不支持的存档版本（v${version}），请先升级应用。`);
    }

    const iterations = readUint32(bytes, MAGIC.length + 1);
    if (iterations < 10000 || iterations > 5000000) {
        throw new Error('存档头部的加密参数无效。');
    }

    const saltStart = MAGIC.length + 1 + 4;
    const ivStart = saltStart + SALT_BYTES;
    const salt = bytes.slice(saltStart, ivStart);
    const iv = bytes.slice(ivStart, ivStart + IV_BYTES);
    const header = bytes.slice(0, HEADER_BYTES);
    const ciphertext = bytes.slice(HEADER_BYTES);

    const crypto = subtleCrypto();
    const key = await deriveKey(secret, salt, iterations);

    let plaintext;
    try {
        plaintext = await crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv,
                additionalData: header
            },
            key,
            ciphertext
        );
    } catch {
        // GCM 认证失败无法区分「口令错误」与「内容损坏」，统一提示。
        throw new Error('口令错误或存档已损坏。');
    }

    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    } catch {
        throw new Error('存档内容不是有效的 UTF-8 文本。');
    }
}

/**
 * 判断字节是否为 TMPLNote 加密存档（仅检查魔数，不做解密）。
 *
 * @param {Uint8Array|ArrayBuffer} input 待判断字节。
 * @returns {boolean}
 */
export function isEncryptedArchive(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    return hasMagic(bytes) && bytes.length > HEADER_BYTES;
}

/**
 * 生成存档文件名（本地时间）。
 *
 * @param {Date} [date=new Date()] 用于生成文件名的时间。
 * @returns {string} 形如 `tmplnote-archive-20260101-090000.tmplenc`。
 */
export function archiveFilename(date = new Date()) {
    const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    const yyyy = pad(d.getFullYear(), 4);
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mi = pad(d.getMinutes());
    const ss = pad(d.getSeconds());
    return `tmplnote-archive-${yyyy}${mm}${dd}-${hh}${mi}${ss}${ARCHIVE_EXTENSION}`;
}

export default {
    ARCHIVE_VERSION,
    ARCHIVE_ITERATIONS,
    MIN_PASSWORD_LENGTH,
    ARCHIVE_EXTENSION,
    assertPassword,
    encryptArchive,
    decryptArchive,
    isEncryptedArchive,
    archiveFilename
};
