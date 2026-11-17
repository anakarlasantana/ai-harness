import http from 'node:http';
import { TaskMemory } from '../memory/TaskMemory.js';
import { log } from '../core/logger.js';

/**
 * Local, dependency-free monitoring dashboard.
 *
 * Serves:
 *   GET /                -> HTML (Tailwind via CDN) with 3s auto-refresh
 *   GET /api/traces      -> all task JSONs under <cwd>/.harness/tasks
 *   GET /api/traces/:id  -> a single task
 *
 * Bound to 127.0.0.1 by default; read-only over local task memory.
 */
export interface DashboardOptions {
  cwd: string;
  port?: number;
  host?: string;
}

export function startDashboard(opts: DashboardOptions): Promise<http.Server> {
  const port = opts.port ?? Number(process.env.DASHBOARD_PORT ?? 3000);
  const host = opts.host ?? '127.0.0.1';
  const memory = new TaskMemory(opts.cwd);

  const server = http.createServer(async (req, res) => {
    const url = req.url ?? '/';

    if (url === '/' || url.startsWith('/?')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }

    if (url === '/api/traces') {
      const tasks = await memory.listAll();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ tasks }));
      return;
    }

    // Observabilidade dos testes: todas as execuções, de todas as tasks.
    if (url === '/api/tests') {
      const tasks = await memory.listAll();
      const runs = tasks.flatMap((t) => (t.testRuns ?? []).map((r) => ({ taskId: t.id, ...r })));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ runs }));
      return;
    }

    const m = url.match(/^\/api\/traces\/([^/]+)$/);
    if (m && m[1]) {
      const task = await memory.load(decodeURIComponent(m[1]));
      if (!task) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'task not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(task));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      log.ok(`Dashboard disponível em http://${host}:${port} (auto-refresh 3s)`);
      resolve(server);
    });
  });
}

const HTML = `<!doctype html>
<html lang="pt-BR" class="h-full">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI Harness — Dashboard</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="h-full bg-slate-950 text-slate-100 antialiased">
<header class="border-b border-slate-800 px-6 py-4 flex items-center justify-between">
  <div>
    <h1 class="text-lg font-semibold">AI Harness · Monitor de Execução</h1>
    <p class="text-xs text-slate-400">Linha do tempo, transição de personas e log de pensamento da IA</p>
  </div>
  <span id="clock" class="text-xs text-slate-400"></span>
</header>
<main class="p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
  <section class="lg:col-span-1 space-y-6">
    <div>
      <h2 class="text-xs uppercase tracking-wide text-slate-500 mb-2">Testes das aplicações</h2>
      <div id="tests" class="space-y-3"></div>
    </div>
    <div>
      <h2 class="text-xs uppercase tracking-wide text-slate-500 mb-2">Tasks</h2>
      <div id="tasks" class="space-y-3"></div>
    </div>
  </section>
  <section id="detail" class="lg:col-span-2">
    <div class="text-slate-500 text-sm">Selecione uma task à esquerda.</div>
  </section>
</main>
<script>
const STATUS_BADGE = {
  planned:'bg-slate-700', coded:'bg-blue-700', 'qa-passed':'bg-green-700',
  'qa-failed':'bg-red-700', reworked:'bg-purple-700', synced:'bg-teal-700', error:'bg-red-800'
};
function el(tag, cls, txt){const e=document.createElement(tag);if(cls)e.className=cls;if(txt!==undefined)e.textContent=txt;return e;}
function statusIcon(s){return s==='thinking'?'🧠':s==='tool_executed'?'🔧':s==='success'?'✅':s==='error'?'❌':'•';}
const TEST_BADGE = { running:'bg-amber-600', passed:'bg-green-700', failed:'bg-red-700' };
const STEP_BADGE = { running:'bg-amber-600', passed:'bg-green-700', failed:'bg-red-700', skipped:'bg-slate-600' };
function dur(ms){ return ms===undefined||ms===null ? '—' : (Math.round(ms/100)/10) + 's'; }
function testTitle(r){ return r.kind==='readiness' ? 'prontidão' : ('e2e' + (r.journey ? ' · ' + r.journey : '')); }
async function refreshTests(){
  let data;
  try{ data = await (await fetch('/api/tests')).json(); }catch(e){ return; }
  const runs = (data.runs||[]).slice(0,12);
  const box = document.getElementById('tests');
  box.innerHTML = '';
  if(runs.length===0){ box.appendChild(el('div','text-slate-500 text-sm','Nenhuma verificação ainda. Rode: ai e2e (ou ai e2e --readiness).')); }
  runs.forEach(r=>{
    const card = el('div','rounded-lg border border-slate-800 p-3 bg-slate-900/60');
    const top = el('div','flex items-center justify-between gap-2');
    top.appendChild(el('span','font-medium text-sm', testTitle(r)));
    top.appendChild(el('span','text-[10px] px-2 py-0.5 rounded ' + (TEST_BADGE[r.status]||'bg-slate-700'), r.status));
    card.appendChild(top);
    card.appendChild(el('div','text-[11px] text-slate-400 truncate mt-1', r.headline || r.command || ''));
    card.appendChild(el('div','text-[10px] text-slate-500 mt-1',
      'task: ' + r.taskId + ' · ' + dur(r.durationMs) + ' · 5xx ' + ((r.facts&&r.facts.fiveXX)||0) + ' · console ' + ((r.facts&&r.facts.consoleErrors)||0)));
    const chips = el('div','flex flex-wrap gap-1 mt-2');
    (r.steps||[]).forEach(s=>{
      chips.appendChild(el('span','text-[10px] px-1.5 py-0.5 rounded ' + (STEP_BADGE[s.status]||'bg-slate-700') + ' text-slate-100', s.name + ' · ' + dur(s.durationMs)));
    });
    if((r.steps||[]).length>0) card.appendChild(chips);
    if(r.digestPath) card.appendChild(el('div','text-[10px] text-slate-500 mt-1 truncate','digest: ' + r.digestPath));
    box.appendChild(card);
  });
}
async function refresh(){
  document.getElementById('clock').textContent = new Date().toLocaleString('pt-BR');
  let data;
  try{ data = await (await fetch('/api/traces')).json(); }catch(e){ return; }
  const tasks = data.tasks || [];
  const list = document.getElementById('tasks');
  list.innerHTML = '';
  if(tasks.length===0){ list.appendChild(el('div','text-slate-500 text-sm','Nenhuma task em .harness/tasks ainda.')); }
  tasks.forEach(t=>{
    const card = el('button','w-full text-left rounded-lg border border-slate-800 hover:border-slate-600 p-3 bg-slate-900/60');
    const top = el('div','flex items-center justify-between');
    top.appendChild(el('span','font-medium text-sm', t.id));
    const badge = el('span','text-[10px] px-2 py-0.5 rounded ' + (STATUS_BADGE[t.status]||'bg-slate-700'), t.status);
    top.appendChild(badge);
    card.appendChild(top);
    card.appendChild(el('div','text-xs text-slate-400 truncate mt-1', t.description || '(sem descrição)'));
    card.appendChild(el('div','text-[10px] text-slate-500 mt-1', 'trace: ' + (t.executionTrace?.length||0) + ' · reworks: ' + (t.qaFeedbackHistory?.length||0)));
    card.onclick = ()=>showTask(t);
    list.appendChild(card);
  });
  if(window.__selected){ const t = tasks.find(x=>x.id===window.__selected); if(t) showTask(t); }
}
function personaSequence(trace){
  const seq=[]; (trace||[]).forEach(e=>{ if(seq[seq.length-1]!==e.activePersona) seq.push(e.activePersona); });
  return seq;
}
async function showTask(t){
  window.__selected = t.id;
  const d = document.getElementById('detail');
  d.innerHTML='';
  const head = el('div','mb-4');
  head.appendChild(el('h2','text-xl font-semibold', t.id));
  head.appendChild(el('p','text-sm text-slate-400 mt-1', t.description||'(sem descrição)'));
  d.appendChild(head);

  const tree = el('div','mb-4 p-3 rounded-lg bg-slate-900/60 border border-slate-800');
  tree.appendChild(el('div','text-xs uppercase tracking-wide text-slate-500 mb-2','Árvore de transição de personas'));
  const seq = personaSequence(t.executionTrace);
  const row = el('div','flex flex-wrap items-center gap-2');
  seq.forEach((p,i)=>{ if(i>0) row.appendChild(el('span','text-slate-600','→')); row.appendChild(el('span','px-2 py-1 rounded bg-indigo-900/70 text-indigo-200 text-xs', p)); });
  if(seq.length===0) row.appendChild(el('span','text-slate-500 text-xs','(sem dados)'));
  tree.appendChild(row); d.appendChild(tree);

  if((t.testRuns||[]).length>0){
    const box = el('div','mb-4 p-3 rounded-lg bg-slate-900/60 border border-slate-800');
    box.appendChild(el('div','text-xs uppercase tracking-wide text-slate-500 mb-2','Verificações'));
    t.testRuns.forEach(r=>{
      const item = el('div','mb-2');
      const top = el('div','flex items-center justify-between gap-2');
      top.appendChild(el('span','text-sm', testTitle(r) + ' · ' + dur(r.durationMs)));
      top.appendChild(el('span','text-[10px] px-2 py-0.5 rounded ' + (TEST_BADGE[r.status]||'bg-slate-700'), r.status));
      item.appendChild(top);
      if(r.headline) item.appendChild(el('div','text-[11px] text-slate-400', r.headline));
      const chips = el('div','flex flex-wrap gap-1 mt-1');
      (r.steps||[]).forEach(s=>{
        const chip = el('span','text-[10px] px-1.5 py-0.5 rounded ' + (STEP_BADGE[s.status]||'bg-slate-700') + ' text-slate-100', s.name + ' · ' + dur(s.durationMs));
        if(s.detail) chip.title = s.detail;
        chips.appendChild(chip);
      });
      if((r.steps||[]).length>0) item.appendChild(chips);
      if(r.digestPath) item.appendChild(el('div','text-[10px] text-slate-500 truncate','digest: ' + r.digestPath));
      box.appendChild(item);
    });
    d.appendChild(box);
  }

  if(t.architectureDecision){
    const arch = el('div','mb-4 p-3 rounded-lg bg-slate-900/60 border border-slate-800');
    arch.appendChild(el('div','text-xs uppercase tracking-wide text-slate-500 mb-1','Decisão de arquitetura'));
    arch.appendChild(el('pre','text-xs whitespace-pre-wrap text-slate-300', t.architectureDecision));
    d.appendChild(arch);
  }

  const tl = el('div','relative border-l border-slate-800 ml-2');
  tl.appendChild(el('div','text-xs uppercase tracking-wide text-slate-500 mb-2 pl-4','Linha do tempo / log de pensamento'));
  (t.executionTrace||[]).forEach(e=>{
    const item = el('div','mb-3 pl-5 relative');
    const dot = el('span','absolute top-1 w-2.5 h-2.5 rounded-full bg-slate-600');
    dot.style.left = '-5px';
    item.appendChild(dot);
    const meta = el('div','text-[11px] text-slate-400');
    meta.textContent = (e.timestamp? new Date(e.timestamp).toLocaleTimeString('pt-BR'):'') + ' · ' + e.activePersona + ' · ' + e.status + (e.model?(' · '+e.model):'') + (e.toolCalled?(' · '+e.toolCalled):'');
    item.appendChild(meta);
    if(e.thought){ item.appendChild(el('div','text-sm text-slate-200 mt-0.5 whitespace-pre-wrap', statusIcon(e.status)+' '+e.thought)); }
    tl.appendChild(item);
  });
  if((t.executionTrace||[]).length===0) tl.appendChild(el('div','text-slate-500 text-sm pl-5','(sem trace ainda)'));
  d.appendChild(tl);
}
refresh(); refreshTests(); setInterval(function(){ refresh(); refreshTests(); }, 3000);
</script>
</body>
</html>`;
