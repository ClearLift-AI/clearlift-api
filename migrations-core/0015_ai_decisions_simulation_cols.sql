-- Add simulation columns to ai_decisions for simulation-backed recommendations
-- simulation_data: JSON with current_state, simulated_state, diminishing_returns_model
-- simulation_confidence: confidence score from simulation engine
ALTER TABLE ai_decisions ADD COLUMN simulation_data TEXT;
ALTER TABLE ai_decisions ADD COLUMN simulation_confidence REAL;
