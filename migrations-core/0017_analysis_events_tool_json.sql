-- Add full tool call input/output JSON to analysis_events
-- tool_input: raw JSON arguments the LLM passed to the tool
-- tool_output: raw JSON response returned by the tool executor
ALTER TABLE analysis_events ADD COLUMN tool_input TEXT;
ALTER TABLE analysis_events ADD COLUMN tool_output TEXT;
