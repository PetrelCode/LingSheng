/*
 * xf-tts —— 讯飞离线语音合成（MSC 5.0.44）命令行封装。
 *
 * 只做一件事：把一段 UTF-8 文本合成成 16bit PCM 单声道 WAV。
 * 编码、切段、缓存、并发全部由 Node 侧（src/tts）负责，
 * 与旧版 ls20_tts_xf_linux/tts + lame 的分工保持一致。
 *
 * 用法：
 *   xf-tts --text-file <txt> --output <wav>
 *          --appid <appid> --work-dir <dir> --res-dir <dir>
 *          --voice <xiaoyan|xiaofeng> [--speed 0-100] [--volume 0-100]
 *          [--pitch 0-100] [--sample-rate 16000] [--rdn 0] [--verbose]
 *
 * 说明：
 *   - 文本走文件而不是命令行参数，避免长文本触发 argv 长度限制，也不用转义引号。
 *   - MSC 5.0.44 只认相对 <work-dir>/msc 的资源路径，所以进程会切到该目录，
 *     并把 --res-dir 自动转换成相对路径后再交给 SDK。
 *   - 退出码：0 成功；2 参数错误；3 文本读取失败；4 登录失败；
 *             5 会话创建失败；6 文本送入失败；7 取音频失败；8 写文件失败。
 *
 * MSC 5.x 的 C 接口声明见 msp_cmn.h / qtts.h；这里直接 extern 声明，
 * 避免把讯飞头文件纳入版本库（本工程只用这 7 个符号）。
 */

/* -std=c11 下 glibc 会隐藏 realpath / nanosleep 等 POSIX 接口，必须显式声明 */
#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

/* ---- 旧版 MSC 离线 SDK 接口（msp_cmn.h / qtts.h） ---- */
extern const char *MSPLogin(const char *usr, const char *pwd, const char *cfg);
extern int MSPLogout(void);
extern const char *QTTSSessionBegin(const char *params, int *errorCode);
extern int QTTSTextPut(const char *sessionID, const char *textString,
                       unsigned int textLen, const char *params);
extern const void *QTTSAudioGet(const char *sessionID, unsigned int *audioLen,
                                int *synthStatus, int *errorCode);
extern int QTTSSessionEnd(const char *sessionID, const char *hints);

/* qtts.h 中的合成状态标记 */
#define MSP_TTS_FLAG_STILL_HAVE_DATA 1
#define MSP_TTS_FLAG_DATA_END 2

#define XF_DEFAULT_APPID "5ff40276"
#define XF_DEFAULT_SAMPLE_RATE 16000

typedef struct {
  const char *textFile;
  const char *output;
  const char *appId;
  const char *workDir;
  const char *resDir;
  const char *voice;
  int speed;
  int volume;
  int pitch;
  int sampleRate;
  int rdn;
  int verbose;
} Options;

static void usage(FILE *out) {
  fprintf(out,
          "xf-tts —— 讯飞离线语音合成\n"
          "用法: xf-tts --text-file <txt> --output <wav> --appid <appid>\n"
          "              --work-dir <dir> --res-dir <dir> --voice <name>\n"
          "              [--speed 0-100] [--volume 0-100] [--pitch 0-100]\n"
          "              [--sample-rate 16000] [--rdn 0] [--verbose]\n");
}

static const char *errorHint(int code) {
  switch (code) {
  case 10105:
    return "参数无效：检查 appid / work-dir / res-dir / 采样率";
  case 10114:
    return "会话超时";
  case 10116:
    return "会话不存在";
  case 11200:
    return "授权失败：appid 与 jet 资源不匹配（日志里非致命的 11200 警告可忽略）";
  default:
    return "详见讯飞 MSC 错误码表";
  }
}

static void reportError(const char *stage, int code) {
  fprintf(stderr, "xf-tts: %s failed, error code: %d (0x%x) —— %s\n", stage,
          code, code, errorHint(code));
}

static int parsePositiveInt(const char *raw, int min, int max, const char *name,
                            int *out) {
  char *end = NULL;
  long value = strtol(raw, &end, 10);
  if (end == raw || *end != '\0' || value < min || value > max) {
    fprintf(stderr, "xf-tts: %s 取值非法（%s），允许范围 %d-%d\n", name, raw,
            min, max);
    return -1;
  }
  *out = (int)value;
  return 0;
}

static int parseArgs(int argc, char **argv, Options *opt) {
  opt->textFile = NULL;
  opt->output = NULL;
  opt->appId = XF_DEFAULT_APPID;
  opt->workDir = NULL;
  opt->resDir = NULL;
  opt->voice = NULL;
  opt->speed = 50;
  opt->volume = 50;
  opt->pitch = 50;
  opt->sampleRate = XF_DEFAULT_SAMPLE_RATE;
  opt->rdn = 0;
  opt->verbose = 0;

  for (int i = 1; i < argc; i += 1) {
    const char *key = argv[i];
    if (strcmp(key, "-h") == 0 || strcmp(key, "--help") == 0) {
      usage(stdout);
      return 1;
    }
    if (strcmp(key, "--verbose") == 0) {
      opt->verbose = 1;
      continue;
    }
    if (i + 1 >= argc) {
      fprintf(stderr, "xf-tts: 缺少 %s 的取值\n", key);
      return -1;
    }
    const char *val = argv[++i];
    if (strcmp(key, "--text-file") == 0) {
      opt->textFile = val;
    } else if (strcmp(key, "--output") == 0) {
      opt->output = val;
    } else if (strcmp(key, "--appid") == 0) {
      opt->appId = val;
    } else if (strcmp(key, "--work-dir") == 0) {
      opt->workDir = val;
    } else if (strcmp(key, "--res-dir") == 0) {
      opt->resDir = val;
    } else if (strcmp(key, "--voice") == 0) {
      opt->voice = val;
    } else if (strcmp(key, "--speed") == 0) {
      if (parsePositiveInt(val, 0, 100, "--speed", &opt->speed) != 0) return -1;
    } else if (strcmp(key, "--volume") == 0) {
      if (parsePositiveInt(val, 0, 100, "--volume", &opt->volume) != 0)
        return -1;
    } else if (strcmp(key, "--pitch") == 0) {
      if (parsePositiveInt(val, 0, 100, "--pitch", &opt->pitch) != 0) return -1;
    } else if (strcmp(key, "--sample-rate") == 0) {
      if (parsePositiveInt(val, 8000, 48000, "--sample-rate",
                           &opt->sampleRate) != 0)
        return -1;
    } else if (strcmp(key, "--rdn") == 0) {
      if (parsePositiveInt(val, 0, 1, "--rdn", &opt->rdn) != 0) return -1;
    } else {
      fprintf(stderr, "xf-tts: 未知参数 %s\n", key);
      return -1;
    }
  }

  if (!opt->textFile || !opt->output || !opt->workDir || !opt->resDir ||
      !opt->voice) {
    fprintf(stderr, "xf-tts: --text-file / --output / --work-dir / --res-dir / "
                    "--voice 都是必填的\n");
    return -1;
  }
  return 0;
}

static char *readWholeFile(const char *file, size_t *length) {
  FILE *fp = fopen(file, "rb");
  if (!fp) {
    fprintf(stderr, "xf-tts: 打开文本文件失败 %s: %s\n", file, strerror(errno));
    return NULL;
  }
  if (fseek(fp, 0, SEEK_END) != 0) {
    fclose(fp);
    return NULL;
  }
  long size = ftell(fp);
  if (size < 0) {
    fclose(fp);
    return NULL;
  }
  rewind(fp);
  char *buf = (char *)malloc((size_t)size + 1);
  if (!buf) {
    fclose(fp);
    return NULL;
  }
  size_t read = fread(buf, 1, (size_t)size, fp);
  fclose(fp);
  if (read != (size_t)size) {
    free(buf);
    return NULL;
  }
  buf[read] = '\0';
  *length = read;
  return buf;
}

static void putLE32(unsigned char *p, unsigned int v) {
  p[0] = (unsigned char)(v & 0xff);
  p[1] = (unsigned char)((v >> 8) & 0xff);
  p[2] = (unsigned char)((v >> 16) & 0xff);
  p[3] = (unsigned char)((v >> 24) & 0xff);
}

static void putLE16(unsigned char *p, unsigned int v) {
  p[0] = (unsigned char)(v & 0xff);
  p[1] = (unsigned char)((v >> 8) & 0xff);
}

/** 先写占位头，音频写完后回填长度 */
static int writeWavHeader(FILE *fp, int sampleRate) {
  unsigned char h[44];
  memset(h, 0, sizeof(h));
  memcpy(h, "RIFF", 4);
  memcpy(h + 8, "WAVE", 4);
  memcpy(h + 12, "fmt ", 4);
  putLE32(h + 16, 16);
  putLE16(h + 20, 1);                    /* PCM */
  putLE16(h + 22, 1);                    /* 单声道 */
  putLE32(h + 24, (unsigned int)sampleRate);
  putLE32(h + 28, (unsigned int)sampleRate * 2); /* byteRate */
  putLE16(h + 32, 2);                    /* blockAlign */
  putLE16(h + 34, 16);                   /* bitsPerSample */
  memcpy(h + 36, "data", 4);
  return fwrite(h, 1, sizeof(h), fp) == sizeof(h) ? 0 : -1;
}

static int patchWavHeader(FILE *fp, long dataBytes) {
  unsigned char buf[4];
  if (fseek(fp, 4, SEEK_SET) != 0) return -1;
  putLE32(buf, (unsigned int)(36 + dataBytes));
  if (fwrite(buf, 1, 4, fp) != 4) return -1;
  if (fseek(fp, 40, SEEK_SET) != 0) return -1;
  putLE32(buf, (unsigned int)dataBytes);
  if (fwrite(buf, 1, 4, fp) != 4) return -1;
  return 0;
}

int main(int argc, char **argv) {
  Options opt;
  int parsed = parseArgs(argc, argv, &opt);
  if (parsed != 0) return parsed > 0 ? 0 : 2;

  size_t textLen = 0;
  char *text = readWholeFile(opt.textFile, &textLen);
  if (!text) return 3;
  if (textLen == 0) {
    fprintf(stderr, "xf-tts: 文本为空\n");
    free(text);
    return 3;
  }

  /* 统一转成绝对路径，避免后续 chdir 影响相对路径参数 */
  char workAbs[4096];
  char resAbs[4096];
  if (realpath(opt.workDir, workAbs) == NULL) {
    fprintf(stderr, "xf-tts: 工作目录不存在 %s: %s\n", opt.workDir,
            strerror(errno));
    free(text);
    return 2;
  }
  if (realpath(opt.resDir, resAbs) == NULL) {
    fprintf(stderr, "xf-tts: 资源目录不存在 %s: %s\n", opt.resDir,
            strerror(errno));
    free(text);
    return 2;
  }

  /*
   * 关键：MSC 5.0.44 的 fo| 资源路径必须是「相对 <work_dir>/msc 的路径」。
   * 传绝对路径时它不会返回错误码，只是静默打不开资源，QTTSAudioGet 直接返回空。
   * 旧系统就是 chdir 到 msc/ 后用 res/tts/xiaoyan.jet，这里保持一致。
   */
  char dataDir[8192];
  int nd = snprintf(dataDir, sizeof(dataDir), "%s/msc", workAbs);
  if (nd <= 0 || nd >= (int)sizeof(dataDir) || access(dataDir, X_OK) != 0) {
    snprintf(dataDir, sizeof(dataDir), "%s", workAbs);
  }
  if (chdir(dataDir) != 0) {
    fprintf(stderr, "xf-tts: 无法进入工作目录 %s: %s\n", dataDir,
            strerror(errno));
    free(text);
    return 2;
  }

  char cwd[4096];
  char cwdReal[4096];
  if (getcwd(cwd, sizeof(cwd)) == NULL) {
    fprintf(stderr, "xf-tts: 读取当前目录失败: %s\n", strerror(errno));
    free(text);
    return 2;
  }
  if (realpath(cwd, cwdReal) == NULL) snprintf(cwdReal, sizeof(cwdReal), "%s", cwd);

  const char *resBase = resAbs;
  size_t cwdLen = strlen(cwdReal);
  if (strncmp(resAbs, cwdReal, cwdLen) == 0 && resAbs[cwdLen] == '/') {
    resBase = resAbs + cwdLen + 1;
  }

  char commonJet[4096];
  char voiceJet[4096];
  int n1 = snprintf(commonJet, sizeof(commonJet), "%s/common.jet", resBase);
  int n2 = snprintf(voiceJet, sizeof(voiceJet), "%s/%s.jet", resBase,
                    opt.voice);
  if (n1 <= 0 || n1 >= (int)sizeof(commonJet) || n2 <= 0 ||
      n2 >= (int)sizeof(voiceJet)) {
    fprintf(stderr, "xf-tts: 资源路径过长\n");
    free(text);
    return 2;
  }
  if (access(commonJet, R_OK) != 0 || access(voiceJet, R_OK) != 0) {
    fprintf(stderr, "xf-tts: 缺少音色资源: %s / %s（当前目录 %s）\n", voiceJet,
            commonJet, cwd);
    free(text);
    return 2;
  }
  if (opt.verbose) {
    fprintf(stderr, "xf-tts: cwd=%s work_dir=%s res=%s;%s\n", cwd, workAbs,
            voiceJet, commonJet);
  }

  char loginCfg[8192];
  int n3 = snprintf(loginCfg, sizeof(loginCfg), "appid=%s,work_dir=%s",
                    opt.appId, workAbs);
  if (n3 <= 0 || n3 >= (int)sizeof(loginCfg)) {
    fprintf(stderr, "xf-tts: 登录参数过长\n");
    free(text);
    return 2;
  }

  int code = 0;
  const char *loginRet = MSPLogin(NULL, NULL, loginCfg);
  if (loginRet != NULL) {
    fprintf(stderr, "xf-tts: MSPLogin failed: %s\n", loginRet);
    free(text);
    return 4;
  }

  int result = 0;
  char sessionParams[16384];
  int n4 = snprintf(
      sessionParams, sizeof(sessionParams),
      "engine_type=local,voice_name=%s,text_encoding=UTF8,"
      "tts_res_path=fo|%s;fo|%s,sample_rate=%d,speed=%d,volume=%d,pitch=%d,"
      "rdn=%d",
      opt.voice, voiceJet, commonJet, opt.sampleRate, opt.speed, opt.volume,
      opt.pitch, opt.rdn);
  if (n4 <= 0 || n4 >= (int)sizeof(sessionParams)) {
    fprintf(stderr, "xf-tts: 合成参数过长\n");
    MSPLogout();
    free(text);
    return 2;
  }

  const char *session = QTTSSessionBegin(sessionParams, &code);
  if (session == NULL || code != 0) {
    if (code != 0) {
      reportError("QTTSSessionBegin", code);
    } else {
      fprintf(stderr, "xf-tts: QTTSSessionBegin 返回空会话\n");
    }
    if (session != NULL) QTTSSessionEnd(session, "BeginError");
    MSPLogout();
    free(text);
    return 5;
  }

  code = QTTSTextPut(session, text, (unsigned int)textLen, NULL);
  free(text);
  if (code != 0) {
    reportError("QTTSTextPut", code);
    QTTSSessionEnd(session, "TextPutError");
    MSPLogout();
    return 6;
  }

  FILE *fp = fopen(opt.output, "wb");
  if (!fp) {
    fprintf(stderr, "xf-tts: 无法创建输出文件 %s: %s\n", opt.output,
            strerror(errno));
    QTTSSessionEnd(session, "FileError");
    MSPLogout();
    return 8;
  }
  if (writeWavHeader(fp, opt.sampleRate) != 0) {
    fclose(fp);
    QTTSSessionEnd(session, "FileError");
    MSPLogout();
    return 8;
  }

  long dataBytes = 0;
  int calls = 0;
  int lastStatus = -1;
  int lastErr = 0;
  int nullStreak = 0;
  while (1) {
    unsigned int audioLen = 0;
    int synthStatus = MSP_TTS_FLAG_STILL_HAVE_DATA;
    int err = 0;
    const void *audio = QTTSAudioGet(session, &audioLen, &synthStatus, &err);
    calls += 1;
    lastStatus = synthStatus;
    lastErr = err;
    if (opt.verbose) {
      fprintf(stderr, "xf-tts: audio#%d %s len=%u status=%d err=%d\n", calls,
              audio != NULL ? "data" : "null", audioLen, synthStatus, err);
    }
    if (err != 0) {
      reportError("QTTSAudioGet", err);
      result = 7;
      break;
    }
    if (audio != NULL && audioLen > 0) {
      if (fwrite(audio, 1, audioLen, fp) != audioLen) {
        fprintf(stderr, "xf-tts: 写音频失败: %s\n", strerror(errno));
        result = 8;
        break;
      }
      dataBytes += (long)audioLen;
      nullStreak = 0;
    } else if (audio == NULL) {
      /* 合成未就绪时个别版本会先返回空指针，短暂重试后再判定为空结果 */
      nullStreak += 1;
      if (synthStatus == MSP_TTS_FLAG_DATA_END || nullStreak > 50) break;
      struct timespec pause = {0, 20 * 1000 * 1000};
      nanosleep(&pause, NULL);
      continue;
    }
    if (synthStatus == MSP_TTS_FLAG_DATA_END) break;
  }

  if (result == 0) {
    if (fflush(fp) != 0 || patchWavHeader(fp, dataBytes) != 0) {
      fprintf(stderr, "xf-tts: 回填 WAV 长度失败\n");
      result = 8;
    }
  }
  if (fclose(fp) != 0 && result == 0) result = 8;

  if (result == 0 && dataBytes <= 0) {
    fprintf(stderr,
            "xf-tts: 合成结果为空（AudioGet %d 次，最后 status=%d err=%d，"
            "资源=%s，cwd=%s）\n",
            calls, lastStatus, lastErr, voiceJet, cwd);
    result = 7;
  }

  if (QTTSSessionEnd(session, "Normal") != 0 && result == 0) {
    fprintf(stderr, "xf-tts: QTTSSessionEnd 返回非 0（音频已生成，忽略）\n");
  }
  MSPLogout();

  if (result != 0) {
    remove(opt.output);
    return result;
  }
  return 0;
}
