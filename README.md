# lingsheng-core-xf

[![License](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)
[![NestJS](https://img.shields.io/badge/NestJS-10-ea2845.svg)](https://nestjs.com)
[![Platform](https://img.shields.io/badge/platform-linux--x64-blue.svg)](#8-部署)

> 菱声 LS20/LS22 音柱控制服务（讯飞离线 TTS 版）。一个 Node 进程同时提供 HTTP 接口、内嵌 MQTT Broker 和静态文件服务，直接对音柱下发播放指令。

## 功能一览

| 能力 | 说明 |
|---|---|
| **即时播报** | 调接口让一台或多台音柱播放指定音频（媒体库文件或任意可访问 URL） |
| **文字转语音** | 提交文字，服务端离线合成为音频后走同一条播报链路 |
| **设备管理** | 内置 MQTT Broker 接收设备登录，维护注册表与在线状态 |
| **媒体库** | 音频上传 / 列表 / 删除，随服务一并提供静态下载 |

| 环境 | 要求 |
|---|---|
| 运行时 | Node.js ≥ 18 |
| 系统 | Linux x64（麒麟 V10 / CentOS 7+）；Windows 可开发，仅 TTS 不可用 |
| 端口 | `18080`（HTTP）、`21883`（MQTT） |

## 目录

| 章节 | 内容 |
|---|---|
| [1. 整体结构](#1-整体结构) | 进程架构、与厂家版本的对应关系 |
| [2. 目录结构](#2-目录结构) | 源码目录说明 |
| [3. 配置](#3-配置) | `config.json` 字段与环境变量 |
| [4. 接口](#4-接口) | HTTP 接口一览与调用示例 |
| [5. 文字转语音（TTS）](#5-文字转语音tts) | 离线合成流程、SDK 准备、排查 |
| [6. 设备协议](#6-设备协议) | MQTT 主题、报文与抓包工具 |
| [7. 快速开始](#7-快速开始) | 本地跑起来 |
| [8. 部署](#8-部署) | 离线打包、安装与运维 |
| [9. 许可证](#9-许可证) | MIT |

## 1. 整体结构

```text
                 HTTP API :18080                   MQTT :21883
   外部系统 ──────────►┌──────────────────────────────────────┐◄────── 音柱设备
   浏览器/设备 ◄───────│  NestJS 单进程                        │
     (下载音频)        │  ├ PlaybackService  下发播放/停止/音量  │
                       │  ├ DevicesService   注册表 + 登录应答  │
                       │  ├ TtsService       归一化/切段/合成   │
                       │  └ MediaService     媒体库 + 静态挂载  │
                       └──────────────────────────────────────┘
```

所有状态都在内存里，没有数据库、没有 RTSP、没有 ffmpeg/lame、没有外部中间件。

与厂家提供的 `ls22-linux` 的对应关系：

| 厂家版本组件 | 本项目 |
|---|---|
| `mgrserver`（业务 + MQTT Broker + Web） | 本服务（HTTP + aedes Broker） |
| `resserver`（HTTP 文件 + RTSP） | 内置静态文件服务（`/media`、`/tts`） |
| `rethinkdb` | 无，状态全在内存 |
| `collector` / `player` / `ffmpeg` / ALSA | 不需要，设备自己下载播放 |
| `tts_xf.sh` + 讯飞 SDK + `lame` | 内置 `xf-tts`（C 封装）+ 纯 JS MP3 编码 |

## 2. 目录结构

```text
src/
  main.ts                  启动、静态目录挂载
  config/config.ts         配置加载与路径解析
  mqtt/                    内嵌 aedes Broker
  devices/                 设备注册表、devLogin 应答
  playback/                播放/停止/音量/静音下发
  media/                   媒体库上传、列表、删除
  tts/                     合成、缓存、文本归一化、MP3 编码
  protocol/                主题规则与报文封装
native/                    xf-tts 的 C 源码与 Makefile
tools/                     SDK 准备脚本、抓包工具
deploy/                    离线打包与安装脚本
```

## 3. 配置

服务直接读取进程工作目录下的 `config.json`，缺失字段使用内置默认值（文件不存在时全部走默认值）。全部字段见 `config.example.json`，常用项：

| 字段 | 默认 | 说明 |
|---|---|---|
| `server.httpPort` | `18080` | HTTP 端口 |
| `server.publicBaseUrl` | 空 | **设备访问本机的地址**，如 `http://192.168.1.10:18080`；留空按请求 host 推断；配置的 IP 已不属于本机网卡时，启动会自动换成当前网卡 IP |
| `mqtt.port` | `21883` | 内嵌 Broker 端口，与厂家版本一致，设备不用改配置 |
| `mqtt.username/password` | 空 | 留空表示免认证 |
| `vendor.code` | `ls20` | 厂商编号，参与主题与报文 `app` 字段 |
| `vendor.topicMode` | `double` | 下行主题规则，见第 6 节 |
| `media.dir` | `./media` | 音频目录，挂载到 `/media` |
| `media.maxSizeMb` | `100` | 上传大小上限 |
| `playback.defaultVol` | `60` | 默认任务音量 0-100 |
| `playback.defaultLevel` | `99999` | 默认优先级 |
| `device.offlineTimeoutSec` | `180` | 超过该时长无上报判定离线 |
| `tts.*` | 见第 5.5 节 | 语音合成相关 |

> `server.publicBaseUrl` 里的 IP 会跟着本机网卡走：
>
> - 启动时检查一次，之后每次下发播放/合成地址（10 秒缓存）都会再确认。IP 不属于本机网卡（换网段、DHCP 重新分配等）就换成当前网卡 IP，日志打印告警，例如
>   `server.publicBaseUrl 配置的是 http://192.168.3.93:18080，该 IP 不属于本机网卡，已改用 http://192.168.3.94:18080`
> - 开机时网卡还没拿到地址，会先沿用配置值并告警，网卡就绪后自动切换，不需要改配置或重启
> - 只处理 IPv4 字面量，域名、IPv6、空值保持原样

也可用环境变量覆盖（优先级高于 `config.json`）：

`LINGSHEN_CONFIG`（配置文件路径）、`LINGSHEN_HTTP_PORT`、`LINGSHEN_MQTT_PORT`、`LINGSHEN_PUBLIC_BASE_URL`、`LINGSHEN_MEDIA_DIR`、`LINGSHEN_TTS_ROOT`、`LINGSHEN_TTS_BIN`、`LINGSHEN_TTS_APP_ID`、`LINGSHEN_TTS_WORK_DIR`、`LINGSHEN_TTS_ENABLED`。

## 4. 接口

### 4.1 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 接口索引 |
| GET | `/api/health` | 健康检查 |
| POST | `/api/play` | 即时播报 |
| POST | `/api/stop` | 停止播报 |
| POST | `/api/volume` | 调整任务音量 |
| POST | `/api/mute` | 设备整机静音 |
| POST | `/api/unmute` | 取消设备静音 |
| POST | `/api/media` | 上传音频（multipart，字段 `file`） |
| GET | `/api/media` | 媒体列表 |
| DELETE | `/api/media/:name` | 删除音频 |
| POST | `/api/tts/play` | 合成并播报 |
| POST | `/api/tts` | 只合成，返回音频地址 |
| GET | `/api/tts/status` | 引擎、队列、缓存状态 |
| GET | `/api/tts/voices` | 可用音色 |
| GET | `/api/devices` | 设备列表与在线状态 |
| GET | `/api/devices/connections` | 当前 MQTT 连接（联调用） |
| GET | `/api/devices/:sn` | 单台设备详情 |
| GET | `/api/tasks` | 本服务当前下发的任务 |

`sns` 支持三种写法：`0202****0H6R`、`ls20:0202****0H6R`、`ls20://0202****0H6R`，服务内部统一转成裸 SN。

### 4.2 播报

```bash
# 播放媒体库文件
curl -X POST http://127.0.0.1:18080/api/play \
  -H 'Content-Type: application/json' \
  -d '{"sns":["0202****0H6R"],"media":"alarm.mp3","vol":60,"count":1}'

# 播放任意可访问地址
curl -X POST http://127.0.0.1:18080/api/play \
  -H 'Content-Type: application/json' \
  -d '{"sns":["0202****0H6R"],"url":"http://192.168.1.10:18080/media/alarm.mp3","vol":80}'
```

请求字段：

| 字段 | 说明 |
|---|---|
| `sns` | 必填，设备 SN 数组 |
| `media` / `url` | 二选一。`media` 是媒体库文件名，`url` 可为绝对地址或站内相对路径 |
| `vol` | 任务音量 0-100，默认 `playback.defaultVol` |
| `level` | 优先级，默认 `99999` |
| `count` | 播放次数，默认 1 |
| `length` | 播放时长（秒），0 表示整段播完 |
| `name` | 任务名，设备端显示 |
| `tid` | 自定义任务 ID，留空自动生成 |
| `baseUrl` | 覆盖本次下发给设备的文件根地址 |

返回 `code`、`tid`、`uri`，以及每台设备的下发结果 `results[{sn,topic,ok,error?}]`。

### 4.3 停止 / 音量 / 静音

```bash
# 停止（不传 tid 时按本服务记录的任务停止）
curl -X POST http://127.0.0.1:18080/api/stop \
  -H 'Content-Type: application/json' -d '{"sns":["0202****0H6R"]}'

# 任务音量
curl -X POST http://127.0.0.1:18080/api/volume \
  -H 'Content-Type: application/json' -d '{"sns":["0202****0H6R"],"vol":40}'

# 设备整机静音 / 取消
curl -X POST http://127.0.0.1:18080/api/mute   -H 'Content-Type: application/json' -d '{"sns":["0202****0H6R"]}'
curl -X POST http://127.0.0.1:18080/api/unmute -H 'Content-Type: application/json' -d '{"sns":["0202****0H6R"]}'
```

音量分两层：**实际音量 = 任务音量 × 设备音量 / 100**。`/api/volume` 改的是任务音量；静音是设备整机行为，会盖掉所有正在播放的内容。

`/api/tasks` 只能看到本进程下发过的任务，服务重启后为空，此时 `/api/stop` 需显式传 `tid`。

### 4.4 媒体库

```bash
curl -F 'file=@alarm.mp3' http://127.0.0.1:18080/api/media   # 上传
curl http://127.0.0.1:18080/api/media                        # 列表
curl -X DELETE http://127.0.0.1:18080/api/media/alarm.mp3    # 删除
```

支持 `mp3/wav/aac/m4a/ogg/flac`。上传时文件名会被改成 ASCII 安全字符（中文/空格替换为 `_`），重名自动追加序号，避免音柱固件对编码支持不一致。

## 5. 文字转语音（TTS）

完全离线，不依赖云服务。引擎是厂家提供的讯飞离线 SDK（MSC 5.0.44），沿用 `ls22-linux` 中 `ls20_tts_xf_linux` 的 `libmsc.so` 与 jet 资源。**仅支持 Linux x64**，Windows 上只能准备文件、无法合成。

### 5.1 处理流程

```text
POST /api/tts/play { text, sns }
   ├─ 文本归一化：数字/单位/日期转口语（3号库房 25.5℃ → 三号库房 二十五点五摄氏度）
   ├─ 按标点切段（默认 ≤100 字/段，一段一个 URL，设备顺序播放）
   ├─ 起 xf-tts 子进程：MSPLogin → QTTSSessionBegin → QTTSTextPut → QTTSAudioGet → 写 WAV
   ├─ 重采样到 16kHz + 纯 JS 编码 MP3（无需 ffmpeg / lame）
   ├─ 按参数哈希命名落盘，命中缓存直接复用
   └─ 复用 PlaybackService 下发 priority_task_play
```

TTS 只负责产出音频文件，设备侧协议没有任何改动。

### 5.2 目录布局

SDK 与引擎不进 `node_modules`，单独放在 `tts.root` 下：

```text
tts/                            # 开发机为 runtime/tts，安装后为 /opt/lingshen/tts
  bin/xf-tts                    # native/ 的编译产物
  lib/libmsc.so                 # 讯飞 MSC 5.0.44
  msc/                          # MSC 工作目录（tts.workDir）
    msc.cfg                     # 日志配置
    res/tts/
      common.jet                # 通用资源
      xiaoyan.jet               # 女声
      xiaofeng.jet              # 男声
  cache/                        # 合成产物，挂载到 /tts
```

MSC 把日志与授权缓存写到 `<workDir>/msc/`，所以 `msc/res/tts` 与日志同目录。源目录里的 `*.log`、`*.logcache`、`*.ldata` 不会复制。

### 5.3 准备 SDK 并编译引擎

```bash
npm run tts:setup                                        # 从同级的 ls22-linux 目录复制
npm run tts:setup -- --from=/path/to/ls20_tts_xf_linux   # 或指定目录
XF_SDK_DIR=/path/to/ls20_tts_xf_linux npm run tts:setup  # 或走环境变量

npm run tts:build     # make -C native，产出 runtime/tts/bin/xf-tts（需要 gcc + make）
npm run tts:check     # ldd 依赖 + xf-tts --help
```

复制内容约 10 MB：`libmsc.so`（6.0 MB）、`common.jet`（4.1 MB）、`xiaoyan.jet`（3.9 MB）、`xiaofeng.jet`（1.3 MB）。

`libmsc.so` 最高只依赖 `GLIBC_2.15`，麒麟 V10 / CentOS 7+ 均可运行。开发机本地调试时把 `config.json` 的 `tts.root` 设为 `./runtime/tts`。

### 5.4 调用

```bash
# 合成并播报
curl -X POST http://127.0.0.1:18080/api/tts/play \
  -H 'Content-Type: application/json' \
  -d '{"text":"3号库房温度25.5℃，请及时处理","sns":["0202****0H6R"],"vol":70}'

# 只合成，拿地址自行使用
curl -X POST http://127.0.0.1:18080/api/tts \
  -H 'Content-Type: application/json' -d '{"text":"请注意，测试开始","speed":60}'

# 音色与引擎状态
curl http://127.0.0.1:18080/api/tts/voices
curl http://127.0.0.1:18080/api/tts/status
```

`/api/tts/play` 返回：

```json
{
  "code": 0,
  "tid": "1762..._1",
  "voice": "female",
  "segments": 1,
  "urls": [{ "name": "tts_3e5a19a2b535e034.mp3", "uri": "http://192.168.1.10:18080/tts/tts_3e5a19a2b535e034.mp3" }],
  "cached": false,
  "synthMs": 820,
  "totalMs": 850,
  "text": "三号库房温度二十五点五摄氏度请及时处理",
  "results": [{ "sn": "0202****0H6R", "topic": "ls20://ls20://0202****0H6R/req", "ok": true }]
}
```

- `voice` 留空用 `tts.defaultVoice`；`speed` / `volume` / `pitch` 均为 0-100，50 为正常，缺省走配置。
- 音色、参数、文本任意一项不同都算不同缓存文件，互不覆盖。
- 文本超过 `tts.maxChars`（默认 300）返回 400；队列满或引擎不可用返回 503。

### 5.5 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `tts.enabled` | `true` | 关闭后 TTS 接口返回 503，不影响 `/api/play` |
| `tts.root` | `./tts` | 引擎、SDK 资源、缓存根目录（相对路径按进程工作目录解析） |
| `tts.bin` | 空 | 引擎路径，留空用 `<root>/bin/xf-tts` |
| `tts.appId` | `5ff40276` | MSC appid，必须与 jet 资源授权一致，否则报 11200 |
| `tts.workDir` | 空 | MSC 工作目录，留空用 `tts.root`；相对路径按 `tts.root` 解析 |
| `tts.voices` | 女声 + 男声 | `{id,label,jet}`，`jet` 对应 `<workDir>/msc/res/tts/<jet>.jet` |
| `tts.defaultVoice` | `female` | 默认音色 id，留空取第一个 |
| `tts.volume` / `tts.pitch` | `50` | 默认合成音量 / 音调 0-100 |
| `tts.urlPrefix` | `"/tts"` | 产物 URL 前缀，同时作为静态挂载路径 |
| `tts.format` | `mp3` | `mp3` 或 `wav`；mp3 为 16kHz 单声道 |
| `tts.sampleRate` | `16000` | 输出采样率，`0` 表示保持引擎原始采样率 |
| `tts.bitrateKbps` | `32` | MP3 码率 |
| `tts.maxChars` | `300` | 单次请求文本上限 |
| `tts.segmentChars` | `100` | 切段长度，一段一个 URL |
| `tts.concurrency` | `1` | 并发合成数，每段是一个 MSC 进程，建议保持 1 |
| `tts.maxQueue` | `20` | 排队上限 |
| `tts.timeoutMs` | `30000` | 单段合成超时，超时 kill 子进程 |
| `tts.cacheTtlHours` | `168` | 产物保留时长（小时） |
| `tts.cacheMaxMb` | `500` | 产物总容量上限，超出按最旧优先淘汰 |

### 5.6 音色

| id | label | jet |
|---|---|---|
| `female` | 女声（小燕） | `xiaoyan` |
| `male` | 男声（小峰） | `xiaofeng` |

新增音色：把 `xxx.jet` 放进 `tts/msc/res/tts/`，再在 `tts.voices` 加一项 `{ "id": "xxx", "label": "...", "jet": "xxx" }`。音色资源必须与 `tts.appId` 的授权匹配，未授权的 jet 合成时报 `11200`。

### 5.7 文本归一化

规则在 `src/tts/text/text-normalize.ts`。引擎本身能读数字，这一层是为了让单位、日期、百分号的读法在所有音色下保持一致：

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

多音字由引擎自带词典处理（「重庆」「银行」按上下文读）。专有名词读错时，可在调用前改写成同音字或加空格分隔。

### 5.8 TTS 排查

先绕过服务确认引擎本身能出声：

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

加 `--verbose` 可打印实际 cwd、work_dir、传给 MSC 的资源路径以及每次 `QTTSAudioGet` 的返回值。

| 现象 | 排查方向 |
|---|---|
| `MSPLogin failed` / `11200` | `tts.appId` 与 jet 授权不匹配。日志中 `read auth file failed err=11200` 是非致命警告，合成成功可忽略 |
| `QTTSSessionBegin failed` / `10105` | `--work-dir`、`--res-dir` 不对，或 jet 文件缺失 |
| 合成结果为空 | MSC 只认「相对 `<work-dir>/msc`」的资源路径。`xf-tts` 已自动把 `--res-dir` 转成 `res/tts/xxx.jet`，仍为空时用 `--verbose` 确认 |
| `缺少音色资源` | `msc/res/tts/<jet>.jet` 没复制过来，重新 `npm run tts:setup` |
| `libmsc.so: cannot open shared object file` | 用 `tts.bin` 指向了别处的 `xf-tts`，导致 `$ORIGIN/../lib` 失效；保持默认布局或补 `LD_LIBRARY_PATH` |
| 合成很慢 | 每次合成都会加载 jet 资源，确认 `tts.concurrency` 为 1 |

详细日志在 `tts/msc/msc.log`、`tts/msc/tts_local.log`，日志级别在 `tts/msc/msc.cfg` 调整。

## 6. 设备协议

主题：

```text
下行   ls20://ls20://0202****0H6R/req
上行   ls20/request
遗嘱   ls20/will                     （掉线通知，op=offline）
回包   ls20://ls20://0202****0H6R/resp
```

设备上报的 `sn` 本身带前缀（`ls20://0202****0H6R`），厂家的 `mgrserver` 用 `sn.split(":")[0] + "://" + sn + "/req"` 拼接，于是成了两层。本项目内部统一用裸 SN，拼主题时由 `vendor.topicMode` 控制：

| topicMode | 生成的主题 |
|---|---|
| `double`（默认，与厂家实现一致） | `ls20://ls20://0202****0H6R/req` |
| `simple` | `ls20://0202****0H6R/req` |
| `vendor-colon` | `ls20://ls20:0202****0H6R/req` |

支持的操作：

| op | 方向 | 说明 |
|---|---|---|
| `devLogin` | 设备 → 服务 | 设备上线，服务回应答完成注册 |
| `priority_task_play` | 服务 → 设备 | `type=5`，`urls[].uri` 为 HTTP 文件地址 |
| `priority_task_stop` | 服务 → 设备 | 停止任务（`tid` + `tname`） |
| `priority_task_setvol` | 服务 → 设备 | 调整任务音量 |
| `device_mute` / `device_unmute` | 服务 → 设备 | 设备整机静音 / 取消 |
| `task_started` / `task_finished` | 设备 → 服务 | 设备自动上报，播完无需轮询 |

实际下发的播放报文：

```json
{
  "type": "req",
  "app": "ls20",
  "name": "priority_task_play",
  "source": "noreplay",
  "params": {
    "count": 1, "length": 0, "level": 99999, "name": "实时播放",
    "tid": "<任务ID>", "vol": 60, "type": 5, "uid": "<用户ID>",
    "urls": [{ "name": "a.mp3", "uri": "http://<本机IP>:18080/tts/xxx.mp3" }]
  },
  "callid": 0
}
```

`devLogin` 应答结构见 `src/devices/devices.service.ts` 的 `buildLoginAck()`，只把 `resserver_urls` 的 IP/端口换成本服务地址。

### 6.1 抓包工具

只订阅不发送，不影响现有业务。包内自带 Node 运行时，目标机不需要安装 Node：

```bash
tar -xzf lingsheng-core-xf-0.1.0.tar.gz -C /tmp/ls
cd /tmp/ls
sh capture.sh --host 127.0.0.1 --port 21883
```

然后依次：让音柱重新登录 → 触发一次即时播放 → 触发停止 → `Ctrl+C`。当前目录生成 `capture-<时间>.log`，内含 `devLogin` 上行报文、服务端应答和 `priority_task_play` 完整参数。

开发机已装 Node 时也可直接 `node tools/capture.mjs --host 127.0.0.1 --port 21883`。

## 7. 快速开始

```bash
npm install
npm run build
npm start
```

配置直接读项目根目录的 `config.json`（没有该文件时全部使用默认值），字段见第 3 节。

启动后：

- `http://localhost:18080/` — 接口索引
- `http://localhost:18080/api/health` — 健康检查
- 设备端把 MQTT 服务器指向 `<本机IP>:21883` 即可上线

> 依赖用 npm 管理。若用 pnpm 12+，先执行 `pnpm approve-builds` 放行 `@nestjs/core`。

TTS 需要额外的 SDK 与编译步骤，见第 5 节；不准备 TTS 不影响播报功能。

## 8. 部署

适配环境：

| 项 | 说明 |
|---|---|
| 操作系统 | 银河麒麟高级服务器操作系统 V10 SP3 2403 |
| 安装镜像 | `Kylin-Server-V10-SP3-2403-Release-20240426-X86_64.iso` |
| CPU | 海光 C86（x86_64） |

### 8.1 构建打包

在构建机上执行：

```bash
npm ci
npm run tts:setup      # 首次或更换 SDK 时执行
npm run tts:build      # 需要 gcc
npm run pack:offline   # 生成 release/lingsheng-core-xf-<ver>.tar.gz
```

**随包携带 Node 运行时（可选）**

把官方 linux-x64 的 Node 解压到 `runtime/node-linux-x64/`，打包时会放进包内 `node/`：

```bash
mkdir -p runtime/node-linux-x64
curl -fLO https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz
tar -xJf node-v20.18.1-linux-x64.tar.xz -C runtime/node-linux-x64 --strip-components=1
runtime/node-linux-x64/bin/node -v
```

- `--strip-components=1` 去掉压缩包顶层目录，否则路径会多一层，打包脚本找不到 `bin/node`
- 没有外网时先在别的机器下载同一个 `tar.xz` 再拷过来解压；也可直接复制本机已装的 Node：`cp -a /usr/local/node-vXX-linux-x64/. runtime/node-linux-x64/`
- 必须是 linux-x64、版本 ≥ 18（见 `package.json` 的 `engines`），不要用 musl 或 arm64 构建
- 该目录已在 `.gitignore` 中，只进离线包，不进版本库

打包后确认已包含 Node：

```bash
tar -tzf release/lingsheng-core-xf-<ver>.tar.gz | grep 'node/bin/node'
```

不放 Node 时打包仍会成功，安装时提示「目标机需自带 Node 18+」，改用系统 `node`。

未执行 `tts:setup` / `tts:build` 时打包仍会成功，只是 TTS 接口返回 503，播报功能不受影响。

### 8.2 安装

```bash
tar xzf lingsheng-core-xf-<ver>.tar.gz -C /tmp/pack
sh /tmp/pack/deploy/install.sh
```

`install.sh` 只安装不启动，做的事：

- 程序复制到 `/opt/lingshen`，`tts/` 复制到 `/opt/lingshen/tts` 并补执行位、创建 `cache/`
- 选择 Node 运行时：**包内有 `node/bin/node` 就用包内的**（复制到 `/opt/lingshen/node/bin/node`），没有才用系统的 `node`；两者都没有则安装失败。实际使用哪个会在安装日志里打印
- 首次安装生成 `config.json`（自动填入本机 IP 与绝对路径 `tts.root`；升级时也会纠正相对路径）
- 安装 systemd 服务、放行 18080 / 21883 端口、检查端口占用

### 8.3 服务运维

```bash
systemctl start lingshen-core      # 启动
systemctl enable lingshen-core     # 开机自启
systemctl restart lingshen-core    # 改完配置后重启
systemctl status lingshen-core     # 运行状态
journalctl -u lingshen-core -f     # 实时日志
curl http://127.0.0.1:18080/api/health   # 健康检查
```

安装后的路径：

| 内容 | 路径 |
|---|---|
| 程序 | `/opt/lingshen/app` |
| 配置 | `/opt/lingshen/config.json`（systemd 通过 `LINGSHEN_CONFIG` 指定） |
| 媒体库 | `/opt/lingshen/media` |
| TTS 引擎与缓存 | `/opt/lingshen/tts` |
| 启动脚本 | `/opt/lingshen/run.sh` |

## 9. 许可证

本项目采用 [MIT 许可证](LICENSE)，版权所有 (c) 2026 PetrelCode。

```text
MIT License

Copyright (c) 2026 PetrelCode
```

> 注意：`ls22-linux` 目录为设备厂商提供的原始程序与资源（含讯飞 MSC SDK 及其 jet 授权资源），不在本项目 MIT 许可范围内，其使用权仍受厂商与讯飞授权条款约束。
