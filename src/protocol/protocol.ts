/**
 * 菱声设备协议：MQTT 报文封装与主题规则
 *
 * ====== 以下规则来自设备抓包（SN 已脱敏，形如 0202****0H6R）======
 *
 * 设备上报的 sn 自带协议前缀：  "ls20://0202****0H6R"
 * 原厂 mgrserver 用 `sn.split(":")[0] + "://" + sn + "/req"` 拼主题，
 * 因此实际下行主题是：          "ls20://ls20://0202****0H6R/req"
 * 上行主题：                    "ls20/request"
 * 设备掉线遗嘱：                "ls20/will"
 *
 * 本项目内部一律用「裸 SN」（0202****0H6R）作为设备标识，
 * 拼主题时再按 topicMode 还原。默认 'double' 即上面对齐原厂的写法。
 * ==================================================================
 */

export type EnvelopeType = 'req' | 'resp' | 'notif';

export interface DeviceEnvelope<T = Record<string, any>> {
  type: EnvelopeType;
  /** 回包地址，设备/采集器用，形如 ls20://0202****0H6R/resp */
  source?: string;
  app?: string;
  /** 服务端下行多用 name，设备上行多用 op，两者等价 */
  name?: string;
  op?: string;
  callid?: string | number;
  params?: T;
  sec?: number;
  nsec?: number;
}

/**
 * 下行主题规则
 * - double       ls20://ls20://<SN>/req   （原厂实测，默认）
 * - simple       ls20://<SN>/req
 * - vendor-colon ls20://ls20:<SN>/req
 */
export type TopicMode = 'double' | 'simple' | 'vendor-colon';

/**
 * 兼容 "ls20://0202****0H6R" / "ls20://ls20://0202****0H6R" / "ls20:0202****0H6R" / "0202****0H6R"
 * 统一取裸 SN。注意不要改大小写，MQTT 主题区分大小写。
 */
export function normalizeSn(input: string): string {
  let s = String(input ?? '').trim();
  if (!s) return '';
  while (s.includes('://')) s = s.split('://').pop() as string;
  if (s.includes(':')) s = s.split(':').pop() as string;
  return s.trim();
}

/** 取报文的操作名（设备用 op，采集器用 name） */
export function opOf(msg: DeviceEnvelope | null | undefined): string {
  if (!msg) return '';
  return String(msg.op ?? msg.name ?? '').trim();
}

export function buildDeviceTopic(vendor: string, sn: string, mode: TopicMode = 'double'): string {
  const v = vendor || 'ls20';
  const bare = normalizeSn(sn);
  switch (mode) {
    case 'simple':
      return `${v}://${bare}/req`;
    case 'vendor-colon':
      return `${v}://${v}:${bare}/req`;
    case 'double':
    default:
      return `${v}://${v}://${bare}/req`;
  }
}

/** 设备侧约定的回包主题（当报文里没有 source 时兜底） */
export function buildDeviceRespTopic(vendor: string, sn: string, mode: TopicMode = 'double'): string {
  return buildDeviceTopic(vendor, sn, mode).replace(/\/req$/, '/resp');
}

export function buildUplinkTopic(vendor: string): string {
  return `${vendor || 'ls20'}/request`;
}

/** 设备遗嘱主题，用于接收掉线通知 */
export function buildWillTopic(vendor: string): string {
  return `${vendor || 'ls20'}/will`;
}

export function safeJson(text: string): any | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
