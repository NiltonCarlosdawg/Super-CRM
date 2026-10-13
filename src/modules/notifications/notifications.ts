import { prisma } from '../lib/prisma';
import { authAdapter } from '../adapters/auth/auth';

export interface Notification {
  id: string;
  userId: string;
  title: string;
  message: string;
  type: 'info' | 'warning' | 'error' | 'success';
  read: boolean;
  createdAt: Date;
}

export interface NotificationFilters {
  userId: string;
  read?: boolean;
  type?: string;
  startDate?: Date;
  endDate?: Date;
}

export async function createNotification(
  userId: string,
  title: string,
  message: string,
  type: Notification['type'] = 'info'
): Promise<Notification> {
  const notification: Notification = {
    id: crypto.randomUUID(),
    userId,
    title,
    message,
    type,
    read: false,
    createdAt: new Date(),
  };

  await prisma.notification.create({
    data: notification,
  });

  return notification;
}

export async function getNotifications(filters: NotificationFilters): Promise<Notification[]> {
  const where: any = {
    userId: filters.userId,
  };

  if (filters.read !== undefined) {
    where.read = filters.read;
  }

  if (filters.type) {
    where.type = filters.type;
  }

  if (filters.startDate) {
    where.createdAt = { gte: filters.startDate };
  }

  if (filters.endDate) {
    where.createdAt = { lte: filters.endDate };
  }

  return prisma.notification.findMany({ where });
}

export async function markNotificationAsRead(notificationId: string, userId: string): Promise<boolean> {
  try {
    await prisma.notification.update({
      where: { id: notificationId, userId },
      data: { read: true },
    });
    return true;
  } catch {
    return false;
  }
}
