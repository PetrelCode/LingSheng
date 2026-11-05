import { Module } from '@nestjs/common';

import { AppController } from './app.controller';
import { APP_CONFIG, CONFIG } from './config/config';
import { DevicesController } from './devices/devices.controller';
import { DevicesService } from './devices/devices.service';
import { MediaController } from './media/media.controller';
import { MediaService } from './media/media.service';
import { MqttBrokerService } from './mqtt/mqtt-broker.service';
import { PlaybackController } from './playback/playback.controller';
import { PlaybackService } from './playback/playback.service';
import { XfEngine } from './tts/engines/xf.engine';
import { TtsController } from './tts/tts.controller';
import { TtsService } from './tts/tts.service';

@Module({
  controllers: [AppController, DevicesController, PlaybackController, MediaController, TtsController],
  providers: [
    { provide: APP_CONFIG, useValue: CONFIG },
    MqttBrokerService,
    DevicesService,
    PlaybackService,
    MediaService,
    XfEngine,
    TtsService,
  ],
})
export class AppModule {}
