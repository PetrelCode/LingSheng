import { Controller, Get, Inject } from '@nestjs/common';

import { APP_CONFIG, AppConfig } from './config/config';

@Controller()
export class AppController {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  @Get()
  info() {
    return {
      service: 'lingshen-core',
      version: '0.1.0',
      vendor: this.cfg.vendor.code,
      endpoints: {
        play: 'POST /api/play  { sns, media|url, vol, count }',
        stop: 'POST /api/stop  { sns, tid? }',
        volume: 'POST /api/volume  { sns, vol }',
        mute: 'POST /api/mute  { sns }',
        unmute: 'POST /api/unmute  { sns }',
        tasks: 'GET /api/tasks',
        devices: 'GET /api/devices',
        connections: 'GET /api/devices/connections',
        mediaUpload: 'POST /api/media  (multipart, field=file)',
        mediaList: 'GET /api/media',
        ttsPlay: 'POST /api/tts/play  { text, sns, vol, speed }',
        ttsSynth: 'POST /api/tts  { text, speed }  (只合成不播报)',
        ttsStatus: 'GET /api/tts/status',
        ttsVoices: 'GET /api/tts/voices',
      },
    };
  }

  @Get('api/health')
  health() {
    return { code: 0, status: 'ok', uptime: Math.floor(process.uptime()) };
  }
}
