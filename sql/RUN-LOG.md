# Supabase SQL Run Log

| Name | What it does | Live in Supabase | Date |
| :--- | :--- | :--- | :--- |
| `sql/15.7-stage-a.sql` | Creates `public.fj_server_time()` RPC so clients can measure server clock offset. | Unsure (ask owner) | — |
| `sql/15.7-stage-b1.sql` | Creates `org_secrets` & `org_login_throttle` tables, enables RLS, migrates plaintext passwords to bcrypt, and creates auth RPCs (`org_login`, `org_verify_password`, `org_change_password`, `org_register`). | Unsure (ask owner — `org_secrets` & auth RPCs appear live, `org_register` was updated manually) | — |
| `sql/15.7-auth-fix.sql` | Unlocks throttle table, aligns 6+ char password rule, adds `_fj_verify_org`, and updates `org_login`/`org_verify_password`/`org_change_password`/`org_register` with `uuid` fix. | Unsure (ask owner — `org_register` & `org_login` tested live on 2026-11-12) | 2026-11-12 |
| `sql/15.7-stage-b3.sql` | Drops legacy plaintext `public.organizations.password` column and updates `public.fj_health()`. | Unsure (ask owner) | — |
| `sql/15.7-stage-c.sql` | Creates password-verified `public.org_restore(p_org_id, p_password, p_mode, p_payload, p_dry_run)` with `_fj_verify_org` check, dry-run support, and locked-event Replace refusal. | yes | 2026-11-12 |
