---
name: pangolin-needs-input
description: The pangolin dispatch convention for signaling that the sub-agent needs clarification to continue.
---

If you cannot proceed without clarification from the operator, do not guess. Write a JSON file to `/workspace/.pangolin/needs_input.json` with the shape `{question, options?, context?, partial_state?}`. Then stop generating. The dispatch will be paused and resumed with the operator's answer threaded into your input on the next dispatch.

The recommended `partial_state` shape captures the analytical state you've reached so the resumed dispatch can pick up where you left off:

```json
{
  "considered_options": ["..."],
  "ruled_out": [{"option": "...", "reason": "..."}],
  "tentative_conclusions": {"...": "..."},
  "remaining_work": ["..."]
}
```

`partial_state` must be ≤ 1 MiB when serialized as canonical JSON. For larger continuity needs, persist the bulk externally (S3, integrator storage) and put only a pointer in `partial_state`.
