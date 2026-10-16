'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
}

async function boot() {
  try { await api('GET', '/api/admin/status'); showPanel(); }
  catch { $('alogin').classList.remove('hidden'); }
}
async function aLogin() {
  $('a-err').textContent = '';
  try { await api('POST', '/api/admin/login', { user: $('a-user').value.trim(), pass: $('a-pass').value }); boot(); }
  catch (e) { $('a-err').textContent = e.message; }
}
async function aLogout() { await api('POST', '/api/admin/logout'); location.reload(); }

async function showPanel() {
  $('alogin').classList.add('hidden');
  $('apanel').classList.remove('hidden');
  const s = await api('GET', '/api/admin/status');
  $('a-status').innerHTML = `Storage: <b>${esc(s.backend)}</b> · ${s.members} members · ${s.txns} ledger entries · target $${(s.monthlyTarget / 100).toFixed(0)}/member`;
  $('a-target').value = (s.monthlyTarget / 100).toFixed(0);
  const members = await api('GET', '/api/admin/members');
  $('a-members').innerHTML = members.map((m) => `<tr><td>${esc(m.name)}${m.mustChangePw ? ' <span class="pill warn">temp pw</span>' : ''}</td>
    <td class="muted">${esc(m.username)}</td>
    <td style="white-space:nowrap"><button class="btn ghost small" onclick="aReset('${m.id}','${esc(m.name)}')">Reset pw</button>
    <button class="btn danger small" onclick="aDel('${m.id}','${esc(m.name)}')">✕</button></td></tr>`).join('')
    || '<tr><td colspan="3" class="muted">No members yet — create the first one above.</td></tr>';
}

function aShowNew() { $('a-new').classList.toggle('hidden'); }

async function aCreate() {
  try {
    const r = await api('POST', '/api/admin/members', {
      name: $('an-name').value, username: $('an-user').value, password: $('an-pass').value,
    });
    $('a-created').innerHTML = `<p><b>${esc(r.name)}</b> created. Tell them this temp password <b>once</b> — they'll set their own on first login:</p>
      <div class="temp-pass">${esc(r.tempPassword)}</div>`;
    $('an-name').value = $('an-user').value = $('an-pass').value = '';
    showPanel();
  } catch (e) { alert(e.message); }
}

async function aReset(id, name) {
  if (!confirm(`Reset ${name}'s password? They'll be logged out and must set a new one.`)) return;
  const r = await api('POST', '/api/admin/reset-password', { userId: id });
  $('a-created').innerHTML = `<p>New temp password for <b>${esc(name)}</b> — tell them <b>once</b>:</p>
    <div class="temp-pass">${esc(r.tempPassword)}</div>`;
  showPanel();
}

async function aDel(id, name) {
  if (!confirm(`Remove ${name}? Their login stops working. Their past ledger entries stay.`)) return;
  await api('POST', '/api/admin/delete-member', { userId: id });
  showPanel();
}

async function aTarget() {
  try { await api('POST', '/api/admin/target', { target: $('a-target').value }); showPanel(); }
  catch (e) { alert(e.message); }
}

boot();
