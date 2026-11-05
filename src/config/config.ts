import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { TopicMode } from '../protocol/protocol';

export interface AppConfig {
  server: {
    host: string;
    httpPort: number;
    /** 设备访问本服务用的根地址，如 http://192.168.1.10:8080；留空则按请求 host 或本机网卡推断 */
    publicBaseUrl: string;
  };
  mqtt: {
    host: string;
    port: number;
    username: string;
    password: string;
  };
  vendor: {
    code: string;
    topicMode: TopicMode;
  };
  media: {
    dir: string;
    urlPrefix: string;
    maxSizeMb: number;
  };
  playback: {
    defaultVol: number;
    defaultLevel: number;
    defaultCount: number;
    defaultUid: string;
  };
  tts: {
    enabled: boolean;
    /** 引擎、SDK 资源与产物的根目录，内含 bin/、lib/、msc/、cache/ */
    root: string;
    /** 引擎可执行文件，留空则用 <root>/bin/xf-tts */
    bin: string;
    /** 讯飞 MSC appid：离线合成必须与 jet 资源的授权一致 */
    appId: string;
    /** MSC 工作目录（日志与授权缓存落在 <workDir>/msc），留空用 tts.root */
    workDir: string;
    /** 音色列表：jet 对应 <workDir>/msc/res/tts/<jet>.jet，同时作为 voice_name */
    voices: Array<{
      id: string;
      label?: string;
      /** 留空用 id */
      jet?: string;
    }>;
    /** 默认音色 id，留空取第一个 */
    defaultVoice: string;
    /** 默认音量，0-100 */
    volume: number;
    /** 默认音调，0-100 */
    pitch: number;
    /** 合成产物 URL 前缀，同时用于静态目录挂载 */
    urlPrefix: string;
    /** 产物格式：mp3（对齐旧系统实测格式）或 wav */
    format: 'mp3' | 'wav';
    /** 输出采样率，0 表示保持引擎原始的 16kHz */
    sampleRate: number;
    bitrateKbps: number;
    /** 单次请求文本长度上限（字符） */
    maxChars: number;
    /** 单段合成文本长度上限，超过则拆成多个 URL 顺序播放 */
    segmentChars: number;
    /** 并发合成数，每个子进程都会加载 jet 资源，建议 1 */
    concurrency: number;
    /** 排队上限，超出返回 503 */
    maxQueue: number;
    timeoutMs: number;
    cacheTtlHours: number;
    cacheMaxMb: number;
  };
  device: {
    /** 超过该时长没有心跳判定离线（秒） */
    offlineTimeoutSec: number;
    /** devLogin 应答里允许覆盖的字段（bitRate / timeSpan 等） */
    loginAck: Record<string, any>;
  };
}

const DEFAULTS: AppConfig = {
  // 默认 18080：8080 常被 rethinkdb 管理界面 / 其他中间件占用
  server: { host: '0.0.0.0', httpPort: 18080, publicBaseUrl: '' },
  mqtt: { host: '0.0.0.0', port: 21883, username: '', password: '' },
  vendor: { code: 'ls20', topicMode: 'double' },
  media: { dir: './media', urlPrefix: '/media', maxSizeMb: 100 },
  playback: { defaultVol: 60, defaultLevel: 99999, defaultCount: 1, defaultUid: '' },
  tts: {
    enabled: true,
    root: './tts',
    bin: '',
    // 与旧版 resserver/ls20_tts_xf_linux 一致：本地引擎，appid 5ff40276
    appId: '5ff40276',
    workDir: '',
    voices: [
      { id: 'female', label: '女声（小燕）', jet: 'xiaoyan' },
      { id: 'male', label: '男声（小峰）', jet: 'xiaofeng' },
    ],
    defaultVoice: 'female',
    volume: 50,
    pitch: 50,
    urlPrefix: '/tts',
    format: 'mp3',
    sampleRate: 16000,
    bitrateKbps: 32,
    maxChars: 300,
    segmentChars: 100,
    concurrency: 1,
    maxQueue: 20,
    timeoutMs: 30000,
    cacheTtlHours: 168,
    cacheMaxMb: 500,
  },
  device: { offlineTimeoutSec: 180, loginAck: { bitRate: '128', timeSpan: '1' } },
};

function isPlainObject(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: any): T {
  if (!isPlainObject(patch)) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject((base as any)?.[k])) out[k] = deepMerge((base as any)[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

export function configFilePath(): string {
  return process.env.LINGSHEN_CONFIG || path.resolve(process.cwd(), 'config.json');
}

export function loadConfig(): AppConfig {
  const file = configFilePath();
  let user: any = {};
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e: any) {
      throw new Error(`配置文件解析失败 ${file}: ${e.message}`);
    }
  }
  const cfg = deepMerge(DEFAULTS, user);

  if (process.env.LINGSHEN_HTTP_PORT) cfg.server.httpPort = Number(process.env.LINGSHEN_HTTP_PORT);
  if (process.env.LINGSHEN_MQTT_PORT) cfg.mqtt.port = Number(process.env.LINGSHEN_MQTT_PORT);
  if (process.env.LINGSHEN_PUBLIC_BASE_URL) cfg.server.publicBaseUrl = process.env.LINGSHEN_PUBLIC_BASE_URL;
  if (process.env.LINGSHEN_MEDIA_DIR) cfg.media.dir = process.env.LINGSHEN_MEDIA_DIR;
  if (process.env.LINGSHEN_TTS_ROOT) cfg.tts.root = process.env.LINGSHEN_TTS_ROOT;
  if (process.env.LINGSHEN_TTS_BIN) cfg.tts.bin = process.env.LINGSHEN_TTS_BIN;
  if (process.env.LINGSHEN_TTS_APP_ID) cfg.tts.appId = process.env.LINGSHEN_TTS_APP_ID;
  if (process.env.LINGSHEN_TTS_WORK_DIR) cfg.tts.workDir = process.env.LINGSHEN_TTS_WORK_DIR;
  if (process.env.LINGSHEN_TTS_ENABLED) cfg.tts.enabled = /^(1|true|yes)$/i.test(process.env.LINGSHEN_TTS_ENABLED);

  cfg.media.dir = path.isAbsolute(cfg.media.dir) ? cfg.media.dir : path.resolve(process.cwd(), cfg.media.dir);
  cfg.media.urlPrefix = '/' + cfg.media.urlPrefix.replace(/^\/+|\/+$/g, '');

  cfg.tts.root = path.isAbsolute(cfg.tts.root) ? cfg.tts.root : path.resolve(process.cwd(), cfg.tts.root);
  if (cfg.tts.bin) cfg.tts.bin = path.isAbsolute(cfg.tts.bin) ? cfg.tts.bin : path.resolve(process.cwd(), cfg.tts.bin);

  // 工作目录相对于 tts.root 解析：同一份 config.json 在开发机和目标机都能用
  cfg.tts.workDir = cfg.tts.workDir
    ? path.isAbsolute(cfg.tts.workDir)
      ? cfg.tts.workDir
      : path.resolve(cfg.tts.root, cfg.tts.workDir)
    : cfg.tts.root;

  cfg.tts.urlPrefix = '/' + cfg.tts.urlPrefix.replace(/^\/+|\/+$/g, '');
  if (cfg.tts.format !== 'wav') cfg.tts.format = 'mp3';
  if (!Array.isArray(cfg.tts.voices) || cfg.tts.voices.length === 0) cfg.tts.voices = [{ id: 'female', label: '女声（小燕）', jet: 'xiaoyan' }];
  cfg.tts.voices = cfg.tts.voices.map((v, i) => {
    const id = String(v.id || `voice${i + 1}`);
    return { ...v, id, label: v.label || id, jet: String(v.jet || id) };
  });
  return cfg;
}

/** 引擎可执行文件路径 */
export function ttsBinPath(cfg: AppConfig): string {
  if (cfg.tts.bin) return cfg.tts.bin;
  return path.join(cfg.tts.root, 'bin', 'xf-tts');
}

/** MSC 工作目录：日志与授权缓存落在 <workDir>/msc */
export function ttsWorkDir(cfg: AppConfig): string {
  return cfg.tts.workDir || cfg.tts.root;
}

/** 音色资源目录（common.jet / 各音色 jet） */
export function ttsResDir(cfg: AppConfig): string {
  return path.join(ttsWorkDir(cfg), 'msc', 'res', 'tts');
}

/** 讯飞动态库目录 */
export function ttsLibDir(cfg: AppConfig): string {
  return path.join(cfg.tts.root, 'lib');
}

/** 合成产物目录（同时也是静态挂载目录） */
export function ttsCacheDir(cfg: AppConfig): string {
  return path.join(cfg.tts.root, 'cache');
}

export const CONFIG = loadConfig();
export const APP_CONFIG = 'APP_CONFIG';

/** 本机第一个非回环 IPv4，用于给设备下发文件地址 */
export function detectLocalIp(): string {
  const ifaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) candidates.push(item.address);
    }
  }
  const preferred = candidates.find((ip) => ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip));
  return preferred || candidates[0] || '127.0.0.1';
}

/** 解析 "http://1.2.3.4:8080" 中的 host */
export function hostOfBaseUrl(baseUrl: string): string {
  if (!baseUrl) return detectLocalIp();
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return detectLocalIp();
  }
}
