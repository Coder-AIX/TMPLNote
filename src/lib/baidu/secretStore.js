/**
 * secretStore.js — 自动同步口令的设备级加密存储
 *
 * 为什么需要本模块：
 * - 自动备份需要无人值守运行，因此必须在本机保存口令；但明文口令一旦落进
 *   IndexedDB 就等同于泄露，所以先在本机生成「不可导出」的 AES-GCM 设备密钥，
 *   再用它加密口令，只保存密文。
 * - 设备密钥本身不可导出，仅能以 CryptoKey 形式存入 IndexedDB（结构化克隆），
 *   同源脚本可以在不读取原始字节的前提下解密，降低泄露风险。
 * - 清除口令时保留设备密钥，便于用户之后重新保存口令而无需更换密钥。
 * - 口令校验值用于在下载/恢复之前快速判断口令是否正确，复用存档加密逻辑，
 *   但它不参与口令解密，只保存密文校验串。
 *
 * 安全约定：
 * - 不把口令写入 settings / localStorage / sessionStorage / 日志 / DOM；
 * - 不导出设备密钥，也不把 CryptoKey 交给本模块之外的调用方；
 * - 任何失败都抛出可直接展示给用户的中文错误，并引导用户改用「仅本次会话」。
 */
import { db } from '../db/index.js';
import { encryptArchive, decryptArchive } from './archiveCrypto.js';

/** secrets 对象仓库名 */
const STORE = 'secrets';

/** 设备密钥记录主键 */
const DEVICE_KEY = 'deviceKey';

/** 自动口令记录主键 */
const PASSPHRASE_KEY = 'autoPassphrase';

/** AES-GCM 附加认证数据（长度变化时必须同步升级版本） */
const AAD_TEXT = 'tmplnote-auto-pass:v1';

/** AES-GCM 推荐 IV 长度（字节） */
const IV_BYTES = 12;

/** AES-GCM 认证标签长度（字节），密文至少应大于该值 */
const TAG_BYTES = 16;

/** 口令校验值使用的固定明文 */
const CHECK_TEXT = 'tmplnote-auto-pass-check';

/**
 * 获取可用的 WebCrypto。
 * 非安全上下文（HTTP）或旧浏览器中 crypto.subtle 不存在，此时无法安全加密。
 * @returns {Crypto}
 */
function requireCrypto() {
    const crypto = globalThis.crypto;
    if (!crypto || !crypto.subtle || typeof crypto.subtle.encrypt !== 'function') {
        throw new Error(
            '当前环境不支持 WebCrypto，无法加密保存自动同步口令。请使用 HTTPS 或 localhost 访问，或选择「仅本次会话」不保存口令。'
        );
    }
    if (typeof crypto.getRandomValues !== 'function') {
        throw new Error(
            '当前浏览器无法生成安全随机数，不能加密保存自动同步口令。请更换浏览器，或选择「仅本次会话」。'
        );
    }
    return crypto;
}

/** 判断值是否为 CryptoKey（兼容 CryptoKey 未暴露为全局变量的浏览器） */
function isCryptoKey(value) {
    if (!value || typeof value !== 'object') return false;
    const CryptoKeyCtor = globalThis.CryptoKey;
    if (typeof CryptoKeyCtor === 'function') {
        try {
            return value instanceof CryptoKeyCtor;
        } catch {
            // 跨 realm 等场景下 instanceof 可能抛错，退化为结构判断
        }
    }
    return (
        typeof value.type === 'string' &&
        typeof value.extractable === 'boolean' &&
        Boolean(value.algorithm) &&
        typeof value.algorithm === 'object'
    );
}

/** 字节数组转 Base64（分块处理，避免长数组触发调用栈溢出） */
function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

/** Base64 转字节数组（非法 Base64 时抛出异常，由调用方转换为中文错误） */
function base64ToBytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/** 生成指定长度的密码学随机字节 */
function randomBytes(length) {
    const crypto = requireCrypto();
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
}

/** 校验口令参数；空口令直接拒绝（长度策略由调用方/存档加密负责） */
function requirePassphrase(passphrase) {
    if (typeof passphrase !== 'string' || passphrase.length === 0) {
        throw new Error('自动同步口令不能为空。');
    }
    return passphrase;
}

/** 读取 secrets 仓库；统一的存储访问错误提示 */
async function readSecret(key, action) {
    try {
        return await db.get(STORE, key);
    } catch {
        throw new Error(
            `无法访问本机加密存储，${action}失败。请检查浏览器是否处于无痕模式或存储已满，或选择「仅本次会话」。`
        );
    }
}

/**
 * 判断口令记录结构是否基本合法（不解密、不抛错）。
 * @param {any} record
 * @returns {boolean}
 */
function isPassphraseRecordLike(record) {
    if (!record || typeof record !== 'object') return false;
    const value = record.value;
    if (!value || typeof value !== 'object') return false;
    if (typeof value.iv !== 'string' || !value.iv) return false;
    if (typeof value.cipher !== 'string' || !value.cipher) return false;
    try {
        const iv = base64ToBytes(value.iv);
        const cipher = base64ToBytes(value.cipher);
        return iv.length === IV_BYTES && cipher.length > TAG_BYTES;
    } catch {
        return false;
    }
}

/**
 * 严格解析口令记录，结构异常时抛出可操作的中文错误。
 * @param {any} record
 * @returns {{ iv: Uint8Array, cipher: Uint8Array }}
 */
function parsePassphraseRecord(record) {
    if (!isPassphraseRecordLike(record)) {
        throw new Error(
            '已保存的自动同步口令记录已损坏，无法读取。请重新保存口令，或选择「仅本次会话」。'
        );
    }
    return {
        iv: base64ToBytes(record.value.iv),
        cipher: base64ToBytes(record.value.cipher)
    };
}

/**
 * 确认运行环境能把 CryptoKey 结构化克隆并持久化。
 * 少数浏览器（或某些隐私模式）既不支持 CryptoKey 克隆，也无法存进 IndexedDB。
 * @param {CryptoKey} key
 */
function assertCryptoKeyPersistable(key) {
    const failedMessage =
        '当前浏览器无法安全地持久化设备密钥，因此不能加密保存自动同步口令。请更换浏览器，或选择「仅本次会话」。';
    if (typeof globalThis.structuredClone !== 'function') {
        throw new Error(failedMessage);
    }
    let cloned;
    try {
        cloned = globalThis.structuredClone(key);
    } catch {
        throw new Error(failedMessage);
    }
    if (!isCryptoKey(cloned)) {
        throw new Error(failedMessage);
    }
}

/**
 * 生成并持久化设备密钥（AES-GCM-256，extractable=false）。
 * 若写入后回读失败，会删除残缺记录，避免留下无法使用的密钥。
 * @returns {Promise<CryptoKey>}
 */
async function createDeviceKey() {
    const crypto = requireCrypto();
    let key;
    try {
        key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
            'encrypt',
            'decrypt'
        ]);
    } catch {
        throw new Error(
            '当前浏览器无法生成设备密钥，暂时不能加密保存自动同步口令。请选择「仅本次会话」，或更换浏览器后重试。'
        );
    }
    if (!isCryptoKey(key)) {
        throw new Error(
            '当前浏览器生成的设备密钥不可用，无法加密保存自动同步口令。请选择「仅本次会话」。'
        );
    }
    assertCryptoKeyPersistable(key);

    try {
        await db.put(STORE, { key: DEVICE_KEY, value: key, updatedAt: Date.now() });
    } catch {
        throw new Error(
            '无法保存设备密钥到本机存储（可能是无痕模式或存储空间不足）。请选择「仅本次会话」。'
        );
    }

    // 回读确认浏览器真的能持久化 CryptoKey，否则清理记录并报错。
    const persisted = await readSecret(DEVICE_KEY, '读取设备密钥');
    if (!persisted || !isCryptoKey(persisted.value)) {
        try {
            await db.delete(STORE, DEVICE_KEY);
        } catch {
            // 清理失败不影响错误提示；调用方不会拿到不可用的密钥
        }
        throw new Error(
            '当前浏览器无法持久化设备密钥，因此不能加密保存自动同步口令。请更换浏览器，或选择「仅本次会话」。'
        );
    }
    return persisted.value;
}

/**
 * 读取已有设备密钥；不存在时创建。
 * @returns {Promise<CryptoKey>}
 */
async function getOrCreateDeviceKey() {
    const record = await readSecret(DEVICE_KEY, '读取设备密钥');
    if (record !== undefined && record !== null) {
        if (!isCryptoKey(record.value)) {
            throw new Error(
                '本机设备密钥记录已损坏，无法解密已保存的自动同步口令。请重新保存口令；如果仍然失败，请选择「仅本次会话」。'
            );
        }
        return record.value;
    }
    return createDeviceKey();
}

/**
 * 加密并保存自动同步口令。
 * - 设备密钥不存在时生成 AES-GCM 256、extractable=false 的 CryptoKey 并存入 secrets；
 * - 口令用 AES-GCM 加密，AAD 为 UTF-8 'tmplnote-auto-pass:v1'；
 * - 若运行环境不支持 WebCrypto / CryptoKey 持久化，抛出中文错误。
 * @param {string} passphrase
 * @returns {Promise<void>}
 */
export async function saveAutoPassphrase(passphrase) {
    const text = requirePassphrase(passphrase);
    const crypto = requireCrypto();

    // 先确保设备密钥可用，再加密；任一步失败都不会写入口令记录。
    const deviceKey = await getOrCreateDeviceKey();

    const iv = randomBytes(IV_BYTES);
    const aad = new TextEncoder().encode(AAD_TEXT);
    let cipherBuffer;
    try {
        cipherBuffer = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv, additionalData: aad },
            deviceKey,
            new TextEncoder().encode(text)
        );
    } catch {
        throw new Error(
            '无法加密自动同步口令，可能是设备密钥已失效。请重试；如果仍然失败，请选择「仅本次会话」。'
        );
    }

    const record = {
        key: PASSPHRASE_KEY,
        value: {
            iv: bytesToBase64(iv),
            cipher: bytesToBase64(new Uint8Array(cipherBuffer))
        },
        updatedAt: Date.now()
    };

    // 单条 put 是原子操作：要么完整写入，要么不写，不会留下半条口令记录。
    try {
        await db.put(STORE, record);
    } catch {
        throw new Error(
            '无法保存自动同步口令到本机存储（可能是无痕模式或存储空间不足）。请选择「仅本次会话」。'
        );
    }
}

/**
 * 读取并解密自动同步口令。
 * - 没有记录返回 null；
 * - 设备密钥缺失、记录损坏、解密失败时抛出中文错误，不得返回空字符串。
 * @returns {Promise<string|null>}
 */
export async function loadAutoPassphrase() {
    const record = await readSecret(PASSPHRASE_KEY, '读取自动同步口令');
    if (record === undefined || record === null) {
        return null;
    }

    const parsed = parsePassphraseRecord(record);

    const deviceRecord = await readSecret(DEVICE_KEY, '读取设备密钥');
    if (!deviceRecord || !isCryptoKey(deviceRecord.value)) {
        throw new Error(
            '缺少用于解密的设备密钥，无法读取已保存的自动同步口令。请重新保存口令，或选择「仅本次会话」。'
        );
    }

    const crypto = requireCrypto();
    const aad = new TextEncoder().encode(AAD_TEXT);
    let plaintext;
    try {
        plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: parsed.iv, additionalData: aad },
            deviceRecord.value,
            parsed.cipher
        );
    } catch {
        throw new Error(
            '已保存的自动同步口令无法解密（可能设备密钥已更换或记录损坏）。请重新保存口令，或选择「仅本次会话」。'
        );
    }

    let text;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    } catch {
        throw new Error(
            '已保存的自动同步口令内容无效（不是有效的 UTF-8 文本）。请重新保存口令，或选择「仅本次会话」。'
        );
    }
    if (text.length === 0) {
        throw new Error(
            '已保存的自动同步口令为空，可能记录已损坏。请重新保存口令，或选择「仅本次会话」。'
        );
    }
    return text;
}

/**
 * 判断是否存在可读取的加密口令记录（只校验结构，不解密）。
 * @returns {Promise<boolean>}
 */
export async function hasStoredAutoPassphrase() {
    try {
        const record = await db.get(STORE, PASSPHRASE_KEY);
        return isPassphraseRecordLike(record);
    } catch {
        return false;
    }
}

/**
 * 删除已保存的自动同步口令（保留设备密钥）。
 * @returns {Promise<void>}
 */
export async function clearAutoPassphrase() {
    try {
        await db.delete(STORE, PASSPHRASE_KEY);
    } catch {
        throw new Error('无法删除已保存的自动同步口令，请稍后重试。');
    }
}

/**
 * 生成口令校验值：用候选口令加密固定文本 'tmplnote-auto-pass-check'，
 * 返回 Base64 编码的密文字节（复用 archiveCrypto.encryptArchive）。
 * @param {string} passphrase
 * @returns {Promise<string>}
 */
export async function createPassphraseCheck(passphrase) {
    const text = requirePassphrase(passphrase);
    // encryptArchive 内部会校验口令长度，并产生可展示的中文错误。
    const bytes = await encryptArchive(CHECK_TEXT, text);
    return bytesToBase64(bytes);
}

/**
 * 校验口令：解密校验值并比对固定文本。
 * 校验值为空、解密失败或内容不匹配时返回 false（不抛错）。
 * @param {string} passphrase
 * @param {string} check
 * @returns {Promise<boolean>}
 */
export async function verifyPassphraseCheck(passphrase, check) {
    if (typeof passphrase !== 'string' || passphrase.length === 0) return false;
    if (typeof check !== 'string' || check.length === 0) return false;

    let bytes;
    try {
        bytes = base64ToBytes(check);
    } catch {
        return false;
    }
    if (bytes.length === 0) return false;

    try {
        const text = await decryptArchive(bytes, passphrase);
        return text === CHECK_TEXT;
    } catch {
        // 校验值损坏、口令错误、环境不支持 WebCrypto 等一律视为校验失败。
        return false;
    }
}

export default {
    saveAutoPassphrase,
    loadAutoPassphrase,
    hasStoredAutoPassphrase,
    clearAutoPassphrase,
    createPassphraseCheck,
    verifyPassphraseCheck
};
