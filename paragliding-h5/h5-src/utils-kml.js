// utils/kml.js — KML 轨迹解析（XCSoar 可导出 KML；同时支持 Google Earth gx:Track）
const RE_COORD = /<coordinates>([\s\S]*?)<\/coordinates>/gi;
const RE_TRACK = /<gx:Track>([\s\S]*?)<\/gx:Track>/gi;
const RE_WHEN = /<when>([^<]+)<\/when>/gi;
const RE_GXCOORD = /<gx:coord>([^<]+)<\/gx:coord>/gi;

/**
 * 解析 KML 文本
 * @param {string} text
 * @returns {object} { name, points, warnings }
 */
function parseKML(text) {
  const warnings = [];
  // 剥离注释与 XML 声明
  let clean = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '');

  const nameMatch = clean.match(/<name>([^<]+)<\/name>/i);
  const name = nameMatch ? nameMatch[1].trim() : '';

  let points = [];

  // 优先解析 gx:Track（带时间）
  const trackMatch = clean.match(RE_TRACK);
  if (trackMatch) {
    for (const block of trackMatch) {
      const times = [...block.matchAll(RE_WHEN)].map((m) => new Date(m[1]).getTime());
      const coords = [...block.matchAll(RE_GXCOORD)].map((m) => {
        const parts = m[1].trim().split(/\s+/).map(Number);
        return { lon: parts[0], lat: parts[1], alt: parts[2] || 0 };
      });
      coords.forEach((c, i) => {
        if (isNaN(c.lon) || isNaN(c.lat)) return;
        points.push({
          t: times[i] || (Date.now() + i * 1000),
          lat: c.lat,
          lon: c.lon,
          alt: c.alt || 0
        });
      });
    }
  }

  // 其次解析 LineString coordinates
  if (!points.length) {
    const coordBlocks = clean.match(RE_COORD);
    if (coordBlocks) {
      for (const block of coordBlocks) {
        const inner = block.replace(/<\/?coordinates>/gi, '').trim();
        const triplets = inner.split(/\s+/).filter((s) => s.length > 0);
        let idx = 0;
        for (const t of triplets) {
          const parts = t.split(',').map(Number);
          if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            points.push({
              t: Date.now() + idx * 1000, // KML LineString 无时间，按 1s 间隔虚拟
              lat: parts[1],
              lon: parts[0],
              alt: parts[2] || 0
            });
            idx++;
          }
        }
      }
    }
  }

  if (!points.length) {
    warnings.push('KML 中未找到 <coordinates> 或 <gx:Track> 轨迹数据');
  }
  points.sort((a, b) => a.t - b.t);
  return { name, points, warnings };
}

module.exports = { parseKML };
