-- ops/sql/roles.sql -- least-privilege roles for the metadata store (work package A01).
--
-- Two roles, one job each:
--
--   backend-buddy_migrate  owns the schema and every object in it. Only the `migrate` one-shot service
--                 connects as this role, and only to run `alembic upgrade head` or a downgrade.
--   backend-buddy_app      the role the api and worker containers connect as. It may read and write the
--                 metadata tables, but on audit_events it holds insert and select only, so the
--                 audit trail cannot be edited or erased through the application's own
--                 credentials (CTQ-16). The trigger audit_events_no_update_delete, created by
--                 migration 0001, rejects UPDATE and DELETE with SQLSTATE 42501 whichever role
--                 attempts them; these grants mean the statement is normally refused before the
--                 trigger is reached. Defence in depth, not one control twice.
--
-- No password appears in this file, and no password may ever be added to it. The roles are
-- created with LOGIN and no password; the operator sets each one from the Docker secret, for
-- example
--
--   ALTER ROLE backend-buddy_app PASSWORD '<the content of /run/secrets/backend-buddy_db_password>';
--
-- run once out of band. See docs/architecture/security-architecture.md section 9.
--
-- Usage (as a superuser or the database owner, after `alembic upgrade head`):
--
--   psql "$BB_TEST_DATABASE_URL" -f ops/sql/roles.sql
--
-- The script is idempotent: it can be re-run after every migration and must be, because it
-- grants on the tables that exist at the time it runs and deliberately sets no default
-- privileges. ALTER DEFAULT PRIVILEGES would grant UPDATE and DELETE on a table created later,
-- which is exactly wrong for the next insert-only table someone adds; naming the exceptions here
-- and re-running the script keeps that decision explicit.
--
-- Operational note for O01 and docs/operations/deployment.md: the compose `migrate` service runs
-- Alembic as backend-buddy_migrate; this script runs after it, before `api` and `worker` start.

begin;

-- 1. Roles -------------------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'backend-buddy_migrate') then
    create role backend-buddy_migrate login;
    raise notice 'created role backend-buddy_migrate (no password; set it from the secret)';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'backend-buddy_app') then
    create role backend-buddy_app login;
    raise notice 'created role backend-buddy_app (no password; set it from the secret)';
  end if;
end $$;

-- 2. Schema privileges -------------------------------------------------------------------------
-- backend-buddy_migrate creates and drops objects; backend-buddy_app only resolves names inside the schema.

grant usage, create on schema public to backend-buddy_migrate;
grant usage on schema public to backend-buddy_app;
revoke create on schema public from backend-buddy_app;

-- 3. Ownership ---------------------------------------------------------------------------------
-- Every table and sequence belongs to backend-buddy_migrate, so backend-buddy_app can never drop or alter one.
-- Skipped with a notice when the connected role is not permitted to reassign ownership.

do $$
declare
  object_name text;
begin
  if not pg_has_role(current_user, 'backend-buddy_migrate', 'member') then
    raise notice 'current_user is not a member of backend-buddy_migrate; ownership left unchanged';
    return;
  end if;
  for object_name in
    select quote_ident(c.relname)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%s owner to backend-buddy_migrate', object_name);
  end loop;
  for object_name in
    select quote_ident(c.relname)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S' and c.relpersistence = 'p'
      and not exists (
        select 1 from pg_depend d
        where d.objid = c.oid and d.deptype = 'i'
      )
  loop
    execute format('alter sequence public.%s owner to backend-buddy_migrate', object_name);
  end loop;
end $$;

-- 4. Table privileges for backend-buddy_app -------------------------------------------------------------
-- Reset first, then grant, so re-running the script also removes a privilege granted by hand.
-- The exception lists are the whole policy:
--
--   audit_events     insert, select      insert-only trail (data-model.md 3.15)
--   alembic_version  select              /readyz checks the head revision; only migrate writes
--   everything else  select, insert, update, delete

do $$
declare
  object_name text;
  insert_only text[] := array['audit_events'];
  read_only text[] := array['alembic_version'];
begin
  for object_name in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('revoke all privileges on table public.%I from backend-buddy_app', object_name);
    if object_name = any (insert_only) then
      execute format('grant insert, select on table public.%I to backend-buddy_app', object_name);
    elsif object_name = any (read_only) then
      execute format('grant select on table public.%I to backend-buddy_app', object_name);
    else
      execute format(
        'grant select, insert, update, delete on table public.%I to backend-buddy_app',
        object_name
      );
    end if;
  end loop;
end $$;

-- Sequence privileges are not granted: every primary key is either a uuid with a
-- gen_random_uuid() default or the identity column of audit_events, whose sequence is reached
-- through the table's INSERT privilege and is not directly accessible.

-- 5. Verification --------------------------------------------------------------------------------
-- Fails the script rather than leaving a silently over-privileged role behind.

do $$
declare
  offending text;
begin
  select string_agg(privilege_type, ', ' order by privilege_type) into offending
  from information_schema.table_privileges
  where grantee = 'backend-buddy_app'
    and table_schema = 'public'
    and table_name = 'audit_events'
    and privilege_type not in ('INSERT', 'SELECT');
  if offending is not null then
    raise exception 'backend-buddy_app holds % on audit_events; it must hold only INSERT, SELECT', offending;
  end if;
  if exists (
    select 1 from information_schema.table_privileges
    where grantee = 'backend-buddy_app' and table_schema = 'public'
      and table_name = 'alembic_version' and privilege_type <> 'SELECT'
  ) then
    raise exception 'backend-buddy_app may only select from alembic_version';
  end if;
end $$;

commit;
