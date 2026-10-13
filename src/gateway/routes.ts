// API Gateway routes for Fase 2
import { Router } from 'express';
import { authRouter } from '../app/api/auth/routes';
import { messagesRouter } from '../app/api/messages/routes';
import { systemRouter } from '../app/api/system/routes';

const router = Router();

router.use('/auth', authRouter);
router.use('/messages', messagesRouter);
router.use('/system', systemRouter);

export { router as gatewayRouter };
