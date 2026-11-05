import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import * as net from 'node:net';
import { Subject } from 'rxjs';

import createAedes, { Aedes, AedesClient, AedesOptions } from 'aedes';

import { APP_CONFIG, AppConfig } from '../config/config';
import { safeJson } from '../protocol/protocol';

export interface IncomingMessage {
  topic: string;
  payload: string;
  json: any;
  clientId: string;
  receivedAt: number;
}

export interface ClientInfo {
  clientId: string;
  ip: string;
  connectedAt: number;
}

/**
 * 内嵌 MQTT Broker。
 * 音柱设备直接连这里，不需要再部署 mosquitto/EMQX。
 */
@Injectable()
export class MqttBrokerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('MQTT');
  private broker: Aedes;
  private tcpServer: net.Server;

  private readonly messageSubject = new Subject<IncomingMessage>();
  readonly messages$ = this.messageSubject.asObservable();

  /** 当前已连接的客户端，联调时可通过接口查看 */
  readonly clients = new Map<string, ClientInfo>();

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  onApplicationBootstrap(): void {
    const { host, port, username, password } = this.cfg.mqtt;

    // 注意：aedes 用 `this.authenticate = opts.authenticate` 直接赋值，
    // 传入 authenticate: undefined 会覆盖掉默认实现导致连接崩溃，
    // 所以未配置账号时必须整个字段都不传。
    const options: AedesOptions = { id: 'lingshen-core' };
    if (username) {
      options.authenticate = (_client, user, pass, done) => {
        const pwd = Buffer.isBuffer(pass) ? pass.toString('utf8') : String(pass ?? '');
        const ok = user === username && pwd === password;
        if (!ok) this.logger.warn(`MQTT 认证失败: ${user}`);
        done(null, ok);
      };
    }

    this.broker = createAedes(options);

    this.broker.on('publish', (packet, client) => {
      // client 为 null 表示本服务自己 publish 的报文，回环忽略
      if (!client) return;
      const payload = packet.payload.toString('utf8');
      this.logger.log(`<- [${client.id}] ${packet.topic} ${truncate(payload)}`);
      this.messageSubject.next({
        topic: packet.topic,
        payload,
        json: safeJson(payload),
        clientId: client.id,
        receivedAt: Date.now(),
      });
    });

    this.broker.on('client', (client: AedesClient) => {
      const ip = client.conn?.remoteAddress || '';
      this.clients.set(client.id, { clientId: client.id, ip, connectedAt: Date.now() });
      this.logger.log(`设备已连接: ${client.id} (${ip})`);
    });

    this.broker.on('clientDisconnect', (client: AedesClient) => {
      this.clients.delete(client.id);
      this.logger.log(`设备已断开: ${client.id}`);
    });

    this.broker.on('clientError', (client: AedesClient, err: Error) => {
      this.logger.warn(`客户端异常 ${client?.id}: ${err.message}`);
    });

    this.tcpServer = net.createServer((socket) => {
      socket.on('error', (err) => this.logger.warn(`socket 异常: ${err.message}`));
      this.broker.handle(socket);
    });
    this.tcpServer.on('error', (err) => this.logger.error(`MQTT 监听失败: ${err.message}`));
    this.tcpServer.listen(port, host, () => {
      this.logger.log(`MQTT Broker 已启动: ${host}:${port}`);
    });
  }

  async publish(topic: string, message: unknown): Promise<void> {
    const payload = Buffer.from(typeof message === 'string' ? message : JSON.stringify(message), 'utf8');
    return new Promise((resolve, reject) => {
      this.broker.publish({ cmd: 'publish', topic, payload, qos: 0, retain: false }, (err) => {
        if (err) {
          this.logger.error(`发布失败 ${topic}: ${err.message}`);
          return reject(err);
        }
        this.logger.log(`-> ${topic} ${truncate(payload.toString('utf8'))}`);
        resolve();
      });
    });
  }

  onApplicationShutdown(): void {
    this.tcpServer?.close();
    this.broker?.close();
  }
}

function truncate(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}...(共 ${text.length} 字节)` : text;
}
