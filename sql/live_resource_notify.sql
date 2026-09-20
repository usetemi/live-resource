-- Attach to every table a resource's snapshot reads from, naming the resource:
--
--   CREATE TRIGGER live_resource_tasks
--   AFTER INSERT OR UPDATE OR DELETE ON tasks
--   FOR EACH ROW EXECUTE FUNCTION live_resource_notify('tasks');
--
-- Postgres delivers the notification only after commit, drops it on rollback,
-- and coalesces identical notifications within one transaction.
CREATE OR REPLACE FUNCTION live_resource_notify() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN
    RETURN NULL;
  END IF;
  PERFORM pg_notify('live_resource', TG_ARGV[0]);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
