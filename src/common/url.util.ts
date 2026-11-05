import type { Request } from 'express';

/**
 * 解析下发给设备的文件访问根地址。
 * 优先级：请求体 baseUrl → 配置 publicBaseUrl → 本次请求的 host。
 */
export function resolveBase(dtoBase: string | undefined, cfgBase: string, req: Request): string {
  const raw = dtoBase || cfgBase || `${req.protocol}://${req.get('host')}`;
  return raw.replace(/\/+$/, '');
}

/** 把站内相对地址拼成绝对地址 */
export function toAbsoluteUrl(url: string, base: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
}
