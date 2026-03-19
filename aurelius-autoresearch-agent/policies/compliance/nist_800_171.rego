# NIST 800-171 Compliance Policy
# Evaluates CUI protection controls for federal proposals.
package compliance.nist_800_171

import rego.v1

default allow := false

control_families := [
  "access_control",
  "awareness_training",
  "audit_accountability",
  "configuration_management",
  "identification_authentication",
  "incident_response",
  "maintenance",
  "media_protection",
  "personnel_security",
  "physical_protection",
  "risk_assessment",
  "security_assessment",
  "system_communications",
  "system_integrity",
]

total_controls := count(control_families)

passing_controls := count([cf |
  some cf in control_families
  content := object.get(input, "content", "")
  contains(lower(content), replace(cf, "_", " "))
])

score := (passing_controls / total_controls) * 100 if {
  total_controls > 0
} else := 0

allow if {
  score >= 60
}

reason := sprintf("NIST 800-171 score: %.1f%% (%d/%d families)", [score, passing_controls, total_controls])
