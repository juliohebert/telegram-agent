import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

function readPrompt(fileName) {
  const filePath = path.join(config.promptsPath, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Arquivo de prompt nao encontrado: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

let cache = null;
let mentorPromptVersion = null;

function loadAll() {
  if (!cache) {
    cache = {
      shared: readPrompt('shared.md'),
      mentor: readPrompt('mentor.md'),
      developer: readPrompt('developer.md'),
    };
    mentorPromptVersion = crypto
      .createHash('sha256')
      .update(`${cache.shared}\n\n${cache.mentor}`, 'utf8')
      .digest('hex')
      .slice(0, 12);
  }
  return cache;
}

export function getMentorSystemPrompt() {
  const { shared, mentor } = loadAll();
  return `${shared}\n\n${mentor}`;
}

export function getDeveloperSystemPrompt() {
  const { shared, developer } = loadAll();
  return `${shared}\n\n${developer}`;
}

// Fingerprint curto do system prompt do Mentor (shared+mentor.md), calculado
// uma vez por processo (mesmo cache de loadAll). Serve so para detectar,
// sem reconstruir o sistema de sessoes, quando uma tarefa persistida foi
// conversada por uma versao diferente do prompt (ex: mentor.md mudou e o
// bridge nao foi reiniciado, ou a task e antiga) — ver task.mentorPromptVersion
// em taskManager.js e o aviso correspondente em /status.
export function getMentorPromptVersion() {
  loadAll();
  return mentorPromptVersion;
}
