fetch('/api/healthz').then(response => response.json()).then(() => {
  document.querySelector('#status').textContent = 'デモデータを読み込む準備ができました。';
}).catch(() => {
  document.querySelector('#status').textContent = 'APIへ接続できません。';
});
