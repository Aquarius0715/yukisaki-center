const ROUTE_COLORS = ["#08785f", "#da781c", "#5267c9"];
const LABELS = {
  fastest: "最短時間",
  balanced: "バランス",
  most_drivable: "走りやすさ優先",
  alternative: "代替経路",
};

const map = L.map("map", {
  center: [37.442762, 138.790865],
  zoom: 13,
  preferCanvas: true,
});

L.tileLayer("/tiles/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution:
    '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">国土地理院</a>',
}).addTo(map);

function refreshMapSize() {
  window.requestAnimationFrame(() => {
    map.invalidateSize({ pan: false });
    const rect = mapPanel.getBoundingClientRect();
    const leafletSize = map.getSize();
    mapPanel.dataset.domSize = `${Math.round(rect.width)}x${Math.round(rect.height)}`;
    mapPanel.dataset.leafletSize = `${leafletSize.x}x${leafletSize.y}`;
  });
}

const mapPanel = document.querySelector(".map-panel");
if ("ResizeObserver" in window) {
  new ResizeObserver(refreshMapSize).observe(mapPanel);
}
window.addEventListener("load", () => {
  refreshMapSize();
  window.setTimeout(refreshMapSize, 150);
  window.setTimeout(refreshMapSize, 600);
});
window.addEventListener("resize", refreshMapSize);

const routeLayers = [];
const overlayGroup = L.featureGroup().addTo(map);
const routeCards = document.querySelector("#route-cards");
const routeCount = document.querySelector("#route-count");
const statusElement = document.querySelector("#request-status");
const rawJson = document.querySelector("#raw-json");
const fetchButton = document.querySelector("#fetch-route");

function number(id) {
  return Number(document.querySelector(`#${id}`).value);
}

function requestPayload() {
  const avoid = [];
  const prefer = [];
  if (document.querySelector("#avoid-steep").checked) avoid.push("steep_road");
  if (document.querySelector("#avoid-bridge").checked) avoid.push("bridge");
  if (document.querySelector("#prefer-main").checked) prefer.push("main_road");
  if (document.querySelector("#prefer-plowed").checked) prefer.push("recently_plowed");
  return {
    origin: { latitude: number("origin-lat"), longitude: number("origin-lon") },
    destination: {
      latitude: number("destination-lat"),
      longitude: number("destination-lon"),
    },
    mode: document.querySelector("#mode").value,
    options: {
      avoid,
      prefer,
      max_detour_minutes: number("detour"),
    },
    reference_time: "2026-01-23T12:00:00+09:00",
  };
}

function endpoint(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/v1/routes")) {
    url.pathname += "/v1/routes";
  }
  return url.toString();
}

function setStatus(message, kind = "idle") {
  statusElement.textContent = message;
  statusElement.dataset.kind = kind;
}

function formatDistance(value) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)} km` : `${Math.round(value)} m`;
}

function formatDuration(value) {
  return `${Math.round(value / 60)}分`;
}

function formatScore(value) {
  return value === null || value === undefined ? "未算出" : Number(value).toFixed(1);
}

function marker(label, point) {
  return L.marker([point.latitude, point.longitude], {
    icon: L.divIcon({
      className: "",
      html: `<span class="point-marker">${label}</span>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    }),
  });
}

function selectRoute(index) {
  routeLayers.forEach((layer, layerIndex) => {
    layer.setStyle({
      weight: layerIndex === index ? 8 : 4,
      opacity: layerIndex === index ? 1 : 0.48,
    });
    if (layerIndex === index) layer.bringToFront();
  });
  document.querySelectorAll(".route-card").forEach((card, cardIndex) => {
    card.dataset.selected = String(cardIndex === index);
  });
}

function routeCard(route, index) {
  const card = document.createElement("article");
  card.className = "route-card";
  card.style.setProperty("--route-color", ROUTE_COLORS[index]);
  card.dataset.selected = String(index === 0);
  const title = document.createElement("div");
  title.className = "route-title";
  const titleText = document.createElement("strong");
  titleText.textContent = `候補${route.rank ?? index + 1}・${LABELS[route.label] ?? route.label}`;
  const simulated = document.createElement("span");
  simulated.textContent = route.is_simulated ? "シミュレーション" : "実データ";
  title.append(titleText, simulated);

  const metrics = document.createElement("div");
  metrics.className = "route-metrics";
  [
    [formatDuration(route.duration_s), "所要時間"],
    [formatDistance(route.distance_m), "距離"],
    [formatScore(route.average_drivability_score), "平均指数"],
  ].forEach(([value, label]) => {
    const metric = document.createElement("div");
    metric.className = "metric";
    const strong = document.createElement("strong");
    strong.textContent = value;
    const small = document.createElement("small");
    small.textContent = label;
    metric.append(strong, small);
    metrics.append(metric);
  });

  const meta = document.createElement("div");
  meta.className = "route-meta";
  meta.textContent =
    `最低指数 ${formatScore(route.minimum_drivability_score)} ／ ` +
    `指数カバレッジ ${Math.round((route.score_coverage ?? 0) * 100)}% ／ ` +
    `危険区間 ${route.hazard_group_count ?? 0}件 ／ ` +
    `除雪済み ${Math.round((route.plowed_ratio ?? 0) * 100)}%`;

  card.append(title, metrics, meta);
  card.addEventListener("click", () => selectRoute(index));
  return card;
}

function validateResponse(data) {
  if (!data || !Array.isArray(data.routes)) {
    throw new Error("routes配列を含む経路APIレスポンスではありません");
  }
  for (const route of data.routes) {
    if (route.geometry?.type !== "LineString" || !Array.isArray(route.geometry.coordinates)) {
      throw new Error("経路GeometryがLineStringではありません");
    }
  }
}

function render(data) {
  validateResponse(data);
  overlayGroup.clearLayers();
  routeLayers.splice(0);
  routeCards.replaceChildren();
  rawJson.textContent = JSON.stringify(data, null, 2);
  document.querySelector("#response-json").value = JSON.stringify(data, null, 2);

  const bounds = [];
  data.routes.forEach((route, index) => {
    const color = ROUTE_COLORS[index] ?? ROUTE_COLORS[ROUTE_COLORS.length - 1];
    const layer = L.geoJSON(route.geometry, {
      style: { color, weight: index === 0 ? 8 : 4, opacity: index === 0 ? 1 : 0.48 },
    }).addTo(overlayGroup);
    routeLayers.push(layer);
    layer.eachLayer((child) => bounds.push(...child.getLatLngs()));

    for (const hazard of route.hazard_groups ?? []) {
      if (hazard.geometry?.type === "LineString") {
        L.geoJSON(hazard.geometry, {
          style: { color: "#c94040", weight: 5, dashArray: "8 7", opacity: 0.9 },
        }).bindTooltip(`候補${route.rank ?? index + 1}の危険区間`).addTo(overlayGroup);
      }
    }
    routeCards.append(routeCard(route, index));
  });

  const snapped = data.snapped_points ?? {};
  if (snapped.origin) {
    marker("出", snapped.origin)
      .bindTooltip(`出発地点・スナップ距離 ${snapped.origin.distance_m}m`)
      .addTo(overlayGroup);
    bounds.push(L.latLng(snapped.origin.latitude, snapped.origin.longitude));
  }
  if (snapped.destination) {
    marker("着", snapped.destination)
      .bindTooltip(`目的地点・スナップ距離 ${snapped.destination.distance_m}m`)
      .addTo(overlayGroup);
    bounds.push(L.latLng(snapped.destination.latitude, snapped.destination.longitude));
  }

  routeCount.textContent = `${data.routes.length}件`;
  if (bounds.length) map.fitBounds(L.latLngBounds(bounds), { padding: [42, 42] });
  selectRoute(0);
  const warnings = data.warnings?.length ? ` 注意: ${data.warnings.join(" / ")}` : "";
  setStatus(
    `${data.routes.length}件を描画しました。グラフ版: ${data.graph_version ?? "不明"}。${warnings}`,
    "success",
  );
}

async function fetchRoutes() {
  fetchButton.disabled = true;
  setStatus("経路APIへ問い合わせています…");
  try {
    const response = await fetch(endpoint(document.querySelector("#api-url").value), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestPayload()),
    });
    const data = await response.json().catch(() => ({ message: "JSON以外の応答です" }));
    rawJson.textContent = JSON.stringify(data, null, 2);
    if (!response.ok) {
      const code = data.error ?? data.message ?? `HTTP ${response.status}`;
      const detail =
        code === "route_service_unavailable"
          ? "DBスキーマ・道路グラフ・Lambdaログを確認してください"
          : data.message ?? "APIエラー";
      throw new Error(`${response.status} ${code}: ${detail}`);
    }
    render(data);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  } finally {
    fetchButton.disabled = false;
  }
}

async function loadSample() {
  try {
    const response = await fetch("./sample-response.json");
    if (!response.ok) throw new Error("デモJSONを読み込めませんでした");
    render(await response.json());
    setStatus("シミュレーションfixtureを描画しました。AWS APIの実行結果ではありません。", "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

document.querySelector("#detour").addEventListener("input", (event) => {
  document.querySelector("#detour-value").textContent = `${event.target.value}分`;
});
fetchButton.addEventListener("click", fetchRoutes);
document.querySelector("#load-sample").addEventListener("click", loadSample);
document.querySelector("#render-json").addEventListener("click", () => {
  try {
    render(JSON.parse(document.querySelector("#response-json").value));
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }
});

if (new URLSearchParams(window.location.search).get("sample") === "1") {
  loadSample();
}
