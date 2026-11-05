import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { diskStorage } from 'multer';

import { CONFIG } from '../config/config';
import { makeSafeFileName, MediaService, uniqueFileName } from './media.service';

@Controller('api/media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get()
  list(@Req() req: Request) {
    const base = baseUrl(req);
    return { code: 0, items: this.media.list().map((i) => ({ ...i, absoluteUrl: `${base}${i.url}` })) };
  }

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => cb(null, CONFIG.media.dir),
        filename: (_req, file, cb) => {
          try {
            const safe = makeSafeFileName(file.originalname);
            cb(null, uniqueFileName(CONFIG.media.dir, safe));
          } catch (e: any) {
            cb(e, '');
          }
        },
      }),
      limits: { fileSize: Math.max(1, CONFIG.media.maxSizeMb) * 1024 * 1024 },
    }),
  )
  upload(@UploadedFile() file: Express.Multer.File, @Req() req: Request) {
    if (!file) throw new BadRequestException('缺少文件字段 file');
    const url = this.media.urlOf(file.filename);
    return { code: 0, name: file.filename, size: file.size, url, absoluteUrl: `${baseUrl(req)}${url}` };
  }

  @Delete(':name')
  remove(@Param('name') name: string) {
    this.media.remove(name);
    return { code: 0 };
  }
}

function baseUrl(req: Request): string {
  return (CONFIG.server.publicBaseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}
