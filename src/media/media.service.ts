import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { APP_CONFIG, AppConfig } from '../config/config';

export interface MediaItem {
  name: string;
  size: number;
  mtime: number;
  url: string;
}

const ALLOWED_EXT = new Set(['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.flac']);

/**
 * 媒体文件管理。文件名强制 ASCII，避免音柱固件对中文/百分号编码支持不一致。
 */
@Injectable()
export class MediaService implements OnModuleInit {
  private readonly logger = new Logger('Media');

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  onModuleInit(): void {
    fs.mkdirSync(this.cfg.media.dir, { recursive: true });
    this.logger.log(`媒体目录: ${this.cfg.media.dir}`);
  }

  list(): MediaItem[] {
    const items = fs
      .readdirSync(this.cfg.media.dir, { withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.startsWith('.'))
      .map((d) => {
        const st = fs.statSync(path.join(this.cfg.media.dir, d.name));
        return { name: d.name, size: st.size, mtime: st.mtimeMs, url: this.urlOf(d.name) };
      });
    return items.sort((a, b) => b.mtime - a.mtime);
  }

  urlOf(name: string): string {
    return `${this.cfg.media.urlPrefix}/${encodeURIComponent(name)}`;
  }

  absolutePath(name: string): string {
    const safe = path.basename(name);
    if (safe !== name) throw new BadRequestException('非法的文件名');
    return path.join(this.cfg.media.dir, safe);
  }

  remove(name: string): void {
    const file = this.absolutePath(name);
    if (!fs.existsSync(file)) throw new NotFoundException('文件不存在');
    fs.unlinkSync(file);
  }

  exists(name: string): boolean {
    return fs.existsSync(this.absolutePath(name));
  }
}

/** 生成 ASCII 安全、目录内唯一的文件名 */
export function makeSafeFileName(original: string): string {
  const ext = path.extname(original).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new BadRequestException(`不支持的文件类型: ${ext || '(无扩展名)'}，允许 ${[...ALLOWED_EXT].join(' ')}`);
  }
  const base = path.basename(original, path.extname(original));
  let cleaned = base
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (cleaned.length < 2) cleaned = 'media';
  return `${cleaned}${ext}`;
}

/** 目录内重名时追加序号 */
export function uniqueFileName(dir: string, name: string): string {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    i += 1;
    candidate = `${base}_${i}${ext}`;
  }
  return candidate;
}
