function origin(raw: string | undefined) {
  if (!raw) return;
  const url = URL.parse(raw);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
  return url.origin;
}

// The editor can run inside an app shell, which passes its token and origins in the environment.
export function shellEnvironment() {
  const { APP_TOKEN, SHELL_ORIGINS } = process.env;
  if (!APP_TOKEN) return;
  if (!/^[a-zA-Z0-9_-]{16,160}$/.test(APP_TOKEN)) throw new Error('Invalid app token.');
  const shellOrigins = [...new Set((SHELL_ORIGINS ?? '').split(/\s+/).flatMap((address) => {
    const value = origin(address);
    if (!value) return [];
    return [value, value.replace('://localhost:', '://127.0.0.1:')];
  }))];
  return { path: '/' + APP_TOKEN, shellOrigins };
}
