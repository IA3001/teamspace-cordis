-- Legacy vectors remain stored but are untrusted until re-embedded with a known model.
ALTER TABLE kb_chunks ADD COLUMN embedding_model TEXT NOT NULL DEFAULT '';
