import { prisma } from '../lib/prisma';
import { authAdapter } from '../adapters/auth/auth';

export interface ReportSummary {
  totalMessages: number;
  totalContacts: number;
  totalLeads: number;
  totalCampaigns: number;
  messagesThisMonth: number;
  contactsThisMonth: number;
}

export interface ReportData {
  summary: ReportSummary;
  messagesByType: Record<string, number>;
  messagesByStatus: Record<string, number>;
  dailyActivity: Array<{ date: string; count: number }>;
}

export async function getReportSummary(): Promise<ReportSummary> {
  const [totalMessages, totalContacts, totalLeads, totalCampaigns, messagesThisMonth, contactsThisMonth] = await Promise.all([
    prisma.message.count(),
    prisma.contact.count(),
    prisma.lead.count(),
    prisma.campaign.count(),
    prisma.message.count({
      where: {
        createdAt: {
          gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
        },
      },
    }),
    prisma.contact.count({
      where: {
        createdAt: {
          gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
        },
      },
    }),
  ]);

  return {
    totalMessages,
    totalContacts,
    totalLeads,
    totalCampaigns,
    messagesThisMonth,
    contactsThisMonth,
  };
}

export async function getReportData(): Promise<ReportData> {
  const summary = await getReportSummary();
  const [messagesByType, messagesByStatus, dailyActivity] = await Promise.all([
    prisma.message.groupBy({
      by: ['type'],
      _count: { type: true },
    }),
    prisma.message.groupBy({
      by: ['status'],
      _count: { status: true },
    }),
    prisma.message.findMany({
      where: {
        createdAt: {
          gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 30,
    }).then((msgs) =>
      msgs.map((m) => ({
        date: m.createdAt.toISOString().split('T')[0],
        count: 1,
      })),
    ),
  ]);

  return {
    summary,
    messagesByType: messagesByType.reduce((acc, curr) => {
      acc[curr.type] = curr._count.type;
      return acc;
    }, {} as Record<string, number>),
    messagesByStatus: messagesByStatus.reduce((acc, curr) => {
      acc[curr.status] = curr._count.status;
      return acc;
    }, {} as Record<string, number>),
    dailyActivity,
  };
}

export async function getDailyActivity(days: number = 30): Promise<Array<{ date: string; count: number }>> {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  return prisma.message.findMany({
    where: {
      createdAt: {
        gte: startDate,
      },
    },
    orderBy: { createdAt: 'asc' },
  }).then((msgs) =>
    msgs.reduce((acc, curr) => {
      const date = curr.createdAt.toISOString().split('T')[0];
      acc[date] = (acc[date] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    Object.entries(acc).map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date)),
  );
}
