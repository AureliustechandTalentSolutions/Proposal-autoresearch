# Compliance Artifact Constraints
#
# Validates that compliance artifacts (SSPs, POA&Ms, security assessments)
# meet structural and content requirements before storage or submission.
#
# Input schema:
#   input.operation       - "upload" | "submit" | "modify" | "delete"
#   input.artifact        - artifact metadata and content summary
#   input.artifact_type   - "ssp" | "poam" | "sar" | "ato" | "ra"
#   input.classification  - "unclassified" | "cui" | "fouo"

package constraints.compliance_artifact

import rego.v1

default allow := false
default deny := false

# Required fields by artifact type
required_fields := {
	"ssp": {"system_name", "authorization_boundary", "security_controls", "responsible_entities"},
	"poam": {"weakness_id", "scheduled_completion", "milestones", "responsible_poc"},
	"sar": {"assessment_date", "assessor", "findings", "recommendations"},
	"ato": {"authorization_date", "expiration_date", "authorizing_official", "conditions"},
	"ra": {"risk_id", "likelihood", "impact", "risk_level", "mitigation"},
}

# Check that required fields are present for the artifact type
fields_present if {
	required := required_fields[input.artifact_type]
	provided := {field | some field, _ in input.artifact.fields}
	missing := required - provided
	count(missing) == 0
}

# Classification handling constraints
classification_ok if {
	input.classification == "unclassified"
}

classification_ok if {
	input.classification == "cui"
	input.artifact.marking_applied == true
}

classification_ok if {
	input.classification == "fouo"
	input.artifact.marking_applied == true
	input.artifact.distribution_limited == true
}

# Prevent deletion of submitted artifacts
delete_ok if {
	input.operation != "delete"
}

delete_ok if {
	input.operation == "delete"
	input.artifact.status != "submitted"
	input.artifact.status != "approved"
}

# Modification constraints on approved artifacts
modify_ok if {
	input.operation != "modify"
}

modify_ok if {
	input.operation == "modify"
	input.artifact.status != "approved"
}

modify_ok if {
	input.operation == "modify"
	input.artifact.status == "approved"
	input.artifact.change_request_approved == true
}

allow if {
	fields_present
	classification_ok
	delete_ok
	modify_ok
}

deny if {
	not fields_present
}

deny if {
	not classification_ok
}

reason := "Missing required fields for artifact type" if {
	not fields_present
} else := "Classification marking requirements not met" if {
	not classification_ok
} else := "Cannot delete submitted or approved artifacts" if {
	not delete_ok
} else := "Cannot modify approved artifacts without change request" if {
	not modify_ok
} else := "Compliant"

findings := {
	"allow": allow,
	"reason": reason,
	"artifact_type": input.artifact_type,
	"operation": input.operation,
	"fields_present": fields_present,
	"classification_ok": classification_ok,
}
