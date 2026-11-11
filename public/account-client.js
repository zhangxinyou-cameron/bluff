(() => {
  async function request(url, data) {
    const response = await fetch(url, data === undefined ? undefined : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload.message || '连接失败，请稍后重试'), { status: response.status });
    return payload;
  }
  window.RiverAccount = { request };

  const form = document.getElementById('accountForm');
  if (!form) return;
  const submit = document.getElementById('accountSubmit');
  const toggle = document.getElementById('accountToggle');
  const message = document.getElementById('accountMessage');
  let register = false;
  toggle.onclick = () => {
    register = !register;
    document.getElementById('accountHeading').textContent = register ? '注册账号' : '登录牌桌';
    document.getElementById('confirmLabel').hidden = !register;
    form.elements.confirmation.disabled = !register;
    form.elements.confirmation.required = register;
    form.elements.password.autocomplete = register ? 'new-password' : 'current-password';
    submit.textContent = register ? '注册并进入' : '登录';
    toggle.textContent = register ? '已有账号，返回登录' : '注册新账号';
    message.textContent = '';
  };
  form.onsubmit = async event => {
    event.preventDefault();
    submit.disabled = toggle.disabled = true;
    message.textContent = '';
    try {
      await request('/api/account/' + (register ? 'register' : 'login'), Object.fromEntries(new FormData(form)));
      const room = /^#room=[0-9]{6}$/.test(location.hash) ? location.hash : '';
      location.replace('/' + room);
    } catch (error) {
      message.textContent = error.message;
    } finally {
      submit.disabled = toggle.disabled = false;
    }
  };
})();
