/* server/server.js — 伞迹 H5 后端（零依赖，Node 内置模块，无需 npm install）
 *
 * 启动：  node server/server.js        （默认端口 3000）
 * 数据：  server/data/db.json          （JSON 文件存储，自动创建）
 *
 * API（与前端 js/storage.js 一一对应，前端接后端时把 IndexedDB 实现
 *       替换为下面 fetch 调用即可，页面零改动）：
 *   POST /api/register   {nickname, contact, base, password}      → 注册并返回用户
 *   POST /api/login      {nickname, password}                     → 登录，返回 {id,nickname,base}
 *   POST /api/tracks     {token, title, base, note, photo, visibility, points} → 上传轨迹
 *   GET  /api/tracks?base=xx&mine=1&fav=1                         → 轨迹列表（公开 + 自己的私密）
 *   GET  /api/profile/:userId                                     → 飞手主页统计
 *   POST /api/like  /  POST /api/fav    {token, trackId}          → 点赞/收藏切换
 *   POST /api/comment {token, trackId, rating, text}              → 提交评论
 *   GET  /api/comments?trackId=1                                  → 轨迹评论
 *   POST /api/delete  {token, trackId}                            → 删除自己的轨迹
 *
 * 安全说明：演示后端使用 JSON 文件存储 + SHA-256 密码摘要；生产环境
 *           应换用数据库、服务端加盐哈希与 HTTPS。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

// ---------- 数据层（JSON 文件） ----------
function loadDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { users: [], tracks: [], comments: [], sites: [], seq: { user: 1, track: 1, comment: 1, site: 1 } };
  }
}
function saveDB(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function sha256(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex');
}

// ---------- HTTP 工具 ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 50 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(new Error('JSON 格式错误')); } });
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function sessionUser(db, token) {
  if (!token) return null;
  return db.users.find(u => u.token === token) || null;
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  // CORS（允许本地 H5 跨域调用）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const db = loadDB();
  try {
    // 注册（普通飞手 / 基地管理员）
    if (p === '/api/register' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.nickname || !b.password) return json(res, 400, { error: '昵称和密码必填' });
      if (db.users.some(u => u.nickname === b.nickname)) return json(res, 400, { error: '昵称已被占用' });
      const user = {
        id: db.seq.user++,
        nickname: b.nickname,
        contact: b.contact || '',
        base: b.base || '',
        role: b.role === 'admin' ? 'admin' : 'pilot', // 身份：基地管理员 / 普通飞手
        passHash: sha256(b.password),
        token: sha256(b.nickname + Date.now()),
        createdAt: Date.now()
      };
      db.users.push(user); saveDB(db);
      return json(res, 200, { id: user.id, nickname: user.nickname, base: user.base, role: user.role, token: user.token });
    }
    // 登录
    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      const u = db.users.find(x => x.nickname === b.nickname);
      if (!u || u.passHash !== sha256(b.password)) return json(res, 400, { error: '账号或密码不正确' });
      return json(res, 200, { id: u.id, nickname: u.nickname, base: u.base, role: u.role || 'pilot', token: u.token });
    }
    // 上传轨迹（含标题/基地/照片/笔记/可见性）
    if (p === '/api/tracks' && req.method === 'POST') {
      const b = await readBody(req);
      const u = sessionUser(db, b.token);
      if (!u) return json(res, 401, { error: '未登录' });
      if (!b.points || b.points.length < 2) return json(res, 400, { error: '轨迹数据无效' });
      const track = {
        id: db.seq.track++,
        title: b.title || '未命名轨迹',
        base: b.base || '',
        note: b.note || '',
        photo: b.photo || null,
        visibility: b.visibility === 'private' ? 'private' : 'public',
        authorId: u.id,
        authorName: u.nickname,
        likeIds: [], favIds: [],
        points: b.points,
        meta: b.meta || {},
        createdAt: Date.now()
      };
      db.tracks.push(track); saveDB(db);
      return json(res, 200, { id: track.id });
    }
    // 轨迹列表（base 筛选 / mine / fav / 默认公开）
    if (p === '/api/tracks' && req.method === 'GET') {
      const u = sessionUser(db, url.searchParams.get('token'));
      let list = db.tracks.filter(t => {
        const vis = t.visibility || 'public';
        if (url.searchParams.get('mine') === '1') return u && t.authorId === u.id;
        if (url.searchParams.get('fav') === '1') return u && t.favIds.includes(u.id);
        if (vis !== 'public') return false;
        const base = url.searchParams.get('base');
        if (base && t.base !== base) return false;
        return true;
      });
      // 去掉 points 减小响应（回放时用 detail 接口）
      list = list.map(t => { const c = Object.assign({}, t); delete c.points; return c; });
      list.sort((a, b) => b.createdAt - a.createdAt);
      return json(res, 200, list);
    }
    // 轨迹详情（含 points，供 3D 回放）
    if (/^\/api\/track\/(\d+)$/.test(p) && req.method === 'GET') {
      const id = Number(p.split('/')[3]);
      const t = db.tracks.find(x => x.id === id);
      if (!t) return json(res, 404, { error: '轨迹不存在' });
      if ((t.visibility || 'public') !== 'public') {
        const u = sessionUser(db, url.searchParams.get('token'));
        if (!u || u.id !== t.authorId) return json(res, 403, { error: '无权限查看' });
      }
      return json(res, 200, t);
    }
    // 飞手主页
    if (/^\/api\/profile\/(\d+)$/.test(p) && req.method === 'GET') {
      const uid = Number(p.split('/')[3]);
      const u = db.users.find(x => x.id === uid) || null;
      const pub = db.tracks.filter(t => t.authorId === uid && (t.visibility || 'public') === 'public');
      const totalSec = pub.reduce((s, t) => s + ((t.meta && t.meta.dur) || 0), 0);
      pub.sort((a, b) => b.createdAt - a.createdAt);
      return json(res, 200, {
        user: u ? { id: u.id, nickname: u.nickname, base: u.base, createdAt: u.createdAt } : null,
        count: pub.length,
        totalSec: totalSec,
        tracks: pub.map(t => { const c = Object.assign({}, t); delete c.points; return c; })
      });
    }
    // 点赞 / 收藏切换
    if ((p === '/api/like' || p === '/api/fav') && req.method === 'POST') {
      const b = await readBody(req);
      const u = sessionUser(db, b.token);
      if (!u) return json(res, 401, { error: '未登录' });
      const t = db.tracks.find(x => x.id === b.trackId);
      if (!t) return json(res, 404, { error: '轨迹不存在' });
      const arr = p === '/api/like' ? 'likeIds' : 'favIds';
      const i = t[arr].indexOf(u.id);
      const on = i < 0;
      if (on) t[arr].push(u.id); else t[arr].splice(i, 1);
      saveDB(db);
      return json(res, 200, { on, count: t[arr].length });
    }
    // 提交评论
    if (p === '/api/comment' && req.method === 'POST') {
      const b = await readBody(req);
      const u = sessionUser(db, b.token);
      if (!u) return json(res, 401, { error: '未登录' });
      const c = {
        id: db.seq.comment++,
        trackId: b.trackId,
        rating: b.rating || 3,
        text: b.text || '',
        author: u.nickname,
        authorId: u.id,
        createdAt: Date.now()
      };
      db.comments.push(c); saveDB(db);
      return json(res, 200, { id: c.id });
    }
    // 轨迹评论列表
    if (p === '/api/comments' && req.method === 'GET') {
      const trackId = Number(url.searchParams.get('trackId'));
      const list = db.comments.filter(c => c.trackId === trackId).sort((a, b) => a.createdAt - b.createdAt);
      return json(res, 200, list);
    }
    // 基地点位/区域（管理员）
    // 列出全部基地点位（所有用户可读）
    if (p === '/api/sites' && req.method === 'GET') {
      return json(res, 200, db.sites || []);
    }
    // 新增点位/区域：管理员
    //   takeoff/landing: {token, type, base, name, lat, lon}
    //   danger:          {token, type:'danger', base, name, note, polygon:[{lat,lon}]}
    if (p === '/api/sites' && req.method === 'POST') {
      const b = await readBody(req);
      const u = sessionUser(db, b.token);
      if (!u) return json(res, 401, { error: '未登录' });
      if (u.role !== 'admin') return json(res, 403, { error: '仅基地管理员可新增点位/区域' });
      const s = {
        id: db.seq.site++,
        type: b.type === 'landing' ? 'landing' : (b.type === 'danger' ? 'danger' : 'takeoff'),
        base: b.base || u.base || '',
        name: b.name || '未命名',
        note: b.note || '',
        authorId: u.id,
        createdAt: Date.now()
      };
      if (s.type === 'danger') {
        if (!b.polygon || b.polygon.length < 3) return json(res, 400, { error: '危险区域至少 3 个顶点' });
        s.polygon = b.polygon;
      } else {
        s.lat = b.lat; s.lon = b.lon;
      }
      db.sites = db.sites || [];
      db.sites.push(s); saveDB(db);
      return json(res, 200, { id: s.id });
    }
    // 拖拽校准起降场坐标 / 更新点位（管理员本人）
    if (p === '/api/site/move' && req.method === 'POST') {
      const b = await readBody(req);
      const u = sessionUser(db, b.token);
      if (!u || u.role !== 'admin') return json(res, 403, { error: '仅基地管理员可校准点位' });
      const s = (db.sites || []).find(x => x.id === b.siteId);
      if (!s) return json(res, 404, { error: '点位不存在' });
      if (s.authorId !== u.id) return json(res, 403, { error: '只能校准自己绘制的点位' });
      if (b.lat != null && b.lon != null) { s.lat = b.lat; s.lon = b.lon; }
      if (b.polygon) s.polygon = b.polygon;
      saveDB(db);
      return json(res, 200, { ok: true });
    }
    // 删除点位/区域（创建者管理员）
    if (p === '/api/site/delete' && req.method === 'POST') {
      const b = await readBody(req);
      const u = sessionUser(db, b.token);
      if (!u || u.role !== 'admin') return json(res, 403, { error: '仅基地管理员可删除' });
      const s = (db.sites || []).find(x => x.id === b.siteId);
      if (!s) return json(res, 404, { error: '点位不存在' });
      if (s.authorId !== u.id) return json(res, 403, { error: '只能删除自己绘制的点位/区域' });
      db.sites = db.sites.filter(x => x.id !== b.siteId);
      saveDB(db);
      return json(res, 200, { ok: true });
    }
    // 删除自己的轨迹
    if (p === '/api/delete' && req.method === 'POST') {
      const b = await readBody(req);
      const u = sessionUser(db, b.token);
      if (!u) return json(res, 401, { error: '未登录' });
      const t = db.tracks.find(x => x.id === b.trackId);
      if (!t || t.authorId !== u.id) return json(res, 403, { error: '只能删除自己的轨迹' });
      db.tracks = db.tracks.filter(x => x.id !== b.trackId);
      db.comments = db.comments.filter(x => x.trackId !== b.trackId);
      saveDB(db);
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: '接口不存在' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log('伞迹后端已启动: http://localhost:' + PORT);
  console.log('API 文档见 server/README.md');
});
