// Fase 4, Task 10: pausa automática. Quem retoma é SEMPRE um humano (API);
// nenhum job tem caminho paused → running (docs/04 §7).

import { evaluateVolumePause } from '../../domain/campaigns/auto-pause.js';
import type { Campaign, PauseReason } from '../../domain/campaigns/types.js';
import type { AccountGate, CampaignRepository } from '../../ports/campaigns.js';
import type {
  CampaignAlertSink,
  DeliveryProbe,
  RecipientStatsStore,
} from '../../ports/campaign-stats.js';
import type { PauseApplier, PauseGuard } from '../../ports/campaign-dispatch.js';
import type { Audit } from '../../ports/audit.js';
import type { TenantScope } from '../../ports/tenancy.js';
import type { CampaignConfig } from '../../modules/campaigns/config.js';
import type { ReconcileFailures } from './reconcile-failures.js';

export interface PauseCampaignDeps {
  scope: TenantScope;
  campaigns: CampaignRepository;
  audit: Audit;
  alerts: CampaignAlertSink;
}

export type PauseCampaign = (input: {
  campaignId: string;
  accountId: string | null;
  reason: PauseReason;
  actorId: string | null;
  now: Date;
}) => Promise<{ paused: Campaign | null }>;

export function makePauseCampaign(deps: PauseCampaignDeps): PauseCampaign {
  return async (input) => {
    const auto = input.actorId === null;
    const paused = await deps.campaigns.compareAndSetStatus(
      deps.scope,
      input.campaignId,
      ['running', 'scheduled'],
      {
        status: 'paused',
        pauseReason: input.reason,
        pausedAt: input.now,
        pausedBy: input.actorId,
      },
    );
    if (paused === null) return { paused: null };

    await deps.audit.record({
      tenantId: deps.scope.tenantId,
      actorId: input.actorId,
      action: auto ? 'campaign.auto_paused' : 'campaign.paused',
      entity: 'campaign',
      entityId: paused.id,
      detail: { reason: input.reason },
      at: input.now,
    });
    if (auto) {
      await deps.alerts.campaignPaused({
        tenantId: deps.scope.tenantId,
        campaignId: paused.id,
        accountId: input.accountId ?? '',
        reason: input.reason,
        auto,
        at: input.now,
      });
    }
    return { paused };
  };
}

/** Adaptador da porta da Task 9: `true` só quando a campanha mudou mesmo. */
export function makePauseApplier(deps: PauseCampaignDeps): PauseApplier {
  const pause = makePauseCampaign(deps);
  return {
    async apply(input) {
      const result = await pause({
        campaignId: input.campaignId,
        accountId: null,
        reason: input.reason,
        actorId: input.actorId,
        now: input.now,
      });
      return result.paused !== null;
    },
  };
}

export function sessionPauseGuard(deps: { accounts: AccountGate }): PauseGuard {
  return async (ctx) => {
    const [account] = await deps.accounts.find({ tenantId: ctx.campaign.tenantId }, [ctx.account.id]);
    if (account === undefined || account.status !== 'connected') return { reason: 'session_down' };
    return null;
  };
}

export function volumePauseGuard(deps: {
  stats: RecipientStatsStore;
  probe: DeliveryProbe;
  cfg: CampaignConfig;
  reconcile: ReconcileFailures;
}): PauseGuard {
  return async (ctx) => {
    const scope = { tenantId: ctx.campaign.tenantId };
    await deps.reconcile(scope, ctx.account.id, {
      stats: deps.stats,
      probe: deps.probe,
      now: () => ctx.now,
    });
    const window = await deps.stats.volumeWindow(
      scope,
      ctx.account.id,
      ctx.campaign.resumedAt ?? ctx.campaign.createdAt,
      { failWindow: deps.cfg.pause.failWindow, optOutWindow: deps.cfg.pause.optOutWindow },
    );
    const reason = evaluateVolumePause(window, deps.cfg.pause);
    return reason === null ? null : { reason };
  };
}
