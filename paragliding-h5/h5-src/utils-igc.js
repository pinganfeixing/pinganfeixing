// utils/igc.js — IGC 飞行记录解析器（XCSoar 默认导出格式）
// IGC 规范要点：
//   B 记录: B{时间HHMMSS}{纬度DDMMmmmN/S}{经度DDDMMmmmE/W}{有效性}{气压高度}{GPS高度}[扩展字段]
//   H 记录: HFDTE:日期、HFPLT:飞行员、HFGFA:滑翔机型号 等
//   高度单位：绝大多数记录为米；部分老设备为英尺，可在解析后统一按米输出

const DEFAULT_YEAR = 2026;

/**
 * 解析 IGC 经纬度（如 3658100 -> 36.58100；N/E 为正）
 * @param {string} raw 原始字符串（含方向字母）
 * @returns {number|null}
 */
function parseLatLon(raw, isLat) {
  if (!raw) return null;
  const m = raw.match(/^(\d{2,3})(\d{2})(\d{3})([NSEW])$/);
  if (!m) return null;
  const deg = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const minThousand = parseInt(m[3], 10);
  const value = deg + (min + minThousand / 1000) / 60;
  const dir = m[4];
  if (isLat) {
    return dir === 'S' ? -value : value;
  }
  return dir === 'W' ? -value : value;
}

/**
 * 解析 B 记录时间 HHMMSS
 * @returns {Date} 当年日期上的时间（日期来自 HFDTE）
 */
function parseBTime(timeStr, baseDate) {
  const hh = parseInt(timeStr.slice(0, 2), 10);
  const mm = parseInt(timeStr.slice(2, 4), 10);
  const ss = parseInt(timeStr.slice(4, 6), 10);
  const d = new Date(baseDate);
  d.setHours(hh, mm, ss, 0);
  return d;
}

/**
 * 解析 IGC 文本内容
 * @param {string} text IGC 文件全文
 * @returns {object} { flightDate, pilot, glider, points, warnings }
 */
function parseIGC(text) {
  const lines = text.split(/\r?\n/);
  const points = [];
  const warnings = [];
  let flightDate = null;
  let pilot = '';
  let glider = '';
  let gliderId = '';
  let site = '';
  let altUnit = 'm'; // m / ft
  let skippedBad = 0;
  const weatherNotes = []; // 当日气象备注（从 H 记录/备注行提取）

  for (const line of lines) {
    if (!line || line.length < 2) continue;
    const type = line[0];
    const body = line.slice(1).trim();

    switch (type) {
      case 'A': {
        // AXXX... 制造商；第 25 位附近是高度单位标志（H=英尺，M=米），不强制
        const unitChar = line.length > 24 ? line[24] : '';
        if (unitChar === 'H') altUnit = 'ft';
        else if (unitChar === 'M') altUnit = 'm';
        break;
      }
      case 'H': {
        const up = body.toUpperCase();
        const dte = up.match(/^FDTE:?(\d{6})/);
        if (dte) {
          const y = parseInt(dte[1].slice(0, 2), 10);
          const fullYear = y > 70 ? 1900 + y : 2000 + y; // IGC 两位年份
          flightDate = new Date(fullYear, parseInt(dte[1].slice(2, 4), 10) - 1, parseInt(dte[1].slice(4, 6), 10));
        }
        const plt = up.match(/^FPLT:?(.*)$/);
        if (plt) pilot = plt[1].trim().replace(/^PILOT:?/i, '');
        const gfa = up.match(/^FGFA:?(.*)$/);
        if (gfa) glider = gfa[1].trim().replace(/^GLIDER:?/i, '');
        const gid = up.match(/^FGID:?(.*)$/);
        if (gid) gliderId = gid[1].trim();
        const siteM = up.match(/^FSITE:?(.*)$/);
        if (siteM) site = siteM[1].trim().replace(/^SITE:?/i, '');
        // 气象/风况备注：含风、天气、气象、wind、weather、WX 关键词的 H 记录
        if (/(风|天气|气象|云|雨|wind|weather|metar|wx)/i.test(up)) {
          const note = body.replace(/^[A-Z]+:?/, '').trim();
          if (note && note.length < 120) weatherNotes.push(note);
        }
        break;
      }
      case 'B': {
        // 兼容两种布局：
        //   定宽标准：B1000003612600N11654000EA0040000400
        //   带空格变体：B 100000 3612600N 11654000E A 00400 00400
        const b = line.slice(1).replace(/\s+/g, '');
        if (b.length < 30) {
          skippedBad++;
          continue;
        }
        const timeStr = b.slice(0, 6);
        const latRaw = b.slice(6, 14);   // DDMMmmm + N/S
        const lonRaw = b.slice(14, 23);  // DDDMMmmm + E/W
        const pressureAlt = parseInt(b.slice(24, 29), 10);
        const gpsAlt = parseInt(b.slice(29, 34), 10);
        const lat = parseLatLon(latRaw, true);
        const lon = parseLatLon(lonRaw, false);
        if (lat === null || lon === null || isNaN(pressureAlt) || isNaN(gpsAlt)) {
          skippedBad++;
          continue;
        }
        const base = flightDate || new Date(DEFAULT_YEAR, 0, 1);
        const t = parseBTime(timeStr, base);
        const alt = altUnit === 'ft' ? gpsAlt * 0.3048 : gpsAlt;
        points.push({
          t: t.getTime(),
          lat,
          lon,
          alt,
          pressureAlt: altUnit === 'ft' ? pressureAlt * 0.3048 : pressureAlt
        });
        break;
      }
      default:
        break;
    }
  }

  if (!points.length) {
    warnings.push('未解析到有效的 B 记录（飞行点），请确认是 IGC 轨迹文件');
  }
  if (skippedBad > 0) {
    warnings.push(`已跳过 ${skippedBad} 条异常飞行点记录`);
  }

  // 按时间排序并去重（同时间点取后一个）
  points.sort((a, b) => a.t - b.t);
  const dedup = [];
  for (const p of points) {
    if (dedup.length && dedup[dedup.length - 1].t === p.t) continue;
    dedup.push(p);
  }

  return {
    flightDate,
    pilot,
    glider,
    gliderId,
    site,
    altUnit,
    // 气象快照：去重后的当日气象备注（用于导入时显示"当日风况预估"）
    weather: [...new Set(weatherNotes)],
    points: dedup,
    warnings
  };
}

module.exports = { parseIGC, parseLatLon };
