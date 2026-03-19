# NIST SP 800-171 Protecting Controlled Unclassified Information (CUI)
#
# Evaluates organization systems against NIST 800-171 Rev 2 requirements
# for protecting CUI in nonfederal systems. Maps to 14 control families
# and 110 security requirements.
#
# Input schema:
#   input.requirements  - object mapping requirement IDs to implementation status
#   input.cui_types     - array of CUI category types handled
#   input.environment   - "contractor" | "subcontractor" | "university"

package compliance.nist_800_171

import rego.v1

default allow := false

# The 14 control families in NIST 800-171
families := {
	"3.1": "Access Control",
	"3.2": "Awareness and Training",
	"3.3": "Audit and Accountability",
	"3.4": "Configuration Management",
	"3.5": "Identification and Authentication",
	"3.6": "Incident Response",
	"3.7": "Maintenance",
	"3.8": "Media Protection",
	"3.9": "Personnel Security",
	"3.10": "Physical Protection",
	"3.11": "Risk Assessment",
	"3.12": "Security Assessment",
	"3.13": "System and Communications Protection",
	"3.14": "System and Information Integrity",
}

total_controls := count(input.requirements)

passing_controls := count({id |
	some id, status in input.requirements
	status == "implemented"
})

# NIST 800-171 has no partial credit; controls are either met or not
score := round((passing_controls / total_controls) * 100) if {
	total_controls > 0
} else := 0

# Full compliance required for CUI handling authorization
allow if {
	score == 100
}

# POA&M acceptable if score is above threshold and plan exists
poam_acceptable if {
	score >= 80
	input.has_poam == true
}

# Identify gaps for Plan of Action & Milestones
gaps := {id: status |
	some id, status in input.requirements
	status != "implemented"
}

findings := {
	"total_controls": total_controls,
	"passing_controls": passing_controls,
	"score": score,
	"gaps": gaps,
	"poam_acceptable": poam_acceptable,
	"cui_types": input.cui_types,
}
