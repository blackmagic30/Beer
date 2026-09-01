do $cleanup$
declare
  accounts_relation pg_catalog.oid :=
    pg_catalog.to_regclass('pintpath_app.accounts');
  public_account_attribute pg_catalog.int2;
  validated_constraint_index_relation pg_catalog.oid;
  redundant_index_relation pg_catalog.oid :=
    pg_catalog.to_regclass('pintpath_app.idx_accounts_public_account');
begin
  if accounts_relation is null then
    raise exception
      'Refusing to remove idx_accounts_public_account because pintpath_app.accounts is absent.';
  end if;

  select attribute_definition.attnum
    into public_account_attribute
    from pg_catalog.pg_attribute attribute_definition
   where attribute_definition.attrelid = accounts_relation
     and attribute_definition.attname = 'public_account_id'
     and attribute_definition.attnum > 0
     and not attribute_definition.attisdropped;

  if public_account_attribute is null then
    raise exception
      'Refusing to remove idx_accounts_public_account without the exact validated accounts(public_account_id) unique constraint and valid backing index.';
  end if;

  select constraint_definition.conindid
    into validated_constraint_index_relation
    from pg_catalog.pg_constraint constraint_definition
    join pg_catalog.pg_index constraint_index
      on constraint_index.indexrelid = constraint_definition.conindid
    join pg_catalog.pg_class constraint_index_definition
      on constraint_index_definition.oid = constraint_index.indexrelid
    where constraint_definition.conrelid = accounts_relation
      and constraint_definition.conname = 'accounts_public_account_id_key'
      and constraint_definition.contype = 'u'
      and constraint_definition.convalidated
      and not constraint_definition.condeferrable
      and not constraint_definition.condeferred
      and constraint_definition.conkey =
        array[public_account_attribute]::pg_catalog.int2[]
      and constraint_index_definition.relkind = 'i'
      and constraint_index.indrelid = accounts_relation
      and constraint_index.indisunique
      and constraint_index.indisvalid
      and constraint_index.indisready
      and constraint_index.indislive
      and constraint_index.indimmediate
      and not constraint_index.indisprimary
      and not constraint_index.indisexclusion
      and not constraint_index.indnullsnotdistinct
      and constraint_index.indnkeyatts = 1
      and constraint_index.indnatts = 1
      and constraint_index.indkey[0] = public_account_attribute
      and constraint_index.indpred is null
      and constraint_index.indexprs is null;

  if validated_constraint_index_relation is null then
    raise exception
      'Refusing to remove idx_accounts_public_account without the exact validated accounts(public_account_id) unique constraint and valid backing index.';
  end if;

  if redundant_index_relation is not null then
    if not exists (
      select 1
      from pg_catalog.pg_class redundant_index_definition
      join pg_catalog.pg_index redundant_index
        on redundant_index.indexrelid = redundant_index_definition.oid
      join pg_catalog.pg_class constraint_index_definition
        on constraint_index_definition.oid = validated_constraint_index_relation
      join pg_catalog.pg_index constraint_index
        on constraint_index.indexrelid = constraint_index_definition.oid
      where redundant_index_definition.oid = redundant_index_relation
        and redundant_index_definition.relkind = 'i'
        and redundant_index.indrelid = accounts_relation
        and redundant_index.indisunique
        and redundant_index.indisvalid
        and redundant_index.indisready
        and redundant_index.indislive
        and redundant_index.indimmediate
        and not redundant_index.indisprimary
        and not redundant_index.indisexclusion
        and not redundant_index.indnullsnotdistinct
        and redundant_index.indnkeyatts = 1
        and redundant_index.indnatts = 1
        and redundant_index.indkey[0] = public_account_attribute
        and redundant_index.indpred is null
        and redundant_index.indexprs is null
        and redundant_index_definition.relam = constraint_index_definition.relam
        and redundant_index.indkey = constraint_index.indkey
        and redundant_index.indcollation = constraint_index.indcollation
        and redundant_index.indclass = constraint_index.indclass
        and redundant_index.indoption = constraint_index.indoption
    ) then
      raise exception
        'Refusing to remove idx_accounts_public_account because the existing object is not the exact redundant unique index on accounts(public_account_id).';
    end if;

    execute 'drop index pintpath_app.idx_accounts_public_account';
  end if;
end
$cleanup$;
