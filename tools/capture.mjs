#!/usr/bin/env node
/**
 * 协议抓包工具（被动监听，不干扰现有系统）
 *
 * 用法：在运行旧版 mgrserver 的内网机器上执行
 *   node capture.mjs --host 127.0.0.1 --port 21883
 *
 * 原理：以普通 MQTT 客户端身份连上现有的 Broker，订阅全部主题，
 *       因此能同时看到「设备 -> 服务器」和「服务器 -> 设备」两个方向的报文。
 *
 * 抓包时建议按顺序操作：
 *   1. 启动本工具
 *   2. 让音柱断电重启（或等它重新登录），抓 devLogin 上行 + 应答
 *   3. 在旧版 Web 控制台点一次「即时播放」，抓 priority_task_play 下行
 *   4. 点一次「停止」，抓 priority_task_stop
 *   5. Ctrl+C 结束，把生成的 .log 文件带回来
 */
import fs from 'node:fs';
import path from 'node:path';
import mqtt from 'mqtt';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const host = args.host || '127.0.0.1';
const port = Number(args.port || 21883);
const topic = args.topic || '#';
const outFile = path.resolve(
  process.cwd(),
  args.out || `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.log`,
);

const stream = fs.createWriteStream(outFile, { flags: 'a' });
const ts = () => new Date().toISOString();

function log(line) {
  console.log(line);
  stream.write(`${line}\n`);
}

log(`# 开始抓包 ${ts()}`);
log(`# broker=mqtt://${host}:${port} subscribe=${topic}`);
log(`# 输出文件: ${outFile}`);

const client = mqtt.connect(`mqtt://${host}:${port}`, {
  clientId: `lingshen_capture_${Date.now()}`,
  clean: true,
  reconnectPeriod: 2000,
  connectTimeout: 8000,
  username: args.username || undefined,
  password: args.password || undefined,
});

client.on('connect', () => {
  client.subscribe(topic, { qos: 0 }, (err) => {
    if (err) log(`# 订阅失败: ${err.message}`);
    else log(`# 已连接并订阅 ${topic}，等待报文…（Ctrl+C 退出）`);
  });
});

client.on('error', (err) => log(`# 连接错误: ${err.message}`));
client.on('offline', () => log(`# 连接断开，正在重连…`));

client.on('message', (t, payload) => {
  const text = payload.toString('utf8');
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    /* 非 JSON，原样输出 */
  }
  const record = { at: ts(), topic: t, payload: text };
  log(`\n===== ${record.at}  topic=${t} =====`);
  log(pretty);
  fs.appendFileSync(outFile, `${JSON.stringify(record)}\n`);
});

process.on('SIGINT', () => {
  log(`# 结束抓包 ${ts()}`);
  client.end(true, () => process.exit(0));
});
