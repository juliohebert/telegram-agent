// Telemetria em memoria da execucao ativa (Mentor/Dev/Revisao), para
// /status e alertas de consumo de tokens. So metricas — nunca conteudo de
// prompt/resposta. Vive apenas na memoria do processo (sem persistencia):
// reinicia junto com o bridge, o que e aceitavel porque so descreve uma
// execucao EM ANDAMENTO; metricas finais de execucoes concluidas ficam na
// task (mentorMetrics/devMetrics/reviewMetrics, ver taskManager.js).
//
// Uma unica execucao ativa por vez: o bridge ja serializa Mentor/Dev/Revisao
// via busy lock (bot.js), entao um unico slot em memoria e suficiente.

let current = null;

export function startExecution(role) {
  current = {
    role, // 'MENTOR' | 'DEV' | 'REVIEW'
    phase: null,
    startedAt: Date.now(),
    lastActivity: null,
    // activeTokens = input+output SOMENTE. cacheCreation e cacheRead ficam
    // FORA de proposito: crescem com o tamanho do contexto (sessao/diffs),
    // nao com o trabalho novo desta execucao — nunca devem inflar o
    // contador mostrado no Telegram nem disparar WARNING/HIGH/CRITICAL
    // (ver taskManager.js: createDevPhaseTracker/checkAlert).
    tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, activeTokens: 0 },
    alertLevel: null, // maior alerta ja emitido nesta execucao: null|'WARNING'|'HIGH'|'CRITICAL'
  };
  return current;
}

export function updateExecution(patch) {
  if (!current) return null;
  current = { ...current, ...patch };
  return current;
}

// Snapshot com elapsedMs calculado no momento da leitura (nao armazenado,
// para nunca ficar desatualizado entre atualizacoes).
export function getExecution() {
  if (!current) return null;
  return { ...current, elapsedMs: Date.now() - current.startedAt };
}

export function endExecution() {
  current = null;
}

export function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.round((ms || 0) / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function formatTokens(n) {
  return Number(n || 0).toLocaleString('pt-BR');
}
