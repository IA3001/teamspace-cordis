-- Allow each shared Agent definition to select an administrator-managed LLM provider profile.
ALTER TABLE agent_definitions ADD COLUMN llm_profile_ref TEXT NOT NULL DEFAULT '';
