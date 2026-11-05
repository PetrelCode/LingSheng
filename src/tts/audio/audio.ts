/**
 * 极简音频处理：只做 TTS 产物需要的三件事。
 *
 * 1. 解析引擎输出的 16bit PCM WAV
 * 2. 混单声道 + 线性重采样到目标采样率
 * 3. 用纯 JS 编码 MP3（不依赖 ffmpeg/lame 等外部可执行文件）
 */

import { Mp3Encoder } from './mp3-encoder';

export interface WavData {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** 交错排列的 16bit PCM，长 = 帧数 × 声道数 */
  samples: Int16Array;
}

function readSample(buf: Buffer, offset: number, bits: number): number {
  if (bits === 8) return (buf.readUInt8(offset) - 128) << 8;
  if (bits === 16) return buf.readInt16LE(offset);
  if (bits === 24) return buf.readIntLE(offset, 3) >> 8;
  if (bits === 32) return buf.readInt32LE(offset) >> 16;
  throw new Error(`不支持的 WAV 位深: ${bits}`);
}

export function decodeWav(buf: Buffer): WavData {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('TTS 产物不是有效的 WAV 文件');
  }

  let fmt: { channels: number; sampleRate: number; bitsPerSample: number } | undefined;
  let dataOffset = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      dataOffset = body;
      dataLength = Math.min(size, buf.length - body);
    }
    offset = body + size + (size % 2);
  }

  if (!fmt || dataOffset < 0) throw new Error('WAV 缺少 fmt/data 块');
  if (!fmt.channels || !fmt.sampleRate) throw new Error('WAV 头信息无效');

  const bytesPerSample = fmt.bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample < 1) {
    throw new Error(`不支持的 WAV 位深: ${fmt.bitsPerSample}`);
  }
  const frames = Math.floor(dataLength / (bytesPerSample * fmt.channels));
  const samples = new Int16Array(frames * fmt.channels);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = readSample(buf, dataOffset + i * bytesPerSample, fmt.bitsPerSample);
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: 16, samples };
}

export function toMono(samples: Int16Array, channels: number): Int16Array {
  if (channels <= 1) return samples;
  const frames = Math.floor(samples.length / channels);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += samples[i * channels + c];
    out[i] = Math.round(sum / channels);
  }
  return out;
}

export function resample(samples: Int16Array, srcRate: number, dstRate: number): Int16Array {
  if (srcRate === dstRate || srcRate <= 0 || dstRate <= 0) return samples;
  const ratio = dstRate / srcRate;
  const length = Math.max(1, Math.round(samples.length * ratio));
  const out = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const pos = i / ratio;
    const left = Math.floor(pos);
    const right = Math.min(samples.length - 1, left + 1);
    const frac = pos - left;
    out[i] = Math.round(samples[left] * (1 - frac) + samples[right] * frac);
  }
  return out;
}

export function encodeMp3(samples: Int16Array, sampleRate: number, kbps: number): Buffer {
  const encoder = new Mp3Encoder(1, sampleRate, kbps);
  const chunks: Buffer[] = [];
  const blockSize = 1152;
  for (let i = 0; i < samples.length; i += blockSize) {
    const block = samples.subarray(i, Math.min(i + blockSize, samples.length));
    const encoded = encoder.encodeBuffer(block);
    if (encoded && encoded.length > 0) chunks.push(Buffer.from(encoded));
  }
  const tail = encoder.flush();
  if (tail && tail.length > 0) chunks.push(Buffer.from(tail));
  return Buffer.concat(chunks);
}
