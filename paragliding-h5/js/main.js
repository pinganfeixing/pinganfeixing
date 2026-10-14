/* js/main.js — 伞迹 H5 三维轨迹复盘（Cesium 内核，对标径大飞行）
 *
 * 功能：
 *   1. 坐标系：IGC(WGS84) 自动适配国内卫星底图 GCJ-02 偏移（高德模式自动转换）
 *   2. 地形：Cesium Ion token 开启 Cesium World Terrain（SRTM30 真实 3D 山体），
 *      轨迹高度与山体海拔对齐（低于地形自动抬升）
 *   3. 轨迹线：宽度 1.8px，按飞行速度渐变着色（低速蓝 / 中速黄 / 高速红），平滑无锯齿
 *   4. 热气流：轻量半透明淡蓝同心波纹 + 弥散微球，不遮挡主轨迹
 *   5. IGC 解析：兼容标准/变体格式，容错跳过异常记录并提示
 *   6. 播放：跟随相机、暂停/调速/任意时间点跳转
 *   7. 数据面板：高度 / 相对高度 / 垂直升降 / 水平速度 / 滑翔比 / 时间
 *   8. 图层切换：天地图卫星 / OpenTopoMap 等高线 / 高德卫星 / ESRI 卫星
 *   9. UI：简约干净、移动端适配
 *  10. 社区：上传分享 IGC、评价、删除、飞行记录（IndexedDB，可换后端）
 */
(function () {
  'use strict';

  // ============ 配置（来自 index.html 全局变量） ============
  var ION_TOKEN = window.ION_TOKEN || '';
  var TIANDITU_KEY = window.TIANDITU_KEY || '';

  var SPEEDS = [0.5, 1, 2, 4, 8];
  var SPEED_NAMES = ['0.5x', '1x', '2x', '4x', '8x'];

  // 底图源。wgs: true 表示 WGS84 无偏移（轨迹坐标保持原样）；
  //        false 表示 GCJ-02（高德），轨迹坐标自动转换对齐。
  var SOURCES = {
    esri: {
      name: 'ESRI 卫星', wgs: true,
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
    },
    amap: {
      name: '高德卫星', wgs: false,
      url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=6&x={x}&y={y}&z={z}',
      subdomains: ['1', '2', '3', '4']
    },
    opentopo: {
      name: 'OpenTopoMap 等高线', wgs: true,
      url: 'https://tile.opentopomap.org/{z}/{x}/{y}.png'
    },
    tianditu: {
      name: '天地图卫星', wgs: true, // CGCS2000 ≈ WGS84，无偏移
      url: 'https://t{s}.tianditu.gov.cn/DataServer?T=img_w&x={x}&y={y}&l={z}&tk=' + TIANDITU_KEY,
      subdomains: ['0', '1', '2', '3', '4', '5', '6', '7']
    }
  };

  var state = {
    points: null,        // 原始点（未抽稀）
    disp: null,          // 抽稀后显示点
    times: null,         // 相对时间 ms
    totalMs: 1,
    playMs: 0,
    playing: false,
    speedIdx: 2,
    follow: true,
    terrainReady: false,
    takeoffAlt: 0,
    stats: null,
    planeEntity: null,
    previewLine: null,   // 静态预览线（未播放时显示整条淡色线，避免"轨迹消失"）
    trackEntities: [],
    markEntities: [],
    thermalEntities: [],
    siteEntities: [],    // 基地图层（起飞场/降落场/危险禁飞多边形）
    sitesVisible: false, // 基地图层默认关闭（由管理员数据驱动）
    danger: false,       // 当前是否处于禁飞危险区域
    chart: null,
    chartData: null,
    curTrack: null,
    coordSys: 'wgs',     // 'wgs' | 'gcj'
    terrainPositions: null,
    mainPool: [],        // 主线分段实体池（速度渐变，30s 窗口）
    tailLayers: [],      // 渐隐尾迹层实体（30-120s 前，逐层淡出）
    _lastTailAt: 0,
    colorMode: 'speed',  // 轨迹着色：speed 速度 | climb 爬升率 | glide 滑翔比
    meta: null,          // IGC 元信息 {date, pilot, glider, site, weather}
    score: null,         // 飞行得分卡（简化 XContest）
    thermalEff: null,    // 热气流效率报告
    states: [],          // 姿态分段（伞状态判定，severity 0-3）
    compare: null        // 编队对比：{points, disp, times, terrainPositions, entity, planeEntity, name}
  };

  // 基地图层（起飞场/降落场/危险禁飞区）：默认关闭；点位与区域全部由
  // 基地管理员在地图上绘制/拖拽创建，存 IndexedDB（storage 'sites'），
  // 普通飞手只读查看。系统不再内置任何"不准"的禁飞标记。
  var SITES = { takeoffs: [], landings: [], dangerZones: [] };

  var dom = {};
  var viewer = null;
  var core = window.SanjiCore;

  // ============ 工具函数 ============

  // 屏幕诊断条（错误 / 容错提示）
  function showDiag(msg, isErr) {
    var bar = document.getElementById('diagBar');
    if (!bar) return;
    bar.textContent = msg;
    bar.style.background = isErr ? 'rgba(127,29,29,.92)' : 'rgba(30,64,175,.92)';
    bar.style.display = 'block';
    clearTimeout(showDiag._t);
    showDiag._t = setTimeout(function () { bar.style.display = 'none'; }, 6000);
  }

  // ---- GCJ-02（高德/奥维国内图层）坐标转换 ----
  function outOfChina(lat, lon) {
    return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
  }
  function tLat(x, y) {
    var ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }
  function tLon(x, y) {
    var ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
    return ret;
  }
  function wgs84ToGcj02(lat, lon) {
    if (outOfChina(lat, lon)) return { lat: lat, lon: lon };
    var a = 6378245.0, ee = 0.00669342162296594323;
    var dLat = tLat(lon - 105.0, lat - 35.0);
    var dLon = tLon(lon - 105.0, lat - 35.0);
    var radLat = lat / 180.0 * Math.PI;
    var magic = Math.sin(radLat);
    magic = 1 - ee * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
    dLon = (dLon * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
    return { lat: lat + dLat, lon: lon + dLon };
  }
  // 单点 → Cartesian3（自动处理 GCJ 转换）
  function ptPos(p, alt) {
    var cesium = window.Cesium;
    if (state.coordSys === 'gcj') {
      var g = wgs84ToGcj02(p.lat, p.lon);
      return cesium.Cartesian3.fromDegrees(g.lon, g.lat, alt);
    }
    return cesium.Cartesian3.fromDegrees(p.lon, p.lat, alt);
  }
  // WGS84 + 高德双坐标文本（用于对比验证）
  function coordDual(lat, lon) {
    var g = wgs84ToGcj02(lat, lon);
    return 'WGS84 ' + lat.toFixed(5) + ',' + lon.toFixed(5) + ' ｜ 高德 ' + g.lat.toFixed(5) + ',' + g.lon.toFixed(5);
  }

  function fmtMs(ms) {
    var t = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (h > 0 ? p(h) + ':' : '') + p(m) + ':' + p(s);
  }
  function fmtDur(sec) { return fmtMs(sec * 1000); }

  // 安全转义（社区卡片渲染用）
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function starStr(avg) {
    var n = Math.round(avg || 0), out = '';
    for (var i = 0; i < 5; i++) out += i < n ? '★' : '☆';
    return out;
  }

  // ============ 初始化 ============
  function init() {
    dom = {
      file: document.getElementById('fileInput'),
      play: document.getElementById('btnPlay'),
      seek: document.getElementById('seek'),
      speed: document.getElementById('btnSpeed'),
      follow: document.getElementById('btnFollow'),
      chartBtn: document.getElementById('btnChart'),
      chartClose: document.getElementById('chartClose'),
      chartPanel: document.getElementById('chartPanel'),
      chartBox: document.getElementById('chartBox'),
      hudAlt: document.getElementById('hudAlt'),
      hudRel: document.getElementById('hudRel'),
      hudClimb: document.getElementById('hudClimb'),
      hudSpeed: document.getElementById('hudSpeed'),
      hudGlide: document.getElementById('hudGlide'),
      hudTime: document.getElementById('hudTime'),
      hudTotal: document.getElementById('hudTotal'),
      trackName: document.getElementById('trackName'),
      trackMeta: document.getElementById('trackMeta'),
      ticks: document.querySelectorAll('.tick')
    };

    var cesium = window.Cesium;
    if (ION_TOKEN) cesium.Ion.defaultAccessToken = ION_TOKEN;

    var baseImagery = ION_TOKEN
      ? undefined
      : new cesium.UrlTemplateImageryProvider({ url: SOURCES.esri.url, maximumLevel: 18 });

    viewer = new cesium.Viewer('cesiumContainer', {
      imageryProvider: baseImagery,
      terrainProvider: new cesium.EllipsoidTerrainProvider(),
      baseLayerPicker: false, geocoder: false, homeButton: false,
      sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false,
      animation: false, timeline: false, infoBox: false, selectionIndicator: false,
      requestRenderMode: false
    });
    viewer.scene.globe.enableLighting = false;
    viewer.scene.globe.baseColor = cesium.Color.fromCssColorString('#0b1220');
    viewer.scene.skyBox.show = false;
    viewer.scene.skyAtmosphere.show = false;
    viewer.scene.fog.enabled = false;

    // 渲染错误捕获（替代系统弹窗）
    try {
      viewer.scene.renderError.addEventListener(function (scene, err) {
        console.error('[Cesium renderError]', err, err && err.stack);
        showDiag('渲染错误（已捕获）：' + (err && err.message ? err.message : err), true);
      });
    } catch (e) { /* 老版本无 renderError */ }

    // 开启 Cesium World Terrain（SRTM30 真实山体，需 token）
    if (ION_TOKEN) {
      try {
        viewer.terrainProvider = cesium.createWorldTerrain({
          requestWaterMask: false, requestVertexNormals: false
        });
        state.terrainReady = true;
      } catch (e) {
        console.warn('World Terrain 加载失败', e);
      }
    } else {
      var bar = document.getElementById('tokenBar');
      if (bar) {
        bar.classList.add('show');
        document.getElementById('tokenClose').addEventListener('click', function () {
          bar.classList.remove('show');
        });
      }
    }

    bindEvents();
    communityInit();
    // 预加载管理员绘制的基地点位/区域（普通飞手只读查看）
    refreshSitesFromDB(function () {
      if (state.disp) rebuildScene();
    });
    loadDemo();
    tick();
  }

  // ============ 事件绑定 ============
  function bindEvents() {
    dom.file.addEventListener('change', onFile);
    dom.play.addEventListener('click', togglePlay);
    dom.speed.addEventListener('click', cycleSpeed);
    dom.seek.addEventListener('input', onSeek);
    dom.follow.addEventListener('click', toggleFollow);
    dom.chartBtn.addEventListener('click', toggleChart);
    dom.chartClose.addEventListener('click', toggleChart);
    document.querySelectorAll('#sourceGroup .btn').forEach(function (b) {
      b.addEventListener('click', function () { switchSource(b.dataset.src); });
    });
    var sitesBtn = document.getElementById('btnSites');
    if (sitesBtn) sitesBtn.addEventListener('click', toggleSites);
    // v3.9：着色模式切换 / 编队对比 / 装备管理 / 年度报告
    var colorBtn = document.getElementById('btnColor');
    if (colorBtn) colorBtn.addEventListener('click', cycleColor);
    var cmpBtn = document.getElementById('btnCompare');
    if (cmpBtn) cmpBtn.addEventListener('click', openCompareModal);
    var gearBtn = document.getElementById('btnGear');
    if (gearBtn) gearBtn.addEventListener('click', openGearModal);
    var annualBtn = document.getElementById('btnAnnual');
    if (annualBtn) annualBtn.addEventListener('click', openAnnualModal);
  }

  // ============ v3.9 新增功能 ============

  // 轨迹着色模式：速度 → 爬升率 → 滑翔比 循环
  function cycleColor() {
    var modes = ['speed', 'climb', 'glide'];
    var names = { speed: '速度', climb: '爬升', glide: '滑翔比' };
    var idx = modes.indexOf(state.colorMode);
    state.colorMode = modes[(idx + 1) % modes.length];
    var btn = document.getElementById('btnColor');
    if (btn) btn.textContent = '着色:' + names[state.colorMode];
    showDiag('轨迹着色：' + names[state.colorMode], false);
    // 强制刷新尾迹（段颜色变化需要重设 _range 缓存）
    state.mainPool.forEach(function (s) { s._range = null; });
    updateTail();
  }

  // ---- 编队轨迹对比：主轨迹 + 对比轨迹（橙色点 + 淡青色虚线）同步回放 ----
  function openCompareModal() {
    document.getElementById('compareModal').classList.add('show');
    var list = document.getElementById('compareList');
    window.SanjiStore.getAll('tracks').then(function (tracks) {
      var pub = tracks.filter(function (t) { return t.visibility !== 'private'; }).slice(0, 12);
      if (!pub.length) {
        list.innerHTML = '<div class="empty-tip">暂无公开轨迹，可上传 IGC 对比</div>';
        return;
      }
      list.innerHTML = pub.map(function (t) {
        return '<div class="fl-log-card" style="cursor:pointer" data-cmp="' + t.id + '">' +
          '<div class="fl-log-title">' + esc(t.title || '未命名') + '</div>' +
          '<div class="fl-log-meta"><span>' + esc(t.authorName || '') + '</span><span>' + esc(t.base || '') + '</span></div></div>';
      }).join('');
      list.querySelectorAll('[data-cmp]').forEach(function (row) {
        row.addEventListener('click', function () {
          var id = Number(row.dataset.cmp);
          var t = pub.filter(function (x) { return x.id === id; })[0];
          loadCompareTrack(t.points, t.title || '对比轨迹');
          document.getElementById('compareModal').classList.remove('show');
        });
      });
    });
    var cmpFile = document.getElementById('compareFile');
    cmpFile.onchange = function () {
      var f = cmpFile.files && cmpFile.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var t = core.parseTrack(reader.result, f.name);
          loadCompareTrack(t.points, f.name.replace(/\.[^.]+$/, ''));
          document.getElementById('compareModal').classList.remove('show');
        } catch (err) { showDiag('对比轨迹解析失败：' + err.message, true); }
      };
      reader.readAsText(f);
      cmpFile.value = '';
    };
  }

  // 加载对比轨迹：抽稀 + 坐标转换 + 渲染淡青色虚线 + 橙色点
  function loadCompareTrack(points, name) {
    if (!points || points.length < 2) { showDiag('对比轨迹点数不足', true); return; }
    clearCompare();
    var decimated = core.stats.decimate(points, 1200);
    var gcj = state.coordSys === 'gcj';
    var disp = decimated.map(function (p) {
      if (gcj) {
        var c = wgs84ToGcj02(p.lat, p.lon);
        return { t: p.t, lat: c[0], lon: c[1], alt: p.alt };
      }
      return p;
    });
    var t0 = disp[0].t || 0;
    var times = disp.map(function (p) { return (p.t || 0) - t0; });
    var cesium = window.Cesium;
    var positions = disp.map(function (p) {
      return cesium.Cartesian3.fromDegrees(p.lon, p.lat, Math.max(p.alt, 300));
    });
    var entity = viewer.entities.add({
      polyline: {
        positions: positions,
        width: 1.2,
        material: new cesium.PolylineGlowMaterialProperty({
          glowPower: 0.08,
          color: cesium.Color.fromCssColorString('#5eead4').withAlpha(0.8)
        }),
        arcType: cesium.ArcType.NONE
      }
    });
    var planeEntity = viewer.entities.add({
      position: new cesium.CallbackProperty(function () {
        var idx = compareIdxAtTime(state.playMs);
        return positions[Math.min(idx, positions.length - 1)] || cesium.Cartesian3.ZERO;
      }, false),
      point: {
        pixelSize: 8,
        color: cesium.Color.fromCssColorString('#fb923c'), // 对比轨迹：橙色点
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
    });
    state.compare = {
      points: points, disp: disp, times: times, positions: positions,
      entity: entity, planeEntity: planeEntity, name: name
    };
    showDiag('对比轨迹已加载：' + (name || '') + '（橙色点，同步回放）', false);
  }

  function compareIdxAtTime(ms) {
    if (!state.compare || !state.compare.times || !state.compare.times.length) return 0;
    var arr = state.compare.times;
    var lo = 0, hi = arr.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (arr[mid] < ms) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function clearCompare() {
    if (!state.compare) return;
    if (state.compare.entity) viewer.entities.remove(state.compare.entity);
    if (state.compare.planeEntity) viewer.entities.remove(state.compare.planeEntity);
    state.compare = null;
  }

  // ---- 热气流明细弹层：每个上升区段的效率 ----
  function openThermalDetail() {
    var s = state.stats;
    if (!s || !s.thermals || !s.thermals.length) return;
    var eff = state.thermalEff || {};
    var html = '<div class="track-summary" style="margin-bottom:10px">' +
      '<span>热气流 <b>' + (s.thermalCount || 0) + ' 个</b></span>' +
      '<span>利用率 <b>' + (eff.utilizationPct || 0) + '%</b></span>' +
      '<span>总增益 <b>' + (eff.totalGain || 0) + ' m</b></span>' +
      '<span>最高爬升 <b>' + (eff.bestClimb || 0) + ' m/s</b></span></div>';
    html += s.thermals.map(function (t, i) {
      return '<div class="fl-log-card">' +
        '<div class="fl-log-title">热气流 #' + (i + 1) + '</div>' +
        '<div class="fl-log-meta">' +
        '<span>时长 ' + fmtMs(t.duration * 1000) + '</span>' +
        '<span>增益 ' + (t.altGain || 0) + ' m</span>' +
        '<span>平均爬升 ' + (t.avgClimb || 0) + ' m/s</span>' +
        '<span>约 ' + (t.circles || 1) + ' 圈</span>' +
        '</div><div class="fl-log-meta"><span>位置 ' + t.centerLat.toFixed(4) + ',' + t.centerLon.toFixed(4) + '</span></div></div>';
    }).join('');
    document.getElementById('thermalBody').innerHTML = html;
    document.getElementById('thermalModal').classList.add('show');
  }

  // ---- 装备管理（伞翼/吊带/副伞，飞行小时提醒） ----
  function openGearModal() {
    document.getElementById('gearModal').classList.add('show');
    renderGearList();
  }

  function renderGearList() {
    window.SanjiStore.getAll('gear').then(function (list) {
      var box = document.getElementById('gearList');
      if (!list.length) {
        box.innerHTML = '<div class="empty-tip">还没有装备，添加伞翼/吊带/副伞并记录飞行小时</div>';
        return;
      }
      box.innerHTML = list.map(function (g) {
        var overdue = g.serviceHours && g.hours >= g.serviceHours;
        return '<div class="fl-log-card">' +
          '<div class="fl-log-title">' + esc(g.name) + ' <span class="card-badge">' + esc(g.type) + '</span></div>' +
          '<div class="fl-log-meta">' +
          '<span>飞行 ' + g.hours + ' h</span>' +
          (g.serviceHours ? '<span>建议 ' + g.serviceHours + ' h</span>' : '') +
          (overdue ? '<span style="color:#f43f5e">⚠ 已到检查/更换时间</span>' : '') +
          '</div>' +
          '<div class="card-foot"><span></span><button class="mini-btn mini-danger" data-del-gear="' + g.id + '">删除</button></div></div>';
      }).join('');
      box.querySelectorAll('[data-del-gear]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (!confirm('删除该装备？')) return;
          window.SanjiStore.del('gear', Number(b.dataset.delGear)).then(function () { renderGearList(); });
        });
      });
    });
  }

  function addGear() {
    var name = document.getElementById('gearName').value.trim();
    if (!name) { showDiag('请填写装备名称', true); return; }
    window.SanjiStore.add('gear', {
      name: name,
      type: document.getElementById('gearType').value,
      hours: parseFloat(document.getElementById('gearHours').value) || 0,
      serviceHours: parseFloat(document.getElementById('gearService').value) || 0,
      createdAt: Date.now()
    }).then(function () {
      document.getElementById('gearName').value = '';
      document.getElementById('gearHours').value = '';
      document.getElementById('gearService').value = '';
      renderGearList();
      showDiag('装备已添加 ✓', false);
    });
  }

  // ---- 年度飞行报告：本年次数/留空/里程/最大高度/最常基地/月度柱状 ----
  function openAnnualModal() {
    var now = new Date();
    var year = now.getFullYear();
    document.getElementById('annualTitle').textContent = year + ' 年度飞行报告';
    var yearStart = new Date(year, 0, 1).getTime();
    window.SanjiStore.me().then(function (me) {
      var uid = me ? me.id : null;
      return Promise.all([
        window.SanjiStore.getAll('flylogs'),
        window.SanjiStore.getAll('tracks')
      ]).then(function (res) {
        var flylogs = res[0].filter(function (f) {
          return f.date && new Date(f.date).getTime() >= yearStart;
        });
        var tracks = res[1].filter(function (t) {
          return t.createdAt && t.createdAt >= yearStart && (!t.authorId || !uid || t.authorId === uid);
        });
      var totalCount = flylogs.reduce(function (s, f) { return s + (Number(f.count) || 1); }, 0) + tracks.length;
      var totalSec = flylogs.reduce(function (s, f) {
        var dur = f.note && f.note.match(/留空\s*([\d.]+)h/i);
        return s + (dur ? parseFloat(dur[1]) * 3600 : 0);
      }, 0);
      // 从 flylogs 备注中提取时长不可靠；改用 tracks 统计（若有 meta.dur）
      var trackSec = 0, totalKm = 0, maxAlt = 0;
      tracks.forEach(function (t) {
        var m = t.meta || {};
        if (m.dur) trackSec += Number(m.dur);
        if (m.km) totalKm += Number(m.km);
        if (m.maxAlt) maxAlt = Math.max(maxAlt, Number(m.maxAlt));
      });
      totalSec += trackSec;
      var sites = {};
      flylogs.forEach(function (f) { if (f.site) sites[f.site] = (sites[f.site] || 0) + 1; });
      tracks.forEach(function (t) { if (t.base) sites[t.base] = (sites[t.base] || 0) + 1; });
      var topSite = Object.keys(sites).sort(function (a, b) { return sites[b] - sites[a]; })[0] || '—';
      // 月度柱状（CSS 条，1-12 月）
      var months = [];
      for (var m = 0; m < 12; m++) months.push({ n: 0, s: 0 });
      flylogs.forEach(function (f) {
        var d = new Date(f.date);
        if (d.getFullYear() === year) {
          months[d.getMonth()].n += Number(f.count) || 1;
          months[d.getMonth()].s++;
        }
      });
      var maxM = Math.max.apply(null, months.map(function (x) { return x.n; }).concat([1]));
      var bars = months.map(function (x, i) {
        var h = Math.max(4, Math.round((x.n / maxM) * 60));
        return '<div style="display:flex;flex-direction:column;align-items:center;gap:3px;flex:1">' +
          '<div style="width:70%;background:linear-gradient(180deg,#38bdf8,#0ea5e9);border-radius:4px 4px 0 0;height:' + h + 'px"></div>' +
          '<div style="font-size:9px;color:#64748b">' + (i + 1) + '月</div>' +
          '<div style="font-size:9px;color:#7dd3fc">' + x.n + '</div></div>';
      }).join('');
      document.getElementById('annualBody').innerHTML =
        '<div class="profile-stat-row">' +
        '<div class="profile-stat"><b>' + totalCount + '</b><span>' + year + ' 飞行次数</span></div>' +
        '<div class="profile-stat"><b>' + fmtDur(totalSec) + '</b><span>总留空时长</span></div>' +
        '<div class="profile-stat"><b>' + totalKm.toFixed(1) + ' km</b><span>总里程</span></div>' +
        '<div class="profile-stat"><b>' + (maxAlt || '—') + ' m</b><span>年度最高</span></div>' +
        '<div class="profile-stat"><b>' + esc(topSite) + '</b><span>最常飞基地</span></div>' +
        '</div>' +
        '<div style="font-size:12px;color:#94a3b8;margin:10px 0 4px">月度飞行次数</div>' +
        '<div style="display:flex;align-items:flex-end;gap:4px;height:86px;padding:0 2px">' + bars + '</div>' +
        '<div style="font-size:10px;color:#64748b;margin-top:8px">数据来源：飞行记录 + 已上传轨迹（本地存储）</div>';
      });
    });
  }

  // ============ 导入与解析（含容错提示） ============
  function onFile(e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var t = core.parseTrack(reader.result, f.name);
        loadTrack(t.points, f.name.replace(/\.[^.]+$/, '') + ' 的飞行', t.meta);
        if (t.warnings && t.warnings.length) {
          showDiag('解析提示：' + t.warnings.join('；'), false);
        }
      } catch (err) {
        showDiag('解析失败：' + err.message, true);
      }
    };
    reader.readAsText(f);
  }

  function loadDemo() {
    try {
      var t = core.parseTrack(window.DEMO_IGC, 'demo.igc');
      loadTrack(t.points, '示例：泰安周边越野飞行');
      if (t.warnings && t.warnings.length) showDiag('示例解析提示：' + t.warnings.join('；'), false);
    } catch (e) {
      console.error('demo load failed', e);
      showDiag('示例轨迹加载失败：' + e.message, true);
    }
  }

  // ============ 轨迹加载与渲染 ============
  function loadTrack(points, name, meta) {
    if (!points || points.length < 2) {
      showDiag('轨迹点数不足，无法渲染', true);
      return;
    }
    clearScene();
    clearCompare(); // 加载新轨迹时清除对比轨迹
    // GPS 噪点过滤：剔除跳点/抖动异常（速度异常大且回跳的点）
    points = filterGpsNoise(points);
    state.points = points;

    // 抽稀至 ≤2000 点（性能与流畅度）
    var decimated = core.stats.decimate(points, 2000);
    state.disp = decimated;

    var t0 = decimated[0].t || 0;
    state.times = decimated.map(function (p) { return (p.t || 0) - t0; });
    state.totalMs = state.times[state.times.length - 1] || 1;
    state.playMs = 0;
    state.playing = false;
    state.takeoffAlt = decimated[0].alt;

    var s = core.stats.computeStats(decimated);
    var p0 = decimated[0], p1 = decimated[decimated.length - 1];
    state.curTrack = { name: name, points: points };
    state.stats = s;
    state.meta = meta || null;
    state.states = s.states || [];
    // 飞行得分卡 + 热气流效率报告（v3.9 新增）
    state.score = core.stats.computeScore(s, state.takeoffAlt);
    state.thermalEff = core.stats.thermalEfficiency(s);

    // 坐标自检（起点明显不在中国大陆 → 提示格式问题）
    if (p0.lat < 18 || p0.lat > 54 || p0.lon < 73 || p0.lon > 135) {
      showDiag('起点坐标 (' + p0.lat.toFixed(4) + ',' + p0.lon.toFixed(4) + ') 超出中国大陆范围，请检查 IGC 经纬度格式', true);
    }

    dom.trackName.textContent = name || '飞行轨迹';
    var metaParts = [];
    if (meta && meta.date) metaParts.push(meta.date);
    if (meta && meta.site) metaParts.push(meta.site);
    if (meta && meta.pilot) metaParts.push('飞手 ' + meta.pilot);
    dom.trackMeta.textContent =
      fmtDur(s.durationSec) + ' · ' + (s.totalDistance / 1000).toFixed(1) + ' km · 最高 ' +
      s.maxAlt + ' m · 热气流 ' + (s.thermalCount || 0) + ' 个' +
      (metaParts.length ? ' · ' + metaParts.join(' · ') : '');
    // 气象快照：导入时显示"当日风况预估"（从 IGC H 记录提取）
    var tw = document.getElementById('trackWeather');
    if (tw) {
      var notes = (meta && meta.weather && meta.weather.length) ? meta.weather : [];
      tw.textContent = notes.length ? '🌤 当日风况预估：' + notes.join('；') : '';
      tw.style.display = notes.length ? 'block' : 'none';
    }
    // 飞行摘要卡：留空时长 / 最大相对高度 / 最佳滑翔比 / 飞行得分 / 热气流效率 / 风险段
    var relMax = Math.max(0, s.maxAlt - state.takeoffAlt);
    var bestGlide = bestGlideRatio(decimated);
    var eff = state.thermalEff;
    var dangerSegs = state.states.filter(function (x) { return x.severity >= 2; });
    var sm = document.getElementById('trackSummary');
    if (sm) {
      sm.innerHTML =
        '<span>留空 <b>' + fmtDur(s.durationSec) + '</b></span>' +
        '<span>最大相对高度 <b>' + relMax + ' m</b></span>' +
        '<span>最佳滑翔比 <b>' + bestGlide + ':1</b></span>' +
        '<span>飞行得分 <b>' + (state.score ? state.score.score : '—') + ' 分</b></span>' +
        '<span>热气流 <b>' + (eff ? eff.thermalCount : 0) + ' 个</b></span>' +
        '<span>利用率 <b>' + (eff ? eff.utilizationPct : 0) + '%</b></span>' +
        '<span>总增益 <b>' + (eff ? eff.totalGain : 0) + ' m</b></span>' +
        (dangerSegs.length ? '<span style="color:#f87171">风险段 <b>' + dangerSegs.length + '</b></span>' : '');
      sm.style.cursor = (s.thermalCount > 0) ? 'pointer' : '';
      sm.onclick = (s.thermalCount > 0) ? openThermalDetail : null;
    }
    var cd = document.getElementById('trackCoord');
    if (cd) cd.textContent = '起飞 ' + coordDual(p0.lat, p0.lon) + ' → 降落 ' + coordDual(p1.lat, p1.lon);
    dom.hudTotal.textContent = fmtMs(state.totalMs);

    rebuildScene();
    updateTicks();
    dom.seek.value = 0;
    updateSeekFill();
    updateHud();
  }

  // GPS 噪点过滤：剔除异常跳点（相对前后点速度 > 60m/s 且方向回跳），保留真实飞行轨迹
  function filterGpsNoise(pts) {
    if (!pts || pts.length < 3) return pts;
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      if (i === 0 || i === pts.length - 1) { out.push(p); continue; }
      var a = pts[i - 1], b = pts[i + 1];
      var dt1 = Math.max((p.t - a.t) / 1000, 1);
      var dt2 = Math.max((b.t - p.t) / 1000, 1);
      var d1 = core.geo.haversine(a.lat, a.lon, p.lat, p.lon);
      var d2 = core.geo.haversine(p.lat, p.lon, b.lat, b.lon);
      var sp1 = d1 / dt1, sp2 = d2 / dt2;
      var straight = core.geo.haversine(a.lat, a.lon, b.lat, b.lon);
      // 跳点特征：两侧速度都异常大（>60m/s≈216km/h），且明显回跳（不走直线）
      if (sp1 > 60 && sp2 > 60 && (d1 + d2) > straight * 1.8) continue;
      out.push(p);
    }
    return out;
  }

  // 最佳滑翔比：全程水平速度 / 垂直下降速度的最大值（下降段），限幅 30:1 避免异常
  function bestGlideRatio(pts) {
    var best = 0;
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i];
      var dt = Math.max((b.t - a.t) / 1000, 0.5);
      var down = (a.alt - b.alt) / dt; // 垂直下降速度 m/s
      if (down <= 0.5) continue;
      var hz = core.geo.haversine(a.lat, a.lon, b.lat, b.lon) / dt;
      var g = hz / down;
      if (g > best && g <= 30) best = g;
    }
    return best > 0 ? best.toFixed(1) : '—';
  }

  // 重建轨迹（图源/坐标系切换后调用）
  function rebuildScene() {
    clearScene();
    state.terrainPositions = null;
    buildTerrainAdjustedPositions(function (positions) {
      try {
        state.terrainPositions = positions;
        renderTrack();
        renderPlane();
        renderThermals(state.stats);
        renderMarks();
        renderSites();
        setupChart(state.disp);
        zoomToTrack(positions);
        updateSeekFill();
        updateHud();
      } catch (err) {
        console.error('渲染失败', err);
        showDiag('渲染失败：' + err.message, true);
      }
    });
  }

  // 轨迹高度：
  //   - 贴地（无真实地形默认）：贴地表，奥维式轨迹观感
  //   - 真实（有 Ion 地形）：气压高度为 Z 轴，低于地形自动抬升 35m 与山体对齐
  //   - GCJ 模式（高德底图）：坐标转换 + 贴地
  function buildTerrainAdjustedPositions(cb) {
    var cesium = window.Cesium;
    var pts = state.disp;
    var gcj = state.coordSys === 'gcj';
    var ground = gcj || !state.terrainReady;
    if (ground) {
      var positions = [];
      if (!gcj && state.terrainReady) {
        var cartos = [];
        for (var j = 0; j < pts.length; j++) {
          cartos.push(new cesium.Cartographic(cesium.Math.toRadians(pts[j].lon), cesium.Math.toRadians(pts[j].lat)));
        }
        cesium.sampleTerrainMostDetailed(viewer.terrainProvider, cartos)
          .then(function (updated) {
            for (var k = 0; k < pts.length; k++) {
              var gh = updated[k] && updated[k].height != null ? updated[k].height : 0;
              positions[k] = ptPos(pts[k], gh + 25);
            }
            cb(positions);
          })
          .catch(function () { cb(positions); });
      } else {
        for (var i = 0; i < pts.length; i++) positions.push(ptPos(pts[i], 0));
        cb(positions);
      }
      return;
    }
    // 真实高度：气压高度为 Z，低于地形抬升
    var positionsReal = [];
    for (var m = 0; m < pts.length; m++) positionsReal.push(ptPos(pts[m], pts[m].alt));
    var cartosReal = [];
    for (var n = 0; n < pts.length; n++) {
      cartosReal.push(new cesium.Cartographic(cesium.Math.toRadians(pts[n].lon), cesium.Math.toRadians(pts[n].lat)));
    }
    cesium.sampleTerrainMostDetailed(viewer.terrainProvider, cartosReal)
      .then(function (updated) {
        for (var k = 0; k < pts.length; k++) {
          var groundH = updated[k] && updated[k].height != null ? updated[k].height : pts[k].alt;
          var h = Math.max(pts[k].alt, groundH + 35);
          positionsReal[k] = ptPos(pts[k], h);
        }
        cb(positionsReal);
      })
      .catch(function () { cb(positionsReal); });
  }

  // 轨迹线（径大式尾迹）：
  //   - 加载后未播放：显示整条淡色静态预览线（避免"轨迹消失"故障）
  //   - 播放中：只保留当前播放点往前 30 秒小段（速度渐变：低速蓝/中速黄/高速红，宽 1.8px）
  //   - 30-120 秒前旧轨迹分 3 层逐层淡出消失，不留整条长线
  function renderTrack() {
    var cesium = window.Cesium;
    state.mainPool = [];
    state.tailLayers = [];

    // 静态预览线：整条淡色细线，未播放时可见（颜色随着色模式：速度=蓝 / 爬升=绿 / 滑翔比=青）
    var previewColor = state.colorMode === 'climb' ? '#4ade80' : (state.colorMode === 'glide' ? '#5eead4' : '#38bdf8');
    var preview = viewer.entities.add({
      polyline: {
        positions: state.terrainPositions,
        width: 1.2,
        material: new cesium.PolylineGlowMaterialProperty({
          glowPower: 0.1,
          color: cesium.Color.fromCssColorString(previewColor).withAlpha(0.55)
        }),
        arcType: cesium.ArcType.NONE
      }
    });
    state.previewLine = preview;

    // 渐隐尾迹层（固定淡红色，透明度/宽度逐层递减）
    [
      { from: -60000, to: -30000, alpha: 0.4, width: 1.0 },
      { from: -90000, to: -60000, alpha: 0.15, width: 0.9 },
      { from: -120000, to: -90000, alpha: 0.06, width: 0.9 }
    ].forEach(function (l) {
      var e = viewer.entities.add({
        polyline: {
          positions: [],
          width: l.width,
          material: new cesium.PolylineGlowMaterialProperty({
            glowPower: 0.08,
            color: cesium.Color.fromCssColorString('#f43f5e').withAlpha(l.alpha)
          }),
          arcType: cesium.ArcType.NONE
        }
      });
      e.show = false;
      state.tailLayers.push(e);
    });
    state._lastTailAt = 0;
  }

  // 二分：第一个 >= val 的索引
  function lowerBound(arr, val) {
    var lo = 0, hi = arr.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid] < val) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // 创建主线速度分段实体（池化复用，宽 1.8px 细线）
  function createMainSeg(color) {
    var cesium = window.Cesium;
    var e = viewer.entities.add({
      polyline: {
        positions: [],
        width: 1.8,
        material: new cesium.PolylineGlowMaterialProperty({
          glowPower: 0.12,
          color: cesium.Color.fromCssColorString(color)
        }),
        arcType: cesium.ArcType.NONE
      }
    });
    e.show = false;
    e._color = color; // 记录当前颜色，着色模式切换时更新材质
    state.mainPool.push(e);
    return e;
  }

  // 每帧更新尾迹：当前点往前 30s 主线（速度渐变）+ 逐层淡出的旧轨迹
  // 【播放消失修复】高频改 positions 会让 Cesium 每帧重建 polyline 几何，
  // 播放时主线程过载 → 几何提交延迟 → 看起来"播放无轨迹、暂停才显示"。
  // 修复：① 120ms 时间节流（而非播放位置差值）；② 段级缓存——start/end 未变时
  // 不重设 positions（引用不变 = Cesium 零重建）；③ 窗口点数不足时画兜底小段，绝不全部隐藏。
  function updateTail() {
    if (!state.terrainPositions || !state.disp) return;
    var now = Date.now();
    if (now - state._lastTailAt < 120) return;
    state._lastTailAt = now;

    // 回到起点/未播放时：显示静态预览线（整条淡色），隐藏尾迹窗口
    if (state.playMs <= 100) {
      if (state.previewLine) state.previewLine.show = true;
      state.mainPool.forEach(function (s) { s.show = false; });
      state.tailLayers.forEach(function (l) { l.show = false; });
      return;
    }
    // 播放/拖动时：隐藏预览线，显示 30s 尾迹窗口
    if (state.previewLine) state.previewLine.show = false;

    var pos = state.terrainPositions;
    var t = state.times;
    var play = state.playMs;
    // 观看窗口：无论倍速 1x/2x/4x，画面始终只展示"最近 30 秒观看时间"的轨迹。
    // 窗口原始宽度 = 30s × 倍速（2x 时屏幕上对应原始 60 秒轨迹，30 秒观看时间内淡出完毕）
    var spd = SPEEDS[state.speedIdx];
    var win = 30000 * spd;

    // 段级缓存赋值：起点/终点与上次一致则跳过（positions 引用不变 → Cesium 不重建几何）
    function setSeg(seg, start, end) {
      if (seg._range && seg._range[0] === start && seg._range[1] === end) return;
      seg.polyline.positions = pos.slice(start, end + 1);
      seg._range = [start, end];
    }

    // 轨迹着色：速度（蓝/黄/红）/ 爬升率 / 滑翔比 三种模式（v3.9）
    function segColor(p0, p1) {
      var dt = Math.max((p1.t - p0.t) / 1000, 0.5);
      var d = core.geo.haversine(p0.lat, p0.lon, p1.lat, p1.lon);
      var hz = d / dt;
      var vz = (p1.alt - p0.alt) / dt;
      if (state.colorMode === 'climb') {
        if (vz > 2) return '#22c55e';   // 强爬升 绿
        if (vz > 0) return '#38bdf8';   // 缓爬升 蓝
        if (vz > -1) return '#facc15';  // 缓下降 黄
        return '#f43f5e';               // 快速下沉 红
      }
      if (state.colorMode === 'glide') {
        if (vz > 0.3) return '#38bdf8'; // 爬升中
        var g = hz / Math.max(0.2, -vz);
        if (g > 8) return '#22c55e';    // 高效滑翔 绿
        if (g > 4) return '#38bdf8';    // 良好 蓝
        if (g > 2) return '#facc15';    // 一般 黄
        return '#f43f5e';               // 低效率 红
      }
      var spdK = hz * 3.6;
      if (spdK < 30) return '#38bdf8';  // 低速 蓝
      if (spdK > 60) return '#f43f5e';  // 高速 红
      return '#facc15';                 // 中速 黄
    }

    // —— 主线：窗口 [play-30s×spd, play]，按着色模式分段 ——
    var a = lowerBound(t, Math.max(0, play - win));
    var b = lowerBound(t, play);
    var shown = 0;
    if (b - a >= 2) {
      var runs = [];
      for (var i = a + 1; i < b; i++) {
        var color = segColor(state.disp[i - 1], state.disp[i]);
        var last = runs[runs.length - 1];
        if (last && last.color === color) last.end = i;
        else runs.push({ color: color, start: i - 1, end: i });
      }
      for (var r = 0; r < runs.length; r++) {
        var seg = state.mainPool[r] || createMainSeg(runs[r].color);
        // 着色模式切换后：同池位颜色变化 → 更新材质颜色
        if (seg._color !== runs[r].color) {
          seg.polyline.material = new window.Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.12,
            color: window.Cesium.Color.fromCssColorString(runs[r].color)
          });
          seg._color = runs[r].color;
        }
        setSeg(seg, runs[r].start, runs[r].end);
        seg.show = true;
        shown = r + 1;
      }
    } else {
      // 兜底（绝不出现轨迹消失）：
      // 前 30s 观看窗口内 → 画"起点→当前点"；之后若窗口内点过少（稀疏轨迹）→ 画当前前 3 点小段
      var st = play <= win ? 0 : Math.max(0, b - 3);
      if (b - st >= 1) {
        var seg0 = state.mainPool[0] || createMainSeg('#facc15');
        setSeg(seg0, st, b);
        seg0.show = true;
        shown = 1;
      }
    }
    for (var hide = shown; hide < state.mainPool.length; hide++) state.mainPool[hide].show = false;

    // —— 尾迹层：30-60s / 60-90s / 90-120s 前（观看时间，随倍速缩放），逐层淡出 ——
    [[-60000, -30000, 0], [-90000, -60000, 1], [-120000, -90000, 2]].forEach(function (w, li) {
      var a2 = lowerBound(t, Math.max(0, play + w[0] * spd));
      var b2 = lowerBound(t, Math.max(0, play + w[1] * spd));
      if (b2 - a2 >= 2) {
        setSeg(state.tailLayers[w[2]], a2, b2 - 1);
        state.tailLayers[w[2]].show = true;
      } else {
        state.tailLayers[w[2]].show = false;
      }
    });
  }

  // 当前位置点：纯蓝色实心小圆点（无描边），跟随飞行点位实时移动
  function renderPlane() {
    var cesium = window.Cesium;
    var plane = viewer.entities.add({
      position: new cesium.CallbackProperty(function () {
        var pos = state.terrainPositions;
        if (!pos || !pos.length) return cesium.Cartesian3.ZERO;
        var i = idxAtTime(state.playMs);
        return pos[Math.min(i, pos.length - 1)] || cesium.Cartesian3.ZERO;
      }, false),
      point: {
        pixelSize: 9,
        color: cesium.Color.fromCssColorString('#3b82f6'), // 纯蓝色，无描边
        disableDepthTestDistance: Number.POSITIVE_INFINITY // 不被山体遮挡
      }
    });
    state.planeEntity = plane;
  }

  // 热气流：小型弥散细环形标记（小尺寸、低透明度浅青蓝，只标注上升区域）
  function renderThermals(s) {
    if (!s || !s.thermals || !s.thermals.length) return;
    var cesium = window.Cesium;
    s.thermals.forEach(function (w) {
      var lat = w.centerLat, lon = w.centerLon;
      // 热气流时段内的平均飞行高度
      var sum = 0, n = 0;
      for (var k = 0; k < state.disp.length; k++) {
        var pk = state.disp[k];
        if (pk.t >= w.startT && pk.t <= w.endT) { sum += pk.alt; n++; }
      }
      var alt = n ? sum / n : 800;

      // 两个小尺寸同心细环（浅青蓝，低透明度弥散）
      [55, 30].forEach(function (rr, ri) {
        var ring = viewer.entities.add({
          position: ptPos({ lat: lat, lon: lon }, alt - 30),
          ellipse: {
            semiMajorAxis: rr,
            semiMinorAxis: rr,
            height: alt - 30,
            material: cesium.Color.fromCssColorString('#a5f3fc').withAlpha(0.04),
            outline: true,
            outlineColor: cesium.Color.fromCssColorString('#a5f3fc').withAlpha(ri === 0 ? 0.28 : 0.16),
            outlineWidth: 1
          }
        });
        state.thermalEntities.push(ring);
      });

      // 中心小点 + 爬升率小字
      var dot = viewer.entities.add({
        position: ptPos({ lat: lat, lon: lon }, alt),
        point: {
          pixelSize: 4,
          color: cesium.Color.fromCssColorString('#a5f3fc').withAlpha(0.9)
        },
        label: {
          text: '+' + (w.avgClimb || 0) + 'm/s',
          font: '12px sans-serif',
          pixelOffset: new cesium.Cartesian2(0, -14),
          fillColor: cesium.Color.fromCssColorString('#a5f3fc'),
          showBackground: true,
          backgroundColor: cesium.Color.fromCssColorString('#0f172a').withAlpha(0.6),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
      state.thermalEntities.push(dot);
    });
  }

  // 起飞/降落轻量标记（小圆点 + 文字）
  function renderMarks() {
    var cesium = window.Cesium;
    var first = state.disp[0];
    var last = state.disp[state.disp.length - 1];
    var takeoff = viewer.entities.add({
      position: ptPos(first, first.alt),
      point: {
        pixelSize: 8,
        color: cesium.Color.fromCssColorString('#4ade80'),
        outlineColor: cesium.Color.WHITE, outlineWidth: 2
      },
      label: {
        text: '起飞', font: '12px sans-serif', pixelOffset: new cesium.Cartesian2(0, -16),
        fillColor: cesium.Color.fromCssColorString('#4ade80'), showBackground: true,
        backgroundColor: cesium.Color.fromCssColorString('#0f172a').withAlpha(0.7)
      }
    });
    var land = viewer.entities.add({
      position: ptPos(last, last.alt),
      point: {
        pixelSize: 8,
        color: cesium.Color.fromCssColorString('#f472b6'),
        outlineColor: cesium.Color.WHITE, outlineWidth: 2
      },
      label: {
        text: '降落', font: '12px sans-serif', pixelOffset: new cesium.Cartesian2(0, -16),
        fillColor: cesium.Color.fromCssColorString('#f472b6'), showBackground: true,
        backgroundColor: cesium.Color.fromCssColorString('#0f172a').withAlpha(0.7)
      }
    });
    state.markEntities.push(takeoff, land);
  }

  // ============ 时间轴 / 播放 ============
  function idxAtTime(ms) {
    var times = state.times;
    var lo = 0, hi = times.length - 1;
    if (ms <= times[0]) return 0;
    if (ms >= times[hi]) return hi;
    while (lo < hi - 1) {
      var mid = (lo + hi) >> 1;
      if (times[mid] <= ms) lo = mid; else hi = mid;
    }
    return lo;
  }

  function togglePlay() {
    state.playing = !state.playing;
    dom.play.textContent = state.playing ? '❚❚' : '▶';
  }

  function cycleSpeed() {
    state.speedIdx = (state.speedIdx + 1) % SPEEDS.length;
    dom.speed.textContent = SPEED_NAMES[state.speedIdx];
  }

  function onSeek(e) {
    var f = Number(e.target.value) / 1000;
    state.playMs = f * state.totalMs;
    updateSeekFill();
    updateHud();
    syncChartCursor();
  }

  function updateSeekFill() {
    var f = state.totalMs ? state.playMs / state.totalMs : 0;
    dom.seek.style.setProperty('--p', (f * 100).toFixed(2) + '%');
  }

  function updateTicks() {
    var n = state.disp ? state.disp.length - 1 : 0;
    [0, 0.25, 0.5, 0.75, 1].forEach(function (f, k) {
      var i = Math.round(n * f);
      dom.ticks[k].textContent = fmtMs(state.times ? state.times[i] : 0);
    });
    // 姿态异常红点（severity>=2：俯仰振荡/急转/螺旋/全失速等）标注在时间轴上，点击跳转
    var row = dom.seek.parentNode.querySelector('.tick-row');
    if (!row) return;
    row.querySelectorAll('.state-dot').forEach(function (d) { d.remove(); });
    (state.states || []).forEach(function (seg) {
      if (seg.severity < 2) return;
      var left = state.totalMs > 0 ? (seg.startT / state.totalMs) * 100 : 0;
      var dot = document.createElement('span');
      dot.className = 'state-dot';
      dot.title = seg.label + ' ' + fmtMs(seg.startT) + '-' + fmtMs(seg.endT);
      dot.style.left = Math.max(0, Math.min(100, left)) + '%';
      dot.addEventListener('click', function (ev) {
        ev.stopPropagation();
        state.playMs = seg.startT;
        dom.seek.value = Math.round((state.playMs / state.totalMs) * 1000);
        updateSeekFill();
        updateHud();
        syncChartCursor();
      });
      row.appendChild(dot);
    });
  }

  // 主循环（rAF 驱动播放）
  // 【性能加固】非复盘视图（社区/飞行记录）下跳过全部重型更新（播放推进/尾迹/闯入检测），
  // tick 仅保留轻量 rAF，保证切页后页面流畅、按钮即时响应。
  var _lastT = 0;
  function tick() {
    var inReplay = document.body.dataset.view === 'replay';
    if (inReplay && state.playing && state.totalMs > 1) {
      var now = Date.now();
      var dt = Math.min((now - (_lastT || now)) / 1000, 0.1);
      _lastT = now;
      state.playMs += dt * 1000 * SPEEDS[state.speedIdx];
      if (state.playMs >= state.totalMs) {
        state.playMs = state.totalMs;
        state.playing = false;
        dom.play.textContent = '▶';
      }
      dom.seek.value = Math.round((state.playMs / state.totalMs) * 1000);
      updateSeekFill();
      updateHud();
      syncChartCursor();
    } else {
      _lastT = Date.now();
    }
    if (inReplay) {
      updateTail(); // 尾迹窗口跟随播放位置（含拖动跳转）
      checkDangerZone(); // 禁飞危险区域闯入告警
    }
    requestAnimationFrame(tick);
  }

  // ============ 数据面板（高度/相对/升降/速度/滑翔比/时间） ============
  var _lastHud = 0;
  function updateHud() {
    var now = Date.now();
    if (now - _lastHud < 120) return;
    _lastHud = now;
    var pts = state.disp;
    if (!pts) return;
    var i = idxAtTime(state.playMs);
    var p = pts[i];
    var prev = pts[Math.max(0, i - 1)];
    var dt = Math.max((p.t - prev.t) / 1000, 0.5);
    var dist = core.geo.haversine(prev.lat, prev.lon, p.lat, p.lon);
    var hSpeed = dist / dt;               // m/s
    var vSpeed = (p.alt - prev.alt) / dt; // m/s 垂直速度（正=上升）
    var relAlt = p.alt - state.takeoffAlt;

    dom.hudAlt.textContent = Math.round(p.alt);
    dom.hudRel.textContent = Math.round(relAlt);
    dom.hudClimb.textContent = vSpeed.toFixed(1);
    dom.hudClimb.style.color = vSpeed > 0.3 ? '#4ade80' : vSpeed < -0.3 ? '#f87171' : '#7dd3fc';
    dom.hudSpeed.textContent = Math.round(hSpeed * 3.6);
    // 滑翔比 = 水平速度 / |垂直速度|（下降时有效）
    if (vSpeed < -0.1) {
      var glide = hSpeed / Math.abs(vSpeed);
      dom.hudGlide.textContent = glide > 99 ? '99' : glide.toFixed(1);
    } else {
      dom.hudGlide.textContent = '↑';
    }
    dom.hudTime.textContent = fmtMs(state.playMs);

    // 姿态实时显示（伞状态判定）：当前播放点所在状态段 → HUD 姿态行 + 异常告警条
    var seg = stateAtTime(state.playMs);
    var hudState = document.getElementById('hudState');
    if (hudState) {
      if (seg) {
        hudState.textContent = seg.label;
        hudState.style.color = seg.severity >= 2 ? '#f43f5e' : (seg.severity === 1 ? '#fbbf24' : '#38bdf8');
      } else {
        hudState.textContent = '巡航';
        hudState.style.color = '#38bdf8';
      }
    }
    var sbar = document.getElementById('stateBar');
    if (sbar) {
      if (seg && seg.severity >= 2) {
        sbar.style.display = 'block';
        sbar.textContent = '⚠ 姿态风险：' + seg.label + '（' + fmtMs(seg.startT) + ' - ' + fmtMs(seg.endT) + '）复盘学习，请勿模仿';
      } else {
        sbar.style.display = 'none';
      }
    }
  }

  // 当前时间点对应的姿态状态段（含起飞/降落覆盖逻辑外的风险判定）
  function stateAtTime(ms) {
    if (!state.states || !state.states.length || !state.times) return null;
    var t = ms;
    for (var k = 0; k < state.states.length; k++) {
      var seg = state.states[k];
      if (t >= seg.startT && t <= seg.endT) return seg;
    }
    return null;
  }

  // ============ 相机 ============
  function toggleFollow() {
    state.follow = !state.follow;
    dom.follow.textContent = '相机: ' + (state.follow ? '跟随' : '自由');
    if (state.follow && state.planeEntity) {
      viewer.trackedEntity = state.planeEntity; // Cesium 自动平滑跟随
    } else {
      viewer.trackedEntity = undefined;
    }
  }

  // 导入/切换图源后：自动定位跳转到本次飞行起飞点位（无需手动拖动找飞行区域）
  function zoomToTrack(positions) {
    var cesium = window.Cesium;
    try {
      var p0 = state.disp[0];
      if (!p0) return;
      var dest = cesium.Cartesian3.fromDegrees(p0.lon, p0.lat, Math.max(p0.alt, 300) + 1200);
      viewer.camera.flyTo({
        destination: dest,
        orientation: { heading: 0, pitch: -Math.PI / 3, roll: 0 },
        duration: 1.5
      });
    } catch (e) {
      if (positions && positions[0]) viewer.camera.setView({ destination: positions[0] });
    }
  }

  // ============ 图层切换（天地图/OpenTopoMap/高德/ESRI） ============
  function switchSource(key) {
    var src = SOURCES[key];
    if (!src) return;
    var cesium = window.Cesium;
    // 天地图需要 key
    if (key === 'tianditu' && !TIANDITU_KEY) {
      showDiag('天地图需要免费 key：https://console.tianditu.gov.cn 申请后填入 index.html 顶部 TIANDITU_KEY', false);
      return;
    }
    var layers = viewer.imageryLayers;
    layers.removeAll();
    var opt = { url: src.url, maximumLevel: 18 };
    if (src.subdomains) opt.subdomains = src.subdomains;
    layers.addImageryProvider(new cesium.UrlTemplateImageryProvider(opt));
    document.querySelectorAll('#sourceGroup .btn').forEach(function (b) {
      b.classList.toggle('btn-active', b.dataset.src === key);
    });
    // 坐标系联动：高德(GCJ-02) 转换轨迹；其余 WGS84 保持
    var newCoord = src.wgs === false ? 'gcj' : 'wgs';
    if (newCoord !== state.coordSys) {
      state.coordSys = newCoord;
      if (state.disp) rebuildScene();
    }
  }

  // ============ 滑翔基地图层（管理员绘制：起飞场/降落场/危险禁飞多边形） ============
  // 从 IndexedDB 加载管理员绘制的基地点位/区域
  function refreshSitesFromDB(cb) {
    window.SanjiStore.getAll('sites').then(function (list) {
      SITES.takeoffs = list.filter(function (s) { return s.type === 'takeoff'; });
      SITES.landings = list.filter(function (s) { return s.type === 'landing'; });
      SITES.dangerZones = list.filter(function (s) { return s.type === 'danger'; });
      if (cb) cb();
    });
  }

  // 渲染基地图层实体（起飞场绿点 / 降落场蓝点 / 危险禁飞多边形红色半透明）
  function renderSites() {
    var cesium = window.Cesium;
    // 起飞场
    SITES.takeoffs.forEach(function (s) {
      var e = viewer.entities.add({
        position: ptPos({ lat: s.lat, lon: s.lon }, 0),
        point: {
          pixelSize: 10,
          color: cesium.Color.fromCssColorString('#4ade80'),
          outlineColor: cesium.Color.WHITE, outlineWidth: 1.5
        },
        label: {
          text: '起飞场·' + s.name, font: '11px sans-serif',
          pixelOffset: new cesium.Cartesian2(0, -18),
          fillColor: cesium.Color.fromCssColorString('#4ade80'), showBackground: true,
          backgroundColor: cesium.Color.fromCssColorString('#0f172a').withAlpha(0.7),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
      // 拖拽/删除标记（管理员编辑模式用）
      e._siteId = s.id; e._siteType = 'takeoff';
      state.siteEntities.push(e);
    });
    // 降落场
    SITES.landings.forEach(function (s) {
      var e = viewer.entities.add({
        position: ptPos({ lat: s.lat, lon: s.lon }, 0),
        point: {
          pixelSize: 10,
          color: cesium.Color.fromCssColorString('#60a5fa'),
          outlineColor: cesium.Color.WHITE, outlineWidth: 1.5
        },
        label: {
          text: '降落场·' + s.name, font: '11px sans-serif',
          pixelOffset: new cesium.Cartesian2(0, -18),
          fillColor: cesium.Color.fromCssColorString('#60a5fa'), showBackground: true,
          backgroundColor: cesium.Color.fromCssColorString('#0f172a').withAlpha(0.7),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
      e._siteId = s.id; e._siteType = 'landing';
      state.siteEntities.push(e);
    });
    // 危险 / 禁飞区域（管理员手绘多边形，半透明红 + 名称备注）
    SITES.dangerZones.forEach(function (s) {
      if (!s.polygon || s.polygon.length < 3) return;
      var ces = window.Cesium;
      var positions = s.polygon.map(function (p) {
        return ces.Cartesian3.fromDegrees(p.lon, p.lat, 0);
      });
      var e = viewer.entities.add({
        polygon: {
          hierarchy: positions,
          height: 0,
          material: ces.Color.fromCssColorString('#ef4444').withAlpha(0.14),
          outline: true,
          outlineColor: ces.Color.fromCssColorString('#ef4444').withAlpha(0.8),
          outlineWidth: 1.5
        },
        label: {
          text: '⚠ ' + s.name + (s.note ? '\n' + s.note : ''),
          font: '11px sans-serif',
          pixelOffset: new ces.Cartesian2(0, 0),
          fillColor: ces.Color.fromCssColorString('#fca5a5'),
          showBackground: true,
          backgroundColor: ces.Color.fromCssColorString('#0f172a').withAlpha(0.8),
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
      e._siteId = s.id; e._siteType = 'danger';
      state.siteEntities.push(e);
    });
    applySitesVisible();
  }

  // 基地图层开关（默认关闭）
  function toggleSites() {
    state.sitesVisible = !state.sitesVisible;
    var btn = document.getElementById('btnSites');
    if (btn) {
      btn.classList.toggle('btn-active', state.sitesVisible);
      btn.textContent = '基地图层' + (state.sitesVisible ? '' : '·关');
    }
    applySitesVisible();
  }

  function applySitesVisible() {
    state.siteEntities.forEach(function (e) { e.show = state.sitesVisible; });
  }

  // 点在多边形内判断（射线法）
  function pointInPolygon(lat, lon, pts) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var xi = pts[i].lon, yi = pts[i].lat;
      var xj = pts[j].lon, yj = pts[j].lat;
      var intersect = ((yi > lat) !== (yj > lat)) &&
        (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // 禁飞闯入检测：进入管理员绘制的危险/禁飞多边形 → 红色高亮告警
  var _lastDangerCheck = 0;
  function checkDangerZone() {
    if (!state.disp) return;
    // 200ms 节流：降低每帧计算压力（飞行无法瞬间穿越区域，200ms 判定足够实时）
    var nowT = Date.now();
    if (nowT - _lastDangerCheck < 200) return;
    _lastDangerCheck = nowT;
    var i = idxAtTime(state.playMs);
    var p = state.disp[i];
    if (!p) return;
    var inDanger = false;
    for (var k = 0; k < SITES.dangerZones.length; k++) {
      var z = SITES.dangerZones[k];
      if (z.polygon && z.polygon.length >= 3 && pointInPolygon(p.lat, p.lon, z.polygon)) {
        inDanger = true;
        break;
      }
    }
    var bar = document.getElementById('dangerBar');
    if (inDanger !== state.danger) {
      state.danger = inDanger;
      if (bar) bar.style.display = inDanger ? 'block' : 'none';
      if (bar) bar.textContent = inDanger ? '⚠ 已进入危险/禁飞区域！复盘风险，请勿模仿' : '';
      // 飞机标记红色高亮（叠加红点）
      if (state.planeEntity) {
        if (inDanger && !state.dangerPoint) {
          state.dangerPoint = viewer.entities.add({
            position: new window.Cesium.CallbackProperty(function () {
              var pos = state.terrainPositions;
              if (!pos || !pos.length) return window.Cesium.Cartesian3.ZERO;
              var ii = idxAtTime(state.playMs);
              return pos[Math.min(ii, pos.length - 1)] || window.Cesium.Cartesian3.ZERO;
            }, false),
            point: { pixelSize: 12, color: window.Cesium.Color.fromCssColorString('#ef4444').withAlpha(0.85) }
          });
        } else if (!inDanger && state.dangerPoint) {
          viewer.entities.remove(state.dangerPoint);
          state.dangerPoint = null;
        }
      }
    }
  }

  // ============ 基地管理员：点位拖拽校准 + 危险区域手绘 ============
  var dragHandler = null;   // 点位拖拽事件
  var drawHandler = null;   // 多边形绘制事件
  var drawState = { mode: null, base: '', pts: [], temp: [] };

  // 启用/停用点位拖拽（仅基地管理员编辑模式）
  function enableSiteDrag(on) {
    if (dragHandler) { dragHandler.destroy(); dragHandler = null; }
    if (!on) return;
    var cesium = window.Cesium;
    dragHandler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    var picked = null, moved = false;
    dragHandler.setInputAction(function (e) {
      var obj = viewer.scene.pick(e.position);
      var ent = obj && obj.id;
      if (ent && ent._siteId && (ent._siteType === 'takeoff' || ent._siteType === 'landing')) {
        picked = ent;
        moved = false;
        viewer.scene.screenSpaceCameraController.enableRotate = false;
      }
    }, cesium.ScreenSpaceEventType.LEFT_DOWN);
    dragHandler.setInputAction(function (e) {
      if (!picked) return;
      moved = true;
      var cart = viewer.camera.pickEllipsoid(e.endPosition, viewer.scene.globe.ellipsoid);
      if (cart) {
        var c = cesium.Cartographic.fromCartesian(cart);
        picked.position = cesium.Cartesian3.fromRadians(c.longitude, c.latitude, 0);
      }
    }, cesium.ScreenSpaceEventType.MOUSE_MOVE);
    dragHandler.setInputAction(function (e) {
      if (picked && moved) {
        var cart = viewer.camera.pickEllipsoid(e.position, viewer.scene.globe.ellipsoid);
        if (cart) {
          var c = cesium.Cartographic.fromCartesian(cart);
          var lat = c.latitude * 180 / Math.PI;
          var lon = c.longitude * 180 / Math.PI;
          // 保存新坐标到 IndexedDB（拖拽校准）
          window.SanjiStore.getAll('sites').then(function (list) {
            var s = list.filter(function (x) { return x.id === picked._siteId; })[0];
            if (s) {
              s.lat = lat; s.lon = lon;
              return window.SanjiStore.put('sites', s);
            }
          }).then(function () {
            // 同步内存中的 SITES，供后续重建使用
            var m = SITES.takeoffs.concat(SITES.landings).filter(function (x) {
              return x.id === picked._siteId;
            })[0];
            if (m) { m.lat = lat; m.lon = lon; }
            showDiag('起飞/降落场坐标已校准 (' + lat.toFixed(5) + ',' + lon.toFixed(5) + ')', false);
          });
        }
      }
      picked = null;
      viewer.scene.screenSpaceCameraController.enableRotate = true;
    }, cesium.ScreenSpaceEventType.LEFT_UP);
  }

  // 开始手绘危险/禁飞区域多边形
  function startDraw(mode, base) {
    stopDraw();
    drawState.mode = mode;      // 'danger'
    drawState.base = base;
    drawState.pts = [];
    drawState.temp = [];
    var cesium = window.Cesium;
    drawHandler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    drawHandler.setInputAction(function (e) {
      var cart = viewer.camera.pickEllipsoid(e.position, viewer.scene.globe.ellipsoid);
      if (!cart) return;
      var c = cesium.Cartographic.fromCartesian(cart);
      drawState.pts.push({ lat: c.latitude * 180 / Math.PI, lon: c.longitude * 180 / Math.PI });
      // 临时顶点标记
      drawState.temp.push(viewer.entities.add({
        position: cesium.Cartesian3.fromRadians(c.longitude, c.latitude, 0),
        point: { pixelSize: 7, color: cesium.Color.fromCssColorString('#f87171') }
      }));
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);
    showDiag('绘制模式：点击地图添加顶点（至少 3 个），完成后在弹层点「保存区域」', false);
  }

  function stopDraw() {
    if (drawHandler) { drawHandler.destroy(); drawHandler = null; }
    drawState.temp.forEach(function (e) { viewer.entities.remove(e); });
    drawState.temp = [];
  }

  // 保存绘制的危险/禁飞区域（含名称与备注）
  function saveDrawnZone(name, note, base) {
    if (drawState.pts.length < 3) { showDiag('至少绘制 3 个顶点', true); return; }
    window.SanjiStore.me().then(function (u) {
      if (!u || u.role !== 'admin') { showDiag('仅基地管理员可绘制区域', true); return null; }
      return window.SanjiStore.add('sites', {
        type: 'danger',
        base: base || (u.base || ''),
        name: name || '危险/禁飞区域',
        note: note || '',
        polygon: drawState.pts,
        authorId: u.id,
        createdAt: Date.now()
      });
    }).then(function (id) {
      if (id) {
        stopDraw();
        drawState.pts = [];
        refreshSitesFromDB(function () {
          rebuildScene();
          refreshSiteAdmin();
          showDiag('危险区域已保存 ✓', false);
        });
      }
    });
  }

  // 删除点位/区域（仅创建者管理员）
  function deleteSiteById(id) {
    window.SanjiStore.me().then(function (u) {
      if (!u || u.role !== 'admin') { showDiag('仅基地管理员可删除', true); return null; }
      return window.SanjiStore.getAll('sites').then(function (list) {
        var s = list.filter(function (x) { return x.id === id; })[0];
        if (!s) return null;
        if (s.authorId !== u.id) { showDiag('只能删除自己绘制的点位/区域', true); return null; }
        if (!confirm('删除该点位/区域？')) return null;
        return window.SanjiStore.del('sites', id).then(function () { return true; });
      });
    }).then(function (ok) {
      if (ok) {
        refreshSitesFromDB(function () {
          rebuildScene();
          refreshSiteAdmin();
          showDiag('已删除 ✓', false);
        });
      }
    });
  }

  // ---- 基地管理界面（仅基地管理员） ----
  var placeState = { mode: null, lat: 0, lon: 0, handler: null, base: '' };

  function openSiteAdmin() {
    window.SanjiStore.me().then(function (u) {
      if (!u || u.role !== 'admin') { showDiag('仅基地管理员可管理基地', true); return; }
      document.getElementById('siteAdminModal').classList.add('show');
      refreshSiteAdmin();
    });
  }

  // 渲染基地管理面板：我的基地 / 起降场管理 / 危险区域管理
  function refreshSiteAdmin() {
    var body = document.getElementById('siteAdminBody');
    window.SanjiStore.me().then(function (u) {
      if (!u) return;
      window.SanjiStore.getAll('sites').then(function (list) {
        var mine = list.filter(function (s) { return s.authorId === u.id; });
        var takeoffs = mine.filter(function (s) { return s.type === 'takeoff'; });
        var landings = mine.filter(function (s) { return s.type === 'landing'; });
        var dangers = mine.filter(function (s) { return s.type === 'danger'; });

        var html = '<div class="auth-fields">' +
          '<label>当前管理的基地<input type="text" id="siteAdminBase" value="' + esc(u.base || '') + '" /></label>' +
          '</div>' +
          (drawState.pts.length >= 1 ? '<div style="background:rgba(244,63,94,.12);border:1px solid rgba(244,63,94,.4);border-radius:8px;padding:8px 10px;margin:8px 0;font-size:12px;color:#fda4af">' +
            '绘制中：已点 ' + drawState.pts.length + ' 个顶点（点击地图继续添加）' +
            '<div style="margin-top:6px;display:flex;gap:6px">' +
            '<button class="mini-btn mini-primary" id="btnSaveDrawn">保存区域</button>' +
            '<button class="mini-btn" id="btnCancelDrawn">放弃</button>' +
            '</div></div>' : '') +
          '<div style="font-size:12px;color:#94a3b8;margin:8px 0 4px">起飞场（' + takeoffs.length + '）</div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">' +
          '<button class="mini-btn" data-add="takeoff">＋ 添加起飞场（地图点选）</button>' +
          '<button class="mini-btn" id="btnDrag" data-drag="1">拖拽校准</button>' +
          '</div>' +
          siteListHtml(takeoffs) +
          '<div style="font-size:12px;color:#94a3b8;margin:8px 0 4px">降落场（' + landings.length + '）</div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">' +
          '<button class="mini-btn" data-add="landing">＋ 添加降落场（地图点选）</button>' +
          '</div>' +
          siteListHtml(landings) +
          '<div style="font-size:12px;color:#94a3b8;margin:8px 0 4px">危险/禁飞区域（' + dangers.length + '）</div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">' +
          '<button class="mini-btn mini-primary" id="btnDrawZone">✏ 手绘危险/禁飞区</button>' +
          '</div>' +
          (dangers.length ? dangers.map(function (d) {
            return '<div class="fl-log-card">' +
              '<div class="fl-log-title">⚠ ' + esc(d.name) + '</div>' +
              '<div class="fl-log-meta"><span>' + esc(d.base) + '</span><span>' + (d.polygon ? d.polygon.length + ' 顶点' : '') + '</span></div>' +
              (d.note ? '<div class="fl-log-note">' + esc(d.note) + '</div>' : '') +
              '<div class="card-foot"><span></span>' +
              '<button class="mini-btn mini-danger" data-del-site="' + d.id + '">删除</button></div></div>';
          }).join('') : '<div class="empty-tip" style="padding:12px 0">还没有危险区域，点上方按钮在地图上手绘多边形</div>') +
          '<div style="font-size:11px;color:#64748b;margin-top:8px">提示：普通伞友可查看你绘制的起降场与危险区域，用于学习风险知识。</div>';

        body.innerHTML = html;
        body.querySelectorAll('[data-add]').forEach(function (b) {
          b.addEventListener('click', function () { startPlace(b.dataset.add); });
        });
        body.querySelectorAll('[data-del-site]').forEach(function (b) {
          b.addEventListener('click', function () { deleteSiteById(Number(b.dataset.delSite)); });
        });
        var dragBtn = document.getElementById('btnDrag');
        if (dragBtn) {
          var dragging = dragBtn.dataset.drag === '1';
          dragBtn.textContent = dragging ? '拖拽校准（进行中…在地图上拖动起降场点）' : '拖拽校准';
          dragBtn.classList.toggle('mini-primary', dragging);
          dragBtn.addEventListener('click', function () {
            var next = dragBtn.dataset.drag !== '1';
            dragBtn.dataset.drag = next ? '1' : '0';
            enableSiteDrag(next);
            if (next) showDiag('拖拽模式：在地图上按住起降场小点拖动校准', false);
            else showDiag('拖拽模式已关闭', false);
            refreshSiteAdmin();
          });
        }
        var drawBtn = document.getElementById('btnDrawZone');
        if (drawBtn) {
          drawBtn.addEventListener('click', function () {
            var base = document.getElementById('siteAdminBase').value.trim() || u.base || '';
            enableSiteDrag(false);
            startDraw('danger', base);
            document.getElementById('siteAdminModal').classList.remove('show');
            showDiag('手绘模式：点击地图依次添加顶点（至少 3 个），完成后重新打开基地管理点「保存区域」', false);
          });
        }
        // 绘制中：保存 / 放弃
        var saveDrawnBtn = document.getElementById('btnSaveDrawn');
        if (saveDrawnBtn) {
          saveDrawnBtn.addEventListener('click', function () {
            document.getElementById('drawModal').classList.add('show');
          });
        }
        var cancelDrawnBtn = document.getElementById('btnCancelDrawn');
        if (cancelDrawnBtn) {
          cancelDrawnBtn.addEventListener('click', function () {
            stopDraw();
            drawState.pts = [];
            refreshSiteAdmin();
            showDiag('已放弃绘制', false);
          });
        }
      });
    });
  }

  function siteListHtml(items) {
    if (!items.length) return '<div class="empty-tip" style="padding:10px 0">暂无点位</div>';
    return items.map(function (s) {
      return '<div class="fl-log-card">' +
        '<div class="fl-log-title">' + esc(s.name) + '</div>' +
        '<div class="fl-log-meta"><span>' + s.lat.toFixed(5) + ',' + s.lon.toFixed(5) + '</span>' +
        '<span>拖拽可校准</span></div>' +
        '<div class="card-foot"><span></span>' +
        '<button class="mini-btn mini-danger" data-del-site="' + s.id + '">删除</button></div></div>';
    }).join('');
  }

  // 地图点选添加起飞/降落场
  function startPlace(mode) {
    enableSiteDrag(false);
    stopDraw();
    placeState.mode = mode; // 'takeoff' | 'landing'
    placeState.base = document.getElementById('siteAdminBase').value.trim() || '';
    var cesium = window.Cesium;
    placeState.handler = new cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    placeState.handler.setInputAction(function (e) {
      var cart = viewer.camera.pickEllipsoid(e.position, viewer.scene.globe.ellipsoid);
      if (!cart) return;
      var c = cesium.Cartographic.fromCartesian(cart);
      placeState.lat = c.latitude * 180 / Math.PI;
      placeState.lon = c.longitude * 180 / Math.PI;
      placeState.handler.destroy();
      placeState.handler = null;
      document.getElementById('placeTitle').textContent = mode === 'takeoff' ? '添加起飞场' : '添加降落场';
      document.getElementById('placeName').value = '';
      document.getElementById('placeCoord').textContent =
        '已选坐标 ' + placeState.lat.toFixed(5) + ',' + placeState.lon.toFixed(5);
      document.getElementById('placeModal').classList.add('show');
    }, cesium.ScreenSpaceEventType.LEFT_CLICK);
    showDiag('点选模式：点击地图确定' + (mode === 'takeoff' ? '起飞场' : '降落场') + '位置', false);
  }

  function savePlacedSite() {
    var name = document.getElementById('placeName').value.trim() || '未命名点位';
    if (!placeState.mode) { showDiag('请先在地图上点选位置', true); return; }
    window.SanjiStore.me().then(function (u) {
      if (!u || u.role !== 'admin') { showDiag('仅基地管理员可添加', true); return null; }
      return window.SanjiStore.add('sites', {
        type: placeState.mode,
        base: placeState.base || (u.base || ''),
        name: name,
        lat: placeState.lat,
        lon: placeState.lon,
        authorId: u.id,
        createdAt: Date.now()
      });
    }).then(function (id) {
      if (id) {
        placeState.mode = null;
        document.getElementById('placeModal').classList.remove('show');
        refreshSitesFromDB(function () {
          rebuildScene();
          refreshSiteAdmin();
          showDiag('点位已保存 ✓', false);
        });
      }
    });
  }

  // ============ 高度曲线（ECharts 联动） ============
  function toggleChart() {
    dom.chartPanel.classList.toggle('show');
    if (state.chart) state.chart.resize();
  }

  function setupChart(pts) {
    if (!window.echarts) return;
    var data = pts.map(function (p, i) {
      return [state.times[i] / 1000, Math.round(p.alt)];
    });
    state.chartData = data;
    // 综合剖面：速度(km/h) 与 升降(m/s) 逐点计算（v3.9 新增双轴）
    var speedData = [0];
    var climbData = [0];
    for (var i = 1; i < pts.length; i++) {
      var dt = Math.max((pts[i].t - pts[i - 1].t) / 1000, 0.5);
      var d = core.geo.haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
      speedData.push(Math.round((d / dt) * 3.6));
      climbData.push(Math.round(((pts[i].alt - pts[i - 1].alt) / dt) * 10) / 10);
    }
    if (!state.chart) state.chart = window.echarts.init(dom.chartBox);
    state.chart.setOption({
      backgroundColor: 'transparent',
      grid: { left: 40, right: 44, top: 18, bottom: 24 },
      tooltip: {
        trigger: 'axis',
        formatter: function (ps) {
          var v = ps[0];
          var sp = ps[1], cl = ps[2];
          var html = v.value[0] + 's · ' + v.value[1] + ' m';
          if (sp && sp.value && sp.value[1] != null) html += '<br/>速度 ' + sp.value[1] + ' km/h';
          if (cl && cl.value && cl.value[1] != null) html += '<br/>升降 ' + cl.value[1] + ' m/s';
          return html;
        }
      },
      xAxis: {
        type: 'value', min: 0, max: Math.ceil(state.totalMs / 1000),
        axisLabel: { color: '#64748b', fontSize: 10, formatter: function (v) { return fmtMs(v * 1000); } },
        splitLine: { lineStyle: { color: 'rgba(148,163,184,.12)' } }
      },
      yAxis: [
        {
          type: 'value', name: '高度 m', nameTextStyle: { color: '#64748b', fontSize: 10 },
          axisLabel: { color: '#64748b', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(148,163,184,.12)' } }
        },
        {
          type: 'value', name: '速度', nameTextStyle: { color: '#38bdf8', fontSize: 9 },
          axisLabel: { color: '#64748b', fontSize: 9, formatter: '{value}' },
          splitLine: { show: false }, min: 0
        },
        {
          type: 'value', name: '升降', nameTextStyle: { color: '#4ade80', fontSize: 9 },
          axisLabel: { color: '#64748b', fontSize: 9, formatter: '{value}' },
          splitLine: { show: false }
        }
      ],
      series: [
        {
          type: 'line', name: '高度', data: data, symbol: 'none', smooth: true,
          lineStyle: { width: 1.5, color: '#38bdf8' },
          areaStyle: { color: 'rgba(56,189,248,.12)' },
          markLine: {
            silent: true, symbol: 'none',
            lineStyle: { color: '#f87171', width: 1 },
            label: { show: false },
            data: [{ xAxis: 0 }]
          }
        },
        {
          type: 'line', name: '速度', data: speedData, symbol: 'none', smooth: true, yAxisIndex: 1,
          lineStyle: { width: 1, color: 'rgba(125,211,252,.55)' }
        },
        {
          type: 'line', name: '升降', data: climbData, symbol: 'none', smooth: true, yAxisIndex: 2,
          lineStyle: { width: 1, color: 'rgba(74,222,128,.5)' }
        }
      ]
    });
    // 点曲线跳转播放位置
    state.chart.getZr().on('click', function (ev) {
      var point = state.chart.convertFromPixel({ seriesIndex: 0 }, [ev.offsetX, ev.offsetY]);
      if (point && point[0] != null) {
        state.playMs = point[0] * 1000;
        dom.seek.value = Math.round((state.playMs / state.totalMs) * 1000);
        updateSeekFill();
        updateHud();
        syncChartCursor();
      }
    });
    // 鼠标悬停曲线：暂停播放 + 3D 镜头同步跳转到对应飞行点位
    // 用 setView 瞬时跳转（避免 flyTo 动画反复打断导致界面卡顿/按钮无响应）
    var _hoverLast = 0;
    var _hoverActive = false;
    state.chart.getZr().on('mousemove', function (ev) {
      if (!_hoverActive) return;
      var now = Date.now();
      if (now - _hoverLast < 200) return;
      var point = state.chart.convertFromPixel({ seriesIndex: 0 }, [ev.offsetX, ev.offsetY]);
      if (!point || point[0] == null) return;
      _hoverLast = now;
      var idx = idxAtTime(point[0] * 1000);
      var p = state.disp[idx];
      var pos = state.terrainPositions && state.terrainPositions[idx];
      if (!p || !pos) return;
      // 暂停播放（悬停预览），同步进度条/HUD/尾迹
      state.playing = false;
      dom.play.textContent = '▶';
      state.playMs = state.times[idx];
      dom.seek.value = Math.round((state.playMs / state.totalMs) * 1000);
      updateSeekFill();
      updateHud();
      syncChartCursor();
      // 镜头瞬时跳转到该点位上空
      try {
        var cesium = window.Cesium;
        var dest = cesium.Cartesian3.fromDegrees(p.lon, p.lat, Math.max(p.alt, 200) + 400);
        viewer.camera.setView({
          destination: dest,
          orientation: { heading: 0, pitch: -Math.PI / 3.5, roll: 0 }
        });
      } catch (e) { /* 忽略相机异常 */ }
    });
    // 鼠标进入/离开曲线面板：控制悬停联动开关
    state.chart.getZr().on('mouseover', function () { _hoverActive = true; });
    state.chart.getZr().on('mouseout', function () { _hoverActive = false; });
  }

  var _lastCursor = 0;
  function syncChartCursor() {
    if (!state.chart) return;
    // 播放中每帧 setOption 会触发 ECharts 全量重绘，占满主线程导致 Cesium 轨迹渲染饥饿（播放消失/暂停才显示的根因）
    // → 250ms 节流，仅时间刻度变化时重绘
    var now = Date.now();
    if (now - _lastCursor < 250) return;
    _lastCursor = now;
    state.chart.setOption({
      series: [{ markLine: { data: [{ xAxis: state.playMs / 1000 }] } }]
    });
  }

  // ============ 视图切换（复盘 / 社区 / 飞行记录） ============
  // 【导航卡死修复】此前 setView 缺失导致点击 Tab 抛 ReferenceError、页面无响应。
  // 补齐定义：切页自动暂停回放 + 取消相机飞行动画，保证播放/暂停任意状态下点击即时响应。
  function setView(v) {
    if (document.body.dataset.view === v) return;
    // 切页自动暂停回放：释放主线程（进度保留，切回可续播）
    if (state.playing) {
      state.playing = false;
      dom.play.textContent = '▶';
    }
    // 取消进行中的相机飞行动画（如导入后自动飞向起飞点），避免占用渲染
    if (viewer && viewer.camera && viewer.camera.cancelFlight) {
      try { viewer.camera.cancelFlight(); } catch (e) { /* 旧版 Cesium 无此方法 */ }
    }
    document.body.dataset.view = v;
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.classList.toggle('tab-active', b.dataset.view === v);
    });
    if (v === 'replay') {
      if (viewer) viewer.resize();
      if (state.playing === false && state.totalMs > 1) updateTail();
    } else if (v === 'community') {
      refreshCommunity();
    } else if (v === 'flylog') {
      refreshFlylogs();
    }
  }

  // ============ 飞手社区（账号/上传/基地专区/点赞收藏/评价/个人主页） ============
  var community = {
    rating: 0,
    trackId: null,
    baseFilter: '',   // 基地筛选（空=全部）
    view: 'all',      // 'all' 公开轨迹 | 'mine' 我的轨迹 | 'fav' 我的收藏
    authMode: 'login',
    uploadPoints: null,
    uploadName: '',
    uploadPhoto: null // 压缩后的飞行照片 dataURL
  };

  function communityInit() {
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.addEventListener('click', function () { setView(b.dataset.view); });
    });
    // 当前轨迹：保存（仅自己）/ 分享（公开，需登录）
    document.getElementById('btnSaveTrack').addEventListener('click', function () { saveCurrentTrack(false); });
    document.getElementById('btnShareTrack').addEventListener('click', function () { saveCurrentTrack(true); });
    // 账号：登录/注册/退出
    document.getElementById('btnAuth').addEventListener('click', function () {
      window.SanjiStore.me().then(function (u) {
        if (u) {
          if (confirm('退出登录？')) {
            window.SanjiStore.logout();
            refreshAuthUI();
            refreshCommunity();
          }
        } else {
          openAuth();
        }
      });
    });
    document.getElementById('authCancel').addEventListener('click', closeAuth);
    document.getElementById('authSwitch').addEventListener('click', function () {
      community.authMode = community.authMode === 'login' ? 'reg' : 'login';
      renderAuthMode();
    });
    document.getElementById('authOk').addEventListener('click', submitAuth);
    // 上传：登录 → 选文件 → 解析 → 填写发布信息
    document.getElementById('btnUploadTrack').addEventListener('click', function () {
      window.SanjiStore.me().then(function (u) {
        if (!u) { showDiag('请先登录再上传轨迹', true); openAuth(); return; }
        document.getElementById('fileUpload').click();
      });
    });
    var up = document.getElementById('fileUpload');
    up.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var t = core.parseTrack(reader.result, f.name);
          community.uploadPoints = t.points;
          community.uploadName = f.name.replace(/\.[^.]+$/, '');
          if (t.warnings && t.warnings.length) showDiag('解析提示：' + t.warnings.join('；'), false);
          openUploadModal();
        } catch (err) { showDiag('解析失败：' + err.message, true); }
      };
      reader.readAsText(f);
    });
    document.getElementById('upCancel').addEventListener('click', closeUploadModal);
    document.getElementById('upOk').addEventListener('click', publishTrack);
    // 飞行照片：选图 → 压缩 → 预览
    var upPhoto = document.getElementById('upPhoto');
    if (upPhoto) {
      upPhoto.addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0];
        if (!f) return;
        var r = new FileReader();
        r.onload = function () { compressPhoto(r.result, function (dataUrl) {
          community.uploadPhoto = dataUrl;
          var img = document.getElementById('upPhotoPreview');
          img.src = dataUrl;
          img.style.display = 'block';
        }); };
        r.readAsDataURL(f);
      });
    }
    // 个人主页弹层
    document.getElementById('profileClose').addEventListener('click', function () {
      document.getElementById('profileModal').classList.remove('show');
    });
    // 身份选择联动
    var regRole = document.getElementById('regRole');
    if (regRole) regRole.addEventListener('change', syncRoleFields);
    // 基地管理（仅管理员）
    document.getElementById('btnSiteAdmin').addEventListener('click', openSiteAdmin);
    document.getElementById('siteAdminClose').addEventListener('click', function () {
      document.getElementById('siteAdminModal').classList.remove('show');
      enableSiteDrag(false);
      stopDraw();
    });
    // 危险区域绘制保存弹层
    document.getElementById('drawOk').addEventListener('click', function () {
      var baseEl = document.getElementById('siteAdminBase');
      saveDrawnZone(
        document.getElementById('drawName').value.trim(),
        document.getElementById('drawNote').value.trim(),
        baseEl ? baseEl.value : ''
      );
      document.getElementById('drawModal').classList.remove('show');
    });
    document.getElementById('drawCancel').addEventListener('click', function () {
      document.getElementById('drawModal').classList.remove('show');
      stopDraw();
    });
    // 添加起飞/降落场弹层
    document.getElementById('placeOk').addEventListener('click', savePlacedSite);
    document.getElementById('placeCancel').addEventListener('click', function () {
      document.getElementById('placeModal').classList.remove('show');
      placeState.mode = null;
    });
    // 评论
    document.querySelectorAll('#starRow .star').forEach(function (s) {
      s.addEventListener('click', function () {
        community.rating = Number(s.dataset.v);
        document.querySelectorAll('#starRow .star').forEach(function (x) {
          x.classList.toggle('on', Number(x.dataset.v) <= community.rating);
        });
      });
    });
    document.getElementById('commentCancel').addEventListener('click', closeComment);
    document.getElementById('commentOk').addEventListener('click', submitComment);
    // 飞行记录
    document.getElementById('flylogForm').addEventListener('submit', submitFlylog);

    // ---- v3.9 新弹层：编队对比 / 装备 / 年度报告 / 热气流明细 ----
    document.getElementById('compareClose').addEventListener('click', function () {
      document.getElementById('compareModal').classList.remove('show');
    });
    document.getElementById('compareClear').addEventListener('click', function () {
      clearCompare();
      document.getElementById('compareModal').classList.remove('show');
      showDiag('已清除对比轨迹', false);
    });
    document.getElementById('gearClose').addEventListener('click', function () {
      document.getElementById('gearModal').classList.remove('show');
    });
    document.getElementById('gearAdd').addEventListener('click', addGear);
    document.getElementById('annualClose').addEventListener('click', function () {
      document.getElementById('annualModal').classList.remove('show');
    });
    document.getElementById('thermalClose').addEventListener('click', function () {
      document.getElementById('thermalModal').classList.remove('show');
    });

    refreshAuthUI();
    refreshBases();
    refreshCommunity();
    refreshFlylogs();
  }

  // ---- 账号：登录 / 注册 ----
  function renderAuthMode() {
    var reg = community.authMode === 'reg';
    document.getElementById('regFields').style.display = reg ? 'block' : 'none';
    document.getElementById('authFields').style.display = reg ? 'none' : 'block';
    document.getElementById('authTitle').textContent = reg ? '飞手注册' : '飞手登录';
    document.getElementById('authOk').textContent = reg ? '注册并登录' : '登录';
    document.getElementById('authSwitch').textContent = reg ? '已有账号？去登录' : '注册新账号';
    if (reg) syncRoleFields();
  }

  // 身份选择联动：管理员填"我管理的基地"，普通飞手填"所属基地"
  function syncRoleFields() {
    var role = document.getElementById('regRole').value;
    var isAdmin = role === 'admin';
    document.getElementById('regBaseLabel').style.display = isAdmin ? 'none' : 'block';
    document.getElementById('regAdminBaseLabel').style.display = isAdmin ? 'block' : 'none';
  }

  function openAuth() {
    community.authMode = 'login';
    renderAuthMode();
    document.getElementById('authModal').classList.add('show');
  }

  function closeAuth() {
    document.getElementById('authModal').classList.remove('show');
  }

  function submitAuth() {
    if (community.authMode === 'login') {
      var nick = document.getElementById('authNickname').value.trim();
      var pw = document.getElementById('authPassword').value;
      if (!nick || !pw) { showDiag('请输入昵称和密码', true); return; }
      window.SanjiStore.login(nick, pw).then(function (u) {
        closeAuth();
        refreshAuthUI();
        refreshCommunity();
        showDiag('欢迎回来，' + u.nickname + (u.role === 'admin' ? '（管理员）' : ''), false);
      }).catch(function (e) { showDiag(e.message, true); });
    } else {
      var rn = document.getElementById('regNickname').value.trim();
      var rc = document.getElementById('regContact').value.trim();
      var role = document.getElementById('regRole').value;
      var rb = role === 'admin'
        ? document.getElementById('regAdminBase').value.trim()
        : document.getElementById('regBase').value.trim();
      var rp = document.getElementById('regPassword').value;
      if (!rn || !rp) { showDiag('昵称和密码必填', true); return; }
      if (role === 'admin' && !rb) { showDiag('管理员请填写你管理的基地名称', true); return; }
      window.SanjiStore.register({ nickname: rn, contact: rc, base: rb, password: rp, role: role }).then(function (u) {
        closeAuth();
        refreshAuthUI();
        refreshBases();
        refreshCommunity();
        showDiag('注册成功，欢迎 ' + u.nickname + (u.role === 'admin' ? '（基地管理员）' : ''), false);
      }).catch(function (e) { showDiag(e.message, true); });
    }
  }

  function refreshAuthUI() {
    var info = document.getElementById('sessionInfo');
    var btn = document.getElementById('btnAuth');
    var adminBtn = document.getElementById('btnSiteAdmin');
    window.SanjiStore.me().then(function (u) {
      if (u) {
        info.textContent = u.nickname + (u.base ? ' · ' + u.base : '') + (u.role === 'admin' ? ' 🛠' : '');
        btn.textContent = '退出';
        // 基地管理入口：仅基地管理员可见
        if (adminBtn) adminBtn.style.display = u.role === 'admin' ? 'inline-block' : 'none';
      } else {
        info.textContent = '未登录';
        btn.textContent = '登录/注册';
        if (adminBtn) adminBtn.style.display = 'none';
      }
    });
  }

  // ---- 上传：填写标题 / 基地 / 照片 / 笔记 / 可见性 ----
  function openUploadModal() {
    window.SanjiStore.getBases().then(function (bases) {
      var dl = document.getElementById('baseList');
      dl.innerHTML = bases.map(function (b) {
        return '<option value="' + esc(b) + '"></option>';
      }).join('');
    });
    document.getElementById('uploadFileName').textContent = community.uploadName || '';
    document.getElementById('upTitle').value = '';
    document.getElementById('upBase').value = '';
    document.getElementById('upNote').value = '';
    document.getElementById('upVisibility').value = 'public';
    community.uploadPhoto = null;
    var img = document.getElementById('upPhotoPreview');
    if (img) { img.style.display = 'none'; img.src = ''; }
    if (document.getElementById('upPhoto')) document.getElementById('upPhoto').value = '';
    document.getElementById('uploadModal').classList.add('show');
  }

  // 照片压缩：Canvas 缩放至宽 ≤900、JPEG 质量 0.7，控制 IndexedDB 存储体积
  function compressPhoto(dataUrl, cb) {
    var img = new Image();
    img.onload = function () {
      var maxW = 900;
      var scale = Math.min(1, maxW / img.width);
      var c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      cb(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = function () { cb(null); };
    img.src = dataUrl;
  }

  function closeUploadModal() {
    document.getElementById('uploadModal').classList.remove('show');
  }

  function publishTrack() {
    if (!community.uploadPoints || community.uploadPoints.length < 2) { showDiag('没有可发布的轨迹数据', true); return; }
    var title = document.getElementById('upTitle').value.trim() || community.uploadName + ' 的飞行';
    var base = document.getElementById('upBase').value.trim();
    var note = document.getElementById('upNote').value.trim();
    var vis = document.getElementById('upVisibility').value;
    window.SanjiStore.me().then(function (u) {
      if (!u) { showDiag('登录状态已失效，请重新登录', true); closeUploadModal(); openAuth(); return null; }
      var s = core.stats.computeStats(core.stats.decimate(community.uploadPoints, 2000));
      return window.SanjiStore.add('tracks', {
        title: title,
        base: base,
        note: note,
        photo: community.uploadPhoto || null, // 飞行照片（压缩 dataURL）
        visibility: vis,
        authorId: u.id,
        authorName: u.nickname,
        points: community.uploadPoints,
        meta: { dur: s.durationSec, dist: Math.round(s.totalDistance), maxAlt: s.maxAlt, th: s.thermalCount },
        createdAt: Date.now()
      });
    }).then(function (id) {
      if (id) {
        closeUploadModal();
        community.uploadPoints = null;
        community.uploadPhoto = null;
        refreshBases();
        refreshCommunity();
        showDiag('轨迹已发布 ✓', false);
      }
    });
  }

  // 当前轨迹保存（仅自己可见）/ 分享（公开，需登录）
  function saveCurrentTrack(shared) {
    if (!state.curTrack || !state.curTrack.points || state.curTrack.points.length < 2) {
      showDiag('当前没有可保存的轨迹', false);
      return;
    }
    window.SanjiStore.me().then(function (u) {
      if (shared && !u) { showDiag('分享到社区需要先登录', true); openAuth(); return null; }
      var pts = state.curTrack.points;
      var s = core.stats.computeStats(core.stats.decimate(pts, 2000));
      return window.SanjiStore.add('tracks', {
        title: state.curTrack.name,
        base: '',
        note: '',
        visibility: shared ? 'public' : 'private',
        authorId: u ? u.id : 0,
        authorName: u ? u.nickname : '本地',
        points: pts,
        meta: { dur: s.durationSec, dist: Math.round(s.totalDistance), maxAlt: s.maxAlt, th: s.thermalCount },
        createdAt: Date.now()
      });
    }).then(function (id) {
      if (id) {
        showDiag(shared ? '已公开分享到社区 ✓' : '已保存到我的轨迹 ✓', false);
        refreshCommunity();
      }
    });
  }

  // ---- 基地筛选 chips（全部 / 我的 / 收藏 / 各基地） ----
  function refreshBases() {
    var wrap = document.getElementById('baseChips');
    window.SanjiStore.getBases().then(function (bases) {
      var items = [{ k: 'all', label: '全部' }, { k: 'mine', label: '我的' }, { k: 'fav', label: '收藏' }];
      bases.forEach(function (b) { items.push({ k: b, label: b }); });
      wrap.innerHTML = items.map(function (it) {
        var active = (it.k === 'mine' && community.view === 'mine') ||
          (it.k === 'fav' && community.view === 'fav') ||
          (it.k !== 'mine' && it.k !== 'fav' && community.view === 'all' && community.baseFilter === it.k);
        return '<button class="chip' + (active ? ' chip-active' : '') + '" data-k="' + esc(it.k) + '">' + esc(it.label) + '</button>';
      }).join('');
      wrap.querySelectorAll('[data-k]').forEach(function (b) {
        b.addEventListener('click', function () {
          var k = b.dataset.k;
          if (k === 'all') { community.view = 'all'; community.baseFilter = ''; }
          else if (k === 'mine') { community.view = 'mine'; community.baseFilter = ''; }
          else if (k === 'fav') { community.view = 'fav'; community.baseFilter = ''; }
          else { community.view = 'all'; community.baseFilter = k; }
          refreshBases();
          refreshCommunity();
        });
      });
    });
  }

  // ---- 社区列表渲染（权限：公开可见；我的含私密；收藏视图；基地筛选） ----
  function refreshCommunity() {
    var list = document.getElementById('communityList');
    Promise.all([
      window.SanjiStore.getAll('tracks'),
      window.SanjiStore.commentStats(),
      window.SanjiStore.me()
    ]).then(function (r) {
      var tracks = r[0], stats = r[1], me = r[2];
      var shown = tracks.filter(function (t) {
        var vis = t.visibility || (t.shared ? 'public' : 'private');
        if (community.view === 'mine') return me && t.authorId === me.id;
        if (community.view === 'fav') return me && t.favIds && t.favIds.indexOf(me.id) >= 0;
        if (vis !== 'public') return false;
        if (community.baseFilter && t.base !== community.baseFilter) return false;
        return true;
      });
      if (!shown.length) {
        list.innerHTML = '<div class="empty-tip">' +
          (community.view === 'mine' ? '你还没有上传过轨迹' :
            community.view === 'fav' ? '还没有收藏任何轨迹' :
            '该基地还没有公开轨迹，上传第一条 IGC 分享给伞友') +
          '</div>';
        return;
      }
      shown.sort(function (a, b) { return b.createdAt - a.createdAt; });
      list.innerHTML = shown.map(function (t) {
        var cs = stats[t.id] || { avg: 0, count: 0 };
        var meta = t.meta || {};
        var vis = t.visibility || (t.shared ? 'public' : 'private');
        var liked = me && t.likeIds && t.likeIds.indexOf(me.id) >= 0;
        var faved = me && t.favIds && t.favIds.indexOf(me.id) >= 0;
        var likeCount = (t.likeIds && t.likeIds.length) || 0;
        var favCount = (t.favIds && t.favIds.length) || 0;
        return '<div class="card">' +
          '<div class="card-head"><span class="card-title">' + esc(t.title || '未命名轨迹') + '</span>' +
          '<span class="card-badge">' + (vis === 'private' ? '🔒 仅自己' : (cs.count ? '★ ' + cs.avg + ' (' + cs.count + ')' : '新轨迹')) + '</span></div>' +
          '<div class="card-meta">' +
          (t.base ? '<span class="base-tag">⛰ ' + esc(t.base) + '</span>' : '') +
          '<span>' + new Date(t.createdAt).toLocaleDateString('zh-CN') + '</span>' +
          '<span>' + fmtDur(meta.dur) + '</span>' +
          '<span>' + ((meta.dist || 0) / 1000).toFixed(1) + ' km</span>' +
          '<span>最高 ' + (meta.maxAlt || 0) + ' m</span>' +
          '<span>热气流 ' + (meta.th || 0) + '</span>' +
          '<span>by <span class="author-link" data-profile="' + t.authorId + '">' + esc(t.authorName || '伞友') + '</span></span></div>' +
          (t.photo ? '<img class="card-photo" src="' + t.photo + '" alt="飞行照片" />' : '') +
          (t.note ? '<div class="card-note">' + esc(t.note) + '</div>' : '') +
          '<div class="card-foot">' +
          '<span class="stars">' + starStr(cs.avg) + '</span>' +
          '<span class="card-btns">' +
          '<button class="like-btn' + (liked ? ' on' : '') + '" data-act="like" data-id="' + t.id + '">❤ ' + likeCount + '</button>' +
          '<button class="fav-btn' + (faved ? ' on' : '') + '" data-act="fav" data-id="' + t.id + '">☆ ' + favCount + '</button>' +
          '<button class="mini-btn mini-primary" data-act="play" data-id="' + t.id + '">回放</button>' +
          '<button class="mini-btn" data-act="comment" data-id="' + t.id + '">评论</button>' +
          (me && t.authorId === me.id ? '<button class="mini-btn mini-danger" data-act="del" data-id="' + t.id + '">删除</button>' : '') +
          '</span></div></div>';
      }).join('');
      list.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var act = btn.dataset.act, id = Number(btn.dataset.id);
          if (act === 'play') playFromCommunity(id);
          else if (act === 'comment') openComment(id);
          else if (act === 'del') deleteTrack(id);
          else if (act === 'like') toggleLikeTrack(id, btn);
          else if (act === 'fav') toggleFavTrack(id, btn);
        });
      });
      list.querySelectorAll('[data-profile]').forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.stopPropagation();
          openProfile(Number(a.dataset.profile));
        });
      });
      list.querySelectorAll('.card').forEach(function (card) {
        card.addEventListener('click', function () {
          var btn = card.querySelector('[data-act="play"]');
          if (btn) playFromCommunity(Number(btn.dataset.id));
        });
      });
    });
  }

  // 点赞（需登录）
  function toggleLikeTrack(id, btn) {
    window.SanjiStore.me().then(function (u) {
      if (!u) { showDiag('登录后才能点赞', true); openAuth(); return null; }
      return window.SanjiStore.toggleLike(id, u.id);
    }).then(function (r) {
      if (r) {
        btn.classList.toggle('on', r.liked);
        btn.textContent = '❤ ' + r.count;
      }
    }).catch(function (e) { showDiag(e.message, true); });
  }

  // 收藏（需登录）
  function toggleFavTrack(id, btn) {
    window.SanjiStore.me().then(function (u) {
      if (!u) { showDiag('登录后才能收藏', true); openAuth(); return null; }
      return window.SanjiStore.toggleFav(id, u.id);
    }).then(function (r) {
      if (r) {
        btn.classList.toggle('on', r.faved);
        btn.textContent = '☆ ' + r.count;
      }
    }).catch(function (e) { showDiag(e.message, true); });
  }

  // 飞手个人主页：总飞行次数 / 总留空时长 / 公开轨迹列表
  function openProfile(userId) {
    window.SanjiStore.profile(userId).then(function (p) {
      var u = p.user;
      document.getElementById('profileTitle').textContent = (u ? u.nickname : '伞友') + ' 的主页';
      var html = '';
      if (u) {
        html += '<div style="font-size:12px;color:#94a3b8">' +
          (u.base ? '基地：' + esc(u.base) + ' · ' : '') +
          '注册于 ' + new Date(u.createdAt).toLocaleDateString('zh-CN') + '</div>';
      }
      html += '<div class="profile-stat-row">' +
        '<div class="profile-stat"><b>' + p.count + '</b><span>总飞行次数</span></div>' +
        '<div class="profile-stat"><b>' + fmtDur(p.totalSec) + '</b><span>总留空时长</span></div>' +
        '</div>';
      if (p.tracks.length) {
        html += '<div style="font-size:12px;color:#94a3b8;margin:8px 0 4px">公开飞行记录</div>';
        html += p.tracks.slice(0, 20).map(function (t) {
          var m = t.meta || {};
          return '<div class="profile-track" data-pid="' + t.id + '">' +
            '<span>' + esc(t.title || '未命名') + (t.base ? ' · ' + esc(t.base) : '') + '</span>' +
            '<span style="color:#7dd3fc">' + fmtDur(m.dur) + '</span></div>';
        }).join('');
      } else {
        html += '<div class="empty-tip">还没有公开飞行记录</div>';
      }
      document.getElementById('profileBody').innerHTML = html;
      document.getElementById('profileModal').classList.add('show');
      document.getElementById('profileBody').querySelectorAll('[data-pid]').forEach(function (row) {
        row.addEventListener('click', function () {
          playFromCommunity(Number(row.dataset.pid));
          document.getElementById('profileModal').classList.remove('show');
        });
      });
    });
  }

  function playFromCommunity(id) {
    window.SanjiStore.getAll('tracks').then(function (tracks) {
      var t = tracks.filter(function (x) { return x.id === id; })[0];
      if (!t) return;
      loadTrack(t.points, t.title || '飞行轨迹');
      setView('replay');
    });
  }

  // 删除：仅轨迹作者本人
  function deleteTrack(id) {
    window.SanjiStore.me().then(function (me) {
      if (!me) { showDiag('登录后才能删除', true); return null; }
      return window.SanjiStore.getAll('tracks').then(function (ts) {
        var t = ts.filter(function (x) { return x.id === id; })[0];
        if (!t || t.authorId !== me.id) { showDiag('只能删除自己的轨迹', true); return null; }
        if (!confirm('删除这条轨迹（含其评论）？')) return null;
        return window.SanjiStore.del('tracks', id).then(function () {
          return window.SanjiStore.getByIndex('comments', 'trackId', id);
        }).then(function (cs) {
          var chain = Promise.resolve();
          cs.forEach(function (c) {
            chain = chain.then(function () { return window.SanjiStore.del('comments', c.id); });
          });
          return chain;
        }).then(function () { return true; });
      });
    }).then(function (ok) {
      if (ok) {
        refreshCommunity();
        showDiag('轨迹已删除', false);
      }
    });
  }

  // 评价（登录后可评）
  function openComment(trackId) {
    window.SanjiStore.me().then(function (u) {
      if (!u) { showDiag('登录后才能评论', true); openAuth(); return; }
      community.rating = 0;
      community.trackId = trackId;
      document.getElementById('commentText').value = '';
      document.querySelectorAll('#starRow .star').forEach(function (x) { x.classList.remove('on'); });
      document.getElementById('commentModal').classList.add('show');
    });
  }

  function closeComment() {
    document.getElementById('commentModal').classList.remove('show');
  }

  function submitComment() {
    var text = document.getElementById('commentText').value.trim();
    if (!community.rating && !text) { showDiag('请先点选星级或填写评论', false); return; }
    window.SanjiStore.me().then(function (u) {
      if (!u) { showDiag('登录状态已失效', true); return null; }
      return window.SanjiStore.add('comments', {
        trackId: community.trackId,
        rating: community.rating || 3,
        text: text,
        author: u.nickname,
        authorId: u.id,
        createdAt: Date.now()
      });
    }).then(function (id) {
      if (id) {
        closeComment();
        refreshCommunity();
        showDiag('评论已提交 ✓', false);
      }
    });
  }

  // 飞行记录
  function refreshFlylogs() {
    var list = document.getElementById('flylogList');
    window.SanjiStore.getAll('flylogs').then(function (logs) {
      if (!logs.length) {
        list.innerHTML = '<div class="empty-tip">还没有飞行记录，填写上方表单记录第一次飞行</div>';
        return;
      }
      logs.sort(function (a, b) { return b.createdAt - a.createdAt; });
      list.innerHTML = logs.map(function (l) {
        return '<div class="fl-log-card">' +
          '<div class="fl-log-title">' + esc(l.site || '未填场地') +
          (l.shared ? ' <span class="card-badge">已分享</span>' : '') + '</div>' +
          '<div class="fl-log-meta">' +
          '<span>' + esc(l.date || '—') + '</span>' +
          '<span>天气 ' + esc(l.weather || '—') + '</span>' +
          '<span>风速 ' + esc(l.wind || '—') + ' m/s</span>' +
          '<span>飞行 ' + (l.count || '—') + ' 次</span>' +
          '<span>伞 ' + esc(l.glider || '—') + '</span>' +
          '</div>' +
          (l.note ? '<div class="fl-log-note">' + esc(l.note) + '</div>' : '') +
          '<div class="card-foot"><span></span>' +
          '<button class="mini-btn mini-danger" data-del="' + l.id + '">删除</button></div></div>';
      }).join('');
      list.querySelectorAll('[data-del]').forEach(function (b) {
        b.addEventListener('click', function () {
          if (!confirm('删除这条飞行记录？')) return;
          window.SanjiStore.del('flylogs', Number(b.dataset.del)).then(refreshFlylogs);
        });
      });
    });
  }

  // 彩蛋：飞行记录场地输入「笑笑」保存后，全屏庆祝约 3 秒（彩色文字 + 气球 + 星光）
  function showEasterEgg() {
    if (document.getElementById('eggOverlay')) return; // 已在播放中
    var ov = document.createElement('div');
    ov.id = 'eggOverlay';

    var box = document.createElement('div');
    box.className = 'egg-box';
    var text = document.createElement('div');
    text.className = 'egg-text';
    text.textContent = '笑笑永远都是大美女';
    var sub = document.createElement('div');
    sub.className = 'egg-sub';
    sub.textContent = '🎈 永远开心 · 天天高飞 🎈';
    box.appendChild(text);
    box.appendChild(sub);
    ov.appendChild(box);

    // 全屏气球：从底部升起
    var balloons = ['🎈', '🎈', '🎈', '🎈', '🎈', '🎈', '🎈', '🎈', '🎈', '🎈', '🎈', '🎈', '🎈', '🎈'];
    balloons.forEach(function () {
      var b = document.createElement('div');
      b.className = 'egg-balloon';
      b.textContent = '🎈';
      b.style.left = (3 + Math.random() * 92) + 'vw';
      b.style.fontSize = (34 + Math.random() * 30) + 'px';
      b.style.animationDuration = (2.4 + Math.random() * 1.2) + 's';
      b.style.animationDelay = (Math.random() * 0.9) + 's';
      ov.appendChild(b);
    });
    // 星光/爱心飘落
    var sparks = ['⭐', '❤️', '✨', '💖', '🌟', '💕'];
    for (var i = 0; i < 16; i++) {
      var s = document.createElement('div');
      s.className = 'egg-spark';
      s.textContent = sparks[i % sparks.length];
      s.style.left = (2 + Math.random() * 94) + 'vw';
      s.style.fontSize = (16 + Math.random() * 18) + 'px';
      s.style.animationDuration = (2 + Math.random() * 1.6) + 's';
      s.style.animationDelay = (Math.random() * 0.6) + 's';
      ov.appendChild(s);
    }

    document.body.appendChild(ov);

    // 3 秒后淡出移除；点击可提前关闭
    var closed = false;
    var close = function () {
      if (closed) return;
      closed = true;
      ov.classList.add('egg-out');
      setTimeout(function () {
        if (ov.parentNode) ov.parentNode.removeChild(ov);
      }, 650);
    };
    setTimeout(close, 3000);
    ov.addEventListener('click', close);
  }

  function submitFlylog(e) {
    e.preventDefault();
    var site = document.getElementById('flSite').value.trim();
    if (!site) { showDiag('请填写场地/基地', false); return; }
    window.SanjiStore.me().then(function (u) {
      return window.SanjiStore.add('flylogs', {
        date: document.getElementById('flDate').value || new Date().toISOString().slice(0, 10),
        site: site,
        weather: document.getElementById('flWeather').value,
        wind: document.getElementById('flWind').value,
        count: document.getElementById('flCount').value,
        glider: document.getElementById('flGlider').value.trim(),
        note: document.getElementById('flNote').value.trim(),
        shared: document.getElementById('flShared').checked,
        author: u ? u.nickname : '本地',
        createdAt: Date.now()
      });
    }).then(function () {
      document.getElementById('flylogForm').reset();
      refreshFlylogs();
      showDiag('飞行记录已保存 ✓', false);
      // 彩蛋：场地输入「笑笑」→ 全屏庆祝
      if (/笑笑/.test(site)) showEasterEgg();
    });
  }

  // ============ 清理 ============
  function clearScene() {
    viewer.entities.removeAll();
    state.trackEntities = [];
    state.markEntities = [];
    state.thermalEntities = [];
    state.siteEntities = [];
    state.planeEntity = null;
    state.previewLine = null;
    state.dangerPoint = null;
    state.terrainPositions = null;
    state.mainPool = [];
    state.tailLayers = [];
    state._lastTailAt = 0;
    state.compare = null; // 场景重建时对比轨迹一并清理（实体已随 removeAll 移除）
    var bar = document.getElementById('dangerBar');
    if (bar) bar.style.display = 'none';
    state.danger = false;
    if (state.chart) state.chart.clear();
  }

  // ============ 启动 ============
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
