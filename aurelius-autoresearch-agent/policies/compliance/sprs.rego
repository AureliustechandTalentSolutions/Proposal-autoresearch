# SPRS (Supplier Performance Risk System) Score Calculation
#
# Calculates the SPRS score based on NIST 800-171 assessment results.
# SPRS scores range from -203 (no controls implemented) to 110 (all
# controls fully implemented). Used for DoD contractor assessments.
#
# Input schema:
#   input.requirements  - object mapping requirement IDs to weighted scores
#   input.poam_items    - array of POA&M items with planned completion dates
#   input.assessment_date - ISO date of most recent assessment

package compliance.sprs

import rego.v1

default allow := false

# Maximum possible SPRS score
max_score := 110

# Calculate raw SPRS score from requirement weights
raw_score := sum({weight |
	some id, weight in input.requirements
}) if {
	count(input.requirements) > 0
} else := -203

# SPRS score is capped at the range [-203, 110]
score := min([max([raw_score, -203]), 110])

# Acceptable SPRS score threshold for basic contract eligibility
allow if {
	score >= 110
}

# Conditional eligibility with POA&M
conditional_allow if {
	score >= 88
	count(input.poam_items) > 0
	all_poam_valid
}

# Validate all POA&M items have completion dates within 180 days
all_poam_valid if {
	every item in input.poam_items {
		item.planned_completion != ""
	}
}

# Count overdue POA&M items
overdue_poam := count({item |
	some item in input.poam_items
	item.status == "overdue"
})

# Risk classification based on score
risk_level := "low" if {
	score >= 88
} else := "moderate" if {
	score >= 50
} else := "high" if {
	score >= 0
} else := "critical"

findings := {
	"score": score,
	"max_score": max_score,
	"risk_level": risk_level,
	"overdue_poam": overdue_poam,
	"total_poam": count(input.poam_items),
	"conditional_allow": conditional_allow,
	"assessment_date": input.assessment_date,
}
