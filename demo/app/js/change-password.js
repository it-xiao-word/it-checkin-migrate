'use strict';
const $ = (id) => document.getElementById(id);

// 必须已登录（会话保存在 httpOnly Cookie 中，向服务端确认）
(async function guard() {
  try {
    const r = await apiFetch('/api/me');
    if (r.status !== 200) location.href = './login.html';
  } catch (e) { location.href = './login.html'; }
})();

const next = new URLSearchParams(location.search).get('next') || 'checkin';
if (next === 'admin') $('hint').textContent = '管理员账号首次登录，请设置新密码';

// 退出登录（改密流程中也允许退出）
$('logoutLink').addEventListener('click', (e) => { e.preventDefault(); logout(); });

$('cpForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const oldP = $('oldPassword').value;
  const newP = $('newPassword').value;
  const confirm = $('confirmPassword').value;
  $('err').textContent = '';

  if (!oldP) { $('err').textContent = '请输入原密码'; return; }
  if (newP.length < 6) { $('err').textContent = '新密码至少 6 位'; return; }
  if (newP !== confirm) { $('err').textContent = '两次输入的新密码不一致'; return; }

  const btn = $('submit');
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    const resp = await apiFetch('/api/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oldPassword: oldP, newPassword: newP })
    });
    const data = await resp.json();
    if (data.code === 0) {
      location.href = next === 'admin' ? './admin.html' : './';
    } else {
      $('err').textContent = data.message;
    }
  } catch (err) {
    $('err').textContent = '网络错误：' + err.message;
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
  }
});
