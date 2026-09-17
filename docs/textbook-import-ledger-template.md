# Textbook import ledger

Copy this template for each material and keep it beside the operator's import
receipt. Do not put bearer tokens, provider keys, storage keys, or private
source text in the ledger.

```yaml
material_id: ""
material_title: ""
revision_id: ""
revision_number: null
material_kind: "pdf|web"
imported_at_utc: ""
operator_or_connection: ""

limits:
  active_or_paused_before: null
  reserved_capacity_before: null
  pending_items_before: null
  daily_import_activations_remaining: null
  daily_new_skill_allowance_unchanged: true

scope:
  selector: "section|page_range"
  section_ids: []
  page_range: null
  reader_operations: []
  segments:
    - segment_id: ""
      section_path: []
      locator: {}
      extraction_status: "ready|needs_ocr|ocr_failed|missing"
      character_count: null
  scope_complete: false
  extraction_gaps: []

skill_formation:
  candidates:
    - client_reference: ""
      title: ""
      objective: ""
      meaning_or_decision: ""
      selected: false
      exclusion_reason: ""

operations:
  - idempotency_key: ""
    operation_id: ""
    submitted_skill_count: null
    terminal_status: ""
    active_count: null
    reused_count: null
    failed_count: null
    retries: []

source_refs:
  - skill_client_reference: ""
    material_id: ""
    revision_id: ""
    section_ids: []
    evidence_chunk_ids: []
    persisted_at: ""

exercise_audit:
  sampled_skill_ids: []
  sampled_exercise_ids: []
  verified_count: null
  rejected_count: null
  retired_count: null
  answer_contracts_checked: true
  preview_answer_keys_exposed: false

issues:
  - exercise_id: ""
    issue_id: ""
    resolution: "confirmed|rejected|inconclusive|"
    reason: ""
    affected_review_count: null
    correction_status: "not_required|pending|in_progress|complete|blocked"

verification:
  commands: []
  live_material_pilot: "not_run|pending|passed|failed"
  notes: ""
```
