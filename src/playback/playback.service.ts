import { Inject, Injectable, Logger } from '@nestjs/common';

import { APP_CONFIG, AppConfig } from '../config/config';
import { MqttBrokerService } from '../mqtt/mqtt-broker.service';
import { buildDeviceTopic, normalizeSn } from '../protocol/protocol';

export interface PlayItem {
  name: string;
  uri: string;
}

export interface PlayOptions {
  sns: string[];
  urls: PlayItem[];
  vol?: number;
  level?: number;
  count?: number;
  length?: number;
  name?: string;
  tid?: string;
  uid?: string;
}

export interface DispatchResult {
  sn: string;
  topic: string;
  ok: boolean;
  error?: string;
}

interface ActiveTask {
  tid: string;
  name: string;
  vol: number;
  startedAt: number;
}

/**
 * 即时播报（type=5）：直接把文件地址下发给音柱，设备自行下载播放。
 * 不需要 RTSP、不需要 ffmpeg、不需要采集器。
 */
@Injectable()
export class PlaybackService {
  private readonly logger = new Logger('Playback');
  private readonly active = new Map<string, ActiveTask>();
  private seq = 0;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly broker: MqttBrokerService,
  ) {}

  async play(opts: PlayOptions): Promise<{ tid: string; results: DispatchResult[] }> {
    const tid = opts.tid || this.nextTid();
    const vol = clamp(opts.vol ?? this.cfg.playback.defaultVol, 0, 100);
    const level = clamp(opts.level ?? this.cfg.playback.defaultLevel, 0, 99999);
    const count = opts.count ?? this.cfg.playback.defaultCount;
    const length = opts.length ?? 0;
    const name = opts.name || opts.urls[0]?.name || '即时播报';

    // 字段与顺序对齐原厂实测报文
    const envelope = {
      type: 'req',
      app: this.cfg.vendor.code,
      name: 'priority_task_play',
      source: 'noreplay',
      params: {
        count,
        length,
        level,
        name,
        tid,
        vol,
        type: 5,
        uid: opts.uid ?? this.cfg.playback.defaultUid ?? '',
        urls: opts.urls,
      },
      callid: 0,
    };

    const results = await this.dispatch(opts.sns, 'priority_task_play', envelope);
    for (const r of results) {
      if (r.ok) this.active.set(r.sn, { tid, name, vol, startedAt: Date.now() });
    }
    this.logger.log(`下发播放 tid=${tid} vol=${vol} urls=${opts.urls.map((u) => u.uri).join(',')}`);
    return { tid, results };
  }

  async stop(sns: string[], tid?: string): Promise<{ results: DispatchResult[] }> {
    const results: DispatchResult[] = [];
    for (const raw of sns) {
      const sn = normalizeSn(raw);
      const task = this.active.get(sn);
      const targetTid = tid || task?.tid;
      if (!targetTid) {
        results.push({ sn, topic: buildDeviceTopic(this.cfg.vendor.code, sn, this.cfg.vendor.topicMode), ok: false, error: '该设备没有正在执行的任务，请显式传入 tid' });
        continue;
      }
      const envelope = {
        type: 'req',
        app: this.cfg.vendor.code,
        name: 'priority_task_stop',
        source: 'noreplay',
        params: { tid: targetTid, tname: task?.name ?? '' },
        callid: 0,
      };
      const r = await this.dispatch([sn], 'priority_task_stop', envelope);
      results.push(...r);
      this.active.delete(sn);
    }
    return { results };
  }

  async setVolume(sns: string[], vol: number): Promise<{ results: DispatchResult[] }> {
    const v = clamp(vol, 0, 100);
    const byTid = new Map<string, string[]>();
    // 同一 tid 的设备合并成一包下发，减少报文
    for (const raw of sns) {
      const sn = normalizeSn(raw);
      const tid = this.active.get(sn)?.tid ?? '';
      const arr = byTid.get(tid) ?? [];
      arr.push(sn);
      byTid.set(tid, arr);
    }
    const results: DispatchResult[] = [];
    for (const [tid, list] of byTid) {
      const envelope = {
        type: 'req',
        app: this.cfg.vendor.code,
        name: 'priority_task_setvol',
        source: 'noreplay',
        params: { tid, vol: v },
        callid: 0,
      };
      results.push(...(await this.dispatch(list, 'priority_task_setvol', envelope)));
    }
    return { results };
  }

  /**
   * 设备级静音 / 取消静音。
   * 与任务音量无关：静音是设备整机行为，会盖掉所有正在播的内容。
   */
  async setMuted(sns: string[], muted: boolean): Promise<{ results: DispatchResult[] }> {
    const name = muted ? 'device_mute' : 'device_unmute';
    const envelope = {
      type: 'req',
      app: this.cfg.vendor.code,
      name,
      callid: 0,
    };
    const results = await this.dispatch(sns, name, envelope);
    return { results };
  }

  activeTasks(): Array<{ sn: string } & ActiveTask> {
    return [...this.active.entries()].map(([sn, t]) => ({ sn, ...t }));
  }

  private async dispatch(sns: string[], name: string, envelope: unknown): Promise<DispatchResult[]> {
    const out: DispatchResult[] = [];
    for (const raw of sns) {
      const sn = normalizeSn(raw);
      const topic = buildDeviceTopic(this.cfg.vendor.code, sn, this.cfg.vendor.topicMode);
      if (!sn) {
        out.push({ sn: raw, topic, ok: false, error: '设备 SN 为空' });
        continue;
      }
      try {
        await this.broker.publish(topic, envelope);
        out.push({ sn, topic, ok: true });
      } catch (e: any) {
        out.push({ sn, topic, ok: false, error: e.message });
      }
    }
    this.logger.log(`${name} 下发完成: ${out.filter((o) => o.ok).length}/${out.length}`);
    return out;
  }

  private nextTid(): string {
    this.seq = (this.seq + 1) % 1000;
    return `${Date.now()}_${this.seq}`;
  }
}

function clamp(v: number, min: number, max: number): number {
  const n = Number(v);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}
