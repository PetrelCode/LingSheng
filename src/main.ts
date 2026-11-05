import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { CONFIG, configFilePath, detectLocalIp, ttsCacheDir } from './config/config';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  app.enableCors();
  app.enableShutdownHooks();
  app.useStaticAssets(CONFIG.media.dir, { prefix: `${CONFIG.media.urlPrefix}/`, index: false });
  // TTS 产物单独挂载，避免污染媒体库列表、避免被 /api/media/:name 误删
  app.useStaticAssets(ttsCacheDir(CONFIG), { prefix: `${CONFIG.tts.urlPrefix}/`, index: false });

  await app.listen(CONFIG.server.httpPort, CONFIG.server.host);

  const lan = CONFIG.server.publicBaseUrl || `http://${detectLocalIp()}:${CONFIG.server.httpPort}`;
  logger.log(`配置文件: ${configFilePath()}`);
  logger.log(`HTTP      http://${CONFIG.server.host}:${CONFIG.server.httpPort}`);
  logger.log(`设备访问根地址: ${lan}`);
  logger.log(`MQTT      tcp://${CONFIG.server.host}:${CONFIG.mqtt.port}`);
  logger.log(`媒体目录: ${CONFIG.media.dir}`);
  logger.log(`TTS 目录: ${CONFIG.tts.root}（产物 ${ttsCacheDir(CONFIG)}，${CONFIG.tts.enabled ? '已启用' : '已关闭'}）`);
}

void bootstrap();
