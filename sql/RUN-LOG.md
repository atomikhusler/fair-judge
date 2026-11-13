# Supabase SQL Run Log

| Name | What it does | Live in Supabase | Date |
| :--- | :--- | :--- | :--- |
| `sql/15.7-stage-a.sql` | Creates `public.fj_server_time()` RPC so clients can measure server clock offset. | yes (verified in `Part_B.5` export) | 2026-11-12 |
| `sql/15.7-stage-b1.sql` | Creates `org_secrets` & `org_login_throttle` tables, enables RLS, migrates plaintext passwords to bcrypt, and creates auth RPCs (`org_login`, `org_verify_password`, `org_change_password`, `org_register`). | yes (verified in `Part_B.1`, `Part_B.2`, `Part_B.4`, `Part_B.5` exports) | 2026-11-12 |
| `sql/15.7-auth-fix.sql` | Unlocks throttle table, aligns 6+ char password rule, adds `_fj_verify_org`, and updates `org_login`/`org_verify_password`/`org_change_password`/`org_register` with `uuid` fix. | yes (`_fj_verify_org` & auth RPCs verified in `Part_B.5` and live tests) | 2026-11-12 |
| `sql/15.7-stage-b3.sql` | Drops legacy plaintext `public.organizations.password` column and updates `public.fj_health()`. | yes (`organizations.password` absent in `Part_B.1`; `fj_health` in `Part_B.5`) | 2026-11-12 |
| `sql/15.7-stage-c.sql` | Creates password-verified `public.org_restore(p_org_id, p_password, p_mode, p_payload, p_dry_run)` with `_fj_verify_org` check, dry-run support, and locked-event Replace refusal. | yes (verified in `Part_B.5` & live dry-run tests) | 2026-11-12 |
| `sql/15.7-stage-d1-safe-cleanup.sql` | Blocks direct `INSERT` on `organizations`, removes duplicate `organizations` policy, revokes `DELETE` on `scores`, and tightens trigger function grants. | yes (Test 1 & Test 2 confirmed) | 2026-11-12 |
