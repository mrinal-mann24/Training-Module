-- Pre-launch review (2026-09-22), two database findings.
--
-- 1. learner_profile.generation_engine was writable by the learner.
--    learner_profile_update_own and learner_profile_insert_own are row
--    policies (auth.uid() = id) with no column restriction, so a learner's
--    own browser session could run
--      supabase.from('learner_profile').update({ generation_engine: 'planned' })
--    and move themselves between engines; the rollout is meant to be the
--    owner's call, one learner at a time.
--
--    A trigger, not column grants: onboarding writes the row through an
--    UPSERT, which PostgREST turns into INSERT ... ON CONFLICT DO UPDATE over
--    every column in the payload, and a column-grant list that forgot one
--    of them would break onboarding for every new learner. The trigger
--    touches nothing else: for a request made as `authenticated` it pins
--    the column to its default on insert and to its current value on
--    update. The service role (the jobs) and the SQL editor are unaffected.

create or replace function public.protect_learner_generation_engine()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.role()) = 'authenticated' then
    if tg_op = 'INSERT' then
      new.generation_engine := 'legacy';
    else
      new.generation_engine := old.generation_engine;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists learner_profile_protect_generation_engine on learner_profile;
create trigger learner_profile_protect_generation_engine
  before insert or update on learner_profile
  for each row
  execute function public.protect_learner_generation_engine();

-- 2. exercises had no index on learner_id. It is the filter of the RLS
--    select policy and of every per-learner read on the scoring and
--    generation paths (the batch guard, the ordinal, the expected closing
--    balances, the open advances, loadAnswerKeys), all ordered by
--    created_at, so each scanned the whole table for every learner.

create index if not exists exercises_learner_created_idx on exercises (learner_id, created_at);
