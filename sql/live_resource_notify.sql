-- Attach to every table a topic's read depends on, naming the topic and,
-- optionally, the column whose value is the topic key:
--
--   CREATE TRIGGER live_resource_tasks
--   AFTER INSERT OR UPDATE OR DELETE ON tasks
--   FOR EACH ROW EXECUTE FUNCTION live_resource_notify('tasks', 'id');
--
--   CREATE TRIGGER live_resource_tasks_comments
--   AFTER INSERT OR UPDATE OR DELETE ON comments
--   FOR EACH ROW EXECUTE FUNCTION live_resource_notify('tasks', 'task_id');
--
-- Without a key column the hint is keyless and reaches every join on the name.
-- With one, INSERT publishes NEW's key, DELETE publishes OLD's, and an UPDATE
-- that moves a row between keys publishes both. A null key publishes nothing,
-- and so does a column the table lacks; the server reports the latter from
-- pg_trigger when it connects. The key is the column as to_jsonb renders it.
--
-- Postgres delivers the notification only after commit, drops it on rollback,
-- and coalesces identical notifications within one transaction.
CREATE OR REPLACE FUNCTION live_resource_notify() RETURNS trigger AS $$
DECLARE
  old_key text;
  new_key text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN
    RETURN NULL;
  END IF;
  IF TG_NARGS < 2 THEN
    PERFORM pg_notify('live_resource', TG_ARGV[0]);
    RETURN NULL;
  END IF;
  -- Reading NEW in a DELETE trigger yields null rather than failing, so branch on TG_OP.
  IF TG_OP <> 'INSERT' THEN
    old_key := to_jsonb(OLD) ->> TG_ARGV[1];
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_key := to_jsonb(NEW) ->> TG_ARGV[1];
  END IF;
  IF old_key IS NOT NULL THEN
    PERFORM pg_notify('live_resource', TG_ARGV[0] || ' ' || old_key);
  END IF;
  IF new_key IS NOT NULL AND new_key IS DISTINCT FROM old_key THEN
    PERFORM pg_notify('live_resource', TG_ARGV[0] || ' ' || new_key);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
