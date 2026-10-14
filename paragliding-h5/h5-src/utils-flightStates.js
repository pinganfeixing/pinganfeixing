// utils/flightStates.js — 基于 GPS 轨迹的伞状态估算（纯函数，无 wx 依赖，可独立测试）
// ⚠️ 说明：仅依据位置/高度/时间序列（地速、升降率、转弯率）做启发式判定，
//    无法直接测量空速与姿态，结果仅用于飞行复盘提示，不替代飞行仪表与教练判断。
//    全失速/螺旋等判定为"疑似"级别，供伞友回看风险时段，不作为飞行安全依据。
const geo = require('./utils-geo');

// 状态定义：severity 0=正常 1=注意 2=警告 3=危险
const STATE_DEFS = {
  takeoff:   { key: 'takeoff',   label: '起飞',       color: '#22c55e', severity: 0 },
  cruise:    { key: 'cruise',    label: '巡航',       color: '#38bdf8', severity: 0 },
  thermal:   { key: 'thermal',   label: '盘旋上升',    color: '#fb923c', severity: 0 },
  landing:   { key: 'landing',   label: '降落',       color: '#94a3b8', severity: 0 },
  bigEars:   { key: 'bigEars',   label: '减速高下沉',  color: '#f97316', severity: 1 },
  sharpTurn: { key: 'sharpTurn', label: '急转(疑似塌陷)', color: '#eab308', severity: 2 },
  pitchOsc:  { key: 'pitchOsc',  label: '俯仰振荡',    color: '#a855f7', severity: 2 },
  spiral:    { key: 'spiral',    label: '螺旋下降',    color: '#f43f5e', severity: 2 },
  deepSink:  { key: 'deepSink',  label: '高速下沉',    color: '#ef4444', severity: 2 },
  fullStall: { key: 'fullStall', label: '全失速',      color: '#dc2626', severity: 3 }
};

// 判定阈值（可调）
const TH = {
  minDt: 0.5,          // 有效采样间隔下限（秒）
  maxDt: 15,           // 采样间隔上限，超过视为数据缺口
  stallSpeed: 5,       // 全失速地速上限（m/s，≈18km/h）
  stallSink: -3.5,     // 全失速下沉率（m/s）
  deepSink: -6,        // 高速下沉（m/s）
  spiralTurn: 40,      // 螺旋最小转弯率（°/s）
  spiralSink: -4,      // 螺旋下沉率（m/s）
  sharpTurnRate: 60,   // 急转阈值（°/s）
  sharpTurnSink: -1,   // 急转时下沉阈值
  oscThreshold: 0.8,   // 俯仰振荡：垂直速度符号判定阈值（m/s）
  oscMinAmpl: 1.5,     // 俯仰振荡：单次振幅下限（m/s）
  oscMinSwings: 3,     // 俯仰振荡：窗口内摆动次数下限
  oscWindow: 12,       // 俯仰振荡：观察窗口（秒）
  earsSpeedLo: 0.3,    // 大耳朵/减速：地速相对基准的下限比例
  earsSpeedHi: 0.65,   // 大耳朵/减速：地速相对基准的上限比例
  earsSinkLo: -5,      // 大耳朵下沉区间
  earsSinkHi: -2.5,
  earsTurn: 25,        // 大耳朵时转弯率上限
  thermalClimb: 0.8,   // 盘旋上升爬升率下限
  thermalTurn: 8,      // 盘旋上升转弯率下限
  sustainWindow: 5,    // 危险判定平滑窗口（点数）
  baselineWin: 30      // 地速基准窗口（秒）
};

/**
 * 计算逐点运动学指标
 * @returns {{vv:number[], hv:number[], turnRate:number[], dt:number[]}}
 */
function perPointKinematics(points) {
  const n = points.length;
  const vv = [0];
  const hv = [0];
  const turnRate = [0];
  const dtArr = [0];
  let prevBearing = null;
  let prevT = points[0].t;

  for (let i = 1; i < n; i++) {
    const dt = Math.min(Math.max((points[i].t - points[i - 1].t) / 1000, TH.minDt), TH.maxDt);
    dtArr.push(dt);
    vv.push((points[i].alt - points[i - 1].alt) / dt);
    const d = geo.haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    hv.push(d / dt);
    // 航向角（正北 0°，顺时针）
    const bearing = geo.bearing(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    if (prevBearing === null) {
      turnRate.push(0);
    } else {
      let diff = bearing - prevBearing;
      while (diff > 180) diff -= 360;
      while (diff < -180) diff += 360;
      turnRate.push(diff / dt);
    }
    prevBearing = bearing;
    prevT = points[i].t;
  }
  return { vv, hv, turnRate, dtArr };
}

/**
 * 窗口内满足条件的点数（含中心，窗口对称）
 */
function windowVotes(arr, i, cond, half = 2) {
  let votes = 0;
  let total = 0;
  for (let j = i - half; j <= i + half; j++) {
    if (j < 0 || j >= arr.length) continue;
    total++;
    if (cond(arr[j], j)) votes++;
  }
  return total > 0 ? votes / total : 0;
}

/**
 * 窗口内均值（用于下沉判据，避免振荡误报失速）
 */
function windowMean(arr, i, half = 2) {
  let sum = 0;
  let total = 0;
  for (let j = i - half; j <= i + half; j++) {
    if (j < 0 || j >= arr.length) continue;
    sum += arr[j];
    total++;
  }
  return total > 0 ? sum / total : 0;
}

/**
 * 俯仰振荡预标记：垂直速度在窗口内多次正负交替且振幅足够
 * @returns {boolean[]} oscFlag
 */
function detectOscillation(vv, ts) {
  const n = vv.length;
  const osc = new Array(n).fill(false);
  for (let i = 1; i < n; i++) {
    // 回溯 oscWindow 秒内的摆动次数与最大振幅
    const t0 = ts[i] - TH.oscWindow * 1000;
    let sign = 0;
    let swings = 0;
    let maxAmpl = 0;
    for (let j = i; j >= 0 && ts[j] >= t0; j--) {
      const v = vv[j];
      const s = v > TH.oscThreshold ? 1 : v < -TH.oscThreshold ? -1 : 0;
      if (s !== 0) {
        if (sign !== 0 && s !== sign) swings++;
        sign = s;
      }
      if (Math.abs(v) > maxAmpl) maxAmpl = Math.abs(v);
    }
    if (swings >= TH.oscMinSwings && maxAmpl >= TH.oscMinAmpl) {
      osc[i] = true;
    }
  }
  return osc;
}

/**
 * 起飞 / 降落段定位
 */
function locateEnds(points) {
  const n = points.length;
  let takeoffEnd = 0;
  let landingStart = n - 1;
  if (n < 3) return { takeoffEnd, landingStart };
  const takeoffAlt = points[0].alt;
  const landingAlt = points[n - 1].alt;
  // 起飞：首次持续抬升（连续 10s 高于起飞点 15m），上限 90s
  const tMax = points[0].t + 90 * 1000;
  let streak = 0;
  for (let i = 1; i < n && points[i].t <= tMax; i++) {
    streak = points[i].alt >= takeoffAlt + 15 ? streak + 1 : 0;
    if (streak >= 5) {
      takeoffEnd = i;
      break;
    }
  }
  // 降落：从末端回扫，找到首次低于降落点 40m 的位置，保证至少 10s 长度
  for (let i = n - 1; i >= 0; i--) {
    if (points[i].alt <= landingAlt + 40) {
      landingStart = i;
      break;
    }
  }
  let dur = (points[n - 1].t - points[landingStart].t) / 1000;
  if (dur < 10) {
    for (let i = landingStart - 1; i >= 0; i--) {
      landingStart = i;
      dur = (points[n - 1].t - points[landingStart].t) / 1000;
      if (dur >= 10) break;
    }
  }
  return { takeoffEnd, landingStart };
}

/**
 * 主入口：识别全段飞行状态
 * @param {Array<{t:number,lat:number,lon:number,alt:number}>} points
 * @returns {{
 *   states: Array<{key:string,label:string,severity:number,startIdx:number,endIdx:number,
 *                  startT:number,endT:number,duration:number,color:string}>,
 *   stateCounts: object, dangerCount: number, hasDanger: boolean,
 *   pointState: string[]
 * }}
 */
function detectFlightStates(points) {
  const n = points.length;
  const empty = {
    states: [],
    stateCounts: {},
    dangerCount: 0,
    hasDanger: false,
    pointState: []
  };
  if (n < 5) return empty;

  const { vv, hv, turnRate, dtArr } = perPointKinematics(points);
  const ts = points.map((p) => p.t);
  const osc = detectOscillation(vv, ts);
  const { takeoffEnd, landingStart } = locateEnds(points);

  // 地速滚动基准（中位数，用于大耳朵判定）
  const baseline = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const t0 = ts[i] - TH.baselineWin * 1000;
    const win = [];
    for (let j = i; j >= 0 && ts[j] >= t0; j--) {
      if (hv[j] > 1) win.push(hv[j]);
    }
    if (win.length >= 5) {
      const sorted = win.slice().sort((a, b) => a - b);
      baseline[i] = sorted[Math.floor(sorted.length / 2)];
    } else {
      baseline[i] = hv[i] || 0;
    }
  }

  const state = new Array(n).fill('cruise');

  for (let i = 1; i < n; i++) {
    // 1) 全失速：地速塌陷 + 窗口平均下沉（振荡态均值≈0 不会误报）
    if (
      windowVotes(hv, i, (v) => v < TH.stallSpeed) >= 0.6 &&
      windowVotes(vv, i, (v) => v < 0) >= 0.6 &&
      windowMean(vv, i) < TH.stallSink
    ) {
      state[i] = 'fullStall';
      continue;
    }
    // 2) 高速下沉（无高转弯）
    if (
      windowMean(vv, i) < TH.deepSink &&
      windowVotes(turnRate, i, (v) => Math.abs(v) < TH.spiralTurn) >= 0.6
    ) {
      state[i] = 'deepSink';
      continue;
    }
    // 3) 螺旋下降：高转弯 + 高下沉
    if (
      windowVotes(turnRate, i, (v) => Math.abs(v) > TH.spiralTurn) >= 0.6 &&
      windowMean(vv, i) < TH.spiralSink
    ) {
      state[i] = 'spiral';
      continue;
    }
    // 4) 急转（疑似塌陷）：短时大幅转向 + 下沉
    if (
      windowVotes(turnRate, i, (v) => Math.abs(v) > TH.sharpTurnRate) >= 0.6 &&
      windowVotes(vv, i, (v) => v < TH.sharpTurnSink) >= 0.6
    ) {
      state[i] = 'sharpTurn';
      continue;
    }
    // 5) 俯仰振荡
    if (osc[i]) {
      state[i] = 'pitchOsc';
      continue;
    }
    // 6) 减速高下沉（疑似大耳朵/深度刹车）
    if (
      baseline[i] > 6 &&
      hv[i] > TH.earsSpeedLo * baseline[i] &&
      hv[i] < TH.earsSpeedHi * baseline[i] &&
      vv[i] > TH.earsSinkLo &&
      vv[i] < TH.earsSinkHi &&
      windowVotes(turnRate, i, (v) => Math.abs(v) < TH.earsTurn) >= 0.6
    ) {
      state[i] = 'bigEars';
      continue;
    }
    // 7) 盘旋上升（热气流）
    if (
      windowVotes(vv, i, (v) => v > TH.thermalClimb) >= 0.6 &&
      windowVotes(turnRate, i, (v) => Math.abs(v) > TH.thermalTurn) >= 0.6
    ) {
      state[i] = 'thermal';
      continue;
    }
  }

  // 起飞 / 降落覆盖（危险状态优先保留）
  for (let i = 1; i <= takeoffEnd; i++) {
    if (state[i] === 'cruise' || state[i] === 'thermal') state[i] = 'takeoff';
  }
  for (let i = landingStart; i < n; i++) {
    if (state[i] === 'cruise' || state[i] === 'thermal' || state[i] === 'bigEars') state[i] = 'landing';
  }

  // 合并相邻同状态为分段，剔除孤点（长度 < 2 视为巡航）
  const segments = [];
  for (let i = 0; i < n; i++) {
    const key = state[i];
    const last = segments[segments.length - 1];
    if (last && last.key === key) {
      last.endIdx = i;
    } else {
      segments.push({ key, startIdx: i, endIdx: i });
    }
  }
  const cleaned = [];
  for (const seg of segments) {
    const len = seg.endIdx - seg.startIdx + 1;
    if (len < 2 && seg.key !== 'takeoff' && seg.key !== 'landing') {
      // 孤点并入相邻：直接标为巡航并合并
      for (let i = seg.startIdx; i <= seg.endIdx; i++) state[i] = 'cruise';
      const prev = cleaned[cleaned.length - 1];
      if (prev && prev.key === 'cruise') prev.endIdx = seg.endIdx;
      continue;
    }
    cleaned.push(seg);
  }

  const states = cleaned.map((seg) => {
    const def = STATE_DEFS[seg.key] || STATE_DEFS.cruise;
    return {
      key: seg.key,
      label: def.label,
      severity: def.severity,
      color: def.color,
      startIdx: seg.startIdx,
      endIdx: seg.endIdx,
      startT: points[seg.startIdx].t,
      endT: points[seg.endIdx].t,
      duration: Math.round((points[seg.endIdx].t - points[seg.startIdx].t) / 1000)
    };
  });

  const stateCounts = {};
  states.forEach((s) => {
    stateCounts[s.key] = (stateCounts[s.key] || 0) + 1;
  });
  const dangerCount = states.filter((s) => s.severity >= 2).length;

  return {
    states,
    stateCounts,
    dangerCount,
    hasDanger: dangerCount > 0,
    pointState: state
  };
}

module.exports = { detectFlightStates, STATE_DEFS, TH, perPointKinematics };
