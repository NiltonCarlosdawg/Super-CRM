import { prisma } from '../lib/prisma';
import { authAdapter } from '../adapters/auth/auth';

export interface FollowupSequence {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  createdById: string;
  lineId: string;
  sequences: FollowupStep[];
}

export interface FollowupStep {
  id: string;
  sequenceId: string;
  position: number;
  delayHours: number;
  condition: string;
  contentMode: string;
  templateText: string;
  aiPrompt: string;
  active: boolean;
}

/** Criar sequência de follow-up */
export async function createSequence(data: {
  name: string;
  description: string;
  lineId: string;
  steps: FollowupStep[];
}) {
  return prisma.followupSequence.create({
    data: {
      name: data.name,
      description: data.description,
      lineId: data.lineId,
      steps: data.steps,
      enabled: true,
    },
  });
}

/** Listar sequências por linha */
export async function listSequencesByLine(lineId: string) {
  return prisma.followupSequence.findMany({
    where: { lineId },
    include: { steps: true },
  });
}

/** Remover sequência */
export async function removeSequence(sequenceId: string) {
  return prisma.followupSequence.delete({ where: { id: sequenceId } });
}
