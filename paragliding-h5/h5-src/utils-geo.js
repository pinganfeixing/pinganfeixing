// utils/geo.js — 地理计算与格式化工具（纯函数，无 wx 依赖，可独立测试）
const R = 6371000; // 地球半径（米）

/**
 * Haversine 球面距离
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} 距离（米）
 */
function haversine(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * 轨迹总长度（米）
 * @param {Array<{lat:number,lon:number}>} points
 */
function trackLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
  }
  return len;
}

/**
 * 两点间平均速度（米/秒），基于时间差
 */
function speedBetween(a, b) {
  const dt = Math.max((b.t - a.t) / 1000, 0.5);
  return haversine(a.lat, a.lon, b.lat, b.lon) / dt;
}

/**
 * 将轨迹点序列投影到以基准点为中心的本地平面坐标（等距圆柱近似，适合数公里尺度）
 * @param {Array<{lat:number,lon:number,alt?:number}>} points
 * @param {number} baseLat
 * @param {number} baseLon
 * @returns {Array<{x:number,y:number,z:number}>} 米制坐标，z 为海拔（米）
 */
function toLocalXY(points, baseLat, baseLon) {
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos((baseLat * Math.PI) / 180);
  return points.map((p) => ({
    x: (p.lon - baseLon) * mPerDegLon,
    y: (baseLat - p.lat) * mPerDegLat, // 北为正，翻转使屏幕上方为北
    z: p.alt || 0
  }));
}

/**
 * 两点间航向角（正北 0°，顺时针 0-360）
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} 角度（度）
 */
function bearing(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (d) => (d * 180) / Math.PI;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * 累计爬升 / 下降（米）。只统计高度变化的“净升降”，忽略小于阈值的抖动。
 * @param {Array<{alt:number}>} points
 * @param {number} threshold 阈值（米），默认 0
 */
function cumulatives(points, threshold = 0) {
  let up = 0;
  let down = 0;
  for (let i = 1; i < points.length; i++) {
    const d = points[i].alt - points[i - 1].alt;
    if (Math.abs(d) <= threshold) continue;
    if (d > 0) up += d;
    else down += -d;
  }
  return { up, down };
}

/** 格式化时长：秒 -> "01:23:45" */
function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** 格式化距离：米 -> "12.3 km" 或 "800 m" */
function formatDistance(m) {
  if (m >= 1000) return (m / 1000).toFixed(1) + ' km';
  return Math.round(m) + ' m';
}

/** 格式化速度：米/秒 -> "38 km/h" */
function formatSpeed(ms) {
  return Math.round(ms * 3.6) + ' km/h';
}

/** 格式化时间戳（ms）-> "MM-DD HH:mm" */
function formatTime(ms) {
  const d = new Date(ms);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

module.exports = {
  R,
  haversine,
  trackLength,
  speedBetween,
  bearing,
  toLocalXY,
  cumulatives,
  formatDuration,
  formatDistance,
  formatSpeed,
  formatTime
};
