-- Which PTY backend a session runs on, and its terminal size, so a tmux
-- session left running by a previous server can be re-attached as it was.
ALTER TABLE sessions ADD COLUMN backend TEXT NOT NULL DEFAULT 'direct';
ALTER TABLE sessions ADD COLUMN cols INTEGER;
ALTER TABLE sessions ADD COLUMN rows INTEGER;
