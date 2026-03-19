# NIST 800-53 Compliance Policy
# Evaluates proposal artifacts against NIST SP 800-53 security controls.
package compliance.nist_800_53

import rego.v1

default allow := false

# Control families evaluated
control_families := [
  "AC",
  "AU",
  "CM",
  "IA",
  "SC",
  "SI",
]

total_controls := count(control_families) * 5

passing_controls := count([cf |
  some cf in control_families
  has_coverage(cf, input)
])

score := (passing_controls / total_controls) * 100 if {
  total_controls > 0
} else := 0

allow if {
  score >= 70
}

reason := sprintf("NIST 800-53 score: %.1f%% (%d/%d controls)", [score, passing_controls, total_controls])

has_coverage(family, inp) if {
  content := object.get(inp, "content", "")
  contains(lower(content), lower(family))
}
