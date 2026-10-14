var SanjiCoreBundle = (() => {
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __commonJS = (cb, mod) => function __require() {
    try {
      return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
    } catch (e) {
      throw mod = 0, e;
    }
  };

  // h5-src/utils-igc.js
  var require_utils_igc = __commonJS({
    "h5-src/utils-igc.js"(exports, module) {
      var DEFAULT_YEAR = 2026;
      function parseLatLon(raw, isLat) {
        if (!raw) return null;
        const m = raw.match(/^(\d{2,3})(\d{2})(\d{3})([NSEW])$/);
        if (!m) return null;
        const deg = parseInt(m[1], 10);
        const min = parseInt(m[2], 10);
        const minThousand = parseInt(m[3], 10);
        const value = deg + (min + minThousand / 1e3) / 60;
        const dir = m[4];
        if (isLat) {
          return dir === "S" ? -value : value;
        }
        return dir === "W" ? -value : value;
      }
      function parseBTime(timeStr, baseDate) {
        const hh = parseInt(timeStr.slice(0, 2), 10);
        const mm = parseInt(timeStr.slice(2, 4), 10);
        const ss = parseInt(timeStr.slice(4, 6), 10);
        const d = new Date(baseDate);
        d.setHours(hh, mm, ss, 0);
        return d;
      }
      function parseIGC2(text) {
        const lines = text.split(/\r?\n/);
        const points = [];
        const warnings = [];
        let flightDate = null;
        let pilot = "";
        let glider = "";
        let gliderId = "";
        let site = "";
        let altUnit = "m";
        let skippedBad = 0;
        const weatherNotes = [];
        for (const line of lines) {
          if (!line || line.length < 2) continue;
          const type = line[0];
          const body = line.slice(1).trim();
          switch (type) {
            case "A": {
              const unitChar = line.length > 24 ? line[24] : "";
              if (unitChar === "H") altUnit = "ft";
              else if (unitChar === "M") altUnit = "m";
              break;
            }
            case "H": {
              const up = body.toUpperCase();
              const dte = up.match(/^FDTE:?(\d{6})/);
              if (dte) {
                const y = parseInt(dte[1].slice(0, 2), 10);
                const fullYear = y > 70 ? 1900 + y : 2e3 + y;
                flightDate = new Date(fullYear, parseInt(dte[1].slice(2, 4), 10) - 1, parseInt(dte[1].slice(4, 6), 10));
              }
              const plt = up.match(/^FPLT:?(.*)$/);
              if (plt) pilot = plt[1].trim().replace(/^PILOT:?/i, "");
              const gfa = up.match(/^FGFA:?(.*)$/);
              if (gfa) glider = gfa[1].trim().replace(/^GLIDER:?/i, "");
              const gid = up.match(/^FGID:?(.*)$/);
              if (gid) gliderId = gid[1].trim();
              const siteM = up.match(/^FSITE:?(.*)$/);
              if (siteM) site = siteM[1].trim().replace(/^SITE:?/i, "");
              if (/(风|天气|气象|云|雨|wind|weather|metar|wx)/i.test(up)) {
                const note = body.replace(/^[A-Z]+:?/, "").trim();
                if (note && note.length < 120) weatherNotes.push(note);
              }
              break;
            }
            case "B": {
              const b = line.slice(1).replace(/\s+/g, "");
              if (b.length < 30) {
                skippedBad++;
                continue;
              }
              const timeStr = b.slice(0, 6);
              const latRaw = b.slice(6, 14);
              const lonRaw = b.slice(14, 23);
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
              const alt = altUnit === "ft" ? gpsAlt * 0.3048 : gpsAlt;
              points.push({
                t: t.getTime(),
                lat,
                lon,
                alt,
                pressureAlt: altUnit === "ft" ? pressureAlt * 0.3048 : pressureAlt
              });
              break;
            }
            default:
              break;
          }
        }
        if (!points.length) {
          warnings.push("\u672A\u89E3\u6790\u5230\u6709\u6548\u7684 B \u8BB0\u5F55\uFF08\u98DE\u884C\u70B9\uFF09\uFF0C\u8BF7\u786E\u8BA4\u662F IGC \u8F68\u8FF9\u6587\u4EF6");
        }
        if (skippedBad > 0) {
          warnings.push(`\u5DF2\u8DF3\u8FC7 ${skippedBad} \u6761\u5F02\u5E38\u98DE\u884C\u70B9\u8BB0\u5F55`);
        }
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
      module.exports = { parseIGC: parseIGC2, parseLatLon };
    }
  });

  // h5-src/utils-kml.js
  var require_utils_kml = __commonJS({
    "h5-src/utils-kml.js"(exports, module) {
      var RE_COORD = /<coordinates>([\s\S]*?)<\/coordinates>/gi;
      var RE_TRACK = /<gx:Track>([\s\S]*?)<\/gx:Track>/gi;
      var RE_WHEN = /<when>([^<]+)<\/when>/gi;
      var RE_GXCOORD = /<gx:coord>([^<]+)<\/gx:coord>/gi;
      function parseKML2(text) {
        const warnings = [];
        let clean = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "");
        const nameMatch = clean.match(/<name>([^<]+)<\/name>/i);
        const name = nameMatch ? nameMatch[1].trim() : "";
        let points = [];
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
                t: times[i] || Date.now() + i * 1e3,
                lat: c.lat,
                lon: c.lon,
                alt: c.alt || 0
              });
            });
          }
        }
        if (!points.length) {
          const coordBlocks = clean.match(RE_COORD);
          if (coordBlocks) {
            for (const block of coordBlocks) {
              const inner = block.replace(/<\/?coordinates>/gi, "").trim();
              const triplets = inner.split(/\s+/).filter((s) => s.length > 0);
              let idx = 0;
              for (const t of triplets) {
                const parts = t.split(",").map(Number);
                if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
                  points.push({
                    t: Date.now() + idx * 1e3,
                    // KML LineString 无时间，按 1s 间隔虚拟
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
          warnings.push("KML \u4E2D\u672A\u627E\u5230 <coordinates> \u6216 <gx:Track> \u8F68\u8FF9\u6570\u636E");
        }
        points.sort((a, b) => a.t - b.t);
        return { name, points, warnings };
      }
      module.exports = { parseKML: parseKML2 };
    }
  });

  // h5-src/utils-gpx.js
  var require_utils_gpx = __commonJS({
    "h5-src/utils-gpx.js"(exports, module) {
      var RE_TRKPT = /<trkpt[^>]*>([\s\S]*?)<\/trkpt>/gi;
      function parseGPX2(text) {
        const warnings = [];
        let clean = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "");
        const nameMatch = clean.match(/<name>([^<]+)<\/name>/i);
        const name = nameMatch ? nameMatch[1].trim() : "";
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
          let t = timeM ? new Date(timeM[1]).getTime() : Date.now() + idx * 1e3;
          if (isNaN(t)) t = Date.now() + idx * 1e3;
          points.push({ t, lat, lon, alt: isNaN(alt) ? 0 : alt });
          idx++;
        }
        if (!points.length) {
          warnings.push("GPX \u4E2D\u672A\u627E\u5230 <trkpt> \u8F68\u8FF9\u70B9");
        }
        points.sort((a, b) => a.t - b.t);
        return { name, points, warnings };
      }
      module.exports = { parseGPX: parseGPX2 };
    }
  });

  // h5-src/utils-geo.js
  var require_utils_geo = __commonJS({
    "h5-src/utils-geo.js"(exports, module) {
      var R = 6371e3;
      function haversine(lat1, lon1, lat2, lon2) {
        const toRad = (d) => d * Math.PI / 180;
        const dLat = toRad(lat2 - lat1);
        const dLon = toRad(lon2 - lon1);
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * R * Math.asin(Math.sqrt(a));
      }
      function trackLength(points) {
        let len = 0;
        for (let i = 1; i < points.length; i++) {
          len += haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
        }
        return len;
      }
      function speedBetween(a, b) {
        const dt = Math.max((b.t - a.t) / 1e3, 0.5);
        return haversine(a.lat, a.lon, b.lat, b.lon) / dt;
      }
      function toLocalXY(points, baseLat, baseLon) {
        const mPerDegLat = 111320;
        const mPerDegLon = 111320 * Math.cos(baseLat * Math.PI / 180);
        return points.map((p) => ({
          x: (p.lon - baseLon) * mPerDegLon,
          y: (baseLat - p.lat) * mPerDegLat,
          // 北为正，翻转使屏幕上方为北
          z: p.alt || 0
        }));
      }
      function bearing(lat1, lon1, lat2, lon2) {
        const toRad = (d) => d * Math.PI / 180;
        const toDeg = (d) => d * 180 / Math.PI;
        const \u03C61 = toRad(lat1);
        const \u03C62 = toRad(lat2);
        const \u0394\u03BB = toRad(lon2 - lon1);
        const y = Math.sin(\u0394\u03BB) * Math.cos(\u03C62);
        const x = Math.cos(\u03C61) * Math.sin(\u03C62) - Math.sin(\u03C61) * Math.cos(\u03C62) * Math.cos(\u0394\u03BB);
        return (toDeg(Math.atan2(y, x)) + 360) % 360;
      }
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
      function formatDuration(sec) {
        sec = Math.max(0, Math.round(sec));
        const h = Math.floor(sec / 3600);
        const m = Math.floor(sec % 3600 / 60);
        const s = sec % 60;
        const pad = (n) => n < 10 ? "0" + n : "" + n;
        return `${pad(h)}:${pad(m)}:${pad(s)}`;
      }
      function formatDistance(m) {
        if (m >= 1e3) return (m / 1e3).toFixed(1) + " km";
        return Math.round(m) + " m";
      }
      function formatSpeed(ms) {
        return Math.round(ms * 3.6) + " km/h";
      }
      function formatTime(ms) {
        const d = new Date(ms);
        const pad = (n) => n < 10 ? "0" + n : "" + n;
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
    }
  });

  // h5-src/utils-flightStates.js
  var require_utils_flightStates = __commonJS({
    "h5-src/utils-flightStates.js"(exports, module) {
      var geo2 = require_utils_geo();
      var STATE_DEFS = {
        takeoff: { key: "takeoff", label: "\u8D77\u98DE", color: "#22c55e", severity: 0 },
        cruise: { key: "cruise", label: "\u5DE1\u822A", color: "#38bdf8", severity: 0 },
        thermal: { key: "thermal", label: "\u76D8\u65CB\u4E0A\u5347", color: "#fb923c", severity: 0 },
        landing: { key: "landing", label: "\u964D\u843D", color: "#94a3b8", severity: 0 },
        bigEars: { key: "bigEars", label: "\u51CF\u901F\u9AD8\u4E0B\u6C89", color: "#f97316", severity: 1 },
        sharpTurn: { key: "sharpTurn", label: "\u6025\u8F6C(\u7591\u4F3C\u584C\u9677)", color: "#eab308", severity: 2 },
        pitchOsc: { key: "pitchOsc", label: "\u4FEF\u4EF0\u632F\u8361", color: "#a855f7", severity: 2 },
        spiral: { key: "spiral", label: "\u87BA\u65CB\u4E0B\u964D", color: "#f43f5e", severity: 2 },
        deepSink: { key: "deepSink", label: "\u9AD8\u901F\u4E0B\u6C89", color: "#ef4444", severity: 2 },
        fullStall: { key: "fullStall", label: "\u5168\u5931\u901F", color: "#dc2626", severity: 3 }
      };
      var TH = {
        minDt: 0.5,
        // 有效采样间隔下限（秒）
        maxDt: 15,
        // 采样间隔上限，超过视为数据缺口
        stallSpeed: 5,
        // 全失速地速上限（m/s，≈18km/h）
        stallSink: -3.5,
        // 全失速下沉率（m/s）
        deepSink: -6,
        // 高速下沉（m/s）
        spiralTurn: 40,
        // 螺旋最小转弯率（°/s）
        spiralSink: -4,
        // 螺旋下沉率（m/s）
        sharpTurnRate: 60,
        // 急转阈值（°/s）
        sharpTurnSink: -1,
        // 急转时下沉阈值
        oscThreshold: 0.8,
        // 俯仰振荡：垂直速度符号判定阈值（m/s）
        oscMinAmpl: 1.5,
        // 俯仰振荡：单次振幅下限（m/s）
        oscMinSwings: 3,
        // 俯仰振荡：窗口内摆动次数下限
        oscWindow: 12,
        // 俯仰振荡：观察窗口（秒）
        earsSpeedLo: 0.3,
        // 大耳朵/减速：地速相对基准的下限比例
        earsSpeedHi: 0.65,
        // 大耳朵/减速：地速相对基准的上限比例
        earsSinkLo: -5,
        // 大耳朵下沉区间
        earsSinkHi: -2.5,
        earsTurn: 25,
        // 大耳朵时转弯率上限
        thermalClimb: 0.8,
        // 盘旋上升爬升率下限
        thermalTurn: 8,
        // 盘旋上升转弯率下限
        sustainWindow: 5,
        // 危险判定平滑窗口（点数）
        baselineWin: 30
        // 地速基准窗口（秒）
      };
      function perPointKinematics(points) {
        const n = points.length;
        const vv = [0];
        const hv = [0];
        const turnRate = [0];
        const dtArr = [0];
        let prevBearing = null;
        let prevT = points[0].t;
        for (let i = 1; i < n; i++) {
          const dt = Math.min(Math.max((points[i].t - points[i - 1].t) / 1e3, TH.minDt), TH.maxDt);
          dtArr.push(dt);
          vv.push((points[i].alt - points[i - 1].alt) / dt);
          const d = geo2.haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
          hv.push(d / dt);
          const bearing = geo2.bearing(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
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
      function detectOscillation(vv, ts) {
        const n = vv.length;
        const osc = new Array(n).fill(false);
        for (let i = 1; i < n; i++) {
          const t0 = ts[i] - TH.oscWindow * 1e3;
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
      function locateEnds(points) {
        const n = points.length;
        let takeoffEnd = 0;
        let landingStart = n - 1;
        if (n < 3) return { takeoffEnd, landingStart };
        const takeoffAlt = points[0].alt;
        const landingAlt = points[n - 1].alt;
        const tMax = points[0].t + 90 * 1e3;
        let streak = 0;
        for (let i = 1; i < n && points[i].t <= tMax; i++) {
          streak = points[i].alt >= takeoffAlt + 15 ? streak + 1 : 0;
          if (streak >= 5) {
            takeoffEnd = i;
            break;
          }
        }
        for (let i = n - 1; i >= 0; i--) {
          if (points[i].alt <= landingAlt + 40) {
            landingStart = i;
            break;
          }
        }
        let dur = (points[n - 1].t - points[landingStart].t) / 1e3;
        if (dur < 10) {
          for (let i = landingStart - 1; i >= 0; i--) {
            landingStart = i;
            dur = (points[n - 1].t - points[landingStart].t) / 1e3;
            if (dur >= 10) break;
          }
        }
        return { takeoffEnd, landingStart };
      }
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
        const baseline = new Array(n).fill(0);
        for (let i = 0; i < n; i++) {
          const t0 = ts[i] - TH.baselineWin * 1e3;
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
        const state = new Array(n).fill("cruise");
        for (let i = 1; i < n; i++) {
          if (windowVotes(hv, i, (v) => v < TH.stallSpeed) >= 0.6 && windowVotes(vv, i, (v) => v < 0) >= 0.6 && windowMean(vv, i) < TH.stallSink) {
            state[i] = "fullStall";
            continue;
          }
          if (windowMean(vv, i) < TH.deepSink && windowVotes(turnRate, i, (v) => Math.abs(v) < TH.spiralTurn) >= 0.6) {
            state[i] = "deepSink";
            continue;
          }
          if (windowVotes(turnRate, i, (v) => Math.abs(v) > TH.spiralTurn) >= 0.6 && windowMean(vv, i) < TH.spiralSink) {
            state[i] = "spiral";
            continue;
          }
          if (windowVotes(turnRate, i, (v) => Math.abs(v) > TH.sharpTurnRate) >= 0.6 && windowVotes(vv, i, (v) => v < TH.sharpTurnSink) >= 0.6) {
            state[i] = "sharpTurn";
            continue;
          }
          if (osc[i]) {
            state[i] = "pitchOsc";
            continue;
          }
          if (baseline[i] > 6 && hv[i] > TH.earsSpeedLo * baseline[i] && hv[i] < TH.earsSpeedHi * baseline[i] && vv[i] > TH.earsSinkLo && vv[i] < TH.earsSinkHi && windowVotes(turnRate, i, (v) => Math.abs(v) < TH.earsTurn) >= 0.6) {
            state[i] = "bigEars";
            continue;
          }
          if (windowVotes(vv, i, (v) => v > TH.thermalClimb) >= 0.6 && windowVotes(turnRate, i, (v) => Math.abs(v) > TH.thermalTurn) >= 0.6) {
            state[i] = "thermal";
            continue;
          }
        }
        for (let i = 1; i <= takeoffEnd; i++) {
          if (state[i] === "cruise" || state[i] === "thermal") state[i] = "takeoff";
        }
        for (let i = landingStart; i < n; i++) {
          if (state[i] === "cruise" || state[i] === "thermal" || state[i] === "bigEars") state[i] = "landing";
        }
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
          if (len < 2 && seg.key !== "takeoff" && seg.key !== "landing") {
            for (let i = seg.startIdx; i <= seg.endIdx; i++) state[i] = "cruise";
            const prev = cleaned[cleaned.length - 1];
            if (prev && prev.key === "cruise") prev.endIdx = seg.endIdx;
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
            duration: Math.round((points[seg.endIdx].t - points[seg.startIdx].t) / 1e3)
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
    }
  });

  // h5-src/utils-stats.js
  var require_utils_stats = __commonJS({
    "h5-src/utils-stats.js"(exports, module) {
      var geo2 = require_utils_geo();
      var { detectFlightStates } = require_utils_flightStates();
      function perPointVelocities(points) {
        const vv = [0];
        const hv = [0];
        for (let i = 1; i < points.length; i++) {
          const dt = (points[i].t - points[i - 1].t) / 1e3;
          if (dt < 0.2) {
            vv.push(0);
            hv.push(0);
            continue;
          }
          vv.push((points[i].alt - points[i - 1].alt) / dt);
          hv.push(geo2.haversine(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon) / dt);
        }
        return { vv, hv };
      }
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
          const duration = (seg[seg.length - 1].t - seg[0].t) / 1e3;
          if (duration < minDuration) {
            segStart = -1;
            return;
          }
          const drift = geo2.haversine(
            seg[0].lat,
            seg[0].lon,
            seg[seg.length - 1].lat,
            seg[seg.length - 1].lon
          );
          if (drift > maxDrift) {
            segStart = -1;
            return;
          }
          const avgClimb = seg.reduce((s, p, i) => i > 0 ? s + vv[segStart + i] : s, 0) / (seg.length - 1);
          if (avgClimb < minClimb) {
            segStart = -1;
            return;
          }
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
            segStart = i - 1;
          } else if (!climbing && segStart >= 0) {
            flush(i);
          }
        }
        if (segStart >= 0) flush(vv.length - 1);
        const merged = [];
        for (const th of thermals) {
          const last = merged[merged.length - 1];
          if (last && th.startT - last.endT < 1e4) {
            const dC = geo2.haversine(last.centerLat, last.centerLon, th.centerLat, th.centerLon);
            if (dC < 100) {
              last.endT = th.endT;
              last.duration = Math.round((th.endT - last.startT) / 1e3);
              last.altGain += th.altGain;
              last.avgClimb = Math.round((last.avgClimb + th.avgClimb) / 2 * 100) / 100;
              continue;
            }
          }
          merged.push(th);
        }
        return merged;
      }
      function computeStats(points) {
        const n = points.length;
        const stats2 = {
          pointCount: n,
          durationSec: 0,
          totalDistance: 0,
          straightDistance: 0,
          maxAlt: 0,
          minAlt: 0,
          takeoffAlt: 0,
          landingAlt: 0,
          maxClimb: 0,
          // m/s
          maxSink: 0,
          // m/s
          avgSpeed: 0,
          // m/s（水平，基于总距离/时长）
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
        if (n < 2) return stats2;
        const { vv, hv } = perPointVelocities(points);
        const alts = points.map((p) => p.alt);
        stats2.maxAlt = Math.round(Math.max(...alts));
        stats2.minAlt = Math.round(Math.min(...alts));
        stats2.takeoffAlt = Math.round(points[0].alt);
        stats2.landingAlt = Math.round(points[n - 1].alt);
        let maxClimb = 0;
        let maxSink = 0;
        for (let i = 1; i < n; i++) {
          if (vv[i] > maxClimb) maxClimb = vv[i];
          if (vv[i] < maxSink) maxSink = vv[i];
        }
        stats2.maxClimb = Math.round(maxClimb * 100) / 100;
        stats2.maxSink = Math.round(maxSink * 100) / 100;
        stats2.totalDistance = Math.round(geo2.trackLength(points));
        stats2.straightDistance = Math.round(
          geo2.haversine(points[0].lat, points[0].lon, points[n - 1].lat, points[n - 1].lon)
        );
        stats2.durationSec = Math.round((points[n - 1].t - points[0].t) / 1e3);
        stats2.avgSpeed = stats2.durationSec > 0 ? Math.round(stats2.totalDistance / stats2.durationSec * 100) / 100 : 0;
        const cum = geo2.cumulatives(points, 0);
        stats2.cumulativeUp = Math.round(cum.up);
        stats2.cumulativeDown = Math.round(cum.down);
        stats2.thermals = findThermals(points);
        stats2.thermalCount = stats2.thermals.length;
        const fs = detectFlightStates(points);
        stats2.states = fs.states;
        stats2.stateCounts = fs.stateCounts;
        stats2.dangerCount = fs.dangerCount;
        stats2.hasDanger = fs.hasDanger;
        return stats2;
      }
      function thermalEfficiency(stats2) {
        const ths = stats2.thermals || [];
        if (!ths.length) {
          return { totalGain: 0, totalThermalSec: 0, utilizationPct: 0, bestClimb: 0, thermalCount: 0 };
        }
        const totalGain = ths.reduce((s, t) => s + (t.altGain || 0), 0);
        const totalThermalSec = ths.reduce((s, t) => s + (t.duration || 0), 0);
        const flightSec = stats2.durationSec || 1;
        const utilizationPct = Math.round(totalThermalSec / flightSec * 100);
        const bestClimb = Math.max.apply(null, ths.map((t) => t.avgClimb || 0));
        return {
          totalGain,
          totalThermalSec,
          utilizationPct,
          bestClimb: Math.round(bestClimb * 100) / 100,
          thermalCount: ths.length
        };
      }
      function computeScore(stats2, takeoffAlt) {
        const straightKm = Math.round((stats2.straightDistance || 0) / 1e3 * 10) / 10;
        const relMax = Math.max(0, (stats2.maxAlt || 0) - (takeoffAlt || 0));
        const distScore = Math.round(straightKm * 2);
        const climbScore = Math.round((stats2.thermalCount || 0) * 3 + relMax / 100);
        const score = distScore + climbScore;
        return {
          straightKm,
          triangleKm: Math.round(straightKm * 0.7),
          // 简化三角航程估算（非 FAI 精确计算）
          score,
          parts: { distScore, climbScore, relMax }
        };
      }
      function decimate(points, maxPoints = 4e3) {
        if (points.length <= maxPoints) return points;
        const step = Math.ceil(points.length / maxPoints);
        const out = [];
        for (let i = 0; i < points.length; i += step) out.push(points[i]);
        if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
        return out;
      }
      module.exports = { computeStats, findThermals, perPointVelocities, decimate, thermalEfficiency, computeScore };
    }
  });

  // h5-src/main.js
  var { parseIGC } = require_utils_igc();
  var { parseKML } = require_utils_kml();
  var { parseGPX } = require_utils_gpx();
  var geo = require_utils_geo();
  var stats = require_utils_stats();
  var flightStates = require_utils_flightStates();
  var core = {
    parseIGC,
    parseKML,
    parseGPX,
    geo,
    stats,
    flightStates
  };
  function parseTrack(text, name) {
    const lower = (name || "").toLowerCase();
    const mkMeta = (r) => ({
      date: r.flightDate ? r.flightDate.toISOString().slice(0, 10) : "",
      pilot: r.pilot || "",
      glider: r.glider || "",
      site: r.site || "",
      weather: r.weather || []
    });
    if (/\.igc$/.test(lower)) {
      const r = parseIGC(text);
      return { points: r.points, format: "igc", warnings: r.warnings || [], meta: mkMeta(r) };
    }
    if (/\.kml$/.test(lower)) {
      return { points: parseKML(text), format: "kml", warnings: [], meta: mkMeta({}) };
    }
    if (/\.gpx$/.test(lower)) {
      return { points: parseGPX(text), format: "gpx", warnings: [], meta: mkMeta({}) };
    }
    if (/\n[A-Z]+\d+\n/.test(text) && /^A/.test(text.trim().split("\n")[0] || "")) {
      const r = parseIGC(text);
      return { points: r.points, format: "igc", warnings: r.warnings || [], meta: mkMeta(r) };
    }
    if (text.indexOf("<kml") >= 0) return { points: parseKML(text), format: "kml", warnings: [], meta: mkMeta({}) };
    if (text.indexOf("<gpx") >= 0) return { points: parseGPX(text), format: "gpx", warnings: [], meta: mkMeta({}) };
    throw new Error("\u65E0\u6CD5\u8BC6\u522B\u6587\u4EF6\u683C\u5F0F\uFF08\u652F\u6301 IGC / KML / GPX\uFF09");
  }
  core.parseTrack = parseTrack;
  window.SanjiCore = core;
})();
