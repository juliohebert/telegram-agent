import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { getFile, downloadFile } from './telegram.js';

const TMP_DIR = path.join(config.stateDir, 'tmp');

function ensureTmpDir() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

export function cleanupFile(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // limpeza e best-effort; nao derruba o bot por falha ao apagar temporario
  }
}

// Baixa um voice/audio do Telegram (via file_id) para um arquivo temporario
// local em state/tmp. Nunca loga o file_path/URL (contem o token embutido
// na URL de download, tratado dentro de telegram.js).
export async function downloadTelegramAudio(fileId, suggestedExt) {
  ensureTmpDir();
  let fileInfo;
  try {
    fileInfo = await getFile(fileId);
  } catch (e) {
    throw new Error(`nao foi possivel obter o arquivo no Telegram: ${e.message}`);
  }
  if (!fileInfo?.file_path) {
    throw new Error('Telegram nao retornou o arquivo (pode exceder 20MB, limite da API de bots para download)');
  }
  const ext = path.extname(fileInfo.file_path) || suggestedExt || '.ogg';
  const localPath = path.join(TMP_DIR, `${crypto.randomUUID()}${ext}`);
  try {
    await downloadFile(fileInfo.file_path, localPath);
  } catch (e) {
    throw new Error(`falha ao baixar o audio: ${e.message}`);
  }
  return localPath;
}

// Converte um caminho absoluto em relativo a `cwd`, usando barras normais.
// O filtro `-af whisper=model=...:destination=...` do ffmpeg usa ':' como
// separador de opcoes, entao um caminho absoluto do Windows ("C:\...")
// quebra o parser (o driveletter colon e interpretado como fim do valor).
// Caminho relativo (sem letra de unidade) evita o problema por completo.
function toFilterPath(cwd, absPath) {
  const rel = path.relative(cwd, absPath).replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(rel) || rel === '') {
    throw new Error(
      `nao foi possivel referenciar "${absPath}" de forma relativa a "${cwd}" (estao em unidades/drives diferentes?). ` +
        'Coloque o modelo Whisper na mesma unidade do projeto (ex: dentro de telegram-agent/models).'
    );
  }
  return rel;
}

function runFfmpeg(args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { cwd, shell: false });
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`transcricao excedeu o tempo limite (${timeoutMs}ms) e foi encerrada`));
        return;
      }
      resolve({ code, err });
    });
  });
}

// Transcreve um arquivo de audio local usando o filtro `whisper` do ffmpeg
// (whisper.cpp embutido) — 100% local, sem API paga. Requer:
// - um build de ffmpeg com --enable-whisper (ex: builds "full" do gyan.dev
//   no Windows; confirme com `ffmpeg -h filter=whisper`);
// - um modelo ggml baixado em config.whisperModelPath.
export async function transcribeAudioFile(audioPath) {
  if (!fs.existsSync(config.whisperModelPath)) {
    throw new Error(
      `modelo Whisper nao encontrado em ${config.whisperModelPath}. Baixe um modelo ggml multilingue ` +
        '(ex: https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin) e salve nesse caminho, ' +
        'ou configure WHISPER_MODEL_PATH.'
    );
  }

  ensureTmpDir();
  const outputPath = path.join(TMP_DIR, `${crypto.randomUUID()}.txt`);

  try {
    const modelRel = toFilterPath(config.stateDir, config.whisperModelPath);
    const outRel = toFilterPath(config.stateDir, outputPath);
    const filter = `whisper=model=${modelRel}:language=${config.whisperLanguage}:queue=${config.whisperQueueSeconds}:format=text:destination=${outRel}`;

    const { code, err } = await runFfmpeg(
      ['-y', '-i', audioPath, '-vn', '-ar', '16000', '-ac', '1', '-af', filter, '-f', 'null', '-'],
      config.stateDir,
      config.audioTimeoutMs
    );

    if (code !== 0) {
      if (/Unknown filter|No such filter|No option name/i.test(err)) {
        throw new Error(
          'este ffmpeg nao tem o filtro "whisper" (whisper.cpp) habilitado ou ha um erro de configuracao do filtro. ' +
            'Confirme com `ffmpeg -h filter=whisper`; instale um build com --enable-whisper se necessario.'
        );
      }
      // a saida do ffmpeg comeca com um banner de versao/build verboso; o
      // erro util de verdade fica no final, entao pegamos a cauda.
      throw new Error(`ffmpeg falhou (codigo ${code}): ${err.trim().slice(-400) || '(sem detalhes)'}`);
    }
    if (!fs.existsSync(outputPath)) {
      // Sem fala reconhecivel gera saida vazia/ausente, nao um erro de codigo.
      return '';
    }
    return fs.readFileSync(outputPath, 'utf8').trim();
  } finally {
    cleanupFile(outputPath);
  }
}
