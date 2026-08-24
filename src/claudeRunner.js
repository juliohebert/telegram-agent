import { spawn } from 'node:child_process';
import { config } from './config.js';
import { registerActive, clearActive, killTreeByPid, CancelledError } from './processRegistry.js';

function spawnClaude(args, message, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, shell: false });
    const handle = registerActive(child);
    let out = '';
    let err = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTreeByPid(child.pid);
    }, timeoutMs);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      clearActive(handle);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearActive(handle);
      if (handle.cancelled) {
        reject(new CancelledError());
        return;
      }
      if (timedOut) {
        reject(new Error(`Claude CLI excedeu o tempo limite (${timeoutMs}ms) e foi encerrado (processo e filhos mortos).`));
        return;
      }
      resolve({ code, out, err });
    });

    child.stdin.write(message);
    child.stdin.end();
  });
}

function buildArgs({ systemPrompt, tools, disallowedTools, settingsJson, sessionId, stream }) {
  const args = [
    '-p',
    '--output-format', stream ? 'stream-json' : 'json',
    // --include-partial-messages: sem ele, o campo `usage` de cada evento
    // "assistant" e so o snapshot inicial (message_start), com output_tokens
    // sempre baixo/placeholder — confirmado com o CLI real (usage somado por
    // mensagem via "assistant" ficou ~20 tokens de output onde o total
    // verdadeiro era ~1583). Com a flag, os eventos brutos do protocolo
    // (stream_event > message_delta) trazem o usage final e correto por
    // mensagem, inclusive output_tokens — e a soma por mensagem bateu
    // exatamente com o `usage` do evento final "result" em teste real.
    ...(stream ? ['--verbose', '--include-partial-messages'] : []),
    '--append-system-prompt', systemPrompt,
    '--tools', tools,
    '--permission-mode', 'bypassPermissions',
    '--model', config.claudeModel,
  ];
  if (disallowedTools) {
    args.push('--disallowedTools', disallowedTools);
  }
  if (settingsJson) {
    args.push('--settings', settingsJson);
  }
  if (sessionId) {
    args.push('--resume', sessionId);
  }
  return args;
}

async function attempt({ message, systemPrompt, tools, disallowedTools, settingsJson, sessionId, timeoutMs }) {
  const args = buildArgs({ systemPrompt, tools, disallowedTools, settingsJson, sessionId });
  const { code, out, err } = await spawnClaude(args, message, config.userpulsePath, timeoutMs);

  let parsed = null;
  try {
    parsed = JSON.parse(out.trim());
  } catch {
    // segue com parsed=null
  }

  if (!parsed) {
    throw new Error(
      `Claude CLI retornou saida invalida (codigo ${code}). stderr: ${err.trim().slice(0, 500) || '(vazio)'}`
    );
  }

  return {
    text: parsed.result ?? '(sem resposta)',
    sessionId: parsed.session_id ?? null,
    isError: Boolean(parsed.is_error),
    subtype: parsed.subtype,
    permissionDenials: parsed.permission_denials ?? [],
    // Consumo real de tokens desta chamada, reportado pelo proprio Claude
    // CLI (nunca estimado por tamanho de texto). Mesmo shape em json e
    // stream-json: input_tokens/output_tokens/cache_creation_input_tokens/
    // cache_read_input_tokens. Pode ser null se o CLI nao devolver usage.
    usage: parsed.usage ?? null,
  };
}

// Variante streaming de spawnClaude: le stdout como NDJSON (uma linha =
// um evento) a medida que chega, chamando onEvent(evento) para cada linha —
// usado para telemetria em tempo real (fase/tokens do Dev, ver
// taskManager.js). O evento final (type: "result") tem o mesmo shape do
// modo json nao-streaming, inclusive `usage`.
function spawnClaudeStreaming(args, message, cwd, timeoutMs, onEvent) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, shell: false });
    const handle = registerActive(child);
    let buffer = '';
    let err = '';
    let timedOut = false;
    let finalEvent = null;

    const timer = setTimeout(() => {
      timedOut = true;
      killTreeByPid(child.pid);
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      buffer += d.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue; // linha nao-JSON inesperada: ignora, nunca derruba o processo
        }
        if (evt.type === 'result') finalEvent = evt;
        if (onEvent) {
          try {
            onEvent(evt);
          } catch {
            // erro no callback do chamador nunca deve interromper o parsing do stream
          }
        }
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      clearActive(handle);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearActive(handle);
      if (handle.cancelled) {
        reject(new CancelledError());
        return;
      }
      if (timedOut) {
        reject(new Error(`Claude CLI excedeu o tempo limite (${timeoutMs}ms) e foi encerrado (processo e filhos mortos).`));
        return;
      }
      if (!finalEvent) {
        reject(
          new Error(
            `Claude CLI (stream) encerrou (codigo ${code}) sem evento final "result". stderr: ${err.trim().slice(0, 500) || '(vazio)'}`
          )
        );
        return;
      }
      resolve(finalEvent);
    });

    child.stdin.write(message);
    child.stdin.end();
  });
}

async function attemptStreaming({ message, systemPrompt, tools, disallowedTools, settingsJson, sessionId, timeoutMs, onEvent }) {
  const args = buildArgs({ systemPrompt, tools, disallowedTools, settingsJson, sessionId, stream: true });
  const parsed = await spawnClaudeStreaming(args, message, config.userpulsePath, timeoutMs, onEvent);

  return {
    text: parsed.result ?? '(sem resposta)',
    sessionId: parsed.session_id ?? null,
    isError: Boolean(parsed.is_error),
    subtype: parsed.subtype,
    permissionDenials: parsed.permission_denials ?? [],
    usage: parsed.usage ?? null,
  };
}

/**
 * Como runClaude, mas via --output-format stream-json: chama onEvent(evento)
 * para cada linha NDJSON recebida em tempo real (tool_use, mensagens
 * intermediarias, etc), alem de resolver com o resultado final (mesmo shape
 * de runClaude, incluindo usage). Usado quando o chamador precisa acompanhar
 * o progresso da execucao (telemetria de fase/tokens), nao so o resultado.
 */
export async function runClaudeStreaming({
  message,
  systemPrompt,
  tools,
  disallowedTools,
  settingsJson,
  sessionId,
  timeoutMs,
  onEvent,
}) {
  try {
    const result = await attemptStreaming({ message, systemPrompt, tools, disallowedTools, settingsJson, sessionId, timeoutMs, onEvent });
    return { ...result, resumeFailed: false };
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    if (!sessionId) throw e;
    const result = await attemptStreaming({
      message,
      systemPrompt,
      tools,
      disallowedTools,
      settingsJson,
      sessionId: null,
      timeoutMs,
      onEvent,
    });
    return { ...result, resumeFailed: true };
  }
}

/**
 * Executa o Claude CLI em modo print, alimentando o prompt via stdin.
 * Se um sessionId for informado e o resume falhar, tenta novamente uma vez
 * sem --resume (nova sessao), sinalizando resumeFailed=true no retorno.
 */
export async function runClaude({ message, systemPrompt, tools, disallowedTools, settingsJson, sessionId, timeoutMs }) {
  try {
    const result = await attempt({ message, systemPrompt, tools, disallowedTools, settingsJson, sessionId, timeoutMs });
    return { ...result, resumeFailed: false };
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    if (!sessionId) throw e;
    // fallback: sessao anterior pode ter expirado/sido perdida — tenta uma sessao nova
    const result = await attempt({ message, systemPrompt, tools, disallowedTools, settingsJson, sessionId: null, timeoutMs });
    return { ...result, resumeFailed: true };
  }
}
