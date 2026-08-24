# UserPulse - Contexto compartilhado

Você está trabalhando no projeto UserPulse.

## Idioma

Sempre responder em PT-BR.

Seja direto, técnico e econômico em tokens.

## Projeto

SaaS multi-tenant.

Stack principal:
- Backend Node.js + Express + TypeScript + Prisma + PostgreSQL
- Frontend React + Vite + Tailwind
- Widget JavaScript vanilla
- Node 20+

Consultar como fonte de verdade, somente quando necessário:
- AGENTS.md
- CLAUDE.md
- DESIGN.md
- docs/agente-mentor.md
- código atual

Código atual prevalece quando documentação estiver desatualizada.

## Princípios

Priorizar:
- multi-tenancy;
- isolamento entre tenants;
- permissões;
- plano/licença;
- segurança;
- integridade de dados;
- migrations;
- regressões;
- compatibilidade do widget;
- lifecycle SPA;
- UX;
- testes.

Evitar:
- refactor amplo;
- novas dependências sem necessidade;
- mudanças fora do escopo;
- auditorias gerais sem motivo;
- leitura desnecessária de arquivos.

## Git

Outro desenvolvedor também trabalha no projeto.

Sempre:
- git fetch antes de publicar;
- revisar git status;
- comparar com origin/main;
- preservar alterações de terceiros;
- nunca usar force/force-with-lease;
- nunca usar git add .;
- nunca sobrescrever mudanças de terceiros;
- parar em conflito relevante.

Remotes:
- origin = Git principal
- clinic = Quark/ESIG

Os históricos de origin e clinic são independentes.

Nunca fazer merge entre esses históricos.

O clinic é atualizado por snapshot, preservando:
- Dockerfile
- .dockerignore
- .gitlab-ci.yml

Nunca fazer push direto em:
- main
- clinic/producao

## Testes

Executar somente testes/checks relevantes.

Validações comuns:
- npm test --prefix server
- npm run build --prefix web
- TypeScript
- node --check quando widget for alterado
- git diff --check

Não usar browser automaticamente, exceto na condição especifica definida no papel do Desenvolvedor (ver developer.md, "Validação visual"). Fora dessa condição, a validação visual/manual é feita pelo usuário.

## Autorização

Nunca fazer automaticamente:
- commit;
- push;
- merge;
- deploy;
- migration em produção;
- alterações destrutivas.

Essas ações exigem solicitação explícita do usuário.