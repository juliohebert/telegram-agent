import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const currentFile = path.join(config.stateDir, 'current.json');
const historyDir = path.join(config.stateDir, 'tasks');

export const STATES = Object.freeze({
  NOVA: 'NOVA',
  ANALISE_MENTOR: 'ANALISE_MENTOR',
  AGUARDANDO_IMPLEMENTACAO: 'AGUARDANDO_IMPLEMENTACAO',
  DEV_IMPLEMENTANDO: 'DEV_IMPLEMENTANDO',
  REVISAO_MENTOR: 'REVISAO_MENTOR',
  AGUARDANDO_VALIDACAO: 'AGUARDANDO_VALIDACAO',
  APROVADA: 'APROVADA',
  CANCELADA: 'CANCELADA',
});

function ensureDirs() {
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.mkdirSync(historyDir, { recursive: true });
}

function newTaskId() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `t-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function loadCurrentTask() {
  ensureDirs();
  if (!fs.existsSync(currentFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(currentFile, 'utf8'));
  } catch {
    return null;
  }
}

export function saveCurrentTask(task) {
  ensureDirs();
  task.updatedAt = new Date().toISOString();
  fs.writeFileSync(currentFile, JSON.stringify(task, null, 2), 'utf8');
  fs.writeFileSync(path.join(historyDir, `${task.id}.json`), JSON.stringify(task, null, 2), 'utf8');
  return task;
}

export function createTask(request) {
  const task = {
    id: newTaskId(),
    request: request || null,
    state: STATES.NOVA,
    mentorSessionId: null,
    mentorPromptVersion: null,
    devSessionId: null,
    lastMentorAnalysis: null,
    mentorMetrics: null,
    devMetrics: null,
    reviewMetrics: null,
    riskLevel: null,
    devInstruction: null,
    branchType: null,
    branchSlug: null,
    devReport: null,
    lastReview: null,
    reviewComplete: null,
    reviewGate: null,
    reviewGateReason: null,
    reviewNextAction: null,
    pendingFixInstruction: null,
    reviewFingerprint: null,
    reviewedFiles: null,
    gitBranch: null,
    baseSha: null,
    localCommitSha: null,
    commitMessage: null,
    prTitle: null,
    prBody: null,
    prUrl: null,
    prNumber: null,
    approvedCommitSha: null,
    approvedAt: null,
    reopenHistory: null,
    reopenPendingReview: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  return saveCurrentTask(task);
}

export function isTaskActive(task) {
  if (!task) return false;
  return task.state !== STATES.CANCELADA && task.state !== STATES.APROVADA;
}

// Lista tarefas persistidas em state/tasks/, mais recente primeiro (por
// updatedAt, com fallback pra createdAt em registros antigos que nao tenham
// um dos dois). Nunca migra/reescreve nada — so leitura. Arquivo corrompido/
// ilegivel e ignorado silenciosamente (nao trava a listagem inteira por
// causa de um registro ruim).
export function listTasks(limit = 10) {
  ensureDirs();
  const files = fs.readdirSync(historyDir).filter((f) => f.endsWith('.json'));
  const tasks = [];
  for (const file of files) {
    try {
      tasks.push(JSON.parse(fs.readFileSync(path.join(historyDir, file), 'utf8')));
    } catch {
      // registro corrompido/incompleto: ignora, nao interrompe a listagem
    }
  }
  tasks.sort((a, b) => {
    const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return tb - ta;
  });
  return tasks.slice(0, limit);
}

// /abrir <taskId>: torna uma tarefa ja existente (state/tasks/<id>.json) a
// tarefa atual (current.json), SEM tocar em nada mais — nunca escreve de
// volta no arquivo historico (ele ja tem o dado certo), nunca altera Git/
// working tree, nunca reseta reviewGate/state/fingerprint/branch. Os campos
// sao preservados exatamente como estao no arquivo (nem updatedAt e
// tocado). Retorna null se a tarefa nao existir.
export function openTask(taskId) {
  ensureDirs();
  const file = path.join(historyDir, `${taskId}.json`);
  if (!fs.existsSync(file)) return null;
  let task;
  try {
    task = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  fs.writeFileSync(currentFile, JSON.stringify(task, null, 2), 'utf8');
  return task;
}

export class ReopenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReopenError';
  }
}

// /reabrir <taskId>: reativa uma tarefa APROVADA pro ciclo de correcao —
// preserva taskId, branch, PR, historico e reviewGate/devInstruction/
// fingerprint anteriores EXATAMENTE como estavam (nada e apagado — servem
// de historico), mas marca `reopenPendingReview=true`: esses valores
// antigos eram de OUTRO ciclo (a aprovacao anterior) e nao valem pra
// autorizar /implementar neste novo ciclo. So uma revisao NOVA (/revisar)
// limpa essa flag (ver reviewSingleShot/reviewChunked/reviewWithMentor em
// taskManager.js) — e o gate de /implementar em bot.js que efetivamente
// bloqueia enquanto ela estiver true. Nunca cria tarefa nova, nunca toca
// Git/working tree (nao chama nada de git.js/taskManager.js aqui — so
// reescreve o proprio state), nunca reabre tarefa que nao esteja
// exatamente em APROVADA (CANCELADA e qualquer estado ja ativo sao
// tratados como incompativeis e lancam ReopenError sem alterar nada).
export function reopenTask(taskId) {
  ensureDirs();
  const file = path.join(historyDir, `${taskId}.json`);
  if (!fs.existsSync(file)) {
    throw new ReopenError(`Tarefa ${taskId} nao encontrada em state/tasks/.`);
  }
  let task;
  try {
    task = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new ReopenError(`Tarefa ${taskId} tem um registro corrompido/ilegivel — nao foi alterada.`);
  }

  if (task.state !== STATES.APROVADA) {
    const hint = isTaskActive(task)
      ? 'ela ja esta ativa — use /abrir so pra selecioná-la.'
      : 'estado nao compativel com /reabrir (so tarefas APROVADA podem ser reabertas).';
    throw new ReopenError(`Tarefa ${taskId} esta em estado ${task.state}, nao APROVADA — ${hint}`);
  }

  const fromState = task.state;
  task.state = STATES.AGUARDANDO_IMPLEMENTACAO;
  task.reopenPendingReview = true;
  task.reopenHistory = Array.isArray(task.reopenHistory) ? task.reopenHistory : [];
  task.reopenHistory.push({ at: new Date().toISOString(), fromState });

  return saveCurrentTask(task);
}
