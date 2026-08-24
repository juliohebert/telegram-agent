import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

try {
  process.loadEnvFile(path.join(projectRoot, '.env'));
} catch {
  // .env ausente: seguimos com o ambiente do processo (ex: variaveis exportadas manualmente)
}

function required(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `Variavel de ambiente obrigatoria ausente: ${name}. Configure o arquivo .env (veja .env na raiz do projeto) e tente novamente.`
    );
  }
  return value.trim();
}

function optional(name, fallback) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function loadConfig() {
  const telegramBotToken = required('TELEGRAM_BOT_TOKEN');
  const allowedChatId = required('TELEGRAM_ALLOWED_CHAT_ID');
  const allowedUserId = required('TELEGRAM_ALLOWED_USER_ID');
  const userpulsePath = required('USERPULSE_PATH');
  const promptsPath = required('PROMPTS_PATH');

  if (!fs.existsSync(userpulsePath) || !fs.statSync(userpulsePath).isDirectory()) {
    throw new Error(`USERPULSE_PATH nao existe ou nao e um diretorio: ${userpulsePath}`);
  }
  if (!fs.existsSync(promptsPath) || !fs.statSync(promptsPath).isDirectory()) {
    throw new Error(`PROMPTS_PATH nao existe ou nao e um diretorio: ${promptsPath}`);
  }

  return {
    telegramBotToken,
    allowedChatId,
    allowedUserId,
    userpulsePath,
    promptsPath,
    // Isolamento de state para testes: sem STATE_DIR no ambiente, o
    // comportamento em producao e identico ao de sempre (state/ dentro do
    // projeto). Testes isolados DEVEM setar STATE_DIR para um diretorio
    // temporario proprio antes de importar este modulo — nunca reaproveitar
    // o state real, mesmo apontando USERPULSE_PATH para um repo isolado
    // (causou perda real de state em testes anteriores: o teste mudava
    // USERPULSE_PATH mas o stateDir continuava fixo no projeto real).
    stateDir: optional('STATE_DIR', path.join(projectRoot, 'state')),
    claudeModel: optional('CLAUDE_MODEL', 'sonnet'),
    mentorTimeoutMs: Number(optional('CLAUDE_MENTOR_TIMEOUT_MS', '300000')),
    devTimeoutMs: Number(optional('CLAUDE_DEV_TIMEOUT_MS', '900000')),
    maxDiffChars: Number(optional('MAX_DIFF_CHARS', '60000')),
    // Transcricao de audio/voz (opcional): so e exigido quando o usuario
    // efetivamente envia um audio pelo Telegram, nao bloqueia o startup.
    whisperModelPath: optional('WHISPER_MODEL_PATH', path.join(projectRoot, 'models', 'ggml-small.bin')),
    whisperLanguage: optional('WHISPER_LANGUAGE', 'pt'),
    whisperQueueSeconds: Number(optional('WHISPER_QUEUE_SECONDS', '15')),
    audioTimeoutMs: Number(optional('AUDIO_TRANSCRIBE_TIMEOUT_MS', '120000')),
    maxAudioDurationSeconds: Number(optional('MAX_AUDIO_DURATION_SECONDS', '300')),
    maxAudioFileSizeBytes: Number(optional('MAX_AUDIO_FILE_SIZE_MB', '20')) * 1024 * 1024,
    // Alertas de consumo de tokens da execucao do Dev (telemetria — ver
    // src/execution.js). WARNING so aparece discretamente no /status; HIGH e
    // CRITICAL disparam alerta no Telegram. Nunca cancelam a execucao.
    devTokenWarning: Number(optional('DEV_TOKEN_WARNING', '30000')),
    devTokenHigh: Number(optional('DEV_TOKEN_HIGH', '50000')),
    devTokenCritical: Number(optional('DEV_TOKEN_CRITICAL', '75000')),
    // Workspace dedicado de validacao local (/validar, ver src/validation.js)
    // — clone exclusivo do MESMO origin do UserPulse-agent, nunca do
    // UserPulse original (historia Clinic/Quark). Opcional: sem essa var,
    // /validar explica o que falta configurar em vez de travar o bridge
    // inteiro no boot (diferente de USERPULSE_PATH, que e sempre exigido).
    validationPath: optional('USERPULSE_VALIDATION_PATH', null),
  };
}

export const config = loadConfig();
