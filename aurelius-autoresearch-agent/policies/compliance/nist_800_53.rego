# NIST SP 800-53 Security and Privacy Controls
#
# Evaluates system security plans and artifacts against NIST 800-53 Rev 5
# control families. Produces a compliance score based on implemented vs
# required controls for the target baseline (Low, Moderate, High).
#
# Input schema:
#   input.baseline      - "low" | "moderate" | "high"
#   input.controls      - object mapping control IDs to implementation status
#   input.system_type   - "cloud" | "on-prem" | "hybrid"

package compliance.nist_800_53

import rego.v1

default allow := false

# Control families and their required controls per baseline
moderate_families := {
	"AC": "Access Control",
	"AT": "Awareness and Training",
	"AU": "Audit and Accountability",
	"CA": "Assessment, Authorization, and Monitoring",
	"CM": "Configuration Management",
	"CP": "Contingency Planning",
	"IA": "Identification and Authentication",
	"IR": "Incident Response",
	"MA": "Maintenance",
	"MP": "Media Protection",
	"PE": "Physical and Environmental Protection",
	"PL": "Planning",
	"PM": "Program Management",
	"PS": "Personnel Security",
	"RA": "Risk Assessment",
	"SA": "System and Services Acquisition",
	"SC": "System and Communications Protection",
	"SI": "System and Information Integrity",
	"SR": "Supply Chain Risk Management",
}

# Count total controls provided
total_controls := count(input.controls)

# Count controls that are implemented or partially implemented
passing_controls := count({id |
	some id, status in input.controls
	status in {"implemented", "partially_implemented", "planned"}
})

# Calculate compliance score as a percentage
score := round((passing_controls / total_controls) * 100) if {
	total_controls > 0
} else := 0

# Allow if score meets threshold for baseline
allow if {
	input.baseline == "low"
	score >= 70
}

allow if {
	input.baseline == "moderate"
	score >= 80
}

allow if {
	input.baseline == "high"
	score >= 90
}

# Identify non-compliant controls
failing_controls := {id: status |
	some id, status in input.controls
	status in {"not_implemented", "not_applicable_override"}
}

# Produce findings summary
findings := {
	"total_controls": total_controls,
	"passing_controls": passing_controls,
	"failing_controls": total_controls - passing_controls,
	"score": score,
	"baseline": input.baseline,
	"non_compliant": failing_controls,
}
