import type { DemoItem } from './sealVerify';

/** A change-order on a custom-home build: ingest → (contract, price) → authorize → emit. */
export const PRISTINE_ITEMS: DemoItem[] = [
  { id: 'd0', label: 'Ingest request', executor: 'dispatch', action: 'intent.ingest', parents: [],
    inputPayload: 'co-0142: relocate kitchen island + add 30A circuit',
    outputPayload: 'scope=electrical+millwork; ref=CO-0142', scope: 'read:intake', secretRef: 'tok_intake_1' },
  { id: 'd1', label: 'Pull contract scope', executor: 'dispatch', action: 'retrieve.contract', parents: ['d0'],
    inputPayload: 'contract=LRK-2025-11; rev=3',
    outputPayload: 'baseline_total=$842,000; allowance_electrical=$18,500', scope: 'read:contracts', secretRef: 'tok_contracts_7' },
  { id: 'd2', label: 'Price the change', executor: 'dispatch', action: 'compute.costdelta', parents: ['d0'],
    inputPayload: 'millwork=14h@$95; electrical=30A run + permit',
    outputPayload: 'cost_delta=$4,275; lead_time=+6 days', scope: 'read:ratecard', secretRef: 'tok_rates_2' },
  { id: 'd3', label: 'Authorize', executor: 'dispatch', action: 'authz.approve', parents: ['d1', 'd2'],
    inputPayload: 'delta=$4,275; approver=owner:r.castellanos',
    outputPayload: 'approved=true; basis=under_$5k_owner_authority', scope: 'approve:changeorder<=5000', secretRef: 'tok_authz_owner' },
  { id: 'd4', label: 'Issue amendment', executor: 'dispatch', action: 'emit.amendment', parents: ['d3'],
    inputPayload: 'co=CO-0142; delta=$4,275; approved=true',
    outputPayload: 'amendment=AMD-0142.pdf; notified=owner,gc,sub', scope: 'write:amendments', secretRef: 'tok_amend_4' },
];

export interface TamperPreset {
  id: string;
  label: string;
  target: string;
  field: 'outputPayload' | 'scope';
  value: string;
}

export const TAMPERS: TamperPreset[] = [
  { id: 'price', label: 'Alter the agreed price', target: 'd2', field: 'outputPayload',
    value: 'cost_delta=$11,900; lead_time=+6 days' },
  { id: 'authz', label: 'Forge approval authority', target: 'd3', field: 'scope',
    value: 'approve:changeorder<=50000' },
  { id: 'scope', label: 'Rewrite delivered scope', target: 'd4', field: 'outputPayload',
    value: 'amendment=AMD-0142.pdf; notified=owner' },
];
