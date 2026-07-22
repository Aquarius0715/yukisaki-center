const mockData = {
  dataTimestamp: '2026-01-23 06:00 JST',
  mockNote: 'モックデータ表示中。API 連携前のダミー値です。',
  riskScore: 74,
  riskLabel: '高',
  riskSummary: '県道23号の融雪水と圧雪が残る区間で、移動時間が長くなりやすい状況です。',
  routes: [
    { name: '最短ルート', eta: '14分', score: 72, detail: '主要街路を通るため安定しています。', active: true },
    { name: '雪道優先', eta: '16分', score: 68, detail: '除雪の進んだ区間を優先します。', active: false },
    { name: '安全優先', eta: '18分', score: 80, detail: '広い道路を通り、危険個所を回避します。', active: false },
  ],
  segments: [
    { name: '県道23号', status: '要注意', badge: 'warning', detail: '融雪水の流れが弱く、凍結リスクが高い区間です。' },
    { name: '南石動町副路', status: '圧雪', badge: 'caution', detail: '車両の通過により圧雪が残り、滑りやすいです。' },
    { name: '千秋周辺', status: '通行可', badge: 'ok', detail: '除雪と散水で比較的通行しやすい状態です。' },
  ],
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderDashboard(data) {
  document.getElementById('data-timestamp').textContent = data.dataTimestamp;
  document.getElementById('risk-score').textContent = data.riskScore;
  document.getElementById('risk-label').textContent = data.riskLabel;
  document.getElementById('risk-summary').textContent = data.riskSummary;
  document.getElementById('mock-note').textContent = data.mockNote;

  const routesContainer = document.getElementById('routes');
  routesContainer.innerHTML = data.routes
    .map((route) => `
      <div class="route-card ${route.active ? 'route-card--active' : ''}">
        <div class="route-card__title">
          <strong>${escapeHtml(route.name)}</strong>
          <span>${escapeHtml(route.eta)}</span>
        </div>
        <div class="route-card__meta">指数 ${route.score}</div>
        <p>${escapeHtml(route.detail)}</p>
      </div>
    `)
    .join('');

  const segmentsContainer = document.getElementById('segments');
  segmentsContainer.innerHTML = data.segments
    .map((segment) => `
      <div class="segment-card">
        <div class="segment-card__head">
          <strong>${escapeHtml(segment.name)}</strong>
          <span class="badge badge--${segment.badge}">${escapeHtml(segment.status)}</span>
        </div>
        <p>${escapeHtml(segment.detail)}</p>
      </div>
    `)
    .join('');
}

function updateApiStatus(apiAvailable) {
  const status = document.getElementById('api-status');
  if (apiAvailable) {
    status.textContent = 'API 接続済み';
    status.classList.add('status--ok');
  } else {
    status.textContent = 'API 未接続';
    status.classList.add('status--warn');
  }
}

function setMapScreen(screen) {
  document.querySelectorAll('.switch-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.screen === screen);
  });

  document.querySelectorAll('.map-overlay').forEach((overlay) => {
    overlay.classList.toggle('is-active', overlay.classList.contains(`${screen}-overlay`));
  });
}

window.addEventListener('DOMContentLoaded', () => {
  renderDashboard(mockData);
  document.querySelectorAll('.switch-btn').forEach((button) => {
    button.addEventListener('click', () => setMapScreen(button.dataset.screen));
  });
  setMapScreen('home');

  fetch('/api/healthz')
    .then((response) => {
      if (!response.ok) {
        throw new Error('health check failed');
      }
      return response.json().catch(() => ({}));
    })
    .then(() => updateApiStatus(true))
    .catch(() => updateApiStatus(false));
});
