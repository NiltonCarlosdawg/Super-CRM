import { prisma } from '../lib/prisma';

export interface AnalyticsDashboard {
  totalUsers: number;
  activeUsers: number;
  newUsersThisMonth: number;
  messagesThisMonth: number;
  campaignsActive: number;
  conversionRate: number;
}

/** Obter dashboard de analytics */
export async function getDashboard(): Promise<AnalyticsDashboard> {
  const [totalUsers, activeUsers, newUsersThisMonth, messagesThisMonth, campaignsActive] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { lastLogin: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } } }),
    prisma.user.count({ where: { createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } } }),
    prisma.message.count({ where: { createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } } }),
    prisma.campaign.count({ where: { status: 'running' } }),
  ]);

  // Taxa de conversão simplificada
  const totalLeads = await prisma.lead.count();
  const convertedLeads = await prisma.lead.count({ where: { status: 'converted' } });
  const conversionRate = totalLeads > 0 ? (convertedLeads / totalLeads) * 100 : 0;

  return {
    totalUsers,
    activeUsers,
    newUsersThisMonth,
    messagesThisMonth,
    campaignsActive,
    conversionRate,
  };
}

export interface UserBehavior {
  userId: string;
  totalMessages: number;
  averageMessageLength: number;
  favoriteTriggers: string[];
  lastActivity: Date;
}

/** Obter comportamento do usuário */
export async function getUserBehavior(userId: string): Promise<UserBehavior> {
  const totalMessages = await prisma.message.count({ where: { sessionId: userId } });
  
  return {
    userId,
    totalMessages,
    averageMessageLength: 0, // Placeholder
    favoriteTriggers: [], // Placeholder
    lastActivity: new Date(),
  };
}
