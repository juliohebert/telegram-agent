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
