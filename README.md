# lingsheng-core-xf

菱声 LS20/LS22 音柱控制核心服务（**讯飞离线 TTS 版**）。对外提供两类能力：

- **API 即时播报**：调用接口让一台或多台音柱播放指定音频文件；
- **文字转语音（TTS）**：提交一段文字，服务端离线合成音频后走同一条播报链路。

功能与 `lingshen-core` 完全一致，只有 TTS 引擎不同：本版本使用**旧版讯飞离线 SDK（MSC 5.0.44）**，
沿用旧系统 `ls20_tts_xf_linux` 的 `libmsc.so` 与 `xiaoyan.jet / xiaofeng.jet` 资源。

## 与旧版系统的关系

旧版 `ls22-linux` 需要 4 个进程 + RethinkDB（源码编译）+ ffmpeg + lame，全部功能耦合在一起。
本项目只保留「即时播报」这一条链路，因此 **RTSP 推流、采集器、ffmpeg、文件服务器、RethinkDB 全部不需要**：

| 旧版组件 | 新版 |
|---|---|
| `mgrserver`（业务 + MQTT Broker + Web） | 本服务（NestJS 单进程） |
| `rethinkdb` | 无（状态全在内存） |
| `resserver`（HTTP 文件 + RTSP） | 本服务内置静态文件服务 |
| `collector` + `player` + `ffmpeg` + ALSA | 不需要 |
| `tts_xf.sh` + 讯飞离线 SDK + `lame` | 本服务内置 `xf-tts`（C 封装，直接调讯飞 MSC）+ 纯 JS 编码 MP3 |

部署形态：**1 个进程、2 个端口、无外部依赖**；唯一需要在目标机（或同架构机器）上做的一次编译是 TTS 引擎封装 `xf-tts`（`npm run tts:build`，只依赖 gcc，约 1 秒）。

## 快速开始（开发机）

```bash
npm install
cp config.example.json config.json   # Windows: copy config.example.json config.json
npm run build
npm start
```

> 本项目用 **npm** 管理依赖（打包脚本也走 npm）。若用 pnpm 12+，需先执行一次 `pnpm approve-builds` 放行 `@nestjs/core` 的构建脚本，否则 pnpm 会以 `ERR_PNPM_IGNORED_BUILDS` 中断（依赖实际已装好，不影响使用）。

启动后：

- `http://localhost:18080/` 接口索引
- `http://localhost:18080/api/health` 健康检查

## 配置

`config.json` 全部字段见 `config.example.json`，常用项：

| 字段 | 说明 |
|---|---|
| `server.httpPort` | HTTP 端口，默认 18080 |
| `server.publicBaseUrl` | **设备访问本机的地址**，如 `http://192.168.1.10:18080`。留空则按请求 host 推断 |
| `mqtt.port` | 内嵌 MQTT Broker 端口，默认 21883（与旧系统一致，设备不用改配置） |
| `vendor.code` | 厂商编号，默认 `ls20` |
| `vendor.topicMode` | 下行主题规则。`mgrserver`（默认，对齐原厂实现）或 `simple` |
| `media.dir` | 音频文件目录 |

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/play` | 即时播报 |
| POST | `/api/stop` | 停止 |
| POST | `/api/volume` | 调音量（任务音量，影响当前任务） |
| POST | `/api/mute` | 设备静音（整机，盖掉所有播放） |
| POST | `/api/unmute` | 取消设备静音 |
| POST | `/api/media` | 上传音频（multipart，字段名 `file`，支持 mp3/wav/aac/m4a/ogg/flac） |
| GET | `/api/media` | 媒体列表 |
| DELETE | `/api/media/:name` | 删除音频 |
| GET | `/api/devices` | 设备列表与在线状态 |
| GET | `/api/devices/connections` | 当前 MQTT 连接（联调用） |
| GET | `/api/tasks` | 本服务当前下发的任务 |
| POST | `/api/tts/play` | 文字转语音并即时播报 |
| POST | `/api/tts` | 只合成不播报，返回音频地址 |
| GET | `/api/tts/status` | TTS 引擎与缓存状态 |
| GET | `/api/tts/voices` | 可用音色 |

### 播报示例

```bash
# 播放媒体库里已有的文件
curl -X POST http://127.0.0.1:18080/api/play \
  -H 'Content-Type: application/json' \
  -d '{"sns":["0201A9ADAA05"],"media":"alarm.mp3","vol":60,"count":1}'

# 播放任意可访问的地址
curl -X POST http://127.0.0.1:18080/api/play \
  -H 'Content-Type: application/json' \
  -d '{"sns":["0201A9ADAA05"],"url":"http://192.168.1.10:18080/media/alarm.mp3","vol":80}'

# 停止
curl -X POST http://127.0.0.1:18080/api/stop \
  -H 'Content-Type: application/json' -d '{"sns":["0201A9ADAA05"]}'

# 静音 / 取消静音
curl -X POST http://127.0.0.1:18080/api/mute \
  -H 'Content-Type: application/json' -d '{"sns":["0201A9ADAA05"]}'
curl -X POST http://127.0.0.1:18080/api/unmute \
  -H 'Content-Type: application/json' -d '{"sns":["0201A9ADAA05"]}'
```

> 音量是两层的：`实际音量 = 任务音量 × (设备音量 / 100)`。`/api/volume` 改的是任务音量。

`sns` 支持 `0201A9ADAA05`、`ls20:0201A9ADAA05`、`ls20://0201A9ADAA05` 三种写法。

## 文字转语音（TTS）

完全离线，不依赖任何云服务。引擎是**旧版讯飞离线 SDK（MSC 5.0.44）**，与旧系统 `resserver` 用的是同一套
`libmsc.so` + `xiaoyan.jet / xiaofeng.jet`；区别是把 `tts` 与 `lame` 两个外部程序换成
`xf-tts`（本仓库 `native/` 下的 C 代码，直接调 MSC 接口）+ 纯 JS MP3 编码。

TTS 只负责「产出音频文件」，播报仍走上面同一条 `priority_task_play` 链路，**设备侧协议无任何改动**。

```
POST /api/tts/play { text, sns }
      │
      ├─ 文本归一化：数字/单位/日期转口语（3号库房 25.5℃ → 三号库房 二十五点五摄氏度）
      ├─ 按标点切段（默认 ≤100 字/段，一段一个 URL，设备顺序播放）
      ├─ xf-tts 子进程：MSPLogin → QTTSSessionBegin → QTTSTextPut → QTTSAudioGet → 写 WAV
      ├─ 重采样到 16kHz + 纯 JS 编码 MP3（不需要 ffmpeg / lame）
      ├─ 哈希命名落盘，命中缓存直接跳过合成
      └─ 复用 PlaybackService 下发
```

### 目录结构

SDK 与引擎**不进 `node_modules`**，单独放在 `tts.root` 下，布局与旧系统 `ls20_tts_xf_linux` 一致：

```
tts/
  bin/xf-tts                        # 本仓库 native/ 编译产物
  lib/libmsc.so                     # 讯飞 MSC 5.0.44 动态库
  msc/                              # MSC 工作目录（tts.workDir，默认即 tts.root）
    msc.cfg                         # MSC 日志配置
    res/tts/
      common.jet                    # 通用资源
      xiaoyan.jet                   # 女声
      xiaofeng.jet                  # 男声
    *.log / *.ldata                 # 运行时生成，可随时删
  cache/                            # 合成产物，静态挂载到 /tts
```

> MSC 把日志与授权缓存写到 `<workDir>/msc/`，所以 `msc/res/tts` 与日志同目录。
> 资源路径在合成时按绝对路径传给 SDK，不依赖进程 cwd。

### 准备 SDK 与编译引擎（Linux x64）

旧 SDK 不联网下载，从旧系统目录复制即可。默认取本仓库同级的
`../ls22-linux_2026-04-07/ls22-linux/resserver/ls20_tts_xf_linux`：

```bash
npm run tts:setup                                          # 复制 libmsc.so 与 msc/res/tts/*.jet 到 runtime/tts
npm run tts:setup -- --from=/path/to/ls20_tts_xf_linux     # 指定其他目录
XF_SDK_DIR=/path/to/ls20_tts_xf_linux npm run tts:setup    # 或走环境变量
```

然后编译引擎封装（需要 gcc + make）：

```bash
npm run tts:build     # make -C native，产出 runtime/tts/bin/xf-tts
npm run tts:check     # ldd 依赖 + xf-tts --help
```

复制内容（约 10 MB）：

| 文件 | 大小 | 用途 |
|---|---|---|
| `libmsc.so` | 6.0 MB | 讯飞 MSC 5.0.44 动态库 |
| `msc/res/tts/common.jet` | 4.1 MB | 通用资源 |
| `msc/res/tts/xiaoyan.jet` | 3.9 MB | 女声 |
| `msc/res/tts/xiaofeng.jet` | 1.3 MB | 男声 |

要求 **Linux x64 + gcc**；`libmsc.so` 最高只依赖 `GLIBC_2.15`，麒麟 V10 / CentOS 7+ 均可。
旧目录里的 `*.log`、`*.logcache`、`*.ldata` 缓存不会被复制。

`runtime/tts/` 已在 `.gitignore` 中，不会进版本库。开发机本地调试时把 `config.json` 的 `tts.root` 设为 `./runtime/tts`。
**Windows 上只能执行 `tts:setup` 准备文件**：没有 Windows 版旧 SDK，`tts:build` 与合成必须在 Linux 上做。

### 打包与安装

```bash
npm run pack:offline        # 生成 release/lingsheng-core-xf-<ver>.tar.gz，内含 tts/
```

目标机：

```bash
tar xzf lingsheng-core-xf-<ver>.tar.gz -C /tmp/pack
sh /tmp/pack/deploy/install.sh
```

`install.sh` 会把 `tts/` 复制到 `/opt/lingshen/tts`、补执行位、创建 `cache/`，并把新生成的 `config.json` 里 `tts.root` 改成绝对路径（升级场景也会自动纠正相对路径）。

> 没执行 `tts:setup` / `tts:build` 时，打包仍会成功，`install.sh` 打印缺少引擎的提示，TTS 接口返回 503，原有播报功能不受影响。

### 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `tts.enabled` | `true` | 关闭后 TTS 接口返回 503，不影响 `/api/play` |
| `tts.root` | `./tts` | 引擎、SDK 资源、缓存根目录（相对路径按进程工作目录解析） |
| `tts.bin` | 空 | 引擎路径，留空用 `<root>/bin/xf-tts`（相对路径按进程工作目录解析） |
| `tts.appId` | `5ff40276` | 讯飞 MSC appid，必须与 jet 资源授权一致，否则报 11200 |
| `tts.workDir` | 空 | MSC 工作目录，留空用 `tts.root`；相对路径按 `tts.root` 解析 |
| `tts.voices` | 女声 + 男声 | `{id,label,jet}`，`jet` 对应 `<workDir>/msc/res/tts/<jet>.jet`，同时作为 `voice_name` |
| `tts.defaultVoice` | `female` | 默认音色 id，留空取第一个 |
| `tts.volume` | `50` | 默认合成音量 0-100 |
| `tts.pitch` | `50` | 默认音调 0-100 |
| `tts.format` | `mp3` | `mp3` 或 `wav`；mp3 对齐旧系统真机验证过的 16kHz 单声道 |
| `tts.sampleRate` | `16000` | 输出采样率，`0` 表示保持引擎原始采样率 |
| `tts.bitrateKbps` | `32` | MP3 码率 |
| `tts.maxChars` | `300` | 单次请求文本上限，超出返回 400 |
| `tts.segmentChars` | `100` | 切段长度，一段一个 URL |
| `tts.concurrency` | `1` | 并发合成数。每段是一个 MSC 进程，建议保持 1 |
| `tts.maxQueue` | `20` | 排队上限，超出返回 503 |
| `tts.timeoutMs` | `30000` | 单段合成超时，超时 kill 子进程 |
| `tts.cacheTtlHours` | `168` | 产物保留时长（小时） |
| `tts.cacheMaxMb` | `500` | 产物总容量上限，超出按最旧优先淘汰 |

### 音色

旧 SDK 只带两套音色资源，一个 `.jet` 就是一个音色：

| id | label | jet | 说明 |
|---|---|---|---|
| `female` | 女声（小燕） | `xiaoyan` | 默认音色 |
| `male` | 男声（小峰） | `xiaofeng` | 默认男声 |

配置示例：

```json
"tts": {
  "appId": "5ff40276",
  "voices": [
    { "id": "female", "label": "女声（小燕）", "jet": "xiaoyan" },
    { "id": "male", "label": "男声（小峰）", "jet": "xiaofeng" }
  ],
  "defaultVoice": "female",
  "volume": 50,
  "pitch": 50
}
```

新增音色 = 把 `xxx.jet` 放进 `tts/msc/res/tts/`，再在 `tts.voices` 里加一项
`{ "id": "xxx", "label": "…", "jet": "xxx" }`。**音色资源必须与 `tts.appId` 的授权匹配**，
未授权的 jet 会在合成时返回 `11200`。

**调用**

```bash
curl http://127.0.0.1:18080/api/tts/voices          # 列出音色与可用状态
curl -X POST http://127.0.0.1:18080/api/tts/play \
  -H 'Content-Type: application/json' \
  -d '{"text":"请注意，三号库房温度异常","voice":"male","sns":["0201A9ADAA05"]}'
```

- 不传 `voice` 用 `tts.defaultVoice`（留空取第一个）；
- `speed` / `volume` / `pitch` 均为 0-100，50 为正常，缺省走配置；
- 音色、参数、文本任意一项不同，都是不同的缓存文件，互不覆盖；
- 单段合成默认 30 秒超时（`tts.timeoutMs`），超时会 kill 子进程并返回 503。

### 手动排查

先确认引擎本身能出声（不经过服务）：

```bash
cd /opt/lingshen/tts
printf '三号库房温度异常，请及时处理。' > /tmp/t.txt
LD_LIBRARY_PATH=lib ./bin/xf-tts \
  --text-file /tmp/t.txt --output /tmp/t.wav \
  --appid 5ff40276 \
  --work-dir /opt/lingshen/tts \
  --res-dir /opt/lingshen/tts/msc/res/tts \
  --voice xiaoyan --speed 50 --volume 50 --pitch 50
```

排查路径问题时加 `--verbose`，会打印实际 cwd、work_dir、传给 MSC 的资源路径以及每次 `QTTSAudioGet` 的返回值：

```bash
LD_LIBRARY_PATH=lib ./bin/xf-tts ... --verbose
```

| 现象 | 排查方向 |
|---|---|
| `MSPLogin failed` / `11200` | `tts.appId` 与 jet 授权不匹配。注意日志里的 `read auth file failed err=11200` 是非致命警告，合成成功可忽略 |
| `QTTSSessionBegin failed` / `10105` | `--work-dir`、`--res-dir` 路径不对，或 jet 文件缺失 |
| `合成结果为空` | MSC 只认「相对 `<work-dir>/msc`」的资源路径。`xf-tts` 已自动把 `--res-dir` 转成 `res/tts/xxx.jet`，若仍为空，用 `--verbose` 看实际 cwd/res，并确认 `msc/res/tts` 下确实有 jet |
| `缺少音色资源` | `msc/res/tts/<jet>.jet` 没复制过来，重新 `npm run tts:setup` |
| `libmsc.so: cannot open shared object file` | 用 `--bin` 指定了别处的 `xf-tts`，导致 `$ORIGIN/../lib` 失效；保持默认布局或补 `LD_LIBRARY_PATH` |
| 合成很慢 | 每次合成都会加载 jet 资源；确认 `tts.concurrency` 为 1，避免多进程抢 CPU |

详细日志在 `tts/msc/msc.log`、`tts/msc/tts_local.log`，可用 `tts/msc/msc.cfg` 调整级别。

### 调用示例

```bash
# 文字转语音 + 播报
curl -X POST http://127.0.0.1:18080/api/tts/play \
  -H 'Content-Type: application/json' \
  -d '{"text":"3号库房温度25.5℃，请及时处理","sns":["0201A9ADAA05"],"vol":70}'

# 只合成，拿到 URL 自行使用
curl -X POST http://127.0.0.1:18080/api/tts \
  -H 'Content-Type: application/json' \
  -d '{"text":"请注意，测试开始","speed":60}'

# 引擎状态（排查首选）
curl http://127.0.0.1:18080/api/tts/status
```

`/api/tts/play` 返回：

```json
{
  "code": 0,
  "tid": "1762..._1",
  "segments": 1,
  "urls": [{ "name": "tts_3e5a19a2b535e034.mp3", "uri": "http://192.168.1.10:18080/tts/tts_3e5a19a2b535e034.mp3" }],
  "cached": false,
  "synthMs": 820,
  "results": [{ "sn": "0201A9ADAA05", "topic": "...", "ok": true }]
}
```

### 文本归一化

送合成前会先做口语化处理，规则在 `src/tts/text/text-normalize.ts`。讯飞引擎本身也能读数字，
保留这一层是为了让单位、日期、百分号的读法在所有音色下保持一致：

| 输入 | 输出 |
|---|---|
| `25.5℃` | `二十五点五摄氏度` |
| `60%` | `百分之六十` |
| `5m/s` | `五米每秒` |
| `2026-11-04 08:30` | `二零二六年十一月四日八点三十分` |
| `13800138000` | `一三八零零一三八零零零`（7 位以上逐位读） |
| `1005` | `一千零五` |
| `3~5层` | `三到五层` |
| `-5℃` | `零下五摄氏度` |

**多音字**：讯飞引擎自带分词与多音字词典（「重庆」「银行」等按上下文读），一般不需要额外处理。若某个专有名词读错，可在调用前自行改写成同音字或加空格分隔。

## 设备协议（已真机验证）

主题（以实测设备 `020292EB68C3` 为例）：

```
下行   ls20://ls20://020292EB68C3/req      ← 注意是两层 ls20://
上行   ls20/request
遗嘱   ls20/will                          （设备掉线通知，op=offline）
回包   ls20://ls20://020292EB68C3/resp     （报文里的 source 字段）
```

原因是设备上报的 `sn` 本身带前缀（`ls20://020292EB68C3`），原厂用 `sn.split(":")[0] + "://" + sn + "/req"` 拼接，于是成了两层。
本项目内部统一用裸 SN，拼主题时由 `vendor.topicMode` 控制：

| topicMode | 生成的主题 |
|---|---|
| `double`（默认，原厂一致） | `ls20://ls20://<SN>/req` |
| `simple` | `ls20://<SN>/req` |
| `vendor-colon` | `ls20://ls20:<SN>/req` |

本服务实现的操作：

| op | 方向 | 说明 |
|---|---|---|
| `devLogin` | 设备 → 服务 | 设备上线，服务回应答完成注册 |
| `priority_task_play` | 服务 → 设备 | `type=5`，`urls[].uri` 为 HTTP 文件地址 |
| `priority_task_stop` | 服务 → 设备 | 停止任务（`tid` + `tname`） |
| `priority_task_setvol` | 服务 → 设备 | 调整音量 |
| `task_started` / `task_finished` | 设备 → 服务 | 设备自动上报，播完无需轮询 |

实际下发的播放报文（实测原样）：

```json
{
  "type": "req",
  "app": "ls20",
  "name": "priority_task_play",
  "source": "noreplay",
  "params": {
    "count": 1, "length": 0, "level": 99999, "name": "实时播放",
    "tid": "16_20_02_188", "vol": 60, "type": 5, "uid": "<用户id>",
    "urls": [{ "name": "a.mp3", "uri": "http://30.0.16.48:10008/tts/xxx.mp3" }]
  },
  "callid": 0
}
```

`devLogin` 应答字段结构见 `src/devices/devices.service.ts` 的 `buildLoginAck()`，取自实测报文，只把 `resserver_urls` 的 IP/端口换成本服务地址。

## 抓包工具（排查用）

协议已于 2026-11-04 用真机抓包确认。后续如果遇到"设备收不到指令""应答不对"之类的问题，可以再抓一次对比。

工具只订阅、不发送，不影响现有业务。包内自带 Node 运行时，目标机**不需要安装 Node**：

```bash
tar -xzf lingsheng-core-xf-0.1.0.tar.gz -C /tmp/ls
cd /tmp/ls
sh capture.sh --host 127.0.0.1 --port 21883
```

`capture.sh` 会自动给包内 `node/bin/node` 补执行位（从 Windows 打包过来没有执行权限）。

然后依次：让音柱重新登录 → 在旧控制台点一次即时播放 → 点停止 → `Ctrl+C`。
当前目录会生成 `capture-<时间>.log`，里面同时包含 `devLogin` 上行报文、服务端应答、以及 `priority_task_play` 的完整参数，据此核对 `topicMode` 与应答字段即可。

> 开发机上已装 Node 时，也可以直接 `node tools/capture.mjs --host 127.0.0.1 --port 21883`。

## 离线部署（麒麟 V10 x86_64）

```bash
npm ci
npm run tts:setup           # 首次或更换 SDK 时：复制 libmsc.so 与 jet 资源
npm run tts:build           # 编译 xf-tts（需要 gcc）
npm run build
npm run pack:offline        # 生成 release/lingsheng-core-xf-<ver>.tar.gz
```

把 `runtime/node-linux-x64` 放好可随包携带 Node 运行时（可选）。到目标机：

```bash
tar -xzf lingsheng-core-xf-0.1.0.tar.gz -C /tmp/pack
sh /tmp/pack/deploy/install.sh
systemctl start lingshen-core
```

`install.sh` 只做安装与配置，**不会自动启动服务**。安装内容：程序复制到 `/opt/lingshen`、生成 `config.json`（自动填入本机 IP）、安装 systemd 服务、放行端口。
