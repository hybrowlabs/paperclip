\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE lookup_test_runs (test_case text, company_id text, context_snapshot jsonb, status text, started_at timestamptz);
INSERT INTO lookup_test_runs VALUES
 ('non_array', 'company', '{"issueId":"issue","wakeCommentIds":"comment"}', 'succeeded', now()),
 ('null_element', 'company', '{"issueId":"issue","wakeCommentIds":[null,"other"]}', 'succeeded', now()),
 ('nested_array', 'company', '{"issueId":"issue","wakeCommentIds":[["comment"]]}', 'succeeded', now()),
 ('mixed_array', 'company', '{"issueId":"issue","wakeCommentIds":[null,123,{},"comment"]}', 'succeeded', now()),
 ('scalar', 'company', '{"issueId":"issue","wakeCommentId":"comment"}', 'succeeded', now()),
 ('array', 'company', '{"issueId":"issue","wakeCommentIds":["comment","other"]}', 'succeeded', now()),
 ('both', 'company', '{"issueId":"issue","wakeCommentId":"comment","wakeCommentIds":["comment"]}', 'running', now()),
 ('cancelled_unstarted', 'company', '{"issueId":"issue","wakeCommentId":"comment"}', 'cancelled', NULL),
 ('cancelled_started', 'company', '{"issueId":"issue","wakeCommentIds":["comment"]}', 'cancelled', now()),
 ('other_company', 'other', '{"issueId":"issue","wakeCommentId":"comment"}', 'succeeded', now()),
 ('other_issue', 'company', '{"issueId":"other","wakeCommentIds":["comment"]}', 'succeeded', now()),
 ('other_comment', 'company', '{"issueId":"issue","wakeCommentId":"other","wakeCommentIds":["other"]}', 'succeeded', now()),
 ('null_snapshot', 'company', NULL, 'succeeded', now()),
 ('null_fields', 'company', '{"issueId":"issue","wakeCommentId":null,"wakeCommentIds":null}', 'succeeded', now()),
 ('missing_fields', 'company', '{"issueId":"issue"}', 'succeeded', now()),
 ('empty_array', 'company', '{"issueId":"issue","wakeCommentIds":[]}', 'succeeded', now()),
 ('duplicate_runs', 'company', '{"issueId":"issue","wakeCommentId":"comment"}', 'succeeded', now()),
 ('duplicate_runs', 'company', '{"issueId":"issue","wakeCommentIds":["comment"]}', 'succeeded', now());
DO $$
DECLARE failures int;
BEGIN
 WITH cases(test_case, expected_saved) AS (VALUES
 ('non_array',true),('null_element',true),('nested_array',true),('mixed_array',false),
 ('scalar',false),('array',false),('both',false),('cancelled_unstarted',true),
 ('cancelled_started',false),('other_company',true),('other_issue',true),
 ('other_comment',true),('null_snapshot',true),('null_fields',true),
 ('missing_fields',true),('empty_array',true),('duplicate_runs',false),('no_runs',true)
 ), results AS (
 SELECT c.*,
 NOT EXISTS (SELECT 1 FROM lookup_test_runs r WHERE r.test_case=c.test_case
 AND r.company_id='company' AND r.context_snapshot->>'issueId'='issue'
 AND NOT (r.status='cancelled' AND r.started_at IS NULL)
 AND (r.context_snapshot->>'wakeCommentId'='comment' OR r.context_snapshot->'wakeCommentIds' @> jsonb_build_array('comment'::text))) AS original,
'comment'::text not in (
      with consumed as materialized (
        select context_snapshot->>'wakeCommentId' as single_id,
          context_snapshot->'wakeCommentIds' as ids
        from lookup_test_runs
        where test_case=c.test_case and company_id = 'company'
          and context_snapshot->>'issueId' = 'issue'
          and not (status = 'cancelled' and started_at is null)
      ), comment_ids as (
        select single_id as id from consumed
        union all
        select element #>> '{}' as id from consumed,
          lateral jsonb_array_elements(case when jsonb_typeof(ids) = 'array'
            then ids else '[]'::jsonb end) as elements(element)
        where jsonb_typeof(element) = 'string'
      )
      select id from comment_ids where id is not null
    ) AS patched
 FROM cases c
 ) SELECT count(*) INTO failures FROM results WHERE original IS DISTINCT FROM patched OR patched IS DISTINCT FROM expected_saved;
 IF failures <> 0 THEN RAISE EXCEPTION 'comment lookup failures: %', failures; END IF;
 RAISE NOTICE '18 comment lookup semantic cases passed';
END $$;
ROLLBACK;
