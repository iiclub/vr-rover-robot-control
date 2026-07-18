const token = new URLSearchParams(location.search).get('token') || '';

document.getElementById('noToken').style.display = token ? 'none' : 'block';
document.getElementById('phoneLink').href = `/phone?token=${encodeURIComponent(token)}`;
document.getElementById('questLink').href = `/quest?token=${encodeURIComponent(token)}`;
document.getElementById('testLink').href = `/test?token=${encodeURIComponent(token)}`;

const dotRobot = document.getElementById('dotRobot');
const txtRobot = document.getElementById('txtRobot');
const dotVideo = document.getElementById('dotVideo');
const txtVideo = document.getElementById('txtVideo');
const txtViewers = document.getElementById('txtViewers');
const txtRobotUrl = document.getElementById('txtRobotUrl');

async function pollStatus() {
  try {
    const res = await fetch('/healthz');
    const data = await res.json();

    dotRobot.className = `dot ${data.robotConnected ? 'up' : 'down'}`;
    txtRobot.textContent = data.robotConnected ? 'connected' : 'disconnected';

    dotVideo.className = `dot ${data.videoSource ? 'up' : 'down'}`;
    txtVideo.textContent = data.videoSource ? 'streaming' : 'no source';

    txtViewers.textContent = data.viewers;
    txtRobotUrl.textContent = data.robotUrl || '--';
  } catch {
    txtRobot.textContent = 'server unreachable';
  }
}

pollStatus();
setInterval(pollStatus, 2000);

const form = document.getElementById('robotForm');
const input = document.getElementById('robotUrlInput');
const formMsg = document.getElementById('formMsg');

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  formMsg.textContent = 'saving...';
  formMsg.className = '';

  try {
    const res = await fetch(`/api/robot-url?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: input.value }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      formMsg.textContent = data.error || `failed (${res.status})`;
      formMsg.className = 'error';
      return;
    }

    formMsg.textContent = `saved: ${data.currentUrl}`;
    formMsg.className = 'ok';
    input.value = '';
    pollStatus();
  } catch (err) {
    formMsg.textContent = err.message;
    formMsg.className = 'error';
  }
});
