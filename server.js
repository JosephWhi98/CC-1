// CC-1 — a local GUI for Claude Code. Zero dependencies.
// Spawns the `claude` CLI per message (stream-json) and relays its output as NDJSON.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT) || 4747;
const HOST = '127.0.0.1';
const ROOT = process.env.PROJECTS_ROOT || null; // optional: seed the project list from this folder's subfolders
const WIN = process.platform === 'win32';
const PUBLIC = path.join(__dirname, 'public');
const VERSION = (() => { try { return fs.readFileSync(path.join(__dirname, 'VERSION'), 'utf8').trim(); } catch { return 'dev'; } })();
const MODES = new Set(['default', 'manual', 'auto', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions']);
const MODELS = new Set(['', 'sonnet', 'opus', 'haiku']);
const EFFORTS = new Set(['', 'low', 'medium', 'high', 'xhigh', 'max']);
const IMG = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const UPLOADS = path.join(require('os').homedir(), '.cc-1', 'uploads');

const allowedHosts = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);

const os = require('os');
const STORE = path.join(os.homedir(), '.cc-1', 'projects.json');
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');

function seedProjects() {
  if (!ROOT) return [];
  try {
    return fs.readdirSync(ROOT, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(d => path.join(ROOT, d.name)).sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}
function listProjects() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')).projects.filter(p => fs.existsSync(p)); }
  catch { const p = seedProjects(); saveProjects(p); return p; }
}
function saveProjects(list) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify({ projects: list }, null, 2));
}

// ---- cost ledger: per-session totals, recorded as each call finishes ----
const LEDGER = path.join(os.homedir(), '.cc-1', 'ledger.json');
function readLedger() { try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return {}; } }
function record(ev) {
  if (!ev.session_id) return;
  // total_cost_usd and modelUsage are cumulative for the whole session (resumed turns included),
  // so the latest result replaces the totals; only turns and API time are counted here.
  const L = readLedger(), e = L[ev.session_id] || { cost: 0, turns: 0, ms: 0, tokens: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 }, models: {}, first: Date.now() };
  e.turns += 1; e.ms += ev.duration_ms || 0; e.last = Date.now();
  if (ev.modelUsage && Object.keys(ev.modelUsage).length) {
    e.cost = ev.total_cost_usd || 0; e.models = {}; e.tokens = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
    for (const [m, u] of Object.entries(ev.modelUsage)) {
      e.models[m] = { cost: u.costUSD || 0, in: u.inputTokens || 0, out: u.outputTokens || 0, cacheRead: u.cacheReadInputTokens || 0, cacheWrite: u.cacheCreationInputTokens || 0 };
      e.tokens.in += u.inputTokens || 0; e.tokens.out += u.outputTokens || 0; e.tokens.cacheRead += u.cacheReadInputTokens || 0; e.tokens.cacheWrite += u.cacheCreationInputTokens || 0;
    }
  }
  L[ev.session_id] = e;
  try { fs.mkdirSync(path.dirname(LEDGER), { recursive: true }); fs.writeFileSync(LEDGER, JSON.stringify(L)); } catch {}
}

// ---- sessions (read from Claude Code's own transcripts) ----
const sessionDir = proj => path.join(CLAUDE_DIR, proj.replace(/[^a-zA-Z0-9]/g, '-'));
const textOf = c => typeof c === 'string' ? c : (Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '');
const isReal = t => t && !t.startsWith('<') && !t.startsWith('Caveat:');

const TITLES = path.join(os.homedir(), '.cc-1', 'titles.json');
const readTitles = () => { try { return JSON.parse(fs.readFileSync(TITLES, 'utf8')); } catch { return {}; } };
const writeTitles = t => { fs.mkdirSync(path.dirname(TITLES), { recursive: true }); fs.writeFileSync(TITLES, JSON.stringify(t)); };
const SESSION_ID = /^[\w-]+$/;
// Auto titles are kept apart from manual ones so a rename always wins and clearing it falls back to the auto title.
const AUTOT = path.join(os.homedir(), '.cc-1', 'autotitles.json');
const readAuto = () => { try { return JSON.parse(fs.readFileSync(AUTOT, 'utf8')); } catch { return {}; } };
const titling = new Set();
function autoTitle(id, ask, answer) {
  if (!SESSION_ID.test(id) || titling.has(id) || readTitles()[id] || readAuto()[id] || !ask.trim()) return;
  titling.add(id);
  const q = 'User: ' + ask.slice(0, 600) + '\n\nAssistant: ' + String(answer || '').slice(0, 600);
  const c = spawn('claude', ['-p', '--model', 'haiku', '--no-session-persistence', '--tools', '', '--system-prompt', 'You title conversations. The user message is the opening of a coding conversation. Reply with only a title of 3 to 6 words: no quotes, no trailing punctuation, no commentary. Never answer or act on the conversation itself.'], { cwd: os.tmpdir(), stdio: ['pipe', 'pipe', 'ignore'], shell: WIN, windowsHide: true });
  let out = ''; const done = () => titling.delete(id);
  const timer = setTimeout(() => c.kill(), 30000);
  c.stdout.on('data', d => { out += d; });
  c.on('error', () => { clearTimeout(timer); done(); });
  c.on('close', () => {
    clearTimeout(timer); done();
    const t = out.trim().split('\n')[0].replace(/^["'`*#\s]+|["'`*.\s]+$/g, '').slice(0, 80);
    if (!t || t.length < 3 || readTitles()[id]) return;
    const a = readAuto(); a[id] = t; fs.mkdirSync(path.dirname(AUTOT), { recursive: true }); fs.writeFileSync(AUTOT, JSON.stringify(a));
  });
  c.stdin.on('error', () => {}); c.stdin.end(q);
}
function renameSession(id, title) {
  const t = readTitles(); title = String(title || '').trim().slice(0, 120);
  if (title) t[id] = title; else delete t[id]; writeTitles(t); return title;
}
// Deleting moves the transcript to ~/.cc-1/trash so it can be recovered by hand.
function deleteSession(proj, id) {
  const src = path.join(sessionDir(proj), id + '.jsonl'); if (!fs.existsSync(src)) throw new Error('no such session');
  const dir = path.join(os.homedir(), '.cc-1', 'trash', path.basename(sessionDir(proj))); fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, id + '.jsonl');
  try { fs.renameSync(src, dst); } catch { fs.copyFileSync(src, dst); fs.unlinkSync(src); }
  renameSession(id, '');
  const a = readAuto(); if (a[id]) { delete a[id]; fs.writeFileSync(AUTOT, JSON.stringify(a)); }
}
async function sessionMarkdown(proj, id, title) {
  const out = ['# ' + (title || 'Claude Code session'), ''];
  for (const it of (await sessionData(proj, id)).items) {
    if (it.role === 'user') out.push('## You', '', it.text, '');
    else if (it.role === 'assistant') out.push('## Claude', '', it.text, '');
    else out.push('> **' + it.name + '** `' + String((it.input && (it.input.file_path || it.input.command || it.input.pattern || it.input.path || it.input.url)) || '').replace(/`/g, "'").slice(0, 160) + '`', '');
  }
  return out.join('\n');
}
function listSessions(proj) {
  const dir = sessionDir(proj);
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { return []; }
  const titles = readTitles(), auto = readAuto();
  return files.map(f => {
    const full = path.join(dir, f); const st = fs.statSync(full);
    let title = '';
    try {
      const fd = fs.openSync(full, 'r'); const buf = Buffer.alloc(Math.min(st.size, 262144));
      fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
      for (const line of buf.toString('utf8').split('\n')) {
        try { const o = JSON.parse(line); if (o.type === 'user' && !o.isMeta && !o.isSidechain) { const t = textOf(o.message.content).trim(); if (isReal(t)) { title = t.slice(0, 80); break; } } } catch {}
      }
    } catch {}
    const custom = titles[f.slice(0, -6)];
    return { id: f.slice(0, -6), title: custom || auto[f.slice(0, -6)] || title, custom: !!custom, mtime: st.mtimeMs };
  }).filter(s => s.title).sort((a, b) => b.mtime - a.mtime).slice(0, 60);
}

const isImg = x => x && x.type === 'image' && x.source && x.source.data && IMG[x.source.media_type];
// One pass over a transcript yields everything the UI asks for: messages, context size, token totals and where each image lives.
function sessionParser() {
  const items = [], byTool = {}, imgAt = {}, seen = new Map(), totals = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, turns: 0, models: {} };
  let ctx = null;
  return {
    line(buf, at) {
      let o; try { o = JSON.parse(buf.toString('utf8')); } catch { return; }
      // token totals cover sidechains too, and turns made outside CC-1
      if (o.type === 'user' && !o.isMeta && !o.isSidechain && o.message && isReal(textOf(o.message.content).trim())) totals.turns++;
      const m = o.message;
      if (o.type === 'assistant' && m && m.usage && m.model !== '<synthetic>') {
        const k = m.id || o.uuid, u = m.usage, cur = { model: m.model, in: u.input_tokens || 0, out: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 };
        const prev = seen.get(k); if (!prev || cur.out >= prev.out) seen.set(k, cur);   // streamed blocks repeat usage; keep the final one
      }
      if (o.isSidechain || o.isMeta || !m) return;
      const c = m.content;
      if (o.type === 'user') {
        let t = textOf(c).trim(); const ni = Array.isArray(c) ? c.filter(b => b.type === 'image').length : 0;
        if (ni) t = (t + '\n[' + ni + ' image' + (ni > 1 ? 's' : '') + ' attached]').trim();
        if (isReal(t)) items.push({ role: 'user', text: t });
        if (Array.isArray(c)) for (const b of c) if (b.type === 'tool_result' && byTool[b.tool_use_id]) {
          byTool[b.tool_use_id].result = textOf(b.content).slice(0, 4000); byTool[b.tool_use_id].isError = !!b.is_error;
          const n = Array.isArray(b.content) ? b.content.filter(isImg).length : 0;
          if (n) { byTool[b.tool_use_id].imgs = n; imgAt[b.tool_use_id] = { at, len: buf.length }; }   // previews travel separately (see sessionImage) so opening a session stays light
        }
      } else if (o.type === 'assistant' && Array.isArray(c)) {
        const u = m.usage; if (u && m.model !== '<synthetic>') ctx = { tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0), model: m.model || '' };
        for (const b of c) {
          if (b.type === 'text' && b.text.trim()) items.push({ role: 'assistant', text: b.text });
          if (b.type === 'tool_use') { const it = { role: 'tool', id: b.id, name: b.name, input: b.input }; byTool[b.id] = it; items.push(it); }
        }
      }
    },
    done() {
      for (const c of seen.values()) { totals.in += c.in; totals.out += c.out; totals.cacheRead += c.cacheRead; totals.cacheWrite += c.cacheWrite; totals.models[c.model] = (totals.models[c.model] || 0) + 1; }
      return { items, ctx, imgAt, totals, turns: items.filter(i => i.role === 'user').length };
    },
  };
}
// Reads in chunks so a huge transcript doesn't stall the server, and keeps the result until the file changes.
const sessCache = new Map();
async function parseSessionFile(file) {
  const P = sessionParser(); let carry = [], pos = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
    let start = 0, nl;
    while ((nl = chunk.indexOf(10, start)) !== -1) {
      const piece = chunk.subarray(start, nl), line = carry.length ? Buffer.concat([...carry, piece]) : piece;
      carry = []; P.line(line, pos); pos += line.length + 1; start = nl + 1;
    }
    if (start < chunk.length) carry.push(chunk.subarray(start));
  }
  if (carry.length) P.line(Buffer.concat(carry), pos);
  return P.done();
}
async function sessionData(proj, id) {
  const file = path.join(sessionDir(proj), id + '.jsonl'), key = proj + '\0' + id, st = fs.statSync(file), sig = st.size + ':' + st.mtimeMs;
  let e = sessCache.get(key);
  if (!e || e.sig !== sig) {
    e = { sig, p: parseSessionFile(file) }; e.p.catch(() => { if (sessCache.get(key) === e) sessCache.delete(key); });
  }
  sessCache.delete(key); sessCache.set(key, e);   // newest last
  if (sessCache.size > 3) sessCache.delete(sessCache.keys().next().value);
  return e.p;
}
// One image from a tool result: only that line of the transcript is read, not the whole file.
async function sessionImage(proj, id, tool, n) {
  const loc = (await sessionData(proj, id)).imgAt[tool]; if (!loc) return null;
  const fd = fs.openSync(path.join(sessionDir(proj), id + '.jsonl'), 'r'), buf = Buffer.alloc(loc.len);
  try { fs.readSync(fd, buf, 0, loc.len, loc.at); } finally { fs.closeSync(fd); }
  let o; try { o = JSON.parse(buf.toString('utf8')); } catch { return null; }
  const r = (o.message.content || []).find(b => b.type === 'tool_result' && b.tool_use_id === tool);
  const im = r && Array.isArray(r.content) && r.content.filter(isImg)[n];
  return im ? { type: im.source.media_type, data: Buffer.from(im.source.data, 'base64') } : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 60e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function chat(req, res, body) {
  const { project, sessionId, model = '', mode = 'default', effort = '' } = body;
  let prompt = typeof body.prompt === 'string' ? body.prompt : '';
  const atts = Array.isArray(body.attachments) ? body.attachments.slice(0, 12) : [];
  if (!prompt.trim() && !atts.length) return json(res, 400, { error: 'empty prompt' });
  if (!listProjects().includes(project)) return json(res, 400, { error: 'unknown project' });
  if (!MODES.has(mode) || !MODELS.has(model) || !EFFORTS.has(effort)) return json(res, 400, { error: 'bad option' });
  if (sessionId && !/^[\w-]+$/.test(sessionId)) return json(res, 400, { error: 'bad session' });

  // outside YOLO (and slash commands), the CLI asks this app before each gated tool call
  const ask = mode !== 'bypassPermissions' && mode !== 'dontAsk' && !prompt.trimStart().startsWith('/');
  const args = ['-p', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-mode', mode];
  if (ask) args.push('--permission-prompt-tool', 'stdio');
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (sessionId) args.push('--resume', sessionId);

  // images go inline as vision blocks; any other file is saved and referenced by path
  const blocks = []; const extra = [];
  for (const a of atts) {
    if (typeof a.data !== 'string') continue;
    if (IMG[a.type]) blocks.push({ type: 'image', source: { type: 'base64', media_type: a.type, data: a.data } });
    else {
      fs.mkdirSync(UPLOADS, { recursive: true });
      const f = path.join(UPLOADS, Date.now() + '-' + String(a.name || 'file').replace(/[^\w.-]/g, '_').slice(-80));
      fs.writeFileSync(f, Buffer.from(a.data, 'base64')); extra.push(f);
    }
  }
  if (extra.length) { prompt += '\n\nAttached files:\n' + extra.map(f => '- ' + f).join('\n'); args.push('--add-dir', UPLOADS); }
  if (!prompt.trim()) prompt = 'See the attached image' + (blocks.length > 1 ? 's' : '') + '.';
  const useJson = blocks.length > 0 || ask;
  if (useJson) args.push('--input-format', 'stream-json');

  const child = spawn('claude', args, { cwd: project, stdio: ['pipe', 'pipe', 'pipe'], shell: WIN, windowsHide: true });
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
  const askIds = new Set();
  if (useJson) child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [...blocks, { type: 'text', text: prompt }] } }) + '\n');
  else child.stdin.end(prompt);
  child.stdin.on('error', () => {});
  let lineBuf = '';
  child.stdout.on('data', d => {
    if (!res.writableEnded) res.write(d); lineBuf += d;
    let nl; while ((nl = lineBuf.indexOf('\n')) >= 0) {
      const line = lineBuf.slice(0, nl); lineBuf = lineBuf.slice(nl + 1);
      if (/"type"\s*:\s*"result"/.test(line)) { try { const ev = JSON.parse(line); if (ev.type === 'result') { record(ev); if (!ev.is_error && body.autoName !== false) autoTitle(ev.session_id, body.prompt, ev.result); if (useJson) child.stdin.end(); } } catch {} }
      else if (/"type"\s*:\s*"control_request"/.test(line)) {
        try { const ev = JSON.parse(line); if (ev.type === 'control_request' && ev.request && ev.request.subtype === 'can_use_tool') { pendingAsk.set(ev.request_id, { child, req: ev.request }); askIds.add(ev.request_id); } } catch {}
      }
    }
  });

  let err = '';
  child.stderr.on('data', d => { err += d; });
  child.on('error', e => {
    res.end(JSON.stringify({ type: 'cc1_error', message: e.message }) + '\n');
  });
  child.on('close', code => {
    for (const id of askIds) pendingAsk.delete(id);
    if (code && err) res.write(JSON.stringify({ type: 'cc1_error', message: err.trim() }) + '\n');
    res.end();
  });
  res.on('close', () => { if (child.exitCode === null) killTree(child); });
}

const pendingAsk = new Map(); // request_id -> { child, req } for tool calls waiting on the user
function answerAsk(body) {
  const w = pendingAsk.get(String(body.request_id || ''));
  if (!w) return { code: 404, error: 'that request is no longer pending' };
  pendingAsk.delete(String(body.request_id));
  let response;
  if (body.behavior === 'allow') {
    response = { behavior: 'allow', updatedInput: body.updatedInput && typeof body.updatedInput === 'object' ? body.updatedInput : w.req.input };
    if (body.always && Array.isArray(w.req.permission_suggestions)) response.updatedPermissions = w.req.permission_suggestions.filter(x => x.type === 'addRules' || x.type === 'setMode');
  } else response = { behavior: 'deny', message: String(body.message || 'The user denied this tool call in CC-1.') };
  try { w.child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: String(body.request_id), response } }) + '\n'); }
  catch { return { code: 410, error: 'the session has already ended' }; }
  return { code: 200, ok: true };
}

function killTree(child) {
  if (WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// Run one shell command in `cwd`, streaming {t:'o'|'e',d} chunks, then {t:'x',code,cwd}.
function exec(req, res, body) {
  const { cmd } = body; let cwd = String(body.cwd || '');
  if (typeof cmd !== 'string' || !cmd.trim()) return json(res, 400, { error: 'empty command' });
  try { if (!fs.statSync(cwd).isDirectory()) throw 0; } catch { return json(res, 400, { error: 'bad cwd' }); }
  const meta = path.join(os.tmpdir(), 'cc1-meta-' + process.pid + '-' + Date.now());
  let child;
  if (WIN) {
    // PowerShell; exit code + final directory are written to a temp file
    const script = cmd + '\n$__ok = $?; $__rc = if ($__ok) {0} elseif ($LASTEXITCODE) {$LASTEXITCODE} else {1}; Set-Content -LiteralPath $env:CC1_META -Value ("$__rc`n" + (Get-Location).Path) -NoNewline';
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, CC1_META: meta } });
  } else {
    const shell = process.env.SHELL || '/bin/zsh';
    // fd 3 reports the exit code and final directory, so `cd` sticks between commands
    child = spawn(shell, ['-lc', cmd + '\n__rc=$?; printf "%s\\n%s" "$__rc" "$PWD" >&3'], {
      cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1', CLICOLOR_FORCE: '1' } });
  }
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
  const send = o => { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); };
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', d => send({ t: 'o', d }));
  child.stderr.on('data', d => send({ t: 'e', d }));
  let metaOut = ''; if (!WIN) child.stdio[3].on('data', d => { metaOut += d; });
  child.on('error', e => { send({ t: 'e', d: e.message + '\n' }); res.end(); });
  child.on('close', code => {
    if (WIN) { try { metaOut = fs.readFileSync(meta, 'utf8'); fs.unlinkSync(meta); } catch {} }
    const [rc, dir] = metaOut.split('\n');
    send({ t: 'x', code: rc !== undefined && rc !== '' ? +rc : code, cwd: dir || cwd }); res.end();
  });
  res.on('close', () => { if (child.exitCode === null) killTree(child); });
}

// ---- Claude account & user-level settings ----
const CONF = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CONF, 'settings.json'), MEMORY = path.join(CONF, 'CLAUDE.md');
const run = (args, ms = 30000) => new Promise(ok => require('child_process').execFile('claude', args,
  { cwd: os.homedir(), timeout: ms, shell: WIN, windowsHide: true, maxBuffer: 4e6 }, (err, out, se) => ok({ err, out: String(out || ''), se: String(se || '') })));
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
function writeAtomic(f, text) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (fs.existsSync(f) && !fs.existsSync(f + '.cc1.bak')) fs.copyFileSync(f, f + '.cc1.bak'); // one-time backup
  fs.writeFileSync(f + '.tmp', text); fs.renameSync(f + '.tmp', f);
}
function parseSettings() { const raw = readText(SETTINGS); if (!raw.trim()) return {}; const o = JSON.parse(raw); if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('settings.json is not an object'); return o; }
const SETTABLE = { 'model': v => ['', 'haiku', 'sonnet', 'opus'].includes(v), 'alwaysThinkingEnabled': v => typeof v === 'boolean',
  'permissions.defaultMode': v => ['', 'default', 'manual', 'auto', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'].includes(v),
  'cleanupPeriodDays': v => v === '' || (Number.isInteger(v) && v >= 1 && v <= 3650) };
const getJson = (url, extra) => new Promise((ok, no) => {
  const r = require('https').get(url, { headers: Object.assign({ Accept: 'application/json' }, extra), timeout: 8000 }, resp => {
    let b = ''; resp.setEncoding('utf8'); resp.on('data', d => { b += d; }); resp.on('end', () => { try { ok(JSON.parse(b)); } catch (e) { no(e); } });
  });
  r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', no);
});
// Update check: newest GitHub release vs. the VERSION file. Cached for an hour; the UI only asks if the user hasn't switched it off.
const REPO = 'JosephWhi98/CC-1';
let updCache = { at: 0, v: null };
const semver = v => String(v).replace(/^v/, '').split(/[-+]/)[0].split('.').map(n => parseInt(n, 10) || 0);
function newerThan(a, b) { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; }
async function checkUpdate() {
  if (updCache.v && Date.now() - updCache.at < 3600e3) return updCache.v;
  const list = await getJson('https://api.github.com/repos/' + REPO + '/releases?per_page=10', { 'User-Agent': 'CC-1/' + VERSION });   // the list (not /latest) so pre-releases count too
  const r = Array.isArray(list) ? list.find(x => !x.draft) : list;
  if (!r || !r.tag_name) throw new Error(!r || !r.message || r.message === 'Not Found' ? 'no releases published yet' : r.message);
  const assets = (r.assets || []).map(a => ({ name: a.name, url: a.browser_download_url, size: a.size, digest: a.digest || '' }));
  const v = { current: VERSION, latest: String(r.tag_name).replace(/^v/, ''), newer: newerThan(r.tag_name, VERSION), url: r.html_url, notes: String(r.body || '').slice(0, 1500), assets };
  updCache = { at: Date.now(), v };
  return v;
}
// In-app update: download the release asset for this OS, check it against the SHA-256 GitHub publishes, unpack it to a staging
// folder. The native shell (Swift / C#) then swaps the app and relaunches; this server never replaces files itself.
const UPD_DIR = path.join(os.homedir(), '.cc-1', 'update');
const upd = { phase: 'idle', pct: 0, stage: '', version: '', error: '' };
try { fs.rmSync(UPD_DIR, { recursive: true, force: true }); } catch {}   // leftovers from the previous update
function fetchFile(url, dest, onPct, hops = 0) {
  return new Promise((ok, no) => {
    let u; try { u = new URL(url); } catch (e) { return no(new Error('bad url')); }
    if (u.protocol !== 'https:' || !/(^|\.)(github\.com|githubusercontent\.com)$/.test(u.hostname)) return no(new Error('refusing to download from ' + u.hostname));
    require('https').get(url, { headers: { 'User-Agent': 'CC-1/' + VERSION } }, resp => {
      if ([301, 302, 303, 307, 308].includes(resp.statusCode) && resp.headers.location && hops < 5) { resp.resume(); return fetchFile(new URL(resp.headers.location, url).href, dest, onPct, hops + 1).then(ok, no); }
      if (resp.statusCode !== 200) { resp.resume(); return no(new Error('download failed (HTTP ' + resp.statusCode + ')')); }
      const total = +resp.headers['content-length'] || 0, h = crypto.createHash('sha256'), out = fs.createWriteStream(dest); let got = 0;
      resp.on('data', d => { got += d.length; h.update(d); if (total) onPct(Math.round(got / total * 100)); });
      resp.pipe(out);
      out.on('finish', () => ok(h.digest('hex'))); out.on('error', no); resp.on('error', no);
    }).on('error', no);
  });
}
function runCmd(cmd, args) { return new Promise((ok, no) => { const c = spawn(cmd, args, { windowsHide: true }); let e = ''; c.stderr.on('data', d => { e += d; }); c.on('error', no); c.on('close', code => code === 0 ? ok() : no(new Error(cmd + ' failed: ' + e.trim().slice(0, 200)))); }); }
function startInstall() {
  if (['download', 'verify', 'extract'].includes(upd.phase)) return;
  if (process.platform !== 'darwin' && process.platform !== 'win32') throw new Error('in-app update is only available on macOS and Windows');
  Object.assign(upd, { phase: 'download', pct: 0, stage: '', version: '', error: '' });
  (async () => {
    try {
      const info = await checkUpdate();
      if (!info.newer) throw new Error('already up to date');
      const re = process.platform === 'darwin' ? /-mac\.zip$/ : /-win-x64-native\.zip$/;
      const a = info.assets.find(x => re.test(x.name));
      if (!a) throw new Error('this release has no package for your system');
      const want = (/^sha256:([0-9a-f]{64})$/.exec(a.digest) || [])[1];
      if (!want) throw new Error('release has no published checksum');
      upd.version = info.latest;
      fs.rmSync(UPD_DIR, { recursive: true, force: true }); fs.mkdirSync(UPD_DIR, { recursive: true });
      const zip = path.join(UPD_DIR, 'update.zip');
      const got = await fetchFile(a.url, zip, p => { upd.pct = p; });
      upd.phase = 'verify';
      if (got !== want) { fs.rmSync(UPD_DIR, { recursive: true, force: true }); throw new Error('checksum mismatch, download discarded'); }
      upd.phase = 'extract';
      const dir = path.join(UPD_DIR, 'stage'); fs.mkdirSync(dir);
      if (process.platform === 'darwin') { await runCmd('/usr/bin/ditto', ['-x', '-k', zip, dir]); if (!fs.existsSync(path.join(dir, 'CC-1.app', 'Contents', 'Info.plist'))) throw new Error('package is missing CC-1.app'); upd.stage = dir; }
      else { await runCmd('tar', ['-xf', zip, '-C', dir]); const root = path.join(dir, 'CC-1-win-x64-native'); if (!fs.existsSync(path.join(root, 'CC-1.exe'))) throw new Error('package is missing CC-1.exe'); upd.stage = root; }
      fs.rmSync(zip, { force: true });
      upd.phase = 'ready'; upd.pct = 100;
    } catch (e) { upd.phase = 'error'; upd.error = String(e.message || e).slice(0, 200); }
  })();
}
let loginProc = null;
async function claudeApi(req, res, u, body) {
  const p = u.pathname;
  if (p === '/api/claude/account') {
    const [a, v] = await Promise.all([run(['auth', 'status', '--json'], 20000), run(['--version'], 15000)]);
    let auth = null; try { auth = JSON.parse(a.out); } catch {}
    if (!auth) return json(res, 200, { auth: { loggedIn: false }, version: v.out.trim(), error: (a.se || a.out || (a.err && a.err.message) || '').trim().slice(0, 300) });
    delete auth.orgId; return json(res, 200, { auth, version: v.out.trim() });
  }
  if (p === '/api/claude/settings') {
    let settings = {}, error = ''; try { settings = parseSettings(); } catch (e) { error = e.message; }
    return json(res, 200, { settings, raw: readText(SETTINGS), memory: readText(MEMORY), dir: CONF, error });
  }
  if (p === '/api/claude/set') {
    const { key, value } = body; if (!SETTABLE[key] || !SETTABLE[key](value)) return json(res, 400, { error: 'not allowed' });
    let o; try { o = parseSettings(); } catch (e) { return json(res, 400, { error: 'settings.json is invalid JSON — fix it in the editor first' }); }
    const parts = key.split('.'); let t = o; for (const k of parts.slice(0, -1)) { if (typeof t[k] !== 'object' || !t[k]) t[k] = {}; t = t[k]; }
    const last = parts[parts.length - 1]; if (value === '') delete t[last]; else t[last] = value;
    if (parts.length > 1 && !Object.keys(o[parts[0]]).length) delete o[parts[0]];
    writeAtomic(SETTINGS, JSON.stringify(o, null, 2) + '\n'); return json(res, 200, { settings: o, raw: readText(SETTINGS) });
  }
  if (p === '/api/claude/raw') {
    try { const o = JSON.parse(String(body.raw || '{}')); if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('must be a JSON object'); }
    catch (e) { return json(res, 400, { error: 'Invalid JSON: ' + e.message }); }
    writeAtomic(SETTINGS, String(body.raw).trimEnd() + '\n'); return json(res, 200, { ok: true });
  }
  if (p === '/api/claude/memory') { writeAtomic(MEMORY, String(body.text || '')); return json(res, 200, { ok: true }); }
  if (p === '/api/claude/update-check') {
    const v = await run(['--version'], 15000), cur = (v.out.match(/\d+\.\d+\.\d+/) || [])[0] || '';
    let latest = ''; try { latest = (await getJson('https://registry.npmjs.org/@anthropic-ai/claude-code/latest')).version || ''; } catch {}
    const n = x => x.split('.').map(Number), a = n(latest || '0.0.0'), b = n(cur || '0.0.0');
    const newer = !!latest && !!cur && (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) > 0;
    return json(res, 200, { current: cur, latest, newer, offline: !latest });
  }
  if (p === '/api/claude/update') { const r = await run(['update'], 300000); return json(res, 200, { out: (r.out + r.se).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim() || 'done' }); }
  if (p === '/api/claude/mcp') { const r = await run(['mcp', 'list'], 90000); return json(res, 200, { out: (r.out || r.se).replace(/\x1b\[[0-9;]*m/g, '').trim() }); }
  if (p === '/api/claude/logout') { const r = await run(['auth', 'logout'], 30000); return json(res, 200, { out: (r.out + r.se).trim() || 'signed out' }); }
  if (p === '/api/claude/login') {
    if (loginProc && loginProc.exitCode === null) return json(res, 200, { out: 'a sign-in is already in progress — finish it in your browser' });
    loginProc = spawn('claude', ['auth', 'login'], { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'], shell: WIN, windowsHide: true });
    let out = ''; const add = d => { out += d; }; loginProc.stdout.on('data', add); loginProc.stderr.on('data', add);
    const killer = setTimeout(() => { if (loginProc && loginProc.exitCode === null) killTree(loginProc); }, 5 * 60 * 1000);
    loginProc.on('close', () => clearTimeout(killer)); loginProc.on('error', e => { out += e.message; });
    return setTimeout(() => json(res, 200, { out: out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim() || 'a browser window should open to finish signing in' }), 3500);
  }
  return json(res, 404, { error: 'not found' });
}

let usageCache = { at: 0, data: null };
function usage(res) {
  if (usageCache.data && Date.now() - usageCache.at < 10000) return json(res, 200, usageCache.data);
  require('child_process').execFile('claude', ['-p', '/usage'], { cwd: os.homedir(), timeout: 40000, shell: WIN, windowsHide: true }, (err, out) => {
    if (err && !out) return json(res, 500, { error: 'could not run claude /usage' });
    const bars = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(.+?):\s*(\d+)%\s*used(?:\s*·\s*resets\s*(.+?))?\s*$/i);
      if (m) bars.push({ label: m[1], pct: +m[2], resets: m[3] || '' });
    }
    usageCache = { at: Date.now(), data: { bars, raw: bars.length ? '' : out.slice(0, 600) } };
    json(res, 200, usageCache.data);
  });
}

const TYPES = { '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };


// ---- remote access: optional LAN listener, QR pairing, per-device tokens ----
const crypto = require('crypto');
const REMOTE_FILE = path.join(os.homedir(), '.cc-1', 'remote.json');
const RPORT = PORT + 1;
const loadRemote = () => { try { const o = JSON.parse(fs.readFileSync(REMOTE_FILE, 'utf8')); return { enabled: !!o.enabled, allowDanger: !!o.allowDanger, devices: Array.isArray(o.devices) ? o.devices : [] }; } catch { return { enabled: false, allowDanger: false, devices: [] }; } };
const remote = loadRemote();
const saveRemote = () => { fs.mkdirSync(path.dirname(REMOTE_FILE), { recursive: true }); fs.writeFileSync(REMOTE_FILE, JSON.stringify(remote, null, 2), { mode: 0o600 }); };
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const normIp = a => String(a || '').replace(/^::ffff:/, '');
const isLoop = a => { a = normIp(a); return a === '127.0.0.1' || a === '::1'; };
const isPrivIp = a => { a = normIp(a); return /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a) || /^169\.254\./.test(a) || /^f[cd][0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a); };
const lanIps = () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal && isPrivIp(i.address)).map(i => i.address);
// Host header must be a private IPv4 literal or a .local name on the remote port (blocks DNS rebinding)
const remoteHostOk = h => { const m = /^([^:]+):(\d+)$/.exec(h || ''); return !!m && +m[2] === RPORT && (/^\d+\.\d+\.\d+\.\d+$/.test(m[1]) ? isPrivIp(m[1]) : /^[\w-]+\.local$/i.test(m[1])); };
let pairing = null, pairFails = 0; const failsByIp = new Map();
const newPairing = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; pairing = { code: Array.from(crypto.randomBytes(10), b => A[b % 32]).join(''), exp: Date.now() + 5 * 60e3 }; pairFails = 0; return pairing; };
const cookieOf = (req, k) => { const m = new RegExp('(?:^|;\\s*)' + k + '=([^;]+)').exec(req.headers.cookie || ''); return m ? m[1] : ''; };
function deviceOf(req) {
  const t = cookieOf(req, 'cc1t'); if (!t) return null;
  const h = sha(t), d = remote.devices.find(x => { try { return crypto.timingSafeEqual(Buffer.from(x.hash, 'hex'), Buffer.from(h, 'hex')); } catch { return false; } });
  if (d && Date.now() - (d.last || 0) > 60e3) { d.last = Date.now(); try { saveRemote(); } catch {} }
  return d || null;
}
function pairDevice(req, res, body) {
  const ip = normIp(req.socket.remoteAddress), f = failsByIp.get(ip) || { n: 0, at: 0 };
  if (Date.now() - f.at > 10 * 60e3) f.n = 0;
  if (f.n >= 8) return json(res, 429, { error: 'too many attempts — wait a few minutes' });
  const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const bad = () => { f.n++; f.at = Date.now(); failsByIp.set(ip, f); if (pairing && ++pairFails >= 5) pairing = null; return json(res, 403, { error: 'invalid or expired code' }); };
  if (!pairing || Date.now() > pairing.exp || code.length !== pairing.code.length) return bad();
  try { if (!crypto.timingSafeEqual(Buffer.from(code), Buffer.from(pairing.code))) return bad(); } catch { return bad(); }
  pairing = null;
  const token = crypto.randomBytes(32).toString('hex'), ua = String(req.headers['user-agent'] || '');
  const name = String(body.name || '').slice(0, 40) || (/iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : 'Device');
  remote.devices.push({ id: crypto.randomBytes(6).toString('hex'), hash: sha(token), name, created: Date.now(), last: Date.now() }); saveRemote();
  res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `cc1t=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000` });
  res.end(JSON.stringify({ ok: true }));
}
const PAIR_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#c9c6bf"><link rel="apple-touch-icon" href="/icon-180.png"><title>CC-1 · pair</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#c9c6bf;font:14px ui-monospace,Menlo,monospace;color:#161616;padding:20px;box-sizing:border-box}
.c{width:min(360px,100%);background:#e9e7e1;border-radius:20px;padding:24px;box-shadow:0 20px 50px #0003}h1{margin:0 0 4px;font:800 28px system-ui}p{color:#5d5a52;line-height:1.5;margin:6px 0 16px}
input{width:100%;box-sizing:border-box;font:700 20px ui-monospace,Menlo,monospace;letter-spacing:.2em;text-transform:uppercase;text-align:center;padding:14px;border:0;border-radius:10px;background:#d9dfc9;color:#1b2014}
button{width:100%;margin-top:12px;padding:14px;border:0;border-radius:12px;background:#ff4d00;color:#fff;font:800 14px system-ui;letter-spacing:.14em}#m{min-height:20px;margin-top:10px;color:#b3261e}</style></head>
<body><div class="c"><h1>CC-1</h1><p>Scan the QR code in CC-1 on your computer (Settings → Remote), or type the pairing code shown there.</p>
<input id="c" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="PAIRING CODE"><button id="b">PAIR THIS DEVICE</button><div id="m"></div></div>
<script>const c=document.getElementById('c'),m=document.getElementById('m');c.value=(location.hash||'').slice(1);history.replaceState(null,'',location.pathname);
async function go(){m.textContent='';try{const r=await fetch('/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:c.value})});const j=await r.json();if(!r.ok)throw new Error(j.error);location.href='/'}catch(e){m.textContent=e.message}}
document.getElementById('b').onclick=go;if(c.value)go();</script></body></html>`;
const remoteSockets = new Set();
function setRemote(on) {
  return new Promise(ok => {
    if (on === remoteSrv.listening) return ok(null);
    if (on) { const onErr = e => ok(e.message); remoteSrv.once('error', onErr); remoteSrv.listen(RPORT, '0.0.0.0', () => { remoteSrv.off('error', onErr); ok(null); }); }
    else { remoteSrv.close(); remoteSockets.forEach(s => s.destroy()); ok(null); }
  });
}
function remoteInfo() {
  const p = pairing && Date.now() < pairing.exp ? pairing : null;
  return { enabled: remote.enabled, listening: remoteSrv.listening, port: RPORT, allowDanger: remote.allowDanger, ips: lanIps(), code: p && p.code, expires: p && p.exp,
    host: os.hostname().replace(/\.local$/i, '') + '.local', devices: remote.devices.map(d => ({ id: d.id, name: d.name, created: d.created, last: d.last })) };
}
async function remoteApi(req, res, body) {
  if (req.method === 'POST') {
    if (typeof body.allowDanger === 'boolean') remote.allowDanger = body.allowDanger;
    if (body.revoke) remote.devices = remote.devices.filter(d => d.id !== body.revoke);
    if (typeof body.enabled === 'boolean') {
      remote.enabled = body.enabled; const err = await setRemote(body.enabled);
      if (err) { remote.enabled = false; saveRemote(); return json(res, 500, { error: 'could not open port ' + RPORT + ': ' + err }); }
      if (body.enabled && (!pairing || Date.now() > pairing.exp)) newPairing();
    }
    if (body.newCode) newPairing();
    saveRemote();
  } else if (remote.enabled && (!pairing || Date.now() > pairing.exp)) newPairing();
  return json(res, 200, remoteInfo());
}

const remoteSrv = http.createServer((req, res) => handle(req, res, true));
remoteSrv.on('connection', s => { remoteSockets.add(s); s.on('close', () => remoteSockets.delete(s)); });
const server = http.createServer((req, res) => handle(req, res, false));
async function handle(req, res, isRemote) {
  // Guard against DNS rebinding / cross-site requests: this server can run an agent.
  const hostOk = h => isRemote ? remoteHostOk(h) : allowedHosts.has(h);
  if (!hostOk(req.headers.host)) return json(res, 403, { error: 'bad host' });
  if (isRemote && !isPrivIp(req.socket.remoteAddress) && !isLoop(req.socket.remoteAddress)) return json(res, 403, { error: 'local network only' });
  if (req.method === 'POST') {
    const o = req.headers.origin;
    if (o && !hostOk(o.replace(/^https?:\/\//, ''))) return json(res, 403, { error: 'bad origin' });
  }
  let dev = null;
  if (isRemote) {
    const pu = new URL(req.url, 'http://x').pathname;
    if (req.method === 'POST' && pu === '/api/pair') return pairDevice(req, res, await readBody(req).catch(() => ({})));
    if (req.method === 'GET' && pu === '/pair') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(PAIR_PAGE); }   // the QR link: also reachable by phones that are already paired
    if (req.method === 'GET' && (pu === '/icon-180.png' || pu === '/manifest.webmanifest')) { /* public */ }
    else {
      dev = deviceOf(req);
      if (!dev) { if (pu.startsWith('/api/')) return json(res, 401, { error: 'not paired' }); res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(PAIR_PAGE); }
    }
  }

  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/remote') { if (isRemote) return json(res, 403, { error: 'manage remote access from the computer' }); return remoteApi(req, res, req.method === 'POST' ? await readBody(req) : {}); }
    if (isRemote && (u.pathname.startsWith('/api/claude/') || u.pathname.startsWith('/api/update/') || u.pathname === '/api/projects/add' || u.pathname === '/api/projects/remove' || (u.pathname === '/api/exec' && !remote.allowDanger))) return json(res, 403, { error: 'not available from a remote device' });
    if (req.method === 'GET' && u.pathname === '/api/projects') return json(res, 200, { projects: listProjects().map(p => ({ path: p, name: path.basename(p) })) });
    if (req.method === 'POST' && (u.pathname === '/api/projects/add' || u.pathname === '/api/projects/remove')) {
      const { path: p } = await readBody(req); const list = listProjects();
      if (u.pathname.endsWith('add')) {
        const r = path.resolve(String(p || '').replace(/^~/, os.homedir()));
        if (!fs.existsSync(r) || !fs.statSync(r).isDirectory()) return json(res, 400, { error: 'not a folder: ' + r });
        if (!list.includes(r)) list.push(r);
        saveProjects(list); return json(res, 200, { added: r });
      }
      saveProjects(list.filter(x => x !== p)); return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && u.pathname === '/api/permission') { const r = answerAsk(await readBody(req)); return json(res, r.code, r); }
    if (req.method === 'POST' && u.pathname === '/api/exec') return exec(req, res, await readBody(req));
    if (u.pathname.startsWith('/api/claude/')) {
      const body = req.method === 'POST' ? await readBody(req) : {};
      if (req.method === 'GET' && ['/api/claude/account', '/api/claude/settings', '/api/claude/mcp', '/api/claude/update-check'].includes(u.pathname) || req.method === 'POST') return claudeApi(req, res, u, body);
    }
    if (u.pathname === '/api/project-md') {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const proj = req.method === 'POST' ? body.project : u.searchParams.get('project');
      if (!listProjects().includes(proj)) return json(res, 400, { error: 'unknown project' });
      const top = path.join(proj, 'CLAUDE.md'), nested = path.join(proj, '.claude', 'CLAUDE.md');
      const file = !fs.existsSync(top) && fs.existsSync(nested) ? nested : top;
      if (req.method === 'GET') return json(res, 200, { path: file, exists: fs.existsSync(file), text: readText(file) });
      if (req.method === 'POST') {
        if (body.reveal && !isRemote) {
          const [cmd, args] = process.platform === 'darwin' ? ['open', fs.existsSync(file) ? ['-R', file] : [proj]]
            : WIN ? ['explorer.exe', fs.existsSync(file) ? ['/select,' + file] : [proj]] : ['xdg-open', [proj]];
          spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
          return json(res, 200, { ok: true });
        }
        writeAtomic(file, String(body.text || '')); return json(res, 200, { ok: true, path: file });
      }
    }
    if (req.method === 'GET' && u.pathname === '/api/version') return json(res, 200, { version: VERSION });
    if (req.method === 'POST' && u.pathname === '/api/update/install') { try { startInstall(); return json(res, 200, { ok: true }); } catch (e) { return json(res, 200, { ok: false, error: String(e.message || e) }); } }
    if (req.method === 'GET' && u.pathname === '/api/update/status') return json(res, 200, upd);
    if (req.method === 'GET' && u.pathname === '/api/update') {
      try { return json(res, 200, await checkUpdate()); } catch (e) { return json(res, 200, { current: VERSION, error: String(e.message || e).slice(0, 120) }); }
    }
    if (req.method === 'GET' && u.pathname === '/api/usage') return usage(res);
    if (req.method === 'GET' && u.pathname === '/api/session-cost') {
      const proj = u.searchParams.get('project'), id = u.searchParams.get('id') || '';
      if (!listProjects().includes(proj) || !/^[\w-]+$/.test(id)) return json(res, 400, { error: 'bad request' });
      return json(res, 200, { ledger: readLedger()[id] || null, transcript: await sessionData(proj, id).then(d => d.totals, () => null) });
    }
    if (req.method === 'POST' && (u.pathname === '/api/session/rename' || u.pathname === '/api/session/delete')) {
      const b = await readBody(req);
      if (!listProjects().includes(b.project) || !SESSION_ID.test(String(b.id || ''))) return json(res, 400, { error: 'bad request' });
      if (u.pathname.endsWith('rename')) return json(res, 200, { title: renameSession(b.id, b.title) });
      try { deleteSession(b.project, b.id); return json(res, 200, { ok: true }); } catch (e) { return json(res, 404, { error: e.message }); }
    }
    if (req.method === 'GET' && u.pathname === '/api/session/markdown') {
      const proj = u.searchParams.get('project'), id = u.searchParams.get('id') || '';
      if (!listProjects().includes(proj) || !SESSION_ID.test(id)) return json(res, 400, { error: 'bad request' });
      try { return json(res, 200, { text: await sessionMarkdown(proj, id, readTitles()[id]) }); } catch { return json(res, 404, { error: 'no such session' }); }
    }
    if (req.method === 'GET' && u.pathname === '/api/sessions') {
      const proj = u.searchParams.get('project'); if (!listProjects().includes(proj)) return json(res, 400, { error: 'unknown project' });
      return json(res, 200, { sessions: listSessions(proj) });
    }
    if (req.method === 'GET' && u.pathname === '/api/session') {
      const proj = u.searchParams.get('project'), id = u.searchParams.get('id');
      if (!listProjects().includes(proj) || !/^[\w-]+$/.test(id || '')) return json(res, 400, { error: 'bad request' });
      try {
        const r = await sessionData(proj, id), total = r.items.length, lim = Number(u.searchParams.get('limit')) || total;   // no limit: the whole session
        const end = Math.min(total, u.searchParams.has('before') ? Math.max(0, Number(u.searchParams.get('before')) || 0) : total), start = Math.max(0, end - lim);
        return json(res, 200, { items: r.items.slice(start, end), start, total, turns: r.turns, ctx: r.ctx });
      } catch { return json(res, 404, { error: 'no such session' }); }
    }
    if (req.method === 'GET' && u.pathname === '/api/session-image') {
      const proj = u.searchParams.get('project'), id = u.searchParams.get('id'), tool = u.searchParams.get('tool');
      if (!listProjects().includes(proj) || !/^[\w-]+$/.test(id || '') || !/^[\w-]+$/.test(tool || '')) return json(res, 400, { error: 'bad request' });
      let im = null; try { im = await sessionImage(proj, id, tool, Number(u.searchParams.get('i')) || 0); } catch {}
      if (!im) return json(res, 404, { error: 'no such image' });
      res.writeHead(200, { 'Content-Type': im.type, 'Content-Length': im.data.length, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
      return res.end(im.data);
    }
    if (req.method === 'POST' && req.url === '/api/chat') {
      const b = await readBody(req);
      if (isRemote && b.mode === 'bypassPermissions' && !remote.allowDanger) return json(res, 403, { error: 'YOLO mode is disabled for remote devices' });
      return chat(req, res, b);
    }
    if (req.method === 'GET') {
      const rel = u.pathname === '/' ? 'index.html' : path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, '');
      const file = path.join(PUBLIC, rel);
      if (path.relative(PUBLIC, file).startsWith('..') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { error: e.message });
  }
}
server.on('error', e => { console.error('CC-1 server error:', e.message); });
server.listen(PORT, HOST, () => console.log(`CC-1 online → http://localhost:${PORT}`));
if (remote.enabled) setRemote(true).then(e => { if (e) console.error('remote access:', e); });
