-- Apply sql/live_resource_notify.sql from the package first.

CREATE TABLE tasks (
  id serial PRIMARY KEY,
  title text NOT NULL,
  done boolean NOT NULL DEFAULT false
);

-- Each viewer sees only their own notes, so a note publishes to the viewer's key.
CREATE TABLE notes (
  id serial PRIMARY KEY,
  viewer text NOT NULL,
  body text NOT NULL
);

-- `allowed` is read on every authorization check, so revoking it denies the tasks join.
-- `fault` makes this viewer's reads fail or hold, to show retained data.
CREATE TABLE viewers (
  name text PRIMARY KEY,
  allowed boolean NOT NULL DEFAULT true,
  fault text CHECK (fault IN ('fail', 'hold'))
);

CREATE TRIGGER live_resource_tasks
AFTER INSERT OR UPDATE OR DELETE ON tasks
FOR EACH ROW EXECUTE FUNCTION live_resource_notify('tasks');

CREATE TRIGGER live_resource_notes
AFTER INSERT OR UPDATE OR DELETE ON notes
FOR EACH ROW EXECUTE FUNCTION live_resource_notify('notes', 'viewer');
