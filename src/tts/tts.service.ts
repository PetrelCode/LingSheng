import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { APP_CONFIG, AppConfig, ttsCacheDir } from '../config/config';
import { decodeWav, encodeMp3, resample, toMono } from './audio/audio';
import { XfEngine } from './engines/xf.engine';
import type { TtsProbe, VoiceSpec } from './engines/engine.interface';
import { normalizeText, splitText } from './text/text-normalize';

export interface SynthOptions {
  /** 音色 id，留空用 tts.defaultVoice */
  voice?: string;
  /** 语速，0-100，50 为正常 */
  speed?: number;
  /** 音量，0-100 */
  volume?: number;
  /** 音调，0-100 */
  pitch?: number;
  format?: 'mp3' | 'wav';
}

export interface SynthResult {
  /** 产物文件名 */
  name: string;
  /** 站内相对地址 */
  url: string;
  /** 磁盘绝对路径 */
  file: string;
  size: number;
  durationMs: number;
  cached: boolean;
  synthMs: number;
  text: string;
  voice: string;
}

@Injectable()
export class TtsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('TTS');
  private probe: TtsProbe = { available: false, reason: '未初始化' };
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private timer?: NodeJS.Timeout;
  private lastError = '';

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly engine: XfEngine,
  ) {}

  onModuleInit(): void {
    fs.mkdirSync(ttsCacheDir(this.cfg), { recursive: true });

    const defaultVoice = this.voiceOf();
    this.probe = this.engine.probe(defaultVoice);
    if (this.probe.available) {
      this.logger.log(
        `引擎就绪: ${this.engine.name} appid=${this.cfg.tts.appId} 音色=${defaultVoice.id}(${defaultVoice.jet}) 资源=${this.engine.resDir()}`,
      );
    } else if (this.cfg.tts.enabled) {
      this.logger.warn(`TTS 未就绪: ${this.probe.reason}`);
    }
    this.logger.log(`合成产物目录: ${ttsCacheDir(this.cfg)}`);

    this.timer = setInterval(() => this.cleanCache(), 60 * 60 * 1000);
    this.timer.unref();
    this.cleanCache();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  urlOf(name: string): string {
    return `${this.cfg.tts.urlPrefix}/${encodeURIComponent(name)}`;
  }

  /** 配置里声明的音色 */
  voices(): VoiceSpec[] {
    const list = this.cfg.tts.voices.length > 0 ? this.cfg.tts.voices : [{ id: 'female', jet: 'xiaoyan' }];
    return list.map((v) => ({
      id: v.id,
      label: v.label || v.id,
      jet: String(v.jet || v.id),
    }));
  }

  /** 按 id 取音色，未指定时取默认 */
  voiceOf(id?: string): VoiceSpec {
    const voices = this.voices();
    const wanted = id || this.cfg.tts.defaultVoice || voices[0].id;
    const found = voices.find((v) => v.id === wanted);
    if (found) return found;
    throw new BadRequestException(`未知音色: ${wanted}，可用 ${voices.map((v) => v.id).join(', ')}`);
  }

  /** 引擎是否可用，不可用时抛 503，不影响 /api/play */
  ensureReady(voice?: VoiceSpec): void {
    if (!this.cfg.tts.enabled) throw new ServiceUnavailableException('TTS 功能已关闭（config: tts.enabled）');
    const target = voice ?? this.voiceOf();
    this.probe = this.engine.probe(target);
    if (!this.probe.available) throw new ServiceUnavailableException(`TTS 引擎不可用: ${this.probe.reason}`);
  }

  /** 合成一段文本（自动归一化，不切段） */
  async synthesize(text: string, opts: SynthOptions = {}): Promise<SynthResult> {
    const voice = this.voiceOf(opts.voice);
    this.ensureReady(voice);
    const normalized = normalizeText(text);
    if (!normalized) throw new ServiceUnavailableException('文本归一化后为空');
    return this.synthesizeNormalized(normalized, voice, {
      speed: clampLevel(opts.speed, 50),
      volume: clampLevel(opts.volume, this.cfg.tts.volume),
      pitch: clampLevel(opts.pitch, this.cfg.tts.pitch),
      format: opts.format ?? this.cfg.tts.format,
    });
  }

  /**
   * 按标点切段并逐段合成，返回多段结果。
   * 一段一个 URL，设备会顺序播放，避免单文件过长导致的开播延迟。
   */
  async synthesizeMany(text: string, opts: SynthOptions = {}): Promise<SynthResult[]> {
    const voice = this.voiceOf(opts.voice);
    this.ensureReady(voice);
    const normalized = normalizeText(text);
    const segments = splitText(normalized, this.cfg.tts.segmentChars);
    if (segments.length === 0) throw new ServiceUnavailableException('文本归一化后为空');

    const speed = clampLevel(opts.speed, 50);
    const volume = clampLevel(opts.volume, this.cfg.tts.volume);
    const pitch = clampLevel(opts.pitch, this.cfg.tts.pitch);
    const format = opts.format ?? this.cfg.tts.format;

    const results: SynthResult[] = [];
    for (const segment of segments) {
      results.push(await this.synthesizeNormalized(segment, voice, { speed, volume, pitch, format }));
    }
    return results;
  }

  status() {
    const voices = this.voices().map((v) => {
      const probe = this.cfg.tts.enabled ? this.engine.probe(v) : { available: false, reason: '已关闭' };
      return { id: v.id, label: v.label, jet: v.jet, available: probe.available, reason: probe.reason ?? '' };
    });
    return {
      enabled: this.cfg.tts.enabled,
      available: this.probe.available,
      reason: this.probe.reason ?? '',
      engine: this.engine.name,
      bin: this.engine.binPath(),
      appId: maskAppId(this.cfg.tts.appId),
      workDir: this.engine.workDir(),
      resDir: this.engine.resDir(),
      defaultVoice: this.voiceOf().id,
      voices,
      format: this.cfg.tts.format,
      sampleRate: this.cfg.tts.sampleRate,
      bitrateKbps: this.cfg.tts.bitrateKbps,
      maxChars: this.cfg.tts.maxChars,
      segmentChars: this.cfg.tts.segmentChars,
      concurrency: this.cfg.tts.concurrency,
      urlPrefix: this.cfg.tts.urlPrefix,
      queue: { active: this.active, waiting: this.waiting.length, max: this.cfg.tts.maxQueue },
      cache: { ...this.cacheStats(), ttlHours: this.cfg.tts.cacheTtlHours, maxMb: this.cfg.tts.cacheMaxMb },
      lastError: this.lastError,
    };
  }

  private async synthesizeNormalized(
    text: string,
    voice: VoiceSpec,
    opts: { speed: number; volume: number; pitch: number; format: 'mp3' | 'wav' },
  ): Promise<SynthResult> {
    const name = this.cacheName(text, voice, opts);
    const file = path.join(ttsCacheDir(this.cfg), name);
    const started = Date.now();

    const cachedResult = (): SynthResult | undefined => {
      if (!fs.existsSync(file)) return undefined;
      const size = fs.statSync(file).size;
      if (size <= 0) return undefined;
      return {
        name,
        url: this.urlOf(name),
        file,
        size,
        durationMs: this.estimateDurationMs(size, opts.format),
        cached: true,
        synthMs: 0,
        text,
        voice: voice.id,
      };
    };

    const hit = cachedResult();
    if (hit) return hit;

    return this.withSlot(async () => {
      // 排队期间可能已被其它请求合成完
      const late = cachedResult();
      if (late) return late;

      const tmpWav = path.join(ttsCacheDir(this.cfg), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
      try {
        await this.engine.synthesize({
          text,
          outputFile: tmpWav,
          speed: opts.speed,
          volume: opts.volume,
          pitch: opts.pitch,
          voice: voice.id,
          jet: voice.jet,
        });
        const wav = decodeWav(fs.readFileSync(tmpWav));
        const mono = toMono(wav.samples, wav.channels);
        const targetRate = this.cfg.tts.sampleRate > 0 ? this.cfg.tts.sampleRate : wav.sampleRate;
        const pcm = resample(mono, wav.sampleRate, targetRate);
        const durationMs = Math.round((pcm.length / targetRate) * 1000);
        const payload = opts.format === 'wav' ? fs.readFileSync(tmpWav) : encodeMp3(pcm, targetRate, this.cfg.tts.bitrateKbps);

        const tmpFinal = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmpFinal, payload);
        fs.renameSync(tmpFinal, file);

        this.lastError = '';
        this.logger.log(`合成 ${name} (${voice.id}, ${payload.length}B, ${durationMs}ms, ${Date.now() - started}ms)`);
        return {
          name,
          url: this.urlOf(name),
          file,
          size: payload.length,
          durationMs,
          cached: false,
          synthMs: Date.now() - started,
          text,
          voice: voice.id,
        };
      } catch (e: any) {
        this.lastError = e?.message ?? String(e);
        this.logger.error(`合成失败: ${this.lastError}`);
        throw new ServiceUnavailableException(`文字转语音失败: ${this.lastError}`);
      } finally {
        fs.rm(tmpWav, { force: true }, () => undefined);
      }
    });
  }

  /** 并发闸门：每段是一个 MSC 子进程，默认串行。槽位直接转交给下一个等待者，避免竞态 */
  private async withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.cfg.tts.concurrency) {
      this.active += 1;
    } else {
      if (this.waiting.length >= this.cfg.tts.maxQueue) {
        throw new ServiceUnavailableException(`TTS 队列已满（上限 ${this.cfg.tts.maxQueue}），请稍后重试`);
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }

  /** 缓存命中时没有 PCM，按码率/采样率估算时长 */
  private estimateDurationMs(size: number, format: string): number {
    if (format === 'wav') {
      const rate = this.cfg.tts.sampleRate || 16000;
      return Math.max(0, Math.round(((size - 44) / 2 / rate) * 1000));
    }
    return Math.max(0, Math.round((size * 8) / Math.max(8, this.cfg.tts.bitrateKbps)));
  }

  private cacheName(
    text: string,
    voice: VoiceSpec,
    opts: { speed: number; volume: number; pitch: number; format: string },
  ): string {
    const key = [
      this.engine.name,
      this.cfg.tts.appId,
      voice.id,
      voice.jet,
      opts.format,
      this.cfg.tts.sampleRate,
      this.cfg.tts.bitrateKbps,
      opts.speed,
      opts.volume,
      opts.pitch,
      text,
    ].join('|');
    return `tts_${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}.${opts.format}`;
  }

  private cacheStats(): { dir: string; files: number; sizeMb: number } {
    const dir = ttsCacheDir(this.cfg);
    let files = 0;
    let bytes = 0;
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || entry.name.startsWith('.')) continue;
        files += 1;
        bytes += fs.statSync(path.join(dir, entry.name)).size;
      }
    }
    return { dir, files, sizeMb: Math.round((bytes / 1024 / 1024) * 10) / 10 };
  }

  /** 清理过期/超量产物与残留临时文件 */
  private cleanCache(): void {
    const dir = ttsCacheDir(this.cfg);
    if (!fs.existsSync(dir)) return;
    const ttlMs = this.cfg.tts.cacheTtlHours * 3600 * 1000;
    const maxBytes = this.cfg.tts.cacheMaxMb * 1024 * 1024;
    const now = Date.now();

    try {
      const entries = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => {
          const full = path.join(dir, d.name);
          const stat = fs.statSync(full);
          return { full, name: d.name, size: stat.size, mtime: stat.mtimeMs };
        });

      let removed = 0;
      for (const item of entries.filter((e) => e.name.endsWith('.tmp') || e.name.startsWith('.tmp-'))) {
        if (now - item.mtime > 3600 * 1000) {
          fs.rmSync(item.full, { force: true });
          removed += 1;
        }
      }

      const cacheable = entries.filter((e) => !e.name.startsWith('.') && !e.name.endsWith('.tmp'));
      const kept: typeof cacheable = [];
      for (const item of cacheable) {
        if (ttlMs > 0 && now - item.mtime > ttlMs) {
          fs.rmSync(item.full, { force: true });
          removed += 1;
        } else {
          kept.push(item);
        }
      }

      if (maxBytes > 0) {
        let total = kept.reduce((sum, e) => sum + e.size, 0);
        for (const item of kept.sort((a, b) => a.mtime - b.mtime)) {
          if (total <= maxBytes) break;
          fs.rmSync(item.full, { force: true });
          total -= item.size;
          removed += 1;
        }
      }

      if (removed > 0) this.logger.log(`清理 TTS 产物 ${removed} 个`);
    } catch (e: any) {
      this.logger.warn(`清理 TTS 产物失败: ${e?.message ?? e}`);
    }
  }
}

/** MSC 的 speed / volume / pitch 都是 0-100，未传或非法时用默认值 */
function clampLevel(v: number | undefined, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/** 状态接口只回显部分 appid，避免把授权信息原样打到外部 */
function maskAppId(appId: string): string {
  if (!appId) return '';
  if (appId.length <= 4) return appId;
  return `${appId.slice(0, 2)}****${appId.slice(-2)}`;
}
