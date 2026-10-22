// Shared helpers: DOM builder, API calls, toasts, nav and the login gate.

let ME = null;

// el('button', {class: 'primary', onclick: fn}, 'Save') -> <button class="primary">Save</button>
function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else if (key === 'value' || key === 'checked' || key === 'selected') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function mount(target, ...children) {
  const node = typeof target === 'string' ? document.getElementById(target) : target;
  node.replaceChildren(...children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false));
  return node;
}

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(method, path, body) {
  const options = { method, headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw new ApiError('Network error: you appear to be offline', 0);
  }
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401 && !path.startsWith('/api/login')) {
    showLogin();
    throw new ApiError('Please log in again', 401);
  }
  if (!res.ok) {
    const detail = data && data.detail;
    throw new ApiError(typeof detail === 'string' ? detail : `Request failed (${res.status})`, res.status);
  }
  return data;
}

function toast(message, kind = 'ok') {
  const box = document.getElementById('toasts') || document.body.appendChild(el('div', { id: 'toasts' }));
  const node = el('div', { class: `toast ${kind === 'ok' ? '' : kind}` }, message);
  box.appendChild(node);
  setTimeout(() => node.remove(), kind === 'ok' ? 2500 : 5000);
}

// Run an async action with a button disabled while it's in flight; errors become toasts.
async function withBusy(button, action) {
  if (button) button.disabled = true;
  try {
    return await action();
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

function formatDate(isoString) {
  if (!isoString) return 'Unknown date';
  return new Date(isoString).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function renderNav() {
  // Templates is one page; the other apps are a link away and share the login.
  const links = [
    ME.trainer_url && [ME.trainer_url, 'Sessions'],
    ME.tracker_url && [ME.tracker_url, 'Nutrition'],
  ].filter(Boolean);
  // On narrow screens the links collapse behind the menu button instead of wrapping.
  const toggle = el('button', { type: 'button', class: 'nav-toggle', 'aria-label': 'Menu', 'aria-expanded': 'false', onclick: () => {
    toggle.setAttribute('aria-expanded', String(nav.classList.toggle('open')));
  } }, '☰');
  const nav = el('nav', {},
    el('a', { class: 'brand', href: '/' }, el('img', { src: '/static/NFP.jpg', alt: '' }), 'Naylon Fitness'),
    toggle,
    el('div', { class: 'nav-menu' },
      el('a', { class: 'nav-link active', href: '/' }, 'Templates'),
      links.map(([href, label]) => el('a', { class: 'nav-link', href }, label)),
      el('span', { class: 'spacer' }),
      el('span', { class: 'who' }, ME.name || ME.username),
      el('button', { class: 'logout', onclick: logout }, 'Logout'),
    ),
  );
  return nav;
}

async function logout() {
  const prefix = `templates:${ME.username}:`;
  let unsynced = 0;
  try { unsynced = (JSON.parse(localStorage.getItem(`${prefix}queue`)) || []).length; } catch {}
  if (unsynced && !confirm(`You have ${unsynced} change(s) that haven't synced yet. Logging out will discard them. Log out anyway?`)) return;
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {
    return toast("Can't log out while offline", 'error');
  }
  try {
    Object.keys(localStorage).filter(key => key.startsWith(prefix) || key === 'templates:me').forEach(key => localStorage.removeItem(key));
  } catch {}
  showLogin();
}

function showLogin() {
  let registering = false;
  const error = el('div', { class: 'error hidden' });
  const name = el('input', { type: 'text', placeholder: 'Full Name', autocomplete: 'name' });
  const email = el('input', { type: 'email', placeholder: 'Email', autocomplete: 'email' });
  const username = el('input', { type: 'text', placeholder: 'Username', autocomplete: 'username', autocapitalize: 'none' });
  const password = el('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
  const confirm = el('input', { type: 'password', placeholder: 'Confirm Password', autocomplete: 'new-password' });
  const title = el('h2', {}, 'Login');
  const submit = el('button', { class: 'primary', onclick: () => send() }, 'Login');
  const toggleLink = el('button', { class: 'link', onclick: () => toggle() }, 'New here? Register an account');
  const registerOnly = [name, email, confirm];

  function toggle() {
    registering = !registering;
    title.textContent = registering ? 'Register' : 'Login';
    submit.textContent = registering ? 'Create Account' : 'Login';
    toggleLink.textContent = registering ? 'Already have an account? Login' : 'New here? Register an account';
    password.autocomplete = registering ? 'new-password' : 'current-password';
    registerOnly.forEach(input => input.classList.toggle('hidden', !registering));
    error.classList.add('hidden');
  }

  function fail(message) {
    error.textContent = message;
    error.classList.remove('hidden');
  }

  async function send() {
    const body = { username: username.value.trim(), password: password.value };
    if (registering) {
      Object.assign(body, { name: name.value.trim(), email: email.value.trim() });
      if (!body.username || !body.name || !body.email || !body.password || !confirm.value) return fail('Please fill all fields');
      if (body.password !== confirm.value) return fail('Passwords do not match');
      if (body.password.length < 6) return fail('Password must be at least 6 characters');
    } else if (!body.username || !body.password) {
      return fail('Please enter your username and password');
    }
    submit.disabled = true;
    try {
      await api('POST', registering ? '/api/register' : '/api/login', body);
      location.reload();
    } catch (err) {
      fail(err.message);
    } finally {
      submit.disabled = false;
    }
  }

  registerOnly.forEach(input => input.classList.add('hidden'));
  const form = el('form', { class: 'auth-box', onsubmit: e => { e.preventDefault(); send(); } },
    el('img', { class: 'logo', src: '/static/NFP.jpg', alt: '' }),
    title, error, name, email, username, password, confirm, submit,
    el('div', { class: 'toggle' }, toggleLink),
    el('p', { class: 'muted', style: 'margin-top:10px;text-align:center' }, 'Forgot your password? Ask the administrator for a reset link.'),
  );
  submit.type = 'submit';
  toggleLink.type = 'button';
  mount(document.querySelector('.container'), form);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

// Entry point: checks the login cookie, draws the nav, then calls render(main).
async function boot(render) {
  const container = document.querySelector('.container');
  try {
    ME = await api('GET', '/api/me');
    try { localStorage.setItem('templates:me', JSON.stringify(ME)); } catch {}
  } catch (err) {
    // Offline: carry on as the last signed-in user so cached templates still open.
    try { ME = err.status === 0 ? JSON.parse(localStorage.getItem('templates:me')) : null; } catch {}
    if (!ME) {
      if (err.status !== 401) mount(container, el('div', { class: 'info' }, err.status === 0 ? "You're offline. Connect once to sign in on this device." : err.message));
      return;
    }
  }
  const main = el('main', {});
  mount(container, renderNav(), main);
  await render(main);
}
