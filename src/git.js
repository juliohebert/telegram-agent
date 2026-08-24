import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

function runGit(args, { allowExitCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: config.userpulsePath, shell: false });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (!allowExitCodes.includes(code)) {
        reject(new Error(`git ${args.join(' ')} falhou (codigo ${code}): ${err.trim()}`));
        return;
      }
      resolve(out);
    });
  });
}

export async function gitStatusShort() {
  const status = await runGit(['status', '--short']);
  return status.trim() || '(sem alteracoes)';
}

// Lista COMPLETA e atomica (uma unica chamada git) de todo arquivo com
// alteracao no workspace — rastreado (staged e/ou unstaged) ou novo/untracked
// (exclui ignorados via .gitignore). Usar uma unica chamada em vez de
// combinar `git diff --name-status` + `git ls-files --others` evita que os
// dois comandos vejam "fotografias" ligeiramente diferentes do disco caso
// algo mude entre uma chamada e outra (ex: arquivo removido no meio do
// processo) — a fonte de verdade da lista de arquivos passa a ser uma so.
// --no-renames evita linhas "R  old -> new" que exigiriam parsing extra;
// uma renomeacao aparece como D (arquivo antigo) + ?? ou A (arquivo novo),
// ambos cobertos individualmente pela revisao.
// Retorna tanto o texto bruto (para exibicao humana ao Mentor) quanto a
// lista parseada (para iteracao/cobertura) a partir da MESMA chamada git —
// de proposito, para que o texto mostrado nunca possa divergir da lista
// realmente processada (ja foi a causa de uma lacuna real em teste: uma
// segunda chamada `git status --short` separada podia ver um arquivo que a
// chamada de listagem, rodando em paralelo, ja nao via mais).
export async function getWorkspaceEntries() {
  const out = await runGit(['status', '--porcelain=v1', '--no-renames']);
  const lines = out.split('\n').filter((line) => line.length > 0);
  const entries = lines.map((line) => {
    const xy = line.slice(0, 2);
    const file = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
    return { xy, file, tracked: xy !== '??' };
  });
  return { raw: lines.join('\n') || '(sem alteracoes)', entries };
}

// Diff de um arquivo rastreado contra HEAD (combina staged + unstaged).
export async function getTrackedFileDiff(file) {
  const out = await runGit(['diff', '--no-renames', 'HEAD', '--', file]);
  return out.trim();
}

// Diff "sintetico" de um arquivo nao rastreado, comparando contra /dev/null.
// git diff --no-index sai com codigo 1 quando ha diferencas (comportamento
// normal, nao erro) e 0 quando nao ha; only >=2 e falha real.
// Para arquivos binarios, o proprio git reporta "Binary files ... differ"
// sem tentar mostrar conteudo textual.
//
// Checagem explicita de existencia: se o arquivo listado por
// getUntrackedFiles() for removido do disco antes deste diff rodar (janela
// de corrida rara), `git diff --no-index` NAO reporta erro nesse caso — ele
// silenciosamente devolve diff vazio (como se nao houvesse nada a mostrar).
// Isso mascararia a lacuna, entao verificamos a existencia primeiro e
// lancamos um erro claro para que o chamador marque o arquivo como falho.
export async function getUntrackedFileDiff(file) {
  const fullPath = path.join(config.userpulsePath, file);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`arquivo "${file}" nao existe mais em disco (removido antes da revisao)`);
  }
  const out = await runGit(['diff', '--no-index', '--', '/dev/null', file], {
    allowExitCodes: [0, 1],
  });
  const isBinary = /^Binary files /m.test(out);
  return { diff: out.trim(), isBinary };
}

export async function getDiffStat() {
  const out = await runGit(['diff', '--stat', 'HEAD']);
  return out.trim() || '(sem alteracoes)';
}

// --- Primitivas de preparo de branch (V2) ---
// Todas rodam pelo bridge (spawn direto de git), nunca pelo Claude Dev.
// Nenhuma usa --force/--force-with-lease/reset/clean.

// Ruidos locais conhecidos (estado do proprio Claude Code, cache de build do
// Vite) que nao devem bloquear o preparo de branch NEM entrar na revisao do
// Mentor. Exportado para uso tambem em collectWorkspaceBlocks (taskManager.js).
export const IGNORED_DIRTY_PREFIXES = ['.claude/', 'web/.vite/'];

export async function hasLocalChanges() {
  const out = await runGit(['status', '--porcelain']);
  const lines = out.split('\n').filter((line) => line.length > 0);
  const relevant = lines.filter((line) => {
    const file = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
    return !IGNORED_DIRTY_PREFIXES.some((prefix) => file.startsWith(prefix));
  });
  return relevant.length > 0 ? relevant.join('\n') : null;
}

export async function fetchOrigin() {
  await runGit(['fetch', 'origin']);
}

export async function getCurrentBranch() {
  const out = await runGit(['branch', '--show-current']);
  return out.trim();
}

export async function switchBranch(name) {
  await runGit(['switch', name]);
}

export async function pullFfOnly(remote, branch) {
  await runGit(['pull', '--ff-only', remote, branch]);
}

export async function getRevParse(ref) {
  const out = await runGit(['rev-parse', ref]);
  return out.trim();
}

export async function branchExists(name) {
  try {
    await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]);
    return true;
  } catch {
    return false;
  }
}

export async function createAndSwitchBranch(name) {
  await runGit(['switch', '-c', name]);
}

// git merge-base sai com codigo 1 (nao 0) e stdout vazio quando NAO ha
// ancestral comum entre as duas referencias — nesse caso o runGit (que so
// aceita exit 0 por padrao) rejeita, que e exatamente o sinal de "historias
// git incompativeis" que quem chama precisa para bloquear.
export async function getMergeBase(refA, refB) {
  const out = await runGit(['merge-base', refA, refB]);
  return out.trim();
}

// --- Primitivas de aprovacao (V3: /aprovar) ---
// Idem: rodam pelo bridge, nunca pelo Claude Dev/Mentor. `remote` nunca e
// aceito como parametro externo/dinamico em quem chama estas funcoes —
// sempre a string literal 'origin', nunca 'clinic'/Quark.

// git add -- <arquivos>. NUNCA `git add .` — sempre lista explicita dos
// arquivos que foram de fato revisados pelo Mentor.
export async function stageFiles(files) {
  if (!files || files.length === 0) return;
  await runGit(['add', '--', ...files]);
}

export async function gitCommit(message) {
  await runGit(['commit', '-m', message]);
}

// git push -u origin <branch>. Nunca --force/--force-with-lease, nunca main.
export async function pushSetUpstream(remote, branch) {
  await runGit(['push', '-u', remote, branch]);
}

export async function getRevListCount(range) {
  const out = await runGit(['rev-list', '--count', range]);
  return out.trim();
}

export async function getRemoteUrl(remote) {
  const out = await runGit(['remote', 'get-url', remote]);
  return out.trim();
}

// --- Preflight de concorrencia (/aprovar) ---
// Somente leitura (nenhum comando muta o repo). Usada para comparar o que
// mudou em origin/<branch> desde um commit base, com deteccao de rename
// (-M) para que um arquivo reorganizado na main apareca como "R" (par
// old->new) em vez de D+A desacoplados, que passariam despercebidos por
// quem so olha o nome antigo.
export async function getNameStatusDiff(baseRef, targetRef) {
  const out = await runGit(['diff', '--name-status', '-M', baseRef, targetRef]);
  const unquote = (s) => s.trim().replace(/^"(.*)"$/, '$1');
  return out
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split('\t');
      const status = parts[0][0];
      if (status === 'R') {
        return { status: 'R', file: unquote(parts[1]), newFile: unquote(parts[2]) };
      }
      return { status, file: unquote(parts[1]) };
    });
}
