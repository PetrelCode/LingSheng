#!/usr/bin/env node
/**
 * 从旧版 ls22-linux 的 resserver 目录准备讯飞离线 SDK，落到 runtime/tts/：
 *
 *   runtime/tts/lib/libmsc.so              讯飞 MSC 5.0.44 动态库
 *   runtime/tts/msc/msc.cfg                MSC 日志配置
 *   runtime/tts/msc/res/tts/common.jet     通用资源
 *   runtime/tts/msc/res/tts/xiaoyan.jet    女声
 *   runtime/tts/msc/res/tts/xiaofeng.jet   男声
 *   runtime/tts/bin/xf-tts                 由 native/ 编译产出（npm run tts:build）
 *
 * 只复制 SDK 必需文件：旧目录里的 *.log、*.logcache、ldata 缓存一律跳过。
 *
 * 用法：
 *   node tools/setup-xf.mjs
 *   node tools/setup-xf.mjs --from ../ls22-linux_2026-04-07/ls22-linux/resserver/ls20_tts_xf_linux
 *   XF_SDK_DIR=/opt/old-tts node tools/setup-xf.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TTS_DIR = path.join(ROOT, 'runtime', 'tts');
const LIB_DIR = path.join(TTS_DIR, 'lib');
const MSC_DIR = path.join(TTS_DIR, 'msc');
const RES_DIR = path.join(MSC_DIR, 'res', 'tts');

const DEFAULT_FROM = path.resolve(
  ROOT,
  '..',
  'ls22-linux_2026-04-07',
  'ls22-linux',
  'resserver',
  'ls20_tts_xf_linux',
);

const REQUIRED_JETS = [
  ['common.jet', 3 * 1024 * 1024],
  ['xiaoyan.jet', 3 * 1024 * 1024],
  ['xiaofeng.jet', 1 * 1024 * 1024],
];

const DEFAULT_MSC_CFG = `## iFLYTEK MSC logger config
[logger]
file                             = msc.log
title                            = Mobile Speech Client
level                            = -1
output                           = 1
filter                           = -1
style                            = -1
flush                            = 0
maxsize                          =
overwrite                        = 1
maxfile                          =
cache                            =
`;

function argValue(name) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : '';
}

function human(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function fail(message) {
  console.error(`失败: ${message}`);
  process.exit(1);
}

/** 旧目录里的运行时垃圾：日志、日志游标、以及以 32 位 hash 命名的 ldata 目录 */
function keepEntry(src) {
  const base = path.basename(src);
  if (base.endsWith('.log') || base.endsWith('.logcache')) return false;
  if (/^[0-9a-f]{32}$/i.test(base)) return false;
  return true;
}

function main() {
  const from = path.resolve(argValue('--from') || process.env.XF_SDK_DIR || DEFAULT_FROM);
  console.log(`==> SDK 来源: ${from}`);
  if (!fs.existsSync(from)) {
    fail(
      `找不到旧版 SDK 目录。用 --from=<ls20_tts_xf_linux 绝对路径> 指定，` +
        `或设置环境变量 XF_SDK_DIR`,
    );
  }

  const libSrc = path.join(from, 'libmsc.so');
  if (!fs.existsSync(libSrc)) fail(`缺少 ${libSrc}`);
  const mscSrc = path.join(from, 'msc');
  if (!fs.existsSync(path.join(mscSrc, 'res', 'tts'))) {
    fail(`缺少 ${path.join(mscSrc, 'res', 'tts')}`);
  }

  fs.mkdirSync(LIB_DIR, { recursive: true });
  fs.mkdirSync(path.join(TTS_DIR, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(TTS_DIR, 'cache'), { recursive: true });

  console.log('==> 复制 libmsc.so');
  fs.copyFileSync(libSrc, path.join(LIB_DIR, 'libmsc.so'));
  fs.chmodSync(path.join(LIB_DIR, 'libmsc.so'), 0o644);

  console.log('==> 复制 MSC 资源（跳过日志与授权缓存）');
  fs.cpSync(mscSrc, MSC_DIR, { recursive: true, filter: keepEntry });

  fs.mkdirSync(RES_DIR, { recursive: true });
  if (!fs.existsSync(path.join(MSC_DIR, 'msc.cfg'))) {
    console.log('==> 生成默认 msc.cfg');
    fs.writeFileSync(path.join(MSC_DIR, 'msc.cfg'), DEFAULT_MSC_CFG);
  }

  for (const [name, minSize] of REQUIRED_JETS) {
    const file = path.join(RES_DIR, name);
    if (!fs.existsSync(file)) fail(`缺少资源 ${file}`);
    const size = fs.statSync(file).size;
    if (size < minSize) fail(`资源 ${name} 体积异常（${human(size)}），可能复制不完整`);
    console.log(`    ${name.padEnd(14)} ${human(size)}`);
  }

  const libSize = fs.statSync(path.join(LIB_DIR, 'libmsc.so')).size;
  console.log(`    libmsc.so      ${human(libSize)}`);

  console.log('\n完成。后续步骤（在 Linux x64 目标机上）：');
  console.log('  npm run tts:build        # make -C native，产出 runtime/tts/bin/xf-tts');
  console.log('  npm run tts:check        # 查看动态库依赖与参数说明');
  console.log('  npm run pack:offline     # 打包（自动包含 runtime/tts）');
  console.log('\n开发机本地调试：config.json 把 tts.root 设为 "./runtime/tts"。');
  console.log('libmsc.so 是 Linux x64 动态库，Windows 上只能准备文件，无法编译与合成。');
}

main();
