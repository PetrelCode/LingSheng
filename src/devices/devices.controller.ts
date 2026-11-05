import { Controller, Get, NotFoundException, Param } from '@nestjs/common';

import { DevicesService } from './devices.service';

@Controller('api/devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** 已注册设备（含在线状态） */
  @Get()
  list() {
    return { code: 0, devices: this.devices.list() };
  }

  /** 原始 MQTT 连接，联调设备连不上时先看这里 */
  @Get('connections')
  connections() {
    return { code: 0, connections: this.devices.connections() };
  }

  @Get(':sn')
  detail(@Param('sn') sn: string) {
    const dev = this.devices.get(sn);
    if (!dev) throw new NotFoundException(`设备 ${sn} 未注册`);
    return { code: 0, device: dev };
  }
}
