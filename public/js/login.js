'use strict';
const $ = (id) => document.getElementById(id);

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('username').value.trim();
  const password = $('password').value;
  $('err').textContent = '';
  if (!username) { $('err').textContent = '请输入登录账号'; $('username').focus(); return; }
  if (!password) { $('err').textContent = '请输入密码'; $('password').focus(); return; }
  const btn = $('submit');
  btn.disabled = true;
  btn.classList.add('loading');
  try {
    const resp = await fetch('/api/login', {
      method: 'POST',
      credentials: 'same-origin', // 接收 httpOnly 会话 Cookie
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await resp.json();
    if (data.code === 0) {
      if (data.data.mustChangePw) {
        // 首次登录强制改密，改完回到对应入口
        location.href = '/change-password.html?next=' + (data.data.role === 'admin' ? 'admin' : 'checkin');
      } else {
        location.href = data.data.role === 'admin' ? '/admin.html' : '/';
      }
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
