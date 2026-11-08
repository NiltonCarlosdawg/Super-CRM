// Fase 4, Task 6: audiência de campanha. Só devolve uuids de contactos com
// consentimento de marketing e sem opt-out; nunca expõe telefones.

import type { TenantScope } from './tenancy.js';

export interface ContactAudience {
  /** Contactos com marketing_consent = true E opted_out_at IS NULL, ordenados por id. Só uuids. */
  eligibleContactIds(scope: TenantScope): Promise<readonly string[]>;
}
