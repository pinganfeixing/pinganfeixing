// h5-src/main.js — 解析/统计核心打包入口（浏览器版）
// 复用伞迹小程序 utils 的纯 JS 解析与统计模块，esbuild 打包为 app-core.js
const { parseIGC } = require('./utils-igc');
const { parseKML } = require('./utils-kml');
const { parseGPX } = require('./utils-gpx');
const geo = require('./utils-geo');
const stats = require('./utils-stats');
const flightStates = require('./utils-flightStates');

const core = {
  parseIGC,
  parseKML,
  parseGPX,
  geo,
  stats,
  flightStates
};

// 按文件扩展名/内容自动识别并解析（返回含容错警告与元信息：日期/场地/气象备注）
function parseTrack(text, name) {
  const lower = (name || '').toLowerCase();
  const mkMeta = (r) => ({
    date: r.flightDate ? r.flightDate.toISOString().slice(0, 10) : '',
    pilot: r.pilot || '',
    glider: r.glider || '',
    site: r.site || '',
    weather: r.weather || []
  });
  if (/\.igc$/.test(lower)) {
    const r = parseIGC(text);
    return { points: r.points, format: 'igc', warnings: r.warnings || [], meta: mkMeta(r) };
  }
  if (/\.kml$/.test(lower)) {
    return { points: parseKML(text), format: 'kml', warnings: [], meta: mkMeta({}) };
  }
  if (/\.gpx$/.test(lower)) {
    return { points: parseGPX(text), format: 'gpx', warnings: [], meta: mkMeta({}) };
  }
  // 按内容嗅探
  if (/\n[A-Z]+\d+\n/.test(text) && /^A/.test(text.trim().split('\n')[0] || '')) {
    const r = parseIGC(text);
    return { points: r.points, format: 'igc', warnings: r.warnings || [], meta: mkMeta(r) };
  }
  if (text.indexOf('<kml') >= 0) return { points: parseKML(text), format: 'kml', warnings: [], meta: mkMeta({}) };
  if (text.indexOf('<gpx') >= 0) return { points: parseGPX(text), format: 'gpx', warnings: [], meta: mkMeta({}) };
  throw new Error('无法识别文件格式（支持 IGC / KML / GPX）');
}

core.parseTrack = parseTrack;
window.SanjiCore = core;
