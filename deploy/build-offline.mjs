#!/usr/bin/env node
/**
 * 生成离线部署包：release/lingsheng-core-xf-<version>.tar.gz
 *
 * 包内结构：
 *   dist/               编译产物
 *   node_modules/       生产依赖（纯 JS，无原生模块，可跨平台拷贝）
 *   tools/              抓包工具 + 讯飞 SDK 准备脚本
 *   native/             xf-tts 的 C 源码与 Makefile（目标机可重新编译）
 *   tts/                可选，xf-tts + libmsc.so + jet 资源（来自 runtime/tts）
 *   node/               可选，随包携带的 linux-x64 Node 运行时
 *   deploy/install.sh   安装脚本
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const releaseDir = path.join(root, 'release');
const archive = path.join(releaseDir, `lingsheng-core-xf-${pkg.version}.tar.gz`);

// 每次构建都用全新的临时目录，避免删除上一次的 node_modules（体积大、容易被安全策略拦截）
const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lingshen-pack-'));
console.log(`==> 暂存目录: ${stageDir}`);

const run = (cmd, cwd = root) => {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

fs.mkdirSync(releaseDir, { recursive: true });

console.log('==> 编译 TypeScript');
// 不依赖 npx：部分最小化 Node 只装了 npm，没有 npx
const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
if (!fs.existsSync(tscBin)) {
  throw new Error(`缺少 TypeScript: ${tscBin}，先执行 npm ci`);
}
run(`"${process.execPath}" "${tscBin}" -p tsconfig.json`);

console.log('==> 复制文件');
fs.cpSync(path.join(root, 'dist'), path.join(stageDir, 'dist'), { recursive: true });
fs.cpSync(path.join(root, 'deploy'), path.join(stageDir, 'deploy'), { recursive: true });
fs.rmSync(path.join(stageDir, 'deploy', 'build-offline.mjs'), { force: true });
fs.copyFileSync(path.join(root, 'package.json'), path.join(stageDir, 'package.json'));
fs.copyFileSync(path.join(root, 'config.example.json'), path.join(stageDir, 'config.example.json'));

console.log('==> 安装生产依赖');
fs.writeFileSync(
  path.join(stageDir, 'package.json'),
  JSON.stringify({ ...pkg, devDependencies: undefined, scripts: { start: 'node dist/main.js' } }, null, 2),
);
try {
  // 优先走离线缓存，避免目标构建机没外网时卡在 registry
  run('npm install --omit=dev --no-audit --no-fund --prefer-offline', stageDir);
} catch {
  console.warn('!! npm install 失败，改为直接复制现有 node_modules（会带上开发依赖）');
  fs.cpSync(path.join(root, 'node_modules'), path.join(stageDir, 'node_modules'), { recursive: true });
}

console.log('==> 复制抓包工具与 SDK 准备脚本');
fs.cpSync(path.join(root, 'tools'), path.join(stageDir, 'tools'), { recursive: true });
fs.copyFileSync(path.join(root, 'capture.sh'), path.join(stageDir, 'capture.sh'));

console.log('==> 复制 xf-tts 源码');
fs.cpSync(path.join(root, 'native'), path.join(stageDir, 'native'), { recursive: true });

// TTS 引擎与 SDK 资源体积大且与平台绑定，单独放 runtime/tts，不进 node_modules
const ttsDir = path.join(root, 'runtime', 'tts');
if (fs.existsSync(path.join(ttsDir, 'bin', 'xf-tts'))) {
  console.log('==> 打入 xf-tts 与讯飞 SDK 资源');
  fs.cpSync(ttsDir, path.join(stageDir, 'tts'), {
    recursive: true,
    filter: (src) => {
      if (src.includes(`${path.sep}.download`)) return false;
      const base = path.basename(src);
      // MSC 运行日志与授权缓存不进包
      if (base.endsWith('.log') || base.endsWith('.logcache')) return false;
      if (/^[0-9a-f]{32}$/i.test(base)) return false;
      return true;
    },
  });
} else {
  console.warn('!! 未找到 runtime/tts/bin/xf-tts，离线包不含文字转语音能力（先执行 npm run tts:setup && npm run tts:build）');
}

const runtime = path.join(root, 'runtime', 'node-linux-x64');
if (fs.existsSync(runtime)) {
  console.log('==> 打入 Node 运行时');
  fs.cpSync(runtime, path.join(stageDir, 'node'), { recursive: true });
} else {
  console.warn('!! 未找到 runtime/node-linux-x64，目标机需自带 Node 18+');
}

console.log('==> 生成 tar.gz');
if (fs.existsSync(archive)) fs.rmSync(archive, { force: true });
execSync(`tar -czf "${archive}" -C "${stageDir}" .`, { stdio: 'inherit' });

console.log(`\n完成: ${archive}`);
