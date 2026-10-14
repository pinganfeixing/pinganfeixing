# 伞迹后端（零依赖 Node 服务）

纯 Node 内置模块实现，**无需 npm install**，直接运行：

```
node server/server.js
```

默认端口 3000，数据存 `server/data/db.json`（首次运行自动创建）。

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/register | 注册 `{nickname, contact, base, password, role}` role: pilot普通飞手 / admin基地管理员 |
| POST | /api/login | 登录 `{nickname, password}` → 返回 token + role |
| POST | /api/tracks | 上传轨迹（需 token）：标题/基地/照片/笔记/可见性/points |
| GET | /api/tracks?base=&mine=1&fav=1 | 轨迹列表（公开 + 筛选） |
| GET | /api/track/:id | 轨迹详情（含 points，3D 回放用） |
| GET | /api/profile/:userId | 飞手主页（总次数/总留空/公开轨迹） |
| POST | /api/like | 点赞切换 `{token, trackId}` |
| POST | /api/fav | 收藏切换 `{token, trackId}` |
| POST | /api/comment | 提交评论 `{token, trackId, rating, text}` |
| GET | /api/comments?trackId= | 轨迹评论列表 |
| POST | /api/delete | 删除自己的轨迹 `{token, trackId}` |
| GET | /api/sites | 基地点位/区域列表（所有人可读） |
| POST | /api/sites | 新增点位/区域（**仅管理员**）：起飞/降落场坐标点 或 危险区域多边形+名称备注 |
| POST | /api/site/move | 拖拽校准起降场坐标 / 更新多边形（仅创建者管理员） |
| POST | /api/site/delete | 删除点位/区域（仅创建者管理员） |

## 前端如何切换到后端

前端默认使用浏览器 IndexedDB（双击 index.html 即用，数据仅本机可见）。
要切换到真后端实现多用户云端共享：

1. 启动后端 `node server/server.js`；
2. 替换 `js/storage.js` 中每个 Promise 函数为 fetch 调用，例如：

```js
// storage.js 中 login 的实现（示例）
login: function (nickname, password) {
  return fetch('http://localhost:3000/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: nickname, password: password })
  }).then(function (r) { return r.json(); }).then(function (d) {
    if (d.error) throw new Error(d.error);
    localStorage.setItem('sanji_session', JSON.stringify({ id: d.id, nickname: d.nickname, base: d.base }));
    return d;
  });
}
```

页面（index.html / main.js）零改动——所有数据操作都走 `window.SanjiStore` 统一接口。

## 安全说明（演示级）

- 密码使用 SHA-256 摘要存储；生产环境应使用加盐哈希（bcrypt/scrypt）+ HTTPS；
- 鉴权使用简单 token；生产环境应使用 JWT 或会话 + 过期机制；
- JSON 文件存储适合原型，生产环境应换 MySQL/PostgreSQL/MongoDB。
