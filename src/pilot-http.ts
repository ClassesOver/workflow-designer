import {createAiHttp} from './ai-http.ts';
import {createPilotAccess} from './pilot-access.ts';
import type {ProposalStore} from './proposal-store.ts';

type Options=Parameters<typeof createPilotAccess>[0]&{store:ProposalStore};

/** Integration point for a trusted same-origin HTTPS host. No public listener,
 * login implementation, default account, externally accessible model or file upload. */
export function createPilotHttp({store,...access}:Options) {
 return createAiHttp({
  store,
  authorize:createPilotAccess(access),
  provider:{async *stream(){throw new Error('Pilot AI is not configured');}},
  async catalog(){return {fields:[],roles:[]};},
  async resolveMaterials(){return [];},
 });
}
