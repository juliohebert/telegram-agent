// Workspace dedicado de validacao local (/validar): um clone exclusivo do
// MESMO origin do UserPulse-agent, nunca do UserPulse original (historia
// independente Clinic/Quark — ver comentarios em git.js sobre esse
// incidente). O usuario continua acessando sempre http://localhost:5173 —
// o bridge e quem garante que o que esta rodando ali corresponde a branch
// da tarefa pronta para validacao, sem o usuario precisar trocar de pasta.
//
// Este modulo NUNCA toca config.userpulsePath para escrita (so leitura, pra
// copiar os arquivos ja revisados) e NUNCA roda git em config.userpulsePath.
// Todo git aqui roda em config.validationPath (workspace separado, criado/
// gerenciado inteiramente pelo bridge) ou no processo de clone inicial.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { config } from './config.js';
import { getRemoteUrl } from './git.js';
import { IGNORED_DIRTY_PREFIXES } from './git.js';
import { killTreeByPid } from './processRegistry.js';

const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// No Windows, npm e um shim .cmd — spawn direto (shell:false) falha com
// EINVAL mesmo passando o nome completo com extensao; precisa do shell.
// Args sao sempre literais fixos aqui (nunca entrada externa), sem risco de
// injecao mesmo com shell:true.
const NPM_SHELL = process.platform === 'win32';
const STATE_FILE = path.join(config.stateDir, 'validation.json');
const LOG_DIR = path.join(config.stateDir, 'validation-logs');

// Portas fixas do proprio projeto UserPulse (nao configuraveis aqui): vite
// (web/vite.config.ts) sempre 5173; backend (server/.env PORT) default 3333
// documentado em .env.example. Nao inventamos outras portas.
//
// FRONTEND_PORT e so a porta PREFERIDA que pedimos ao Vite — ele pode cair
// pro fallback normal dele se estiver ocupada (5174, 5175...), entao a URL
// real do frontend NUNCA e fixa: e sempre a porta descoberta no proprio
// banner de startup do Vite (ver extractVitePortFromLog/state.frontend.port
// mais abaixo). O backend nao tem fallback (Express so quebra se a porta
// 3333 estiver ocupada), entao BACKEND_PORT/BACKEND_URL sao sempre a URL
// real de fato.
export const FRONTEND_PORT = 5173;
export const BACKEND_PORT = 3333;
export const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;
// server/src/index.ts expoe GET /health -> {status:'ok',...}; qualquer
// resposta (mesmo erro 4xx) ja confirma que o processo esta escutando e
// respondendo — o que importa aqui e "vivo", nao o conteudo especifico.
const BACKEND_HEALTH_PATH = '/health';

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function ensureDirs() {
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

export function loadValidationState() {
  ensureDirs();
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveValidationState(state) {
  ensureDirs();
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const tester = net
      .createServer()
      .once('error', () => resolve(true))
      .once('listening', () => tester.close(() => resolve(false)))
      .listen(port, '127.0.0.1');
  });
}

// Sonda HTTP real: qualquer resposta (mesmo 4xx/5xx da propria aplicacao)
// conta como "processo vivo e respondendo" — so timeout/erro de conexao
// (ECONNREFUSED, processo ainda nao escutando) conta como "nao pronto".
function httpProbeOnce(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

// Ultimas linhas do log do processo, pra explicar POR QUE ele nao ficou
// pronto (ex: "ADMIN_JWT_SECRET nao definido"). Cortado a um tamanho curto
// de proposito — nunca deve virar um despejo grande de log no Telegram, e
// nenhum destes processos loga segredos em texto claro no caso conhecido
// (so nomes de variavel ausente), mas o corte curto tambem limita o dano se
// algo inesperado aparecer.
function readLogTail(logFile, maxChars = 500) {
  try {
    const content = fs.readFileSync(logFile, 'utf8');
    const tail = content.slice(-maxChars).trim();
    return tail || '(log vazio)';
  } catch {
    return '(log indisponivel)';
  }
}

// Espera o processo comecar a responder de verdade no endpoint esperado,
// checando a cada intervalo tanto a resposta HTTP quanto se o processo
// CONTINUA vivo (nunca considera so o pid criado como sucesso — se o
// processo morreu no meio do caminho, para de esperar na hora e reporta a
// causa, sem aguardar o timeout inteiro).
async function waitForReady(pid, url, { timeoutMs = 20000, intervalMs = 400 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) {
      return { ready: false, cause: 'process_died' };
    }
    if (await httpProbeOnce(url)) {
      return { ready: true };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { ready: false, cause: 'timeout' };
}

// Extrai a porta REAL que o Vite escolheu do proprio banner de startup
// ("Local: http://localhost:PORTA/") — nunca assume que e a porta pedida,
// porque o Vite pode ter caido pro fallback normal dele (5173 ocupada ->
// 5174, 5175...). So aparece no log depois que o Vite ja esta de fato
// escutando ali, entao achar a linha ja e um bom sinal (a sonda HTTP depois
// confirma de verdade). Remove escapes ANSI de cor antes de casar.
function extractVitePortFromLog(logFile) {
  let content;
  try {
    content = fs.readFileSync(logFile, 'utf8');
  } catch {
    return null;
  }
  const plain = content.replace(/\x1b\[[0-9;]*m/g, '');
  const match = plain.match(/Local:\s*http:\/\/[^\s:]+:(\d{2,5})\/?/i);
  return match ? Number(match[1]) : null;
}

// Como waitForReady, mas pra quando a porta final so e conhecida depois do
// processo subir (frontend/Vite, com fallback de porta habilitado): so
// confirma pronto depois de achar a porta no log de startup E a sonda HTTP
// responder nela de verdade.
async function waitForViteReady(pid, logFile, { timeoutMs = 20000, intervalMs = 400 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) {
      return { ready: false, cause: 'process_died' };
    }
    const port = extractVitePortFromLog(logFile);
    if (port && (await httpProbeOnce(`http://localhost:${port}/`))) {
      return { ready: true, port };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { ready: false, cause: 'timeout' };
}

// Reaproveita o .env local do UserPulse-agent pro workspace de validacao
// quando o proprio validation ainda nao tiver um — nunca sobrescreve um
// .env ja existente ali, nunca altera o arquivo de origem, nunca le/loga o
// CONTEUDO (so verifica existencia e copia bytes). .env* ja e ignorado pelo
// .gitignore do proprio repo (herdado no clone), entao nunca fica rastreado.
function ensureEnvFile(destDir, srcDir) {
  const destEnv = path.join(destDir, '.env');
  if (fs.existsSync(destEnv)) return { present: true, copied: false };
  const srcEnv = path.join(srcDir, '.env');
  if (fs.existsSync(srcEnv)) {
    fs.copyFileSync(srcEnv, destEnv);
    return { present: true, copied: true };
  }
  return { present: false, copied: false };
}

// --- git generico, SEMPRE parametrizado por cwd explicito (nunca usa
// config.userpulsePath) ---
function runGitAt(cwd, args, { allowExitCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (!allowExitCodes.includes(code)) {
        reject(new Error(`git ${args.join(' ')} falhou (codigo ${code}) em ${cwd}: ${err.trim()}`));
        return;
      }
      resolve(out);
    });
  });
}

async function refExists(cwd, ref) {
  try {
    await runGitAt(cwd, ['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

async function hasLocalChangesAt(cwd) {
  const out = await runGitAt(cwd, ['status', '--porcelain']);
  const lines = out.split('\n').filter((l) => l.length > 0);
  const relevant = lines.filter((line) => {
    const file = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
    return !IGNORED_DIRTY_PREFIXES.some((prefix) => file.startsWith(prefix));
  });
  return relevant.length > 0 ? relevant.join('\n') : null;
}

// Cria (ou verifica) config.validationPath como clone exclusivo do origin
// do UserPulse-agent. Se a pasta ja existir, NUNCA apaga/recria — so valida
// que e um clone seguro (so remote "origin", mesma URL) e bloqueia com
// mensagem clara caso contrario, deixando a correcao manual pro usuario.
export async function ensureValidationWorkspace() {
  if (!config.validationPath) {
    throw new ValidationError(
      'USERPULSE_VALIDATION_PATH nao configurado. Defina no .env do telegram-agent (pasta irma, ex: USERPULSE_VALIDATION_PATH=..\\UserPulse-validation) antes de usar /validar.'
    );
  }

  const originUrl = (await getRemoteUrl('origin')).trim();

  if (!fs.existsSync(config.validationPath)) {
    const parent = path.dirname(config.validationPath);
    fs.mkdirSync(parent, { recursive: true });
    await new Promise((resolve, reject) => {
      const child = spawn('git', ['clone', originUrl, config.validationPath], { shell: false });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git clone falhou (codigo ${code}): ${err.trim()}`))));
    });
    return { created: true, path: config.validationPath };
  }

  if (!fs.existsSync(path.join(config.validationPath, '.git'))) {
    throw new ValidationError(
      `${config.validationPath} existe mas nao e um repositorio git. O bridge nunca apaga pastas existentes — resolva manualmente (mova/apague a pasta) antes de usar /validar.`
    );
  }

  const remotesOut = await runGitAt(config.validationPath, ['remote', '-v']);
  const remoteNames = [...new Set(remotesOut.split('\n').filter(Boolean).map((l) => l.split('\t')[0]))];
  const unexpected = remoteNames.filter((n) => n !== 'origin');
  if (unexpected.length > 0) {
    throw new ValidationError(
      `${config.validationPath} tem remote(s) alem de "origin" (${unexpected.join(', ')}). Isso nunca deve incluir "clinic"/Quark — resolva manualmente (git remote remove <nome>) antes de usar /validar.`
    );
  }
  const currentOriginUrl = (await runGitAt(config.validationPath, ['remote', 'get-url', 'origin'])).trim();
  if (currentOriginUrl !== originUrl) {
    throw new ValidationError(
      `origin de ${config.validationPath} (${currentOriginUrl}) nao bate com o origin do UserPulse-agent (${originUrl}). Resolva manualmente.`
    );
  }
  return { created: false, path: config.validationPath };
}

// Desfaz o overlay de arquivos da /validar ANTERIOR (se houver), usando
// SOMENTE a lista que o proprio bridge registrou ter sobrescrito da ultima
// vez — nunca um git reset/clean generico. Arquivo rastreado: `git checkout
// --` devolve o conteudo do commit. Arquivo que so existia por causa do
// overlay anterior (novo, nunca commitado): remove diretamente.
// Restaura um unico arquivo pro estado do commit atual: `git checkout --`
// se rastreado; remocao direta se so existia por ter sido criado por fora
// (overlay anterior, ou artefato de `npm install` — ver
// revertUnintendedLockfileChange). Nunca um reset/clean generico — sempre
// um arquivo explicito de cada vez.
async function revertFileToTracked(cwd, file) {
  try {
    await runGitAt(cwd, ['checkout', '--', file]);
  } catch {
    const full = path.join(cwd, file);
    if (fs.existsSync(full)) fs.rmSync(full);
  }
}

async function revertPreviousOverlay(cwd, previousFiles) {
  for (const file of previousFiles || []) {
    await revertFileToTracked(cwd, file);
  }
}

// `npm install` pode reescrever/gerar o lockfile mesmo sem mudanca real de
// dependencias (normalizacao, versao diferente do npm). Se isso nao fazia
// parte do diff revisado da tarefa (reviewedFiles), reverte imediatamente —
// senao esse ruido some da view do usuario mas fica registrado como "sujeira"
// pro PROXIMO /validar, bloqueando por engano um workspace que so o proprio
// bridge sujou.
async function revertUnintendedLockfileChange(cwd, lockRelPath, reviewedFiles) {
  if (reviewedFiles.includes(lockRelPath)) return;
  const dirty = await hasLocalChangesAt(cwd);
  const touched = dirty && dirty.split('\n').some((line) => line.slice(3).trim() === lockRelPath);
  if (touched) {
    await revertFileToTracked(cwd, lockRelPath);
  }
}

// git fetch + determina a base certa (origin/<branch> se ja existir, senao
// origin/main) + checkout/cria a branch local com o MESMO nome da tarefa,
// sempre por fast-forward ou criacao nova — nunca merge/rebase/reset/force.
// Branch local ja existente e desalinhada da base esperada bloqueia (o
// workspace e exclusivo do bridge; desalinhamento so pode vir de algo
// manual, que precisa ser resolvido manualmente).
async function ensureBranchCheckedOut(cwd, branch) {
  await runGitAt(cwd, ['fetch', 'origin']);

  const onOrigin = await refExists(cwd, `refs/remotes/origin/${branch}`);
  const base = onOrigin ? `origin/${branch}` : 'origin/main';
  const localExists = await refExists(cwd, `refs/heads/${branch}`);

  if (!localExists) {
    await runGitAt(cwd, ['switch', '-c', branch, base]);
  } else {
    await runGitAt(cwd, ['switch', branch]);
    if (onOrigin) {
      await runGitAt(cwd, ['pull', '--ff-only', 'origin', branch]);
    } else {
      const headSha = (await runGitAt(cwd, ['rev-parse', 'HEAD'])).trim();
      const baseSha = (await runGitAt(cwd, ['rev-parse', base])).trim();
      if (headSha !== baseSha) {
        throw new ValidationError(
          `Branch local '${branch}' em ${cwd} ja existe e nao esta alinhada com ${base} (HEAD=${headSha.slice(0, 8)} vs ${base}=${baseSha.slice(0, 8)}). Isso nao deveria acontecer num workspace exclusivo do bridge — resolva manualmente antes de tentar de novo.`
        );
      }
    }
  }

  const sha = (await runGitAt(cwd, ['rev-parse', 'HEAD'])).trim();
  return { sha, base, onOrigin };
}

// Copia o conteudo ATUAL de cada arquivo de `files` (lista ja revisada e
// fingerprintada pelo Mentor — task.reviewedFiles, nunca um copy generico)
// de config.userpulsePath para dentro do workspace de validacao. Arquivo
// removido no UserPulse-agent (fazia parte do diff como delecao) e removido
// tambem na validacao. E assim que o diff READY (ainda nao commitado/
// aprovado) fica visivel ali, sem precisar de commit/push.
function overlayReviewedFiles(files) {
  const applied = [];
  for (const file of files) {
    const src = path.join(config.userpulsePath, file);
    const dest = path.join(config.validationPath, file);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      applied.push(file);
    } else if (fs.existsSync(dest)) {
      fs.rmSync(dest);
      applied.push(file);
    }
  }
  return applied;
}

function lockfileHash(lockPath) {
  if (!fs.existsSync(lockPath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(lockPath)).digest('hex');
}

// Roda `npm install` em `dir` SO se node_modules estiver ausente ou o
// lockfile tiver mudado desde a ultima instalacao registrada (state.installs).
async function ensureDepsInstalled(cwd, dir, lockRelPath, key, reviewedFiles, state) {
  const lockPath = path.join(dir, 'package-lock.json');
  const nodeModulesExists = fs.existsSync(path.join(dir, 'node_modules'));
  const recordedHash = state.installs?.[key];
  const currentHash = lockfileHash(lockPath);

  if (nodeModulesExists && recordedHash && recordedHash === currentHash) {
    return { installed: false };
  }

  await new Promise((resolve, reject) => {
    const logFile = path.join(LOG_DIR, `install-${key}.log`);
    const out = fs.openSync(logFile, 'a');
    const child = spawn(NPM_CMD, ['install'], { cwd: dir, shell: NPM_SHELL, stdio: ['ignore', out, out] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`npm install falhou em ${dir} (codigo ${code}) — veja ${logFile}`))));
  });

  // `npm install` pode reescrever o lockfile sem mudanca real de dependencia
  // — desfaz isso se nao fazia parte do diff revisado, senao o proximo
  // /validar bloquearia por sujeira que o proprio bridge causou.
  await revertUnintendedLockfileChange(cwd, lockRelPath, reviewedFiles);

  state.installs = state.installs || {};
  state.installs[key] = lockfileHash(lockPath);
  return { installed: true };
}

// Verifica se ha algo respondendo na porta e se pertence ao bridge (pid
// registrado em state ainda vivo). NUNCA mata/assume controle de um
// processo cujo pid nao foi registrado por este modulo.
async function checkPortOwnership(port, trackedPid) {
  const inUse = await isPortInUse(port);
  if (!inUse) return { inUse: false, ownedByBridge: false };
  const ownedByBridge = isAlive(trackedPid);
  return { inUse: true, ownedByBridge };
}

function waitPortFree(port, timeoutMs = 5000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (async function poll() {
      if (!(await isPortInUse(port))) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`porta ${port} continuou ocupada apos encerrar o processo do bridge`));
        return;
      }
      setTimeout(poll, 300);
    })();
  });
}

async function startServer(dir, port, extraArgs, logName) {
  const logFile = path.join(LOG_DIR, `${logName}.log`);
  const out = fs.openSync(logFile, 'a');
  // extraArgs vai depois de `--` pro npm repassar direto ao script
  // subjacente (ex: vite --port 5173 --strictPort) sem interpretar como
  // flags do proprio npm.
  //
  // SEM detached:true de proposito (mudanca desta correcao): no Windows,
  // cmd.exe/npm.cmd (spawn com shell:true, unico jeito de rodar um shim
  // .cmd) combinado com detached:true nao propaga o handle de stdio pro
  // processo neto (o node.exe real por baixo de npm.cmd) — confirmado
  // isolando o problema: sem detached, o log captura tudo e a deteccao de
  // "processo morreu" funciona corretamente; com detached, o log fica vazio
  // e a checagem de vida fica nao confiavel, exatamente a causa raiz do bug
  // relatado (readiness que nao refletia a realidade). Contrapartida aceita:
  // esses processos param se o bridge reiniciar — melhor do que reportar
  // sucesso indevido. /validar de novo sobe tudo normalmente.
  const args = extraArgs?.length ? ['run', 'dev', '--', ...extraArgs] : ['run', 'dev'];
  const child = spawn(NPM_CMD, args, { cwd: dir, shell: NPM_SHELL, stdio: ['ignore', out, out] });
  // unref (nao detached): so evita que ESTES filhos, sozinhos, segurem o
  // event loop do bridge aberto — o bridge ja fica vivo pelo proprio polling
  // do Telegram. Nao muda o fato de que os filhos param se o bridge for
  // encerrado (ver nota acima).
  child.unref();
  return { pid: child.pid, port, startedAt: new Date().toISOString(), logFile };
}

// Inicia/substitui (se necessario) o backend do UserPulse-validation, e SO
// retorna sucesso depois de confirmar readiness real (nunca so o pid
// criado). Nunca roda o orquestrador de raiz (`npm run dev` na raiz, que
// sobe docker/db/migrate/seed) — Postgres e um recurso compartilhado com
// nome/porta fixos no docker-compose.yml (userpulse-postgres:5432), entao o
// bridge assume que ja esta rodando e so sobe o processo de aplicacao.
//
// Backend usa SEMPRE a porta fixa 3333 (nao tem fallback proprio, ao
// contrario do Vite — um Express que nao consegue bindar so quebra). Porta
// ocupada por processo QUE NAO E do bridge: bloqueia (ValidationError) —
// nunca tenta outra porta, nunca mata. Porta ocupada por processo DO
// bridge: se a branch/commit nao mudou e ele ainda responde, mantem;
// senao substitui (mata a arvore antiga via killTreeByPid, so entao sobe um
// processo novo). .env local e obrigatorio (reaproveitado do UserPulse-agent
// quando ausente) — sem ele em nenhum dos dois lados, bloqueia dizendo
// exatamente o que falta, sem nem tentar subir o processo.
async function ensureBackendRunning(state, branchChanged) {
  const dir = path.join(config.validationPath, 'server');
  const agentDir = path.join(config.userpulsePath, 'server');
  const url = `http://localhost:${BACKEND_PORT}${BACKEND_HEALTH_PATH}`;
  const tracked = state.backend;
  const check = await checkPortOwnership(BACKEND_PORT, tracked?.pid);

  if (check.inUse && !check.ownedByBridge) {
    throw new ValidationError(
      `Porta ${BACKEND_PORT} ja esta em uso por um processo externo (nao iniciado pelo bridge). Nao vou tentar outra porta nem matar nada — libere a porta manualmente ou identifique o que esta rodando ali antes de tentar de novo.`
    );
  }

  if (check.inUse && check.ownedByBridge && !branchChanged) {
    if (await httpProbeOnce(url)) {
      return { status: 'already_running', pid: tracked.pid, port: BACKEND_PORT };
    }
    // Rodando mas parou de responder: nao confia, substitui como se tivesse mudado.
  }

  if (check.inUse && check.ownedByBridge) {
    killTreeByPid(tracked.pid);
    delete state.backend;
    await waitPortFree(BACKEND_PORT);
  }

  const envResult = ensureEnvFile(dir, agentDir);
  if (!envResult.present) {
    const rel = path.relative(config.validationPath, path.join(dir, '.env'));
    throw new ValidationError(
      `Configuracao local ausente: ${rel} nao existe nem em UserPulse-validation nem em UserPulse-agent. Copie o .env necessario manualmente (arquivo nunca versionado) antes de usar /validar.`
    );
  }

  const child = await startServer(dir, BACKEND_PORT, [], 'backend');
  const readiness = await waitForReady(child.pid, url);
  if (!readiness.ready) {
    const causeLabel = readiness.cause === 'process_died' ? 'o processo encerrou durante o startup' : 'nao respondeu a tempo';
    if (isAlive(child.pid)) killTreeByPid(child.pid);
    throw new ValidationError(
      `Backend nao ficou pronto na porta ${BACKEND_PORT}: ${causeLabel}. Ultimas linhas do log:\n${readLogTail(child.logFile)}`
    );
  }

  state.backend = child;
  return { status: 'started', pid: child.pid, port: BACKEND_PORT };
}

// Inicia/substitui (se necessario) o frontend. Diferente do backend: tenta
// a porta preferida (5173) mas SEM --strictPort — se estiver ocupada,
// deixa o Vite cair pro fallback normal dele (5174, 5175...). A porta real
// so e conhecida depois, lida do proprio banner de startup do Vite (ver
// waitForViteReady/extractVitePortFromLog), nunca assumida como 5173.
//
// NUNCA bloqueia nem mata por causa de outro processo ocupando 5173 — so o
// processo QUE O PROPRIO BRIDGE controla (rastreado em state.frontend) e
// substituido, e so quando a branch/commit muda ou ele parou de responder.
async function ensureFrontendRunning(state, branchChanged) {
  const dir = path.join(config.validationPath, 'web');
  const agentDir = path.join(config.userpulsePath, 'web');
  const tracked = state.frontend;

  if (tracked?.pid && isAlive(tracked.pid) && !branchChanged) {
    if (tracked.port && (await httpProbeOnce(`http://localhost:${tracked.port}/`))) {
      return { status: 'already_running', pid: tracked.pid, port: tracked.port };
    }
    // Rodando mas parou de responder na porta conhecida: nao confia, substitui.
  }

  if (tracked?.pid && isAlive(tracked.pid)) {
    killTreeByPid(tracked.pid);
    delete state.frontend;
    // Best-effort: espera a porta QUE ELE USAVA liberar, mas nao trava a
    // validacao inteira por isso — o Vite novo escolhe outra porta livre
    // sozinho se essa continuar ocupada por qualquer motivo.
    if (tracked.port) {
      await waitPortFree(tracked.port).catch(() => {});
    }
  }

  ensureEnvFile(dir, agentDir); // best-effort: web nao exige .env hoje, nunca bloqueia por causa dele

  const child = await startServer(dir, FRONTEND_PORT, ['--port', String(FRONTEND_PORT)], 'frontend');
  const readiness = await waitForViteReady(child.pid, child.logFile);
  if (!readiness.ready) {
    const causeLabel =
      readiness.cause === 'process_died' ? 'o processo encerrou durante o startup' : 'nao respondeu a tempo (ou nao anunciou a porta no log)';
    if (isAlive(child.pid)) killTreeByPid(child.pid);
    throw new ValidationError(`Frontend nao ficou pronto: ${causeLabel}. Ultimas linhas do log:\n${readLogTail(child.logFile)}`);
  }

  state.frontend = { ...child, port: readiness.port };
  return { status: 'started', pid: state.frontend.pid, port: state.frontend.port };
}

// Sobe backend e frontend nessa ordem. Se qualquer um dos dois falhar
// (porta externa no backend, .env ausente, ou nao ficar pronto), encerra
// imediatamente qualquer processo que ESTA chamada tenha iniciado com
// sucesso ate ali — nunca deixa o outro lado orfao rodando sozinho — e
// propaga o erro (nunca marca validation como pronta).
async function ensureServersRunning(state, { branchChanged }) {
  const startedThisRun = [];
  try {
    const backend = await ensureBackendRunning(state, branchChanged);
    if (backend.status === 'started') startedThisRun.push('backend');

    const frontend = await ensureFrontendRunning(state, branchChanged);
    if (frontend.status === 'started') startedThisRun.push('frontend');

    return { backend, frontend };
  } catch (e) {
    for (const role of startedThisRun) {
      if (state[role]?.pid && isAlive(state[role].pid)) killTreeByPid(state[role].pid);
      delete state[role];
    }
    throw e;
  }
}

// Fluxo completo de /validar. Lanca ValidationError (mensagem segura pra
// mostrar ao usuario) em qualquer precondicao/bloqueio; nunca faz commit,
// push, merge, rebase, reset ou clean em nenhum workspace.
export async function runValidar(task) {
  if (task.reviewGate !== 'READY') {
    throw new ValidationError(
      `reviewGate atual e ${task.reviewGate || '(nenhum)'}, nao READY. /validar exige uma revisao READY do Mentor (use /revisar).`
    );
  }
  if (!task.gitBranch) {
    throw new ValidationError('Tarefa sem branch associada — nada para validar.');
  }
  if (!task.reviewFingerprint || !task.reviewedFiles || task.reviewedFiles.length === 0) {
    throw new ValidationError('Sem fingerprint/lista de arquivos revisados validos para esta tarefa. Rode /revisar novamente.');
  }

  const { created } = await ensureValidationWorkspace();
  const cwd = config.validationPath;

  const previousState = loadValidationState();
  if (!created && previousState?.overlaidFiles?.length) {
    await revertPreviousOverlay(cwd, previousState.overlaidFiles);
  }

  const dirty = await hasLocalChangesAt(cwd);
  if (dirty) {
    throw new ValidationError(
      `Workspace de validacao (${cwd}) tem alteracoes nao esperadas pelo bridge:\n${dirty}\n\nO bridge nunca reseta/limpa automaticamente — resolva manualmente (o workspace e exclusivo do bridge, nao deveria ter sido tocado por fora) antes de tentar de novo.`
    );
  }

  const { sha, base, onOrigin } = await ensureBranchCheckedOut(cwd, task.gitBranch);
  const overlaidFiles = overlayReviewedFiles(task.reviewedFiles);

  // O workspace de validacao (e os processos rodando nele) persistem entre
  // tarefas — so o conteudo/branch mudam. Por isso a base do state e sempre
  // o que ja existia, nunca reiniciada so porque a tarefa mudou.
  const branchChanged = previousState?.branch !== task.gitBranch || previousState?.baseSha !== sha;
  const state = previousState || {};
  state.taskId = task.id;
  state.branch = task.gitBranch;
  state.baseSha = sha;
  state.base = base;
  state.overlaidFiles = overlaidFiles;
  state.reviewFingerprint = task.reviewFingerprint;

  await ensureDepsInstalled(cwd, path.join(cwd, 'server'), 'server/package-lock.json', 'server', task.reviewedFiles, state);
  await ensureDepsInstalled(cwd, path.join(cwd, 'web'), 'web/package-lock.json', 'web', task.reviewedFiles, state);

  // Persiste o progresso do git/overlay (real, ja aconteceu) mesmo se os
  // servidores falharem depois — mas backend/frontend so ficam gravados em
  // `state` quando ensureServerRole confirma readiness (rollback automatico
  // em falha parcial, ver ensureServersRunning). Por isso salvar aqui nunca
  // marca validation como pronta indevidamente.
  let servers;
  try {
    servers = await ensureServersRunning(state, { branchChanged });
  } finally {
    saveValidationState(state);
  }

  return {
    created,
    branch: task.gitBranch,
    sha,
    base,
    onOrigin,
    overlaidFiles,
    servers,
    // Porta real do frontend (pode nao ser 5173, se caiu no fallback do
    // Vite) — nunca a constante fixa. servers.frontend so existe aqui
    // quando ensureServersRunning retornou sem lancar, ou seja, ja
    // confirmado pronto na porta que ele mesmo descobriu.
    url: `http://localhost:${servers.frontend.port}/`,
    backendUrl: BACKEND_URL,
  };
}

// Snapshot pronto pro /status: null se /validar nunca rodou nesta maquina.
// Faz uma sonda HTTP real (rapida, timeout curto) em cada porta — nunca
// confia so no pid vivo, porque o processo pode estar travado/reiniciando
// sem ter morrido. A porta do frontend e a que foi descoberta e persistida
// da ultima vez que ele ficou pronto (state.frontend.port) — nunca a
// constante fixa 5173, que pode nao ser a porta real em uso.
export async function getValidationSummary() {
  const state = loadValidationState();
  if (!state || !config.validationPath) return null;

  const backendAlive = isAlive(state.backend?.pid);
  const frontendAlive = isAlive(state.frontend?.pid);
  const frontendPort = state.frontend?.port;
  const backendReady = backendAlive && (await httpProbeOnce(`${BACKEND_URL}${BACKEND_HEALTH_PATH}`, 800));
  const frontendReady = frontendAlive && frontendPort && (await httpProbeOnce(`http://localhost:${frontendPort}/`, 800));
  const ready = Boolean(backendReady && frontendReady);

  return {
    ready,
    taskId: state.taskId,
    branch: state.branch,
    sha: state.baseSha,
    url: frontendReady ? `http://localhost:${frontendPort}/` : null,
    backend: backendReady ? { pid: state.backend.pid, port: BACKEND_PORT } : null,
    frontend: frontendReady ? { pid: state.frontend.pid, port: frontendPort } : null,
    backendRunning: backendAlive,
    frontendRunning: frontendAlive,
    updatedAt: state.updatedAt,
  };
}
