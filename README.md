# telegram-agent

Bridge local Telegram ↔ Claude Mentor ↔ Claude Dev para o projeto **UserPulse**.

Roda como um processo Node.js de longa duração na máquina do desenvolvedor (long
polling do Telegram, sem servidor HTTP exposto), orquestrando duas sessões
distintas do Claude Code CLI (um "Mentor" e um "Dev") e todas as operações Git
reais — sempre executadas pelo próprio bridge, nunca pelo Claude.

> Único usuário/chat autorizado por instância (`TELEGRAM_ALLOWED_CHAT_ID` /
> `TELEGRAM_ALLOWED_USER_ID`). Não é multi-tenant.

---

## 1. Visão geral

O telegram-agent existe para dar a um Product Owner (humano, via Telegram) um
fluxo de desenvolvimento assistido por IA com **aprovação humana obrigatória**
antes de qualquer código ir para o GitHub, e **sem merge automático** em
nenhuma etapa:

```
Product Owner (Telegram)
    → Mentor        (Claude, analisa/planeja — nunca edita código)
    → Dev            (Claude, implementa — nunca commita/publica)
    → revisão        (Mentor revê o diff — READY / BLOCKED / CHANGES_REQUIRED)
    → validação funcional (/validar — ambiente local isolado, opcional mas recomendado)
    → aprovação       (/aprovar — o BRIDGE comita, publica a branch e cria a PR)
    → Pull Request no GitHub — merge sempre manual, fora do bridge
```

Pontos estruturais que valem para o projeto inteiro:

- O Mentor só tem ferramentas de leitura (`Read,Grep,Glob`) — nunca edita
  arquivos nem roda comandos.
- O Dev tem ferramentas de escrita/execução, mas `git commit`, `git push`,
  `git merge`, `git rebase`, `git reset` e `git clean` são bloqueados em duas
  camadas independentes (ver seção 7) — quem faz essas operações é sempre o
  próprio código do bridge (`src/git.js`).
- `/aprovar` nunca faz merge. Ele cria (ou reaproveita) uma Pull Request e
  para aí.

---

## 2. Papéis

### Product Owner
Pessoa humana, única autorizada a falar com o bot (chat/usuário fixados em
`.env`). Descreve a demanda em linguagem natural (texto ou áudio/voz,
transcrito localmente via Whisper) e comanda o ciclo via comandos `/...`.

### Mentor (Claude, sessão dedicada)
- Prompt de sistema: `prompts/shared.md` + `prompts/mentor.md`.
- Ferramentas: `Read,Grep,Glob` (`MENTOR_TOOLS` em `src/taskManager.js`) — só
  leitura, nunca edita nada.
- Responsabilidades reais no código: analisar a demanda inicial e produzir
  risco (`### Risco`), a instrução para o Dev (`### Instrução para o
  Desenvolvedor`) e o tipo/slug de branch (`### Branch`); revisar o diff
  produzido pelo Dev e devolver um veredito formal (`### Veredito`: `READY`,
  `BLOCKED` ou `CHANGES_REQUIRED`, com motivo/próximo passo, e — se
  `CHANGES_REQUIRED` — uma nova instrução de correção); e, só em `/aprovar`,
  gerar o texto de commit/título/descrição de PR (nunca executa nenhum
  comando Git — quem faz isso é o bridge).
- A sessão do Mentor é mantida entre chamadas (`task.mentorSessionId`,
  `--resume`), então ele acumula contexto ao longo do ciclo de uma task.

### Dev (Claude, sessão dedicada)
- Prompt de sistema: `prompts/shared.md` + `prompts/developer.md`.
- Ferramentas: `Read,Grep,Glob,Edit,Write,Bash,TodoWrite` (`DEV_TOOLS`).
- Implementa exatamente a `devInstruction` mais recente do Mentor. Pode rodar
  testes/build/lint/browser via Bash, mas está impedido de fazer qualquer
  operação Git sensível (seção 7).
- A sessão do Dev **nunca é retomada** entre chamadas (`sessionId` sempre
  `null` em `runDev`) — cada `/implementar` começa uma sessão nova, para
  evitar acúmulo ilimitado de cache de contexto entre tentativas.

### Bridge (este projeto)
Todo o resto: polling do Telegram (`src/bot.js`), máquina de estados da task
(`src/state.js`), orquestração das chamadas ao Claude CLI
(`src/taskManager.js`, `src/claudeRunner.js`), **todas** as operações Git reais
(`src/git.js` — fetch, branch, add, commit, push), criação de Pull Request via
API REST do GitHub (`src/github.js`), o workspace dedicado de validação local
(`src/validation.js`), telemetria de tokens (`src/execution.js`), controle de
processos ativos para `/cancelar` (`src/processRegistry.js`) e transcrição de
áudio (`src/transcribe.js`).

---

## 3. Workspaces

O bridge trabalha com **até três** pastas de repositório distintas, além de si
mesmo. É essencial não confundi-las.

| Workspace | Variável | Uso real no código |
|---|---|---|
| `UserPulse` | *(nenhuma — não configurado no bridge)* | Checkout manual do desenvolvedor. **Nunca** referenciado por nenhuma variável de ambiente nem tocado por `git.js`/`taskManager.js`/`validation.js`. Existe só como histórico/contexto do projeto original — os comentários do código citam um incidente real de linhagem Git incompatível ("clinic/Quark"), que é justamente por isso `prepareTaskBranch` valida `git merge-base` entre `main` local e `origin/main` antes de criar qualquer branch: se a história local não bater com a do remoto configurado, ele bloqueia em vez de seguir. |
| `UserPulse-agent` | `USERPULSE_PATH` | Clone **dedicado** ao Mentor e ao Dev. Toda sessão Claude roda com `cwd=USERPULSE_PATH` (`src/claudeRunner.js`). Todas as operações de `/implementar`, `/revisar` e `/aprovar` (branch, diff, commit, push) acontecem aqui, sempre via `src/git.js`. O `origin` deste clone é o remoto GitHub real do projeto. |
| `UserPulse-validation` | `USERPULSE_VALIDATION_PATH` (opcional) | Clone **dedicado** só ao `/validar`. Nunca usado por Mentor/Dev/`/aprovar`. É onde o bridge sobe backend (porta 3333) e frontend (Vite, preferencialmente 5173) localmente, aplicando por cima (overlay) o conteúdo exato dos arquivos já revisados pelo Mentor — sem precisar de commit. Workspace exclusivo do bridge: se tiver alteração não esperada por ele, `/validar` bloqueia em vez de sobrescrever. |
| `telegram-agent` | — | Este projeto. Não é um repositório de código do UserPulse; é o orquestrador. |

---

## 4. Comandos

Todos os comandos abaixo (exceto `/status`, `/tarefas`, `/abrir` e `/reabrir`)
passam por um lock de exclusão mútua (`withBusyLock` em `src/bot.js`): só uma
operação pesada (Mentor/Dev/revisão/aprovação/validação) roda por vez.

| Comando | Comportamento real |
|---|---|
| `/novo [texto]` | Cria uma task nova (bloqueado se já existe uma task ativa em estado diferente de `AGUARDANDO_VALIDACAO`). Se vier texto junto, já consulta o Mentor na hora. |
| `/implementar` | Envia a task ao Dev. Bloqueado se: a task está em estado terminal; ainda não há nenhuma análise do Mentor; a task foi reaberta e ainda não recebeu uma revisão nova (`reopenPendingReview`); ou o último veredito foi `CHANGES_REQUIRED` sem uma instrução de correção válida associada (`pendingFixInstruction !== false`). Na primeira chamada da task, prepara uma branch dedicada (`prepareTaskBranch`); nas seguintes, só **confirma** que o workspace está na branch certa (`verifyOnTaskBranch`) — o bridge nunca troca de branch sozinho. |
| `/revisar` | Roda a revisão do Mentor sobre o diff atual do workspace (`reviewWithMentor`): coleta status/diff de todo arquivo alterado (rastreado ou novo, ignorando ruído conhecido de `.claude/` e `web/.vite/`), envia ao Mentor (dividido em partes se ultrapassar `MAX_DIFF_CHARS`), calcula um fingerprint SHA-256 do conteúdo exato revisado e grava `reviewGate`/`reviewedFiles`/`reviewFingerprint`. |
| `/status` | Só leitura. Mostra estado da task, gates, branch, PR, métricas de token de cada execução, resumo da validação local (sonda HTTP real, não só PID) e `git status --short`. |
| `/cancelar` | Mata **só o processo Claude ativo no momento** (árvore inteira, via `taskkill /T /F` no Windows). Nunca encerra a task, nunca toca working tree/branch/`reviewGate`. Se havia um Dev ou uma Revisão em andamento, o estado volta para `AGUARDANDO_IMPLEMENTACAO` (nunca deixa a task "presa" em `DEV_IMPLEMENTANDO`/`REVISAO_MENTOR`). |
| `/encerrar` | Único comando que marca a task como `CANCELADA` (terminal). Não mexe em Git nem no working tree. |
| `/aprovar` | `approveTask` — ver seção 7. Comita (só os arquivos revisados), publica a branch e cria/reaproveita a PR. Idempotente em 3 camadas (PR pronta / commit+push já feitos / só commit feito). |
| `/validar` | `runValidar` — ver seção 8. Prepara o ambiente local em `UserPulse-validation`. Nunca é aprovação. |
| `/tarefas` | Lista as 10 tasks mais recentes salvas em `state/tasks/`. Só leitura. |
| `/abrir <taskId>` | Torna uma task existente a "task atual" (`current.json`). Só leitura de Git (compara com a branch atual do workspace e avisa se forem diferentes). Não reativa task terminal. |
| `/reabrir <taskId>` | Só funciona em tasks `APROVADA`. Reativa para um novo ciclo de correção, preservando id/branch/PR/histórico anterior, mas marcando `reopenPendingReview=true`. |

Diferenças que costumam gerar confusão:

- **`/cancelar` × `/encerrar`** — `/cancelar` interrompe só a execução em
  andamento (a task continua ativa, dá pra retomar); `/encerrar` finaliza a
  task inteira (terminal), mesmo sem nada rodando no momento.
- **`/abrir` × `/reabrir`** — `/abrir` apenas troca qual task está selecionada
  (não muda estado nem reativa nada); `/reabrir` efetivamente tira uma task
  `APROVADA` do estado terminal para um novo ciclo.
- **`/validar` não aprova** — só prepara um ambiente local pra visualizar/testar
  o resultado; quem de fato comita/publica/cria PR é sempre `/aprovar`.
- **`/aprovar` nunca faz merge** — cria (ou reaproveita) a Pull Request e para
  por aí; o merge é sempre manual, no GitHub.

---

## 5. State machine e gates

### Estados (`STATES`, `src/state.js`)

```
NOVA → AGUARDANDO_IMPLEMENTACAO → DEV_IMPLEMENTANDO → REVISAO_MENTOR
     → AGUARDANDO_VALIDACAO → APROVADA
```

`CANCELADA` pode ser alcançado a partir de qualquer estado ativo via
`/encerrar`. O estado `ANALISE_MENTOR` está **definido** em `STATES` mas não é
usado em nenhuma transição do código atual — nenhuma parte do fluxo real seta
ou lê esse valor hoje.

### Gates e flags relevantes (todos em `task.*`, persistidos em `state/`)

- **`reviewGate`** (`READY` | `BLOCKED` | `CHANGES_REQUIRED` | `null`) — o
  veredito formal do Mentor na última revisão. Só `READY` libera `/aprovar` e
  `/validar`.
- **`pendingFixInstruction`** (`true` | `false` | `null`) — fail-safe de
  handoff: quando o veredito é `CHANGES_REQUIRED` mas o Mentor não devolveu a
  seção `### Instrução para o Desenvolvedor`, o bridge tenta obtê-la
  automaticamente (uma chamada extra, mesma sessão do Mentor); se mesmo assim
  não vier, marca `pendingFixInstruction=true` e `/implementar` fica bloqueado
  até uma nova `/revisar` — a instrução antiga **nunca** é reenviada ao Dev
  como se fosse a correção desta revisão.
- **`reopenPendingReview`** (`true` | `false` | `null`) — setado por
  `/reabrir`; bloqueia `/implementar` até uma `/revisar` real acontecer neste
  novo ciclo, mesmo que `reviewGate` ainda mostre o valor herdado da
  aprovação anterior.
- **`reviewComplete`** (`true` | `false` | `null`) — `false` quando a revisão
  não pôde ser garantida completa (falha ao coletar algum arquivo, revisão em
  partes que quebrou no meio, arquivo binário presente no diff).
  `/aprovar` exige `reviewComplete === true`.
- **`reviewFingerprint`** / **`reviewedFiles`** — hash SHA-256 e lista exata
  dos arquivos (nome + diff) que o Mentor efetivamente viu na última revisão
  completa. `/aprovar` recalcula o fingerprint do workspace atual e bloqueia
  se não bater — garante que nada mudou localmente entre a revisão e a
  aprovação.
- **`baseSha`** — SHA de `main`/`origin/main` no momento em que a branch da
  task foi criada (gravado em `prepareTaskBranch`). Usado pelo preflight de
  concorrência do `/aprovar` (seção 7).

### Task reaberta após bug funcional (`/reabrir`)

`/reabrir` move `APROVADA → AGUARDANDO_IMPLEMENTACAO`, seta
`reopenPendingReview=true` e preserva branch/PR/`reviewGate` antigos só como
histórico (`reopenHistory`). Se o workspace estiver limpo (sem diff novo,
porque o problema relatado ainda é só conversa com o Mentor), `/revisar` usa
um caminho específico (`buildReopenReviewMessage`): o atalho normal "git limpo
= nada para revisar" fica **desabilitado** nesse caso, e o Mentor recebe um
contexto mínimo (pedido original, implementação já aprovada, última revisão
formal anterior e o que já foi discutido nesta mesma sessão sobre o problema
relatado) para dar um veredito formal mesmo sem diff. Só depois desse
veredito real `/implementar` volta a funcionar.

---

## 6. Fluxo completo de desenvolvimento

```
/novo <demanda>
  → Mentor analisa: risco, devInstruction, tipo/slug de branch
/implementar
  → 1ª vez: prepareTaskBranch cria <tipo>/<slug> a partir de origin/main
  → Dev implementa a devInstruction
  → ao terminar, revisão automática do Mentor roda em seguida (reviewWithMentor)
  → CHANGES_REQUIRED → nova devInstruction → /implementar de novo (repete)
  → READY → AGUARDANDO_VALIDACAO
/validar (opcional, recomendado)
  → sobe UserPulse-validation com o diff revisado aplicado, backend+frontend locais
/aprovar
  → preflight de concorrência com origin/main (seção 7)
  → Mentor gera texto de commit + título/descrição de PR (mesma sessão da revisão)
  → bridge comita (só os arquivos revisados), publica a branch, cria/reaproveita a PR
→ Pull Request aberta no GitHub — merge sempre manual
```

Se depois de aprovada a task revelar um bug funcional, o ciclo de correção é
`/reabrir` → (opcional, se preciso) nova conversa com o Mentor para gerar uma
`devInstruction` nova → `/revisar` (mesmo sem diff, se ainda for só análise) →
`/implementar` → revisão → `/validar` → `/aprovar` de novo, exatamente como um
ciclo normal.

---

## 7. Segurança Git

Regras que valem para **todas** as operações do bridge (`src/git.js`,
`src/taskManager.js`):

- O GitHub (`origin` do clone em `USERPULSE_PATH`) é sempre a fonte da
  verdade de `main`.
- `git fetch origin` roda antes de qualquer decisão que dependa do estado
  remoto (preparo de branch, `/aprovar`).
- `main` local só avança por **fast-forward** (`git pull --ff-only`); se não
  for possível, bloqueia em vez de tentar resolver.
- **Nunca** `--force`/`--force-with-lease`.
- **Nunca** `git reset`, `git clean` ou `git stash` automáticos.
- **Nunca** `git add .` — `/aprovar` sempre faz `git add -- <lista explícita>`
  com exatamente os arquivos que o Mentor revisou (`task.reviewedFiles`),
  nunca "tudo que estiver sujo no momento".
- Alterações de terceiros nunca são sobrescritas — qualquer sujeira
  inesperada ou divergência bloqueia com uma mensagem explicando o que fazer
  manualmente, em vez de tentar corrigir sozinho.
- O Dev, mesmo tendo `Bash`, está bloqueado em duas camadas independentes
  para qualquer comando Git sensível:
  1. `--disallowedTools` do Claude CLI (`DEV_DISALLOWED_TOOLS`, em
     `src/taskManager.js`): nega `git commit`, `git push`, `git merge`,
     `git rebase`, `git reset`, `git clean` diretamente.
  2. Um hook `PreToolUse` (`src/hooks/devGuard.js`) que roda **antes** de
     qualquer `Bash`, mesmo com `--permission-mode bypassPermissions` — cobre
     também invocação indireta (`cmd /c "..."`, `powershell -Command "..."`,
     `sh -c "..."`) e bloqueia adicionalmente `rm -rf`, `format`, alteração
     de `git remote`, `PowerShell -EncodedCommand` e `Invoke-Expression`/`iex`
     (comandos ofuscados/não auditáveis).

### Preflight de concorrência do `/aprovar`

Antes de qualquer `git add`/`commit`/`push`, `approveTask`
(`src/taskManager.js`) roda um preflight específico para pegar o caso de
**outro desenvolvedor ter alterado a `origin/main`** enquanto a task estava em
andamento:

1. `git fetch origin` (o mesmo fetch já usado pra checar divergência ahead/behind).
2. Usa `task.baseSha` — o commit de `main`/`origin/main` no momento exato em
   que a branch da task foi criada (`prepareTaskBranch`) — como base de
   comparação.
3. Compara, via `git diff --name-status -M <baseSha> origin/main`, **somente**
   os arquivos em `task.reviewedFiles` (os mesmos que o `reviewFingerprint`
   cobre) contra o que existe hoje em `origin/main`.
4. Detecta arquivo **modificado**, **removido** ou **renomeado**
   (`getNameStatusDiff`/`checkOriginConcurrency` em `src/taskManager.js` e
   `src/git.js`).
5. Se houver qualquer divergência: `/aprovar` interrompe com uma
   `ApproveError` cuja mensagem começa com `BLOCKED`, listando só os arquivos
   afetados e o tipo de divergência — **nenhum** commit/push acontece, a
   branch da task não é tocada, e nada é resolvido/mergeado automaticamente.
   O usuário precisa resolver manualmente e rodar `/revisar` de novo antes de
   tentar `/aprovar` outra vez.
6. Se não houver divergência nos arquivos revisados (mesmo que `origin/main`
   tenha mudado em arquivos que a task não tocou), o fluxo de aprovação segue
   normalmente.

**Limitação conhecida:** tasks criadas **antes** deste preflight existir não
têm `task.baseSha` gravado. Para essas, `checkOriginConcurrency` não tem uma
base confiável para comparar e o preflight simplesmente não roda — as demais
proteções de `/aprovar` (branch atual, fingerprint do workspace local, fetch
prévio) continuam valendo do mesmo jeito. Tasks novas (criadas depois desta
mudança) sempre têm `baseSha`.

---

## 8. Validação local (`/validar`)

Implementado inteiramente em `src/validation.js`. Nunca toca
`USERPULSE_PATH` para escrita e nunca roda Git nele — todo Git deste fluxo
roda em `USERPULSE_VALIDATION_PATH`.

1. **Preparação do workspace**: se `USERPULSE_VALIDATION_PATH` não existir
   ainda, clona o mesmo `origin` do `UserPulse-agent`. Se já existir, só
   valida que é um clone seguro (só remote `origin`, mesma URL) — nunca
   apaga/recria a pasta.
2. **Branch da task**: `git fetch origin` + checkout/criação da branch com o
   mesmo nome da task (`ensureBranchCheckedOut`), sempre por fast-forward ou
   criação nova a partir de `origin/<branch>` (se já publicada) ou
   `origin/main` (se ainda não). Nunca merge/rebase/reset/force. Branch local
   já existente e desalinhada da base esperada bloqueia (workspace exclusivo
   do bridge — desalinhamento só pode vir de algo manual).
3. **Aplicação dos arquivos revisados**: copia o conteúdo atual de cada
   arquivo em `task.reviewedFiles` de `UserPulse-agent` para dentro de
   `UserPulse-validation` (overlay, sem commit). Arquivo que fazia parte do
   diff como deleção também é removido lá. A cada nova chamada, desfaz
   primeiro o overlay anterior (usando só a lista que o próprio bridge
   registrou ter sobreposto da última vez — nunca `git reset`/`clean`
   genérico).
4. **Backend**: sempre porta fixa `3333` (`BACKEND_PORT`). Se a porta já
   estiver ocupada por processo que **não** foi iniciado pelo bridge,
   bloqueia (nunca tenta outra porta, nunca mata processo alheio). Se
   ocupada por um processo que o próprio bridge já subiu antes e a
   branch/commit não mudou, reaproveita (depois de confirmar que ainda
   responde); senão substitui.
5. **Frontend**: tenta a porta preferida `5173`, mas **sem** `--strictPort` —
   se estiver ocupada, deixa o Vite cair no fallback normal dele (`5174`,
   `5175`, ...). A URL real devolvida ao usuário nunca é fixa: é sempre a
   porta descoberta lendo o próprio banner de startup do Vite no log
   (`extractVitePortFromLog`), nunca a constante `5173` assumida às cegas.
6. **Readiness real (HTTP)**: nenhum dos dois lados é considerado pronto só
   por ter um PID vivo — uma sonda HTTP de verdade (`GET /health` no backend,
   `GET /` no frontend) precisa responder, e o processo precisa continuar
   vivo enquanto isso é checado.
7. **Rollback em falha parcial**: se backend subir mas frontend falhar (ou
   vice-versa), o lado que já tinha subido com sucesso nesta chamada é
   encerrado antes do erro ser propagado — nunca deixa um lado órfão rodando
   sozinho, e `/validar` nunca marca a validação como pronta nesse caso.
8. **`.env`**: o backend **exige** um `.env` em `UserPulse-validation/server`;
   se ausente, reaproveita (copia, sem sobrescrever um já existente) o `.env`
   local de `UserPulse-agent/server`; se nenhum dos dois tiver, bloqueia
   dizendo exatamente o que falta — nunca tenta subir o processo sem isso. O
   frontend não exige `.env` hoje (best-effort, nunca bloqueia por causa
   dele).
9. **Comportamento quando o backend não sobe**: `ValidationError` com as
   últimas linhas do log real (`server`/`web` logs em
   `state/validation-logs/`) — por exemplo, uma variável obrigatória ausente
   no `.env` do UserPulse (como `ADMIN_JWT_SECRET`, se o backend do próprio
   UserPulse exigir) aparece ali, porque é a aplicação do UserPulse quem loga
   isso, não o bridge.

`Postgres` (Docker) é assumido como já rodando externamente — `/validar`
nunca sobe o orquestrador de raiz do UserPulse (`npm run dev` na raiz, que
sobe banco/migração/seed); só os processos de aplicação (`server`, `web`).

---

## 9. Telemetria

Métricas vêm sempre do `usage` real devolvido pelo próprio Claude CLI (nunca
estimadas por tamanho de texto), com 4 campos + 1 derivado
(`src/taskManager.js`, `src/execution.js`):

- `inputTokens`
- `outputTokens`
- `cacheCreationTokens`
- `cacheReadTokens`
- **`activeTokens = inputTokens + outputTokens`** — o único valor mostrado
  como "consumo ativo" no `/status` e usado nos alertas `WARNING`/`HIGH`/
  `CRITICAL` do Dev (`DEV_TOKEN_WARNING`/`DEV_TOKEN_HIGH`/`DEV_TOKEN_CRITICAL`).

`cacheCreationTokens`/`cacheReadTokens` **nunca** entram em `activeTokens` nem
nos alertas — eles crescem com o tamanho do contexto/sessão (histórico
resumido, diffs grandes), não com o trabalho novo feito na execução atual.
São sempre mostrados separadamente ("Cache criado" / "Cache reutilizado").
É por isso, inclusive, que a sessão do Dev nunca é retomada entre chamadas de
`/implementar` (ver seção 2) — resumir a sessão era a causa raiz de
`cacheCreation`/`cacheRead` acumularem sem limite entre tentativas.

---

## 10. Configuração

### Requisitos

- **Node.js ≥ 20.6.0** (`package.json` → `engines`). O projeto **não tem
  nenhuma dependência de terceiros hoje** (`package.json` sem
  `dependencies`) — não há `npm install` de pacotes a fazer; ele usa só
  módulos nativos do Node (`node:child_process`, `node:fs`, `fetch` nativo,
  etc.). `node_modules/` está no `.gitignore` por precaução, caso isso mude
  no futuro.
- **Claude Code CLI** instalado e autenticado, disponível como `claude` no
  `PATH` do sistema (`src/claudeRunner.js` faz `spawn('claude', ...)`
  diretamente, sem caminho absoluto).
- **Git** instalado e no `PATH`, com credencial do GitHub já configurada de
  forma que `git credential fill` (protocolo `https`, host `github.com`)
  devolva uma credencial válida — é assim que `src/github.js` obtém o token
  para criar Pull Requests via API REST (nunca usa `gh` CLI, nunca guarda
  token em disco/estado).
- **npm** no `PATH` (usado só para rodar `npm install`/`npm run dev` **dentro
  do workspace `UserPulse-validation`**, para `/validar` — o próprio
  telegram-agent não depende de `npm install` para si mesmo).
- **ffmpeg** com filtro `whisper` habilitado (build com `--enable-whisper`,
  ex.: builds "full" do gyan.dev no Windows) — **opcional**, só necessário se
  o Product Owner for enviar mensagens de voz/áudio pelo Telegram. Confirme
  com `ffmpeg -h filter=whisper`.
- Um modelo Whisper `ggml` local (ex.: `ggml-small.bin`) — também só para
  áudio/voz.

### Variáveis de ambiente (`.env` na raiz do projeto)

O `.env` **nunca** é versionado (`.gitignore`). Nomes reais lidos por
`src/config.js`, com exemplos fictícios:

```dotenv
# --- Telegram (obrigatórias) ---
TELEGRAM_BOT_TOKEN=123456789:AAExemploDeTokenFicticioNaoReal
TELEGRAM_ALLOWED_CHAT_ID=111111111
TELEGRAM_ALLOWED_USER_ID=111111111

# --- Workspaces (obrigatórias, exceto USERPULSE_VALIDATION_PATH) ---
USERPULSE_PATH=C:\Users\seu-usuario\dev\UserPulse-agent
PROMPTS_PATH=C:\Users\seu-usuario\dev\telegram-agent\prompts
USERPULSE_VALIDATION_PATH=C:\Users\seu-usuario\dev\UserPulse-validation

# --- Claude CLI (opcionais, com default no código) ---
# CLAUDE_MODEL=sonnet
# CLAUDE_MENTOR_TIMEOUT_MS=300000
# CLAUDE_DEV_TIMEOUT_MS=900000
# MAX_DIFF_CHARS=60000

# --- Alertas de consumo de tokens do Dev (opcionais) ---
# DEV_TOKEN_WARNING=30000
# DEV_TOKEN_HIGH=50000
# DEV_TOKEN_CRITICAL=75000

# --- Transcrição de áudio/voz (opcionais, só se for usar voz no Telegram) ---
# WHISPER_MODEL_PATH=C:\Users\seu-usuario\dev\telegram-agent\models\ggml-small.bin
# WHISPER_LANGUAGE=pt
# WHISPER_QUEUE_SECONDS=15
# AUDIO_TRANSCRIBE_TIMEOUT_MS=120000
# MAX_AUDIO_DURATION_SECONDS=300
# MAX_AUDIO_FILE_SIZE_MB=20

# --- Isolamento de state para testes (opcional — NUNCA usar em produção) ---
# STATE_DIR=C:\caminho\para\um\diretorio\de\teste\isolado
```

`USERPULSE_PATH` e `PROMPTS_PATH` são checados na inicialização
(`src/config.js`) e o processo recusa subir se algum dos dois não existir ou
não for diretório. `USERPULSE_VALIDATION_PATH` só é exigido no momento em que
`/validar` é chamado — sua ausência não impede o bot de iniciar.

### Instalar e iniciar

```bash
cd telegram-agent
npm install        # hoje é um no-op (sem dependências), mas seguro de rodar
# criar/editar o .env conforme a tabela acima
npm start           # equivalente a: node src/index.js
```

O processo roda em primeiro plano, fazendo long polling do Telegram
indefinidamente (loop em `startBot`, `src/bot.js`). Não expõe porta HTTP
própria.

---

## 11. Estrutura do projeto

```
telegram-agent/
├── package.json          # sem dependências externas; "start": node src/index.js
├── .env                    # NUNCA versionado (secrets + paths locais)
├── .gitignore
├── readme.txt              # arquivo legado, sem conteúdo relevante
├── models/
│   └── ggml-small.bin      # modelo Whisper (ignorado pelo Git: models/*.bin)
├── prompts/                 # system prompts das sessões Claude (versionados)
│   ├── shared.md            # contexto comum (projeto, princípios, Git, testes, autorização)
│   ├── mentor.md             # papel do Mentor (análise, revisão, formato de veredito)
│   └── developer.md          # papel do Dev (implementação, validação visual em browser)
├── state/                   # runtime local, NUNCA versionado (state/ no .gitignore)
│   ├── current.json          # task selecionada no momento
│   ├── tasks/                # histórico de todas as tasks (uma JSON por task)
│   ├── validation.json       # estado do workspace de validação (pids, portas, branch)
│   ├── validation-logs/      # logs de backend/frontend/npm install do /validar
│   └── tmp/                  # áudio temporário durante transcrição
└── src/
    ├── index.js              # entrypoint: valida config, sobe o bot
    ├── bot.js                # comandos do Telegram, state machine de UI, locks
    ├── config.js              # leitura/validação de .env
    ├── state.js               # STATES, CRUD de task em state/
    ├── taskManager.js          # orquestra Mentor/Dev/revisão/aprovação; preflight de concorrência
    ├── git.js                  # TODAS as operações Git reais (nunca o Claude)
    ├── github.js               # cria/reaproveita Pull Request via API REST do GitHub
    ├── validation.js            # workspace dedicado do /validar (clone, overlay, servers)
    ├── claudeRunner.js          # spawn do Claude CLI (json e stream-json)
    ├── execution.js             # telemetria em memória da execução ativa
    ├── processRegistry.js       # registro do processo Claude ativo, usado por /cancelar
    ├── prompts.js                # carrega/faz cache dos arquivos em prompts/
    ├── telegram.js               # cliente da API do Telegram + conversão Markdown→HTML
    ├── transcribe.js             # download + transcrição local de áudio (ffmpeg + whisper)
    └── hooks/
        └── devGuard.js           # hook PreToolUse que bloqueia comandos Git/destrutivos do Dev
```

---

## 12. Troubleshooting

- **Backend não sobe (`/validar`)** — a mensagem de erro (`ValidationError`)
  vem sempre com as últimas linhas do log real
  (`state/validation-logs/backend.log`). Causas cobertas explicitamente pelo
  código: porta `3333` ocupada por processo externo (bloqueia, nunca tenta
  outra porta nem mata o processo alheio); `.env` ausente tanto em
  `UserPulse-validation/server` quanto em `UserPulse-agent/server`; processo
  que morreu durante o startup; processo que não respondeu a tempo.
- **Variável tipo `ADMIN_JWT_SECRET` ausente** — se o backend do próprio
  UserPulse exigir uma variável de ambiente que não está no `.env` usado
  (comentário em `src/validation.js` cita esse exemplo real), o erro aparece
  no *tail* do log do backend mostrado pelo `/validar` — é a aplicação do
  UserPulse quem loga isso, o bridge só captura e mostra as últimas linhas.
  Corrija o `.env` de `UserPulse-agent/server` (ou o de
  `UserPulse-validation/server`, se já tiver sido criado separadamente) e
  rode `/validar` de novo.
- **Porta 5173 ocupada** — o frontend **não** trava nem bloqueia por isso:
  sobe sem `--strictPort` e deixa o Vite escolher outra porta livre
  (`5174`, `5175`, ...) sozinho.
- **Frontend "mudou de porta"** — normal: a URL real que `/validar` e
  `/status` mostram é sempre a porta que o próprio Vite anunciou no log de
  startup, nunca a constante `5173`. Se a porta preferida estiver livre da
  próxima vez, ele volta a usá-la.
- **Workspace de validação com "alterações não esperadas"** — `/validar`
  nunca reseta/limpa automaticamente; alguém mexeu manualmente em
  `UserPulse-validation` (workspace deveria ser exclusivo do bridge).
  Resolva manualmente (revisar/descartar as alterações à mão) antes de tentar
  de novo.
- **Task `APROVADA` precisa de correção** — use `/reabrir <taskId>`, não
  `/novo`. Preserva branch/PR/histórico e força uma nova `/revisar` antes de
  liberar `/implementar` de novo (ver seção 5).
- **Conflito com mudanças de outro desenvolvedor / arquivo removido ou
  renomeado na `main`** — é exatamente o que o preflight de concorrência do
  `/aprovar` existe para pegar (seção 7). A resposta do bot virá com
  `BLOCKED` no início da mensagem e a lista dos arquivos revisados que
  divergiram (modificado/removido/renomeado). Nenhum commit/push acontece.
  Resolva manualmente (nunca automaticamente) e rode `/revisar` de novo antes
  de tentar `/aprovar` outra vez.
- **`/aprovar` bloqueado pelo preflight sem nenhum conflito óbvio** —
  confirme se a task é antiga o suficiente para não ter `task.baseSha`
  gravado (tasks criadas antes desse preflight existir simplesmente pulam a
  checagem — ver limitação na seção 7); se o bloqueio persistir mesmo assim,
  o `git fetch origin` dentro de `/aprovar` pode estar falhando por outro
  motivo de rede/credencial — a mensagem de erro traz a causa exata.
- **Bridge reiniciado com Dev/Revisão em andamento** — ao reiniciar, o
  processo Claude anterior morre junto (não sobrevive ao processo pai). Na
  próxima mensagem, o bot detecta que o estado ficou em `DEV_IMPLEMENTANDO`
  ou `REVISAO_MENTOR` sem execução ativa e avisa explicitamente, orientando a
  usar `/status`, `/revisar`/`/implementar` para retomar, ou `/encerrar`.
- **Bridge reiniciado com `/validar` ativo** — os processos de backend/frontend
  do workspace de validação **não sobrevivem** a um reinício do bridge (são
  filhos dele, sem `detached:true` — decisão deliberada para manter os logs e
  a detecção de "processo morreu" confiáveis no Windows). `/validar` de novo
  sobe tudo novamente sem problema.

---

## 13. Mudança de computador / backup

Esta seção existe porque o repositório vai ser publicado em
`https://github.com/juliohebert/telegram-agent.git` e depois clonado em outra
máquina. **Clonar o repositório sozinho não é suficiente para continuar
operando o bridge** — várias coisas ficam de fora do Git de propósito.

### A. O que vai para o Git normalmente

- Todo o código em `src/`.
- `prompts/shared.md`, `prompts/mentor.md`, `prompts/developer.md` — não
  contêm segredo nenhum (system prompts de texto), mas **não** são ignorados
  pelo `.gitignore` atual, então acompanham o clone normalmente. É esse
  comportamento que garante que "instalar em outra máquina" já vem com os
  prompts corretos.
- `package.json`, `readme.txt`, `.gitignore`, este `README.md`.

### B. O que fica fora do Git, mas é necessário pra continuar operando (dados locais, não sensíveis por si só)

Tudo dentro de `state/` está no `.gitignore` (`state/`) e **não** é copiado
pelo clone:

- `state/current.json` — qual task está selecionada agora.
- `state/tasks/*.json` — **histórico completo de todas as tasks** (análises
  do Mentor, instruções ao Dev, revisões, branches, PRs). Hoje existem 5
  arquivos aqui.
- `state/validation.json` e `state/validation-logs/` — estado/log do último
  `/validar` (PIDs, portas, branch validada). Totalmente regenerável — não
  precisa ser copiado, `/validar` recria do zero na máquina nova.
- `state/tmp/` — arquivos de áudio temporários; sempre efêmero, nada a
  preservar.

`models/*.bin` também está fora do Git (`.gitignore`) — o modelo Whisper
(`ggml-small.bin`, ~487 MB hoje) precisa ser baixado de novo na máquina nova
se for usar transcrição de voz (ver seção 10).

### C. Dados sensíveis — nunca commitados, precisam ser recriados/copiados manualmente

- **`.env`** (raiz do projeto) — token do bot do Telegram, IDs de chat/usuário
  autorizados, e os caminhos absolutos dos três workspaces
  (`USERPULSE_PATH`, `PROMPTS_PATH`, `USERPULSE_VALIDATION_PATH`), que **quase
  certamente vão mudar** na máquina nova (caminhos absolutos não são
  portáveis). Recrie o `.env` do zero na máquina nova usando o modelo da
  seção 10 — nunca copie o `.env` antigo sem revisar os caminhos.
- Credencial Git/GitHub usada por `git credential fill` — não é armazenada
  pelo bridge em nenhum arquivo (nem em `state/`, nem em `.env`); precisa ser
  configurada de novo na máquina nova pelo mecanismo normal do Git
  (Git Credential Manager, `gh auth login`, etc.).
- Autenticação do próprio Claude Code CLI (`claude`) — também não é gerida
  pelo bridge; precisa de novo login na máquina nova.

### Checklist de migração segura

1. Clonar `telegram-agent` na máquina nova.
2. Clonar/posicionar `UserPulse-agent` e (se for usar `/validar`)
   `UserPulse-validation` na máquina nova, com Git/GitHub já autenticados.
3. Criar um `.env` novo (seção 10), com os caminhos absolutos reais da
   máquina nova — **nunca** reaproveitar caminhos do `.env` antigo sem
   conferir.
4. Instalar/autenticar o Claude Code CLI (`claude`) na máquina nova.
5. Se for usar mensagens de voz: baixar o modelo Whisper (`ggml-*.bin`) de
   novo e apontar `WHISPER_MODEL_PATH` (ou colocar em `models/`, que é o
   default).
6. **Copiar manualmente** (fora do Git — por exemplo via pendrive, SCP, ou
   sincronização de pastas) a pasta `state/` inteira da máquina antiga, **se**
   quiser preservar o histórico de tasks e a task atualmente selecionada.
   Isso é opcional: sem isso, o bridge simplesmente começa com "nenhuma tarefa
   registrada" na máquina nova, mas nada quebra.
7. Rodar `npm install` (no-op hoje) e `npm start` na máquina nova.
8. Confirmar com `/status` que tudo foi lido corretamente (ou, se copiou
   `state/`, que a task antiga aparece certa).

### Risco de perder histórico ao só clonar o repositório

**Sim, existe risco real.** Se alguém simplesmente clonar
`telegram-agent` do GitHub em outra máquina sem copiar `state/` à parte, todo
o histórico de tasks (`state/tasks/*.json`, incluindo análises do Mentor,
instruções ao Dev, revisões e referências de PR) **fica para trás** — porque
`state/` está no `.gitignore` de propósito (para nunca versionar dados de
runtime/local). O código não perde integridade (o bridge sobe normalmente e
começa "do zero"), mas o **histórico** só é preservado se `state/` for copiado
manualmente como no passo 6 acima.

---

## 14. O que nunca fazer

- **Nunca** fazer merge automático de uma PR criada por `/aprovar` — merge é
  sempre manual, no GitHub.
- **Nunca** force push (`--force`/`--force-with-lease`) em nenhum workspace
  gerenciado pelo bridge.
- **Nunca** commitar segredos — em especial, nunca versionar `.env` (já
  coberto pelo `.gitignore`, mas vale reforçar antes de qualquer `git add`
  manual).
- **Nunca** usar o checkout manual de `UserPulse` nas operações do bot — o
  bridge só deve operar em `UserPulse-agent` (Mentor/Dev/`/aprovar`) e
  `UserPulse-validation` (`/validar`).
- **Nunca** resolver conflito automaticamente — nem entre workspaces, nem
  entre a task e `origin/main` (é exatamente o que o preflight de
  concorrência da seção 7 existe para impedir).
- **Nunca** sobrescrever trabalho de terceiros — qualquer divergência ou
  sujeira inesperada em qualquer um dos workspaces deve bloquear a operação
  com uma mensagem clara, nunca ser descartada/sobrescrita silenciosamente.
