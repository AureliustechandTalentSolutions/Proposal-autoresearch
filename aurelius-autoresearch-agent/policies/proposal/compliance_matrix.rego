# Proposal Compliance Matrix Policy
#
# Validates that a proposal's compliance matrix covers all solicitation
# requirements. Ensures each requirement is addressed with a specific
# proposal section reference and compliance status.
#
# Input schema:
#   input.matrix         - array of compliance matrix entries
#   input.requirements   - array of solicitation requirement IDs
#   input.sections       - available proposal section references

package proposal.compliance_matrix

import rego.v1

default allow := false

# Set of all required solicitation items
required_ids := {req | some req in input.requirements}

# Set of requirements addressed in the compliance matrix
addressed_ids := {entry.requirement_id | some entry in input.matrix}

# Requirements not addressed
missing_requirements := required_ids - addressed_ids

# Requirements marked as non-compliant
non_compliant := {entry.requirement_id |
	some entry in input.matrix
	entry.status == "non_compliant"
}

# Requirements with exceptions
exceptions := {entry.requirement_id |
	some entry in input.matrix
	entry.status == "exception"
}

# Requirements fully compliant
compliant := {entry.requirement_id |
	some entry in input.matrix
	entry.status in {"compliant", "exceeds"}
}

total_controls := count(required_ids)

passing_controls := count(compliant)

# Coverage percentage (how many requirements are addressed at all)
coverage := round((count(addressed_ids) / count(required_ids)) * 100) if {
	count(required_ids) > 0
} else := 0

# Compliance percentage (how many addressed requirements are compliant)
score := round((passing_controls / total_controls) * 100) if {
	total_controls > 0
} else := 0

# Allow if all requirements are addressed and compliance is high
allow if {
	count(missing_requirements) == 0
	score >= 90
}

# Validate section references exist
invalid_references := {entry.requirement_id |
	some entry in input.matrix
	not entry.section_ref in {s | some s in input.sections}
}

findings := {
	"total_controls": total_controls,
	"passing_controls": passing_controls,
	"coverage": coverage,
	"score": score,
	"missing_requirements": missing_requirements,
	"non_compliant": non_compliant,
	"exceptions": exceptions,
	"invalid_references": invalid_references,
}
