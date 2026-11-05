/**
 * lamejs 桥接。
 *
 * lamejs 1.2.1 的 npm 入口（src/js/index.js）把 MPEGMode / BitStream / Lame
 * 当成浏览器全局变量使用，直接 require 会报 "MPEGMode is not defined"。
 * 这里在加载前把这三个模块挂到 globalThis，等价于浏览器 bundle 的行为。
 *
 * 只依赖纯 JS，不需要 lame/ffmpeg 等系统可执行文件，保持跨平台与离线部署。
 */

export interface Mp3EncoderInstance {
  encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
  flush(): Int8Array;
}

export type Mp3EncoderCtor = new (channels: number, sampleRate: number, kbps: number) => Mp3EncoderInstance;

const scope = globalThis as unknown as Record<string, unknown>;

for (const name of ['MPEGMode', 'BitStream', 'Lame']) {
  if (scope[name]) continue;
  try {
    scope[name] = require(`lamejs/src/js/${name}.js`);
  } catch {
    // 找不到内部模块时不做处理，后续 require('lamejs') 会给出明确错误
  }
}

const lamejs = require('lamejs') as { Mp3Encoder: Mp3EncoderCtor };

export const Mp3Encoder = lamejs.Mp3Encoder;
