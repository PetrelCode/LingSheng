import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subscription } from 'rxjs';

import { APP_CONFIG, AppConfig, effectivePublicBase, hostOfBaseUrl } from '../config/config';
import { IncomingMessage, MqttBrokerService } from '../mqtt/mqtt-broker.service';
import { buildDeviceRespTopic, normalizeSn, opOf } from '../protocol/protocol';

export interface DeviceState {
  sn: string;
  name?: string;
  ip?: string;
  softwareVersion?: string;
  deviceType?: string;
  /** 设备上报的音量配置（player.vol_*） */
  volumes?: Record<string, any>;
  online: boolean;
  lastSeenAt: number;
  lastLoginAt?: number;
  clientId?: string;
  /** 设备最近一次任务事件 */
  lastEvent?: { op: string; tid?: string; at: number };
}

/**
 * 设备注册表。
 * 身份来自 devLogin（设备每次重连都会发），在线状态靠任务事件 + 超时判定。
 * 状态全在内存：本项目不需要历史数据。
 */
@Injectable()
export class DevicesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Devices');
  private readonly devices = new Map<string, DeviceState>();
  private sub?: Subscription;
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly broker: MqttBrokerService,
  ) {}

  onModuleInit(): void {
    this.sub = this.broker.messages$.subscribe((msg) => this.onMessage(msg));
    const interval = Math.max(10_000, Math.floor((this.cfg.device.offlineTimeoutSec * 1000) / 2));
    this.sweepTimer = setInterval(() => this.sweepOffline(), interval);
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  list(): DeviceState[] {
    return [...this.devices.values()].sort((a, b) => a.sn.localeCompare(b.sn));
  }

  get(sn: string): DeviceState | undefined {
    return this.devices.get(normalizeSn(sn));
  }

  /** 原始 MQTT 连接列表，联调时确认设备到底有没有连上来 */
  connections() {
    return [...this.broker.clients.values()];
  }

  private onMessage(msg: IncomingMessage): void {
    const op = opOf(msg.json);
    if (!op) return;
    const params = msg.json?.params ?? {};

    if (op === 'devLogin') {
      void this.handleLogin(msg);
      return;
    }

    if (op === 'task_started' || op === 'task_finished') {
      const sn = normalizeSn(params.sn ?? '');
      const dev = this.devices.get(sn);
      if (dev) {
        dev.lastSeenAt = Date.now();
        dev.online = true;
        dev.lastEvent = { op, tid: params.task_id, at: Date.now() };
      }
      this.logger.log(`任务事件 ${op} sn=${sn} tid=${params.task_id ?? '-'}`);
      return;
    }

    if (op === 'offline') {
      const sn = normalizeSn(params.sn ?? '');
      const dev = this.devices.get(sn);
      if (dev) {
        dev.online = false;
        this.logger.warn(`设备离线(遗嘱) ${sn}`);
      }
      return;
    }

    this.logger.debug(`忽略报文 op=${op} topic=${msg.topic}`);
  }

  private async handleLogin(msg: IncomingMessage): Promise<void> {
    const params = msg.json?.params ?? {};
    const sn = normalizeSn(params.sn ?? '');
    if (!sn) {
      this.logger.warn(`devLogin 缺少 sn，原始报文: ${msg.payload}`);
      return;
    }

    const now = Date.now();
    const prev = this.devices.get(sn);
    const state: DeviceState = {
      sn,
      name: params.name ?? prev?.name,
      ip: params.ip ?? prev?.ip ?? this.broker.clients.get(msg.clientId)?.ip,
      softwareVersion: params.software_version ?? prev?.softwareVersion,
      deviceType: params.type ?? prev?.deviceType,
      volumes: params.player ?? prev?.volumes,
      online: true,
      lastSeenAt: now,
      lastLoginAt: now,
      clientId: msg.clientId ?? prev?.clientId,
      lastEvent: prev?.lastEvent,
    };
    this.devices.set(sn, state);
    this.logger.log(`设备上线 ${sn} name=${state.name ?? '-'} ip=${state.ip ?? '-'} ver=${state.softwareVersion ?? '-'}`);

    const topic = msg.json?.source || buildDeviceRespTopic(this.cfg.vendor.code, sn, this.cfg.vendor.topicMode);
    try {
      await this.broker.publish(topic, this.buildLoginAck(state));
    } catch (e: any) {
      this.logger.error(`devLogin 应答发送失败: ${e.message}`);
    }
  }

  /**
   * 登录应答模板，字段结构取自原厂 mgrserver 实测报文，
   * 只把 resserver 的 ip / 端口替换成本服务自己的地址。
   */
  private buildLoginAck(dev: DeviceState) {
    const host = hostOfBaseUrl(effectivePublicBase(this.cfg));
    const httpPort = String(this.cfg.server.httpPort);
    const extra = this.cfg.device.loginAck ?? {};
    return {
      type: 'resp',
      op: 'devLogin',
      params: {
        use_ls21_server: true,
        result: 0,
        resserver_urls: [
          {
            downloadPort: '',
            filePort: httpPort,
            httpIp: '',
            id: 'lingshen-core',
            ip: host,
            mp3_delay: 2,
            name: 'lingshen',
            playMode: 1,
            public_ip: host,
            // 本方案不做 RTSP 推流，保留原厂字段值以免设备解析异常
            rtspPort: '8554',
            rtspProtocol: 'tcp',
            uploadPort: '',
            vendor: this.cfg.vendor.code,
          },
        ],
        mp3_delay: 2,
        rtspProtocol: 'tcp',
        EnvVolume: dev.volumes?.EnvVolume ?? 100,
        tasks: [],
        gpio: [],
        ...extra,
      },
      sec: Math.floor(Date.now() / 1000),
      nsec: 0,
    };
  }

  private sweepOffline(): void {
    const deadline = Date.now() - this.cfg.device.offlineTimeoutSec * 1000;
    for (const dev of this.devices.values()) {
      if (dev.online && dev.lastSeenAt < deadline) {
        dev.online = false;
        this.logger.warn(`设备离线(超时) ${dev.sn}`);
      }
    }
  }
}
