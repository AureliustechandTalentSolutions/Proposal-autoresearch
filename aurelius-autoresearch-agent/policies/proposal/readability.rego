# Proposal Readability Policy
#
# Evaluates proposal text for readability metrics including sentence length,
# passive voice usage, jargon density, and Flesch-Kincaid grade level.
# Targets federal proposal standards for clear communication.
#
# Input schema:
#   input.text_metrics    - object with readability measurements
#   input.section         - section name being evaluated
#   input.target_audience - "technical" | "executive" | "mixed"

package proposal.readability

import rego.v1

default allow := false

# Readability thresholds
max_avg_sentence_length := 25
max_passive_voice_pct := 15
max_jargon_density := 10
max_flesch_kincaid_grade := 14
min_flesch_reading_ease := 40

# Check average sentence length
sentence_length_ok if {
	input.text_metrics.avg_sentence_length <= max_avg_sentence_length
}

# Check passive voice percentage
passive_voice_ok if {
	input.text_metrics.passive_voice_pct <= max_passive_voice_pct
}

# Check jargon density (percentage of domain-specific terms)
jargon_ok if {
	input.text_metrics.jargon_density_pct <= max_jargon_density
}

# Check Flesch-Kincaid grade level
grade_level_ok if {
	input.text_metrics.flesch_kincaid_grade <= max_flesch_kincaid_grade
}

# Check Flesch reading ease
reading_ease_ok if {
	input.text_metrics.flesch_reading_ease >= min_flesch_reading_ease
}

# Aggregate checks
checks := {
	"sentence_length": sentence_length_ok,
	"passive_voice": passive_voice_ok,
	"jargon_density": jargon_ok,
	"grade_level": grade_level_ok,
	"reading_ease": reading_ease_ok,
}

total_controls := count(checks)

passing_controls := count({name |
	some name, result in checks
	result == true
})

score := round((passing_controls / total_controls) * 100) if {
	total_controls > 0
} else := 0

allow if {
	score >= 80
}

# Generate improvement suggestions
suggestions := [suggestion |
	not sentence_length_ok
	suggestion := sprintf("Reduce average sentence length from %v to under %v words", [input.text_metrics.avg_sentence_length, max_avg_sentence_length])
] | [suggestion |
	not passive_voice_ok
	suggestion := sprintf("Reduce passive voice from %v%% to under %v%%", [input.text_metrics.passive_voice_pct, max_passive_voice_pct])
] | [suggestion |
	not reading_ease_ok
	suggestion := sprintf("Improve reading ease from %v to at least %v", [input.text_metrics.flesch_reading_ease, min_flesch_reading_ease])
]

findings := {
	"score": score,
	"checks": checks,
	"total_controls": total_controls,
	"passing_controls": passing_controls,
	"suggestions": suggestions,
	"section": input.section,
}
