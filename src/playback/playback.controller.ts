import { BadRequestException, Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { resolveBase, toAbsoluteUrl } from '../common/url.util';
import { APP_CONFIG, AppConfig, effectivePublicBase } from '../config/config';
import { PlaybackService } from './playback.service';

class PlayDto {
  sns: string[];
  /** 绝对地址，如 http://192.168.1.10:8080/media/a.mp3，或站内相对地址 /media/a.mp3 */
  url?: string;
  /** 媒体库中的文件名，与 url 二选一 */
  media?: string;
  vol?: number;
  level?: number;
  count?: number;
  length?: number;
  name?: string;
  tid?: string;
  uid?: string;
  /** 覆盖下发给设备的文件访问根地址 */
  baseUrl?: string;
}

class StopDto {
  sns: string[];
  tid?: string;
}

class VolumeDto {
  sns: string[];
  vol: number;
}

class MuteDto {
  sns: string[];
}

@Controller('api')
export class PlaybackController {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly playback: PlaybackService,
  ) {}

  /**
   * 即时播报。
   * POST /api/play
   * { "sns": ["0201****AA05"], "media": "alarm.mp3", "vol": 60, "count": 1 }
   */
  @Post('play')
  async play(@Body() dto: PlayDto, @Req() req: Request) {
    const sns = normalizeSns(dto.sns);
    if (!dto.url && !dto.media) throw new BadRequestException('url 与 media 至少提供一个');

    const base = resolveBase(dto.baseUrl, effectivePublicBase(this.cfg), req);
    const uri = dto.url ? toAbsoluteUrl(dto.url, base) : `${base}${this.cfg.media.urlPrefix}/${encodeURIComponent(dto.media!)}`;
    const displayName = dto.name || dto.media || decodeURIComponent(uri.split('/').pop() || 'audio');

    const result = await this.playback.play({
      sns,
      urls: [{ name: displayName, uri }],
      vol: dto.vol,
      level: dto.level,
      count: dto.count,
      length: dto.length,
      name: dto.name,
      tid: dto.tid,
      uid: dto.uid,
    });
    return { code: 0, ...result, uri };
  }

  @Post('stop')
  async stop(@Body() dto: StopDto) {
    const sns = normalizeSns(dto.sns);
    const r = await this.playback.stop(sns, dto.tid);
    return { code: 0, ...r };
  }

  @Post('volume')
  async volume(@Body() dto: VolumeDto) {
    const sns = normalizeSns(dto.sns);
    if (dto.vol === undefined || dto.vol === null) throw new BadRequestException('缺少 vol');
    const r = await this.playback.setVolume(sns, Number(dto.vol));
    return { code: 0, ...r };
  }

  /** 设备静音 */
  @Post('mute')
  async mute(@Body() dto: MuteDto) {
    const sns = normalizeSns(dto.sns);
    const r = await this.playback.setMuted(sns, true);
    return { code: 0, ...r };
  }

  /** 设备取消静音 */
  @Post('unmute')
  async unmute(@Body() dto: MuteDto) {
    const sns = normalizeSns(dto.sns);
    const r = await this.playback.setMuted(sns, false);
    return { code: 0, ...r };
  }

  @Get('tasks')
  tasks() {
    return { code: 0, tasks: this.playback.activeTasks() };
  }
}

function normalizeSns(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) throw new BadRequestException('sns 必须是非空数组');
  const list = input.map((v) => String(v).trim()).filter(Boolean);
  if (list.length === 0) throw new BadRequestException('sns 必须是非空数组');
  return list;
}
