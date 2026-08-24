#!/usr/bin/env node
/**
 * Hook PreToolUse (matcher: Bash) para a sessao do Claude Dev.
 * Recebe no stdin o payload JSON do hook (tool_name, tool_input.command, ...)
 * e decide, ANTES da execucao, se o comando deve ser negado.
 *
 * Este e o portao mais forte disponivel no CLI: roda mesmo com
 * --permission-mode bypassPermissions, o que --disallowedTools sozinho nao
 * garante em todas as formas de invocacao indireta.
 *
 * A checagem e feita sobre a string bruta do comando (nao apenas o primeiro
 * token), entao invocacoes indiretas via `cmd /c "..."`, `powershell -Command
 * "..."`, `sh -c "..."` etc. tambem sao capturadas desde que o comando
 * perigoso apareca litealmente no texto. Comandos ofuscados (ex: PowerShell
 * -EncodedCommand em base64) nao podem ser lidos por substring, por isso o
 * uso desses mecanismos de codificacao e bloqueado por si so.
 */

const BLOCKED_RULES = [
  // --- git: historico/publicacao ---
  { name: 'git commit', pattern: /\bgit\s+(-\S+\s+)*commit\b/i },
  { name: 'git push', pattern: /\bgit\s+(-\S+\s+)*push\b/i },
  { name: 'git merge', pattern: /\bgit\s+(-\S+\s+)*merge\b/i },
  { name: 'git rebase', pattern: /\bgit\s+(-\S+\s+)*rebase\b/i },
  { name: 'git reset', pattern: /\bgit\s+(-\S+\s+)*reset\b/i },
  { name: 'git clean', pattern: /\bgit\s+(-\S+\s+)*clean\b/i },
  // --- git: alteracoes de remote ---
  { name: 'git remote (add/remove/rename/set-url/prune)', pattern: /\bgit\s+remote\s+(add|remove|rm|rename|set-url|prune)\b/i },
  { name: 'git config remote.*', pattern: /\bgit\s+config\b[^\n]*\bremote\./i },
  // --- filesystem destrutivo: POSIX ---
  { name: 'rm -r/-f (recursivo ou forcado)', pattern: /\brm\s+(-\S*[rf]\S*|--recursive\b|--force\b)/i },
  { name: 'dd para dispositivo', pattern: /\bdd\s+[^\n]*\bof=\/dev\//i },
  { name: 'mkfs', pattern: /\bmkfs(\.\w+)?\b/i },
  // --- filesystem destrutivo: cmd.exe ---
  { name: 'del /f ou /s', pattern: /\b(del|erase)\b[^\n]*\/[fsFS]/i },
  { name: 'rd /s ou rmdir /s', pattern: /\b(rd|rmdir)\b[^\n]*\/[sS]/i },
  { name: 'format <drive>', pattern: /\bformat\s+[a-zA-Z]:/i },
  // --- filesystem destrutivo: PowerShell ---
  { name: 'Remove-Item -Recurse/-Force', pattern: /remove-item\b[^\n]*-(recurse|force)\b/i },
  // --- execucao indireta/ofuscada nao auditavel ---
  { name: 'PowerShell -EncodedCommand (comando codificado, nao auditavel)', pattern: /(powershell|pwsh)(\.exe)?\b[^\n]*-e(nc(odedcommand)?)?\b/i },
  { name: 'Invoke-Expression / iex', pattern: /\b(invoke-expression|iex)\b/i },
];

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // payload ilegivel: nao temos como avaliar com seguranca -> nega por cautela
    deny('Guard: nao foi possivel interpretar o payload do hook; comando negado por seguranca.');
    return;
  }

  if (payload.tool_name && payload.tool_name !== 'Bash') {
    process.exit(0);
    return;
  }

  const command = String(payload?.tool_input?.command || '');
  for (const rule of BLOCKED_RULES) {
    if (rule.pattern.test(command)) {
      deny(`Bloqueado pelo guard de seguranca do Dev: ${rule.name}. Essas acoes exigem autorizacao explicita do usuario e nao podem ser executadas pelo agente.`);
      return;
    }
  }

  process.exit(0);
}

main();
