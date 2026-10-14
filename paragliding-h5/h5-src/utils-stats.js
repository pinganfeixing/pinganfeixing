// utils/stats.js — 飞行统计与热气流识别（纯函数，无 wx 依赖）
const geo = require('./utils-geo');
const { detectFlightStates } = require('./utils-flightStates');

/**
 * 计算逐点垂直速度（m/s）与水平速度（m/s）
 */
function perPointVelocities(points) {
  const vv = [0];
  const hv = [0];
  for (let i = 1; i < points.length; i++) {
    const dt = (points[i].t - points[i - 1].t) / 1000;
    if (dt < 0.2) {
      vv.push(0);
      hv.push(0);
      continue;
    }
    vv.push((points[i].alt - points[i - 1].alt) / dt);
    hv.push(geo.haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon) / dt);
  }
  return { vv, hv };
}

/**
 * 热气流识别：连续爬升且水平漂移有限的区段
 * @param {Array<{t:number,lat:number,lon:number,alt:number}>} points
 * @param {object} [opts]
 * @param {number} [opts.minClimb=0.8]  区段平均爬升率下限（m/s）
 * @param {number} [opts.minDuration=25] 区段最小时长（秒）
 * @param {number} [opts.maxDrift=600]   区段内水平漂移上限（米）
 * @returns {Array<{startT:number,endT:number,centerLat:number,centerLon:number,
 *                  avgClimb:number,altGain:number,duration:number}>}
 */
function findThermals(points, opts = {}) {
  const { minClimb = 0.8, minDuration = 25, maxDrift = 600 } = opts;
  if (points.length < 3) return [];

  const { vv } = perPointVelocities(points);
  const thermals = [];
  let segStart = -1;

  const flush = (endIdx) => {
    if (segStart < 0) return;
    const seg = points.slice(segStart, endIdx + 1);
    if (seg.length < 3) {
      segStart = -1;
      return;
    }
    const duration = (seg[seg.length - 1].t - seg[0].t) / 1000;
    if (duration < minDuration) {
      segStart = -1;
      return;
    }
    const drift = geo.haversine(
      seg[0].lat, seg[0].lon,
      seg[seg.length - 1].lat, seg[seg.length - 1].lon
    );
    if (drift > maxDrift) {
      segStart = -1;
      return;
    }
    const avgClimb =
      seg.reduce((s, p, i) => (i > 0 ? s + vv[segStart + i] : s), 0) / (seg.length - 1);
    if (avgClimb < minClimb) {
      segStart = -1;
      return;
    }
    // 中心点取中位位置与平均高度
    const mid = seg[Math.floor(seg.length / 2)];
    thermals.push({
      startT: seg[0].t,
      endT: seg[seg.length - 1].t,
      centerLat: mid.lat,
      centerLon: mid.lon,
      avgClimb: Math.round(avgClimb * 100) / 100,
      altGain: Math.round(seg[seg.length - 1].alt - seg[0].alt),
      duration: Math.round(duration),
      // 估算盘旋圈数：标准盘旋一圈约 10-15s，取 12s/圈
      circles: Math.max(1, Math.round(duration / 12))
    });
    segStart = -1;
  };

  for (let i = 1; i < vv.length; i++) {
    const climbing = vv[i] > 0;
    if (climbing && segStart < 0) {
      // 从上一非爬升点开始，避免丢失边界
      segStart = i - 1;
    } else if (!climbing && segStart >= 0) {
      flush(i);
    }
  }
  if (segStart >= 0) flush(vv.length - 1);

  // 合并过近的热气流（间隔 < 10 秒且中心距 < 100 米）
  const merged = [];
  for (const th of thermals) {
    const last = merged[merged.length - 1];
    if (last && th.startT - last.endT < 10000) {
      const dC = geo.haversine(last.centerLat, last.centerLon, th.centerLat, th.centerLon);
      if (dC < 100) {
        last.endT = th.endT;
        last.duration = Math.round((th.endT - last.startT) / 1000);
        last.altGain += th.altGain;
        last.avgClimb = Math.round(((last.avgClimb + th.avgClimb) / 2) * 100) / 100;
        continue;
      }
    }
    merged.push(th);
  }
  return merged;
}

/**
 * 计算整段飞行的完整统计
 * @returns {object} stats
 */
function computeStats(points) {
  const n = points.length;
  const stats = {
    pointCount: n,
    durationSec: 0,
    totalDistance: 0,
    straightDistance: 0,
    maxAlt: 0,
    minAlt: 0,
    takeoffAlt: 0,
    landingAlt: 0,
    maxClimb: 0, // m/s
    maxSink: 0, // m/s
    avgSpeed: 0, // m/s（水平，基于总距离/时长）
    cumulativeUp: 0,
    cumulativeDown: 0,
    thermals: [],
    thermalCount: 0,
    // 伞状态判定（基于 GPS 估算，见 utils/flightStates.js）
    states: [],
    stateCounts: {},
    dangerCount: 0,
    hasDanger: false
  };

  if (n < 2) return stats;

  const { vv, hv } = perPointVelocities(points);
  const alts = points.map((p) => p.alt);
  stats.maxAlt = Math.round(Math.max(...alts));
  stats.minAlt = Math.round(Math.min(...alts));
  stats.takeoffAlt = Math.round(points[0].alt);
  stats.landingAlt = Math.round(points[n - 1].alt);

  let maxClimb = 0;
  let maxSink = 0;
  for (let i = 1; i < n; i++) {
    if (vv[i] > maxClimb) maxClimb = vv[i];
    if (vv[i] < maxSink) maxSink = vv[i];
  }
  stats.maxClimb = Math.round(maxClimb * 100) / 100;
  stats.maxSink = Math.round(maxSink * 100) / 100;

  stats.totalDistance = Math.round(geo.trackLength(points));
  stats.straightDistance = Math.round(
    geo.haversine(points[0].lat, points[0].lon, points[n - 1].lat, points[n - 1].lon)
  );
  stats.durationSec = Math.round((points[n - 1].t - points[0].t) / 1000);
  stats.avgSpeed =
    stats.durationSec > 0 ? Math.round((stats.totalDistance / stats.durationSec) * 100) / 100 : 0;

  const cum = geo.cumulatives(points, 0);
  stats.cumulativeUp = Math.round(cum.up);
  stats.cumulativeDown = Math.round(cum.down);

  stats.thermals = findThermals(points);
  stats.thermalCount = stats.thermals.length;

  // 伞状态判定
  const fs = detectFlightStates(points);
  stats.states = fs.states;
  stats.stateCounts = fs.stateCounts;
  stats.dangerCount = fs.dangerCount;
  stats.hasDanger = fs.hasDanger;

  return stats;
}

/**
 * 热气流效率报告：整趟飞行的热气流利用情况
 * @param {object} stats computeStats 结果
 * @returns {object} { totalGain, totalThermalSec, utilizationPct, bestClimb, thermalCount }
 */
function thermalEfficiency(stats) {
  const ths = stats.thermals || [];
  if (!ths.length) {
    return { totalGain: 0, totalThermalSec: 0, utilizationPct: 0, bestClimb: 0, thermalCount: 0 };
  }
  const totalGain = ths.reduce((s, t) => s + (t.altGain || 0), 0);
  const totalThermalSec = ths.reduce((s, t) => s + (t.duration || 0), 0);
  const flightSec = stats.durationSec || 1;
  // 利用率 = 热气流总爬升时间 / 总飞行时长（起飞→降落）
  const utilizationPct = Math.round((totalThermalSec / flightSec) * 100);
  const bestClimb = Math.max.apply(null, ths.map((t) => t.avgClimb || 0));
  return {
    totalGain,
    totalThermalSec,
    utilizationPct,
    bestClimb: Math.round(bestClimb * 100) / 100,
    thermalCount: ths.length
  };
}

/**
 * 飞行得分卡（简化 XContest 风格，非官方）
 * 直线距离分 = 直线航程(km) × 2；爬升表现分 = 热气流数 × 3 + 最大相对高度(m)/100；
 * 综合飞行分 = 直线距离分 + 爬升表现分（向上取整）。
 * @param {object} stats computeStats 结果
 * @param {number} takeoffAlt 起飞海拔
 * @returns {object} { straightKm, triangleKm, score, parts }
 */
function computeScore(stats, takeoffAlt) {
  const straightKm = Math.round(((stats.straightDistance || 0) / 1000) * 10) / 10;
  const relMax = Math.max(0, (stats.maxAlt || 0) - (takeoffAlt || 0));
  const distScore = Math.round(straightKm * 2);
  const climbScore = Math.round((stats.thermalCount || 0) * 3 + relMax / 100);
  const score = distScore + climbScore;
  return {
    straightKm,
    triangleKm: Math.round(straightKm * 0.7), // 简化三角航程估算（非 FAI 精确计算）
    score,
    parts: { distScore, climbScore, relMax }
  };
}

/**
 * 抽稀轨迹点（保留形状，用于 3D 渲染性能优化）
 * @param {Array} points
 * @param {number} maxPoints 目标点数
 */
function decimate(points, maxPoints = 4000) {
  if (points.length <= maxPoints) return points;
  const step = Math.ceil(points.length / maxPoints);
  const out = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

module.exports = { computeStats, findThermals, perPointVelocities, decimate, thermalEfficiency, computeScore };
