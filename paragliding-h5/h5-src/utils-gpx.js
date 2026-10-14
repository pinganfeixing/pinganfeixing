// utils/gpx.js — GPX 轨迹解析
const RE_TRKPT = /<trkpt[^>]*>([\s\S]*?)<\/trkpt>/gi;

/**
 * 解析 GPX 文本
 * @param {string} text
 * @returns {object} { name, points, warnings }
 */
function parseGPX(text) {
  const warnings = [];
  let clean = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '');

  const nameMatch = clean.match(/<name>([^<]+)<\/name>/i);
  const name = nameMatch ? nameMatch[1].trim() : '';

  const points = [];
  const blocks = clean.match(RE_TRKPT) || [];
  let idx = 0;
  for (const block of blocks) {
    const latM = block.match(/\blat="([^"]+)"/i);
    const lonM = block.match(/\blon="([^"]+)"/i);
    if (!latM || !lonM) continue;
    const lat = parseFloat(latM[1]);
    const lon = parseFloat(lonM[1]);
    if (isNaN(lat) || isNaN(lon)) continue;

    const eleM = block.match(/<ele>([^<]+)<\/ele>/i);
    const timeM = block.match(/<time>([^<]+)<\/time>/i);
    const alt = eleM ? parseFloat(eleM[1]) : 0;
    let t = timeM ? new Date(timeM[1]).getTime() : Date.now() + idx * 1000;

    // 时间异常时回退为虚拟时间
    if (isNaN(t)) t = Date.now() + idx * 1000;
    points.push({ t, lat, lon, alt: isNaN(alt) ? 0 : alt });
    idx++;
  }

  if (!points.length) {
    warnings.push('GPX 中未找到 <trkpt> 轨迹点');
  }
  points.sort((a, b) => a.t - b.t);
  return { name, points, warnings };
}

module.exports = { parseGPX };
