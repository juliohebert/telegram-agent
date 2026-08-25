import dns from 'node:dns';

// IPv6 desta maquina esta com rota quebrada para api.telegram.org, o que causa
// UND_ERR_CONNECT_TIMEOUT intermitente no fetch nativo do Node quando o DNS
// retorna AAAA junto com A. Forcar IPv4 primeiro antes de qualquer chamada de rede.
dns.setDefaultResultOrder('ipv4first');

async function main() {
  let config;
  try {
    ({ config } = await import('./config.js'));
  } catch (e) {
    console.error(`Falha ao iniciar: ${e.message}`);
    process.exit(1);
  }

  console.log(`Config OK. USERPULSE_PATH=${config.userpulsePath}`);
  console.log(`Config OK. PROMPTS_PATH=${config.promptsPath}`);

  const fs = await import('node:fs');
  if (!fs.existsSync(config.whisperModelPath)) {
    console.warn(
      `Aviso: modelo Whisper nao encontrado em ${config.whisperModelPath}. Mensagens de voz/audio falharao ate um modelo ser configurado (WHISPER_MODEL_PATH).`
    );
  }

  const { startBot } = await import('./bot.js');

  process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection:', reason instanceof Error ? reason.message : reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('uncaughtException:', err.message);
  });

  await startBot();
}

main().catch((e) => {
  console.error('Erro fatal:', e.message);
  process.exit(1);
});
