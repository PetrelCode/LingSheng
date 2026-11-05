import { BadRequestException, Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { resolveBase, toAbsoluteUrl } from '../common/url.util';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PlaybackService } from '../playback/playback.service';
import { TtsService } from './tts.service';

class TtsPlayDto {
  text: string;
  sns: string[];
  /** 音色 id，见 GET /api/tts/voices，留空用默认音色 */
  voice?: string;
  /** 语速，0-100，50 为正常 */
  speed?: number;
  /** 合成音量，0-100，留空用 tts.volume */
  volume?: number;
  /** 音调，0-100，留空用 tts.pitch */
  pitch?: number;
  vol?: number;
  level?: number;
  count?: number;
  length?: number;
  /** 任务名，同时作为设备上显示的名称 */
  name?: string;
  tid?: string;
  uid?: string;
  /** 覆盖下发给设备的文件访问根地址 */
  baseUrl?: string;
  /** 覆盖输出格式 */
  format?: string;
}

class TtsSynthDto {
  text: string;
  voice?: string;
  speed?: number;
  volume?: number;
  pitch?: number;
  format?: string;
}

@Controller('api')
export class TtsController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly tts: TtsService,
    private readonly playback: PlaybackService,
  ) {}

  /**
   * 文字转语音并即时播报。
   * POST /api/tts/play
   * { "text": "三号库房温度异常", "sns": ["0201A9ADAA05"], "voice": "male", "vol": 60 }
   */
  @Post('tts/play')
  async play(@Body() dto: TtsPlayDto, @Req() req: Request) {
    const sns = normalizeSns(dto.sns);
    const text = requireText(dto.text, this.cfg.tts.maxChars);
    const format = normalizeFormat(dto.format, this.cfg.tts.format);
    const base = resolveBase(dto.baseUrl, this.cfg.server.publicBaseUrl, req);
    const started = Date.now();

    const synthesized = await this.tts.synthesizeMany(text, {
      voice: dto.voice,
      speed: dto.speed,
      volume: dto.volume,
      pitch: dto.pitch,
      format,
    });
    const urls = synthesized.map((item) => ({ name: item.name, uri: toAbsoluteUrl(this.tts.urlOf(item.name), base) }));
    const synthMs = Date.now() - started;

    const result = await this.playback.play({
      sns,
      urls,
      vol: dto.vol,
      level: dto.level,
      count: dto.count,
      length: dto.length,
      name: dto.name || '文字播报',
      tid: dto.tid,
      uid: dto.uid,
    });

    return {
      code: 0,
      tid: result.tid,
      voice: synthesized[0]?.voice ?? '',
      segments: urls.length,
      urls,
      cached: synthesized.every((item) => item.cached),
      synthMs,
      totalMs: Date.now() - started,
      text: synthesized.map((item) => item.text).join(''),
      results: result.results,
    };
  }

  /**
   * 只合成，不播报。
   * POST /api/tts
   */
  @Post('tts')
  async synth(@Body() dto: TtsSynthDto, @Req() req: Request) {
    const text = requireText(dto.text, this.cfg.tts.maxChars);
    const format = normalizeFormat(dto.format, this.cfg.tts.format);
    const item = await this.tts.synthesize(text, {
      voice: dto.voice,
      speed: dto.speed,
      volume: dto.volume,
      pitch: dto.pitch,
      format,
    });
    const base = resolveBase(undefined, this.cfg.server.publicBaseUrl, req);
    return {
      code: 0,
      name: item.name,
      url: toAbsoluteUrl(item.url, base),
      voice: item.voice,
      size: item.size,
      durationMs: item.durationMs,
      cached: item.cached,
      synthMs: item.synthMs,
      text: item.text,
    };
  }

  @Get('tts/status')
  status() {
    return { code: 0, ...this.tts.status() };
  }

  /** 可用音色 */
  @Get('tts/voices')
  voices() {
    const status = this.tts.status();
    return {
      code: 0,
      engine: status.engine,
      defaultVoice: status.defaultVoice,
      voices: status.voices.map((v) => ({
        id: v.id,
        label: v.label,
        jet: v.jet,
        available: v.available,
        format: status.format,
        sampleRate: status.sampleRate,
      })),
    };
  }
}

function normalizeSns(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) throw new BadRequestException('sns 必须是非空数组');
  const list = input.map((v) => String(v).trim()).filter(Boolean);
  if (list.length === 0) throw new BadRequestException('sns 必须是非空数组');
  return list;
}

function requireText(raw: unknown, maxChars: number): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) throw new BadRequestException('text 不能为空');
  if (text.length > maxChars) {
    throw new BadRequestException(`text 超长（${text.length} > ${maxChars}），请拆分后分批调用`);
  }
  return text;
}

function normalizeFormat(raw: unknown, fallback: 'mp3' | 'wav'): 'mp3' | 'wav' {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = String(raw).toLowerCase();
  if (value !== 'mp3' && value !== 'wav') throw new BadRequestException('format 只能是 mp3 或 wav');
  return value;
}
