# Proposal Evaluation Rubric
#
# Scores proposal sections against a configurable evaluation rubric.
# Evaluates technical approach, management approach, past performance,
# cost/price, and key personnel sections.
#
# Input schema:
#   input.sections         - object mapping section names to evaluation data
#   input.rubric           - evaluation criteria and weights
#   input.evaluation_type  - "technical" | "management" | "cost" | "full"

package proposal.eval_rubric

import rego.v1

default allow := false

# Default section weights (adjustable via input.rubric)
default_weights := {
	"technical_approach": 40,
	"management_approach": 25,
	"past_performance": 20,
	"cost_price": 10,
	"key_personnel": 5,
}

# Use provided rubric weights or defaults
weights := object.union(default_weights, input.rubric.weights) if {
	input.rubric.weights
} else := default_weights

# Calculate weighted score for each section
section_scores := {name: section_score |
	some name, data in input.sections
	weight := weights[name]
	raw := data.score
	section_score := round((raw * weight) / 100)
}

# Total weighted score
total_score := sum({s | some _, s in section_scores})

# Maximum possible score
max_score := sum({w | some _, w in weights})

# Normalized score as percentage
score := round((total_score / max_score) * 100) if {
	max_score > 0
} else := 0

# Rating bands
rating := "Outstanding" if {
	score >= 90
} else := "Good" if {
	score >= 75
} else := "Acceptable" if {
	score >= 60
} else := "Marginal" if {
	score >= 40
} else := "Unacceptable"

# Allow if proposal meets minimum acceptable threshold
allow if {
	score >= 60
}

# Identify weak sections
weak_sections := {name |
	some name, data in input.sections
	data.score < 60
}

findings := {
	"total_score": total_score,
	"max_score": max_score,
	"score": score,
	"rating": rating,
	"section_scores": section_scores,
	"weak_sections": weak_sections,
}
