import { prisma } from '../lib/prisma';
import { authAdapter } from '../adapters/auth/auth';

export interface Campaign {
  id: string;
  name: string;
  status: 'draft' | 'scheduled' | 'running' | 'completed' | 'cancelled';
  messageTemplate: string;
  dailyLimit?: number;
  scheduledAt?: Date;
  createdById: string;
  accounts: string[];
  recipients?: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** Criar nova campanha */
export async function createCampaign(data: {
  name: string;
  messageTemplate: string;
  dailyLimit?: number;
  accountIds: string[];
  scheduledAt?: Date;
}) {
  const campaign = await prisma.campaign.create({
    data: {
      name: data.name,
      messageTemplate: data.messageTemplate,
      dailyLimit: data.dailyLimit,
      scheduledAt: data.scheduledAt,
      createdById: data.createdById,
      accounts: data.accountIds,
    },
  });
  return campaign;
}

/** Listar campanhas */
export async function listCampaigns(userId: string) {
  return prisma.campaign.findMany({
    where: { createdById: userId },
    orderBy: { createdAt: 'desc' },
  });
}

/** Atualizar campanha */
export async function updateCampaign(
  campaignId: string,
  data: { name?: string; messageTemplate?: string; dailyLimit?: number; status?: string }
) {
  return prisma.campaign.update({
    where: { id: campaignId },
    data,
  });
}

/** Remover campanha */
export async function removeCampaign(campaignId: string) {
  return prisma.campaign.delete({ where: { id: campaignId } });
}
