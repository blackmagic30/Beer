-- Activate the reviewed-price Postgres mutation kernel created in the prior
-- fail-closed migration. The plan remains mutation-disabled: inside the
-- reviewed-price operator boundary, only a separate short-lived reviewer
-- approval can authorize one exact apply or quarantine. The shared runtime
-- role retains separately documented DML needed by ordinary repositories.

begin;

set local search_path = pg_catalog;

do $pintpath_preflight$
declare
  database_oid_text text;
  apply_owner text;
  apply_execute text;
  quarantine_owner text;
  quarantine_execute text;
  role_name text;
  executor_role_oid oid;
  executor_is_superuser boolean;
  executor_can_create_role boolean;
  existing_scoped_role_count integer;
begin
  perform pg_catalog.pg_advisory_xact_lock(-1516610544307388179);

  select database.oid::text into strict database_oid_text
  from pg_catalog.pg_database as database
  where database.datname = pg_catalog.current_database();
  if database_oid_text !~ '^[1-9][0-9]{0,9}$' then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_activation_database_identity_unsafe';
  end if;

  apply_owner := 'pintpath_reviewed_price_apply_owner_d' || database_oid_text;
  apply_execute := 'pintpath_reviewed_price_apply_execute_d' || database_oid_text;
  quarantine_owner :=
    'pintpath_reviewed_price_quarantine_owner_d' || database_oid_text;
  quarantine_execute :=
    'pintpath_reviewed_price_quarantine_execute_d' || database_oid_text;

  select role.oid, role.rolsuper, role.rolcreaterole
    into strict executor_role_oid, executor_is_superuser,
      executor_can_create_role
  from pg_catalog.pg_roles as role
  where role.rolname = current_user;

  if pg_catalog.to_regrole('pintpath_runtime') is null
     or pg_catalog.to_regrole('pintpath_migrator') is null
     or pg_catalog.to_regclass(
       'pintpath_ops.reviewed_price_promotion_operations'
     ) is null
     or pg_catalog.to_regclass(
       'pintpath_ops.reviewed_price_promotion_rows'
     ) is null
     or pg_catalog.to_regprocedure(
       'pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb)'
     ) is null
     or pg_catalog.to_regprocedure(
       'pintpath_ops.quarantine_reviewed_price_promotion(pg_catalog.jsonb)'
     ) is null
     or pg_catalog.to_regprocedure('pg_catalog.sha256(bytea)') is null then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_activation_prerequisite_missing';
  end if;

  select count(*)::integer into existing_scoped_role_count
  from pg_catalog.pg_roles as role
  where role.rolname = any(array[
    apply_owner, apply_execute, quarantine_owner, quarantine_execute
  ]);
  if existing_scoped_role_count not in (0, 4) then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_activation_role_state_mixed';
  end if;
  if existing_scoped_role_count = 0 then
    if not executor_is_superuser and (
      not executor_can_create_role
      or pg_catalog.current_setting('createrole_self_grant') <> ''
    ) then
      raise exception using errcode = '42501',
        message = 'reviewed_price_promotion_activation_role_creator_unsafe';
    end if;
    foreach role_name in array array[
      apply_owner, apply_execute, quarantine_owner, quarantine_execute
    ] loop
      execute pg_catalog.format(
        'create role %I nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit -1',
        role_name
      );
    end loop;
  end if;

  -- PostgreSQL 17 gives a non-superuser CREATEROLE principal one implicit
  -- ADMIN-only membership in each role it creates. That edge has neither
  -- INHERIT nor SET authority, so it cannot exercise the scoped role. Accept
  -- exactly that platform edge (granted by a superuser) and nothing else.
  foreach role_name in array array[
    apply_owner, apply_execute, quarantine_owner, quarantine_execute
  ] loop
    if pg_catalog.to_regrole(role_name) is null or exists (
      select 1 from pg_catalog.pg_roles as role
      where role.rolname = role_name
        and (
          role.rolcanlogin or role.rolsuper or role.rolcreatedb
          or role.rolcreaterole or role.rolinherit or role.rolreplication
          or role.rolbypassrls or role.rolconnlimit <> -1
          or role.rolvaliduntil is not null
          or exists (
            select 1 from pg_catalog.pg_auth_members as membership
            where membership.member = role.oid
               or (
                 membership.roleid = role.oid
                 and not (
                   not executor_is_superuser
                   and membership.member = executor_role_oid
                   and membership.admin_option
                   and not membership.inherit_option
                   and not membership.set_option
                   and membership.grantor = 10::oid
                   and exists (
                     select 1 from pg_catalog.pg_roles as grantor
                     where grantor.oid = membership.grantor
                       and grantor.rolsuper
                   )
                 )
               )
          )
          or (
            select count(*) from pg_catalog.pg_auth_members as membership
            where membership.roleid = role.oid
          ) <> case when executor_is_superuser then 0 else 1 end
          or exists (
            select 1 from pg_catalog.pg_auth_members as membership
            where membership.member = role.oid
          )
          or exists (
            select 1 from pg_catalog.pg_db_role_setting as setting
            where setting.setrole = role.oid
          )
        )
    ) then
      raise exception using errcode = '42501',
        message = 'reviewed_price_promotion_activation_role_unsafe';
    end if;
  end loop;

  alter table pintpath_ops.reviewed_price_promotion_rows
    no force row level security;
  alter table pintpath_ops.reviewed_price_promotion_operations
    no force row level security;
  if exists (
    select 1 from pintpath_ops.reviewed_price_promotion_operations
  ) or exists (
    select 1 from pintpath_ops.reviewed_price_promotion_rows
  ) then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_activation_ledger_not_empty';
  end if;
  alter table pintpath_ops.reviewed_price_promotion_operations
    force row level security;
  alter table pintpath_ops.reviewed_price_promotion_rows
    force row level security;

  if (select count(*) from pg_catalog.pg_proc as routine
      join pg_catalog.pg_namespace as namespace
        on namespace.oid = routine.pronamespace
      where namespace.nspname = 'pintpath_ops'
        and routine.proname = any(array[
          'apply_reviewed_price_promotion',
          'quarantine_reviewed_price_promotion'
        ])
        and routine.pronargs = 1
        and routine.proargtypes[0] =
          'pg_catalog.jsonb'::pg_catalog.regtype::oid
        and routine.prosecdef
        and routine.proconfig = array['search_path=pg_catalog']::text[]
        and routine.prosrc like
          '%reviewed_price_promotion_kernel_disabled%') <> 2 then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_activation_inert_kernel_drift';
  end if;
end
$pintpath_preflight$;

alter table pintpath_ops.reviewed_price_promotion_operations
  drop constraint reviewed_price_promotion_operations_kind_check;
alter table pintpath_ops.reviewed_price_promotion_operations
  add constraint reviewed_price_promotion_operations_kind_check
  check (operation_kind in (
    'authorize_apply', 'authorize_quarantine', 'apply', 'quarantine'
  ));
alter table pintpath_ops.reviewed_price_promotion_operations
  drop constraint reviewed_price_promotion_operations_source_check;
alter table pintpath_ops.reviewed_price_promotion_operations
  add constraint reviewed_price_promotion_operations_source_check
  check (
    (operation_kind in ('authorize_apply', 'apply')
      and source_apply_operation_id is null)
    or (operation_kind in ('authorize_quarantine', 'quarantine')
      and source_apply_operation_id is not null
      and source_apply_operation_id <> operation_id)
  );

create or replace function pintpath_ops.authorize_reviewed_price_promotion(
  request pg_catalog.jsonb
) returns pg_catalog.jsonb
language plpgsql
volatile
parallel unsafe
security definer
set search_path = pg_catalog
as $pintpath_authorize$
declare
  database_oid_text text;
  expected_owner text;
  plan jsonb;
  plan_candidate jsonb;
  packet jsonb;
  packet_candidate jsonb;
  approval_envelope jsonb;
  approval jsonb;
  source_receipt jsonb;
  authorization_id_value uuid;
  operation_id_value uuid;
  source_apply_operation_id_value uuid;
  operation_kind_value text;
  approval_payload_sha text;
  authorization_request_sha text;
  physical_identity_text text;
  physical_identity_sha text;
  row_count_value integer;
  authorized_at_value timestamptz;
  authorized_at_text text;
  existing_authorization record;
  response_authorization jsonb;
begin
  select database.oid::text into strict database_oid_text
  from pg_catalog.pg_database as database
  where database.datname = pg_catalog.current_database();
  expected_owner := 'pintpath_reviewed_price_apply_owner_d' || database_oid_text;
  if current_user <> expected_owner then
    raise exception using errcode = '42501',
      message = 'reviewed_price_promotion_kernel_owner_unsafe';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'serializable'
     or pg_catalog.current_setting('transaction_read_only')::boolean then
    raise exception using errcode = '25000',
      message = 'reviewed_price_promotion_transaction_unsafe';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(-1516610544307388179);

  if request is null or pg_catalog.jsonb_typeof(request) <> 'object'
     or (select pg_catalog.array_agg(key order by key collate "C")
         from pg_catalog.jsonb_object_keys(request) as keys(key))
        is distinct from array[
          'approvalEnvelopeCanonical','approvalFileSha256',
          'approvalPayloadCanonical','approvalSignatureSha256','operationId',
          'operationKind','planCandidateCanonical','planCanonical',
          'reviewPacketCandidateCanonical','reviewPacketCanonical',
          'sourceApplyReceiptCanonical','version'
        ]::text[]
     or request->>'version' <> '1'
     or request->>'operationKind' not in ('apply', 'quarantine')
     or request->>'approvalFileSha256' !~ '^[0-9a-f]{64}$'
     or request->>'approvalSignatureSha256' !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023',
      message = 'reviewed_price_promotion_request_invalid';
  end if;
  begin
    plan := (request->>'planCanonical')::jsonb;
    plan_candidate := (request->>'planCandidateCanonical')::jsonb;
    packet := (request->>'reviewPacketCanonical')::jsonb;
    packet_candidate := (request->>'reviewPacketCandidateCanonical')::jsonb;
    approval_envelope := (request->>'approvalEnvelopeCanonical')::jsonb;
    approval := (request->>'approvalPayloadCanonical')::jsonb;
    authorization_id_value := (approval->>'authorizationId')::uuid;
    operation_id_value := (approval->>'operationId')::uuid;
    operation_kind_value := approval->>'operationKind';
    source_apply_operation_id_value := case
      when operation_kind_value = 'quarantine'
      then (approval->>'sourceApplyOperationId')::uuid
      else null
    end;
    source_receipt := case
      when operation_kind_value = 'quarantine'
      then (request->>'sourceApplyReceiptCanonical')::jsonb
      else null
    end;
  exception when others then
    raise exception using errcode = '22023',
      message = 'reviewed_price_promotion_request_invalid';
  end;

  if authorization_id_value = operation_id_value
     or request->>'operationId' <> operation_id_value::text
     or request->>'operationKind' <> operation_kind_value
     or plan - 'planCandidateSha256' <> plan_candidate
     or packet - 'reviewPacketCandidateSha256' <> packet_candidate
     or approval_envelope->'payload' <> approval
     or approval_envelope->>'kind' <>
       'pintpath-postgres-reviewed-price-operation-signed-approval'
     or approval_envelope->>'version' <> '1'
     or pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(request->>'planCanonical', 'UTF8')
     ), 'hex') <> approval->>'planFileSha256'
     or pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(request->>'reviewPacketCanonical', 'UTF8')
     ), 'hex') <> approval->>'reviewPacketFileSha256'
     or pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(request->>'planCandidateCanonical', 'UTF8')
     ), 'hex') <> plan->>'planCandidateSha256'
     or pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(
         request->>'reviewPacketCandidateCanonical', 'UTF8'
       )
     ), 'hex') <> packet->>'reviewPacketCandidateSha256'
     or pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(request->>'approvalEnvelopeCanonical', 'UTF8')
     ), 'hex') <> request->>'approvalFileSha256'
     or pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.decode(approval_envelope->>'signatureBase64', 'base64')
     ), 'hex') <> request->>'approvalSignatureSha256'
     or (operation_kind_value = 'apply'
       and request->'sourceApplyReceiptCanonical' <> 'null'::jsonb)
     or (operation_kind_value = 'quarantine' and (
       pg_catalog.jsonb_typeof(request->'sourceApplyReceiptCanonical')
         <> 'string'
       or pg_catalog.encode(pg_catalog.sha256(
         pg_catalog.convert_to(
           request->>'sourceApplyReceiptCanonical', 'UTF8'
         )
       ), 'hex') <> approval->>'sourceApplyReceiptFileSha256'
       or source_receipt->>'receiptSha256' <>
         approval->>'sourceApplyReceiptSha256'
     )) then
    raise exception using errcode = '22023',
      message = 'reviewed_price_promotion_artifact_hash_mismatch';
  end if;

  approval_payload_sha := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(request->>'approvalPayloadCanonical', 'UTF8')
  ), 'hex');
  if approval->>'kind' <>
       'pintpath-postgres-reviewed-price-operation-approval-payload'
     or approval->>'version' <> '1'
     or approval->>'candidateSha' <> plan->>'candidateSha'
     or approval->>'candidateSha' <> packet->>'candidateSha'
     or approval->>'planCandidateSha256' <>
       plan->>'planCandidateSha256'
     or approval->>'reviewPacketCandidateSha256' <>
       packet->>'reviewPacketCandidateSha256'
     or approval->>'authorityBundleSha256' <>
       plan#>>'{authority,authorityBundleSha256}'
     or approval->>'authorityBundleSha256' <>
       packet->>'authorityBundleSha256'
     or approval->>'expectedEnvironment' <>
       plan->>'expectedEnvironment'
     or approval->>'expectedEnvironment' <>
       packet->>'expectedEnvironment'
     or approval->>'targetPhysicalIdentitySha256' <>
       plan#>>'{target,physicalIdentitySha256}'
     or approval->>'targetPhysicalIdentitySha256' <>
       packet->>'targetPhysicalIdentitySha256'
     or approval->>'sourceSnapshotSha256' <>
       plan#>>'{sourceSnapshot,combinedSha256}'
     or approval->>'sourceSnapshotSha256' <>
       packet->>'sourceSnapshotSha256'
     or approval->>'recoveryAuthoritySha256' <>
       plan#>>'{authority,recoveryReferencesSha256}'
     or approval->>'expectedEnvironment' not in
       ('permanent-staging', 'production')
     or approval->>'operatorIdSha256' !~ '^[0-9a-f]{64}$'
     or approval->>'reviewerIdSha256' !~ '^[0-9a-f]{64}$'
     or approval->>'deploymentBindingSha256' !~ '^[0-9a-f]{64}$'
     or approval->>'evidenceAuthoritySha256' !~ '^[0-9a-f]{64}$'
     or approval->>'approvalReferenceSha256' !~ '^[0-9a-f]{64}$'
     or approval->>'reviewerPublicKeySha256' !~ '^[0-9a-f]{64}$'
     or approval->>'transportRootCaSha256' !~ '^[0-9a-f]{64}$'
     or approval->>'operatorIdSha256' = approval->>'reviewerIdSha256'
     or approval->>'operatorLoginSha256' = approval->>'reviewerLoginSha256'
     or approval->>'reviewerLoginSha256' <>
       pg_catalog.encode(pg_catalog.sha256(
         pg_catalog.convert_to(
           'pintpath-reviewed-price-database-login-v1', 'UTF8'
         ) || pg_catalog.decode('00', 'hex')
           || pg_catalog.convert_to(session_user, 'UTF8')
       ), 'hex')
     or (approval->>'issuedAt')::timestamptz >
       pg_catalog.transaction_timestamp()
     or (approval->>'expiresAt')::timestamptz <
       pg_catalog.transaction_timestamp()
     or (approval->>'expiresAt')::timestamptz <=
       (approval->>'issuedAt')::timestamptz
     or (approval->>'expiresAt')::timestamptz -
       (approval->>'issuedAt')::timestamptz > interval '24 hours' then
    raise exception using errcode = '42501',
      message = 'reviewed_price_promotion_approval_invalid';
  end if;

  select control.system_identifier::text into strict physical_identity_text
  from pg_catalog.pg_control_system() as control;
  physical_identity_text :=
    '{"databaseName":' || pg_catalog.to_json(pg_catalog.current_database())::text
    || ',"databaseOid":' || pg_catalog.to_json(database_oid_text)::text
    || ',"kind":"pintpath-postgres-logical-source-database"'
    || ',"serverVersionNum":'
    || pg_catalog.to_json(pg_catalog.current_setting('server_version_num'))::text
    || ',"systemIdentifier":'
    || pg_catalog.to_json(physical_identity_text)::text
    || ',"version":1}' || chr(10);
  physical_identity_sha := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(physical_identity_text, 'UTF8')
  ), 'hex');
  row_count_value := (packet->>'rowCount')::integer;
  if physical_identity_sha <> approval->>'targetPhysicalIdentitySha256'
     or row_count_value < 1 or row_count_value > 5000
     or not exists (
       select 1 from pintpath_app.schema_metadata as metadata
       where metadata.key = 'migration_candidate_sha'
         and metadata.value = approval->>'candidateSha'
     )
     or (operation_kind_value = 'quarantine' and not exists (
       select 1 from pintpath_ops.reviewed_price_promotion_operations as source
       where source.operation_id = source_apply_operation_id_value
         and source.operation_kind = 'apply'
         and source.receipt_sha256 = source_receipt->>'receiptSha256'
         and source.candidate_sha = approval->>'candidateSha'
         and source.plan_candidate_sha256 = plan->>'planCandidateSha256'
         and source.review_packet_candidate_sha256 =
           packet->>'reviewPacketCandidateSha256'
         and source.target_physical_identity_sha256 = physical_identity_sha
     )) then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_target_binding_mismatch';
  end if;

  authorization_request_sha := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(pg_catalog.concat_ws(chr(31),
      'pintpath-reviewed-price-operation-authorization-v1',
      authorization_id_value::text, operation_id_value::text,
      operation_kind_value, request->>'approvalFileSha256',
      approval_payload_sha, request->>'approvalSignatureSha256',
      plan->>'planCandidateSha256',
      packet->>'reviewPacketCandidateSha256', physical_identity_sha,
      approval->>'sourceSnapshotSha256',
      approval->>'deploymentBindingSha256',
      approval->>'evidenceAuthoritySha256',
      approval->>'recoveryAuthoritySha256',
      approval->>'operatorIdSha256', approval->>'reviewerIdSha256',
      approval->>'operatorLoginSha256', approval->>'reviewerLoginSha256',
      row_count_value::text
    ), 'UTF8')), 'hex');
  authorized_at_value := pg_catalog.transaction_timestamp();
  authorized_at_text := pg_catalog.to_char(
    authorized_at_value at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );

  select operation.* into existing_authorization
  from pintpath_ops.reviewed_price_promotion_operations as operation
  where operation.operation_id = authorization_id_value;
  if found then
    if existing_authorization.operation_kind <>
         'authorize_' || operation_kind_value
       or existing_authorization.source_apply_operation_id is distinct from
         source_apply_operation_id_value
       or existing_authorization.request_sha256 <> authorization_request_sha
       or existing_authorization.result_state_sha256 <> approval_payload_sha
       or existing_authorization.receipt_sha256 <>
         request->>'approvalFileSha256' then
      raise exception using errcode = '23505',
        message = 'reviewed_price_promotion_authorization_id_conflict';
    end if;
    authorized_at_text := pg_catalog.to_char(
      existing_authorization.committed_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    );
    response_authorization := pg_catalog.jsonb_build_object(
      'approvalFileSha256', request->>'approvalFileSha256',
      'approvalPayloadSha256', approval_payload_sha,
      'authorizationId', authorization_id_value::text,
      'authorizedAt', authorized_at_text,
      'kind',
        'pintpath-postgres-reviewed-price-operation-authorization-receipt',
      'operationId', operation_id_value::text,
      'operationKind', operation_kind_value,
      'reviewerIdSha256', approval->>'reviewerIdSha256',
      'version', 1
    );
    return pg_catalog.jsonb_build_object(
      'authorization', response_authorization, 'replayed', true
    );
  end if;

  insert into pintpath_ops.reviewed_price_promotion_operations (
    operation_id, operation_kind, source_apply_operation_id, candidate_sha,
    expected_environment, authority_bundle_sha256, plan_candidate_sha256,
    review_packet_candidate_sha256, target_physical_identity_sha256,
    source_snapshot_sha256, request_sha256, requested_row_count, committed_at,
    result_state_sha256, receipt_sha256
  ) values (
    authorization_id_value, 'authorize_' || operation_kind_value,
    source_apply_operation_id_value, approval->>'candidateSha',
    approval->>'expectedEnvironment', approval->>'authorityBundleSha256',
    plan->>'planCandidateSha256', packet->>'reviewPacketCandidateSha256',
    physical_identity_sha, approval->>'sourceSnapshotSha256',
    authorization_request_sha, row_count_value, authorized_at_value,
    approval_payload_sha, request->>'approvalFileSha256'
  );
  response_authorization := pg_catalog.jsonb_build_object(
    'approvalFileSha256', request->>'approvalFileSha256',
    'approvalPayloadSha256', approval_payload_sha,
    'authorizationId', authorization_id_value::text,
    'authorizedAt', authorized_at_text,
    'kind',
      'pintpath-postgres-reviewed-price-operation-authorization-receipt',
    'operationId', operation_id_value::text,
    'operationKind', operation_kind_value,
    'reviewerIdSha256', approval->>'reviewerIdSha256',
    'version', 1
  );
  return pg_catalog.jsonb_build_object(
    'authorization', response_authorization, 'replayed', false
  );
exception
  when serialization_failure or deadlock_detected or lock_not_available then
    raise exception using errcode = sqlstate,
      message = 'reviewed_price_promotion_retryable_transaction_failure';
end
$pintpath_authorize$;

create or replace function pintpath_ops.apply_reviewed_price_promotion(
  request pg_catalog.jsonb
) returns pg_catalog.jsonb
language plpgsql
volatile
parallel unsafe
security definer
set search_path = pg_catalog
as $pintpath_apply$
declare
  database_oid_text text;
  expected_owner text;
  plan jsonb;
  plan_candidate jsonb;
  packet jsonb;
  packet_candidate jsonb;
  approval_envelope jsonb;
  approval jsonb;
  approval_payload_sha text;
  authorization_request_sha text;
  source_ids text[];
  venue_ids text[];
  authorization_id_value uuid;
  operation_id_value uuid;
  committed_at_value timestamptz;
  committed_at_text text;
  physical_identity_text text;
  physical_identity_sha text;
  request_sha text;
  result_state_sha text;
  receipt_sha text;
  row_count_value integer;
  item_count_value integer;
  global_ordinal integer := 0;
  ledger_rows jsonb := '[]'::jsonb;
  item_entry record;
  row_entry record;
  queue_record record;
  profile_record record;
  catalog_record record;
  price_record_json jsonb;
  venue_beer_json jsonb;
  after_state jsonb;
  row_request_sha text;
  before_state_sha text;
  after_state_sha text;
  row_receipt_sha text;
  existing_operation record;
  registered_authorization record;
  existing_found boolean := false;
  response_receipt jsonb;
begin
  select database.oid::text into strict database_oid_text
  from pg_catalog.pg_database as database
  where database.datname = pg_catalog.current_database();
  expected_owner := 'pintpath_reviewed_price_apply_owner_d' || database_oid_text;
  if current_user <> expected_owner then
    raise exception using errcode = '42501',
      message = 'reviewed_price_promotion_kernel_owner_unsafe';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'serializable'
     or pg_catalog.current_setting('transaction_read_only')::boolean then
    raise exception using errcode = '25000',
      message = 'reviewed_price_promotion_transaction_unsafe';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(-1516610544307388179);

  if request is null or pg_catalog.jsonb_typeof(request) <> 'object'
     or (select pg_catalog.array_agg(key order by key collate "C")
         from pg_catalog.jsonb_object_keys(request) as keys(key))
        is distinct from array[
          'approvalEnvelopeCanonical','approvalFileSha256',
          'approvalPayloadCanonical','approvalSignatureSha256','operationId',
          'operationKind','planCandidateCanonical','planCanonical',
          'reviewPacketCandidateCanonical','reviewPacketCanonical',
          'sourceApplyReceiptCanonical','version'
        ]::text[]
     or request->>'version' <> '1'
     or request->>'operationKind' <> 'apply'
     or request->'sourceApplyReceiptCanonical' <> 'null'::jsonb
     or request->>'approvalFileSha256' !~ '^[0-9a-f]{64}$'
     or request->>'approvalSignatureSha256' !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023',
      message = 'reviewed_price_promotion_request_invalid';
  end if;

  begin
    operation_id_value := (request->>'operationId')::uuid;
    plan := (request->>'planCanonical')::jsonb;
    plan_candidate := (request->>'planCandidateCanonical')::jsonb;
    packet := (request->>'reviewPacketCanonical')::jsonb;
    packet_candidate := (request->>'reviewPacketCandidateCanonical')::jsonb;
    approval_envelope := (request->>'approvalEnvelopeCanonical')::jsonb;
    approval := (request->>'approvalPayloadCanonical')::jsonb;
    authorization_id_value := (approval->>'authorizationId')::uuid;
  exception when others then
    raise exception using errcode = '22023',
      message = 'reviewed_price_promotion_request_invalid';
  end;

  if plan - 'planCandidateSha256' <> plan_candidate
     or packet - 'reviewPacketCandidateSha256' <> packet_candidate
     or approval_envelope->'payload' <> approval
     or approval_envelope->>'kind' <>
       'pintpath-postgres-reviewed-price-operation-signed-approval'
     or approval_envelope->>'version' <> '1'
     or pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(request->>'planCanonical', 'UTF8')
     ), 'hex') <> approval->>'planFileSha256'
     or pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(request->>'reviewPacketCanonical', 'UTF8')
     ), 'hex') <> approval->>'reviewPacketFileSha256'
     or pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(request->>'planCandidateCanonical', 'UTF8')
     ), 'hex') <> plan->>'planCandidateSha256'
     or pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(
         request->>'reviewPacketCandidateCanonical', 'UTF8'
       )
     ), 'hex') <> packet->>'reviewPacketCandidateSha256'
     or pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(request->>'approvalEnvelopeCanonical', 'UTF8')
     ), 'hex') <> request->>'approvalFileSha256'
     or pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.decode(approval_envelope->>'signatureBase64', 'base64')
     ), 'hex') <> request->>'approvalSignatureSha256' then
    raise exception using errcode = '22023',
      message = 'reviewed_price_promotion_artifact_hash_mismatch';
  end if;

  approval_payload_sha := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(request->>'approvalPayloadCanonical', 'UTF8')
  ), 'hex');
  if approval->>'kind' <>
       'pintpath-postgres-reviewed-price-operation-approval-payload'
     or approval->>'version' <> '1'
     or approval->>'operationKind' <> 'apply'
     or approval->>'operationId' <> operation_id_value::text
     or approval->>'authorizationId' <> authorization_id_value::text
     or authorization_id_value = operation_id_value
     or approval->'sourceApplyOperationId' <> 'null'::jsonb
     or approval->'sourceApplyReceiptFileSha256' <> 'null'::jsonb
     or approval->'sourceApplyReceiptSha256' <> 'null'::jsonb
     or approval->>'operatorIdSha256' !~ '^[0-9a-f]{64}$'
     or approval->>'reviewerIdSha256' !~ '^[0-9a-f]{64}$'
     or approval->>'operatorIdSha256' = approval->>'reviewerIdSha256'
     or approval->>'operatorLoginSha256' = approval->>'reviewerLoginSha256'
     or approval->>'operatorLoginSha256' <>
       pg_catalog.encode(pg_catalog.sha256(
         pg_catalog.convert_to(
           'pintpath-reviewed-price-database-login-v1', 'UTF8'
         ) || pg_catalog.decode('00', 'hex')
           || pg_catalog.convert_to(session_user, 'UTF8')
       ), 'hex')
     or approval->>'candidateSha' <> plan->>'candidateSha'
     or approval->>'candidateSha' <> packet->>'candidateSha'
     or approval->>'planCandidateSha256' <>
       plan->>'planCandidateSha256'
     or approval->>'reviewPacketCandidateSha256' <>
       packet->>'reviewPacketCandidateSha256'
     or approval->>'authorityBundleSha256' <>
       plan#>>'{authority,authorityBundleSha256}'
     or approval->>'authorityBundleSha256' <>
       packet->>'authorityBundleSha256'
     or approval->>'expectedEnvironment' <>
       plan->>'expectedEnvironment'
     or approval->>'expectedEnvironment' <>
       packet->>'expectedEnvironment'
     or approval->>'expectedEnvironment' not in
       ('permanent-staging', 'production')
     or approval->>'targetPhysicalIdentitySha256' <>
       plan#>>'{target,physicalIdentitySha256}'
     or approval->>'targetPhysicalIdentitySha256' <>
       packet->>'targetPhysicalIdentitySha256'
     or approval->>'sourceSnapshotSha256' <>
       plan#>>'{sourceSnapshot,combinedSha256}'
     or approval->>'sourceSnapshotSha256' <>
       packet->>'sourceSnapshotSha256'
     or approval->>'deploymentBindingSha256' !~ '^[0-9a-f]{64}$'
     or approval->>'evidenceAuthoritySha256' !~ '^[0-9a-f]{64}$'
     or approval->>'recoveryAuthoritySha256' <>
       plan#>>'{authority,recoveryReferencesSha256}'
     or approval->>'approvalReferenceSha256' !~ '^[0-9a-f]{64}$'
     or approval->>'reviewerPublicKeySha256' !~ '^[0-9a-f]{64}$'
     or approval->>'transportRootCaSha256' !~ '^[0-9a-f]{64}$'
     or (approval->>'issuedAt')::timestamptz >
       pg_catalog.transaction_timestamp()
     or (approval->>'expiresAt')::timestamptz <
       pg_catalog.transaction_timestamp()
     or (approval->>'expiresAt')::timestamptz <=
       (approval->>'issuedAt')::timestamptz
     or (approval->>'expiresAt')::timestamptz -
       (approval->>'issuedAt')::timestamptz > interval '24 hours' then
    raise exception using errcode = '42501',
      message = 'reviewed_price_promotion_approval_invalid';
  end if;

  select control.system_identifier::text into strict physical_identity_text
  from pg_catalog.pg_control_system() as control;
  physical_identity_text :=
    '{"databaseName":' || pg_catalog.to_json(pg_catalog.current_database())::text
    || ',"databaseOid":' || pg_catalog.to_json(database_oid_text)::text
    || ',"kind":"pintpath-postgres-logical-source-database"'
    || ',"serverVersionNum":'
    || pg_catalog.to_json(pg_catalog.current_setting('server_version_num'))::text
    || ',"systemIdentifier":'
    || pg_catalog.to_json(physical_identity_text)::text
    || ',"version":1}' || chr(10);
  physical_identity_sha := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(physical_identity_text, 'UTF8')
  ), 'hex');
  if physical_identity_sha <> approval->>'targetPhysicalIdentitySha256'
     or not exists (
       select 1 from pintpath_app.schema_metadata as metadata
       where metadata.key = 'migration_candidate_sha'
         and metadata.value = approval->>'candidateSha'
     )
     or not exists (
       select 1 from pintpath_ops.migration_runs as run
       where run.run_id = plan#>>'{migration,runId}'
         and run.status = 'ready'
         and run.candidate_commit_sha = approval->>'candidateSha'
         and run.expected_environment = approval->>'expectedEnvironment'
         and run.receipt_sha256 = plan#>>'{migration,receiptSha256}'
         and run.contract_sha256 = plan#>>'{migration,contractSha256}'
         and run.manifest_sha256 = plan#>>'{migration,manifestSha256}'
         and run.source_snapshot_sha256 =
           plan#>>'{migration,sourceSnapshotSha256}'
     ) then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_target_binding_mismatch';
  end if;

  item_count_value := pg_catalog.jsonb_array_length(packet->'items');
  row_count_value := (packet->>'rowCount')::integer;
  if packet->>'kind' <>
       'pintpath-postgres-reviewed-price-promotion-private-review-packet'
     or packet->>'version' <> '1'
     or packet->>'mutationEnabled' <> 'false'
     or plan->>'mutationEnabled' <> 'false'
     or item_count_value < 1 or item_count_value > 50
     or (packet->>'itemCount')::integer <> item_count_value
     or row_count_value < 1 or row_count_value > 5000
     or (plan#>>'{reviewPacket,itemCount}')::integer <> item_count_value
     or (plan#>>'{reviewPacket,rowCount}')::integer <> row_count_value then
    raise exception using errcode = '22023',
      message = 'reviewed_price_promotion_packet_invalid';
  end if;

  select pg_catalog.array_agg(value->>'sourceIngestionId'
           order by value->>'sourceIngestionId' collate "C"),
         pg_catalog.array_agg(value#>>'{venue,id}'
           order by value->>'sourceIngestionId' collate "C")
    into source_ids, venue_ids
  from pg_catalog.jsonb_array_elements(packet->'items') as entries(value);
  if pg_catalog.array_length(source_ids, 1) <> item_count_value
     or pg_catalog.array_length(venue_ids, 1) <> item_count_value
     or (select count(distinct id) from pg_catalog.unnest(source_ids) as ids(id))
       <> item_count_value
     or (select count(distinct id) from pg_catalog.unnest(venue_ids) as ids(id))
       <> item_count_value
     or exists (
       select 1 from pg_catalog.generate_subscripts(source_ids, 1) as index
       where index > 1 and source_ids[index - 1] >= source_ids[index]
     ) then
    raise exception using errcode = '22023',
      message = 'reviewed_price_promotion_packet_identity_invalid';
  end if;

  request_sha := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.concat_ws(chr(31),
      'pintpath-reviewed-price-operation-request-v1',
      'apply', operation_id_value::text, authorization_id_value::text,
      plan->>'planCandidateSha256',
      packet->>'reviewPacketCandidateSha256',
      request->>'approvalFileSha256', approval_payload_sha,
      request->>'approvalSignatureSha256',
      approval->>'targetPhysicalIdentitySha256',
      approval->>'sourceSnapshotSha256', row_count_value::text
    ), 'UTF8')), 'hex');

  authorization_request_sha := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(pg_catalog.concat_ws(chr(31),
      'pintpath-reviewed-price-operation-authorization-v1',
      authorization_id_value::text, operation_id_value::text, 'apply',
      request->>'approvalFileSha256', approval_payload_sha,
      request->>'approvalSignatureSha256',
      plan->>'planCandidateSha256',
      packet->>'reviewPacketCandidateSha256', physical_identity_sha,
      approval->>'sourceSnapshotSha256',
      approval->>'deploymentBindingSha256',
      approval->>'evidenceAuthoritySha256',
      approval->>'recoveryAuthoritySha256',
      approval->>'operatorIdSha256', approval->>'reviewerIdSha256',
      approval->>'operatorLoginSha256', approval->>'reviewerLoginSha256',
      row_count_value::text
    ), 'UTF8')), 'hex');
  select registered.* into registered_authorization
  from pintpath_ops.reviewed_price_promotion_operations as registered
  where registered.operation_id = authorization_id_value;
  if not found
     or registered_authorization.operation_kind <> 'authorize_apply'
     or registered_authorization.source_apply_operation_id is not null
     or registered_authorization.candidate_sha <> approval->>'candidateSha'
     or registered_authorization.expected_environment <>
       approval->>'expectedEnvironment'
     or registered_authorization.authority_bundle_sha256 <>
       approval->>'authorityBundleSha256'
     or registered_authorization.plan_candidate_sha256 <>
       plan->>'planCandidateSha256'
     or registered_authorization.review_packet_candidate_sha256 <>
       packet->>'reviewPacketCandidateSha256'
     or registered_authorization.target_physical_identity_sha256 <>
       physical_identity_sha
     or registered_authorization.source_snapshot_sha256 <>
       approval->>'sourceSnapshotSha256'
     or registered_authorization.request_sha256 <> authorization_request_sha
     or registered_authorization.requested_row_count <> row_count_value
     or registered_authorization.result_state_sha256 <> approval_payload_sha
     or registered_authorization.receipt_sha256 <>
       request->>'approvalFileSha256' then
    raise exception using errcode = '42501',
      message = 'reviewed_price_promotion_authorization_missing';
  end if;

  select operation.*, true as found into existing_operation
  from pintpath_ops.reviewed_price_promotion_operations as operation
  where operation.operation_id = operation_id_value;
  existing_found := found;
  if existing_found then
    if existing_operation.operation_kind <> 'apply'
       or existing_operation.source_apply_operation_id is not null
       or existing_operation.candidate_sha <> approval->>'candidateSha'
       or existing_operation.expected_environment <>
         approval->>'expectedEnvironment'
       or existing_operation.authority_bundle_sha256 <>
         approval->>'authorityBundleSha256'
       or existing_operation.plan_candidate_sha256 <>
         plan->>'planCandidateSha256'
       or existing_operation.review_packet_candidate_sha256 <>
         packet->>'reviewPacketCandidateSha256'
       or existing_operation.target_physical_identity_sha256 <>
         physical_identity_sha
       or existing_operation.source_snapshot_sha256 <>
         approval->>'sourceSnapshotSha256'
       or existing_operation.request_sha256 <> request_sha
       or existing_operation.requested_row_count <> row_count_value then
      raise exception using errcode = '23505',
        message = 'reviewed_price_promotion_operation_id_conflict';
    end if;
    committed_at_text := pg_catalog.to_char(
      existing_operation.committed_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    );
    response_receipt := pg_catalog.jsonb_build_object(
      'approvalFileSha256', request->>'approvalFileSha256',
      'approvalReferenceSha256', approval->>'approvalReferenceSha256',
      'authorizationId', authorization_id_value::text,
      'authorityBundleSha256', approval->>'authorityBundleSha256',
      'candidateSha', approval->>'candidateSha',
      'committedAt', committed_at_text,
      'expectedEnvironment', approval->>'expectedEnvironment',
      'itemCount', item_count_value,
      'kind', 'pintpath-postgres-reviewed-price-operation-receipt',
      'operationId', operation_id_value::text,
      'operationKind', 'apply',
      'operatorIdSha256', approval->>'operatorIdSha256',
      'planCandidateSha256', plan->>'planCandidateSha256',
      'receiptSha256', existing_operation.receipt_sha256,
      'requestSha256', existing_operation.request_sha256,
      'requestedRowCount', existing_operation.requested_row_count,
      'resultStateSha256', existing_operation.result_state_sha256,
      'reviewPacketCandidateSha256',
        packet->>'reviewPacketCandidateSha256',
      'reviewerIdSha256', approval->>'reviewerIdSha256',
      'sourceApplyOperationId', null,
      'sourceIngestionIds', pg_catalog.to_jsonb(source_ids),
      'targetPhysicalIdentitySha256', physical_identity_sha,
      'version', 1
    );
    return pg_catalog.jsonb_build_object(
      'receipt', response_receipt, 'replayed', true
    );
  end if;

  lock table pintpath_app.venue_price_records in share row exclusive mode;
  lock table pintpath_app.venue_beers in share row exclusive mode;

  if exists (
    select 1 from pintpath_app.venue_price_records as price
    where price.source_ingestion_id = any(source_ids)
       or (
         price.venue_id = any(venue_ids)
         and price.confidence = any(array[
           'admin_verified','venue_confirmed','photo_verified',
           'community_confirmed'
         ])
       )
  ) or exists (
    select 1 from pintpath_app.venue_beers as beer
    where beer.venue_id = any(venue_ids)
  ) or exists (
    select 1 from pintpath_app.wrong_price_reports as report
    where report.venue_id = any(venue_ids)
      and report.status = any(array['open','in_progress'])
  ) then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_live_conflict';
  end if;

  committed_at_value := pg_catalog.transaction_timestamp();
  committed_at_text := pg_catalog.to_char(
    committed_at_value at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  before_state_sha := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(
      '{"priceRecord":null,"venueBeer":null}', 'UTF8'
    )
  ), 'hex');

  for item_entry in
    select value, ordinality::integer - 1 as item_ordinal
    from pg_catalog.jsonb_array_elements(packet->'items')
      with ordinality as items(value, ordinality)
    order by ordinality
  loop
    if item_entry.value->>'sourceIngestionId' !~
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or item_entry.value->>'evidenceReference' <>
         'source-ingestion:' || (item_entry.value->>'sourceIngestionId')
       or item_entry.value->>'evidenceContentSha256' !~ '^[0-9a-f]{64}$'
       or item_entry.value->>'evidenceReferenceSha256' !~ '^[0-9a-f]{64}$'
       or pg_catalog.jsonb_array_length(item_entry.value->'rows') < 1
       or pg_catalog.jsonb_array_length(item_entry.value->'rows') > 100 then
      raise exception using errcode = '22023',
        message = 'reviewed_price_promotion_item_invalid';
    end if;

    select queue.id, queue.venue_id, queue.venue_name, queue.status,
           queue.review_claim_token, queue.review_claimed_at,
           queue.published_at, queue.rejected_at
      into queue_record
    from pintpath_app.admin_ingestion_queue as queue
    where queue.id = item_entry.value->>'sourceIngestionId'
    for share;
    if not found
       or queue_record.venue_id <> item_entry.value#>>'{venue,id}'
       or queue_record.venue_name <> item_entry.value#>>'{venue,name}'
       or queue_record.status <> 'pending_review'
       or queue_record.review_claim_token is not null
       or queue_record.review_claimed_at is not null
       or queue_record.published_at is not null
       or queue_record.rejected_at is not null then
      raise exception using errcode = '55000',
        message = 'reviewed_price_promotion_source_changed';
    end if;

    select profile.venue_id, profile.name, profile.address, profile.suburb,
           profile.area, profile.active
      into profile_record
    from pintpath_app.venue_profiles as profile
    where profile.venue_id = item_entry.value#>>'{venue,id}'
    for key share;
    if not found or not profile_record.active
       or profile_record.name <> item_entry.value#>>'{venue,name}'
       or profile_record.address is distinct from
         item_entry.value#>>'{venue,address}'
       or profile_record.suburb <> item_entry.value#>>'{venue,suburb}'
       or profile_record.area is distinct from item_entry.value#>>'{venue,area}'
       or pg_catalog.lower(profile_record.suburb) <>
         pg_catalog.lower(packet->>'marketedSuburb') then
      raise exception using errcode = '55000',
        message = 'reviewed_price_promotion_venue_changed';
    end if;

    for row_entry in
      select value, ordinality::integer - 1 as item_row_ordinal
      from pg_catalog.jsonb_array_elements(item_entry.value->'rows')
        with ordinality as rows(value, ordinality)
      order by ordinality
    loop
      price_record_json := row_entry.value->'priceRecord';
      venue_beer_json := row_entry.value->'venueBeer';
      if (row_entry.value->>'ordinal')::integer <>
           row_entry.item_row_ordinal
         or price_record_json->>'id' <>
           'source-ingestion:' || (item_entry.value->>'sourceIngestionId')
             || ':' || row_entry.item_row_ordinal::text
         or price_record_json->>'venueId' <> item_entry.value#>>'{venue,id}'
         or venue_beer_json->>'venueId' <> item_entry.value#>>'{venue,id}'
         or price_record_json->>'sourceIngestionId' <>
           item_entry.value->>'sourceIngestionId'
         or venue_beer_json->>'sourceIngestionId' <>
           item_entry.value->>'sourceIngestionId'
         or price_record_json->>'sourceEvidenceReference' <>
           item_entry.value->>'evidenceReference'
         or price_record_json->>'sourceType' <> 'source_ingestion'
         or price_record_json->>'confidence' <> 'admin_verified'
         or price_record_json->>'servingSize' <> 'pint'
         or price_record_json->>'isOnTap' <> 'yes'
         or price_record_json->>'isHappyHourPrice' <> 'false'
         or price_record_json->'happyHourDetails' <> 'null'::jsonb
         or price_record_json->'sourceSubmissionId' <> 'null'::jsonb
         or venue_beer_json->>'currency' <> 'AUD'
         or venue_beer_json->>'serveSize' <> 'pint'
         or venue_beer_json->>'onTap' <> 'true'
         or venue_beer_json->>'inStock' <> 'true'
         or venue_beer_json->>'notes' <>
           'Published from admin source review.'
         or price_record_json->>'beerName' <>
           venue_beer_json->>'beerName'
         or price_record_json->>'normalizedBeerId' <>
           venue_beer_json->>'normalizedBeerId'
         or (price_record_json->>'price')::numeric <= 0
         or (price_record_json->>'price')::numeric > 10000
         or (price_record_json->>'price')::numeric <>
           (venue_beer_json->>'price')::numeric then
        raise exception using errcode = '22023',
          message = 'reviewed_price_promotion_row_invalid';
      end if;

      select item.key, item.name, item.brewery, item.style, item.abv,
             item.status
        into catalog_record
      from pintpath_app.beer_catalog_items as item
      where item.key = price_record_json->>'normalizedBeerId'
      for key share;
      if not found or catalog_record.status <> 'active'
         or catalog_record.name <> price_record_json->>'beerName'
         or catalog_record.brewery is distinct from
           venue_beer_json->>'brewery'
         or catalog_record.style is distinct from venue_beer_json->>'style'
         or catalog_record.abv is distinct from
           nullif(venue_beer_json->>'abv', '')::numeric then
        raise exception using errcode = '55000',
          message = 'reviewed_price_promotion_catalog_changed';
      end if;

      insert into pintpath_app.venue_price_records (
        id, venue_id, venue_name, suburb, beer_name, normalized_beer_id,
        serving_size, price, is_happy_hour_price, happy_hour_details,
        is_on_tap, confidence, source_type, source_submission_id,
        source_ingestion_id, source_evidence_reference,
        source_evidence_verified_at, last_verified_at, created_at, updated_at
      ) values (
        price_record_json->>'id', price_record_json->>'venueId',
        price_record_json->>'venueName', price_record_json->>'suburb',
        price_record_json->>'beerName',
        price_record_json->>'normalizedBeerId',
        price_record_json->>'servingSize',
        (price_record_json->>'price')::numeric, false, null,
        'yes', 'admin_verified', 'source_ingestion', null,
        price_record_json->>'sourceIngestionId',
        price_record_json->>'sourceEvidenceReference', committed_at_value,
        committed_at_value, committed_at_value, committed_at_value
      );
      insert into pintpath_app.venue_beers (
        id, venue_id, beer_name, normalized_beer_id, brewery, style, abv,
        serve_size, price, currency, on_tap, in_stock, notes,
        price_verified_at, stock_verified_at, source_ingestion_id,
        created_at, updated_at
      ) values (
        venue_beer_json->>'id', venue_beer_json->>'venueId',
        venue_beer_json->>'beerName',
        venue_beer_json->>'normalizedBeerId',
        venue_beer_json->>'brewery', venue_beer_json->>'style',
        nullif(venue_beer_json->>'abv', '')::numeric,
        'pint', (venue_beer_json->>'price')::numeric, 'AUD', true, true,
        'Published from admin source review.', committed_at_value,
        committed_at_value, venue_beer_json->>'sourceIngestionId',
        committed_at_value, committed_at_value
      );

      select pg_catalog.jsonb_build_object(
        'priceRecord', pg_catalog.to_jsonb(price_row),
        'venueBeer', pg_catalog.to_jsonb(beer_row)
      ) into strict after_state
      from pintpath_app.venue_price_records as price_row
      cross join pintpath_app.venue_beers as beer_row
      where price_row.id = price_record_json->>'id'
        and beer_row.id = venue_beer_json->>'id';
      row_request_sha := pg_catalog.encode(pg_catalog.sha256(
        pg_catalog.convert_to(row_entry.value::text, 'UTF8')
      ), 'hex');
      after_state_sha := pg_catalog.encode(pg_catalog.sha256(
        pg_catalog.convert_to(after_state::text, 'UTF8')
      ), 'hex');
      row_receipt_sha := pg_catalog.encode(pg_catalog.sha256(
        pg_catalog.convert_to(pg_catalog.concat_ws(chr(31),
          'pintpath-reviewed-price-operation-row-v1',
          operation_id_value::text, global_ordinal::text, row_request_sha,
          before_state_sha, after_state_sha
        ), 'UTF8')
      ), 'hex');
      ledger_rows := ledger_rows || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'afterStateSha256', after_state_sha,
          'beforeStateSha256', before_state_sha,
          'normalizedBeerId', price_record_json->>'normalizedBeerId',
          'priceRecordId', price_record_json->>'id',
          'rowOrdinal', global_ordinal,
          'rowReceiptSha256', row_receipt_sha,
          'rowRequestSha256', row_request_sha,
          'sourceIngestionId', item_entry.value->>'sourceIngestionId',
          'venueBeerId', venue_beer_json->>'id',
          'venueId', item_entry.value#>>'{venue,id}'
        )
      );
      global_ordinal := global_ordinal + 1;
    end loop;

    update pintpath_app.admin_ingestion_queue
       set status = 'published',
           image_data_url = null,
           image_redacted_at = committed_at_value,
           image_redaction_reason = 'review_completed',
           review_claim_token = null,
           review_claimed_at = null,
           error_message = null,
           updated_at = committed_at_value,
           published_at = committed_at_value
     where id = item_entry.value->>'sourceIngestionId'
       and status = 'pending_review'
       and review_claim_token is null
       and review_claimed_at is null
       and published_at is null
       and rejected_at is null;
    if not found then
      raise exception using errcode = '55000',
        message = 'reviewed_price_promotion_source_changed';
    end if;
  end loop;
  if global_ordinal <> row_count_value then
    raise exception using errcode = '22023',
      message = 'reviewed_price_promotion_row_count_mismatch';
  end if;

  result_state_sha := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(ledger_rows::text, 'UTF8')
  ), 'hex');
  receipt_sha := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.concat_ws(chr(31),
      'pintpath-reviewed-price-operation-receipt-v1', 'apply',
      authorization_id_value::text, operation_id_value::text, '',
      request_sha, result_state_sha,
      committed_at_text, row_count_value::text,
      pg_catalog.array_to_string(source_ids, ','),
      request->>'approvalFileSha256'
    ), 'UTF8')), 'hex');

  insert into pintpath_ops.reviewed_price_promotion_operations (
    operation_id, operation_kind, source_apply_operation_id, candidate_sha,
    expected_environment, authority_bundle_sha256, plan_candidate_sha256,
    review_packet_candidate_sha256, target_physical_identity_sha256,
    source_snapshot_sha256, request_sha256, requested_row_count, committed_at,
    result_state_sha256, receipt_sha256
  ) values (
    operation_id_value, 'apply', null, approval->>'candidateSha',
    approval->>'expectedEnvironment', approval->>'authorityBundleSha256',
    plan->>'planCandidateSha256', packet->>'reviewPacketCandidateSha256',
    physical_identity_sha, approval->>'sourceSnapshotSha256', request_sha,
    row_count_value, committed_at_value, result_state_sha, receipt_sha
  );

  insert into pintpath_ops.reviewed_price_promotion_rows (
    operation_id, row_ordinal, source_ingestion_id, venue_id,
    price_record_id, venue_beer_id, normalized_beer_id, row_request_sha256,
    before_state_sha256, after_state_sha256, row_receipt_sha256
  )
  select operation_id_value, (entry->>'rowOrdinal')::integer,
         (entry->>'sourceIngestionId')::uuid, (entry->>'venueId')::uuid,
         entry->>'priceRecordId', entry->>'venueBeerId',
         entry->>'normalizedBeerId', entry->>'rowRequestSha256',
         entry->>'beforeStateSha256', entry->>'afterStateSha256',
         entry->>'rowReceiptSha256'
  from pg_catalog.jsonb_array_elements(ledger_rows) as rows(entry)
  order by (entry->>'rowOrdinal')::integer;

  response_receipt := pg_catalog.jsonb_build_object(
    'approvalFileSha256', request->>'approvalFileSha256',
    'approvalReferenceSha256', approval->>'approvalReferenceSha256',
    'authorizationId', authorization_id_value::text,
    'authorityBundleSha256', approval->>'authorityBundleSha256',
    'candidateSha', approval->>'candidateSha',
    'committedAt', committed_at_text,
    'expectedEnvironment', approval->>'expectedEnvironment',
    'itemCount', item_count_value,
    'kind', 'pintpath-postgres-reviewed-price-operation-receipt',
    'operationId', operation_id_value::text,
    'operationKind', 'apply',
    'operatorIdSha256', approval->>'operatorIdSha256',
    'planCandidateSha256', plan->>'planCandidateSha256',
    'receiptSha256', receipt_sha,
    'requestSha256', request_sha,
    'requestedRowCount', row_count_value,
    'resultStateSha256', result_state_sha,
    'reviewPacketCandidateSha256', packet->>'reviewPacketCandidateSha256',
    'reviewerIdSha256', approval->>'reviewerIdSha256',
    'sourceApplyOperationId', null,
    'sourceIngestionIds', pg_catalog.to_jsonb(source_ids),
    'targetPhysicalIdentitySha256', physical_identity_sha,
    'version', 1
  );
  return pg_catalog.jsonb_build_object(
    'receipt', response_receipt, 'replayed', false
  );
exception
  when serialization_failure or deadlock_detected or lock_not_available then
    raise exception using errcode = sqlstate,
      message = 'reviewed_price_promotion_retryable_transaction_failure';
end
$pintpath_apply$;

create or replace function pintpath_ops.quarantine_reviewed_price_promotion(
  request pg_catalog.jsonb
) returns pg_catalog.jsonb
language plpgsql
volatile
parallel unsafe
security definer
set search_path = pg_catalog
as $pintpath_quarantine$
declare
  database_oid_text text;
  expected_owner text;
  plan jsonb;
  plan_candidate jsonb;
  packet jsonb;
  packet_candidate jsonb;
  approval_envelope jsonb;
  approval jsonb;
  source_receipt jsonb;
  approval_payload_sha text;
  authorization_request_sha text;
  source_ids text[];
  authorization_id_value uuid;
  operation_id_value uuid;
  source_apply_operation_id_value uuid;
  committed_at_value timestamptz;
  committed_at_text text;
  physical_identity_text text;
  physical_identity_sha text;
  request_sha text;
  result_state_sha text;
  receipt_sha text;
  row_count_value integer;
  item_count_value integer;
  ledger_rows jsonb := '[]'::jsonb;
  source_operation record;
  registered_authorization record;
  source_row record;
  existing_operation record;
  existing_found boolean := false;
  before_state jsonb;
  after_state jsonb;
  before_state_sha text;
  after_state_sha text;
  row_request_sha text;
  row_receipt_sha text;
  response_receipt jsonb;
begin
  select database.oid::text into strict database_oid_text
  from pg_catalog.pg_database as database
  where database.datname = pg_catalog.current_database();
  expected_owner :=
    'pintpath_reviewed_price_quarantine_owner_d' || database_oid_text;
  if current_user <> expected_owner then
    raise exception using errcode = '42501',
      message = 'reviewed_price_promotion_kernel_owner_unsafe';
  end if;
  if pg_catalog.current_setting('transaction_isolation') <> 'serializable'
     or pg_catalog.current_setting('transaction_read_only')::boolean then
    raise exception using errcode = '25000',
      message = 'reviewed_price_promotion_transaction_unsafe';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(-1516610544307388179);

  if request is null or pg_catalog.jsonb_typeof(request) <> 'object'
     or (select pg_catalog.array_agg(key order by key collate "C")
         from pg_catalog.jsonb_object_keys(request) as keys(key))
        is distinct from array[
          'approvalEnvelopeCanonical','approvalFileSha256',
          'approvalPayloadCanonical','approvalSignatureSha256','operationId',
          'operationKind','planCandidateCanonical','planCanonical',
          'reviewPacketCandidateCanonical','reviewPacketCanonical',
          'sourceApplyReceiptCanonical','version'
        ]::text[]
     or request->>'version' <> '1'
     or request->>'operationKind' <> 'quarantine'
     or pg_catalog.jsonb_typeof(request->'sourceApplyReceiptCanonical')
       <> 'string'
     or request->>'approvalFileSha256' !~ '^[0-9a-f]{64}$'
     or request->>'approvalSignatureSha256' !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023',
      message = 'reviewed_price_promotion_request_invalid';
  end if;
  begin
    operation_id_value := (request->>'operationId')::uuid;
    plan := (request->>'planCanonical')::jsonb;
    plan_candidate := (request->>'planCandidateCanonical')::jsonb;
    packet := (request->>'reviewPacketCanonical')::jsonb;
    packet_candidate := (request->>'reviewPacketCandidateCanonical')::jsonb;
    approval_envelope := (request->>'approvalEnvelopeCanonical')::jsonb;
    approval := (request->>'approvalPayloadCanonical')::jsonb;
    source_receipt := (request->>'sourceApplyReceiptCanonical')::jsonb;
    authorization_id_value := (approval->>'authorizationId')::uuid;
    source_apply_operation_id_value :=
      (approval->>'sourceApplyOperationId')::uuid;
  exception when others then
    raise exception using errcode = '22023',
      message = 'reviewed_price_promotion_request_invalid';
  end;

  if plan - 'planCandidateSha256' <> plan_candidate
     or packet - 'reviewPacketCandidateSha256' <> packet_candidate
     or approval_envelope->'payload' <> approval
     or approval_envelope->>'kind' <>
       'pintpath-postgres-reviewed-price-operation-signed-approval'
     or approval_envelope->>'version' <> '1'
     or pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(request->>'planCanonical', 'UTF8')
     ), 'hex') <> approval->>'planFileSha256'
     or pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(request->>'reviewPacketCanonical', 'UTF8')
     ), 'hex') <> approval->>'reviewPacketFileSha256'
     or pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(request->>'planCandidateCanonical', 'UTF8')
     ), 'hex') <> plan->>'planCandidateSha256'
     or pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(
         request->>'reviewPacketCandidateCanonical', 'UTF8'
       )
     ), 'hex') <> packet->>'reviewPacketCandidateSha256'
     or pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(request->>'approvalEnvelopeCanonical', 'UTF8')
     ), 'hex') <> request->>'approvalFileSha256'
     or pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.decode(approval_envelope->>'signatureBase64', 'base64')
     ), 'hex') <> request->>'approvalSignatureSha256'
     or pg_catalog.encode(pg_catalog.sha256(
       pg_catalog.convert_to(request->>'sourceApplyReceiptCanonical', 'UTF8')
     ), 'hex') <> approval->>'sourceApplyReceiptFileSha256' then
    raise exception using errcode = '22023',
      message = 'reviewed_price_promotion_artifact_hash_mismatch';
  end if;

  approval_payload_sha := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(request->>'approvalPayloadCanonical', 'UTF8')
  ), 'hex');
  if approval->>'kind' <>
       'pintpath-postgres-reviewed-price-operation-approval-payload'
     or approval->>'version' <> '1'
     or approval->>'operationKind' <> 'quarantine'
     or approval->>'operationId' <> operation_id_value::text
     or approval->>'authorizationId' <> authorization_id_value::text
     or authorization_id_value = operation_id_value
     or approval->>'sourceApplyReceiptSha256' <>
       source_receipt->>'receiptSha256'
     or approval->>'operatorIdSha256' !~ '^[0-9a-f]{64}$'
     or approval->>'reviewerIdSha256' !~ '^[0-9a-f]{64}$'
     or approval->>'operatorIdSha256' = approval->>'reviewerIdSha256'
     or approval->>'operatorLoginSha256' = approval->>'reviewerLoginSha256'
     or approval->>'operatorLoginSha256' <>
       pg_catalog.encode(pg_catalog.sha256(
         pg_catalog.convert_to(
           'pintpath-reviewed-price-database-login-v1', 'UTF8'
         ) || pg_catalog.decode('00', 'hex')
           || pg_catalog.convert_to(session_user, 'UTF8')
       ), 'hex')
     or approval->>'candidateSha' <> plan->>'candidateSha'
     or approval->>'candidateSha' <> packet->>'candidateSha'
     or approval->>'planCandidateSha256' <>
       plan->>'planCandidateSha256'
     or approval->>'reviewPacketCandidateSha256' <>
       packet->>'reviewPacketCandidateSha256'
     or approval->>'authorityBundleSha256' <>
       plan#>>'{authority,authorityBundleSha256}'
     or approval->>'authorityBundleSha256' <>
       packet->>'authorityBundleSha256'
     or approval->>'expectedEnvironment' <>
       plan->>'expectedEnvironment'
     or approval->>'expectedEnvironment' <>
       packet->>'expectedEnvironment'
     or approval->>'expectedEnvironment' not in
       ('permanent-staging', 'production')
     or approval->>'targetPhysicalIdentitySha256' <>
       plan#>>'{target,physicalIdentitySha256}'
     or approval->>'targetPhysicalIdentitySha256' <>
       packet->>'targetPhysicalIdentitySha256'
     or approval->>'sourceSnapshotSha256' <>
       plan#>>'{sourceSnapshot,combinedSha256}'
     or approval->>'sourceSnapshotSha256' <>
       packet->>'sourceSnapshotSha256'
     or approval->>'deploymentBindingSha256' !~ '^[0-9a-f]{64}$'
     or approval->>'evidenceAuthoritySha256' !~ '^[0-9a-f]{64}$'
     or approval->>'recoveryAuthoritySha256' <>
       plan#>>'{authority,recoveryReferencesSha256}'
     or approval->>'approvalReferenceSha256' !~ '^[0-9a-f]{64}$'
     or approval->>'reviewerPublicKeySha256' !~ '^[0-9a-f]{64}$'
     or approval->>'transportRootCaSha256' !~ '^[0-9a-f]{64}$'
     or (approval->>'issuedAt')::timestamptz >
       pg_catalog.transaction_timestamp()
     or (approval->>'expiresAt')::timestamptz <
       pg_catalog.transaction_timestamp()
     or (approval->>'expiresAt')::timestamptz <=
       (approval->>'issuedAt')::timestamptz
     or (approval->>'expiresAt')::timestamptz -
       (approval->>'issuedAt')::timestamptz > interval '24 hours' then
    raise exception using errcode = '42501',
      message = 'reviewed_price_promotion_approval_invalid';
  end if;

  select control.system_identifier::text into strict physical_identity_text
  from pg_catalog.pg_control_system() as control;
  physical_identity_text :=
    '{"databaseName":' || pg_catalog.to_json(pg_catalog.current_database())::text
    || ',"databaseOid":' || pg_catalog.to_json(database_oid_text)::text
    || ',"kind":"pintpath-postgres-logical-source-database"'
    || ',"serverVersionNum":'
    || pg_catalog.to_json(pg_catalog.current_setting('server_version_num'))::text
    || ',"systemIdentifier":'
    || pg_catalog.to_json(physical_identity_text)::text
    || ',"version":1}' || chr(10);
  physical_identity_sha := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(physical_identity_text, 'UTF8')
  ), 'hex');
  if physical_identity_sha <> approval->>'targetPhysicalIdentitySha256' then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_target_binding_mismatch';
  end if;

  item_count_value := pg_catalog.jsonb_array_length(packet->'items');
  row_count_value := (packet->>'rowCount')::integer;
  select pg_catalog.array_agg(value->>'sourceIngestionId'
           order by value->>'sourceIngestionId' collate "C") into source_ids
  from pg_catalog.jsonb_array_elements(packet->'items') as entries(value);
  if item_count_value < 1 or item_count_value > 50
     or row_count_value < 1 or row_count_value > 5000
     or pg_catalog.array_length(source_ids, 1) <> item_count_value then
    raise exception using errcode = '22023',
      message = 'reviewed_price_promotion_packet_invalid';
  end if;

  request_sha := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.concat_ws(chr(31),
      'pintpath-reviewed-price-operation-request-v1',
      'quarantine', operation_id_value::text, authorization_id_value::text,
      plan->>'planCandidateSha256',
      packet->>'reviewPacketCandidateSha256',
      request->>'approvalFileSha256', approval_payload_sha,
      request->>'approvalSignatureSha256',
      approval->>'targetPhysicalIdentitySha256',
      approval->>'sourceSnapshotSha256', row_count_value::text
    ), 'UTF8')), 'hex');

  authorization_request_sha := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(pg_catalog.concat_ws(chr(31),
      'pintpath-reviewed-price-operation-authorization-v1',
      authorization_id_value::text, operation_id_value::text, 'quarantine',
      request->>'approvalFileSha256', approval_payload_sha,
      request->>'approvalSignatureSha256',
      plan->>'planCandidateSha256',
      packet->>'reviewPacketCandidateSha256', physical_identity_sha,
      approval->>'sourceSnapshotSha256',
      approval->>'deploymentBindingSha256',
      approval->>'evidenceAuthoritySha256',
      approval->>'recoveryAuthoritySha256',
      approval->>'operatorIdSha256', approval->>'reviewerIdSha256',
      approval->>'operatorLoginSha256', approval->>'reviewerLoginSha256',
      row_count_value::text
    ), 'UTF8')), 'hex');
  select registered.* into registered_authorization
  from pintpath_ops.reviewed_price_promotion_operations as registered
  where registered.operation_id = authorization_id_value;
  if not found
     or registered_authorization.operation_kind <> 'authorize_quarantine'
     or registered_authorization.source_apply_operation_id <>
       source_apply_operation_id_value
     or registered_authorization.candidate_sha <> approval->>'candidateSha'
     or registered_authorization.expected_environment <>
       approval->>'expectedEnvironment'
     or registered_authorization.authority_bundle_sha256 <>
       approval->>'authorityBundleSha256'
     or registered_authorization.plan_candidate_sha256 <>
       plan->>'planCandidateSha256'
     or registered_authorization.review_packet_candidate_sha256 <>
       packet->>'reviewPacketCandidateSha256'
     or registered_authorization.target_physical_identity_sha256 <>
       physical_identity_sha
     or registered_authorization.source_snapshot_sha256 <>
       approval->>'sourceSnapshotSha256'
     or registered_authorization.request_sha256 <> authorization_request_sha
     or registered_authorization.requested_row_count <> row_count_value
     or registered_authorization.result_state_sha256 <> approval_payload_sha
     or registered_authorization.receipt_sha256 <>
       request->>'approvalFileSha256' then
    raise exception using errcode = '42501',
      message = 'reviewed_price_promotion_authorization_missing';
  end if;

  select operation.*, true as found into existing_operation
  from pintpath_ops.reviewed_price_promotion_operations as operation
  where operation.operation_id = operation_id_value;
  existing_found := found;
  if existing_found then
    if existing_operation.operation_kind <> 'quarantine'
       or existing_operation.source_apply_operation_id <>
         source_apply_operation_id_value
       or existing_operation.request_sha256 <> request_sha
       or existing_operation.requested_row_count <> row_count_value then
      raise exception using errcode = '23505',
        message = 'reviewed_price_promotion_operation_id_conflict';
    end if;
    committed_at_text := pg_catalog.to_char(
      existing_operation.committed_at at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    );
    response_receipt := pg_catalog.jsonb_build_object(
      'approvalFileSha256', request->>'approvalFileSha256',
      'approvalReferenceSha256', approval->>'approvalReferenceSha256',
      'authorizationId', authorization_id_value::text,
      'authorityBundleSha256', approval->>'authorityBundleSha256',
      'candidateSha', approval->>'candidateSha',
      'committedAt', committed_at_text,
      'expectedEnvironment', approval->>'expectedEnvironment',
      'itemCount', item_count_value,
      'kind', 'pintpath-postgres-reviewed-price-operation-receipt',
      'operationId', operation_id_value::text,
      'operationKind', 'quarantine',
      'operatorIdSha256', approval->>'operatorIdSha256',
      'planCandidateSha256', plan->>'planCandidateSha256',
      'receiptSha256', existing_operation.receipt_sha256,
      'requestSha256', existing_operation.request_sha256,
      'requestedRowCount', existing_operation.requested_row_count,
      'resultStateSha256', existing_operation.result_state_sha256,
      'reviewPacketCandidateSha256',
        packet->>'reviewPacketCandidateSha256',
      'reviewerIdSha256', approval->>'reviewerIdSha256',
      'sourceApplyOperationId', source_apply_operation_id_value::text,
      'sourceIngestionIds', pg_catalog.to_jsonb(source_ids),
      'targetPhysicalIdentitySha256', physical_identity_sha,
      'version', 1
    );
    return pg_catalog.jsonb_build_object(
      'receipt', response_receipt, 'replayed', true
    );
  end if;

  select operation.* into source_operation
  from pintpath_ops.reviewed_price_promotion_operations as operation
  where operation.operation_id = source_apply_operation_id_value;
  if not found
     or source_operation.operation_kind <> 'apply'
     or source_operation.receipt_sha256 <> source_receipt->>'receiptSha256'
     or source_operation.candidate_sha <> approval->>'candidateSha'
     or source_operation.plan_candidate_sha256 <>
       plan->>'planCandidateSha256'
     or source_operation.review_packet_candidate_sha256 <>
       packet->>'reviewPacketCandidateSha256'
     or source_operation.target_physical_identity_sha256 <>
       physical_identity_sha
     or source_operation.requested_row_count <> row_count_value
     or exists (
       select 1 from pintpath_ops.reviewed_price_promotion_operations as prior
       where prior.operation_kind = 'quarantine'
         and prior.source_apply_operation_id = source_apply_operation_id_value
         and prior.operation_id <> operation_id_value
     ) then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_source_receipt_invalid';
  end if;

  lock table pintpath_app.venue_price_records in share row exclusive mode;
  lock table pintpath_app.venue_beers in share row exclusive mode;
  committed_at_value := pg_catalog.transaction_timestamp();
  committed_at_text := pg_catalog.to_char(
    committed_at_value at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );

  for source_row in
    select ledger.*
    from pintpath_ops.reviewed_price_promotion_rows as ledger
    where ledger.operation_id = source_apply_operation_id_value
    order by ledger.row_ordinal
  loop
    select pg_catalog.jsonb_build_object(
      'priceRecord', pg_catalog.to_jsonb(price_row),
      'venueBeer', pg_catalog.to_jsonb(beer_row)
    ) into before_state
    from pintpath_app.venue_price_records as price_row
    cross join pintpath_app.venue_beers as beer_row
    where price_row.id = source_row.price_record_id
      and beer_row.id = source_row.venue_beer_id
    for update of price_row, beer_row;
    if not found then
      raise exception using errcode = '55000',
        message = 'reviewed_price_promotion_quarantine_row_missing';
    end if;
    before_state_sha := pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(before_state::text, 'UTF8')
    ), 'hex');
    if before_state_sha <> source_row.after_state_sha256 then
      raise exception using errcode = '55000',
        message = 'reviewed_price_promotion_quarantine_row_changed';
    end if;

    update pintpath_app.venue_price_records
       set source_type = 'source_ingestion_quarantined',
           confidence = 'disputed',
           updated_at = committed_at_value
     where id = source_row.price_record_id
       and source_ingestion_id = source_row.source_ingestion_id::text
       and source_type = 'source_ingestion'
       and confidence = 'admin_verified';
    if not found then
      raise exception using errcode = '55000',
        message = 'reviewed_price_promotion_quarantine_row_changed';
    end if;
    update pintpath_app.venue_beers
       set on_tap = false, in_stock = false, updated_at = committed_at_value
     where id = source_row.venue_beer_id
       and source_ingestion_id = source_row.source_ingestion_id::text;
    if not found then
      raise exception using errcode = '55000',
        message = 'reviewed_price_promotion_quarantine_row_changed';
    end if;

    select pg_catalog.jsonb_build_object(
      'priceRecord', pg_catalog.to_jsonb(price_row),
      'venueBeer', pg_catalog.to_jsonb(beer_row)
    ) into strict after_state
    from pintpath_app.venue_price_records as price_row
    cross join pintpath_app.venue_beers as beer_row
    where price_row.id = source_row.price_record_id
      and beer_row.id = source_row.venue_beer_id;
    after_state_sha := pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(after_state::text, 'UTF8')
    ), 'hex');
    row_request_sha := pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(pg_catalog.concat_ws(chr(31),
        source_row.row_request_sha256, request_sha,
        source_row.row_ordinal::text
      ), 'UTF8')
    ), 'hex');
    row_receipt_sha := pg_catalog.encode(pg_catalog.sha256(
      pg_catalog.convert_to(pg_catalog.concat_ws(chr(31),
        'pintpath-reviewed-price-operation-row-v1',
        operation_id_value::text, source_row.row_ordinal::text,
        row_request_sha, before_state_sha, after_state_sha
      ), 'UTF8')
    ), 'hex');
    ledger_rows := ledger_rows || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'afterStateSha256', after_state_sha,
        'beforeStateSha256', before_state_sha,
        'normalizedBeerId', source_row.normalized_beer_id,
        'priceRecordId', source_row.price_record_id,
        'rowOrdinal', source_row.row_ordinal,
        'rowReceiptSha256', row_receipt_sha,
        'rowRequestSha256', row_request_sha,
        'sourceIngestionId', source_row.source_ingestion_id::text,
        'venueBeerId', source_row.venue_beer_id,
        'venueId', source_row.venue_id::text
      )
    );
  end loop;
  if pg_catalog.jsonb_array_length(ledger_rows) <> row_count_value then
    raise exception using errcode = '55000',
      message = 'reviewed_price_promotion_source_receipt_invalid';
  end if;

  result_state_sha := pg_catalog.encode(pg_catalog.sha256(
    pg_catalog.convert_to(ledger_rows::text, 'UTF8')
  ), 'hex');
  receipt_sha := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.concat_ws(chr(31),
      'pintpath-reviewed-price-operation-receipt-v1', 'quarantine',
      authorization_id_value::text, operation_id_value::text,
      source_apply_operation_id_value::text,
      request_sha, result_state_sha, committed_at_text,
      row_count_value::text, pg_catalog.array_to_string(source_ids, ','),
      request->>'approvalFileSha256'
    ), 'UTF8')), 'hex');

  insert into pintpath_ops.reviewed_price_promotion_operations (
    operation_id, operation_kind, source_apply_operation_id, candidate_sha,
    expected_environment, authority_bundle_sha256, plan_candidate_sha256,
    review_packet_candidate_sha256, target_physical_identity_sha256,
    source_snapshot_sha256, request_sha256, requested_row_count, committed_at,
    result_state_sha256, receipt_sha256
  ) values (
    operation_id_value, 'quarantine', source_apply_operation_id_value,
    approval->>'candidateSha', approval->>'expectedEnvironment',
    approval->>'authorityBundleSha256', plan->>'planCandidateSha256',
    packet->>'reviewPacketCandidateSha256', physical_identity_sha,
    approval->>'sourceSnapshotSha256', request_sha, row_count_value,
    committed_at_value, result_state_sha, receipt_sha
  );
  insert into pintpath_ops.reviewed_price_promotion_rows (
    operation_id, row_ordinal, source_ingestion_id, venue_id,
    price_record_id, venue_beer_id, normalized_beer_id, row_request_sha256,
    before_state_sha256, after_state_sha256, row_receipt_sha256
  )
  select operation_id_value, (entry->>'rowOrdinal')::integer,
         (entry->>'sourceIngestionId')::uuid, (entry->>'venueId')::uuid,
         entry->>'priceRecordId', entry->>'venueBeerId',
         entry->>'normalizedBeerId', entry->>'rowRequestSha256',
         entry->>'beforeStateSha256', entry->>'afterStateSha256',
         entry->>'rowReceiptSha256'
  from pg_catalog.jsonb_array_elements(ledger_rows) as rows(entry)
  order by (entry->>'rowOrdinal')::integer;

  response_receipt := pg_catalog.jsonb_build_object(
    'approvalFileSha256', request->>'approvalFileSha256',
    'approvalReferenceSha256', approval->>'approvalReferenceSha256',
    'authorizationId', authorization_id_value::text,
    'authorityBundleSha256', approval->>'authorityBundleSha256',
    'candidateSha', approval->>'candidateSha',
    'committedAt', committed_at_text,
    'expectedEnvironment', approval->>'expectedEnvironment',
    'itemCount', item_count_value,
    'kind', 'pintpath-postgres-reviewed-price-operation-receipt',
    'operationId', operation_id_value::text,
    'operationKind', 'quarantine',
    'operatorIdSha256', approval->>'operatorIdSha256',
    'planCandidateSha256', plan->>'planCandidateSha256',
    'receiptSha256', receipt_sha,
    'requestSha256', request_sha,
    'requestedRowCount', row_count_value,
    'resultStateSha256', result_state_sha,
    'reviewPacketCandidateSha256', packet->>'reviewPacketCandidateSha256',
    'reviewerIdSha256', approval->>'reviewerIdSha256',
    'sourceApplyOperationId', source_apply_operation_id_value::text,
    'sourceIngestionIds', pg_catalog.to_jsonb(source_ids),
    'targetPhysicalIdentitySha256', physical_identity_sha,
    'version', 1
  );
  return pg_catalog.jsonb_build_object(
    'receipt', response_receipt, 'replayed', false
  );
exception
  when serialization_failure or deadlock_detected or lock_not_available then
    raise exception using errcode = sqlstate,
      message = 'reviewed_price_promotion_retryable_transaction_failure';
end
$pintpath_quarantine$;

do $pintpath_activation$
declare
  database_oid_text text;
  apply_owner text;
  apply_execute text;
  quarantine_owner text;
  quarantine_execute text;
  reviewer_execute text;
  relation_name text;
  role_name text;
  executor_name text;
  executor_role_oid oid;
  executor_is_superuser boolean;
begin
  select database.oid::text into strict database_oid_text
  from pg_catalog.pg_database as database
  where database.datname = pg_catalog.current_database();
  apply_owner := 'pintpath_reviewed_price_apply_owner_d' || database_oid_text;
  apply_execute := 'pintpath_reviewed_price_apply_execute_d' || database_oid_text;
  quarantine_owner :=
    'pintpath_reviewed_price_quarantine_owner_d' || database_oid_text;
  quarantine_execute :=
    'pintpath_reviewed_price_quarantine_execute_d' || database_oid_text;
  reviewer_execute :=
    'pintpath_reviewed_price_reviewer_execute_d' || database_oid_text;
  select role.rolname, role.oid, role.rolsuper
    into strict executor_name, executor_role_oid, executor_is_superuser
  from pg_catalog.pg_roles as role
  where role.rolname = current_user;

  if pg_catalog.to_regrole(reviewer_execute) is null then
    execute pg_catalog.format(
      'create role %I nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit -1',
      reviewer_execute
    );
  end if;
  if exists (
    select 1 from pg_catalog.pg_roles as role
    where role.rolname = reviewer_execute
      and (
        role.rolcanlogin or role.rolsuper or role.rolcreatedb
        or role.rolcreaterole or role.rolinherit or role.rolreplication
        or role.rolbypassrls or role.rolconnlimit <> -1
        or role.rolvaliduntil is not null
        or exists (
          select 1 from pg_catalog.pg_auth_members as membership
          where membership.member = role.oid
             or (
               membership.roleid = role.oid
               and not (
                 not executor_is_superuser
                 and membership.member = executor_role_oid
                 and membership.admin_option
                 and not membership.inherit_option
                 and not membership.set_option
                 and membership.grantor = 10::oid
                 and exists (
                   select 1 from pg_catalog.pg_roles as grantor
                   where grantor.oid = membership.grantor
                     and grantor.rolsuper
                 )
               )
             )
        )
        or (
          select count(*) from pg_catalog.pg_auth_members as membership
          where membership.roleid = role.oid
        ) <> case when executor_is_superuser then 0 else 1 end
        or exists (
          select 1 from pg_catalog.pg_auth_members as membership
          where membership.member = role.oid
        )
        or exists (
          select 1 from pg_catalog.pg_db_role_setting as setting
          where setting.setrole = role.oid
        )
      )
  ) then
    raise exception using errcode = '42501',
      message = 'reviewed_price_promotion_reviewer_role_unsafe';
  end if;

  if not exists (
       select 1
       from pg_catalog.pg_namespace as namespace
       where namespace.nspname = 'pintpath_ops'
         and namespace.nspowner = executor_role_oid
     ) or exists (
       select 1
       from pg_catalog.pg_proc as routine
       join pg_catalog.pg_namespace as namespace
         on namespace.oid = routine.pronamespace
       where namespace.nspname = 'pintpath_ops'
         and routine.proname = any(array[
           'authorize_reviewed_price_promotion',
           'apply_reviewed_price_promotion',
           'quarantine_reviewed_price_promotion'
         ])
         and routine.pronargs = 1
         and routine.proargtypes[0] =
           'pg_catalog.jsonb'::pg_catalog.regtype::oid
         and not (
           routine.proowner = executor_role_oid
           or (
             executor_is_superuser
             and (
               (
                 routine.proname = any(array[
                   'authorize_reviewed_price_promotion',
                   'apply_reviewed_price_promotion'
                 ])
                 and routine.proowner = pg_catalog.to_regrole(apply_owner)
               )
               or (
                 routine.proname = 'quarantine_reviewed_price_promotion'
                 and routine.proowner = pg_catalog.to_regrole(quarantine_owner)
               )
             )
           )
         )
     ) then
    raise exception using errcode = '42501',
      message = 'reviewed_price_promotion_activation_executor_ownership_unsafe';
  end if;

  -- A non-superuser CREATEROLE executor receives no SET authority from its
  -- implicit ADMIN edge. Add a transaction-local, explicitly granted SET edge
  -- only long enough to transfer and administer the three function owners;
  -- the exact grantor edge is revoked and revalidated before commit.
  if not executor_is_superuser then
    foreach role_name in array array[apply_owner, quarantine_owner] loop
      execute pg_catalog.format(
        'grant %I to %I with admin false, inherit false, set true granted by %I',
        role_name, executor_name, executor_name
      );
      execute pg_catalog.format(
        'grant create on schema pintpath_ops to %I', role_name
      );
    end loop;
  end if;

  execute pg_catalog.format(
    'alter function pintpath_ops.authorize_reviewed_price_promotion(pg_catalog.jsonb) owner to %I',
    apply_owner
  );
  execute pg_catalog.format(
    'alter function pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb) owner to %I',
    apply_owner
  );
  execute pg_catalog.format(
    'alter function pintpath_ops.quarantine_reviewed_price_promotion(pg_catalog.jsonb) owner to %I',
    quarantine_owner
  );
  if not executor_is_superuser then
    foreach role_name in array array[apply_owner, quarantine_owner] loop
      execute pg_catalog.format(
        'revoke create on schema pintpath_ops from %I', role_name
      );
    end loop;
  end if;

  -- The shared runtime role retains its existing DML because venue-manager,
  -- catalog, support, privacy, and moderation repositories legitimately write
  -- these projections. Reviewed-price operators receive no table privileges;
  -- their only mutation capability is the exact SECURITY DEFINER function.
  revoke insert on table
    pintpath_app.venue_price_records,
    pintpath_app.venue_beers
    from pintpath_migrator;

  -- Reuse one policy slot per relation so the portable policy cardinality
  -- remains stable. Table grants still constrain every role to its exact verb.
  foreach relation_name in array array[
    'admin_ingestion_queue', 'beer_catalog_items', 'venue_profiles',
    'wrong_price_reports'
  ] loop
    execute pg_catalog.format(
      'alter policy %I on pintpath_app.%I to public using (current_user = any(array[%L,%L,%L])) with check (current_user = any(array[%L,%L,%L]))',
      relation_name || '_runtime_all', relation_name,
      'pintpath_runtime', 'pintpath_maintenance', apply_owner,
      'pintpath_runtime', 'pintpath_maintenance', apply_owner
    );
  end loop;
  foreach relation_name in array array['venue_price_records', 'venue_beers'] loop
    execute pg_catalog.format(
      'alter policy %I on pintpath_app.%I to public using (current_user = any(array[%L,%L,%L,%L])) with check (current_user = any(array[%L,%L,%L,%L]))',
      relation_name || '_runtime_all', relation_name,
      'pintpath_runtime', 'pintpath_maintenance', apply_owner, quarantine_owner,
      'pintpath_runtime', 'pintpath_maintenance', apply_owner, quarantine_owner
    );
  end loop;
  execute pg_catalog.format(
    'alter policy schema_metadata_runtime_read on pintpath_app.schema_metadata to public using (current_user = any(array[%L,%L,%L]))',
    'pintpath_runtime', 'pintpath_maintenance', apply_owner
  );
  execute pg_catalog.format(
    'alter policy migration_runs_migrator_select on pintpath_ops.migration_runs to public using (current_user = any(array[%L,%L]))',
    'pintpath_migrator', apply_owner
  );

  drop policy reviewed_price_promotion_operations_migrator_select
    on pintpath_ops.reviewed_price_promotion_operations;
  drop policy reviewed_price_promotion_rows_migrator_select
    on pintpath_ops.reviewed_price_promotion_rows;
  execute pg_catalog.format(
    'create policy reviewed_price_promotion_operations_migrator_select on pintpath_ops.reviewed_price_promotion_operations for all to public using (current_user = any(array[%L,%L,%L])) with check (current_user = any(array[%L,%L,%L]))',
    'pintpath_migrator', apply_owner, quarantine_owner,
    'pintpath_migrator', apply_owner, quarantine_owner
  );
  execute pg_catalog.format(
    'create policy reviewed_price_promotion_rows_migrator_select on pintpath_ops.reviewed_price_promotion_rows for all to public using (current_user = any(array[%L,%L,%L])) with check (current_user = any(array[%L,%L,%L]))',
    'pintpath_migrator', apply_owner, quarantine_owner,
    'pintpath_migrator', apply_owner, quarantine_owner
  );

  execute pg_catalog.format(
    'grant usage on schema pintpath_app, pintpath_ops to %I', apply_owner
  );
  execute pg_catalog.format(
    'grant usage on schema pintpath_app, pintpath_ops to %I', quarantine_owner
  );
  execute pg_catalog.format(
    'grant select on table pintpath_app.schema_metadata, pintpath_app.admin_ingestion_queue, pintpath_app.beer_catalog_items, pintpath_app.venue_profiles, pintpath_app.wrong_price_reports, pintpath_app.venue_price_records, pintpath_app.venue_beers, pintpath_ops.migration_runs, pintpath_ops.reviewed_price_promotion_operations, pintpath_ops.reviewed_price_promotion_rows to %I',
    apply_owner
  );
  execute pg_catalog.format(
    'grant insert on table pintpath_app.venue_price_records, pintpath_app.venue_beers, pintpath_ops.reviewed_price_promotion_operations, pintpath_ops.reviewed_price_promotion_rows to %I',
    apply_owner
  );
  -- PostgreSQL row-locking clauses and SHARE ROW EXCLUSIVE table locks require
  -- UPDATE in addition to SELECT. The owner has no login or executable
  -- INHERIT/SET path; this grant is used only while the pinned SECURITY DEFINER
  -- body holds its source/catalog locks. Promotion ledgers remain append-only.
  execute pg_catalog.format(
    'grant update on table pintpath_app.beer_catalog_items, pintpath_app.venue_profiles, pintpath_app.venue_price_records, pintpath_app.venue_beers to %I',
    apply_owner
  );
  execute pg_catalog.format(
    'grant update on table pintpath_app.admin_ingestion_queue to %I',
    apply_owner
  );
  execute pg_catalog.format(
    'grant select on table pintpath_app.venue_price_records, pintpath_app.venue_beers, pintpath_ops.reviewed_price_promotion_operations, pintpath_ops.reviewed_price_promotion_rows to %I',
    quarantine_owner
  );
  execute pg_catalog.format(
    'grant update on table pintpath_app.venue_price_records, pintpath_app.venue_beers to %I',
    quarantine_owner
  );
  execute pg_catalog.format(
    'grant insert on table pintpath_ops.reviewed_price_promotion_operations, pintpath_ops.reviewed_price_promotion_rows to %I',
    quarantine_owner
  );
  -- pg_control_system() has PostgreSQL's default PUBLIC EXECUTE ACL. The owner
  -- roles are otherwise isolated and the kernel bodies are byte-pinned, so no
  -- cluster-owner-only GRANT is required here.
  execute pg_catalog.format(
    'grant usage on schema pintpath_ops to %I', reviewer_execute
  );
  execute pg_catalog.format(
    'grant usage on schema pintpath_ops to %I', apply_execute
  );
  execute pg_catalog.format(
    'grant usage on schema pintpath_ops to %I', quarantine_execute
  );

  execute pg_catalog.format('set local role %I', apply_owner);
  revoke all on function
    pintpath_ops.authorize_reviewed_price_promotion(pg_catalog.jsonb),
    pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb)
    from public, pintpath_runtime, pintpath_migrator;
  foreach relation_name in array array['anon','authenticated','service_role'] loop
    if pg_catalog.to_regrole(relation_name) is not null then
      execute pg_catalog.format(
        'revoke all on function pintpath_ops.authorize_reviewed_price_promotion(pg_catalog.jsonb), pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb) from %I',
        relation_name
      );
    end if;
  end loop;
  execute pg_catalog.format(
    'grant execute on function pintpath_ops.authorize_reviewed_price_promotion(pg_catalog.jsonb) to %I',
    reviewer_execute
  );
  execute pg_catalog.format(
    'grant execute on function pintpath_ops.apply_reviewed_price_promotion(pg_catalog.jsonb) to %I',
    apply_execute
  );
  execute pg_catalog.format('set local role %I', executor_name);

  execute pg_catalog.format('set local role %I', quarantine_owner);
  revoke all on function
    pintpath_ops.quarantine_reviewed_price_promotion(pg_catalog.jsonb)
    from public, pintpath_runtime, pintpath_migrator;
  foreach relation_name in array array['anon','authenticated','service_role'] loop
    if pg_catalog.to_regrole(relation_name) is not null then
      execute pg_catalog.format(
        'revoke all on function pintpath_ops.quarantine_reviewed_price_promotion(pg_catalog.jsonb) from %I',
        relation_name
      );
    end if;
  end loop;
  execute pg_catalog.format(
    'grant execute on function pintpath_ops.quarantine_reviewed_price_promotion(pg_catalog.jsonb) to %I',
    quarantine_execute
  );
  execute pg_catalog.format('set local role %I', executor_name);

  if not executor_is_superuser then
    foreach role_name in array array[apply_owner, quarantine_owner] loop
      execute pg_catalog.format(
        'revoke %I from %I granted by %I',
        role_name, executor_name, executor_name
      );
    end loop;
  end if;

  if not pg_catalog.has_table_privilege(
       'pintpath_runtime', 'pintpath_app.venue_price_records',
       'INSERT,UPDATE,DELETE'
     )
     or not pg_catalog.has_table_privilege(
       'pintpath_runtime', 'pintpath_app.venue_beers',
       'INSERT,UPDATE,DELETE'
     )
     or not pg_catalog.has_table_privilege(
       'pintpath_runtime', 'pintpath_app.venue_price_records', 'SELECT'
     )
     or not pg_catalog.has_table_privilege(
       'pintpath_runtime', 'pintpath_app.venue_beers', 'SELECT'
     )
     or pg_catalog.has_table_privilege(
       apply_execute, 'pintpath_app.venue_price_records', 'SELECT'
     )
     or pg_catalog.has_table_privilege(
       quarantine_execute, 'pintpath_app.venue_price_records', 'SELECT'
     )
     or pg_catalog.has_table_privilege(
       reviewer_execute, 'pintpath_ops.reviewed_price_promotion_operations',
       'SELECT,INSERT,UPDATE,DELETE'
     )
     or not pg_catalog.has_function_privilege(
       apply_owner, 'pg_catalog.sha256(bytea)', 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       quarantine_owner, 'pg_catalog.sha256(bytea)', 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       apply_owner, 'pg_catalog.pg_control_system()', 'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       quarantine_owner, 'pg_catalog.pg_control_system()', 'EXECUTE'
     )
     or pg_catalog.has_schema_privilege(
       apply_owner, 'pintpath_ops', 'CREATE'
     )
     or pg_catalog.has_schema_privilege(
       quarantine_owner, 'pintpath_ops', 'CREATE'
     ) then
    raise exception using errcode = '42501',
      message = 'reviewed_price_promotion_activation_acl_postcondition_failed';
  end if;

  foreach role_name in array array[
    apply_owner, apply_execute, quarantine_owner, quarantine_execute,
    reviewer_execute
  ] loop
    if exists (
      select 1 from pg_catalog.pg_roles as role
      where role.rolname = role_name
        and (
          exists (
            select 1 from pg_catalog.pg_auth_members as membership
            where membership.member = role.oid
               or (
                 membership.roleid = role.oid
                 and not (
                   not executor_is_superuser
                   and membership.member = executor_role_oid
                   and membership.admin_option
                   and not membership.inherit_option
                   and not membership.set_option
                   and membership.grantor = 10::oid
                   and exists (
                     select 1 from pg_catalog.pg_roles as grantor
                     where grantor.oid = membership.grantor
                       and grantor.rolsuper
                   )
                 )
               )
          )
          or (
            select count(*) from pg_catalog.pg_auth_members as membership
            where membership.roleid = role.oid
          ) <> case when executor_is_superuser then 0 else 1 end
        )
    ) then
      raise exception using errcode = '42501',
        message = 'reviewed_price_promotion_activation_membership_postcondition_failed';
    end if;
  end loop;
end
$pintpath_activation$;

commit;
