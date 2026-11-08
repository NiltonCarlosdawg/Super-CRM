// Fase 4, Task 9: um tick por (campanha, conta). Serializa um envio, aplica
// janela silenciosa/ramp/caps/backlog e guardas de pausa; nunca retoma sozinho.

import {
  accountAgeDays,
  dayStartInTz,
  effectiveDailyCap,
  isQuietHours,
  nextCampaignWindowOpen,
  nextDayStartInTz,
  randomDelayMs,
} from '../../domain/campaigns/rhythm.js';
import { renderCampaignMessage } from '../../domain/campaigns/template.js';
import type { CampaignRepository } from '../../ports/campaigns.js';
import type {
  CampaignDispatchStore,
  CampaignOutbox,
  ContactNameSource,
  ConversationFinder,
  PauseApplier,
  PauseGuard,
} from '../../ports/campaign-dispatch.js';
import type { CampaignRecipientStore } from '../../ports/campaign-recipients.js';
import type { AccountGate } from '../../ports/campaigns.js';
import type { TenantScope } from '../../ports/tenancy.js';
import type { CampaignConfig } from '../../modules/campaigns/config.js';

export type TickReason =
  | 'campaign_not_running'
  | 'scheduled_not_due'
  | 'account_unavailable'
  | 'quiet_hours'
  | 'daily_cap'
  | 'conversation_backlog'
  | 'no_pending_recipient'
  | 'paused';

export type TickResult =
  | { outcome: 'idle'; reason: TickReason }
  | { outcome: 'waiting'; reason: TickReason; retryAt: Date }
  | { outcome: 'sent'; recipientId: string; outboxKey: string; retryAt: Date }
  | { outcome: 'completed' };

export interface TickDeps {
  scope: TenantScope;
  campaigns: CampaignRepository;
  dispatch: CampaignDispatchStore;
  recipients: CampaignRecipientStore;
  contacts: ContactNameSource;
  accounts: AccountGate;
  outbox: CampaignOutbox;
  conversations: ConversationFinder;
  pauseGuards: readonly PauseGuard[];
  applyPause: PauseApplier;
  now(): Date;
  rng(): number;
  cfg: CampaignConfig;
  logger?: (line: string) => void;
}

export async function processCampaignTick(
  input: { campaignId: string; accountId: string },
  deps: TickDeps,
): Promise<TickResult> {
  const now = deps.now();
  const delay = (): Date => new Date(now.getTime() + randomDelayMs(deps.cfg.delay, deps.rng));

  const campaign = await deps.campaigns.findById(deps.scope, input.campaignId);
  if (campaign === null || !['scheduled', 'running', 'paused'].includes(campaign.status)) {
    return { outcome: 'idle', reason: 'campaign_not_running' };
  }
  if (campaign.status === 'paused') return { outcome: 'idle', reason: 'paused' };
  if (campaign.status === 'scheduled' && campaign.scheduledAt !== null && now < campaign.scheduledAt) {
    return { outcome: 'waiting', reason: 'scheduled_not_due', retryAt: campaign.scheduledAt };
  }

  const accounts = await deps.accounts.find(deps.scope, [input.accountId]);
  const account = accounts[0];
  if (account === undefined) {
    return { outcome: 'waiting', reason: 'account_unavailable', retryAt: delay() };
  }

  // As guardas correm ANTES do gate de disponibilidade: uma sessão caída tem de
  // PAUSAR a campanha (Task 10), não apenas esperar.
  for (const guard of deps.pauseGuards) {
    const hit = await guard({ campaign, account, now });
    if (hit !== null) {
      await deps.applyPause.apply({
        campaignId: campaign.id,
        reason: hit.reason,
        actorId: null,
        now,
      });
      return { outcome: 'idle', reason: 'paused' };
    }
  }

  if (account.purpose !== 'campaigns' || account.status !== 'connected') {
    return { outcome: 'waiting', reason: 'account_unavailable', retryAt: delay() };
  }

  if (campaign.status === 'scheduled') {
    const started = await deps.campaigns.compareAndSetStatus(deps.scope, campaign.id, ['scheduled'], {
      status: 'running',
    });
    if (started === null) return { outcome: 'idle', reason: 'campaign_not_running' };
  }

  // Consentimento retirado/opt-out depois da materialização: nunca chega à outbox.
  await deps.dispatch.skipIneligibleContacts(deps.scope, campaign.id, now);

  const recipient = await deps.dispatch.nextPending(deps.scope, campaign.id, input.accountId);
  if (recipient === null) {
    const pending = await deps.dispatch.pendingCount(deps.scope, campaign.id);
    if (pending === 0) {
      await deps.campaigns.compareAndSetStatus(deps.scope, campaign.id, ['running', 'scheduled'], {
        status: 'completed',
      });
      return { outcome: 'completed' };
    }
    return { outcome: 'idle', reason: 'no_pending_recipient' };
  }

  if (isQuietHours(now, deps.cfg)) {
    return { outcome: 'waiting', reason: 'quiet_hours', retryAt: nextCampaignWindowOpen(now, deps.cfg) };
  }

  const cap = effectiveDailyCap({
    ageDays: accountAgeDays(account.createdAt, now),
    ramp: deps.cfg.ramp,
    campaignDailyLimit: campaign.dailyLimit,
  });
  const sentToday = await deps.dispatch.countEnqueuedSince(
    deps.scope,
    input.accountId,
    dayStartInTz(now, deps.cfg.timezone),
  );
  if (sentToday >= cap) {
    return { outcome: 'waiting', reason: 'daily_cap', retryAt: nextDayStartInTz(now, deps.cfg.timezone) };
  }

  const backlog = await deps.outbox.pendingConversationCount(input.accountId);
  if (backlog > 0) return { outcome: 'waiting', reason: 'conversation_backlog', retryAt: delay() };

  const name = await deps.contacts.displayName(deps.scope, recipient.contactId);
  const text = renderCampaignMessage(
    { template: campaign.messageTemplate, contactName: name },
    deps.cfg,
  );
  const conversation = await deps.conversations.findOrCreateForCampaign(deps.scope, {
    accountId: input.accountId,
    contactId: recipient.contactId,
  });
  const outboxKey = `campaign:${campaign.id}:recipient:${recipient.id}:step:${recipient.step}`;

  await deps.outbox.enqueue({
    accountId: input.accountId,
    contactId: recipient.contactId,
    conversationId: conversation.id,
    sender: 'campaign',
    text,
    idempotencyKey: outboxKey,
    scheduledAt: now,
  });
  await deps.recipients.markEnqueued(deps.scope, recipient.id, outboxKey, now);

  deps.logger?.(
    `campaign.tick sent campaign=${campaign.id} account=${input.accountId} recipient=${recipient.id}`,
  );
  return { outcome: 'sent', recipientId: recipient.id, outboxKey, retryAt: delay() };
}
