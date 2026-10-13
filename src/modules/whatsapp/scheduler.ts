const checkScheduledMessages = async () => {
  // Buscar mensagens programadas para enviar
  const pendingMessages = await prisma.scheduledMessage.findMany({
    where: {
      status: 'pending',
      sendAt: {
        lte: new Date(),
      },
    },
  });

  logger.debug(`Scheduler: Checking for messages due before ${new Date().toISOString()}...`);

  let sentCount = 0;
  let failedCount = 0;

  for (const msg of pendingMessages) {
    try {
      // Verificar se a sessão está conectada
      const isConnected = await checkSessionConnected(msg.sessionId);
      if (!isConnected) {
        logger.warn(`Scheduler: Session ${msg.sessionId} not connected, skipping`);
        await prisma.scheduledMessage.update({
          where: { id: msg.id },
          data: { status: 'failed' },
        });
        failedCount++;
        continue;
      }

      // Enviar mensagem
      const sendResult = await prisma.$transaction(async (tx) => {
        const send = await sendWhatsAppMessage(
          msg.sessionId,
          msg.jid,
          { type: msg.messageType, text: msg.content },
          msg.payload
        );

        // Atualizar status no banco
        await tx.scheduledMessage.update({
          where: { id: msg.id },
          data: {
            status: 'sent',
            sentAt: new Date(),
          },
        });

        return send;
      });

      sentCount++;
      logger.success(`Scheduler: Msg ${msg.id} sent to ${msg.jid}`);
    } catch (error) {
      logger.error(`Scheduler: Failed to send msg ${msg.id}`, error);
      await prisma.scheduledMessage.update({
        where: { id: msg.id },
        data: { status: 'failed' },
      });
      failedCount++;
    }
  }

  logger.info(`Scheduler: ${sentCount} sent, ${failedCount} failed`);
  return { sentCount, failedCount };
};

export function startScheduler() {
  // Verificar mensagens pendentes a cada 30 segundos
  checkScheduledMessages();
  setInterval(checkScheduledMessages, 30 * 1000);

  logger.info('Scheduler iniciado - a cada 30s');
};
