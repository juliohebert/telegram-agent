import { spawn } from 'node:child_process';
import { getRemoteUrl } from './git.js';

// `gh` (GitHub CLI) nao esta instalado neste ambiente e nao instalamos
// dependencia nova para isso — usamos a API REST do GitHub direto via
// fetch nativo, autenticando com a MESMA credencial que o git ja usa para
// push/fetch (reaproveitada via `git credential fill`, nunca armazenada em
// disco/estado, nunca logada).

function parseGitHubRepo(url) {
  const m = url.match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

function getGitHubToken() {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['credential', 'fill'], { shell: false });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git credential fill falhou (codigo ${code}): ${err.trim()}`));
        return;
      }
      const match = out.match(/^password=(.+)$/m);
      if (!match) {
        reject(new Error('nenhuma credencial encontrada para github.com — faca login (git/gh) antes de usar /aprovar com PR automatica'));
        return;
      }
      resolve(match[1].trim());
    });
    child.stdin.write('protocol=https\nhost=github.com\n\n');
    child.stdin.end();
  });
}

async function githubApi(method, route, token, body) {
  const res = await fetch(`https://api.github.com${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'telegram-agent-bridge',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    // nunca inclui o token na mensagem de erro (nem por acidente): so
    // status + descricao que o GitHub devolveu.
    const desc = json?.message || `HTTP ${res.status}`;
    throw new Error(`GitHub API (${method} ${route}) falhou: ${desc}`);
  }
  return json;
}

// Cria a PR no origin (GitHub) ou reutiliza uma ja aberta para a mesma
// branch/base, sem nunca mergear e sem nunca aceitar head === base (nunca
// cria PR de main para main). base e sempre 'main' (quem chama controla
// isso; aqui so validamos que head != base como ultima barreira).
export async function createOrGetPullRequest({ base, head, title, body }) {
  if (head === base) {
    throw new Error(`head (${head}) nao pode ser igual a base (${base}) — abortando.`);
  }

  const originUrl = await getRemoteUrl('origin');
  const repoInfo = parseGitHubRepo(originUrl);
  if (!repoInfo) {
    throw new Error(`origin nao parece ser um repositorio do GitHub — PR automatica nao suportada aqui.`);
  }

  const token = await getGitHubToken();

  // reutiliza PR aberta existente para essa branch -> nunca duplica em retry.
  const existing = await githubApi(
    'GET',
    `/repos/${repoInfo.owner}/${repoInfo.repo}/pulls?head=${encodeURIComponent(`${repoInfo.owner}:${head}`)}&base=${encodeURIComponent(base)}&state=open`,
    token
  );
  if (Array.isArray(existing) && existing.length > 0) {
    const pr = existing[0];
    return { number: pr.number, url: pr.html_url, reused: true };
  }

  const created = await githubApi('POST', `/repos/${repoInfo.owner}/${repoInfo.repo}/pulls`, token, { title, body, head, base });
  return { number: created.number, url: created.html_url, reused: false };
}
