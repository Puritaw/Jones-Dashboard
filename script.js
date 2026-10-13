/* =========================================================
 * JonesDashboard – real data version
 *  - Weather / soil moisture : Open-Meteo (free, no API key)
 *  - Fire hotspots           : NASA FIRMS VIIRS (free MAP_KEY needed)
 *      get one at https://firms.modaps.eosdis.nasa.gov/api/map_key/
 * ========================================================= */

const FIRMS_MAP_KEY = "ef32d020846b08f4ac615b8dd5421d3e";            // <-- ใส่ MAP_KEY ของ NASA FIRMS ที่นี่เพื่อแสดงจุดความร้อนจริง
const FIRMS_SOURCE = "VIIRS_SNPP_NRT";
const HOTSPOT_RADIUS_KM = 80;        // จุดความร้อนที่อยู่ใกล้จังหวัดภายในรัศมีนี้จะถูกนับให้จังหวัดนั้น
const REFRESH_MS = 10 * 60 * 1000;   // รีเฟรชทุก 10 นาที

// ---------- DOM ----------
const redBtn = document.getElementById('redBtn');
const greenBtn = document.getElementById('greenBtn');
const alertContent = document.getElementById('alertContent');
const toggleAlertBtn = document.getElementById('toggleAlertBtn');
const provinceDataDiv = document.getElementById('provinceData');
const statusEl = document.getElementById('status');
const chartNote = document.getElementById('chartNote');

// ---------- Map: OpenStreetMap (ฟรี ไม่ต้องใช้ API key) ----------
const map = L.map('map').setView([19, 99.5], 8);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);
L.control.scale({ metric: true, imperial: false }).addTo(map);
setTimeout(() => map.invalidateSize(), 300);

const redLayer = L.layerGroup();
const greenLayer = L.layerGroup();

// ---------- Provinces (coordinates only – all values come from APIs) ----------
const provinces = [
  { name: "Chiang Mai", latlng: [18.79, 98.98] },
  { name: "Lampang",    latlng: [18.29, 99.49] },
  { name: "Phrae",      latlng: [18.15, 100.14] },
  { name: "Chiang Rai", latlng: [19.91, 99.83] },
  { name: "Phayao",     latlng: [19.16, 99.89] }
];

map.fitBounds(provinces.map(p => p.latlng), { padding: [40, 40] });

let state = { zone: "red", data: [], hotspotsAvailable: false, hotspotError: "" };
let temperatureChart, humidityChart, hotspotChart;

// ---------- Helpers ----------
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const sum = arr => arr.reduce((a, b) => a + (b ?? 0), 0);
const mean = arr => {
  const v = arr.filter(x => x != null);
  return v.length ? sum(v) / v.length : null;
};
const fmt = (v, d = 0) => (v == null ? "N/A" : Number(v).toFixed(d));

function weighted(parts) {
  // parts: [[score(0-1) | null, weight], ...] – ข้ามค่าที่ไม่มีข้อมูลแล้ว normalize น้ำหนัก
  const ok = parts.filter(p => p[0] != null);
  if (!ok.length) return null;
  const w = sum(ok.map(p => p[1]));
  return sum(ok.map(p => p[0] * p[1])) / w;
}

function haversine(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------- Level calculation (indicative index computed from real measurements) ----------
function riskFromScore(s) {
  if (s == null) return { level: "-", desc: "No data" };
  if (s < 0.2) return { level: "A", desc: "Low Risk" };
  if (s < 0.4) return { level: "B", desc: "Moderate Risk" };
  if (s < 0.55) return { level: "C", desc: "High Risk" };
  if (s < 0.7) return { level: "D", desc: "Very High Risk" };
  return { level: "E", desc: "Extreme Risk" };
}

function forestFromScore(s) {
  if (s == null) return { level: "-", desc: "No data" };
  if (s >= 0.75) return { level: "A", desc: "Excellent Forest" };
  if (s >= 0.6) return { level: "B", desc: "Good Forest" };
  if (s >= 0.45) return { level: "C", desc: "Moderate Forest" };
  if (s >= 0.3) return { level: "D", desc: "Fair Forest" };
  return { level: "E", desc: "Stressed Forest" };
}

function getRiskColor(level) {
  return { A: "#ffcccc", B: "#ff6666", C: "#ff3300", D: "#cc0000", E: "#990000", F: "#660000" }[level] || "#999999";
}
function getForestColor(level) {
  return { A: "#2d6514", B: "#7c9d39", C: "#ffc746", D: "#faad00", E: "#aa4cda", F: "#8f3432" }[level] || "#999999";
}

// ---------- Data fetching ----------
async function fetchWeather() {
  const lat = provinces.map(p => p.latlng[0]).join(",");
  const lon = provinces.map(p => p.latlng[1]).join(",");
  const url = "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${lat}&longitude=${lon}` +
    "&current=temperature_2m,relative_humidity_2m,wind_speed_10m" +
    "&daily=temperature_2m_mean,relative_humidity_2m_mean,precipitation_sum" +
    "&hourly=soil_moisture_0_to_7cm" +
    "&past_days=6&forecast_days=1&timezone=Asia%2FBangkok&wind_speed_unit=kmh";
  const res = await fetch(url);
  if (!res.ok) throw new Error("Open-Meteo HTTP " + res.status);
  const json = await res.json();
  return Array.isArray(json) ? json : [json];
}

async function fetchHotspots() {
  // returns { perProvince: [ {date: count} ], dates: [...] } or null
  if (!FIRMS_MAP_KEY) {
    state.hotspotError = "ยังไม่ได้ใส่ FIRMS_MAP_KEY ใน script.js จึงยังไม่มีข้อมูลจุดความร้อน";
    return null;
  }
  try {
    const bbox = "97.3,17.0,101.5,20.5"; // west,south,east,north
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${FIRMS_MAP_KEY}/${FIRMS_SOURCE}/${bbox}/5`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("FIRMS HTTP " + res.status);
    const text = (await res.text()).trim();
    const lines = text.split(/\r?\n/);
    const head = lines[0].split(",");
    const iLat = head.indexOf("latitude"), iLon = head.indexOf("longitude"), iDate = head.indexOf("acq_date");
    if (iLat < 0 || iLon < 0 || iDate < 0) throw new Error(text.slice(0, 120));

    const perProvince = provinces.map(() => ({}));
    const dateSet = new Set();
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(",");
      const pt = [parseFloat(c[iLat]), parseFloat(c[iLon])], date = c[iDate];
      if (isNaN(pt[0]) || isNaN(pt[1])) continue;
      dateSet.add(date);
      let best = -1, bestD = Infinity;
      provinces.forEach((p, idx) => {
        const d = haversine(p.latlng, pt);
        if (d < bestD) { bestD = d; best = idx; }
      });
      if (best >= 0 && bestD <= HOTSPOT_RADIUS_KM) {
        perProvince[best][date] = (perProvince[best][date] || 0) + 1;
      }
    }
    // ใช้ 5 วันล่าสุดเป็นแกนเวลาเสมอ (วันที่ไม่มีจุดความร้อน = 0)
    const dates = [];
    for (let k = 4; k >= 0; k--) dates.push(isoDayUTC(-k)); // acq_date ของ FIRMS เป็น UTC
    return { perProvince, dates };
  } catch (e) {
    state.hotspotError = "ดึงข้อมูลจุดความร้อนไม่สำเร็จ: " + e.message;
    return null;
  }
}

function isoDayUTC(offset) {
  return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
}

function isoDay(offset) {
  const d = new Date(Date.now() + 7 * 3600 * 1000 + offset * 86400000); // เวลาไทย UTC+7
  return d.toISOString().slice(0, 10);
}

// ---------- Build province records ----------
function buildRecords(weather, hot) {
  return provinces.map((prov, i) => {
    const w = weather[i];
    const cur = w.current, d = w.daily;

    // soil moisture เฉลี่ย 24 ชม. ล่าสุด
    let soil = null;
    const times = w.hourly.time, sm = w.hourly.soil_moisture_0_to_7cm;
    let idx = -1;
    for (let k = 0; k < times.length; k++) if (times[k] <= cur.time) idx = k;
    if (idx >= 0) soil = mean(sm.slice(Math.max(0, idx - 23), idx + 1));

    const rain7 = sum(d.precipitation_sum);
    const hotspots = hot ? sum(Object.values(hot.perProvince[i])) : null;
    const hotToday = hot ? (hot.perProvince[i][isoDayUTC(0)] || 0) : null;

    // Fire-risk index (0-1): ยิ่งร้อน/แห้ง/ลมแรง/ฝนน้อย/มีจุดความร้อนมาก ยิ่งเสี่ยง
    const riskScore = weighted([
      [clamp((cur.temperature_2m - 25) / 17), 0.25],
      [clamp((70 - cur.relative_humidity_2m) / 55), 0.30],
      [clamp(cur.wind_speed_10m / 30), 0.15],
      [1 - clamp(rain7 / 40), 0.20],
      [hotspots == null ? null : clamp(hotspots / 20), 0.10]
    ]);

    // Forest-moisture index (0-1): ความชื้นดิน + ความชื้นอากาศ + ฝนสะสม 7 วัน
    const forestScore = weighted([
      [soil == null ? null : clamp(soil / 0.4), 0.4],
      [clamp(cur.relative_humidity_2m / 80), 0.3],
      [clamp(rain7 / 60), 0.3]
    ]);

    return {
      name: prov.name,
      latlng: prov.latlng,
      temperature: cur.temperature_2m,
      humidity: cur.relative_humidity_2m,
      windSpeed: cur.wind_speed_10m,
      rain7, soil, hotspots, hotToday,
      riskScore, forestScore,
      risk: riskFromScore(riskScore),
      forest: forestFromScore(forestScore),
      days: d.time,
      dailyTemp: d.temperature_2m_mean,
      dailyHum: d.relative_humidity_2m_mean,
      dailyRain: d.precipitation_sum,
      dailyHot: hot ? hot.dates.map(dt => hot.perProvince[i][dt] || 0) : null,
      hotDates: hot ? hot.dates : null
    };
  });
}

// ---------- Render: map ----------
function renderMap() {
  redLayer.clearLayers();
  greenLayer.clearLayers();
  state.data.forEach(p => {
    const redPopup = `<b>${p.name}</b><br>${p.risk.desc} (Level ${p.risk.level})<br>` +
      `🌡️ ${fmt(p.temperature, 1)} °C · 💧 ${fmt(p.humidity)}% · 💨 ${fmt(p.windSpeed, 1)} km/h<br>` +
      `🔥 Hotspots (5d): ${fmt(p.hotspots)}`;
    const greenPopup = `<b>${p.name}</b><br>${p.forest.desc} (Level ${p.forest.level})<br>` +
      `🌡️ ${fmt(p.temperature, 1)} °C · 💧 ${fmt(p.humidity)}%<br>` +
      `🌧️ Rain 7d: ${fmt(p.rain7, 1)} mm`;
    L.circle(p.latlng, {
      radius: 10000, color: getRiskColor(p.risk.level), fillColor: getRiskColor(p.risk.level),
      fillOpacity: 0.7, weight: 2
    }).bindPopup(redPopup).addTo(redLayer);
    L.circle(p.latlng, {
      radius: 10000, color: getForestColor(p.forest.level), fillColor: getForestColor(p.forest.level),
      fillOpacity: 0.7, weight: 2
    }).bindPopup(greenPopup).addTo(greenLayer);
  });
  if (state.zone === "red") { map.removeLayer(greenLayer); redLayer.addTo(map); }
  else { map.removeLayer(redLayer); greenLayer.addTo(map); }
}

// ---------- Render: cards ----------
function renderCards() {
  const zone = state.zone;
  provinceDataDiv.innerHTML = state.data.map(p => {
    if (zone === "red") {
      return `
        <div class="card">
          <h3>${p.name}</h3>
          <p><strong>🔥 Risk Level:</strong> ${p.risk.level} (${p.risk.desc})</p>
          <p>🌡️ Temp: ${fmt(p.temperature, 1)} °C</p>
          <p>💧 Humidity: ${fmt(p.humidity)}%</p>
          <p>💨 Wind Speed: ${fmt(p.windSpeed, 1)} km/h</p>
          <p>🌧️ Rain (7d): ${fmt(p.rain7, 1)} mm</p>
          <p>🔥 Hotspots (5d): ${p.hotspots == null ? "N/A" : p.hotspots}</p>
        </div>`;
    }
    return `
      <div class="card">
        <h3>${p.name}</h3>
        <p><strong>🌲 Forest Level:</strong> ${p.forest.level} (${p.forest.desc})</p>
        <p>🌡️ Temp: ${fmt(p.temperature, 1)} °C</p>
        <p>💧 Humidity: ${fmt(p.humidity)}%</p>
        <p>💨 Wind Speed: ${fmt(p.windSpeed, 1)} km/h</p>
        <p>🌧️ Rainfall (7d): ${fmt(p.rain7, 1)} mm</p>
        <p>🌱 Soil moisture: ${p.soil == null ? "N/A" : fmt(p.soil * 100, 0) + "%"}</p>
      </div>`;
  }).join("");
}

// ---------- Render: alerts ----------
function renderAlert() {
  let html = "";
  if (state.zone === "red") {
    state.data.filter(p => p.risk.level === "D" || p.risk.level === "E").forEach(p => {
      html += `<p>⚠️ <strong>Alert:</strong> ${p.name} has high fire risk (${p.risk.level} – ${p.risk.desc}) 🔥</p>`;
    });
    alertContent.innerHTML = html || "<p>✅ No alerts.</p>";
  } else {
    state.data.filter(p => p.forest.level === "D" || p.forest.level === "E").forEach(p => {
      html += `<p>⚠️ <strong>Alert:</strong> ${p.name} forest is under moisture stress (${p.forest.level} – ${p.forest.desc})</p>`;
    });
    alertContent.innerHTML = html || "<p>🟢 No alerts in Green Zone.</p>";
  }
}

// ---------- Render: zone summaries (bottom sections) ----------
function renderSummaries() {
  const byRisk = [...state.data].sort((a, b) => (b.riskScore ?? -1) - (a.riskScore ?? -1))[0];
  const byForest = [...state.data].sort((a, b) => (b.forestScore ?? -1) - (a.forestScore ?? -1))[0];
  if (!byRisk || !byForest) return;

  document.getElementById('redHeadline').textContent =
    `🔥 Wildfire Risk: ${byRisk.risk.desc} in ${byRisk.name} Province`;
  document.getElementById('redSummary').innerHTML =
    `Based on current conditions, <strong>${byRisk.name}</strong> has the highest wildfire risk ` +
    `(Level ${byRisk.risk.level}): ${fmt(byRisk.temperature, 1)} °C, humidity ${fmt(byRisk.humidity)}%, ` +
    `wind ${fmt(byRisk.windSpeed, 1)} km/h, rain over the last 7 days ${fmt(byRisk.rain7, 1)} mm` +
    (byRisk.hotspots == null ? "." : `, ${byRisk.hotspots} hotspots detected in the last 5 days.`);

  document.getElementById('greenHeadline').textContent =
    `🌲 Forest Conservation Advisory – ${byForest.name}`;
  document.getElementById('greenSummary').innerHTML =
    `<strong>${byForest.name}</strong> currently has the best forest moisture condition ` +
    `(<strong>Level ${byForest.forest.level} – ${byForest.forest.desc}</strong>): ` +
    `humidity ${fmt(byForest.humidity)}%, rainfall over 7 days ${fmt(byForest.rain7, 1)} mm` +
    (byForest.soil == null ? "." : `, soil moisture ${fmt(byForest.soil * 100)}%.`);
}

// ---------- Render: charts ----------
const palette = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4"];

function makeChart(canvasId, old, labels, datasets, title, yLabel) {
  if (old) old.destroy();
  return new Chart(document.getElementById(canvasId).getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: datasets.map((d, i) => ({
        label: d.label, data: d.data,
        borderColor: palette[i % palette.length],
        backgroundColor: palette[i % palette.length],
        pointBorderColor: palette[i % palette.length],
        borderWidth: 3, tension: 0.3, pointRadius: 4, pointBackgroundColor: "#fff", spanGaps: true
      }))
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        title: { display: true, text: title, color: "#333", font: { size: 16, weight: 'bold' } },
        legend: { labels: { color: "#333", font: { size: 12, weight: 'bold' } } }
      },
      scales: {
        x: { ticks: { color: "#555" }, grid: { color: "rgba(200,200,200,0.2)" } },
        y: {
          ticks: { color: "#555" }, grid: { color: "rgba(200,200,200,0.2)" },
          title: { display: true, text: yLabel, color: "#555" }
        }
      }
    }
  });
}

function renderCharts() {
  const d0 = state.data[0];
  if (!d0) return;
  const labels = d0.days.map(s => s.slice(5)); // MM-DD

  temperatureChart = makeChart('temperatureChart', temperatureChart, labels,
    state.data.map(p => ({ label: p.name, data: p.dailyTemp })), 'Temperature (°C)', '°C');
  humidityChart = makeChart('humidityChart', humidityChart, labels,
    state.data.map(p => ({ label: p.name, data: p.dailyHum })), 'Humidity (%)', '%');

  const showHot = state.zone === "red" && state.hotspotsAvailable;
  if (showHot) {
    hotspotChart = makeChart('hotspotChart', hotspotChart, d0.hotDates.map(s => s.slice(5)),
      state.data.map(p => ({ label: p.name, data: p.dailyHot })), 'Hotspots per day', 'count');
    chartNote.textContent = "";
  } else {
    hotspotChart = makeChart('hotspotChart', hotspotChart, labels,
      state.data.map(p => ({ label: p.name, data: p.dailyRain })), 'Rainfall (mm)', 'mm');
    chartNote.textContent = state.zone === "red" ? "⚠️ " + state.hotspotError + " – แสดงกราฟปริมาณฝนแทน" : "";
  }
}

// ---------- Master render ----------
function render() {
  redBtn.classList.toggle("active", state.zone === "red");
  greenBtn.classList.toggle("active", state.zone === "green");
  renderMap();
  renderCards();
  renderAlert();
  renderSummaries();
  renderCharts();
}

// ---------- Load ----------
async function loadAll() {
  statusEl.className = "status";
  statusEl.textContent = "Loading real-time data…";
  try {
    state.hotspotError = "";
    const [weather, hot] = await Promise.all([fetchWeather(), fetchHotspots()]);
    state.hotspotsAvailable = !!hot;
    state.data = buildRecords(weather, hot);
    render();
    const t = new Date().toLocaleTimeString('th-TH');
    statusEl.textContent = `✅ Updated ${t}` +
      (state.hotspotsAvailable ? "" : " · Hotspot data unavailable (see note under charts)");
  } catch (err) {
    console.error(err);
    statusEl.className = "status error";
    statusEl.textContent = "❌ Could not load data: " + err.message + " (will retry automatically)";
  }
}

// ---------- Events ----------
redBtn.addEventListener("click", () => { state.zone = "red"; if (state.data.length) render(); });
greenBtn.addEventListener("click", () => { state.zone = "green"; if (state.data.length) render(); });
toggleAlertBtn.addEventListener("click", () => {
  const hidden = alertContent.classList.toggle("hidden");
  toggleAlertBtn.textContent = hidden ? "Show Alert" : "Hide Alert";
});

loadAll();
setInterval(loadAll, REFRESH_MS);