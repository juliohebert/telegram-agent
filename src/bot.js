import fs from 'node:fs';
import { config } from './config.js';
import { getUpdates, sendMessage, PREFIX } from './telegram.js';
import {
  loadCurrentTask,
  createTask,
  saveCurrentTask,
  STATES,
  isTaskActive,
  listTasks,
  openTask,
  reopenTask,
  ReopenError,
} from './state.js';
import {
  consultMentor,
  runDev,
  reviewWithMentor,
  prepareTaskBranch,
  verifyOnTaskBranch,
  BranchPrepError,
  approveTask,
  ApproveError,
} from './taskManager.js';
import { gitStatusShort, getCurrentBranch } from './git.js';
import { getMentorPromptVersion } from './prompts.js';
import { getExecution, formatElapsed, formatTokens } from './execution.js';
import { runValidar, getValidationSummary, ValidationError } from './validation.js';
import { cancelActive, hasActive, CancelledError } from './processRegistry.js';
import { downloadTelegramAudio, transcribeAudioFile, cleanupFile } from './transcribe.js';

let busy = false;

function isAuthorized(msg) {
  return (
    msg?.chat?.id !== undefined &&
    msg?.from?.id !== undefined &&
    String(msg.chat.id) === config.allowedChatId &&
    String(msg.from.id) === config.allowedUserId
  );
}

function stillActive(taskId) {
  const onDisk = loadCurrentTask();
  return onDisk && onDisk.id === taskId && onDisk.state !== STATES.CANCELADA;
}

async function withBusyLock(chatId, fn) {
  if (busy) {
    await sendMessage(
      chatId,
      'Ainda processando a solicitacao anterior. Aguarde a resposta (use /status para acompanhar, ou /cancelar para interromper a execucao atual — a tarefa continua ativa).',
      PREFIX.SYSTEM
    );
    return;
  }
  busy = true;
  try {
    await fn();
  } catch (e) {
    if (e instanceof CancelledError) {
      // /cancelar ja mandou a confirmacao para o usuario; nada mais a fazer.
      console.log('Processamento interrompido por cancelamento do usuario.');
      return;
    }
    console.error('Erro ao processar:', e.message);
    await sendMessage(chatId, `Erro: ${e.message}`, PREFIX.SYSTEM);
  } finally {
    busy = false;
  }
}

async function runMentorTurn(chatId, task, text) {
  const result = await consultMentor(task, text);
  if (!stillActive(task.id)) {
    await sendMessage(
      chatId,
      `(tarefa ${task.id} foi cancelada durante o processamento; resposta do Mentor descartada)`,
      PREFIX.SYSTEM
    );
    return;
  }
  if (result.resumeFailed) {
    await sendMessage(chatId, '(sessao anterior do Mentor nao pode ser retomada; iniciando nova sessao)', PREFIX.SYSTEM);
  }
  await sendMessage(chatId, result.text, PREFIX.MENTOR);
}

async function runReviewAndSend(chatId, task) {
  let reviewResult;
  try {
    reviewResult = await reviewWithMentor(task);
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    await sendMessage(chatId, `Erro na revisao: ${e.message}`, PREFIX.SYSTEM);
    return;
  }
  if (!stillActive(task.id)) {
    await sendMessage(
      chatId,
      `(tarefa ${task.id} foi cancelada durante o processamento; revisao descartada)`,
      PREFIX.SYSTEM
    );
    return;
  }
  if (reviewResult.resumeFailed) {
    await sendMessage(chatId, '(sessao anterior do Mentor nao pode ser retomada; iniciando nova sessao)', PREFIX.SYSTEM);
  }
  const chunkNote = reviewResult.chunked
    ? `(diff dividido em ${reviewResult.totalChunks} parte(s) por exceder MAX_DIFF_CHARS, revisao completa)\n\n`
    : '';
  await sendMessage(chatId, `${chunkNote}${reviewResult.text}`, PREFIX.REVIEW);
}

// Politica de notificacao da telemetria do Dev (ver runDev/
// createDevPhaseTracker em taskManager.js): mudanca de fase NUNCA gera
// mensagem (fica so no /status, via src/execution.js) — so 3 eventos
// chegam ate o Telegram: alerta HIGH, alerta CRITICAL (cada um no maximo 1x
// por execucao, ja garantido pelo edge-trigger em checkAlert) e a conclusao
// (resumo curto). O inicio da execucao ja e coberto pela mensagem "Enviando
// tarefa ao Dev..." que cmdImplementar manda antes de chamar runDev — sem
// duplicar aqui. Erros de envio nao devem derrubar a execucao do Dev (o
// callback e fire-and-forget). "Tokens ativos" = activeTokens
// (input+output SOMENTE) — nunca inclui cacheCreation/cacheRead, que sao
// sempre mostrados a parte ("Cache criado"/"Cache reutilizado") e nunca
// contam pros alertas (cache grande sozinho nao dispara HIGH/CRITICAL).
async function handleDevExecutionUpdate(chatId, task, update) {
  try {
    const { type, level, snapshot, metrics } = update;
    if (type === 'phase') return; // silenciado por design — ver /status

    if (type === 'alert') {
      const limit = level === 'CRITICAL' ? config.devTokenCritical : config.devTokenHigh;
      const lines = [
        level === 'CRITICAL' ? '🔴 Consumo de tokens CRITICO' : '⚠️ Consumo de tokens ALTO',
        `Fase: ${snapshot.phase || '(iniciando)'}`,
        `Tempo: ${formatElapsed(snapshot.elapsedMs)}`,
        `Tokens ativos: ${formatTokens(snapshot.tokens.activeTokens)} (limite ${level}: ${formatTokens(limit)})`,
        `Cache criado: ${formatTokens(snapshot.tokens.cacheCreation)}`,
        `Cache reutilizado: ${formatTokens(snapshot.tokens.cacheRead)}`,
      ];
      if (task.riskLevel === 'BAIXO') {
        lines.push('Risco da tarefa: BAIXO — consumo parece alto para o risco esperado.');
      }
      if (level === 'CRITICAL') {
        lines.push('Execucao NAO sera cancelada automaticamente. Acompanhe ou use /cancelar se achar necessario.');
      }
      await sendMessage(chatId, lines.join('\n'), PREFIX.DEV);
      return;
    }

    if (type === 'complete') {
      await sendMessage(
        chatId,
        [
          `Tempo total: ${formatElapsed(metrics.elapsedMs)}`,
          `Tokens ativos: ${formatTokens(metrics.activeTokens)}`,
          `Cache criado: ${formatTokens(metrics.cacheCreationTokens)}`,
          `Cache reutilizado: ${formatTokens(metrics.cacheReadTokens)}`,
        ].join('\n'),
        PREFIX.DEV
      );
    }
  } catch (e) {
    console.error(`Falha ao enviar atualizacao de telemetria do Dev: ${e.message}`);
  }
}

async function cmdNovo(chatId, argText) {
  const current = loadCurrentTask();
  if (isTaskActive(current) && current.state !== STATES.AGUARDANDO_VALIDACAO) {
    await sendMessage(
      chatId,
      `Ja existe uma tarefa em andamento (${current.id}, estado ${current.state}). Use /encerrar para encerrar definitivamente ou /status para ver detalhes.`,
      PREFIX.SYSTEM
    );
    return;
  }
  const task = createTask(argText || null);
  if (argText) {
    await sendMessage(chatId, `Tarefa ${task.id} criada. Consultando o Mentor...`, PREFIX.SYSTEM);
    await runMentorTurn(chatId, task, argText);
  } else {
    await sendMessage(chatId, `Tarefa ${task.id} criada. Descreva o que precisa ser feito.`, PREFIX.SYSTEM);
  }
}

async function cmdImplementar(chatId) {
  const task = loadCurrentTask();
  if (!task) {
    await sendMessage(chatId, 'Nenhuma tarefa selecionada. Use /novo ou /abrir <taskId>.', PREFIX.SYSTEM);
    return;
  }
  if (!isTaskActive(task)) {
    // Bloqueio intencional (nao ha reabertura automatica de desenvolvimento
    // pra tarefa terminal ainda): so informa, sem tentar nenhuma acao.
    await sendMessage(
      chatId,
      `Tarefa ${task.id} esta em estado terminal (${task.state}) — /implementar nao esta disponivel para tarefas aprovadas/canceladas.`,
      PREFIX.SYSTEM
    );
    return;
  }
  if (!task.lastMentorAnalysis) {
    await sendMessage(
      chatId,
      'Ainda nao ha analise do Mentor para esta tarefa. Descreva a tarefa antes de /implementar.',
      PREFIX.SYSTEM
    );
    return;
  }

  // Tarefa reaberta (/reabrir, ver state.js): reviewGate/devInstruction da
  // aprovacao ANTERIOR ficam preservados so como historico — nao autorizam
  // /implementar neste ciclo novo. So uma revisao que de fato consulte o
  // Mentor (/revisar chamando reviewSingleShot/reviewChunked) limpa esse
  // sinalizador, independente do veredito que ela devolver.
  if (task.reopenPendingReview) {
    await sendMessage(
      chatId,
      'Tarefa reaberta ainda sem uma nova revisao do Mentor neste ciclo — o reviewGate/instrucao da aprovacao anterior nao valem mais. Use /revisar antes de /implementar.',
      PREFIX.SYSTEM
    );
    return;
  }

  // Fail-safe de handoff: em CHANGES_REQUIRED, so libera o Dev se a revisao
  // ATUAL de fato produziu uma instrucao de correcao (task.pendingFixInstruction
  // === false). pendingFixInstruction ausente/true (inclui tarefas antigas,
  // de antes desse campo existir) bloqueia por seguranca — nunca reenvia
  // task.devInstruction achando que e a correcao desta revisao. Use /revisar
  // para o Mentor gerar/recuperar a instrucao antes de tentar de novo.
  if (task.reviewGate === 'CHANGES_REQUIRED' && task.pendingFixInstruction !== false) {
    await sendMessage(
      chatId,
      'Handoff de correcao pendente: a revisao mais recente (CHANGES_REQUIRED) nao tem uma instrucao de correcao valida associada a ela. Use /revisar para o Mentor gerar/recuperar a instrucao antes de /implementar.',
      PREFIX.SYSTEM
    );
    return;
  }

  // Preparo de branch (V2): so roda a preparacao completa uma vez por
  // tarefa, na primeira vez que /implementar e chamado. Em chamadas
  // seguintes (ex: Dev corrigindo algo apontado pelo Mentor), a branch ja
  // existe — mas isso NAO e pulado cegamente: confirmamos que o workspace
  // esta de fato na branch da tarefa antes de deixar o Dev continuar. Se
  // alguem trocou de branch manualmente nesse meio tempo, bloqueia (o
  // bridge nunca troca de branch sozinho fora do preparo inicial).
  if (!task.gitBranch) {
    await sendMessage(chatId, 'Preparando branch exclusiva para a tarefa...', PREFIX.SYSTEM);
    let branchName;
    try {
      branchName = await prepareTaskBranch(task);
    } catch (e) {
      if (e instanceof BranchPrepError) {
        await sendMessage(chatId, `Preparo de branch bloqueado: ${e.message}`, PREFIX.SYSTEM);
        return;
      }
      throw e;
    }
    task.gitBranch = branchName;
    saveCurrentTask(task);
    await sendMessage(chatId, `Branch ${branchName} criada a partir de origin/main. Iniciando o Dev...`, PREFIX.SYSTEM);
  } else {
    try {
      await verifyOnTaskBranch(task);
    } catch (e) {
      if (e instanceof BranchPrepError) {
        await sendMessage(chatId, `Bloqueado: ${e.message}`, PREFIX.SYSTEM);
        return;
      }
      throw e;
    }
  }

  await sendMessage(chatId, 'Enviando tarefa ao Dev para implementacao...', PREFIX.SYSTEM);
  let devResult;
  try {
    devResult = await runDev(task, { onUpdate: (update) => handleDevExecutionUpdate(chatId, task, update) });
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    task.state = STATES.AGUARDANDO_IMPLEMENTACAO;
    saveCurrentTask(task);
    await sendMessage(chatId, `Erro na implementacao: ${e.message}`, PREFIX.SYSTEM);
    return;
  }
  if (!stillActive(task.id)) {
    await sendMessage(
      chatId,
      `(tarefa ${task.id} foi cancelada durante a implementacao; relatorio descartado)`,
      PREFIX.SYSTEM
    );
    return;
  }
  if (devResult.resumeFailed) {
    await sendMessage(chatId, '(sessao anterior do Dev nao pode ser retomada; iniciando nova sessao)', PREFIX.SYSTEM);
  }
  await sendMessage(chatId, devResult.text, PREFIX.DEV);

  await sendMessage(chatId, 'Coletando diff e enviando ao Mentor para revisao...', PREFIX.SYSTEM);
  await runReviewAndSend(chatId, task);
}

async function cmdRevisar(chatId) {
  const task = loadCurrentTask();
  if (!isTaskActive(task)) {
    await sendMessage(chatId, 'Nenhuma tarefa ativa.', PREFIX.SYSTEM);
    return;
  }
  await sendMessage(chatId, 'Coletando diff atual e solicitando revisao ao Mentor...', PREFIX.SYSTEM);
  await runReviewAndSend(chatId, task);
}

// Trunca a solicitacao pra caber numa linha da listagem, sem cortar no meio
// de uma palavra quando da pra evitar.
function summarizeRequest(request, maxLen = 72) {
  if (!request) return '(solicitacao nao definida)';
  const oneLine = request.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  const cut = oneLine.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

// /tarefas: lista as tarefas persistidas em state/tasks/, mais recente
// primeiro. So leitura — nunca muda current.json nem nenhum arquivo.
async function cmdTarefas(chatId) {
  const tasks = listTasks(10);
  if (tasks.length === 0) {
    await sendMessage(chatId, 'Nenhuma tarefa registrada ainda. Use /novo para comecar.', PREFIX.SYSTEM);
    return;
  }

  const current = loadCurrentTask();
  const blocks = tasks.map((task, i) => {
    const marker = current?.id === task.id ? ' (selecionada)' : '';
    const lines = [`${i + 1}. ${task.id} — ${task.state}${marker}`, `   ${summarizeRequest(task.request)}`];
    const details = [];
    if (task.gitBranch) details.push(`Branch: ${task.gitBranch}`);
    if (task.reviewGate) details.push(`Gate: ${task.reviewGate}`);
    if (details.length) lines.push(`   ${details.join(' · ')}`);
    if (task.prUrl) lines.push(`   PR: ${task.prNumber ? `#${task.prNumber}` : task.prUrl}`);
    return lines.join('\n');
  });

  await sendMessage(
    chatId,
    [`Tarefas recentes (${tasks.length}):`, '', blocks.join('\n\n'), '', 'Para selecionar: /abrir <taskId>'].join('\n'),
    PREFIX.SYSTEM
  );
}

// /abrir <taskId>: torna uma tarefa existente a tarefa atual. Nunca toca
// Git/working tree (so LE a branch atual pra comparar e avisar); nunca
// reativa estado de tarefa terminal; preserva todos os campos exatamente
// como estavam salvos em state/tasks/<taskId>.json.
async function cmdAbrir(chatId, argText) {
  const taskId = (argText || '').trim().split(/\s+/)[0];
  if (!taskId) {
    await sendMessage(chatId, 'Uso: /abrir <taskId>. Veja os ids disponiveis com /tarefas.', PREFIX.SYSTEM);
    return;
  }

  const task = openTask(taskId);
  if (!task) {
    await sendMessage(chatId, `Tarefa ${taskId} nao encontrada em state/tasks/. Veja os ids disponiveis com /tarefas.`, PREFIX.SYSTEM);
    return;
  }

  let currentBranch = null;
  try {
    currentBranch = await getCurrentBranch();
  } catch (e) {
    console.error(`Falha ao ler branch atual do UserPulse-agent: ${e.message}`);
  }

  const lines = [
    `Tarefa ${task.id} selecionada.`,
    `Estado: ${task.state}`,
    `Solicitacao: ${task.request || '(nao definida)'}`,
    task.reviewGate ? `Gate de revisao: ${task.reviewGate}` : null,
    task.gitBranch ? `Branch da tarefa: ${task.gitBranch}` : '(tarefa sem branch)',
    currentBranch ? `Branch atual do workspace: ${currentBranch}` : null,
  ].filter(Boolean);

  if (task.gitBranch && currentBranch && task.gitBranch !== currentBranch) {
    lines.push('', 'Aviso: Tarefa aberta, mas o workspace esta em outra branch.');
  }
  if (!isTaskActive(task)) {
    const validarNote = task.reviewGate === 'READY' ? ' (pode usar /validar)' : '';
    lines.push('', `Tarefa terminal (${task.state}) — aberta so para consulta${validarNote}. /implementar nao esta disponivel.`);
  }

  await sendMessage(chatId, lines.join('\n'), PREFIX.SYSTEM);
}

// /reabrir <taskId>: reativa uma tarefa APROVADA pro ciclo de correcao
// (/revisar, /implementar voltam a funcionar). So mexe no state.json da
// tarefa (via reopenTask, em state.js) — nunca chama git.js/taskManager.js
// aqui, entao nunca faz checkout/fetch/pull/commit/push, nunca cria tarefa
// nova. Tarefa ja ativa ou CANCELADA e tratada como estado incompativel
// (reopenTask lanca ReopenError, nada e alterado).
async function cmdReabrir(chatId, argText) {
  const taskId = (argText || '').trim().split(/\s+/)[0];
  if (!taskId) {
    await sendMessage(chatId, 'Uso: /reabrir <taskId>. Veja os ids disponiveis com /tarefas.', PREFIX.SYSTEM);
    return;
  }

  let task;
  try {
    task = reopenTask(taskId);
  } catch (e) {
    if (e instanceof ReopenError) {
      await sendMessage(chatId, e.message, PREFIX.SYSTEM);
      return;
    }
    throw e;
  }

  const lines = [
    `Tarefa ${task.id} reaberta (estava APROVADA).`,
    `Estado: ${task.state}`,
    task.gitBranch ? `Branch preservada: ${task.gitBranch}` : '(tarefa sem branch)',
    task.prUrl ? `PR preservada: ${task.prNumber ? `#${task.prNumber}` : task.prUrl}` : null,
    task.reviewGate ? `Gate de revisao anterior preservado: ${task.reviewGate}` : null,
    '',
    'Descreva o novo problema/ajuste pro Mentor, ou use /revisar ou /implementar diretamente.',
  ].filter(Boolean);
  await sendMessage(chatId, lines.join('\n'), PREFIX.SYSTEM);
}

async function cmdStatus(chatId) {
  const task = loadCurrentTask();
  let statusText;
  try {
    statusText = await gitStatusShort();
  } catch (e) {
    statusText = `(erro ao obter git status: ${e.message})`;
  }
  if (!task) {
    await sendMessage(chatId, `Nenhuma tarefa registrada ainda.\n\ngit status --short:\n${statusText}`, PREFIX.SYSTEM);
    return;
  }
  const reviewNote =
    task.reviewComplete === false
      ? ' [REVISAO INCOMPLETA - nao considerar aprovado, use /revisar]'
      : '';
  const gateLine =
    task.reviewGate && task.reviewGate !== 'READY'
      ? [
          `Gate de revisao: ${task.reviewGate} — /aprovar bloqueado`,
          task.reviewGateReason ? `  Motivo: ${task.reviewGateReason}` : null,
          task.reviewNextAction ? `  Proximo passo: ${task.reviewNextAction}` : null,
        ].filter(Boolean).join('\n')
      : null;
  const fixReadyLine =
    task.reviewGate === 'CHANGES_REQUIRED'
      ? task.pendingFixInstruction === false
        ? 'Correcao tecnica pronta: sim'
        : 'Correcao tecnica pronta: nao — handoff pendente (use /revisar)'
      : null;
  // Snapshot curto e sempre visivel dos 3 gates que decidem /implementar e
  // /aprovar — util sobretudo apos /reabrir, pra ver reopenPendingReview
  // sem precisar adivinhar pelas linhas condicionais acima.
  const gateSnapshotLine = `Gates: reviewGate=${task.reviewGate || '(nenhum)'} · reopenPendingReview=${Boolean(task.reopenPendingReview)} · pendingFixInstruction=${task.pendingFixInstruction === null || task.pendingFixInstruction === undefined ? '(nenhum)' : task.pendingFixInstruction}`;
  const promptVersionNote =
    task.mentorPromptVersion && task.mentorPromptVersion !== getMentorPromptVersion()
      ? 'Aviso: sessao do Mentor foi iniciada com uma versao anterior de prompts/mentor.md — use /revisar para atualizar o contexto.'
      : null;

  // Execucao ativa (Mentor/Dev/Revisao em andamento): telemetria em tempo
  // real, ver src/execution.js. null quando ociosa.
  const activeExecution = getExecution();

  // Distingue tarefa ativa / execucao ativa / execucao interrompida / tarefa
  // encerrada. "Execucao ativa" usa hasActive() (processRegistry.js) como
  // fonte definitiva — cobre tambem chamadas sem role rastreado por
  // src/execution.js (ex: geracao de commit/PR dentro de /aprovar).
  // "Interrompida" e o caso de crash/reinicio do bridge sem passar por
  // /cancelar (que agora sempre limpa DEV_IMPLEMENTANDO/REVISAO_MENTOR antes
  // de terminar) — mesma deteccao usada em handleFreeText.
  const runningNow = Boolean(activeExecution) || hasActive();
  const executionInterrupted =
    !runningNow && (task.state === STATES.DEV_IMPLEMENTANDO || task.state === STATES.REVISAO_MENTOR);
  const situacaoLine = !isTaskActive(task)
    ? `Situacao: ENCERRADA (${task.state})`
    : runningNow
      ? `Situacao: ATIVA — execucao em andamento${activeExecution ? ` (${activeExecution.role}${activeExecution.phase ? `, fase ${activeExecution.phase}` : ''})` : ''}`
      : executionInterrupted
        ? `Situacao: ATIVA — execucao interrompida sem passar por /cancelar (estado ${task.state} sem processo rodando; use /revisar, /implementar ou /encerrar)`
        : 'Situacao: ATIVA — aguardando proxima acao';
  // Tokens ativos = activeTokens (input+output SOMENTE); cache criado/
  // reutilizado sempre a parte, nunca somados no contador principal nem nos
  // alertas (cache grande sozinho nao dispara HIGH/CRITICAL).
  const executionLines = activeExecution
    ? [
        `Execucao ativa: ${activeExecution.role}${activeExecution.phase ? ` — Fase: ${activeExecution.phase}` : ''}`,
        `  Tempo decorrido: ${formatElapsed(activeExecution.elapsedMs)}`,
        `  Tokens ativos: ${formatTokens(activeExecution.tokens.activeTokens)}`,
        `  Cache criado: ${formatTokens(activeExecution.tokens.cacheCreation)}`,
        `  Cache reutilizado: ${formatTokens(activeExecution.tokens.cacheRead)}`,
        activeExecution.lastActivity ? `  Ultima atividade: ${activeExecution.lastActivity}` : null,
        activeExecution.alertLevel ? `  Nivel de alerta: ${activeExecution.alertLevel}` : null,
      ].filter(Boolean)
    : [];

  // Metricas finais das execucoes ja concluidas desta tarefa. activeTokens
  // e recalculado aqui (nunca lido cru do campo persistido): tarefas
  // aprovadas/antigas podem ter sido salvas por uma versao anterior do
  // bridge, com outro nome de campo (ex: "newTokens") ou sem esse campo —
  // inputTokens/outputTokens sempre existiram e sao a fonte real, entao
  // recalcular na leitura evita mostrar "0" so por causa do nome do campo,
  // sem inventar nenhum numero novo (regra 1: activeTokens = input+output).
  const metricsLine = (label, m) => {
    if (!m) return null;
    const active = m.activeTokens ?? (m.inputTokens ?? 0) + (m.outputTokens ?? 0);
    return `${label}: ${formatElapsed(m.elapsedMs)}, tokens ativos ${formatTokens(active)}, cache criado ${formatTokens(m.cacheCreationTokens)}, cache reutilizado ${formatTokens(m.cacheReadTokens)}${m.finalPhase ? ` (fase final: ${m.finalPhase})` : ''}`;
  };
  const metricsLines = [
    metricsLine('Metricas Mentor', task.mentorMetrics),
    metricsLine('Metricas Dev', task.devMetrics),
    metricsLine('Metricas Revisao', task.reviewMetrics),
  ].filter(Boolean);

  // Workspace de validacao local (/validar, ver src/validation.js) — null
  // quando /validar nunca rodou nesta maquina. `ready` vem de uma sonda HTTP
  // real feita agora (nao so pid vivo) — PID/porta e URL so aparecem quando
  // aquele lado especifico esta de fato respondendo.
  const validationSummary = await getValidationSummary();
  const validationLines = validationSummary
    ? [
        'Validacao local:',
        `  Status: ${validationSummary.ready ? 'READY' : 'BLOCKED'}`,
        `  Branch: ${validationSummary.branch || '(nenhuma)'}`,
        `  Commit base: ${validationSummary.sha ? validationSummary.sha.slice(0, 8) : '(nenhum)'}`,
        `  Backend: ${validationSummary.backend ? `pid ${validationSummary.backend.pid} · porta ${validationSummary.backend.port}` : '(nao confirmado)'}`,
        `  Frontend: ${validationSummary.frontend ? `pid ${validationSummary.frontend.pid} · porta ${validationSummary.frontend.port}` : '(nao confirmado)'}`,
        ...(validationSummary.url ? [`  URL: ${validationSummary.url}`] : []),
      ]
    : ['Validacao local: nao preparada (use /validar)'];

  const lines = [
    `Tarefa: ${task.id}`,
    `Estado: ${task.state}${busy ? ' (processando...)' : ''}${reviewNote}`,
    situacaoLine,
    `Solicitacao: ${task.request || '(nao definida)'}`,
    `Risco: ${task.riskLevel || '(nao classificado)'}`,
    gateSnapshotLine,
    ...(fixReadyLine ? [fixReadyLine] : []),
    ...(gateLine ? [gateLine] : []),
    ...(promptVersionNote ? [promptVersionNote] : []),
    `Branch: ${task.gitBranch || '(ainda nao preparada)'}`,
    `Aprovacao: ${task.approvedCommitSha ? `commit ${task.approvedCommitSha.slice(0, 8)}` : '(nao aprovada)'}`,
    `PR: ${task.prUrl || '(nao criada)'}`,
    '',
    ...validationLines,
    ...(executionLines.length ? ['', ...executionLines] : []),
    ...(metricsLines.length ? ['', ...metricsLines] : []),
    `Atualizada em: ${task.updatedAt}`,
    '',
    'git status --short:',
    `\`\`\`\n${statusText}\n\`\`\``,
  ];
  await sendMessage(chatId, lines.join('\n'), PREFIX.SYSTEM);
}

// /aprovar: commita + publica a branch da tarefa + gera texto de PR. Nao usa
// o guard padrao isTaskActive() porque uma tarefa ja APROVADA (terminal, logo
// "inativa" nesse sentido) ainda precisa poder responder de forma idempotente
// mostrando o que ja foi aprovado — quem decide bloquear/permitir e o proprio
// approveTask (precondicoes + idempotencia).
async function cmdAprovar(chatId) {
  const task = loadCurrentTask();
  if (!task) {
    await sendMessage(chatId, 'Nenhuma tarefa registrada.', PREFIX.SYSTEM);
    return;
  }

  await sendMessage(chatId, 'Verificando pre-condicoes e preparando aprovacao...', PREFIX.SYSTEM);

  let result;
  try {
    result = await approveTask(task);
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    if (e instanceof ApproveError) {
      await sendMessage(chatId, `Aprovacao bloqueada: ${e.message}`, PREFIX.SYSTEM);
      return;
    }
    throw e;
  }

  // Destaque principal: titulo + link da PR, sempre nas 2 primeiras linhas.
  // Branch/commit/id da tarefa ficam como informacao secundaria, depois.
  if (result.alreadyApproved) {
    await sendMessage(
      chatId,
      [
        `**${result.prTitle}**`,
        result.prUrl,
        '',
        '(PR ja criada anteriormente — nada foi repetido)',
        '',
        `Commit: ${result.commitSha}`,
        `Branch: ${result.branch}`,
        `Tarefa: ${task.id}`,
        '',
        'Descricao da PR:',
        result.prBody,
      ].join('\n'),
      PREFIX.SYSTEM
    );
    return;
  }

  const statusLine = result.resumedPrOnly
    ? 'PR criada (commit/push ja estavam prontos de uma tentativa anterior).'
    : result.resumedPush
      ? 'Push retomado e PR criada (o commit ja existia de uma tentativa anterior).'
      : 'Aprovado: commitado, publicado e PR criada no origin.';

  const lines = [`**${result.prTitle}**`, result.prUrl, '', statusLine];
  if (result.prReused) {
    lines.push('(ja existia uma PR aberta para esta branch — reutilizada, nao duplicada)');
  }
  lines.push('', `Commit: ${result.commitSha}`, `Branch: ${result.branch}`, `Tarefa: ${task.id}`);
  if (result.divergence) {
    lines.push(`Em relacao a origin/main: ${result.divergence.ahead} commit(s) a frente, ${result.divergence.behind} atras.`);
  }
  if (result.parseFallbackUsed) {
    lines.push(
      '',
      '(aviso: a resposta do Mentor nao seguiu o formato esperado; titulo/descricao podem estar genericos — revise a PR)'
    );
  }
  lines.push('', 'Descricao da PR:', result.prBody);

  await sendMessage(chatId, lines.join('\n'), PREFIX.SYSTEM);
}

// /validar prepara o workspace dedicado (UserPulse-validation) pra refletir
// a branch/diff READY da tarefa em http://localhost:5173 — nunca e
// aprovacao (/aprovar continua o unico jeito de commitar/publicar/criar PR).
// Funciona tambem pra tarefa ja APROVADA (nao exige tarefa ativa): o que
// realmente importa e reviewGate=READY + reviewedFiles/fingerprint validos
// + gitBranch, que runValidar checa por conta propria — nunca precisa criar
// tarefa nova so pra revalidar algo ja aprovado/publicado.
async function cmdValidar(chatId) {
  const task = loadCurrentTask();
  if (!task) {
    await sendMessage(chatId, 'Nenhuma tarefa selecionada. Use /novo ou /abrir <taskId>.', PREFIX.SYSTEM);
    return;
  }

  await sendMessage(chatId, 'Preparando workspace de validacao local...', PREFIX.SYSTEM);

  let result;
  try {
    result = await runValidar(task);
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    if (e instanceof ValidationError) {
      await sendMessage(chatId, `Validacao bloqueada: ${e.message}`, PREFIX.SYSTEM);
      return;
    }
    throw e;
  }

  // Se chegou aqui, runValidar so retorna depois de confirmar readiness real
  // (sonda HTTP + processo vivo) dos dois lados — nunca so o pid criado.
  // Ver src/validation.js: ensureServerRole lanca ValidationError (tratado
  // no catch acima) em qualquer cenario de porta externa, .env ausente ou
  // processo que nao ficou pronto — nunca chega nesta mensagem de sucesso
  // nesses casos.
  const lines = [
    result.created ? `Workspace de validacao criado (clone novo do origin).` : 'Workspace de validacao ja existia — verificado.',
    `Branch: ${result.branch}${result.onOrigin ? '' : ' (ainda nao publicada — base: origin/main)'}`,
    `Commit base: ${result.sha.slice(0, 8)}`,
    `Arquivos da revisao aplicados no working tree: ${result.overlaidFiles.length}`,
    '',
    'Workspace de validação pronto',
    `Backend: ${result.backendUrl}`,
    `Frontend: ${result.url}`,
    '',
    '(isto NAO e aprovacao — quando validar, use /aprovar separadamente)',
  ];
  await sendMessage(chatId, lines.join('\n'), PREFIX.SYSTEM);
}

// /cancelar interrompe SO a execucao ativa (mata o processo Claude), NUNCA a
// tarefa: diff no working tree, devInstruction, gitBranch, reviewGate e
// pendingFixInstruction ficam intocados. Depois de matar o processo,
// recoloca task.state num estado seguro e acionavel (nunca deixa
// DEV_IMPLEMENTANDO/REVISAO_MENTOR "presos" — a mesma classe de problema que
// handleFreeText ja detecta como "possivelmente interrompida").
//
// Sem execucao ativa, nao ha nada pra interromper — /cancelar nao mexe na
// tarefa; quem quer encerrar a tarefa em si (mesmo sem nada rodando) usa
// /encerrar.
async function cmdCancelar(chatId) {
  const task = loadCurrentTask();
  if (!isTaskActive(task)) {
    await sendMessage(chatId, 'Nenhuma tarefa ativa.', PREFIX.SYSTEM);
    return;
  }
  // hasActive() (processRegistry.js) e a fonte definitiva de "ha um processo
  // Claude rodando agora" — cobre TODAS as chamadas (Mentor/Dev/Revisao E a
  // geracao de commit/PR dentro de /aprovar, que nao passa pelo tracker de
  // telemetria de src/execution.js). getExecution() so entra depois, como
  // pista OPCIONAL de qual papel foi interrompido, pra decidir o rollback de
  // estado — sua ausencia nunca impede matar o processo.
  if (!hasActive()) {
    await sendMessage(
      chatId,
      'Nenhuma execucao em andamento para interromper agora. Para encerrar a tarefa definitivamente, use /encerrar.',
      PREFIX.SYSTEM
    );
    return;
  }

  const activeExec = getExecution();
  const killed = cancelActive();

  // MENTOR (ou execucao sem role rastreado, ex: geracao de commit/PR em
  // /aprovar): task.state so avanca DEPOIS que a chamada termina com
  // sucesso — interromper no meio nao deixa nada "preso" pra reverter.
  // DEV/REVIEW: ambos marcam o estado em progresso (DEV_IMPLEMENTANDO /
  // REVISAO_MENTOR) ANTES de chamar o Claude — precisa reverter para um
  // estado que libere /implementar e /revisar de novo, sem perder
  // reviewGate/devInstruction/branch (nenhum dos dois e tocado aqui).
  if (activeExec?.role === 'DEV' || activeExec?.role === 'REVIEW') {
    task.state = STATES.AGUARDANDO_IMPLEMENTACAO;
    saveCurrentTask(task);
  }

  const note = killed ? ' Processo Claude foi encerrado (arvore de processos morta).' : '';
  await sendMessage(chatId, `Execucao interrompida.${note} A tarefa continua ativa.`, PREFIX.SYSTEM);
}

// /encerrar: unico comando que torna a tarefa terminal (CANCELADA). Requer
// intencao explicita — /cancelar nunca faz isso mais. Working tree e branch
// NAO sao tocados (sem git destrutivo aqui).
async function cmdEncerrar(chatId) {
  const task = loadCurrentTask();
  if (!isTaskActive(task)) {
    await sendMessage(chatId, 'Nenhuma tarefa ativa para encerrar.', PREFIX.SYSTEM);
    return;
  }
  // Marca CANCELADA em disco ANTES de matar o processo (se houver um ativo):
  // qualquer callback que ainda estava em andamento vai ver
  // isTaskActive()/stillActive() falso e nao vai sobrescrever este estado.
  task.state = STATES.CANCELADA;
  saveCurrentTask(task);
  const killed = cancelActive();
  const note = killed ? ' Processo Claude em execucao foi encerrado (arvore de processos morta).' : '';
  await sendMessage(
    chatId,
    `Tarefa ${task.id} encerrada (estado: CANCELADA).${note} Working tree e branch (${task.gitBranch || '(nenhuma)'}) nao foram alterados.`,
    PREFIX.SYSTEM
  );
}

async function handleFreeText(chatId, text) {
  let task = loadCurrentTask();
  if (!isTaskActive(task)) {
    task = createTask(text);
    await sendMessage(chatId, `Tarefa ${task.id} criada. Consultando o Mentor...`, PREFIX.SYSTEM);
    await runMentorTurn(chatId, task, text);
    return;
  }
  if (task.state === STATES.DEV_IMPLEMENTANDO || task.state === STATES.REVISAO_MENTOR) {
    await sendMessage(
      chatId,
      `Tarefa ${task.id} parece estar em ${task.state} sem execucao ativa (possivelmente interrompida abruptamente, ex: bridge reiniciado). Use /status para detalhes, /revisar ou /implementar para retomar, ou /encerrar para encerrar a tarefa.`,
      PREFIX.SYSTEM
    );
    return;
  }
  if (task.state === STATES.NOVA && !task.request) {
    task.request = text;
    saveCurrentTask(task);
  }
  await runMentorTurn(chatId, task, text);
}

// Voice notes (msg.voice) e arquivos de audio enviados (msg.audio) seguem o
// mesmo caminho: baixar -> transcrever localmente -> mostrar a transcricao
// -> tratar como texto normal (handleFreeText, mesma state machine/locks).
// Nunca envia nada ao Mentor se download/transcricao falhar ou vier vazio.
async function handleVoiceMessage(chatId, media) {
  if (media.duration && media.duration > config.maxAudioDurationSeconds) {
    await sendMessage(
      chatId,
      `Audio muito longo (${media.duration}s, limite ${config.maxAudioDurationSeconds}s). Envie um audio mais curto.`,
      PREFIX.SYSTEM
    );
    return;
  }
  if (media.file_size && media.file_size > config.maxAudioFileSizeBytes) {
    const mb = (media.file_size / 1024 / 1024).toFixed(1);
    const limitMb = (config.maxAudioFileSizeBytes / 1024 / 1024).toFixed(0);
    await sendMessage(chatId, `Arquivo de audio muito grande (${mb}MB, limite ${limitMb}MB).`, PREFIX.SYSTEM);
    return;
  }

  await sendMessage(chatId, 'Audio recebido. Baixando e transcrevendo localmente...', PREFIX.SYSTEM);

  let localPath;
  try {
    localPath = await downloadTelegramAudio(media.file_id, guessExt(media.mime_type));
  } catch (e) {
    await sendMessage(chatId, `Erro ao baixar audio: ${e.message}`, PREFIX.SYSTEM);
    return;
  }

  let transcript;
  try {
    const stat = fs.statSync(localPath);
    if (stat.size === 0) {
      throw new Error('arquivo de audio baixado esta vazio');
    }
    transcript = await transcribeAudioFile(localPath);
  } catch (e) {
    await sendMessage(chatId, `Falha na transcricao: ${e.message}`, PREFIX.SYSTEM);
    return;
  } finally {
    cleanupFile(localPath);
  }

  if (!transcript) {
    await sendMessage(
      chatId,
      'Transcricao vazia (nenhuma fala reconhecivel no audio). Nada foi enviado ao Mentor.',
      PREFIX.SYSTEM
    );
    return;
  }

  await sendMessage(chatId, transcript, PREFIX.TRANSCRIPTION);
  await handleFreeText(chatId, transcript);
}

function guessExt(mimeType) {
  if (!mimeType) return '.ogg';
  if (mimeType.includes('ogg')) return '.ogg';
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return '.mp3';
  if (mimeType.includes('mp4') || mimeType.includes('m4a')) return '.m4a';
  if (mimeType.includes('wav')) return '.wav';
  return '.ogg';
}

const COMMANDS = {
  '/novo': (chatId, argText) => withBusyLock(chatId, () => cmdNovo(chatId, argText)),
  '/implementar': (chatId) => withBusyLock(chatId, () => cmdImplementar(chatId)),
  '/revisar': (chatId) => withBusyLock(chatId, () => cmdRevisar(chatId)),
  '/aprovar': (chatId) => withBusyLock(chatId, () => cmdAprovar(chatId)),
  '/validar': (chatId) => withBusyLock(chatId, () => cmdValidar(chatId)),
  '/status': (chatId) => cmdStatus(chatId),
  '/tarefas': (chatId) => cmdTarefas(chatId),
  '/abrir': (chatId, argText) => cmdAbrir(chatId, argText),
  '/reabrir': (chatId, argText) => cmdReabrir(chatId, argText),
  '/cancelar': (chatId) => cmdCancelar(chatId),
  '/encerrar': (chatId) => cmdEncerrar(chatId),
};

async function handleMessage(msg) {
  if (!isAuthorized(msg)) {
    console.log('Mensagem ignorada de chat/usuario nao autorizado.');
    return;
  }
  const chatId = msg.chat.id;

  if (msg.voice || msg.audio) {
    await withBusyLock(chatId, () => handleVoiceMessage(chatId, msg.voice || msg.audio));
    return;
  }

  const text = (msg.text || '').trim();
  if (!text) return;

  if (text.startsWith('/')) {
    const [rawCmd, ...rest] = text.split(/\s+/);
    const cmd = rawCmd.split('@')[0].toLowerCase();
    const argText = text.slice(rawCmd.length).trim();
    const handler = COMMANDS[cmd];
    if (handler) {
      await handler(chatId, argText);
    } else {
      await sendMessage(chatId, `Comando desconhecido: ${cmd}`, PREFIX.SYSTEM);
    }
    return;
  }

  await withBusyLock(chatId, () => handleFreeText(chatId, text));
}

export async function startBot() {
  console.log('Bot iniciado. Aguardando mensagens via long polling...');
  let offset = 0;
  for (;;) {
    try {
      const updates = await getUpdates(offset, 25);
      for (const update of updates) {
        offset = update.update_id + 1;
        if (update.message) {
          // nao aguarda: assim /status e /cancelar respondem mesmo com Mentor/Dev em execucao.
          // exclusao mutua entre chamadas pesadas (Mentor/Dev) e feita via withBusyLock.
          handleMessage(update.message).catch((e) => {
            console.error('Erro nao tratado ao processar mensagem:', e.message);
          });
        }
      }
    } catch (e) {
      console.error('Erro no loop de polling:', e.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
