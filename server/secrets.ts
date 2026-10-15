// API key 加密保存：AES-256-GCM。
// 主密钥放在 ~/.ai-drama-studio/master.key（只有你自己能读），不在项目文件夹里，
// 所以把项目文件夹拷给别人，别人拿不到你的 key。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY_DIR = process.env.SECRET_DIR || path.join(os.homedir(), '.ai-drama-studio');
const KEY_FILE = path.join(KEY_DIR, 'master.key');

let masterKey: Buffer | null = null;

function getMasterKey(): Buffer {
  if (masterKey) return masterKey;
  if (fs.existsSync(KEY_FILE)) {
    masterKey = Buffer.from(fs.readFileSync(KEY_FILE, 'utf-8').trim(), 'base64');
  } else {
    fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
    masterKey = crypto.randomBytes(32);
    fs.writeFileSync(KEY_FILE, masterKey.toString('base64'), { mode: 0o600 });
  }
  return masterKey;
}

export function encrypt(plain: string): string {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getMasterKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decrypt(blob: string): string {
  if (!blob) return '';
  const [v, ivB, tagB, encB] = blob.split(':');
  if (v !== 'v1') throw new Error('无法识别的密钥格式');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', getMasterKey(), Buffer.from(ivB, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(encB, 'base64')), decipher.final()]).toString('utf-8');
  } catch {
    throw new Error('API key 解密失败：可能换了电脑或删了 ~/.ai-drama-studio/master.key，请在「模型管理」里重新填写 key');
  }
}

export function hint(plain: string): string {
  if (!plain) return '';
  return plain.length <= 4 ? '****' : `****${plain.slice(-4)}`;
}
