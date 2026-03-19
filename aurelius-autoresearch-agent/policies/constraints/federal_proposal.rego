# Federal Proposal Constraints
#
# Enforces constraints specific to federal government proposal submissions.
# Validates FAR/DFARS compliance, organizational conflict of interest checks,
# and mandatory certifications and representations.
#
# Input schema:
#   input.operation      - the operation being attempted
#   input.proposal       - proposal metadata
#   input.certifications - organization certifications
#   input.oci_check      - organizational conflict of interest assessment

package constraints.federal_proposal

import rego.v1

default allow := false
default deny := false

# Required certifications for federal proposals
required_certs := {
	"sam_registration",
	"cage_code",
	"duns_number",
	"far_52_204_7",
}

# Check all required certifications are present
certs_valid if {
	provided := {cert | some cert in input.certifications}
	missing := required_certs - provided
	count(missing) == 0
}

# OCI check must be clean or mitigated
oci_clear if {
	input.oci_check.status in {"clear", "mitigated"}
}

# Proposal must have required metadata
metadata_complete if {
	input.proposal.solicitation_number != ""
	input.proposal.naics_code != ""
	input.proposal.submission_deadline != ""
	input.proposal.contracting_officer != ""
}

# Export control check
export_control_ok if {
	not input.proposal.contains_itar
} else if {
	input.proposal.contains_itar
	input.certifications[_] == "itar_registered"
}

allow if {
	certs_valid
	oci_clear
	metadata_complete
	export_control_ok
}

deny if {
	not certs_valid
}

deny if {
	not oci_clear
}

reason := "Missing required certifications" if {
	not certs_valid
} else := "Organizational conflict of interest not resolved" if {
	not oci_clear
} else := "Incomplete proposal metadata" if {
	not metadata_complete
} else := "Export control requirements not met" if {
	not export_control_ok
} else := "Compliant"

findings := {
	"allow": allow,
	"reason": reason,
	"certs_valid": certs_valid,
	"oci_clear": oci_clear,
	"metadata_complete": metadata_complete,
	"export_control_ok": export_control_ok,
}
