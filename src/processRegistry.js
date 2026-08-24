import { execFile } from 'node:child_process';

export class CancelledError extends Error {
  constructor(message = 'Execucao cancelada pelo usuario.') {
    super(message);
    this.name = 'CancelledError';
  }
}

// Mata o processo e toda a sua arvore de filhos. child.kill() sozinho so
// atinge o processo direto (claude.exe); se ele tiver disparado subprocessos
// (ex: Bash rodando npm/tsc), eles ficariam orfaos rodando. No Windows,
// `taskkill /T /F` e a forma confiavel de matar a arvore inteira.
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
  } else {
    // melhor esforco fora do Windows (nao e a plataforma alvo deste bridge)
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* grupo pode nao existir se o processo nao foi criado detached */
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* processo pode ja ter encerrado */
    }
  }
}

// So existe uma chamada Claude ativa por vez (Mentor e Dev sao serializados
// pelo lock de negocio em bot.js), entao um unico slot e suficiente.
let activeHandle = null;

export function registerActive(child) {
  const handle = { child, cancelled: false };
  activeHandle = handle;
  return handle;
}

export function clearActive(handle) {
  if (activeHandle === handle) activeHandle = null;
}

export function hasActive() {
  return activeHandle !== null;
}

// Usado por /cancelar: mata fisicamente o processo Claude (e filhos) em
// execucao no momento, se houver. Retorna true se havia algo para matar.
export function cancelActive() {
  if (!activeHandle) return false;
  activeHandle.cancelled = true;
  killTree(activeHandle.child.pid);
  return true;
}

// Usado no timeout do claudeRunner: mata a arvore sem marcar como
// "cancelado pelo usuario" (e um erro de timeout, nao de cancelamento).
export function killTreeByPid(pid) {
  killTree(pid);
}
