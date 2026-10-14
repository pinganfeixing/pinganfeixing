/* js/storage.js — 伞迹 H5 社区数据层（IndexedDB 本地存储 + 会话）
 *
 * 数据表：
 *   users   飞手账号 {id, nickname, contact, base, passHash, createdAt}
 *   tracks  上传轨迹 {id, title, base, note, visibility('public'|'private'),
 *                    authorId, authorName, points, meta, createdAt}
 *   comments 轨迹评论 {id, trackId, rating, text, author, createdAt}
 *   flylogs  飞行记录 {id, date, site, weather, wind, count, glider, note, shared, author, createdAt}
 *   gear     装备 {id, name, type, hours, serviceHours, createdAt}（伞翼/吊带/副伞，飞行小时提醒）
 *
 * 说明：纯前端演示用 IndexedDB 本地存储；接后端时替换为 HTTP API 即可，
 *       数据表结构与云数据库一一对应。
 */
(function () {
  'use strict';
  var DB_NAME = 'sanji-h5';
  var DB_VERSION = 4;
  var SESSION_KEY = 'sanji_session';

  // 预置滑翔基地（用户可自定义新增）
  var PRESET_BASES = [
    '泰山伞场', '徂徕山', '莲花山', '济南南部山区',
    '青龙山', '青岛崂山', '临沂沂蒙山', '河北坝上'
  ];

  // ---- IndexedDB 基础 ----
  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('users')) {
          db.createObjectStore('users', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('tracks')) {
          db.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('comments')) {
          var cs = db.createObjectStore('comments', { keyPath: 'id', autoIncrement: true });
          cs.createIndex('trackId', 'trackId', { unique: false });
        }
        if (!db.objectStoreNames.contains('flylogs')) {
          db.createObjectStore('flylogs', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('sites')) {
          // 基地点位/区域：type='takeoff'|'landing'|'danger'
          //   takeoff/landing: {type, base, name, lat, lon, authorId, createdAt}
          //   danger:         {type, base, name, note, polygon:[{lat,lon}], authorId, createdAt}
          db.createObjectStore('sites', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('gear')) {
          // 装备：{id, name, type, hours, serviceHours, createdAt}
          db.createObjectStore('gear', { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function getAll(store) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, 'readonly');
        var req = t.objectStore(store).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function add(store, obj) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, 'readwrite');
        var req = t.objectStore(store).add(obj);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function del(store, key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, 'readwrite');
        var req = t.objectStore(store).delete(key);
        req.onsuccess = function () { resolve(); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // 覆盖更新整条记录（点赞/收藏等字段变更用）
  function put(store, obj) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, 'readwrite');
        var req = t.objectStore(store).put(obj);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function getByIndex(store, idx, value) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(store, 'readonly');
        var req = t.objectStore(store).index(idx).getAll(value);
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // ---- 密码哈希（SHA-256，纯前端演示；真实后端应使用服务端加盐哈希） ----
  function hashPw(pw) {
    if (window.crypto && crypto.subtle) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw || ''))
        .then(function (buf) {
          return Array.prototype.map.call(new Uint8Array(buf), function (b) {
            return ('0' + b.toString(16)).slice(-2);
          }).join('');
        });
    }
    // 极简 fallback（非安全，仅供离线演示）
    var h = 0;
    for (var i = 0; i < (pw || '').length; i++) h = (h * 31 + pw.charCodeAt(i)) | 0;
    return Promise.resolve('h' + Math.abs(h).toString(16));
  }

  // ---- 账号系统 ----
  var SanjiStore = {
    getAll: getAll,
    add: add,
    del: del,
    getByIndex: getByIndex,
    PRESET_BASES: PRESET_BASES,

    // 注册：飞手昵称 / 联系信息 / 所属基地 / 密码 / 身份（pilot 普通飞手 | admin 基地管理员）
    register: function (opt) {
      return getAll('users').then(function (users) {
        var dup = users.filter(function (u) {
          return u.nickname === opt.nickname;
        })[0];
        if (dup) {
          throw new Error('昵称已被占用，请换一个');
        }
        return hashPw(opt.password).then(function (passHash) {
          return add('users', {
            nickname: opt.nickname,
            contact: opt.contact || '',
            base: opt.base || '',
            role: opt.role === 'admin' ? 'admin' : 'pilot', // 身份：基地管理员 / 普通飞手
            passHash: passHash,
            createdAt: Date.now()
          });
        }).then(function (id) {
          // 注册成功自动登录
          return getAll('users').then(function (us) {
            var u = us.filter(function (x) { return x.id === id; })[0];
            setSession(u);
            return u;
          });
        });
      });
    },

    // 登录：昵称 + 密码
    login: function (nickname, password) {
      return getAll('users').then(function (users) {
        var u = users.filter(function (x) { return x.nickname === nickname; })[0];
        if (!u) throw new Error('账号不存在，请先注册');
        return hashPw(password).then(function (h) {
          if (h !== u.passHash) throw new Error('密码不正确');
          setSession(u);
          return u;
        });
      });
    },

    // 会话：localStorage 保存登录状态
    setSession: setSession,
    getSession: function () {
      try {
        var s = localStorage.getItem(SESSION_KEY);
        return s ? JSON.parse(s) : null;
      } catch (e) { return null; }
    },
    logout: function () {
      localStorage.removeItem(SESSION_KEY);
    },

    // 当前登录用户完整信息（校验 users 表）
    me: function () {
      var s = SanjiStore.getSession();
      if (!s) return Promise.resolve(null);
      return getAll('users').then(function (users) {
        var u = users.filter(function (x) { return x.id === s.id; })[0];
        if (u) setSession(u);
        return u || null;
      });
    },

    // 基地列表：预置 + 用户/轨迹/基地点位中出现的新基地
    getBases: function () {
      var set = {};
      PRESET_BASES.forEach(function (b) { set[b] = 1; });
      return Promise.all([getAll('users'), getAll('tracks'), getAll('sites')]).then(function (r) {
        var users = r[0], tracks = r[1], sites = r[2];
        users.forEach(function (u) { if (u.base) set[u.base] = 1; });
        tracks.forEach(function (t) { if (t.base) set[t.base] = 1; });
        sites.forEach(function (s) { if (s.base) set[s.base] = 1; });
        return Object.keys(set);
      });
    },

    // 各轨迹评论统计 {trackId: {avg, count}}
    commentStats: function () {
      return getAll('comments').then(function (list) {
        var map = {};
        list.forEach(function (c) {
          if (!map[c.trackId]) map[c.trackId] = { sum: 0, count: 0 };
          map[c.trackId].sum += c.rating;
          map[c.trackId].count++;
        });
        var out = {};
        Object.keys(map).forEach(function (k) {
          out[k] = { avg: Math.round((map[k].sum / map[k].count) * 10) / 10, count: map[k].count };
        });
        return out;
      });
    },

    // 点赞 / 收藏切换（需登录）：likeIds / favIds 存用户 id 数组
    toggleLike: function (trackId, userId) {
      return getAll('tracks').then(function (ts) {
        var t = ts.filter(function (x) { return x.id === trackId; })[0];
        if (!t) throw new Error('轨迹不存在');
        t.likeIds = t.likeIds || [];
        var i = t.likeIds.indexOf(userId);
        if (i >= 0) t.likeIds.splice(i, 1); else t.likeIds.push(userId);
        return put('tracks', t).then(function () { return { liked: i < 0, count: t.likeIds.length }; });
      });
    },
    toggleFav: function (trackId, userId) {
      return getAll('tracks').then(function (ts) {
        var t = ts.filter(function (x) { return x.id === trackId; })[0];
        if (!t) throw new Error('轨迹不存在');
        t.favIds = t.favIds || [];
        var i = t.favIds.indexOf(userId);
        if (i >= 0) t.favIds.splice(i, 1); else t.favIds.push(userId);
        return put('tracks', t).then(function () { return { faved: i < 0, count: t.favIds.length }; });
      });
    },

    // 收藏夹轨迹 id 列表（当前用户）
    myFavTrackIds: function (userId) {
      return getAll('tracks').then(function (ts) {
        var ids = [];
        ts.forEach(function (t) {
          if (t.favIds && t.favIds.indexOf(userId) >= 0) ids.push(t.id);
        });
        return ids;
      });
    },

    // 飞手主页聚合：公开轨迹数 / 总留空时长 / 公开轨迹列表
    profile: function (userId) {
      return Promise.all([getAll('users'), getAll('tracks')]).then(function (r) {
        var users = r[0], tracks = r[1];
        var u = users.filter(function (x) { return x.id === userId; })[0] || null;
        var pub = tracks.filter(function (t) {
          return t.authorId === userId && (t.visibility || (t.shared ? 'public' : 'private')) === 'public';
        });
        var totalSec = pub.reduce(function (s, t) { return s + ((t.meta && t.meta.dur) || 0); }, 0);
        pub.sort(function (a, b) { return b.createdAt - a.createdAt; });
        return { user: u, count: pub.length, totalSec: totalSec, tracks: pub };
      });
    }
  };

  function setSession(u) {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      id: u.id,
      nickname: u.nickname,
      base: u.base,
      role: u.role || 'pilot'
    }));
  }

  window.SanjiStore = SanjiStore;
})();
