import { Inject, Injectable } from '@nestjs/common';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { APP_CONFIG, AppConfig, ttsBinPath, ttsLibDir, ttsResDir, ttsWorkDir } from '../../config/config';
import type { SynthTask, TtsEngine, TtsProbe, VoiceSpec } from './engine.interface';

/**
 * 讯飞离线 TTS 引擎（MSC 5.0.44）。
 *
 * 进程模型与旧版 tts_xf.sh 一致：一次请求起一个 xf-tts 进程，
 * 进程内 MSPLogin → QTTSSessionBegin → QTTSTextPut → QTTSAudioGet → 写 WAV。
 * 资源与动态库放在 <tts.root> 下，由 npm run tts:setup / tts:build 准备，
 * 不进 node_modules，也不进版本库。
 */
@Injectable()
export class XfEngine implements TtsEngine {
  readonly name = 'xf-offline';

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  binPath(): string {
    return ttsBinPath(this.cfg);
  }

  workDir(): string {
    return ttsWorkDir(this.cfg);
  }

  resDir(): string {
    return ttsResDir(this.cfg);
  }

  probe(voice?: VoiceSpec): TtsProbe {
    if (!this.cfg.tts.enabled) return { available: false, reason: '配置项 tts.enabled 为 false' };
    if (process.platform !== 'linux') {
      return { available: false, reason: `讯飞离线 SDK 仅支持 Linux x64（当前平台 ${process.platform}）` };
    }

    const bin = this.binPath();
    if (!fs.existsSync(bin)) {
      return { available: false, reason: `未找到 xf-tts: ${bin}（在 Linux 上执行 npm run tts:build）` };
    }

    const lib = path.join(ttsLibDir(this.cfg), 'libmsc.so');
    if (!fs.existsSync(lib)) {
      return { available: false, reason: `未找到 libmsc.so: ${lib}（执行 npm run tts:setup）` };
    }

    const work = this.workDir();
    if (!fs.existsSync(work)) return { available: false, reason: `MSC 工作目录不存在: ${work}` };
    try {
      fs.accessSync(work, fs.constants.W_OK);
    } catch {
      return { available: false, reason: `MSC 工作目录不可写: ${work}` };
    }

    const res = this.resDir();
    const common = path.join(res, 'common.jet');
    if (!fs.existsSync(common)) return { available: false, reason: `缺少通用资源: ${common}` };

    if (voice) {
      const jet = path.join(res, `${voice.jet}.jet`);
      if (!fs.existsSync(jet)) return { available: false, reason: `缺少音色资源: ${jet}` };
    }

    return { available: true };
  }

  async synthesize(task: SynthTask): Promise<void> {
    const bin = this.binPath();
    const libDir = ttsLibDir(this.cfg);
    const textFile = `${task.outputFile}.txt`;
    fs.writeFileSync(textFile, task.text, 'utf8');

    const args = [
      '--text-file',
      textFile,
      '--output',
      task.outputFile,
      '--appid',
      this.cfg.tts.appId,
      '--work-dir',
      this.workDir(),
      '--res-dir',
      this.resDir(),
      '--voice',
      task.jet,
      '--speed',
      String(clamp(task.speed, 0, 100)),
      '--volume',
      String(clamp(task.volume, 0, 100)),
      '--pitch',
      String(clamp(task.pitch, 0, 100)),
      // MSC 5.x 原生产物就是 16kHz；输出采样率由 TtsService 统一重采样，
      // 不把 tts.sampleRate 传给引擎，避免 SDK 忽略该参数时出现变调。
      '--sample-rate',
      '16000',
    ];

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // 可执行文件自带 rpath，这里再显式给一次，方便把 SDK 换到别的目录
      LD_LIBRARY_PATH: [libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(bin, args, { cwd: this.workDir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          reject(new Error(`TTS 合成超时（${this.cfg.tts.timeoutMs}ms）`));
        }, this.cfg.tts.timeoutMs);

        child.stdout?.on('data', () => undefined);
        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderr.length < 4000) stderr += chunk.toString();
        });

        child.on('error', (e: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(new Error(`无法启动 TTS 引擎: ${e.message}`));
        });

        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`xf-tts 退出码 ${code}: ${stderr.trim().slice(-800) || '无输出'}`));
        });
      });
    } finally {
      fs.rm(textFile, { force: true }, () => undefined);
    }

    if (!fs.existsSync(task.outputFile) || fs.statSync(task.outputFile).size <= 44) {
      throw new Error('xf-tts 未生成有效的音频文件');
    }
  }
}

function clamp(v: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return Math.round((min + max) / 2);
  return Math.min(max, Math.max(min, Math.round(n)));
}
