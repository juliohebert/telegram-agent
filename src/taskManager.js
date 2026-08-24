import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getMentorSystemPrompt, getDeveloperSystemPrompt, getMentorPromptVersion } from './prompts.js';
import { runClaude, runClaudeStreaming } from './claudeRunner.js';
import { CancelledError } from './processRegistry.js';
import * as execution from './execution.js';
import { createOrGetPullRequest } from './github.js';
import {
  getDiffStat,
  getWorkspaceEntries,
  getTrackedFileDiff,
  getUntrackedFileDiff,
  hasLocalChanges,
  fetchOrigin,
  getCurrentBranch,
  switchBranch,
  pullFfOnly,
  getRevParse,
  branchExists,
  createAndSwitchBranch,
  getMergeBase,
  stageFiles,
  gitCommit,
  pushSetUpstream,
  getRevListCount,
  getNameStatusDiff,
  IGNORED_DIRTY_PREFIXES,
} from './git.js';
import { STATES, saveCurrentTask } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MENTOR_TOOLS = 'Read,Grep,Glob';
export const DEV_TOOLS = 'Read,Grep,Glob,Edit,Write,Bash,TodoWrite';

// Defesa em profundidade (camada 1): nega a ferramenta para esses padroes.
// Cobre a maioria dos casos, mas --disallowedTools sozinho pode nao
// alcancar invocacoes indiretas em todas as formas.
export const DEV_DISALLOWED_TOOLS = [
  'Bash(git commit:*)',
  'Bash(git push:*)',
  'Bash(git merge:*)',
  'Bash(git rebase:*)',
  'Bash(git reset:*)',
  'Bash(git clean:*)',
].join(',');

// Defesa em profundidade (camada 2, mais forte): hook PreToolUse que roda
// ANTES de qualquer execucao Bash, mesmo com --permission-mode
// bypassPermissions. Ver src/hooks/devGuard.js.
const DEV_GUARD_SCRIPT = path.join(__dirname, 'hooks', 'devGuard.js');
export const DEV_SETTINGS_JSON = JSON.stringify({
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: `node "${DEV_GUARD_SCRIPT}"` }],
      },
    ],
  },
});

// --- Telemetria de execucao (Mentor/Dev/Revisao) ---
//
// Fonte real dos tokens: o proprio Claude CLI devolve `usage` (input_tokens/
// output_tokens/cache_creation_input_tokens/cache_read_input_tokens) tanto
// no modo --output-format json (chamada unica, no evento final) quanto no
// stream-json (evento final type:"result", mesmo shape) — nunca estimado por
// tamanho de texto. Ver claudeRunner.js.
//
// Separa um objeto `usage` (snake_case, formato do Claude CLI) nos 4 campos
// reais + activeTokens.
// activeTokens = input+output SOMENTE. cacheCreation e cacheRead ficam de
// fora — ambos podem crescer muito so por causa de contexto (sessao
// resumida, diffs grandes) sem relacao com o QUE foi de fato gerado nesta
// execucao. Caso real que motivou excluir tambem cacheCreation (antes so
// cacheRead ficava de fora): input=42, output=7508, cacheCreation=166981,
// cacheRead=3357833 — CRITICAL disparou por causa do cache, com consumo
// ativo real de ~7550 tokens. Ver tambem a mudanca em runDev (sessao do Dev
// nunca mais resumida) — a causa raiz do cache se acumulando entre retries.
function splitUsage(usage) {
  if (!usage) return null;
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheCreation = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  return { input, output, cacheCreation, cacheRead, activeTokens: input + output };
}

// Metricas finais de UMA execucao (Mentor/Dev/Revisao), para persistir na
// task e exibir no /status apos concluir. `usage` pode ser a soma acumulada
// de varias chamadas (ex: revisao em chunks) — ver reviewChunked.
function buildMetrics(role, { startedAt, elapsedMs, phase }, usage) {
  const split = splitUsage(usage);
  return {
    role,
    startedAt: new Date(startedAt).toISOString(),
    elapsedMs,
    inputTokens: split?.input ?? null,
    outputTokens: split?.output ?? null,
    cacheCreationTokens: split?.cacheCreation ?? null,
    cacheReadTokens: split?.cacheRead ?? null,
    activeTokens: split?.activeTokens ?? null,
    finalPhase: phase ?? null,
  };
}

// Funde o `usage` autoritativo do evento final "result" com o total ao vivo
// ja acumulado pelo tracker de stream (snap.tokens, formato camelCase de
// execution.js) — campo a campo, preferindo SEMPRE o valor do result QUANDO
// PRESENTE (numero, mesmo que 0 legitimo), e so caindo pro valor ao vivo
// quando o campo vier ausente (null/undefined) no result. Garante que um
// evento final incompleto nunca zere metricas que ja foram corretamente
// coletadas ao vivo (o live snapshot ja e deduplicado por message_id — ver
// createDevPhaseTracker — nunca soma snapshot cumulativo como delta).
function mergeUsageWithLiveSnapshot(resultUsage, liveTokens) {
  if (!liveTokens) return resultUsage;
  // Trata ausente (null/undefined) E zero suspeito (result diz 0 mas o
  // stream ja tinha acumulado um total real positivo) da mesma forma: nunca
  // deixam um total valido virar zero. Um 0 no result so e aceito quando o
  // live tambem nao tem nada acumulado (0 realmente e o valor certo).
  const pick = (fromResult, fromLive) => {
    if (fromResult === undefined || fromResult === null) return fromLive;
    if (fromResult === 0 && fromLive > 0) return fromLive;
    return fromResult;
  };
  return {
    input_tokens: pick(resultUsage?.input_tokens, liveTokens.input),
    output_tokens: pick(resultUsage?.output_tokens, liveTokens.output),
    cache_creation_input_tokens: pick(resultUsage?.cache_creation_input_tokens, liveTokens.cacheCreation),
    cache_read_input_tokens: pick(resultUsage?.cache_read_input_tokens, liveTokens.cacheRead),
  };
}

function addUsage(acc, usage) {
  if (!usage) return acc;
  acc.input_tokens += usage.input_tokens || 0;
  acc.cache_creation_input_tokens += usage.cache_creation_input_tokens || 0;
  acc.cache_read_input_tokens += usage.cache_read_input_tokens || 0;
  acc.output_tokens += usage.output_tokens || 0;
  return acc;
}

// Fases do Dev inferidas do fluxo real de tool calls (nunca percentual
// inventado): Read/Grep/Glob -> ANALISANDO; Edit/Write -> IMPLEMENTANDO;
// Bash de test/build/typecheck/lint/browser -> VALIDANDO (outro Bash conta
// como IMPLEMENTANDO). FINALIZANDO NAO vem daqui — ver createDevPhaseTracker.
// TodoWrite nao muda fase.
const VALIDATION_BASH_RE = /\b(test|jest|vitest|mocha|pytest|build|tsc|typecheck|type-check|lint|eslint|playwright|cypress|chrome|browser)\b/i;
function phaseForToolUse(name, input) {
  if (name === 'Read' || name === 'Grep' || name === 'Glob') return 'ANALISANDO';
  if (name === 'Edit' || name === 'Write') return 'IMPLEMENTANDO';
  if (name === 'Bash') {
    const cmd = (input && input.command) || '';
    return VALIDATION_BASH_RE.test(cmd) ? 'VALIDANDO' : 'IMPLEMENTANDO';
  }
  return null;
}

const ALERT_RANK = { WARNING: 1, HIGH: 2, CRITICAL: 3 };

// Cria o handler de eventos do stream do Dev: atualiza a execucao ativa
// (src/execution.js) com fase/tokens/ultima atividade em tempo real, e
// invoca onUpdate() so em mudanca de fase ou em alerta HIGH/CRITICAL — nunca
// a cada tool call (economia). WARNING so fica registrado no snapshot (o
// /status mostra), sem mensagem no Telegram. Alertas sao "edge-triggered":
// disparam so ao CRUZAR um novo nivel maximo nesta execucao, nunca se
// repetem enquanto o consumo continuar no mesmo nivel.
//
// FONTE DOS TOKENS (validada com o Claude CLI real, --include-partial-
// messages): o evento "assistant" (sem partial messages) so carrega o
// snapshot de usage do INICIO da mensagem (message_start) — output_tokens
// fica preso num valor baixo/placeholder e NUNCA e atualizado; somar isso
// por turno chegou a subestimar o output real em ~80x num teste (20 vs
// 1583). Os eventos brutos "stream_event" > "message_delta" (habilitados
// por --include-partial-messages) trazem o usage FINAL e correto de cada
// mensagem assim que ela termina de gerar — inclusive input/cacheCreation/
// cacheRead, iguais ao message_start (nao mudam), so output_tokens e
// corrigido. Somando esses deltas por mensagem (1 por message_id, sem
// reprocessar) a soma bateu EXATAMENTE com o `usage` do evento final
// "result" em teste real (input/output/cacheCreation/cacheRead identicos).
//
// Por que NAO somar cacheRead/cacheCreation no contador nem nos alertas:
// cada turno interno do Dev (novo tool call) re-le/reescreve o cache com
// base no historico da conversa ate ali — esses dois campos crescem com o
// TAMANHO DO CONTEXTO (sessao/diffs), nao com o trabalho novo feito nesta
// execucao. Caso real: cacheRead somado por turno chegou a saltar
// 116k -> 598k -> 720k -> 849k num teste; caso real mais grave: cacheCreation
// sozinho chegou a 166981 numa sessao Dev resumida entre retries, disparando
// CRITICAL com so ~7550 tokens de trabalho ativo (input+output). Por isso
// activeTokens = input+output SOMENTE. cacheCreation/cacheRead continuam
// rastreados e exibidos separadamente ("Cache criado"/"Cache reutilizado"),
// fora de activeTokens e fora dos alertas. Ver tambem runDev: a sessao do
// Dev deixou de ser resumida entre chamadas, que e a causa raiz do cache
// se acumulando sem limite entre retries.
//
// FASES: um bloco de texto pode aparecer ANTES de outro tool_use na MESMA
// mensagem (confirmado com o CLI real) — nao e mais usado como gatilho de
// fase. FINALIZANDO so e confirmado no evento final "result" (type:
// "result"), que so acontece quando a execucao de fato terminou — nunca
// prematuro, nunca volta para outra fase depois (e o ultimo evento).
function createDevPhaseTracker(onUpdate) {
  const usageByMessageId = new Map(); // message_id -> {input, output, cacheCreation, cacheRead}
  let currentMessageId = null;
  let phase = 'ANALISANDO';
  execution.startExecution('DEV');
  execution.updateExecution({ phase });

  function totals() {
    const sum = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
    for (const u of usageByMessageId.values()) {
      sum.input += u.input;
      sum.output += u.output;
      sum.cacheCreation += u.cacheCreation;
      sum.cacheRead += u.cacheRead;
    }
    sum.activeTokens = sum.input + sum.output;
    return sum;
  }

  function notifyPhase(newPhase) {
    if (!newPhase || newPhase === phase) return;
    phase = newPhase;
    execution.updateExecution({ phase });
    onUpdate?.({ type: 'phase', snapshot: execution.getExecution() });
  }

  function checkAlert(activeTokens) {
    let level = null;
    if (activeTokens >= config.devTokenCritical) level = 'CRITICAL';
    else if (activeTokens >= config.devTokenHigh) level = 'HIGH';
    else if (activeTokens >= config.devTokenWarning) level = 'WARNING';
    if (!level) return;
    const snap = execution.getExecution();
    const prevRank = snap?.alertLevel ? ALERT_RANK[snap.alertLevel] : 0;
    if (ALERT_RANK[level] <= prevRank) return;
    execution.updateExecution({ alertLevel: level });
    if (level === 'HIGH' || level === 'CRITICAL') {
      onUpdate?.({ type: 'alert', level, snapshot: execution.getExecution() });
    }
  }

  return function onEvent(evt) {
    if (evt.type === 'result') {
      // Unico gatilho de FINALIZANDO: a execucao realmente terminou.
      notifyPhase('FINALIZANDO');
      return;
    }

    if (evt.type === 'stream_event' && evt.event) {
      const inner = evt.event;
      if (inner.type === 'message_start' && inner.message?.id) {
        currentMessageId = inner.message.id;
        return;
      }
      if (inner.type === 'message_delta' && currentMessageId && inner.usage) {
        const u = inner.usage;
        usageByMessageId.set(currentMessageId, {
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheCreation: u.cache_creation_input_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
        });
        const t = totals();
        execution.updateExecution({ tokens: t });
        checkAlert(t.activeTokens);
      }
      return;
    }

    if (evt.type !== 'assistant' || !evt.message) return;
    for (const block of evt.message.content || []) {
      if (block.type === 'tool_use') {
        execution.updateExecution({ lastActivity: block.name });
        notifyPhase(phaseForToolUse(block.name, block.input));
      }
    }
  };
}

export const DEFAULT_BRANCH = 'main';

export class BranchPrepError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BranchPrepError';
  }
}

// Tipos aceitos no padrao de branch <tipo>/<slug> (ver resolveBranchName).
// Fallback seguro quando o Mentor nao define um tipo valido: 'chore' — nao
// afirma nada sobre a natureza da mudanca, so identifica a tarefa.
export const BRANCH_TYPES = ['feat', 'fix', 'perf', 'refactor', 'chore', 'docs', 'test'];
const FALLBACK_BRANCH_TYPE = 'chore';

function normalizeBranchType(type) {
  if (!type) return null;
  const t = String(type).trim().toLowerCase();
  return BRANCH_TYPES.includes(t) ? t : null;
}

// Normaliza texto livre para um slug de branch seguro: lowercase,
// kebab-case, sem acentos/caracteres especiais, truncado sem cortar no
// meio de uma palavra quando possivel.
function slugify(text, maxLen = 40) {
  if (!text) return '';
  let slug = String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > maxLen) {
    const truncated = slug.slice(0, maxLen).replace(/-+$/, '');
    slug = truncated.replace(/-[^-]*$/, '') || truncated;
  }
  return slug;
}

// Monta <tipo>/<slug> a partir do que o Mentor definiu (task.branchType /
// task.branchSlug). Se o tipo nao for um dos BRANCH_TYPES, ou o slug ficar
// vazio apos normalizacao, cai para um fallback seguro derivado da
// devInstruction/solicitacao da tarefa — nunca bloqueia a criacao da branch
// por falta desses campos. Tambem persiste em `task` os valores REALMENTE
// usados (resolvidos), para que o estado reflita a branch criada mesmo
// quando o fallback foi acionado.
function resolveBranchName(task) {
  const type = normalizeBranchType(task.branchType) || FALLBACK_BRANCH_TYPE;
  const slug = slugify(task.branchSlug) || slugify(task.devInstruction) || slugify(task.request) || task.id;
  task.branchType = type;
  task.branchSlug = slug;
  return `${type}/${slug}`;
}

// Prepara uma branch exclusiva e segura para a tarefa, ANTES do Dev tocar
// em qualquer arquivo. Roda inteiramente pelo bridge (spawns diretos de
// git em git.js) — o Claude Dev nunca executa nenhum destes passos.
//
// Fluxo (interrompe e lanca BranchPrepError no primeiro problema, sem usar
// force/force-with-lease/reset/clean em nenhum passo):
// 1. git fetch origin (primeiro, para que a checagem de divergencia mais
//    adiante e a decisao de sujeira usem informacao remota atualizada)
// 2. confirma que main pertence a MESMA historia de origin/main (git
//    merge-base) — protege contra workspaces com historia incompativel
//    (ex: remote/branch de outra linhagem, como o incidente clinic/Quark)
// 3. git status --porcelain -> se sujo (ignorando ruidos locais conhecidos),
//    aborta (nunca sobrescreve trabalho existente)
// 4. git switch main
// 5. git pull --ff-only origin main
// 6. confirma que main local == origin/main
// 7. cria <branchType>/<branchSlug> (ver resolveBranchName) -- se ja
//    existir, aborta (nao recria silenciosamente). taskId NAO entra no nome
//    da branch, so no state/Telegram.
export async function prepareTaskBranch(task) {
  try {
    await fetchOrigin();
  } catch (e) {
    throw new BranchPrepError(`git fetch origin falhou: ${e.message}`);
  }

  try {
    await getMergeBase(DEFAULT_BRANCH, `origin/${DEFAULT_BRANCH}`);
  } catch (e) {
    throw new BranchPrepError(
      `${DEFAULT_BRANCH} local nao tem ancestral comum com origin/${DEFAULT_BRANCH} (git merge-base falhou: ${e.message}). ` +
        'Isso indica historia git incompativel neste workspace (ex: remote/branch de outra linhagem). ' +
        'Nenhuma implementacao foi iniciada — resolva manualmente antes de tentar novamente.'
    );
  }

  const dirty = await hasLocalChanges();
  if (dirty) {
    throw new BranchPrepError(
      `Workspace com alteracoes locais nao commitadas em ${DEFAULT_BRANCH}. Resolva manualmente (commit/stash) antes de tentar novamente:\n${dirty}`
    );
  }

  try {
    await switchBranch(DEFAULT_BRANCH);
  } catch (e) {
    throw new BranchPrepError(`git switch ${DEFAULT_BRANCH} falhou: ${e.message}`);
  }

  try {
    await pullFfOnly('origin', DEFAULT_BRANCH);
  } catch (e) {
    throw new BranchPrepError(
      `git pull --ff-only origin ${DEFAULT_BRANCH} falhou (possivel divergencia local/remota): ${e.message}`
    );
  }

  const localSha = await getRevParse(DEFAULT_BRANCH);
  const remoteSha = await getRevParse(`origin/${DEFAULT_BRANCH}`);
  if (localSha !== remoteSha) {
    throw new BranchPrepError(
      `${DEFAULT_BRANCH} local (${localSha.slice(0, 8)}) nao esta alinhada com origin/${DEFAULT_BRANCH} (${remoteSha.slice(0, 8)}) apos o pull. Abortando.`
    );
  }

  // Base real da branch da tarefa: o commit em que main/origin/main
  // convergiram bem antes de criar a branch (linha acima). Persistido para
  // que /aprovar possa depois checar, so nos arquivos revisados, o que
  // mudou em origin/main desde este ponto (preflight de concorrencia — ver
  // approveTask).
  task.baseSha = localSha;

  const branchName = resolveBranchName(task);
  if (await branchExists(branchName)) {
    throw new BranchPrepError(
      `Branch ${branchName} ja existe. Nao sera recriada automaticamente — verifique/remova manualmente antes de tentar novamente.`
    );
  }

  try {
    await createAndSwitchBranch(branchName);
  } catch (e) {
    throw new BranchPrepError(`Falha ao criar a branch ${branchName}: ${e.message}`);
  }

  return branchName;
}

// Chamado quando task.gitBranch ja foi preparada em uma chamada anterior de
// /implementar (ex: Dev corrigindo algo apos revisao do Mentor). NUNCA troca
// de branch automaticamente — so confirma que o workspace esta exatamente
// na branch da tarefa antes de deixar o Dev continuar. Se estiver em outra
// branch (trocada manualmente, ou por qualquer outro motivo), bloqueia.
export async function verifyOnTaskBranch(task) {
  const current = await getCurrentBranch();
  if (current !== task.gitBranch) {
    throw new BranchPrepError(
      `Branch atual (${current || '(nenhuma — HEAD destacado?)'}) diferente da branch da tarefa (${task.gitBranch}). O bridge nao troca de branch automaticamente — mude manualmente para ${task.gitBranch} e tente novamente.`
    );
  }
  return current;
}

// Marcador "### Instrucao para o Desenvolvedor", usado tanto na analise
// inicial (parseMentorAnalysis) quanto na revisao (parseReviewGate) e no
// fail-safe de handoff (ensureFixInstructionForChangesRequired) — uma unica
// definicao evita os tres lugares divergirem silenciosamente.
const DEV_INSTRUCTION_RE = /###\s*Instru[cç][aã]o para o Desenvolvedor\s*\n([\s\S]*?)(?=\n###|\s*$)/i;
function extractDevInstruction(text) {
  if (!text) return null;
  const m = text.match(DEV_INSTRUCTION_RE);
  return m ? m[1].trim() : null;
}

// Extrai do texto do Mentor os campos estruturados (quando presentes):
// - riskLevel: BAIXO/MEDIO/ALTO, de "### Risco";
// - devInstruction: conteudo de "### Instrucao para o Desenvolvedor";
// - branchType/branchSlug: "<tipo>/<slug>" de "### Branch" (bruto — a
//   normalizacao/validacao final acontece em resolveBranchName, na hora de
//   criar a branch, nunca aqui).
// Ausencia de qualquer um desses campos e normal (ex: resposta de
// "Verificacao direta" nao produz instrucao) — quem chama preserva o valor
// anterior nesse caso, nunca zera com null.
function parseMentorAnalysis(text) {
  const riskMatch = text.match(/###\s*Risco\s*\n\s*(BAIXO|MEDIO|ALTO)\b/i);
  const instrMatch = extractDevInstruction(text);
  const branchMatch = text.match(/###\s*Branch\s*\n\s*([^\n]+)/i);
  let branchType = null;
  let branchSlug = null;
  if (branchMatch) {
    const raw = branchMatch[1].trim();
    const slashIdx = raw.indexOf('/');
    if (slashIdx > 0) {
      branchType = raw.slice(0, slashIdx).trim();
      branchSlug = raw.slice(slashIdx + 1).trim();
    }
  }
  return {
    riskLevel: riskMatch ? riskMatch[1].toUpperCase() : null,
    devInstruction: instrMatch,
    branchType,
    branchSlug,
  };
}

// Extrai o veredito estruturado da revisao do Mentor (### Veredito / Motivo /
// Proximo passo). gate=null quando o Mentor nao devolveu o formato esperado
// — tratado como "nao pronto" por quem chama, nunca como READY implicito.
//
// Em CHANGES_REQUIRED, o Mentor tambem pode devolver "### Instrucao para o
// Desenvolvedor" com a correcao — extraida aqui (mesmo marcador usado em
// parseMentorAnalysis) para virar o novo task.devInstruction sem depender
// da sessao do Mentor no proximo /implementar.
function parseReviewGate(text) {
  const gateMatch = text.match(/###\s*Veredito\s*\n\s*(READY|BLOCKED|CHANGES_REQUIRED)\b/i);
  const reasonMatch = text.match(/###\s*Motivo\s*\n([\s\S]*?)(?=\n###|\s*$)/i);
  const nextMatch = text.match(/###\s*Pr[oó]ximo passo\s*\n([\s\S]*?)(?=\n###|\s*$)/i);
  return {
    gate: gateMatch ? gateMatch[1].toUpperCase() : null,
    reason: reasonMatch ? reasonMatch[1].trim() : null,
    nextAction: nextMatch ? nextMatch[1].trim() : null,
    fixInstruction: extractDevInstruction(text),
  };
}

function buildFixInstructionRetryMessage() {
  return [
    'Sua revisao anterior teve Veredito CHANGES_REQUIRED mas nao incluiu a secao obrigatoria de correcao.',
    '',
    'Retorne SOMENTE o seguinte, sem texto antes/depois, com base na revisao que voce ja fez (nao precisa reler o diff):',
    '',
    '### Instrução para o Desenvolvedor',
    '<correção curta e completa, autocontida>',
  ].join('\n');
}

// Fail-safe do handoff Mentor -> Dev quando a revisao veio CHANGES_REQUIRED
// mas SEM "### Instrucao para o Desenvolvedor" (sessao com prompt antigo,
// Mentor esqueceu o campo, etc). Nunca deixa a devInstruction ANTIGA passar
// silenciosamente como se fosse a correcao desta revisao:
// 1. tenta extrair da propria revisao (task.lastReview);
// 2. se ausente, faz UMA chamada curta adicional na MESMA sessao do Mentor
//    (sem reenviar diff/analise) pedindo so a secao que falta;
// 3. se mesmo assim nao vier, marca pendingFixInstruction=true — quem chama
//    (cmdImplementar) usa essa flag para bloquear, independente do que
//    task.devInstruction ainda contiver de uma correcao anterior.
async function ensureFixInstructionForChangesRequired(task) {
  const directInstruction = extractDevInstruction(task.lastReview);
  if (directInstruction) {
    task.devInstruction = directInstruction;
    task.pendingFixInstruction = false;
    return { note: null };
  }

  let retryResult;
  try {
    retryResult = await runClaude({
      message: buildFixInstructionRetryMessage(),
      systemPrompt: getMentorSystemPrompt(),
      tools: MENTOR_TOOLS,
      sessionId: task.mentorSessionId,
      timeoutMs: config.mentorTimeoutMs,
    });
  } catch (e) {
    task.pendingFixInstruction = true;
    return {
      note: `FALHA NO HANDOFF: a revisao veio CHANGES_REQUIRED sem "### Instrucao para o Desenvolvedor", e a tentativa automatica de obte-la falhou (${e.message}). /implementar fica BLOQUEADO ate nova revisao (/revisar) — a instrucao anterior NAO sera reenviada ao Dev.`,
    };
  }

  task.mentorSessionId = retryResult.sessionId;
  task.mentorPromptVersion = getMentorPromptVersion();
  const retriedInstruction = extractDevInstruction(retryResult.text);
  if (retriedInstruction) {
    task.devInstruction = retriedInstruction;
    task.pendingFixInstruction = false;
    return {
      note: '(a revisao original nao trouxe "### Instrucao para o Desenvolvedor"; obtida automaticamente em uma chamada adicional ao Mentor, na mesma sessao)',
      usage: retryResult.usage,
    };
  }

  task.pendingFixInstruction = true;
  return {
    note: 'FALHA NO HANDOFF: o Mentor nao retornou uma instrucao de correcao valida mesmo apos nova tentativa. /implementar fica BLOQUEADO ate nova revisao (/revisar) — a instrucao anterior NAO sera reenviada ao Dev.',
    usage: retryResult.usage,
  };
}

// Contexto minimo para o Dev: instrucao curta e estruturada do Mentor
// (devInstruction) em vez da analise completa — so cai para a analise
// inteira se o Mentor nao tiver produzido uma instrucao parseavel ainda.
// Como a sessao do Dev nunca e resumida (ver runDev), esta mensagem e TODO
// o contexto que o Dev recebe pronto — nunca inclui devReport/historico do
// Dev anterior; o resto (estado atual do working tree, arquivos, diff) o
// proprio Dev le com Read/Grep/Glob/Bash quando precisar.
function buildDevMessage(task) {
  return [
    '## Tarefa aprovada para implementacao',
    '',
    '### Solicitacao original',
    task.request || '(nao informada)',
    '',
    '### Instrucao do Mentor',
    task.devInstruction || task.lastMentorAnalysis || '(nenhuma analise registrada)',
    '',
    'Implemente conforme suas instrucoes. Ao final, entregue o relatorio no formato definido.',
  ].join('\n');
}

// Monta, para CADA arquivo listado em `git status --short` (rastreado ou
// novo), um bloco de texto pronto para revisao. Arquivos rastreados usam
// diff contra HEAD (cobre staged + unstaged de uma vez). Arquivos novos
// (untracked) tem o conteudo incluido via diff sintetico contra /dev/null.
//
// Arquivo binario (rastreado ou novo): e listado ao Mentor por nome (apenas
// um marcador, NUNCA o conteudo), e seu nome tambem vai em `binaries` —
// quem chama (reviewWithMentor) usa essa lista para forcar
// reviewComplete=false e impedir AGUARDANDO_VALIDACAO, mesmo que o resto do
// workspace seja textual e tenha sido revisado normalmente. Arquivos
// ignorados via .gitignore nunca aparecem aqui, pois `git status` ja os
// exclui por padrao — nao ha necessidade de trata-los especialmente.
//
// Qualquer falha ao COLETAR um arquivo (ex: removido em condicao de corrida)
// e reportada em `failures` — isso e diferente de binario: falha aborta a
// revisao inteira antes de chamar o Mentor; binario nao aborta a chamada,
// so impede a conclusao como completa.

// Hash determinístico do conteudo exato revisado (nome + texto de cada
// bloco, ordenados por nome de arquivo para nao depender da ordem que o
// git devolveu). /aprovar recalcula isso sobre o workspace atual e bloqueia
// se nao bater com o que foi salvo ao final da revisao.
function computeWorkspaceFingerprint(blocks) {
  const sorted = [...blocks].sort((a, b) => a.file.localeCompare(b.file));
  const material = sorted.map((b) => `${b.file} ${b.text}`).join('');
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

async function collectWorkspaceBlocks() {
  // raw e entries vem da MESMA chamada git (ver getWorkspaceEntries): o
  // texto exibido ao Mentor nunca pode divergir da lista realmente coberta.
  // Ruidos conhecidos (IGNORED_DIRTY_PREFIXES: .claude/, web/.vite/) sao
  // removidos de AMBOS aqui — nunca aparecem no texto nem na lista iterada,
  // mantendo os dois em sincronia (mesmo principio ja usado para o resto
  // da lista: nunca mostrar algo que nao foi de fato coberto, e vice-versa).
  const { entries: rawEntries } = await getWorkspaceEntries();
  const entries = rawEntries.filter(
    ({ file }) => !IGNORED_DIRTY_PREFIXES.some((prefix) => file.startsWith(prefix))
  );
  const statusText = entries.length > 0 ? entries.map(({ xy, file }) => `${xy} ${file}`).join('\n') : '(sem alteracoes)';

  const blocks = [];
  const failures = [];
  const binaries = [];

  for (const { xy, file, tracked } of entries) {
    try {
      if (tracked) {
        const diff = await getTrackedFileDiff(file);
        const isBinary = /^Binary files /m.test(diff);
        if (isBinary) {
          binaries.push(file);
          blocks.push({
            file,
            text: `### ${file} [status: ${xy.trim()}] (BINARIO — NAO REVISAVEL: conteudo nao incluido, apenas registrado como presente)`,
          });
        } else {
          blocks.push({
            file,
            text: `### ${file} [status: ${xy.trim()}]\n\`\`\`diff\n${diff || '(sem diff textual)'}\n\`\`\``,
          });
        }
      } else {
        const { diff, isBinary } = await getUntrackedFileDiff(file);
        if (isBinary) {
          binaries.push(file);
          blocks.push({
            file,
            text: `### ${file} (novo arquivo BINARIO — NAO REVISAVEL: conteudo nao incluido, apenas registrado como presente)`,
          });
        } else {
          blocks.push({
            file,
            text: `### ${file} (novo arquivo, nao rastreado)\n\`\`\`diff\n${diff}\n\`\`\``,
          });
        }
      }
    } catch (e) {
      failures.push({ file, error: e.message });
    }
  }

  return { statusText, blocks, failures, binaries };
}

function buildReviewMessage(task, gitInfo, blocks) {
  return [
    '## Revisao de implementacao',
    '',
    '### Pedido original',
    task.request || '(nao informado)',
    '',
    '### Instrucao dada ao Dev',
    task.devInstruction || task.lastMentorAnalysis || '(nenhuma)',
    '',
    '### Relatorio do Desenvolvedor',
    task.devReport || '(nenhum relatorio)',
    '',
    '### git status --short',
    '```',
    gitInfo.status,
    '```',
    '',
    '### git diff --stat (HEAD)',
    '```',
    gitInfo.diffStat,
    '```',
    '',
    `### Alteracoes completas (${blocks.length} arquivo(s): rastreados staged+unstaged e novos/untracked)`,
    blocks.map((b) => b.text).join('\n\n'),
    '',
    'Revise criticamente conforme suas instrucoes, cobrindo TODOS os arquivos listados acima. Diga explicitamente se esta pronto para validacao do usuario ou se ha problemas a corrigir.',
  ].join('\n');
}

// Revisao de tarefa REABERTA (/reabrir) sem diff novo no workspace — usada
// so quando task.reopenPendingReview===true (ver reviewWithMentor): o
// atalho normal de "git limpo -> nada pra revisar" nao vale aqui, porque a
// tarefa foi reaberta por causa de um problema funcional relatado DEPOIS da
// aprovacao, nao por falta de mudancas. Contexto minimo e intencional (nao
// manda o diff completo do ciclo ja aprovado, so o essencial pro Mentor
// formar um veredito): pedido original, instrucao/implementacao do ciclo
// anterior, ultima revisao formal anterior (se houver) e estado atual —
// mais o que ja foi discutido nesta MESMA sessao do Mentor (mesmo
// mentorSessionId, resumido por reviewSingleShot), que ja tem a evidencia
// do problema relatado pelo usuario apos a reabertura.
function buildReopenReviewMessage(task) {
  return [
    '## Revisao apos reabertura (sem diff novo no workspace)',
    '',
    'Esta tarefa foi APROVADA e depois reaberta (/reabrir) por causa de um problema funcional relatado apos a aprovacao. O workspace esta limpo agora (nada foi implementado ainda neste novo ciclo) — nao ha diff pra revisar desta vez, entao NAO use o atalho de "nada pra revisar": avalie com base no que ja foi discutido nesta sessao sobre o problema relatado.',
    '',
    '### Pedido original',
    task.request || '(nao informado)',
    '',
    '### Instrucao/implementacao do ciclo ja aprovado',
    task.devInstruction || '(nenhuma)',
    '',
    '### Ultima revisao formal anterior (antes da aprovacao)',
    task.lastReview || '(nenhuma)',
    '',
    '### Ultima analise do Mentor nesta sessao (evidencia/problema relatado apos a reabertura)',
    task.lastMentorAnalysis || '(veja a conversa recente desta mesma sessao)',
    '',
    `### Estado atual da tarefa: state=${task.state}, reviewGate anterior=${task.reviewGate || '(nenhum)'}, branch=${task.gitBranch || '(nenhuma)'}`,
    '',
    'Com base nisso e na conversa ja tida nesta sessao, de um veredito formal no formato definido (### Veredito: READY, BLOCKED ou CHANGES_REQUIRED). Se for CHANGES_REQUIRED, inclua a secao "### Instrucao para o Desenvolvedor" com a correcao completa e autocontida.',
  ].join('\n');
}

function splitByLines(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const lines = text.split('\n');
  const parts = [];
  let current = '';
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > maxChars && current) {
      parts.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts;
}

// Empacota os blocos (ja formatados, um por arquivo) em chunks <= maxChars.
// Um bloco cujo texto sozinho exceda maxChars e dividido em partes
// sequenciais (nunca cortado sem aviso) — o arquivo continua 100% coberto,
// apenas em varias mensagens.
function buildChunksFromBlocks(blocks, maxChars) {
  const chunks = [];
  let current = '';
  for (const { file, text } of blocks) {
    if (text.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      const subparts = splitByLines(text, maxChars);
      subparts.forEach((part, i) => {
        chunks.push(`${part}\n\n(${file}: parte ${i + 1}/${subparts.length}, dividido por exceder MAX_DIFF_CHARS)`);
      });
      continue;
    }
    if (current && current.length + text.length + 2 > maxChars) {
      chunks.push(current);
      current = text;
    } else {
      current = current ? `${current}\n\n${text}` : text;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function buildReviewIntroMessage(task, gitInfo, totalParts, fileNames) {
  return [
    '## Revisao de implementacao (workspace dividido em partes)',
    '',
    `O conteudo total das alteracoes (diffs + arquivos novos) excede MAX_DIFF_CHARS (${config.maxDiffChars} caracteres) e sera enviado em ${totalParts} parte(s) nas proximas mensagens desta mesma sessao.`,
    `Arquivos que serao cobertos (${fileNames.length}): ${fileNames.join(', ')}`,
    'NAO emita veredito final ainda. Apenas confirme o recebimento e aguarde todas as partes. No final, confirme que revisou TODOS os arquivos listados acima.',
    '',
    '### Pedido original',
    task.request || '(nao informado)',
    '',
    '### Instrucao dada ao Dev',
    task.devInstruction || task.lastMentorAnalysis || '(nenhuma)',
    '',
    '### Relatorio do Desenvolvedor',
    task.devReport || '(nenhum relatorio)',
    '',
    '### git status --short',
    '```',
    gitInfo.status,
    '```',
    '',
    '### git diff --stat (HEAD)',
    '```',
    gitInfo.diffStat,
    '```',
  ].join('\n');
}

function buildReviewPartMessage(index, total, chunkContent) {
  return [
    `## Parte ${index}/${total}`,
    '',
    'Analise esta parte (arquivos/blocos abaixo). Anote riscos/bugs encontrados, mas NAO emita veredito final ainda — pode haver mais partes ou o pedido de consolidacao final a seguir.',
    '',
    chunkContent,
  ].join('\n');
}

function buildReviewFinalMessage(fileNames) {
  return [
    'Todas as partes foram enviadas.',
    '',
    `Confirme que cobriu TODOS os ${fileNames.length} arquivos desta lista: ${fileNames.join(', ')}.`,
    'Agora consolide sua revisao considerando TODO o conteudo analisado nas partes anteriores (nao apenas a ultima).',
    'Use o formato definido nas suas instrucoes (O que foi feito / Riscos-bugs / Aderencia / Proximo passo).',
    'Diga explicitamente se esta pronto para validacao do usuario ou se ha problemas a corrigir.',
  ].join('\n');
}

export async function consultMentor(task, userMessage) {
  const startedAt = Date.now();
  execution.startExecution('MENTOR');
  let result;
  try {
    result = await runClaude({
      message: userMessage,
      systemPrompt: getMentorSystemPrompt(),
      tools: MENTOR_TOOLS,
      sessionId: task.mentorSessionId,
      timeoutMs: config.mentorTimeoutMs,
    });
  } finally {
    execution.endExecution();
  }

  task.mentorSessionId = result.sessionId;
  task.mentorPromptVersion = getMentorPromptVersion();
  task.lastMentorAnalysis = result.text;
  task.mentorMetrics = buildMetrics('MENTOR', { startedAt, elapsedMs: Date.now() - startedAt, phase: null }, result.usage);
  const parsed = parseMentorAnalysis(result.text);
  if (parsed.riskLevel) task.riskLevel = parsed.riskLevel;
  if (parsed.devInstruction) task.devInstruction = parsed.devInstruction;
  if (parsed.branchType) task.branchType = parsed.branchType;
  if (parsed.branchSlug) task.branchSlug = parsed.branchSlug;
  if (task.state === STATES.NOVA) {
    task.state = STATES.AGUARDANDO_IMPLEMENTACAO;
  }
  saveCurrentTask(task);
  return result;
}

// onUpdate (opcional): recebe { type: 'phase'|'alert'|'complete', level?,
// snapshot?, metrics? } para telemetria em tempo real (ver
// createDevPhaseTracker). Quem chama (bot.js) decide o que fazer com isso
// (ex: mandar mensagem no Telegram) — runDev nunca formata nem envia
// mensagens.
//
// Sessao do Dev NUNCA e resumida entre chamadas (sessionId sempre null aqui,
// mesmo que task.devSessionId exista de uma execucao anterior) — cada
// /implementar comeca uma sessao nova. Motivo: resumir (--resume) faz o
// Claude CLI recarregar TODO o historico da conversa anterior a cada turno,
// e isso e o que estava acumulando cacheCreation/cacheRead sem limite entre
// retries (caso real: cacheCreation=166981 numa sessao resumida, contra
// ~7550 tokens de trabalho ativo). buildDevMessage ja manda so o minimo
// (solicitacao + devInstruction ATUAL, nunca o relatorio/historico do Dev
// anterior) — o Dev novo le o working tree/diff diretamente com suas
// ferramentas quando precisar de mais contexto, em vez de receber texto
// antigo. task.devSessionId continua sendo salvo (so como referencia/
// auditoria de qual sessao rodou por ultimo), nunca mais reutilizado como
// entrada.
export async function runDev(task, { onUpdate } = {}) {
  task.state = STATES.DEV_IMPLEMENTANDO;
  saveCurrentTask(task);

  const onEvent = createDevPhaseTracker(onUpdate);
  try {
    const result = await runClaudeStreaming({
      message: buildDevMessage(task),
      systemPrompt: getDeveloperSystemPrompt(),
      tools: DEV_TOOLS,
      disallowedTools: DEV_DISALLOWED_TOOLS,
      settingsJson: DEV_SETTINGS_JSON,
      sessionId: null,
      timeoutMs: config.devTimeoutMs,
      onEvent,
    });

    const snap = execution.getExecution();
    task.devSessionId = result.sessionId;
    task.devReport = result.text;
    // Funde com o total ao vivo (snap.tokens) — nunca deixa um campo
    // ausente/zero no result final sobrescrever o que ja foi corretamente
    // acumulado durante o stream (ver mergeUsageWithLiveSnapshot).
    const mergedUsage = mergeUsageWithLiveSnapshot(result.usage, snap.tokens);
    task.devMetrics = buildMetrics('DEV', { startedAt: snap.startedAt, elapsedMs: snap.elapsedMs, phase: snap.phase }, mergedUsage);
    saveCurrentTask(task);
    // Unica notificacao de conclusao (alem do inicio ja enviado por
    // cmdImplementar e dos alertas HIGH/CRITICAL) — usa as metricas finais
    // JA calculadas acima a partir do `usage` autoritativo, sem recalcular.
    onUpdate?.({ type: 'complete', metrics: task.devMetrics });
    return result;
  } finally {
    execution.endExecution();
  }
}

// `message` ja vem pronto do chamador (buildReviewMessage para o fluxo
// normal com diff, ou buildReopenReviewMessage para revisao de tarefa
// reaberta sem diff novo) — reviewSingleShot so cuida do que e comum aos
// dois casos: chamar o Mentor, parsear o veredito, tratar handoff de
// CHANGES_REQUIRED, limpar reopenPendingReview e persistir tudo.
async function reviewSingleShot(task, gitInfo, message) {
  const startedAt = Date.now();
  execution.startExecution('REVIEW');
  let result;
  let handoff;
  try {
    result = await runClaude({
      message,
      systemPrompt: getMentorSystemPrompt(),
      tools: MENTOR_TOOLS,
      sessionId: task.mentorSessionId,
      timeoutMs: config.mentorTimeoutMs,
    });

    task.mentorSessionId = result.sessionId;
    task.mentorPromptVersion = getMentorPromptVersion();
    task.lastReview = result.text;
    task.reviewComplete = true;
    // Revisao completou de verdade: qualquer bloqueio de /implementar
    // herdado de uma reabertura (/reabrir — ver state.js) fica resolvido
    // aqui, seja qual for o veredito. So esta linha decide isso; o gate
    // CHANGES_REQUIRED continua com sua propria checagem de handoff normal.
    task.reopenPendingReview = false;
    const gate = parseReviewGate(result.text);
    task.reviewGate = gate.gate;
    task.reviewGateReason = gate.reason;
    task.reviewNextAction = gate.nextAction;
    // So CHANGES_REQUIRED tem correcao de fato a implementar. BLOCKED/READY
    // preservam a instrucao anterior e nao ficam com correcao pendente.
    handoff = { note: null };
    if (gate.gate === 'CHANGES_REQUIRED') {
      handoff = await ensureFixInstructionForChangesRequired(task);
    } else {
      task.pendingFixInstruction = false;
    }
  } finally {
    execution.endExecution();
  }
  const usageAcc = addUsage(addUsage({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, result.usage), handoff.usage);
  task.reviewMetrics = buildMetrics('REVIEW', { startedAt, elapsedMs: Date.now() - startedAt, phase: null }, usageAcc);
  task.state = STATES.AGUARDANDO_VALIDACAO;
  saveCurrentTask(task);
  const text = handoff.note ? `${result.text}\n\n---\n${handoff.note}` : result.text;
  return { ...result, text, gitInfo, chunked: false };
}

async function reviewChunked(task, gitInfo, chunks, fileNames) {
  let sessionId = task.mentorSessionId;
  let reviewedCount = 0;
  const startedAt = Date.now();
  const usageAcc = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  execution.startExecution('REVIEW');

  try {
    const introResult = await runClaude({
      message: buildReviewIntroMessage(task, gitInfo, chunks.length, fileNames),
      systemPrompt: getMentorSystemPrompt(),
      tools: MENTOR_TOOLS,
      sessionId,
      timeoutMs: config.mentorTimeoutMs,
    });
    addUsage(usageAcc, introResult.usage);
    sessionId = introResult.sessionId;
    task.mentorSessionId = sessionId;
    saveCurrentTask(task);

    for (let i = 0; i < chunks.length; i++) {
      const partResult = await runClaude({
        message: buildReviewPartMessage(i + 1, chunks.length, chunks[i]),
        systemPrompt: getMentorSystemPrompt(),
        tools: MENTOR_TOOLS,
        sessionId,
        timeoutMs: config.mentorTimeoutMs,
      });
      addUsage(usageAcc, partResult.usage);
      sessionId = partResult.sessionId;
      task.mentorSessionId = sessionId;
      saveCurrentTask(task);
      reviewedCount++;
    }

    const finalResult = await runClaude({
      message: buildReviewFinalMessage(fileNames),
      systemPrompt: getMentorSystemPrompt(),
      tools: MENTOR_TOOLS,
      sessionId,
      timeoutMs: config.mentorTimeoutMs,
    });
    addUsage(usageAcc, finalResult.usage);

    task.mentorSessionId = finalResult.sessionId;
    task.mentorPromptVersion = getMentorPromptVersion();
    task.lastReview = finalResult.text;
    task.reviewComplete = true;
    task.reopenPendingReview = false;
    const gate = parseReviewGate(finalResult.text);
    task.reviewGate = gate.gate;
    task.reviewGateReason = gate.reason;
    task.reviewNextAction = gate.nextAction;
    let handoff = { note: null };
    if (gate.gate === 'CHANGES_REQUIRED') {
      handoff = await ensureFixInstructionForChangesRequired(task);
      addUsage(usageAcc, handoff.usage);
    } else {
      task.pendingFixInstruction = false;
    }
    task.reviewMetrics = buildMetrics('REVIEW', { startedAt, elapsedMs: Date.now() - startedAt, phase: null }, usageAcc);
    task.state = STATES.AGUARDANDO_VALIDACAO;
    saveCurrentTask(task);
    const text = handoff.note ? `${finalResult.text}\n\n---\n${handoff.note}` : finalResult.text;
    return { ...finalResult, text, gitInfo, chunked: true, totalChunks: chunks.length };
  } catch (e) {
    if (e instanceof CancelledError) {
      // cmdCancelar ja marcou o estado como CANCELADA; nao sobrescrever.
      throw e;
    }
    // Revisao nao pode ser garantida completa: NUNCA avancar para
    // AGUARDANDO_VALIDACAO nem sobrescrever lastReview com algo parcial
    // que possa parecer uma aprovacao. Gate tambem e zerado — um veredito
    // READY de uma tentativa anterior nao pode sobreviver a uma revisao
    // que falhou no meio do caminho.
    task.reviewComplete = false;
    task.reviewGate = null;
    task.reviewGateReason = null;
    task.pendingFixInstruction = false;
    task.reviewNextAction = 'Use /revisar para tentar novamente.';
    task.lastReview = `REVISAO INCOMPLETA (parte ${reviewedCount + 1}/${chunks.length} falhou): ${e.message}. NAO aprovar automaticamente — use /revisar para tentar novamente.`;
    task.state = STATES.REVISAO_MENTOR;
    saveCurrentTask(task);
    throw new Error(task.lastReview);
  } finally {
    execution.endExecution();
  }
}

export async function reviewWithMentor(task) {
  task.state = STATES.REVISAO_MENTOR;
  saveCurrentTask(task);

  const [diffStat, workspace] = await Promise.all([getDiffStat(), collectWorkspaceBlocks()]);
  const gitInfo = { status: workspace.statusText, diffStat };

  if (workspace.failures.length > 0) {
    const failList = workspace.failures.map((f) => `- ${f.file}: ${f.error}`).join('\n');
    task.reviewComplete = false;
    task.reviewGate = null;
    task.reviewGateReason = null;
    task.pendingFixInstruction = false;
    task.reviewNextAction = 'Investigue o erro e use /revisar para tentar novamente.';
    task.lastReview = `REVISAO INCOMPLETA: os seguintes arquivos NAO puderam ser revisados:\n${failList}\n\nNAO aprovar automaticamente. Investigue o erro e use /revisar para tentar novamente.`;
    task.state = STATES.REVISAO_MENTOR;
    saveCurrentTask(task);
    throw new Error(task.lastReview);
  }

  if (workspace.blocks.length === 0) {
    // Tarefa reaberta (/reabrir) por problema funcional relatado apos a
    // aprovacao: o atalho "git limpo -> nada pra revisar" NAO vale aqui —
    // teria READY/GATE antigo sem o Mentor nunca ter visto o problema
    // relatado. Consulta o Mentor mesmo sem diff, com contexto minimo (ver
    // buildReopenReviewMessage); reviewSingleShot cuida do parsing do
    // veredito, handoff de CHANGES_REQUIRED e de limpar
    // reopenPendingReview (so quando o Mentor E DE FATO consultado).
    if (task.reopenPendingReview) {
      task.reviewFingerprint = computeWorkspaceFingerprint([]);
      task.reviewedFiles = [];
      return await reviewSingleShot(task, gitInfo, buildReopenReviewMessage(task));
    }

    task.reviewComplete = true;
    // Nada para revisar -> nada bloqueando por falta de evidencia; o proprio
    // approveTask ainda rejeita com mensagem especifica ("nada para
    // aprovar") ao recolher o workspace de novo.
    task.reviewGate = 'READY';
    task.reviewGateReason = 'Nenhuma alteracao pendente no workspace.';
    task.reviewNextAction = null;
    task.pendingFixInstruction = false;
    task.reviewFingerprint = computeWorkspaceFingerprint([]);
    task.reviewedFiles = [];
    task.lastReview = 'Nenhuma alteracao pendente no workspace (git status limpo). Nada para revisar.';
    task.state = STATES.AGUARDANDO_VALIDACAO;
    saveCurrentTask(task);
    return {
      text: task.lastReview,
      sessionId: task.mentorSessionId,
      isError: false,
      resumeFailed: false,
      chunked: false,
      gitInfo,
    };
  }

  // Fingerprint do EXATO workspace que sera enviado ao Mentor — usado pelo
  // /aprovar para bloquear se qualquer coisa mudar entre a revisao e a
  // aprovacao. Calculado ANTES da chamada ao Mentor (reflete o que foi
  // mostrado a ele) e persistido pelos saveCurrentTask() dentro de
  // reviewSingleShot/reviewChunked, ja que essas funcoes salvam o `task`
  // inteiro quando reviewComplete=true.
  task.reviewFingerprint = computeWorkspaceFingerprint(workspace.blocks);
  task.reviewedFiles = workspace.blocks.map((b) => b.file);

  const totalChars = workspace.blocks.reduce((sum, b) => sum + b.text.length, 0);

  let reviewResult;
  if (totalChars <= config.maxDiffChars) {
    reviewResult = await reviewSingleShot(task, gitInfo, buildReviewMessage(task, gitInfo, workspace.blocks));
  } else {
    const fileNames = workspace.blocks.map((b) => b.file);
    const chunks = buildChunksFromBlocks(workspace.blocks, config.maxDiffChars);
    reviewResult = await reviewChunked(task, gitInfo, chunks, fileNames);
  }

  // Arquivo binario impede conclusao da revisao, MESMO que o Mentor tenha
  // avaliado normalmente todo o resto do workspace (que pode estar 100%
  // textual e revisavel). Isso e forcado aqui, depois da chamada ao Mentor,
  // para nao depender do que o texto de resposta dele diz.
  if (workspace.binaries.length > 0) {
    const list = workspace.binaries.join(', ');
    task.reviewComplete = false;
    task.reviewGate = 'BLOCKED';
    task.reviewGateReason = `Arquivos binarios nao revisaveis textualmente: ${list}.`;
    task.reviewNextAction = 'Revise os binarios manualmente (fora deste bridge) e use /revisar de novo.';
    task.pendingFixInstruction = false;
    task.reviewFingerprint = null;
    task.reviewedFiles = null;
    task.state = STATES.REVISAO_MENTOR;
    task.lastReview = [
      reviewResult.text,
      '',
      '---',
      `REVISAO INCOMPLETA: os seguintes arquivos binarios nao podem ser revisados textualmente e IMPEDEM aprovacao automatica: ${list}.`,
      'Revise esses arquivos manualmente (fora deste bridge) antes de validar. Use /revisar apos essa revisao manual se quiser reavaliar o restante.',
    ].join('\n');
    saveCurrentTask(task);
    reviewResult = { ...reviewResult, text: task.lastReview };
  }

  return reviewResult;
}

export class ApproveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApproveError';
  }
}

// Preflight de concorrencia: compara SOMENTE os arquivos revisados/aprovados
// desta tarefa (task.reviewedFiles — o mesmo conjunto coberto pelo
// fingerprint) contra o que mudou em origin/<DEFAULT_BRANCH> desde a base
// real da branch da tarefa (task.baseSha, gravado em prepareTaskBranch).
// Roda depois de fetchOrigin() e ANTES de qualquer git add/commit/push.
//
// So leitura (getNameStatusDiff nunca muta o repo): nunca faz merge/rebase/
// stash/reset/force-push, nunca resolve conflito nem restaura arquivo
// removido pela main — so decide bloquear ou nao. Detecta no minimo
// modificado (M), removido (D) e renomeado (R, via -M em getNameStatusDiff);
// qualquer outro status de linha (ex: T) e tratado como "modificado" por
// seguranca. Retorna a lista de conflitos (nunca vazia quando ha bloqueio)
// ou null quando nao ha divergencia.
//
// Tarefas antigas sem baseSha (criadas antes deste preflight existir) nao
// tem base confiavel para comparar — o preflight e pulado nesse caso
// (fail-open aqui e intencional: nao ha commit/base real para checar contra,
// e as demais checagens de approveTask — branch atual, fingerprint do
// workspace, fetch previo — continuam valendo do mesmo jeito).
export async function checkOriginConcurrency(task) {
  if (!task.baseSha) return null;
  const reviewedFiles = task.reviewedFiles || [];
  if (reviewedFiles.length === 0) return null;

  let diffEntries;
  try {
    diffEntries = await getNameStatusDiff(task.baseSha, `origin/${DEFAULT_BRANCH}`);
  } catch (e) {
    throw new ApproveError(
      `Nao foi possivel checar concorrencia com origin/${DEFAULT_BRANCH} desde a base da tarefa (${task.baseSha.slice(0, 8)}): ${e.message}`
    );
  }

  const reviewedSet = new Set(reviewedFiles);
  const conflicts = [];
  for (const entry of diffEntries) {
    if (entry.status === 'R') {
      if (reviewedSet.has(entry.file) || reviewedSet.has(entry.newFile)) {
        conflicts.push({ file: `${entry.file} -> ${entry.newFile}`, type: 'renomeado' });
      }
      continue;
    }
    if (!reviewedSet.has(entry.file)) continue;
    if (entry.status === 'D') {
      conflicts.push({ file: entry.file, type: 'removido' });
    } else {
      conflicts.push({ file: entry.file, type: 'modificado' });
    }
  }
  return conflicts.length > 0 ? conflicts : null;
}

// Pede ao Mentor, numa UNICA chamada (resume da mesma sessao que ja
// revisou o diff — nao reenvia o diff de novo, so o formato exigido), a
// mensagem de commit + titulo/descricao de PR em formato curto e
// estruturado. Formato fixo para permitir parsing confiavel.
function buildApprovalMessage(task, statusText) {
  return [
    '## Geracao de commit e PR',
    '',
    'A implementacao que voce ja revisou nesta sessao esta pronta para commit. Baseando-se no diff que voce ja viu, gere APENAS o seguinte, no formato exato abaixo (sem texto antes/depois dos marcadores):',
    '',
    '### COMMIT',
    '<mensagem de commit em uma linha, estilo convencional (fix:/feat:/chore:/refactor:), em portugues>',
    '',
    '### PR_TITLE',
    '<titulo curto da PR, uma linha>',
    '',
    '### PR_BODY',
    '<descricao da PR em PT-BR: o que mudou e por que, curta e objetiva>',
    '',
    '### Arquivos no commit',
    statusText,
    '',
    `Solicitacao original: ${task.request || '(nao informada)'}`,
  ].join('\n');
}

function parseApprovalResponse(text) {
  const grab = (label) => {
    const re = new RegExp(`###\\s*${label}\\s*\\n([\\s\\S]*?)(?=\\n###|\\s*$)`, 'i');
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  const commitRaw = grab('COMMIT');
  const prTitleRaw = grab('PR_TITLE');
  const prBody = grab('PR_BODY');
  const commit = commitRaw ? commitRaw.split('\n')[0].trim() : null;
  const prTitle = prTitleRaw ? prTitleRaw.split('\n')[0].trim() : null;
  return { commit, prTitle, prBody, ok: Boolean(commit && prTitle && prBody) };
}

// Cria a PR (ou reutiliza uma ja aberta para a branch — nunca duplica) e
// persiste prUrl/prNumber na tarefa. base e SEMPRE DEFAULT_BRANCH ('main');
// nunca merge, nunca outro remote (createOrGetPullRequest so fala com
// 'origin', via a URL do proprio remote).
async function createPrForTask(task) {
  let pr;
  try {
    pr = await createOrGetPullRequest({
      base: DEFAULT_BRANCH,
      head: task.gitBranch,
      title: task.prTitle,
      body: task.prBody,
    });
  } catch (e) {
    throw new ApproveError(
      `Commit e push ja feitos (commit ${task.approvedCommitSha.slice(0, 8)}), mas a criacao da PR falhou: ${e.message}. Use /aprovar novamente para tentar so a criacao da PR — commit/push nao serao repetidos.`
    );
  }
  task.prUrl = pr.url;
  task.prNumber = pr.number;
  saveCurrentTask(task);
  return pr;
}

// Fluxo /aprovar (commitar + publicar a branch da tarefa + criar/reutilizar
// a PR no origin). Roda inteiramente pelo bridge; a unica chamada a Claude e
// ao Mentor (nunca ao Dev), e so para gerar o texto do commit/PR — nunca
// para decidir git add/commit/push/criacao de PR, que sao sempre feitos
// diretamente aqui.
//
// Idempotencia em 3 camadas, da mais para a menos concluida — cada uma pula
// direto para o proximo passo pendente, sem repetir o que ja foi feito nem
// chamar o Mentor de novo:
// 1. task.prUrl definido -> tudo pronto, so retorna o que ja existe.
// 2. task.approvedCommitSha definido (sem prUrl) -> commit+push ja feitos,
//    so falta criar/confirmar a PR.
// 3. task.localCommitSha definido (sem approvedCommitSha) -> commit local
//    existe mas o push de uma tentativa anterior falhou; so reenvia o push
//    e segue para a PR.
export async function approveTask(task) {
  if (task.prUrl) {
    return {
      alreadyApproved: true,
      commitSha: task.approvedCommitSha,
      branch: task.gitBranch,
      prTitle: task.prTitle,
      prBody: task.prBody,
      prUrl: task.prUrl,
      prNumber: task.prNumber,
    };
  }

  if (task.approvedCommitSha) {
    const pr = await createPrForTask(task);
    return {
      alreadyApproved: false,
      resumedPush: false,
      resumedPrOnly: true,
      commitSha: task.approvedCommitSha,
      branch: task.gitBranch,
      prTitle: task.prTitle,
      prBody: task.prBody,
      prUrl: pr.url,
      prNumber: pr.number,
      prReused: pr.reused,
    };
  }

  if (task.localCommitSha) {
    try {
      await pushSetUpstream('origin', task.gitBranch);
    } catch (e) {
      throw new ApproveError(
        `Push falhou novamente: ${e.message}. Commit local (${task.localCommitSha.slice(0, 8)}) preservado — use /aprovar de novo para tentar o push mais tarde.`
      );
    }
    task.approvedCommitSha = task.localCommitSha;
    task.approvedAt = new Date().toISOString();
    task.state = STATES.APROVADA;
    saveCurrentTask(task);

    const pr = await createPrForTask(task);
    return {
      alreadyApproved: false,
      resumedPush: true,
      resumedPrOnly: false,
      commitSha: task.approvedCommitSha,
      branch: task.gitBranch,
      prTitle: task.prTitle,
      prBody: task.prBody,
      prUrl: pr.url,
      prNumber: pr.number,
      prReused: pr.reused,
    };
  }

  if (task.state !== STATES.AGUARDANDO_VALIDACAO) {
    throw new ApproveError(`Tarefa nao esta aguardando validacao (estado atual: ${task.state}).`);
  }
  if (!task.reviewComplete) {
    throw new ApproveError('Revisao do Mentor incompleta ou nao aprovada. Rode /revisar e resolva as pendencias antes de aprovar.');
  }
  if (task.reviewGate !== 'READY') {
    const reason = task.reviewGateReason ? ` Motivo: ${task.reviewGateReason}` : '';
    const next = task.reviewNextAction ? ` Proximo passo: ${task.reviewNextAction}` : '';
    throw new ApproveError(
      `Revisao do Mentor nao esta READY (status: ${task.reviewGate || 'INDEFINIDO'}).${reason}${next}`
    );
  }
  if (!task.gitBranch) {
    throw new ApproveError('Tarefa sem branch associada — nada para aprovar.');
  }

  const currentBranch = await getCurrentBranch();
  if (currentBranch !== task.gitBranch) {
    throw new ApproveError(
      `Branch atual (${currentBranch || '(nenhuma — HEAD destacado?)'}) diferente da branch da tarefa (${task.gitBranch}). O bridge nao troca de branch automaticamente.`
    );
  }

  try {
    await fetchOrigin();
  } catch (e) {
    throw new ApproveError(`git fetch origin falhou: ${e.message}`);
  }

  // Preflight de concorrencia — ver checkOriginConcurrency. Roda antes de
  // qualquer git add/commit/push: se houver divergencia nos arquivos
  // revisados, interrompe aqui (nenhum commit, nenhum push, branch
  // intocada) e reporta BLOCKED com a lista de arquivos afetados.
  const conflicts = await checkOriginConcurrency(task);
  if (conflicts) {
    const list = conflicts.map((c) => `- ${c.file}: ${c.type}`).join('\n');
    throw new ApproveError(
      [
        `BLOCKED: alteracoes concorrentes detectadas em origin/${DEFAULT_BRANCH} desde a base da tarefa (${task.baseSha.slice(0, 8)}).`,
        'Nenhum commit ou push foi feito; a branch da tarefa nao foi alterada.',
        '',
        'Arquivos revisados que divergiram em origin/main:',
        list,
        '',
        'Resolva manualmente (sem force-push/reset/clean/stash/merge/rebase automatico) e rode /revisar novamente antes de tentar /aprovar de novo.',
      ].join('\n')
    );
  }

  const workspace = await collectWorkspaceBlocks();
  if (workspace.failures.length > 0) {
    throw new ApproveError(
      `Nao foi possivel reavaliar o workspace: ${workspace.failures.map((f) => `${f.file}: ${f.error}`).join('; ')}`
    );
  }
  if (workspace.binaries.length > 0) {
    throw new ApproveError(`Arquivos binarios presentes (${workspace.binaries.join(', ')}) impedem aprovacao automatica.`);
  }
  if (workspace.blocks.length === 0) {
    throw new ApproveError('Nada para aprovar: workspace sem alteracoes.');
  }

  const currentFingerprint = computeWorkspaceFingerprint(workspace.blocks);
  if (currentFingerprint !== task.reviewFingerprint) {
    throw new ApproveError(
      'O workspace mudou desde a ultima revisao do Mentor (fingerprint nao bate). Rode /revisar novamente antes de aprovar.'
    );
  }

  let divergence = null;
  try {
    const behind = await getRevListCount(`HEAD..origin/${DEFAULT_BRANCH}`);
    const ahead = await getRevListCount(`origin/${DEFAULT_BRANCH}..HEAD`);
    divergence = { behind, ahead };
  } catch {
    divergence = null;
  }

  const result = await runClaude({
    message: buildApprovalMessage(task, workspace.statusText),
    systemPrompt: getMentorSystemPrompt(),
    tools: MENTOR_TOOLS,
    sessionId: task.mentorSessionId,
    timeoutMs: config.mentorTimeoutMs,
  });
  task.mentorSessionId = result.sessionId;
  saveCurrentTask(task);

  const parsed = parseApprovalResponse(result.text);
  const commitMessage = parsed.commit || `chore: alteracoes da tarefa ${task.id}`;
  const prTitle = parsed.prTitle || (task.request ? task.request.slice(0, 72) : `Tarefa ${task.id}`);
  const prBody = parsed.prBody || task.lastReview || '(sem descricao gerada)';

  const reviewedFiles = workspace.blocks.map((b) => b.file);

  try {
    await stageFiles(reviewedFiles);
  } catch (e) {
    throw new ApproveError(`git add falhou: ${e.message}`);
  }

  let commitSha;
  try {
    await gitCommit(commitMessage);
    commitSha = await getRevParse('HEAD');
  } catch (e) {
    throw new ApproveError(`git commit falhou: ${e.message}`);
  }

  task.localCommitSha = commitSha;
  task.commitMessage = commitMessage;
  task.prTitle = prTitle;
  task.prBody = prBody;
  saveCurrentTask(task);

  try {
    await pushSetUpstream('origin', task.gitBranch);
  } catch (e) {
    throw new ApproveError(
      `Commit feito localmente (${commitSha.slice(0, 8)}) mas o push falhou: ${e.message}. Use /aprovar novamente para tentar o push de novo.`
    );
  }

  task.approvedCommitSha = commitSha;
  task.approvedAt = new Date().toISOString();
  task.state = STATES.APROVADA;
  saveCurrentTask(task);

  const pr = await createPrForTask(task);

  return {
    alreadyApproved: false,
    resumedPush: false,
    resumedPrOnly: false,
    commitSha,
    branch: task.gitBranch,
    prTitle,
    prBody,
    prUrl: pr.url,
    prNumber: pr.number,
    prReused: pr.reused,
    divergence,
    parseFallbackUsed: !parsed.ok,
  };
}
