#!/usr/bin/env node
/**
 * 开发模式：构建 → 起静态服务 → 改源码自动重建并刷新页面
 *
 *   npm run dev                   http://127.0.0.1:5173/ ，自动开浏览器
 *   npm run dev -- --port 8080   换端口（被占用会自动顺延）
 *   npm run dev -- --no-open     不自动开浏览器
 *   npm run dev -- --no-watch    只起静态服务，不监听文件
 *
 * 零依赖：只用 node 内置模块；真正的构建仍然交给 build.js，这里只做编排。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WATCH_DIRS = [path.join(ROOT, 'src'), path.join(ROOT, 'data')].filter(d => fs.existsSync(d));

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const OPEN = !has('--no-open');
const WATCH = !has('--no-watch');
const START_PORT = Number(opt('--port', process.env.PORT || 5173));

/* ---------- 构建 ---------- */
function build(label){
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(ROOT, 'build.js')], { stdio: 'inherit' });
  const ok = r.status === 0;
  if (label){
    const ms = Date.now() - t0;
    console.log(ok
      ? `\n✓ ${label} 重建完成（${ms} ms）`
      : `\n✗ ${label} 重建失败，页面保持上一版`);
  }
  if (ok) pushReload();
  return ok;
}

/* ---------- 自动刷新：SSE ---------- */
const clients = new Set();

function pushReload(){
  for (const res of clients){
    try { res.write('data: reload\n\n'); } catch (_){}
  }
}

/* ---------- 静态服务 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

const LIVE_TAG = '<script>/* dev only: 文件改动后自动刷新 */' +
  'new EventSource("/__live").onmessage=function(){location.reload();};</script>';

function injectLive(html){
  if (!WATCH) return html;
  return html.includes('</body>')
    ? html.replace('</body>', LIVE_TAG + '</body>')
    : html + LIVE_TAG;
}

function sendText(res, code, text){
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  /* 自动刷新的长连接 */
  if (url.pathname === '/__live'){
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive'
    });
    res.write('retry: 400\n\n');
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_){} }, 30000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';

  const file = path.join(ROOT, rel);
  /* 防目录穿越：解析后必须仍在项目目录内 */
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)){
    return sendText(res, 403, 'Forbidden');
  }

  let buf;
  try {
    if (!fs.statSync(file).isFile()) throw new Error('not a file');
    buf = fs.readFileSync(file);
  } catch (_){
    return sendText(res, 404, 'Not found: ' + rel);
  }

  const ext = path.extname(file).toLowerCase();
  let body = buf;
  if (ext === '.html') body = Buffer.from(injectLive(buf.toString('utf8')), 'utf8');

  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    /* 改完立刻能看到，不用手动硬刷 */
    'Cache-Control': 'no-store'
  });
  res.end(body);
});

/* ---------- 端口：被占用就顺延 ---------- */
function listen(port, tries = 0){
  server.removeAllListeners('error');
  server.once('error', err => {
    if (err.code === 'EADDRINUSE' && tries < 10){
      console.log(`! 端口 ${port} 被占用，换 ${port + 1}`);
      listen(port + 1, tries + 1);
    } else {
      console.error('✗ 服务启动失败：' + err.message);
      process.exit(1);
    }
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log('\n⚡ 投资人生 · 开发模式');
    console.log('   预览：' + url);
    console.log(WATCH
      ? '   监听：src/  data/    改完自动重建并刷新页面'
      : '   监听：已关闭（--no-watch）');
    console.log('   Ctrl+C 退出\n');
    if (OPEN) openBrowser(url);
  });
}

function openBrowser(url){
  const [cmd, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch (_){}
}

/* ---------- 监听源文件 ---------- */
let timer = null;
let pending = '';

function schedule(file){
  pending = file;
  clearTimeout(timer);
  timer = setTimeout(() => {
    build(`检测到 ${path.relative(ROOT, pending)} 改动，`);
  }, 180);
}

function watchSources(){
  let ok = 0;
  for (const dir of WATCH_DIRS){
    try {
      fs.watch(dir, { recursive: true }, (ev, name) => {
        if (!name) return;
        const base = path.basename(name);
        /* 忽略编辑器临时文件与隐藏文件 */
        if (base.startsWith('.') || base.endsWith('~') || base.endsWith('.swp')) return;
        schedule(path.join(dir, name));
      });
      ok++;
    } catch (e){
      console.warn('! 无法监听 ' + path.relative(ROOT, dir) + '：' + e.message);
    }
  }
  return ok;
}

/* ---------- 启动 ---------- */
console.log('▶ 初次构建…');
if (!build('')){
  console.error('✗ 初次构建失败，先修好数据或模板再看预览');
  process.exit(1);
}

if (WATCH){
  const n = watchSources();
  if (!n) console.warn('! 没有可监听的目录，本次只提供静态预览');
}

listen(START_PORT);

/* Ctrl+C 时收拾干净 */
for (const sig of ['SIGINT', 'SIGTERM']){
  process.on(sig, () => {
    for (const res of clients){ try { res.end(); } catch (_){} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 300);
  });
}
