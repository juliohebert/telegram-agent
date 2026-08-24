import fs from 'node:fs';
import { config } from './config.js';

const API_BASE = `https://api.telegram.org/bot${config.telegramBotToken}`;
const FILE_BASE = `https://api.telegram.org/file/bot${config.telegramBotToken}`;
const MAX_MESSAGE_LEN = 3900;

function apiUrl(method) {
  return `${API_BASE}/${method}`;
}

// Nunca logar a URL/token: em caso de erro, expor apenas o metodo e o status.
async function callApi(method, body, { timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(apiUrl(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.ok === false) {
      const desc = json?.description ?? `HTTP ${res.status}`;
      throw new Error(`Telegram API (${method}) falhou: ${desc}`);
    }
    return json.result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function getUpdates(offset, timeoutSeconds = 25) {
  return callApi(
    'getUpdates',
    { offset, timeout: timeoutSeconds, allowed_updates: ['message'] },
    { timeoutMs: (timeoutSeconds + 10) * 1000 }
  );
}

// Prefixos padronizados por origem da mensagem, usados como primeira linha
// (em negrito) de cada envio.
export const PREFIX = {
  MENTOR: '\u{1F9E0} MENTOR',
  DEV: '\u{1F4BB} DESENVOLVEDOR',
  REVIEW: '\u{1F50E} REVISAO',
  SYSTEM: '⚙️ SISTEMA',
  TRANSCRIPTION: '\u{1F399}️ TRANSCRICAO',
};

function splitPlainMessage(text, maxLen = MAX_MESSAGE_LEN) {
  if (text.length <= maxLen) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.length) parts.push(rest);
  return parts;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const PH_OPEN = '';
const PH_CLOSE = '';

// Converte um subconjunto de Markdown (o que o Mentor/Dev efetivamente
// produzem) para HTML suportado pelo Telegram. Escapa o texto bruto ANTES
// de inserir qualquer tag, para nunca deixar caracteres do conteudo
// original quebrarem o parser de entidades do Telegram.
function mdToTelegramHtml(raw) {
  let text = escapeHtml(raw);

  // blocos de codigo cercados por crases triplas -> <pre><code>...</code></pre>.
  // Extraidos para placeholder ANTES de qualquer outra transformacao, para
  // nao formatar o conteudo interno do bloco. PH_OPEN/PH_CLOSE usam
  // caracteres da area de uso privado do Unicode, que nunca aparecem em
  // texto real, entao nao ha risco de colisao com conteudo legitimo.
  const blocks = [];
  text = text.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_match, code) => {
    const idx = blocks.push(code.replace(/\n$/, '')) - 1;
    return PH_OPEN + 'B' + idx + PH_CLOSE;
  });

  // codigo inline entre crases simples -> <code>...</code> (tambem extraido antes do resto).
  const inlines = [];
  text = text.replace(/`([^`\n]+)`/g, (_match, code) => {
    const idx = inlines.push(code) - 1;
    return PH_OPEN + 'I' + idx + PH_CLOSE;
  });

  // titulos "#" a "######" -> negrito
  text = text.replace(/^#{1,6}[ \t]+(.+)$/gm, (_match, t) => `<b>${t.trim()}</b>`);

  // **negrito**
  text = text.replace(/\*\*([^\n*]+?)\*\*/g, '<b>$1</b>');

  // listas "- item" / "* item" -> bullet
  text = text.replace(/^[ \t]*[-*][ \t]+(.+)$/gm, '• $1');

  const phRe = new RegExp(`${PH_OPEN}([BI])(\\d+)${PH_CLOSE}`, 'g');
  text = text.replace(phRe, (_match, kind, i) =>
    kind === 'I' ? `<code>${inlines[Number(i)]}</code>` : `<pre><code>${blocks[Number(i)]}</code></pre>`
  );

  return text;
}

const PRE_BLOCK_RE = /<pre><code>[\s\S]*?<\/code><\/pre>/g;
const PRE_WRAP_LEN = '<pre><code></code></pre>'.length;

// Divide HTML ja convertido em partes <= maxLen SEM cortar no meio de uma
// tag ou de um bloco <pre><code>...</code></pre>. Blocos de codigo sao
// tratados como unidade atomica; se um bloco sozinho exceder maxLen, seu
// conteudo e dividido por linha e cada parte reembrulhada em
// <pre><code>...</code></pre> proprio (HTML sempre bem formado). Texto fora
// de blocos e dividido em limites de linha, entao tags inline curtas
// (<b>, <code>) - que nunca ocupam mais de uma linha na pratica - nunca sao
// cortadas ao meio.
function splitHtmlMessage(html, maxLen = MAX_MESSAGE_LEN) {
  const tokens = [];
  let lastIndex = 0;
  let m;
  PRE_BLOCK_RE.lastIndex = 0;
  while ((m = PRE_BLOCK_RE.exec(html))) {
    if (m.index > lastIndex) tokens.push({ type: 'text', content: html.slice(lastIndex, m.index) });
    tokens.push({ type: 'block', content: m[0] });
    lastIndex = PRE_BLOCK_RE.lastIndex;
  }
  if (lastIndex < html.length) tokens.push({ type: 'text', content: html.slice(lastIndex) });

  const chunks = [];
  let current = '';
  const flush = () => {
    if (current) {
      chunks.push(current);
      current = '';
    }
  };

  for (const token of tokens) {
    if (token.type === 'block') {
      if (token.content.length > maxLen) {
        flush();
        const inner = token.content.slice('<pre><code>'.length, -'</code></pre>'.length);
        for (const part of splitPlainMessage(inner, Math.max(maxLen - PRE_WRAP_LEN, 200))) {
          chunks.push(`<pre><code>${part}</code></pre>`);
        }
        continue;
      }
      if (current.length + token.content.length > maxLen) flush();
      current += token.content;
      continue;
    }

    const lines = token.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] + (i < lines.length - 1 ? '\n' : '');
      if (line.length > maxLen) {
        flush();
        for (let j = 0; j < line.length; j += maxLen) {
          chunks.push(line.slice(j, j + maxLen));
        }
        continue;
      }
      if (current.length + line.length > maxLen) flush();
      current += line;
    }
  }
  flush();
  return chunks.length ? chunks : [''];
}

// Resolve o file_path do Telegram a partir de um file_id (necessario antes
// do download). Nao contem o token, seguro de logar se preciso.
export async function getFile(fileId) {
  return callApi('getFile', { file_id: fileId }, { timeoutMs: 20000 });
}

// Baixa o arquivo (voice/audio) para destPath. A URL de download embute o
// token - nunca e logada nem incluida em mensagens de erro; erros expoem
// apenas o status HTTP.
export async function downloadFile(filePath, destPath) {
  const url = `${FILE_BASE}/${filePath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`download do arquivo falhou (HTTP ${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    return destPath;
  } finally {
    clearTimeout(timer);
  }
}

async function sendParts(chatId, parts, parseMode) {
  const total = parts.length;
  for (let i = 0; i < parts.length; i++) {
    const pageMarker = total > 1 ? `[${i + 1}/${total}]\n` : '';
    const body = { chat_id: chatId, text: pageMarker + parts[i], disable_web_page_preview: true };
    if (parseMode) body.parse_mode = parseMode;
    await callApi('sendMessage', body);
  }
}

// Envia uma mensagem formatada (Markdown -> HTML) ao Telegram, com prefixo
// padronizado opcional (use PREFIX.*). Se o envio em HTML falhar (ex: uma
// entidade mal formada que a conversao nao previu), cai automaticamente
// para texto simples sem parse_mode, garantindo que o conteudo chegue.
export async function sendMessage(chatId, text, prefixLabel) {
  const raw = text && text.trim() ? text : '(resposta vazia)';

  let html = mdToTelegramHtml(raw);
  if (prefixLabel) html = `<b>${prefixLabel}</b>\n${html}`;

  try {
    await sendParts(chatId, splitHtmlMessage(html), 'HTML');
  } catch (e) {
    console.error(`Falha ao enviar em HTML, usando texto simples: ${e.message}`);
    const plain = prefixLabel ? `${prefixLabel}\n${raw}` : raw;
    await sendParts(chatId, splitPlainMessage(plain), undefined);
  }
}
