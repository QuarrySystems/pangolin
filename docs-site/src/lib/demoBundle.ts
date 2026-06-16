import type { DemoItem } from './sealVerify';

export interface TamperPreset {
  id: string;
  label: string;
  target: string;
  field: 'outputPayload' | 'scope';
  value: string;
}

/** A reskinnable sealed plan: same fork→merge shape, different domain.
 *  Every bundle is a 5-dispatch DAG (d0 → {d1,d2} → d3 → d4) ending in an
 *  action, with three parallel tampers: an amount/value edit on the computed
 *  node (d2), an authority forge on the authorize node (d3, `scope`), and a
 *  delivered-record rewrite on the emit node (d4). The tamper beats are
 *  byte-identical across domains; only the data changes. Synthetic data only. */
export interface DemoBundle {
  id: string;
  /** Selector button text (the prospect-facing domain framing). */
  label: string;
  /** Header subtitle, e.g. "Sealed change-order bundle · CO-0142". */
  subtitle: string;
  items: DemoItem[];
  tampers: TamperPreset[];
}

/** A change-order on a custom-home build: ingest → (contract, price) → authorize → emit.
 *  The generic default — used when no domain is selected. */
const changeOrder: DemoBundle = {
  id: 'change-order',
  label: 'Change order (generic)',
  subtitle: 'Sealed change-order bundle · CO-0142',
  items: [
    {
      id: 'd0',
      label: 'Ingest request',
      executor: 'dispatch',
      action: 'intent.ingest',
      parents: [],
      inputPayload: 'co-0142: relocate kitchen island + add 30A circuit',
      outputPayload: 'scope=electrical+millwork; ref=CO-0142',
      scope: 'read:intake',
      secretRef: 'tok_intake_1',
    },
    {
      id: 'd1',
      label: 'Pull contract scope',
      executor: 'dispatch',
      action: 'retrieve.contract',
      parents: ['d0'],
      inputPayload: 'contract=LRK-2025-11; rev=3',
      outputPayload: 'baseline_total=$842,000; allowance_electrical=$18,500',
      scope: 'read:contracts',
      secretRef: 'tok_contracts_7',
    },
    {
      id: 'd2',
      label: 'Price the change',
      executor: 'dispatch',
      action: 'compute.costdelta',
      parents: ['d0'],
      inputPayload: 'millwork=14h@$95; electrical=30A run + permit',
      outputPayload: 'cost_delta=$4,275; lead_time=+6 days',
      scope: 'read:ratecard',
      secretRef: 'tok_rates_2',
    },
    {
      id: 'd3',
      label: 'Authorize',
      executor: 'dispatch',
      action: 'authz.approve',
      parents: ['d1', 'd2'],
      inputPayload: 'delta=$4,275; approver=owner:r.castellanos',
      outputPayload: 'approved=true; basis=under_$5k_owner_authority',
      scope: 'approve:changeorder<=5000',
      secretRef: 'tok_authz_owner',
    },
    {
      id: 'd4',
      label: 'Issue amendment',
      executor: 'dispatch',
      action: 'emit.amendment',
      parents: ['d3'],
      inputPayload: 'co=CO-0142; delta=$4,275; approved=true',
      outputPayload: 'amendment=AMD-0142.pdf; notified=owner,gc,sub',
      scope: 'write:amendments',
      secretRef: 'tok_amend_4',
    },
  ],
  tampers: [
    {
      id: 'price',
      label: 'Alter the agreed price',
      target: 'd2',
      field: 'outputPayload',
      value: 'cost_delta=$11,900; lead_time=+6 days',
    },
    {
      id: 'authz',
      label: 'Forge approval authority',
      target: 'd3',
      field: 'scope',
      value: 'approve:changeorder<=50000',
    },
    {
      id: 'scope',
      label: 'Rewrite delivered scope',
      target: 'd4',
      field: 'outputPayload',
      value: 'amendment=AMD-0142.pdf; notified=owner',
    },
  ],
};

/** Insurance — denied-claim appeal. Maps to Aegis / Elysian / Avallon.
 *  Synthetic claim + member data; no real PHI. */
const claimsAppeal: DemoBundle = {
  id: 'claims-appeal',
  label: 'Insurance · denied-claim appeal',
  subtitle: 'Sealed claim-appeal bundle · CLM-88231',
  items: [
    {
      id: 'd0',
      label: 'Ingest denial',
      executor: 'dispatch',
      action: 'intent.ingest',
      parents: [],
      inputPayload: 'CLM-88231: MRI lumbar (72148) denied — not medically necessary',
      outputPayload: 'scope=appeal; ref=CLM-88231',
      scope: 'read:intake',
      secretRef: 'tok_intake_1',
    },
    {
      id: 'd1',
      label: 'Pull policy criteria',
      executor: 'dispatch',
      action: 'retrieve.policy',
      parents: ['d0'],
      inputPayload: 'policy=PPO-2025; section=advanced_imaging',
      outputPayload: 'criteria=conservative_care_6wk; covered=true',
      scope: 'read:policy',
      secretRef: 'tok_policy_7',
    },
    {
      id: 'd2',
      label: 'Assemble clinical evidence',
      executor: 'dispatch',
      action: 'retrieve.clinical',
      parents: ['d0'],
      inputPayload: 'member chart (synthetic); PT + imaging history',
      outputPayload: 'pt_weeks=6; radiculopathy=ongoing; conservative_care=documented',
      scope: 'read:phi',
      secretRef: 'tok_ehr_2',
    },
    {
      id: 'd3',
      label: 'Authorize appeal',
      executor: 'dispatch',
      action: 'authz.approve',
      parents: ['d1', 'd2'],
      inputPayload: 'criteria_met=true; reviewer=clinician:nguyen',
      outputPayload: 'approved=true; basis=criteria_satisfied',
      scope: 'approve:appeal',
      secretRef: 'tok_authz_clin',
    },
    {
      id: 'd4',
      label: 'Submit to payer',
      executor: 'dispatch',
      action: 'emit.submission',
      parents: ['d3'],
      inputPayload: 'clm=CLM-88231; appeal packet',
      outputPayload: 'submission=APL-88231.pdf; payer_ack=queued',
      scope: 'write:payer-portal',
      secretRef: 'tok_payer_4',
    },
  ],
  tampers: [
    {
      id: 'evidence',
      label: 'Fabricate clinical evidence',
      target: 'd2',
      field: 'outputPayload',
      value: 'pt_weeks=12; radiculopathy=severe; surgery=recommended',
    },
    {
      id: 'authz',
      label: 'Forge reviewer authority',
      target: 'd3',
      field: 'scope',
      value: 'approve:appeal:any-criteria',
    },
    {
      id: 'scope',
      label: 'Rewrite what was submitted',
      target: 'd4',
      field: 'outputPayload',
      value: 'submission=APL-88231.pdf; payer_ack=queued; expedited=true',
    },
  ],
};

/** Legal — immigration petition filing. Maps to CaseBlink / Gale / Visalaw.
 *  Synthetic case + applicant data. */
const immigrationFiling: DemoBundle = {
  id: 'immigration-filing',
  label: 'Legal · immigration filing',
  subtitle: 'Sealed petition bundle · CASE-2207',
  items: [
    {
      id: 'd0',
      label: 'Ingest case',
      executor: 'dispatch',
      action: 'intent.ingest',
      parents: [],
      inputPayload: 'CASE-2207: I-140 EB-2 NIW; applicant file (synthetic)',
      outputPayload: 'scope=petition; ref=CASE-2207',
      scope: 'read:intake',
      secretRef: 'tok_intake_1',
    },
    {
      id: 'd1',
      label: 'Pull eligibility criteria',
      executor: 'dispatch',
      action: 'retrieve.regs',
      parents: ['d0'],
      inputPayload: 'category=EB-2 NIW; rev=2026.1',
      outputPayload: 'prongs=3; evidence=advanced_degree+national_interest',
      scope: 'read:uscis-policy',
      secretRef: 'tok_regs_7',
    },
    {
      id: 'd2',
      label: 'Assemble exhibits',
      executor: 'dispatch',
      action: 'compile.exhibits',
      parents: ['d0'],
      inputPayload: 'diplomas, recommendation letters, publications',
      outputPayload: 'exhibits=14; pages=210; prongs_supported=3',
      scope: 'read:client-docs',
      secretRef: 'tok_docs_2',
    },
    {
      id: 'd3',
      label: 'Attorney authorize',
      executor: 'dispatch',
      action: 'authz.approve',
      parents: ['d1', 'd2'],
      inputPayload: 'prongs_met=3; attorney=bar:CA-284417',
      outputPayload: 'approved=true; basis=attorney_of_record',
      scope: 'approve:filing',
      secretRef: 'tok_authz_atty',
    },
    {
      id: 'd4',
      label: 'E-file petition',
      executor: 'dispatch',
      action: 'emit.filing',
      parents: ['d3'],
      inputPayload: 'form=I-140; exhibits=14',
      outputPayload: 'receipt=EAC-2207; status=filed',
      scope: 'write:uscis-efile',
      secretRef: 'tok_efile_4',
    },
  ],
  tampers: [
    {
      id: 'exhibits',
      label: 'Pad the exhibit record',
      target: 'd2',
      field: 'outputPayload',
      value: 'exhibits=31; pages=410; prongs_supported=3',
    },
    {
      id: 'authz',
      label: 'Forge filing authority',
      target: 'd3',
      field: 'scope',
      value: 'approve:filing:any-category',
    },
    {
      id: 'scope',
      label: 'Rewrite the filed record',
      target: 'd4',
      field: 'outputPayload',
      value: 'receipt=EAC-2207; status=filed; premium_processing=true',
    },
  ],
};

/** Finance — payment reconciliation exception. Maps to End Close. */
const reconciliation: DemoBundle = {
  id: 'reconciliation',
  label: 'Finance · reconciliation exception',
  subtitle: 'Sealed reconciliation bundle · EXC-5521',
  items: [
    {
      id: 'd0',
      label: 'Ingest exception',
      executor: 'dispatch',
      action: 'intent.ingest',
      parents: [],
      inputPayload: 'EXC-5521: $48,210 unmatched ACH credit',
      outputPayload: 'scope=reconcile; ref=EXC-5521',
      scope: 'read:intake',
      secretRef: 'tok_intake_1',
    },
    {
      id: 'd1',
      label: 'Pull ledger entry',
      executor: 'dispatch',
      action: 'retrieve.ledger',
      parents: ['d0'],
      inputPayload: 'gl=2026-06; account=1010-cash',
      outputPayload: 'expected=$48,210; counterparty=Northwind',
      scope: 'read:gl',
      secretRef: 'tok_gl_7',
    },
    {
      id: 'd2',
      label: 'Match bank feed',
      executor: 'dispatch',
      action: 'compute.match',
      parents: ['d0'],
      inputPayload: 'bank txns window ±3d',
      outputPayload: 'matched_txn=BT-99812; amount=$48,210; confidence=0.99',
      scope: 'read:bankfeed',
      secretRef: 'tok_bank_2',
    },
    {
      id: 'd3',
      label: 'Approve reclass',
      executor: 'dispatch',
      action: 'authz.approve',
      parents: ['d1', 'd2'],
      inputPayload: 'delta=$0; approver=controller:okafor',
      outputPayload: 'approved=true; basis=under_50k_controller',
      scope: 'approve:reclass<=50000',
      secretRef: 'tok_authz_ctrl',
    },
    {
      id: 'd4',
      label: 'Post to GL',
      executor: 'dispatch',
      action: 'emit.posting',
      parents: ['d3'],
      inputPayload: 'entry=EXC-5521; matched=BT-99812',
      outputPayload: 'posting=JE-5521; status=posted',
      scope: 'write:gl',
      secretRef: 'tok_post_4',
    },
  ],
  tampers: [
    {
      id: 'amount',
      label: 'Alter the matched amount',
      target: 'd2',
      field: 'outputPayload',
      value: 'matched_txn=BT-99812; amount=$148,210; confidence=0.99',
    },
    {
      id: 'authz',
      label: 'Forge approval authority',
      target: 'd3',
      field: 'scope',
      value: 'approve:reclass<=5000000',
    },
    {
      id: 'scope',
      label: 'Rewrite the posted entry',
      target: 'd4',
      field: 'outputPayload',
      value: 'posting=JE-5521; status=posted; reversed=true',
    },
  ],
};

/** Govtech — vendor-bid evaluation. Maps to Hazel. Synthetic solicitation. */
const vendorBid: DemoBundle = {
  id: 'vendor-bid',
  label: 'Govtech · vendor-bid scoring',
  subtitle: 'Sealed evaluation bundle · RFP-IT-09',
  items: [
    {
      id: 'd0',
      label: 'Ingest solicitation',
      executor: 'dispatch',
      action: 'intent.ingest',
      parents: [],
      inputPayload: 'RFP-2026-IT-09; 4 sealed bids received',
      outputPayload: 'scope=evaluate; ref=RFP-IT-09',
      scope: 'read:intake',
      secretRef: 'tok_intake_1',
    },
    {
      id: 'd1',
      label: 'Pull eval criteria',
      executor: 'dispatch',
      action: 'retrieve.criteria',
      parents: ['d0'],
      inputPayload: 'rubric=FAR 15.3; weights',
      outputPayload: 'criteria=price40/tech40/past20',
      scope: 'read:far-rubric',
      secretRef: 'tok_rubric_7',
    },
    {
      id: 'd2',
      label: 'Score bids',
      executor: 'dispatch',
      action: 'compute.score',
      parents: ['d0'],
      inputPayload: '4 sealed bids (synthetic)',
      outputPayload: 'top=Vendor-C; score=87.4; price=$1.92M',
      scope: 'read:bids',
      secretRef: 'tok_bids_2',
    },
    {
      id: 'd3',
      label: 'Authorize award rec',
      executor: 'dispatch',
      action: 'authz.approve',
      parents: ['d1', 'd2'],
      inputPayload: 'winner=Vendor-C; CO=officer:diaz',
      outputPayload: 'approved=true; basis=contracting_officer',
      scope: 'approve:award-rec',
      secretRef: 'tok_authz_co',
    },
    {
      id: 'd4',
      label: 'Issue evaluation',
      executor: 'dispatch',
      action: 'emit.evaluation',
      parents: ['d3'],
      inputPayload: 'rfp=RFP-IT-09; winner=Vendor-C',
      outputPayload: 'evaluation=EVAL-IT-09.pdf; posted=SAM.gov',
      scope: 'write:award-record',
      secretRef: 'tok_award_4',
    },
  ],
  tampers: [
    {
      id: 'score',
      label: 'Alter the winning score',
      target: 'd2',
      field: 'outputPayload',
      value: 'top=Vendor-A; score=91.0; price=$2.40M',
    },
    {
      id: 'authz',
      label: 'Forge award authority',
      target: 'd3',
      field: 'scope',
      value: 'approve:award-rec:sole-source',
    },
    {
      id: 'scope',
      label: 'Rewrite the posted evaluation',
      target: 'd4',
      field: 'outputPayload',
      value: 'evaluation=EVAL-IT-09.pdf; posted=none',
    },
  ],
};

/** Finance — loan servicing action + investor report. Maps to Zolvo. */
const loanServicing: DemoBundle = {
  id: 'loan-servicing',
  label: 'Finance · loan servicing',
  subtitle: 'Sealed servicing bundle · LN-7741',
  items: [
    {
      id: 'd0',
      label: 'Ingest servicing event',
      executor: 'dispatch',
      action: 'intent.ingest',
      parents: [],
      inputPayload: 'loan=LN-7741; payoff request',
      outputPayload: 'scope=service; ref=LN-7741',
      scope: 'read:intake',
      secretRef: 'tok_intake_1',
    },
    {
      id: 'd1',
      label: 'Pull loan position',
      executor: 'dispatch',
      action: 'retrieve.loan',
      parents: ['d0'],
      inputPayload: 'loan=LN-7741; as_of=2026-06-15',
      outputPayload: 'principal=$312,480; rate=6.25%; escrow=$4,210',
      scope: 'read:servicing',
      secretRef: 'tok_svc_7',
    },
    {
      id: 'd2',
      label: 'Compute payoff',
      executor: 'dispatch',
      action: 'compute.payoff',
      parents: ['d0'],
      inputPayload: 'per_diem; through 2026-06-30',
      outputPayload: 'payoff=$316,995; per_diem=$53.48',
      scope: 'read:ratecard',
      secretRef: 'tok_rates_2',
    },
    {
      id: 'd3',
      label: 'Approve disbursement',
      executor: 'dispatch',
      action: 'authz.approve',
      parents: ['d1', 'd2'],
      inputPayload: 'amount=$316,995; approver=servicer:reyes',
      outputPayload: 'approved=true; basis=under_500k_servicer',
      scope: 'approve:disbursement<=500000',
      secretRef: 'tok_authz_svc',
    },
    {
      id: 'd4',
      label: 'Post + investor report',
      executor: 'dispatch',
      action: 'emit.remittance',
      parents: ['d3'],
      inputPayload: 'loan=LN-7741; payoff=$316,995',
      outputPayload: 'remittance=RMT-7741; investor=Pool-22; status=reported',
      scope: 'write:investor-report',
      secretRef: 'tok_remit_4',
    },
  ],
  tampers: [
    {
      id: 'payoff',
      label: 'Alter the payoff figure',
      target: 'd2',
      field: 'outputPayload',
      value: 'payoff=$216,995; per_diem=$53.48',
    },
    {
      id: 'authz',
      label: 'Forge disbursement authority',
      target: 'd3',
      field: 'scope',
      value: 'approve:disbursement<=50000000',
    },
    {
      id: 'scope',
      label: 'Rewrite the investor report',
      target: 'd4',
      field: 'outputPayload',
      value: 'remittance=RMT-7741; investor=Pool-22; status=unreported',
    },
  ],
};

/** Registry — the generic change-order is index 0 (the default). */
export const BUNDLES: DemoBundle[] = [
  changeOrder,
  claimsAppeal,
  immigrationFiling,
  reconciliation,
  vendorBid,
  loanServicing,
];

/** Resolve a bundle by id; falls back to the generic default. */
export function bundleById(id: string): DemoBundle {
  return BUNDLES.find((b) => b.id === id) ?? BUNDLES[0]!;
}

/** Back-compat: the generic bundle's items/tampers, the original named exports. */
export const PRISTINE_ITEMS: DemoItem[] = changeOrder.items;
export const TAMPERS: TamperPreset[] = changeOrder.tampers;
