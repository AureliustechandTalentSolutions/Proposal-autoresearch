# CMMC Level 2 (Cybersecurity Maturity Model Certification)
#
# Evaluates organization practices against CMMC 2.0 Level 2 requirements,
# which align with NIST 800-171. Assesses 110 practices across 14 domains.
#
# Input schema:
#   input.practices     - object mapping practice IDs to maturity status
#   input.assessment    - "self" | "c3pao" (third-party assessor)
#   input.scope         - CUI scope boundary definition
#   input.sprs_score    - current SPRS score (-203 to 110)

package compliance.cmmc_l2

import rego.v1

default allow := false

# CMMC 2.0 Level 2 domains (aligned with NIST 800-171 families)
domains := {
	"AC": "Access Control",
	"AM": "Asset Management",
	"AT": "Awareness and Training",
	"AU": "Audit and Accountability",
	"CM": "Configuration Management",
	"IA": "Identification and Authentication",
	"IR": "Incident Response",
	"MA": "Maintenance",
	"MP": "Media Protection",
	"PE": "Physical Protection",
	"PS": "Personnel Security",
	"RA": "Risk Assessment",
	"CA": "Security Assessment",
	"SC": "System and Communications Protection",
	"SI": "System and Information Integrity",
}

total_controls := count(input.practices)

passing_controls := count({id |
	some id, status in input.practices
	status in {"met", "implemented"}
})

score := round((passing_controls / total_controls) * 100) if {
	total_controls > 0
} else := 0

# CMMC L2 requires all 110 practices to be met for certification
allow if {
	score == 100
}

# Conditional authorization with POA&M if close to full compliance
conditional_authorization if {
	score >= 90
	input.sprs_score >= 88
}

# SPRS score validation
sprs_valid if {
	input.sprs_score >= -203
	input.sprs_score <= 110
}

# Identify unmet practices
unmet_practices := {id: status |
	some id, status in input.practices
	not status in {"met", "implemented"}
}

findings := {
	"total_controls": total_controls,
	"passing_controls": passing_controls,
	"score": score,
	"assessment_type": input.assessment,
	"sprs_score": input.sprs_score,
	"sprs_valid": sprs_valid,
	"conditional_authorization": conditional_authorization,
	"unmet_practices": unmet_practices,
}
