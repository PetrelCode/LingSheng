export interface TtsProbe {
  available: boolean;
  reason?: string;
}

/** 解析后的音色：对应 MSC 的 voice_name 与 res/tts/<jet>.jet 资源 */
export interface VoiceSpec {
  id: string;
  label: string;
  /** 音色资源名（不带 .jet），同时作为 MSC 的 voice_name */
  jet: string;
}

export interface SynthTask {
  /** 已做归一化的文本 */
  text: string;
  /** 引擎写出的 WAV 绝对路径 */
  outputFile: string;
  /** 语速，0-100，50 为正常 */
  speed: number;
  /** 音量，0-100，50 为默认 */
  volume: number;
  /** 音调，0-100，50 为正常 */
  pitch: number;
  /** 音色 id，仅用于日志与缓存键 */
  voice: string;
  /** 本次合成使用的音色资源名 */
  jet: string;
}

/**
 * TTS 引擎抽象。
 * 约定：引擎只负责把文本合成成 16bit PCM WAV，编码/重采样/落盘由 TtsService 统一处理，
 * 这样换引擎不需要改业务代码。
 */
export interface TtsEngine {
  readonly name: string;
  probe(voice?: VoiceSpec): TtsProbe;
  synthesize(task: SynthTask): Promise<void>;
  /** 引擎可执行文件，仅用于状态展示与排查 */
  binPath(): string;
}
